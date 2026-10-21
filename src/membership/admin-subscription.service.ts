import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { CreditBucket, CreditLotStatus, CreditTxnType, Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { csvEscape, exportDateFormatter } from "../common/utils/datetime"
import { maskPhone } from "../common/utils/mask"
import { PrismaService } from "../prisma/prisma.service"
import { CreditService } from "./credit.service"
import { AdjustSubscriptionDto, QueryAdminSubscriptionDto } from "./dto/admin-subscription.dto"
import { DAY_MS, PACKAGE_EXPIRE_DAYS } from "./membership.constants"

type Tx = Prisma.TransactionClient

/** 临期窗口：7 天内到期算 EXPIRING（与到期提醒任务 T-7 口径一致） */
export const EXPIRING_WINDOW_DAYS = 7

export type SubscriptionStatus = "ACTIVE" | "EXPIRING" | "EXPIRED"

/**
 * 后台个人订阅（客户运营·个人订阅 tab）：
 * - 列表：Lv.1-3 订阅用户（在期/临期/过期 + 到期升序）+ MRR 汇总（USD 口径）；
 * - 客服补偿调整：赠送积分（可负数扣回）/ 延长有效期，写 MANUAL_ADJUST 流水（meta.compensation=true），
 *   明示不产生订单、不开收据。
 */
@Injectable()
export class AdminSubscriptionService {
  private readonly logger = new Logger(AdminSubscriptionService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditService
  ) {}

  /** 列表 + MRR 汇总（汇总为全量 Lv.1-3 口径，不随列表筛选变化） */
  async list(query: QueryAdminSubscriptionDto) {
    const now = new Date()
    const expiringBefore = new Date(now.getTime() + EXPIRING_WINDOW_DAYS * DAY_MS)
    const { page, pageSize } = query
    const where = this.buildWhere(query, now, expiringBefore)

    const [rows, total, summary] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          phone: true,
          email: true,
          subscriptionTier: true,
          subscriptionExpiresAt: true,
        },
        orderBy: [{ subscriptionExpiresAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
      this.summary(now, expiringBefore),
    ])

    // 剩余积分（points）：个人可消费 = 充值+套餐+赠送（ACTIVE 未过期批次），口径同 GET /api/users 的 points；
    // 本页用户都是个人订阅者（企业成员 tier 已清空不会进列表），批量一次查，避免前端 N+1
    const ids = rows.map(r => r.id)
    const balanceRows = ids.length
      ? await this.prisma.creditLot.groupBy({
          by: ["userId"],
          where: {
            userId: { in: ids },
            bucket: { in: [CreditBucket.RECHARGE, CreditBucket.PACKAGE, CreditBucket.GIFT] },
            status: CreditLotStatus.ACTIVE,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          _sum: { remaining: true },
        })
      : []
    const pointsByUser = new Map<number, Decimal>(
      balanceRows.map(b => [b.userId, b._sum.remaining ?? new Decimal(0)])
    )

    return {
      items: rows.map(r => ({
        ...this.toItem(r, now, expiringBefore),
        points: (pointsByUser.get(r.id) ?? new Decimal(0)).toString(),
      })),
      total,
      page,
      pageSize,
      summary,
    }
  }

  /**
   * 订阅名单 CSV 导出（带 BOM，Excel 中文不乱码）：与列表同一套筛选（状态/档位/关键词/到期日区间），
   * 最多 5000 行。到期时间按 tz（IANA 时区名）格式化 YYYY-MM-DD（纯日期，与页面口径一致），缺省/非法回落 Asia/Shanghai。
   * 手机号与列表同口径脱敏（全号走 GET /users/:id/phone 审计接口）。
   */
  async exportCsv(query: QueryAdminSubscriptionDto, tz?: string): Promise<string> {
    const now = new Date()
    const expiringBefore = new Date(now.getTime() + EXPIRING_WINDOW_DAYS * DAY_MS)
    const where = this.buildWhere(query, now, expiringBefore)
    const [rows, plans] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          phone: true,
          subscriptionTier: true,
          subscriptionExpiresAt: true,
        },
        orderBy: [{ subscriptionExpiresAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
        take: 5000,
      }),
      this.prisma.membershipPlan.findMany({ where: { tier: { in: [1, 2, 3] } } }),
    ])
    const planName = (tier: number | null) => plans.find(p => p.tier === tier)?.name ?? ""
    const fmt = exportDateFormatter(tz)
    const statusLabel: Record<SubscriptionStatus, string> = {
      ACTIVE: "在期",
      EXPIRING: "临期",
      EXPIRED: "已过期",
    }
    const lines = ["用户名,手机号,会员等级,状态,到期时间,剩余天数"]
    for (const r of rows) {
      const item = this.toItem(r, now, expiringBefore)
      lines.push(
        [
          csvEscape(item.username),
          item.phone, // 已脱敏
          csvEscape(item.tier != null ? `Lv.${item.tier} ${planName(item.tier)}`.trim() : ""),
          statusLabel[item.status],
          item.subscriptionExpiresAt ? fmt(new Date(item.subscriptionExpiresAt)) : "",
          item.daysLeft != null ? String(item.daysLeft) : "",
        ].join(",")
      )
    }
    return "﻿" + lines.join("\n")
  }

  /** 列表/导出共用的 where：状态（ACTIVE/EXPIRING/EXPIRED）+ 关键词 + 档位 + 到期日区间（AND 组合避免键冲突） */
  private buildWhere(
    query: QueryAdminSubscriptionDto,
    now: Date,
    expiringBefore: Date
  ): Prisma.UserWhereInput {
    const { keyword, tier, status, expiresStart, expiresEnd } = query
    const and: Prisma.UserWhereInput[] = []
    // 在期 = 全部未过期订阅（含临期，与企业管理 ACTIVE 口径一致；EXPIRING 是「在期」的子集快捷筛选）
    if (status === "ACTIVE") and.push({ subscriptionExpiresAt: { gt: now } })
    if (status === "EXPIRING") {
      and.push({ subscriptionExpiresAt: { gt: now, lte: expiringBefore } })
    }
    // 已过期：到期时刻已过；expiresAt 为 null 属数据异常，一并归入过期
    if (status === "EXPIRED") {
      and.push({ OR: [{ subscriptionExpiresAt: { lte: now } }, { subscriptionExpiresAt: null }] })
    }
    if (expiresStart || expiresEnd) {
      and.push({
        subscriptionExpiresAt: {
          ...(expiresStart && { gte: new Date(expiresStart) }),
          ...(expiresEnd && { lte: new Date(expiresEnd) }),
        },
      })
    }
    return {
      subscriptionTier: tier ?? { in: [1, 2, 3] },
      ...(keyword && {
        OR: [{ username: { contains: keyword } }, { phone: { contains: keyword } }],
      }),
      ...(and.length > 0 && { AND: and }),
    }
  }

  /**
   * MRR 汇总：按档分组统计总人数 / 在期（未过期）人数 / 临期人数，
   * MRR = Σ 各档在期人数 × 档月价（元；priceCny 未定价的档按 0 计、价格原样返回 null 供前端标「待定」）。
   */
  private async summary(now: Date, expiringBefore: Date) {
    const [plans, totalByTier, activeByTier, expiringByTier] = await Promise.all([
      this.prisma.membershipPlan.findMany({ where: { tier: { in: [1, 2, 3] } } }),
      this.prisma.user.groupBy({
        by: ["subscriptionTier"],
        where: { subscriptionTier: { in: [1, 2, 3] } },
        _count: { _all: true },
      }),
      this.prisma.user.groupBy({
        by: ["subscriptionTier"],
        where: { subscriptionTier: { in: [1, 2, 3] }, subscriptionExpiresAt: { gt: now } },
        _count: { _all: true },
      }),
      this.prisma.user.groupBy({
        by: ["subscriptionTier"],
        where: {
          subscriptionTier: { in: [1, 2, 3] },
          subscriptionExpiresAt: { gt: now, lte: expiringBefore },
        },
        _count: { _all: true },
      }),
    ])

    const countOf = (
      grouped: { subscriptionTier: number | null; _count: { _all: number } }[],
      tier: number
    ) => grouped.find(g => g.subscriptionTier === tier)?._count._all ?? 0

    let mrrCny = 0
    let activeSubscribers = 0
    const byTier = [1, 2, 3].map(tier => {
      const plan = plans.find(p => p.tier === tier)
      const active = countOf(activeByTier, tier)
      const expiring = countOf(expiringByTier, tier)
      const price = plan?.priceCny != null ? Number(plan.priceCny) : null
      const mrr = price != null ? active * price : 0
      mrrCny += mrr
      activeSubscribers += active
      return {
        tier,
        planName: plan?.name ?? null,
        priceCny: price,
        total: countOf(totalByTier, tier),
        active,
        expiring,
        expired: countOf(totalByTier, tier) - active,
        mrrCny: mrr,
      }
    })

    return {
      currency: "CNY",
      mrrCny,
      activeSubscribers, // 在期（含临期）订阅人数
      expiringSoon: byTier.reduce((s, t) => s + t.expiring, 0),
      byTier,
    }
  }

  private toItem(
    row: {
      id: number
      username: string
      phone: string
      email?: string | null // 列表返回邮箱；导出不再取该列（隐私口径）
      subscriptionTier: number | null
      subscriptionExpiresAt: Date | null
    },
    now: Date,
    expiringBefore: Date
  ) {
    const expiresAt = row.subscriptionExpiresAt
    const status: SubscriptionStatus =
      expiresAt == null || expiresAt <= now
        ? "EXPIRED"
        : expiresAt <= expiringBefore
          ? "EXPIRING"
          : "ACTIVE"
    return {
      userId: row.id,
      username: row.username,
      phone: maskPhone(row.phone), // 默认脱敏；全号走 GET /users/:id/phone
      email: row.email,
      tier: row.subscriptionTier,
      subscriptionExpiresAt: expiresAt?.toISOString() ?? null,
      status,
      daysLeft:
        expiresAt == null ? null : Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS), // 过期为负数
    }
  }

  /**
   * 客服补偿调整：赠送积分（正=发 GIFT 批次 30 天过期 / 负=按过期先后从 PACKAGE+GIFT 扣回，不得超剩余）
   * + 延长有效期（在当前到期时刻上顺延；从未订阅过则以现在为基准）。两者至少传一项。
   * 写一条 MANUAL_ADJUST 流水（source=客服补偿赠送，meta.compensation=true）；不产生订单、不开收据。
   */
  async adjust(userId: number, operatorId: number, dto: AdjustSubscriptionDto) {
    if (dto.giftCredits == null && dto.extendDays == null) {
      throw new BadRequestException("没有需要调整的内容")
    }
    if (dto.giftCredits === 0) throw new BadRequestException("调整积分不能为 0")

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, subscriptionExpiresAt: true },
    })
    if (!user) throw new NotFoundException("用户不存在")

    const meta: Record<string, unknown> = {
      compensation: true,
      reason: dto.reason ?? null,
      giftCredits: dto.giftCredits ?? null,
      extendDays: dto.extendDays ?? null,
      operatorId,
    }

    const newExpiresAt = await this.prisma.$transaction(async tx => {
      if (dto.giftCredits != null && dto.giftCredits > 0) {
        await this.credit.grant(
          userId,
          CreditBucket.GIFT,
          dto.giftCredits,
          {
            type: CreditTxnType.MANUAL_ADJUST,
            source: "客服补偿赠送",
            expiresAt: new Date(Date.now() + PACKAGE_EXPIRE_DAYS * DAY_MS),
            meta,
          },
          tx
        )
      } else if (dto.giftCredits != null && dto.giftCredits < 0) {
        await this.deductGiftInTx(userId, -dto.giftCredits, meta, tx)
      }

      let updated: Date | null = null
      if (dto.extendDays != null) {
        const base = user.subscriptionExpiresAt ?? new Date()
        updated = new Date(base.getTime() + dto.extendDays * DAY_MS)
        await tx.user.update({
          where: { id: userId },
          data: { subscriptionExpiresAt: updated },
        })
        // 2026-09-02 bug22：调整套餐到期日同步顺延仍有效的套餐批次（RECHARGE_PLAN 来源
        // PACKAGE/GIFT，只延不缩），与续费存量顺延同口径；注册赠送等其他来源批次不动
        await this.credit.extendPlanLotExpiryInTx(tx, userId, updated)
        if (dto.giftCredits == null) {
          // 纯延长有效期也留一条 0 积分流水，充值记录可见「客服补偿赠送（延长有效期）」便于对账
          const balanceAfter = await this.credit.consumableBalance(tx, userId)
          await tx.creditTransaction.create({
            data: {
              userId,
              direction: "CREDIT",
              bucket: null,
              type: CreditTxnType.MANUAL_ADJUST,
              amount: 0,
              balanceAfter,
              source: "客服补偿赠送",
              meta: meta as Prisma.InputJsonValue,
            },
          })
        }
      }
      return updated
    })

    this.logger.log(
      `adjustSubscription user=${userId} op=${operatorId} gift=${dto.giftCredits ?? "-"} extend=${dto.extendDays ?? "-"}`
    )
    return {
      userId,
      giftCredits: dto.giftCredits ?? null,
      extendDays: dto.extendDays ?? null,
      subscriptionExpiresAt: newExpiresAt?.toISOString() ?? null,
    }
  }

  /**
   * 扣回赠送积分：个人批次（teamId IS NULL）PACKAGE+GIFT 合池，按过期先后 FIFO 扣（与消费同口径）。
   * 加锁当前读（FOR UPDATE）；余额不足抛 400、不扣成负。
   */
  private async deductGiftInTx(
    userId: number,
    amount: number,
    meta: Record<string, unknown>,
    tx: Tx
  ) {
    const need = new Decimal(amount)
    const lots = await tx.$queryRaw<Array<{ id: number; remaining: Prisma.Decimal }>>`
      SELECT id, remaining
      FROM CreditLot
      WHERE userId = ${userId} AND teamId IS NULL AND bucket IN (${CreditBucket.PACKAGE}, ${CreditBucket.GIFT}) AND status = ${CreditLotStatus.ACTIVE}
      ORDER BY expiresAt ASC, grantedAt ASC
      FOR UPDATE
    `
    const available = lots.reduce((s, l) => s.plus(l.remaining), new Decimal(0))
    if (available.lessThan(need)) {
      throw new BadRequestException("赠送积分余额不足，减少量不得超过剩余")
    }

    let remaining = need
    for (const lot of lots) {
      if (remaining.lessThanOrEqualTo(0)) break
      const lotRemaining = new Decimal(lot.remaining)
      if (lotRemaining.lessThanOrEqualTo(0)) continue // 跳过欠账负批次
      const take = lotRemaining.greaterThan(remaining) ? remaining : lotRemaining
      const newRemaining = lotRemaining.minus(take)
      await tx.creditLot.update({
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

    const balanceAfter = await this.credit.consumableBalance(tx, userId)
    await tx.creditTransaction.create({
      data: {
        userId,
        direction: "DEBIT",
        bucket: null, // 跨 PACKAGE+GIFT 合池扣减，不归属单桶
        type: CreditTxnType.MANUAL_ADJUST,
        amount: need,
        balanceAfter,
        source: "客服补偿赠送",
        meta: meta as Prisma.InputJsonValue,
      },
    })
  }
}
