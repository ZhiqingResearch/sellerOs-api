import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import { CreditBucket, CreditLotStatus, CreditTxnType, Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { CreditService } from "../membership/credit.service"
import { DAY_MS, PACKAGE_EXPIRE_DAYS } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"

type Tx = Prisma.TransactionClient

/** 池入账入参：三类积分按需组合（套餐/赠送 30 天过期，充值永不过期） */
export interface GrantPoolOptions {
  /** 批次归属账号（一般为团队管理员；个人转团队等场景可为购买人） */
  ownerUserId: number
  /** 套餐积分（PACKAGE 桶，默认 30 天过期） */
  packageCredits?: number
  /** 赠送积分（GIFT 桶，默认 30 天过期） */
  giftCredits?: number
  /** 充值积分（RECHARGE 桶，永不过期） */
  rechargeCredits?: number
  /** 套餐/赠送批次过期时点（缺省 now+30 天；续费入账可按周期指定） */
  packageExpiresAt?: Date
  source: string
  sourceRef?: string
  meta?: Record<string, unknown>
  /** 流水类型，默认 TEAM_RECHARGE */
  type?: CreditTxnType
}

/**
 * 企业共享池包装：入账/余额/平台调整。
 * 入账与扣减一律组合 CreditService（recordRecharge / consumeTeamCredits / archiveTeamPool），
 * 不绕过批次台账；仅「平台调整池充值积分」因 CreditService 暂无团队批次调整方法而在本类自实现
 * （同样走 CreditLot + CreditTransaction 台账，MANUAL_ADJUST 带 teamId）。
 */
@Injectable()
export class TeamPoolService {
  private readonly logger = new Logger(TeamPoolService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditService
  ) {}

  /**
   * 池入账（团队新购/续费/充值包/平台定制开通共用）：多批次一条 TEAM_RECHARGE 流水，批次带 teamId。
   * 供 M2b 订单结算与本模块平台侧开通调用。
   */
  async grantPool(teamId: number, opts: GrantPoolOptions, tx?: Tx): Promise<void> {
    const packageExpiresAt =
      opts.packageExpiresAt ?? new Date(Date.now() + PACKAGE_EXPIRE_DAYS * DAY_MS)
    const lots: { bucket: CreditBucket; amount: number; expiresAt?: Date | null }[] = []
    if (opts.packageCredits && opts.packageCredits > 0) {
      lots.push({
        bucket: CreditBucket.PACKAGE,
        amount: opts.packageCredits,
        expiresAt: packageExpiresAt,
      })
    }
    if (opts.giftCredits && opts.giftCredits > 0) {
      lots.push({
        bucket: CreditBucket.GIFT,
        amount: opts.giftCredits,
        expiresAt: packageExpiresAt,
      })
    }
    if (opts.rechargeCredits && opts.rechargeCredits > 0) {
      lots.push({ bucket: CreditBucket.RECHARGE, amount: opts.rechargeCredits, expiresAt: null })
    }
    if (!lots.length) return
    await this.credit.recordRecharge(
      opts.ownerUserId,
      {
        type: opts.type ?? CreditTxnType.TEAM_RECHARGE,
        source: opts.source,
        sourceRef: opts.sourceRef,
        lots,
        meta: opts.meta,
        teamId,
      },
      tx
    )
    this.logger.log(
      `grantPool team=${teamId} package=${opts.packageCredits ?? 0} gift=${opts.giftCredits ?? 0} recharge=${opts.rechargeCredits ?? 0}`
    )
  }

  /** 池可消费余额（RECHARGE + PACKAGE + GIFT，ACTIVE 未过期；含欠账负批次） */
  poolBalance(teamId: number, tx?: Tx): Promise<Decimal> {
    return this.credit.teamPoolBalance(teamId, tx)
  }

  /** 池分桶余额（总览卡片口径：套餐=PACKAGE、赠送=GIFT、充值=RECHARGE） */
  async poolBuckets(
    teamId: number,
    tx?: Tx,
    opts?: { includeFrozen?: boolean }
  ): Promise<{ package: Decimal; gift: Decimal; recharge: Decimal; total: Decimal }> {
    const run = async (c: Tx | PrismaService) => {
      const rows = await c.creditLot.groupBy({
        by: ["bucket"],
        where: {
          teamId,
          status: CreditLotStatus.ACTIVE,
          // GRACE 宽限期展示口径（includeFrozen）：批次已过到期日但物理保留（续费顺延可恢复），
          // 冻结余额应可见（标已冻结），不按到期日过滤；消费扣减不走本方法，不受影响
          ...(opts?.includeFrozen
            ? {}
            : { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }),
        },
        _sum: { remaining: true },
      })
      const get = (b: CreditBucket) =>
        rows.find(r => r.bucket === b)?._sum.remaining ?? new Decimal(0)
      const pkg = get(CreditBucket.PACKAGE)
      const gift = get(CreditBucket.GIFT)
      const recharge = get(CreditBucket.RECHARGE)
      return { package: pkg, gift, recharge, total: pkg.plus(gift).plus(recharge) }
    }
    return tx ? run(tx) : run(this.prisma)
  }

  /** 池累计发放（全部批次 amount 合计，含已耗尽/已清零/已过期；欠账负批次自然抵减）。池不足 20% 提醒的分母 */
  async poolGrantedTotal(teamId: number): Promise<Decimal> {
    const agg = await this.prisma.creditLot.aggregate({
      where: { teamId },
      _sum: { amount: true },
    })
    return agg._sum.amount ?? new Decimal(0)
  }

  /**
   * 平台调整池充值积分（客服补偿）：正=追加 RECHARGE 批次（永不过期）；负=按 FIFO 扣减池 RECHARGE 批次。
   * 定稿口径：减少量不得超过池充值剩余（余额不足抛 400，不扣成负）。写一条 MANUAL_ADJUST 流水（带 teamId）。
   */
  async adjustPoolRecharge(
    teamId: number,
    ownerUserId: number,
    delta: number,
    opts: { source?: string; meta?: Record<string, unknown> } = {},
    tx?: Tx
  ): Promise<void> {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new BadRequestException("调整积分必须为非零整数")
    }
    const run = async (c: Tx) => {
      if (delta > 0) {
        await c.creditLot.create({
          data: {
            userId: ownerUserId,
            bucket: CreditBucket.RECHARGE,
            amount: delta,
            remaining: delta,
            expiresAt: null,
            sourceType: CreditTxnType.MANUAL_ADJUST,
            status: CreditLotStatus.ACTIVE,
            teamId,
          },
        })
      } else {
        // 扣减：加锁当前读池 RECHARGE 批次（FOR UPDATE），FIFO 扣减；欠账负批次跳过但仍计入可用净额
        const need = new Decimal(-delta)
        const lots = await c.$queryRaw<Array<{ id: number; remaining: Prisma.Decimal }>>`
          SELECT id, remaining
          FROM CreditLot
          WHERE teamId = ${teamId} AND bucket = ${CreditBucket.RECHARGE} AND status = ${CreditLotStatus.ACTIVE}
          ORDER BY grantedAt ASC
          FOR UPDATE
        `
        const available = lots.reduce((s, l) => s.plus(l.remaining), new Decimal(0))
        if (available.lessThan(need)) {
          throw new BadRequestException(
            `池充值积分剩余不足（当前可扣减 ${available.toDecimalPlaces(0).toNumber()}），减少量不得超过剩余`
          )
        }
        let remaining = need
        for (const lot of lots) {
          if (remaining.lessThanOrEqualTo(0)) break
          const lotRemaining = new Decimal(lot.remaining)
          if (lotRemaining.lessThanOrEqualTo(0)) continue
          const take = lotRemaining.greaterThan(remaining) ? remaining : lotRemaining
          const newRemaining = lotRemaining.minus(take)
          await c.creditLot.update({
            where: { id: lot.id },
            data: {
              remaining: newRemaining,
              status: newRemaining.lessThanOrEqualTo(0)
                ? CreditLotStatus.EXHAUSTED
                : CreditLotStatus.ACTIVE,
            },
          })
          remaining = remaining.minus(take)
        }
      }
      const balanceAfter = await this.credit.teamPoolBalance(teamId, c)
      await c.creditTransaction.create({
        data: {
          userId: ownerUserId,
          direction: delta > 0 ? "CREDIT" : "DEBIT",
          bucket: CreditBucket.RECHARGE,
          type: CreditTxnType.MANUAL_ADJUST,
          amount: Math.abs(delta),
          balanceAfter,
          source: opts.source ?? "admin.team.adjust",
          teamId,
          meta: opts.meta as Prisma.InputJsonValue | undefined,
        },
      })
    }
    return tx
      ? run(tx)
      : this.prisma.$transaction(run, {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        })
  }
}
