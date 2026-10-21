import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import {
  CreditBucket,
  CreditDirection,
  CreditLotStatus,
  CreditTxnType,
  InvokeType,
  MembershipLevel,
  Prisma,
  ScheduledPlanStatus,
  TeamStatus,
} from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { beijingMonthStart } from "../common/utils/datetime"
import { quantize4 } from "../common/utils/decimal"
import { PrismaService } from "../prisma/prisma.service"
import {
  CREDIT_PER_CNY,
  DAY_MS,
  DEFAULT_LEVEL2_REBATE_RATE,
  consumeBucketTiers,
  resolveLevel,
} from "./membership.constants"

type Tx = Prisma.TransactionClient

export interface GrantOptions {
  type: CreditTxnType
  expiresAt?: Date | null
  sourceRef?: string | null
  source?: string | null
  meta?: Record<string, unknown>
  /** 归属企业共享池（批次与流水带 teamId）；不传=个人批次 */
  teamId?: number | null
}

export interface ConsumeBreakdownItem {
  bucket: CreditBucket
  amount: string
}

export interface ConsumeResult {
  creditsCharged: Decimal // 实扣积分（人民币消费含折扣、向上取整；精确积分消费按传入值）
  costCny: Decimal // 原始人民币成本
  breakdown: ConsumeBreakdownItem[] // 跨桶扣减明细
  balanceAfter: Decimal // 扣后可消费积分余额（RECHARGE + PACKAGE + GIFT）
}

/**
 * 扣费内核公共选项。bucketScope / skipInviterShare 仅供内部混合扣费分段调用
 * （UsageService.consumeRouted 企业成员路径），业务调用方不要传。
 */
export interface ConsumeOpts {
  source?: string
  meta?: Record<string, unknown>
  allowOverdraft?: boolean
  /** 调用方式：API=开放平台服务间扣费（/api/open/* 入口显式传入）；缺省 PLATFORM 平台使用 */
  invokeType?: InvokeType
  /** 【内部】只扣指定桶域（如赠送层 PACKAGE+GIFT / 仅 RECHARGE）；缺省=全部可消费桶 */
  bucketScope?: CreditBucket[]
  /** 【内部】不走邀请人共享额度（企业成员混合扣费的个人段用，与团队扣费同口径） */
  skipInviterShare?: boolean
}

/**
 * 返利金额精度助手 quantize4 在 ../common/utils/decimal（返利结算与成本试算共用，防口径漂移）。
 */

export interface WalletView {
  level: ReturnType<typeof resolveLevel>
  buckets: { recharge: Decimal; package: Decimal; gift: Decimal; rebate: Decimal }
  total: Decimal // 可消费积分合计（不含 REBATE）
  monthUsed: Decimal // 本自然月消耗
  totalConsumed: Decimal // 累计消耗
  nextExpireAt: Date | null // 最近一笔 PACKAGE 清零时间
  nextExpireAmount: Decimal | null // 该最早到期时点将清零的 PACKAGE 积分数
  discount: Decimal
  rebateRate: Decimal
  subscriptionExpiresAt: Date | null
  inviter: { id: number; username: string } | null // 我的邀请人（仅 LV4 有值）
  // 邀请人是否开启「共享额度」（仅 LV4 有值），供前端判定本人能否动用邀请人额度；
  // 读时派生自邀请人的 shareCreditsWithInvitees，与 /admin/recharge/users 的 inviterShareCredits 同口径
  inviterShareCredits: boolean | null
}

/**
 * 积分核心服务：发放(grant) / 消费(consume) / 钱包(getWallet) / 周期清零(expireLots)。
 * 被 usage / membership / invite 复用。所有积分变动走批次(CreditLot) + 流水(CreditTransaction)。
 */
@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** 发放一笔积分批次 + 入账流水。可传外层事务 tx 复用（充值/注册等多步操作的一部分）。 */
  async grant(
    userId: number,
    bucket: CreditBucket,
    amount: Decimal | number | string,
    opts: GrantOptions,
    tx?: Tx
  ) {
    const amt = new Decimal(amount)
    if (amt.lessThanOrEqualTo(0)) throw new BadRequestException("发放积分必须大于 0")

    const run = async (c: Tx) => {
      const lot = await c.creditLot.create({
        data: {
          userId,
          bucket,
          amount: amt,
          remaining: amt,
          expiresAt: opts.expiresAt ?? null,
          sourceType: opts.type,
          sourceRef: opts.sourceRef ?? null,
          status: CreditLotStatus.ACTIVE,
          teamId: opts.teamId ?? null,
        },
      })
      const balanceAfter = await this.displayBalance(c, userId, bucket)
      // 把批次到期时刻一并写进流水 meta（套餐/注册赠送等会过期的发放），供充值记录读时判「已过期」
      const meta: Record<string, unknown> = { ...((opts.meta as Record<string, unknown>) ?? {}) }
      if (opts.expiresAt) meta.expiresAt = opts.expiresAt.toISOString()
      await c.creditTransaction.create({
        data: {
          userId,
          direction: CreditDirection.CREDIT,
          bucket,
          type: opts.type,
          amount: amt,
          balanceAfter,
          source: opts.source ?? null,
          lotId: lot.id,
          teamId: opts.teamId ?? null,
          meta: Object.keys(meta).length ? (meta as Prisma.InputJsonValue) : undefined,
        },
      })
      return lot
    }

    return tx ? run(tx) : this.prisma.$transaction(run)
  }

  /**
   * 记一笔充值（充值包 / 自定义 / 升级补差）：按需建多个批次（本金进 RECHARGE 永不过期、
   * 套餐本体进 PACKAGE、赠送进 GIFT，后两者 30 天过期），
   * 但**只写一条充值流水**（amount=各批次合计，bucket=null），meta 带 priceCny/本金/赠送明细。
   * 与 grant（一批次一流水）不同：本方法是「多批次一流水」，使充值记录里一笔充值合并显示成 1 行。
   */
  async recordRecharge(
    userId: number,
    opts: {
      type: CreditTxnType
      source: string
      sourceRef?: string
      lots: { bucket: CreditBucket; amount: Decimal | number | string; expiresAt?: Date | null }[]
      meta?: Record<string, unknown>
      /** 归属企业共享池（批次与流水带 teamId）；不传=个人批次 */
      teamId?: number | null
    },
    tx?: Tx
  ) {
    const run = async (c: Tx) => {
      let total = new Decimal(0)
      for (const l of opts.lots) {
        const amt = new Decimal(l.amount)
        if (amt.lessThanOrEqualTo(0)) continue
        await c.creditLot.create({
          data: {
            userId,
            bucket: l.bucket,
            amount: amt,
            remaining: amt,
            expiresAt: l.expiresAt ?? null,
            sourceType: opts.type,
            sourceRef: opts.sourceRef ?? null,
            status: CreditLotStatus.ACTIVE,
            teamId: opts.teamId ?? null,
          },
        })
        total = total.plus(amt)
      }
      if (total.lessThanOrEqualTo(0)) return
      // balanceAfter 口径随归属走：个人批次=个人可消费合计；企业池批次（teamId 有值）=池余额，
      // 否则池入账行的「剩余积分」会错显示成管理员个人余额（池行与个人户实际变动对不上）
      const balanceAfter = opts.teamId
        ? await this.teamPoolBalance(opts.teamId, c)
        : await this.consumableBalance(c, userId)
      await c.creditTransaction.create({
        data: {
          userId,
          direction: CreditDirection.CREDIT,
          bucket: null,
          type: opts.type,
          amount: total,
          balanceAfter,
          source: opts.source,
          teamId: opts.teamId ?? null,
          meta: opts.meta as Prisma.InputJsonValue | undefined,
        },
      })
    }
    return tx ? run(tx) : this.prisma.$transaction(run)
  }

  /**
   * 手动调额（仅作用于 RECHARGE 充值积分桶）：delta 正=增加 / 负=扣减，写一条 MANUAL_ADJUST 流水。
   * - 增加：新建 RECHARGE 批次（永不过期）。
   * - 扣减：**只从 RECHARGE 桶**按 FIFO 扣已有批次（不动赠送/套餐积分）；可用充值积分不足则抛 400、
   *   不扣成负。用加锁当前读（FOR UPDATE）杜绝并发丢失更新。
   */
  async adjust(
    userId: number,
    delta: Decimal | number | string,
    opts: { source?: string; sourceRef?: string; meta?: Record<string, unknown> } = {},
    tx?: Tx
  ) {
    const amt = new Decimal(delta)
    if (amt.isZero()) throw new BadRequestException("调整积分不能为 0")

    const run = async (c: Tx) => {
      if (amt.greaterThan(0)) {
        // 增加：进 RECHARGE 桶、永不过期
        await c.creditLot.create({
          data: {
            userId,
            bucket: CreditBucket.RECHARGE,
            amount: amt,
            remaining: amt,
            expiresAt: null,
            sourceType: CreditTxnType.MANUAL_ADJUST,
            sourceRef: opts.sourceRef ?? null,
            status: CreditLotStatus.ACTIVE,
          },
        })
      } else {
        // 扣减：只从 RECHARGE 桶按 FIFO 扣已有批次。加锁当前读（SELECT ... FOR UPDATE）读最新已提交
        // remaining 并锁行，杜绝并发丢失更新；可用充值积分（含可能存在的欠账负批次）不足则报错。
        const need = amt.abs()
        const lots = await c.$queryRaw<Array<{ id: number; remaining: Prisma.Decimal }>>`
          SELECT id, remaining
          FROM CreditLot
          WHERE userId = ${userId} AND teamId IS NULL AND bucket = ${CreditBucket.RECHARGE} AND status = ${CreditLotStatus.ACTIVE}
          ORDER BY grantedAt ASC
          FOR UPDATE
        `
        const available = lots.reduce((s, l) => s.plus(l.remaining), new Decimal(0))
        if (available.lessThan(need)) throw new BadRequestException("可用充值积分不足，无法扣减")

        let remaining = need
        for (const lot of lots) {
          if (remaining.lessThanOrEqualTo(0)) break
          const lotRemaining = new Decimal(lot.remaining)
          if (lotRemaining.lessThanOrEqualTo(0)) continue // 跳过欠账负批次
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

      const balanceAfter = await this.displayBalance(c, userId, CreditBucket.RECHARGE)
      await c.creditTransaction.create({
        data: {
          userId,
          direction: amt.greaterThan(0) ? CreditDirection.CREDIT : CreditDirection.DEBIT,
          bucket: CreditBucket.RECHARGE,
          type: CreditTxnType.MANUAL_ADJUST,
          amount: amt.abs(),
          balanceAfter,
          source: opts.source ?? null,
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

  /**
   * 消费：cost 人民币 → 折扣换算积分（向上取整）→ 按等级优先级 + 桶内 FIFO 扣批次（行锁）
   * → 余额不足抛错 → 每动一个桶写一条 CONSUME 流水 → 多级返利（沿 invitedById 上溯，见 settleRebatesInTx）。
   */
  async consume(
    userId: number,
    costCny: Decimal | number | string,
    opts: ConsumeOpts = {},
    tx?: Tx
  ): Promise<ConsumeResult> {
    const cost = new Decimal(costCny)
    if (cost.lessThan(0)) throw new BadRequestException("消费金额不能为负")
    // 读时兜底：非嵌套调用时，消费前先激活到期的待生效续费（确保用对当前周期的积分/等级）
    if (!tx) await this.activateDuePlans(userId)
    return tx
      ? this.consumeInTx(tx, userId, cost, opts)
      : // READ COMMITTED：配合行锁，锁后重读批次余额读到「最新已提交」值，杜绝并发扣费丢失更新
        this.prisma.$transaction(c => this.consumeInTx(c, userId, cost, opts), {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        })
  }

  /**
   * 按明确的积分数消费，不再做「人民币 × 10 × 折扣后向上取整」换算。
   * 用于业务方已经给出最终平台积分售价、且需要保留小数积分的场景；桶优先级、共享额度、
   * 透支、流水和返利仍完全复用 consume 的扣费内核。
   */
  async consumeCredits(
    userId: number,
    credits: Decimal | number | string,
    costCny: Decimal | number | string,
    opts: ConsumeOpts = {},
    tx?: Tx
  ): Promise<ConsumeResult> {
    const charge = new Decimal(credits)
    const cost = new Decimal(costCny)
    if (charge.lessThan(0)) throw new BadRequestException("消费积分不能为负")
    if (cost.lessThan(0)) throw new BadRequestException("消费金额不能为负")
    if (!tx) await this.activateDuePlans(userId)
    return tx
      ? this.consumeInTx(tx, userId, cost, opts, charge)
      : this.prisma.$transaction(c => this.consumeInTx(c, userId, cost, opts, charge), {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        })
  }

  /**
   * 生效折扣（2026-09-02 产品口径）：「允许邀请注册」开关（canInvite）为分界——
   * 本人开过（canInvite=true）或无邀请人 → 用本人 discount；
   * 本人没开过（canInvite=false）且有邀请人 → 沿 invitedById 上溯，用邀请人的生效折扣（递归）。
   * 注册时抄的快照只对 canInvite=true 的账号有意义（作为其自设折扣的初始值）；消费一律走本解析。
   * 上溯封顶 5 层防数据异常成环；邀请人账号不存在时落回当前节点值。
   */
  async resolveEffectiveDiscount(
    client: Tx | PrismaService,
    user: { canInvite: boolean; discount: Decimal | string | number; invitedById: number | null }
  ): Promise<Decimal> {
    let current = user
    for (let depth = 0; depth < 5; depth++) {
      // discount 列生产上非空（default 1）；?? 1 只是防调用方 select 漏字段/不完整 mock
      if (current.canInvite || current.invitedById == null)
        return new Decimal(current.discount ?? 1)
      const inviter = await client.user.findUnique({
        where: { id: current.invitedById },
        select: { id: true, canInvite: true, discount: true, invitedById: true },
      })
      if (!inviter) return new Decimal(current.discount ?? 1)
      current = inviter
    }
    return new Decimal(current.discount ?? 1)
  }

  private async consumeInTx(
    tx: Tx,
    userId: number,
    cost: Decimal,
    opts: ConsumeOpts,
    exactCredits?: Decimal
  ): Promise<ConsumeResult> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        invitedById: true,
        canInvite: true,
        discount: true,
      },
    })
    if (!user) throw new NotFoundException("用户不存在")

    // 生效折扣：canInvite=false 且有邀请人 → 跟随上级（2026-09-02 口径）
    const discount = await this.resolveEffectiveDiscount(tx, user)
    // 人民币消费：成本(元) × 10 × 折扣后向上取整；明确的平台积分售价则保留传入精度。
    const charge = exactCredits ?? cost.mul(CREDIT_PER_CNY).mul(discount).ceil()

    if (charge.lessThanOrEqualTo(0)) {
      const balanceAfter = await this.consumableBalance(tx, userId)
      return { creditsCharged: new Decimal(0), costCny: cost, breakdown: [], balanceAfter }
    }

    // 邀请人（若有）：用于返利；并在其开启「共享额度」时，被邀请人自己额度不足可继续扣邀请人额度。
    // skipInviterShare（混合扣费个人段，与团队扣费同口径）只用自己的批次。
    const inviter =
      user.invitedById != null && !opts.skipInviterShare
        ? await tx.user.findUnique({
            where: { id: user.invitedById },
            select: { id: true, rebateRate: true, shareCreditsWithInvitees: true, canInvite: true },
          })
        : null
    // bucketScope（混合扣费分段）：把扣减分层收窄到指定桶域，如只扣赠送层 / 只扣充值层
    const tiers = opts.bucketScope
      ? consumeBucketTiers()
          .map(tier => tier.filter(b => opts.bucketScope!.includes(b)))
          .filter(tier => tier.length > 0)
      : consumeBucketTiers()
    const allBuckets = tiers.flat()
    // 扣减「所有者」顺序：先消费者自己，再（共享时）邀请人。
    const ownerIds = this.resolveFundingOwnerIds(userId, inviter)

    // 加锁的「当前读」：一次性锁住所有相关用户的可消费批次。
    // InnoDB 当前读绕过 MVCC 快照（任何隔离级别下都读最新已提交值）→ 并发扣费第二笔等到锁后必读到最新余额，
    // 杜绝丢失更新；多个下级同时动用同一邀请人额度时，二者都要锁邀请人的行，后到者阻塞→重读→不超扣。
    // ORDER BY userId,id：所有并发消费按同一全局顺序申请行锁，杜绝死锁环。
    const lots = await tx.$queryRaw<
      Array<{
        id: number
        userId: number
        bucket: CreditBucket
        remaining: Prisma.Decimal
        expiresAt: Date | null
        grantedAt: Date
      }>
    >`
      SELECT id, userId, bucket, remaining, expiresAt, grantedAt
      FROM CreditLot
      WHERE userId IN (${Prisma.join(ownerIds)})
        AND teamId IS NULL
        AND status = ${CreditLotStatus.ACTIVE}
        AND remaining > 0
        AND bucket IN (${Prisma.join(allBuckets)})
        AND (expiresAt IS NULL OR expiresAt > NOW())
      ORDER BY userId, id
      FOR UPDATE
    `

    // 各所有者扣前可消费余额（含可能存在的透支负批次）：用于跨池余额校验 + 流水 balanceAfter 逐行递减。
    // 共享时「可用」= 消费者自己 + 邀请人；allowOverdraft 时不挡（视频出片结算兜底）。
    // bucketScope 限定时：扣减预算只看域内净额；流水 balanceAfter 展示仍用全量可消费净额（与钱包总额同口径）。
    const balanceByOwner = new Map<number, Decimal>()
    const displayByOwner = new Map<number, Decimal>()
    for (const oid of ownerIds) {
      const display = await this.consumableBalance(tx, oid)
      displayByOwner.set(oid, display)
      balanceByOwner.set(
        oid,
        opts.bucketScope ? await this.consumableBalance(tx, oid, opts.bucketScope) : display
      )
    }
    // 每个所有者最多只能贡献自己的正净额：某一方已有欠账时应跳过该方，不能用其负数
    // 抵消另一方仍可正常扣减的额度。与下方 ownerBudget <= 0 时跳过的实际扣减规则保持一致。
    const available = this.sumAvailableBalances(
      ownerIds.map(oid => balanceByOwner.get(oid) ?? new Decimal(0))
    )
    if (!opts.allowOverdraft && available.lessThan(charge)) {
      throw new BadRequestException("积分余额不足，请充值")
    }

    // 已锁批次按 (所有者, 桶) 归集
    const byOwnerBucket = new Map<string, typeof lots>()
    for (const l of lots) {
      const k = `${l.userId}:${l.bucket}`
      const arr = byOwnerBucket.get(k) ?? []
      arr.push(l)
      byOwnerBucket.set(k, arr)
    }
    // 先过期的先扣：expiresAt 升序、永不过期(null)排最后，再按 grantedAt 升序
    const byExpiry = (a: (typeof lots)[number], b: (typeof lots)[number]) => {
      const ax = a.expiresAt ? a.expiresAt.getTime() : Number.MAX_SAFE_INTEGER
      const bx = b.expiresAt ? b.expiresAt.getTime() : Number.MAX_SAFE_INTEGER
      if (ax !== bx) return ax - bx
      return a.grantedAt.getTime() - b.grantedAt.getTime()
    }

    let remainingToCharge = charge
    let inviterDrawn = new Decimal(0) // 扣自邀请人额度的合计（不返利的部分）
    const breakdown: ConsumeBreakdownItem[] = []
    // 每个所有者各自的 balanceAfter 逐行递减（从其扣前全量可消费净额起；显示该所有者池子的总额）
    const runningByOwner = new Map<number, Decimal>(
      ownerIds.map(oid => [oid, displayByOwner.get(oid) ?? new Decimal(0)])
    )

    // 扣减顺序：先消费者自己（赠送层 FIFO → 充值层），再（共享时）邀请人（同序）。
    // 即「自己快过期 → 自己余额 → 邀请人快过期 → 邀请人余额」，上一级不足扣下一级。
    for (const ownerId of ownerIds) {
      if (remainingToCharge.lessThanOrEqualTo(0)) break
      // 扣费看「这个人净剩多少额度」（consumableBalance 已含欠账负批次），不是只看单个正批次的 remaining：
      // 净额 > 0 才扣得动、且最多扣到净额为止；净额 ≤ 0 直接跳到下一所有者（共享时即邀请人）。
      // 否则欠账负批次把净额拉低、正批次再多也会被超额扣空，导致该落邀请人的消费没落过去。
      let ownerBudget = balanceByOwner.get(ownerId) ?? new Decimal(0)
      if (ownerBudget.lessThanOrEqualTo(0)) continue
      for (const tier of tiers) {
        if (remainingToCharge.lessThanOrEqualTo(0) || ownerBudget.lessThanOrEqualTo(0)) break
        // 同一层内多桶（如赠送层 PACKAGE+GIFT）合池，统一按过期先后扣，跨桶共享 FIFO
        const tierLots = tier
          .flatMap(b => byOwnerBucket.get(`${ownerId}:${b}`) ?? [])
          .sort(byExpiry)

        const takenByBucket = new Map<CreditBucket, Decimal>()
        for (const lot of tierLots) {
          if (remainingToCharge.lessThanOrEqualTo(0) || ownerBudget.lessThanOrEqualTo(0)) break
          const lotRemaining = new Decimal(lot.remaining)
          // 扣额上限 = min(本批次剩余, 本次待扣, 本人净额预算)——按净额封顶，绝不超净额扣
          const cap = remainingToCharge.lessThan(ownerBudget) ? remainingToCharge : ownerBudget
          const take = lotRemaining.greaterThan(cap) ? cap : lotRemaining
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
          takenByBucket.set(
            lot.bucket,
            (takenByBucket.get(lot.bucket) ?? new Decimal(0)).plus(take)
          )
          remainingToCharge = remainingToCharge.minus(take)
          ownerBudget = ownerBudget.minus(take)
          if (ownerId !== userId) inviterDrawn = inviterDrawn.plus(take)
        }

        // 每动一个桶写一条 CONSUME 流水（userId=批次所有者；扣的是邀请人额度时 relatedUserId=消费者）
        let running = runningByOwner.get(ownerId) ?? new Decimal(0)
        for (const bucket of tier) {
          const takenFromBucket = takenByBucket.get(bucket)
          if (takenFromBucket && takenFromBucket.greaterThan(0)) {
            running = running.minus(takenFromBucket)
            // 动用邀请人额度的行：balanceAfter 记邀请人池余额（邀请人视角看自己流水；被邀请人视角
            // 也展示它——2026-09-01 bug13 产品口径：剩余积分=邀请人共享积分扣后余额）。meta 里仍存
            // 消费者自己净额（consumerBalanceAfter，读侧已不再使用，保留仅作审计快照）。
            const rowMeta =
              ownerId === userId
                ? (opts.meta as Prisma.InputJsonValue | undefined)
                : ({
                    ...(opts.meta ?? {}),
                    consumerBalanceAfter: (runningByOwner.get(userId) ?? new Decimal(0)).toString(),
                  } as Prisma.InputJsonValue)
            await tx.creditTransaction.create({
              data: {
                userId: ownerId,
                direction: CreditDirection.DEBIT,
                bucket,
                type: CreditTxnType.CONSUME,
                amount: takenFromBucket,
                balanceAfter: running,
                source: opts.source ?? null,
                invokeType: opts.invokeType ?? InvokeType.PLATFORM,
                relatedUserId: ownerId === userId ? null : userId,
                meta: rowMeta,
              },
            })
            breakdown.push({ bucket, amount: takenFromBucket.toString() })
          }
        }
        runningByOwner.set(ownerId, running)
      }
    }

    // 透支兜底（仅 allowOverdraft，如视频出片结算）：所有可用池（含共享的邀请人额度）扣尽仍有缺口 →
    // 在「消费者自己」RECHARGE 记一笔负批次（欠账），不阻断已出片视频的交付；欠账由消费者下次充值抵扣，
    // 不记到邀请人头上（relatedUserId 留空，故计入消费者自己消耗、可返利）。
    if (remainingToCharge.greaterThan(0)) {
      // 桶域限定且不含 RECHARGE 时不允许透支落账：欠账批次固定写 RECHARGE，落在域外会污染分段账务
      // （正常不会到这里——混合扣费各段调用前已按锁定净额预扣，只有并发异常才可能触发）。
      if (opts.bucketScope && !opts.bucketScope.includes(CreditBucket.RECHARGE)) {
        throw new BadRequestException("积分余额不足，请充值")
      }
      const debt = new Decimal(0).minus(remainingToCharge)
      await tx.creditLot.create({
        data: {
          userId,
          bucket: CreditBucket.RECHARGE,
          amount: debt,
          remaining: debt,
          expiresAt: null,
          sourceType: CreditTxnType.CONSUME,
          status: CreditLotStatus.ACTIVE,
        },
      })
      const running = (runningByOwner.get(userId) ?? new Decimal(0)).minus(remainingToCharge)
      runningByOwner.set(userId, running)
      await tx.creditTransaction.create({
        data: {
          userId,
          direction: CreditDirection.DEBIT,
          bucket: CreditBucket.RECHARGE,
          type: CreditTxnType.CONSUME,
          amount: remainingToCharge,
          balanceAfter: running,
          source: opts.source ?? null,
          invokeType: opts.invokeType ?? InvokeType.PLATFORM,
          relatedUserId: null,
          meta: opts.meta as Prisma.InputJsonValue | undefined,
        },
      })
      breakdown.push({ bucket: CreditBucket.RECHARGE, amount: remainingToCharge.toString() })
      remainingToCharge = new Decimal(0)
    }

    // 多级返利（2026-08-20 新口径，替代 LV4 单层返利）：沿 invitedById 上溯，规则见 settleRebatesInTx。
    // 消耗基数维持原口径：只计「扣自被邀请人自己额度」的部分（ownDrawn = charge − 动用邀请人共享额度部分）。
    await this.settleRebatesInTx(tx, userId, charge.minus(inviterDrawn), {
      source: opts.source,
      meta: opts.meta,
    })

    this.logger.log(
      `consume user=${userId} cost=${cost.toString()} charge=${charge.toString()} buckets=${breakdown
        .map(b => b.bucket)
        .join("+")}`
    )
    const balanceAfter = await this.consumableBalance(tx, userId)
    return { creditsCharged: charge, costCny: cost, breakdown, balanceAfter }
  }

  /**
   * 多级返利内核（2026-08-20 新口径，替代 LV4 单层返利）：
   * - 从消费者沿 invitedById 上溯，最多 RebateRule.maxLayers 层（无规则行默认 2；maxLayers=null 不限层级，上溯到底）；
   *   第一层按该邀请人 rebateRate，第二层按其 level2RebateRate（null 用全局默认 0.10）；
   *   邀请人 rebateEnabled=false → 跳过该层（继续上溯，链不断）。
   * - 封顶：perConsumeCapPct（各层合计超 base×pct 时等比缩减）；perInviterCap（邀请人自然月
   *   REBATE_IN 累计封顶，当月已返部分抵扣）。
   * - 每层 REBATE 桶入账（永不过期、不可消费）+ REBATE_IN 流水（relatedUserId=消费者，meta.layer 记层）。
   */
  private async settleRebatesInTx(
    tx: Tx,
    consumerUserId: number,
    base: Decimal,
    opts: {
      source?: string | null
      meta?: Record<string, unknown>
      /**
       * 链起点覆盖：默认沿消费者本人 invitedById 上溯；
       * 企业池段传企业邀请人（Team.invitedById 快照，null=无企业邀请人 → 该段不计佣）——
       * 成员个人段沿成员个人邀请链、企业段沿企业邀请链，互不串账（2026-08-31）。
       */
      chainRootInviterId?: number | null
      /**
       * 企业池段结算时传 teamId：REBATE_IN 流水行同步落 teamId（2026-09-01 起），
       * 供分销关系树把池返利向上卷起归属到企业管理员节点（个人段为 null 不受影响）。
       */
      teamId?: number | null
    }
  ): Promise<void> {
    if (base.lessThanOrEqualTo(0)) return
    const ruleRow = await tx.rebateRule.findFirst({ orderBy: { id: "asc" } })
    // 无规则行 → 默认 2 层；规则行 maxLayers=null → 不限层级（2026-09-01 bug15，沿邀请链上溯到底）
    const maxLayers = ruleRow ? (ruleRow.maxLayers ?? Number.MAX_SAFE_INTEGER) : 2
    const perInviterCap = ruleRow?.perInviterCap ?? null
    const perConsumeCapPct = ruleRow?.perConsumeCapPct
      ? new Decimal(ruleRow.perConsumeCapPct)
      : null

    // 链起点：默认消费者的上级；企业池段用覆盖值（企业邀请人快照）
    let nextInviterId: number | null
    if (opts.chainRootInviterId !== undefined) {
      nextInviterId = opts.chainRootInviterId
    } else {
      const consumer = await tx.user.findUnique({
        where: { id: consumerUserId },
        select: { invitedById: true },
      })
      nextInviterId = consumer?.invitedById ?? null
    }

    // 沿 invitedById 上溯建返利链。计酬闸门（2026-08-31，跳层链不断、上级照常）：
    // ① rebateEnabled=true；② 账号在启用（停用立即停酬，启用恢复）；
    // ③ 邀请权在库 canInvite=true（2026-09-01 起落库制：关闭分销代理/上级收回立即停酬，重开恢复）
    const chain: { userId: number; rate: Decimal; layer: number }[] = []
    let layer = 0
    while (nextInviterId != null && layer < maxLayers) {
      const inviter: {
        id: number
        invitedById: number | null
        rebateRate: Prisma.Decimal
        level2RebateRate: Prisma.Decimal | null
        rebateEnabled: boolean
        isActive: boolean
        canInvite: boolean
      } | null = await tx.user.findUnique({
        where: { id: nextInviterId },
        select: {
          id: true,
          invitedById: true,
          rebateRate: true,
          level2RebateRate: true,
          rebateEnabled: true,
          isActive: true,
          canInvite: true,
        },
      })
      if (!inviter) break
      layer++
      if (inviter.rebateEnabled && inviter.isActive && inviter.canInvite) {
        const rate =
          layer === 1
            ? new Decimal(inviter.rebateRate)
            : new Decimal(inviter.level2RebateRate ?? DEFAULT_LEVEL2_REBATE_RATE)
        chain.push({ userId: inviter.id, rate, layer })
      }
      nextInviterId = inviter.invitedById
    }
    if (!chain.length) return

    // 每层金额 = base × 比例，最多 4 位小数（2026-08-31 起不抹零：1×30% 返 0.3；
    // 此前逐层取整会把不足 1 积分的返利抹成 0，低积分消费返利形同虚设）
    let rebates = chain.map(c => ({
      ...c,
      amount: quantize4(base.mul(c.rate)),
    }))
    // perConsumeCapPct：合计超限 → 各层等比缩减（4dp 量化；入账前再校验合计不破顶）
    if (perConsumeCapPct) {
      const cap = base.mul(perConsumeCapPct)
      const total = rebates.reduce((s, r) => s.plus(r.amount), new Decimal(0))
      if (total.greaterThan(cap) && total.greaterThan(0)) {
        const factor = cap.div(total)
        rebates = rebates.map(r => ({ ...r, amount: quantize4(r.amount.mul(factor)) }))
      }
      // 入账前再校验合计：返利之和不得超过 base×perConsumeCapPct（防御 4dp 量化尾差，超限从末层扣回）
      const sum = rebates.reduce((s, r) => s.plus(r.amount), new Decimal(0))
      if (sum.greaterThan(cap)) {
        this.logger.error(
          `单笔返利封顶校验失败：base=${base.toString()} cap=${cap.toString()} 合计=${sum.toString()}，按封顶截断`
        )
        let excess = sum.minus(cap)
        for (let i = rebates.length - 1; i >= 0 && excess.greaterThan(0); i--) {
          const cut = Decimal.min(rebates[i].amount, excess)
          rebates[i] = { ...rebates[i], amount: rebates[i].amount.minus(cut) }
          excess = excess.minus(cut)
        }
      }
    }
    // perInviterCap：邀请人自然月 REBATE_IN 累计封顶
    if (perInviterCap != null) {
      // 锁链上邀请人行（FOR UPDATE，id 升序防死锁）：月累计是读-改-写，并发消费不加锁会双双过检、当月超封顶
      const ids = [...new Set(rebates.map(r => r.userId))].sort((a, b) => a - b)
      if (ids.length) {
        await tx.$queryRaw`SELECT id FROM \`User\` WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
      }
      // 北京自然月起点（容器 UTC 也必须按北京切月，否则每月 1 日 00:00–08:00 错算上月）
      const monthStart = beijingMonthStart()
      const sums = await tx.creditTransaction.groupBy({
        by: ["userId"],
        where: {
          userId: { in: rebates.map(r => r.userId) },
          type: CreditTxnType.REBATE_IN,
          createdAt: { gte: monthStart },
        },
        _sum: { amount: true },
      })
      const usedByInviter = new Map(sums.map(s => [s.userId, new Decimal(s._sum.amount ?? 0)]))
      const cap = new Decimal(perInviterCap)
      rebates = rebates.map(r => {
        const used = usedByInviter.get(r.userId) ?? new Decimal(0)
        const remaining = cap.minus(used)
        return { ...r, amount: Decimal.max(Decimal.min(r.amount, remaining), new Decimal(0)) }
      })
    }

    for (const r of rebates) {
      if (r.amount.lessThanOrEqualTo(0)) continue
      const lot = await tx.creditLot.create({
        data: {
          userId: r.userId,
          bucket: CreditBucket.REBATE,
          amount: r.amount,
          remaining: r.amount,
          expiresAt: null,
          sourceType: CreditTxnType.REBATE_IN,
          status: CreditLotStatus.ACTIVE,
        },
      })
      const balanceAfter = await this.bucketBalance(tx, r.userId, CreditBucket.REBATE)
      await tx.creditTransaction.create({
        data: {
          userId: r.userId,
          direction: CreditDirection.CREDIT,
          bucket: CreditBucket.REBATE,
          type: CreditTxnType.REBATE_IN,
          amount: r.amount,
          balanceAfter,
          relatedUserId: consumerUserId,
          lotId: lot.id,
          teamId: opts.teamId ?? null, // 企业池段返利行落 teamId（树卷起归属用；个人段 null）
          source: opts.source ?? null,
          meta: { ...(opts.meta ?? {}), layer: r.layer },
        },
      })
    }
  }

  /**
   * 到期未续费 → 自动降为无等级：subscriptionTier 置空、membershipLevel 回写 NONE。
   * subscriptionExpiresAt 保留作「曾订阅已过期」判据（身份 SUB_EXPIRED / 到期提醒口径不变）。
   * 由每日清零任务调用；读侧（getWallet 等级）已按有效期即时推导，不等本任务。
   */
  async downgradeExpiredSubscriptions(now = new Date()): Promise<{ downgraded: number }> {
    const res = await this.prisma.user.updateMany({
      where: {
        subscriptionTier: { not: null },
        subscriptionExpiresAt: { not: null, lte: now },
      },
      data: { subscriptionTier: null, membershipLevel: MembershipLevel.NONE },
    })
    if (res.count) {
      this.logger.log(`downgradeExpiredSubscriptions: ${res.count} 个到期未续费用户降为无等级`)
    }
    return { downgraded: res.count }
  }

  /** 钱包：各桶余额 + 当前等级 + 本月已用 + 累计消耗 + 最近清零时间 */
  async getWallet(userId: number): Promise<WalletView> {
    // 读时兜底：先激活到期的待生效续费套餐，保证等级/余额是最新的
    await this.activateDuePlans(userId)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        canInvite: true,
        invitedById: true,
        subscriptionTier: true,
        subscriptionExpiresAt: true,
        discount: true,
        rebateRate: true,
        invitedBy: {
          select: { id: true, username: true, shareCreditsWithInvitees: true, canInvite: true },
        },
      },
    })
    if (!user) throw new NotFoundException("用户不存在")

    const now = new Date()
    const lots = await this.prisma.creditLot.findMany({
      where: {
        userId,
        teamId: null,
        status: CreditLotStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { bucket: true, remaining: true, expiresAt: true },
    })

    const buckets: Record<CreditBucket, Decimal> = {
      [CreditBucket.RECHARGE]: new Decimal(0),
      [CreditBucket.PACKAGE]: new Decimal(0),
      [CreditBucket.GIFT]: new Decimal(0),
      [CreditBucket.REBATE]: new Decimal(0),
    }
    for (const l of lots) {
      buckets[l.bucket] = buckets[l.bucket].plus(l.remaining)
    }

    // 最早到期的赠送批次时点（PACKAGE 套餐/充值赠送 + GIFT 注册赠送，均会过期）
    // + 该时点将清零的积分数（同一时点多笔则合计）
    const expiring = lots.filter(
      l => (l.bucket === CreditBucket.PACKAGE || l.bucket === CreditBucket.GIFT) && l.expiresAt
    )
    let nextExpireAt: Date | null = null
    let nextExpireAmount: Decimal | null = null
    if (expiring.length) {
      const minTime = Math.min(...expiring.map(l => l.expiresAt!.getTime()))
      nextExpireAt = new Date(minTime)
      nextExpireAmount = expiring
        .filter(l => l.expiresAt!.getTime() === minTime)
        .reduce((s, l) => s.plus(l.remaining), new Decimal(0))
    }

    // 本月已用：北京自然月口径（容器 UTC 切月不偏 8 小时）
    const monthStart = beijingMonthStart(now)
    // 已消耗 = 本人实际消费：自己池(userId=自己) ∪ 动用邀请人额度(relatedUserId=自己)的消费——
    // 后者记在邀请人账上，但确是本人消费的，算本人头上（与积分明细 LV4 视角同口径）。
    const consumedByMe: Prisma.CreditTransactionWhereInput = {
      type: CreditTxnType.CONSUME,
      OR: [{ userId }, { relatedUserId: userId }],
    }
    const [monthAgg, totalAgg] = await Promise.all([
      this.prisma.creditTransaction.aggregate({
        where: { ...consumedByMe, createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      this.prisma.creditTransaction.aggregate({
        where: consumedByMe,
        _sum: { amount: true },
      }),
    ])

    const total = buckets[CreditBucket.RECHARGE]
      .plus(buckets[CreditBucket.PACKAGE])
      .plus(buckets[CreditBucket.GIFT])

    // 等级按有效期即时推导：已过期（即便库中 tier 尚未被每日任务置空）一律显示无等级
    const effectiveTier =
      user.subscriptionExpiresAt && user.subscriptionExpiresAt > now ? user.subscriptionTier : null

    return {
      level: resolveLevel({ ...user, subscriptionTier: effectiveTier }),
      buckets: {
        recharge: buckets[CreditBucket.RECHARGE],
        package: buckets[CreditBucket.PACKAGE],
        gift: buckets[CreditBucket.GIFT],
        rebate: buckets[CreditBucket.REBATE],
      },
      total,
      monthUsed: monthAgg._sum.amount ?? new Decimal(0),
      totalConsumed: totalAgg._sum.amount ?? new Decimal(0),
      nextExpireAt,
      nextExpireAmount,
      // 生效折扣：canInvite=false 且有邀请人 → 跟随上级当前折扣（2026-09-02 口径）
      discount: await this.resolveEffectiveDiscount(this.prisma, user),
      rebateRate: new Decimal(user.rebateRate),
      subscriptionExpiresAt: user.subscriptionExpiresAt,
      inviter: user.invitedBy ? { id: user.invitedBy.id, username: user.invitedBy.username } : null,
      // 展示与消费同口径（bug28）：邀请人已关闭邀请权时共享实际失效，钱包不得再显示「开放共享」
      inviterShareCredits: user.invitedBy
        ? user.invitedBy.shareCreditsWithInvitees && user.invitedBy.canInvite
        : null,
    }
  }

  /**
   * 周期清零：把已过期的赠送批次（PACKAGE 套餐/充值赠送、GIFT 注册赠送）置 EXPIRED、remaining→0，
   * 并写一条 EXPIRE 流水（清零必留痕）。由每日定时任务调用；读时余额一律过滤 expiresAt>now，
   * 故即使本任务延迟也不会误扣。RECHARGE/REBATE 永不过期，不在清零范围。
   * **仅清个人批次（teamId=null）**：团队套餐/赠送批次随团队同日到期，但团队到期进宽限期（GRACE）
   * 只是冻结不是清零——批次保留至归档时由 archiveTeamPool 统一清零留痕，宽限期内续费可完整恢复。
   */
  async expireLots(now = new Date()) {
    const expired = await this.prisma.creditLot.findMany({
      where: {
        bucket: { in: [CreditBucket.PACKAGE, CreditBucket.GIFT] },
        status: CreditLotStatus.ACTIVE,
        remaining: { gt: 0 },
        expiresAt: { lte: now },
        teamId: null, // 团队批次不在此清零（宽限期保留，归档统一清）
      },
      select: { id: true, userId: true, bucket: true, teamId: true },
    })

    let count = 0
    for (const lot of expired) {
      await this.prisma.$transaction(async tx => {
        const fresh = await tx.creditLot.findUnique({
          where: { id: lot.id },
          select: { remaining: true, status: true },
        })
        if (
          !fresh ||
          fresh.status !== CreditLotStatus.ACTIVE ||
          new Decimal(fresh.remaining).lessThanOrEqualTo(0)
        ) {
          return
        }
        await tx.creditLot.update({
          where: { id: lot.id },
          data: { remaining: 0, status: CreditLotStatus.EXPIRED },
        })
        const balanceAfter = await this.displayBalance(tx, lot.userId, lot.bucket)
        await tx.creditTransaction.create({
          data: {
            userId: lot.userId,
            direction: CreditDirection.DEBIT,
            bucket: lot.bucket,
            type: CreditTxnType.EXPIRE,
            amount: fresh.remaining,
            balanceAfter,
            lotId: lot.id,
            teamId: lot.teamId, // 恒为 null（团队批次不由本任务清零），保留字段兼容老流水
            source: "system.expire", // 每日到期清零（系统回收），区别于切 LV5 的 invite.switch
          },
        })
        count++
      })
    }
    if (count) this.logger.log(`expireLots: expired ${count} gift/package lots`)
    return { expired: count }
  }

  /**
   * 激活某用户已到期的「待生效续费套餐」（排队生效）：
   * 当前订阅到期后，按 activateAt 升序把 PENDING 套餐逐个激活——发 PACKAGE 积分（30 天有效期从
   * activateAt 起算）+ 写 RECHARGE_PLAN 流水 + 切订阅档/到期日/等级，并标该套餐 ACTIVATED。
   * 幂等：当前订阅仍在有效期、或无到期待生效套餐时不做任何事；停机跨多周期会链式追平。
   * 读时（getWallet/consume 进入时）与每日定时任务都会调用，故漏跑也会被下次访问兜底。
   */
  async activateDuePlans(userId: number, now = new Date()): Promise<{ activated: number }> {
    let activated = 0
    for (;;) {
      // 三态：stop=无可激活/订阅仍有效；activated=本轮激活一个；skip=被并发抢走、继续看下一张
      const result = await this.prisma.$transaction(async tx => {
        // 先看有没有到期的待生效套餐——没有就直接收工，不必加载用户（高频读路径的零开销快路径）
        const plan = await tx.scheduledPlan.findFirst({
          where: {
            userId,
            teamId: null,
            status: ScheduledPlanStatus.PENDING,
            activateAt: { lte: now },
          },
          orderBy: { activateAt: "asc" },
        })
        if (!plan) return "stop" as const

        const user = await tx.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            canInvite: true,
            invitedById: true,
            subscriptionExpiresAt: true,
          },
        })
        if (!user) return "stop" as const
        // 当前订阅仍在有效期 → 不激活下一个（队列等当前周期结束）
        if (user.subscriptionExpiresAt && user.subscriptionExpiresAt > now) return "stop" as const

        // 抢占式激活：先条件把这张 PENDING 置 ACTIVATED，只有抢到(count===1)的事务才往下发积分。
        // 并发第二笔的 updateMany（UPDATE 当前读+行锁）阻塞后重读到 ACTIVATED 不匹配 → count=0 → 跳过，
        // 杜绝重复激活/重复发积分，不依赖隔离级别。
        const claimed = await tx.scheduledPlan.updateMany({
          where: { id: plan.id, status: ScheduledPlanStatus.PENDING },
          data: { status: ScheduledPlanStatus.ACTIVATED, activatedAt: now },
        })
        if (claimed.count !== 1) return "skip" as const

        // 抢到后才发积分：只建批次（套餐本体 PACKAGE + 赠送 GIFT，30 天有效期从 activateAt 起算）。
        // 充值流水已在续费下单(scheduleRenewal)时记过，这里不再写流水，避免充值记录重复。
        const expiresAt = new Date(plan.activateAt.getTime() + plan.periodDays * DAY_MS)
        for (const lot of [
          { bucket: CreditBucket.PACKAGE, amount: plan.packageCredits },
          { bucket: CreditBucket.GIFT, amount: plan.giftCredits },
        ]) {
          if (lot.amount <= 0) continue
          const amount = new Decimal(lot.amount)
          await tx.creditLot.create({
            data: {
              userId,
              bucket: lot.bucket,
              amount,
              remaining: amount,
              expiresAt,
              sourceType: CreditTxnType.RECHARGE_PLAN,
              sourceRef: `plan:LV${plan.tier}`,
              status: CreditLotStatus.ACTIVE,
            },
          })
        }
        await tx.user.update({
          where: { id: userId },
          data: {
            subscriptionTier: plan.tier,
            subscriptionStart: plan.activateAt,
            subscriptionExpiresAt: expiresAt,
            membershipLevel: resolveLevel({
              subscriptionTier: plan.tier,
            }),
          },
        })
        return "activated" as const // 激活了一个，继续看下一个（追平多周期）
      })
      if (result === "stop") break
      if (result === "activated") activated++
      // "skip"：被并发抢走，继续循环看下一张（不计数）
    }
    if (activated) this.logger.log(`activateDuePlans user=${userId} activated=${activated}`)
    return { activated }
  }

  /** 扫描所有有「到期待生效套餐」的用户并激活（每日定时任务用）。 */
  async activateAllDuePlans(now = new Date()): Promise<{ activated: number; users: number }> {
    const due = await this.prisma.scheduledPlan.findMany({
      where: { teamId: null, status: ScheduledPlanStatus.PENDING, activateAt: { lte: now } },
      select: { userId: true },
      distinct: ["userId"],
    })
    let activated = 0
    for (const { userId } of due) {
      const res = await this.activateDuePlans(userId, now)
      activated += res.activated
    }
    return { activated, users: due.length }
  }

  /** 某用户的待生效续费队列（按 activateAt 升序），供后台队列展示 / 续费结果返回。 */
  async listScheduledPlans(userId: number) {
    const plans = await this.prisma.scheduledPlan.findMany({
      where: { userId, teamId: null, status: ScheduledPlanStatus.PENDING },
      orderBy: { activateAt: "asc" },
    })
    return plans.map(p => ({
      id: p.id,
      tier: p.tier,
      planName: p.planName,
      priceCny: p.priceCny.toString(),
      packageCredits: p.packageCredits,
      giftCredits: p.giftCredits,
      periodDays: p.periodDays,
      activateAt: p.activateAt,
      expiresAt: new Date(p.activateAt.getTime() + p.periodDays * DAY_MS),
      createdAt: p.createdAt,
    }))
  }

  /**
   * 【遗留】续费排队下单：把套餐排到「当前订阅 + 已排队队尾」之后，到期由 activateDuePlans 依次激活。
   * 2026-08-25 起续费改为立即生效（renewImmediateInTx），本方法仅为历史排队单保留读/激活链路，
   * 新代码请用 renewImmediateInTx。
   * 下单即记一条 RECHARGE_PLAN 充值流水（付款就显示在充值记录里），但**此时不发积分批次**——
   * 积分到激活时才到账，故不影响余额。meta.scheduled/activateAt 供前端标「待生效」。
   * 当前无有效订阅且队列为空时 activateAt=now，随后立即激活。
   * opts.source/sourceRef/meta：供线上订单（billing.order）覆盖默认的后台来源标识。
   */
  async scheduleRenewal(
    userId: number,
    snapshot: {
      tier: number
      planName: string
      priceCny: Decimal
      packageCredits: number
      giftCredits: number
      periodDays: number
    },
    now = new Date(),
    opts: { source?: string; sourceRef?: string; meta?: Record<string, unknown> } = {}
  ) {
    // 先把已到期的待生效套餐激活，保证队列/订阅状态最新，再算队尾
    await this.activateDuePlans(userId, now)

    const [user, pending] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { subscriptionExpiresAt: true },
      }),
      this.prisma.scheduledPlan.findMany({
        where: { userId, status: ScheduledPlanStatus.PENDING },
        select: { activateAt: true, periodDays: true },
      }),
    ])

    // 队尾到期时刻 = 当前有效订阅到期日 与 所有待生效套餐到期日 中的最晚者；都没有则立即生效(now)
    const tails: number[] = []
    if (user?.subscriptionExpiresAt && user.subscriptionExpiresAt > now) {
      tails.push(user.subscriptionExpiresAt.getTime())
    }
    for (const p of pending) tails.push(p.activateAt.getTime() + p.periodDays * DAY_MS)
    const activateAt = tails.length ? new Date(Math.max(...tails)) : now

    const amount = new Decimal(snapshot.packageCredits + snapshot.giftCredits)
    const created = await this.prisma.$transaction(async tx => {
      const sp = await tx.scheduledPlan.create({
        data: {
          userId,
          tier: snapshot.tier,
          activateAt,
          status: ScheduledPlanStatus.PENDING,
          planName: snapshot.planName,
          priceCny: snapshot.priceCny,
          packageCredits: snapshot.packageCredits,
          giftCredits: snapshot.giftCredits,
          periodDays: snapshot.periodDays,
        },
      })
      // 付款即记充值流水（不发批次，balanceAfter=null 表示「待生效、未到账」）
      await tx.creditTransaction.create({
        data: {
          userId,
          direction: CreditDirection.CREDIT,
          bucket: CreditBucket.PACKAGE,
          type: CreditTxnType.RECHARGE_PLAN,
          amount,
          balanceAfter: null,
          source: opts.source ?? "admin.recharge.plan",
          meta: {
            tier: snapshot.tier,
            name: snapshot.planName,
            packageCredits: snapshot.packageCredits,
            giftCredits: snapshot.giftCredits,
            priceCny: snapshot.priceCny.toNumber(),
            scheduled: true,
            activateAt: activateAt.toISOString(),
            // 激活后的到期时刻 = activateAt + 周期，供充值记录读时判「已过期」（待生效阶段它是未来时间）
            expiresAt: new Date(activateAt.getTime() + snapshot.periodDays * DAY_MS).toISOString(),
            scheduledPlanId: sp.id,
            ...(opts.sourceRef ? { sourceRef: opts.sourceRef } : {}),
            ...(opts.meta ?? {}),
          },
        },
      })
      return sp
    })

    // 无可排队对象（activateAt<=now）→ 立即激活这笔
    await this.activateDuePlans(userId, now)
    return created
  }

  /**
   * 【遗留】scheduleRenewal 的事务内变体。2026-08-25 起订单 settle 改走 renewImmediateInTx（立即生效），
   * 本方法保留仅为兼容历史排队单的激活链路。
   */
  async scheduleRenewalInTx(
    tx: Tx,
    userId: number,
    snapshot: {
      tier: number
      planName: string
      priceCny: Decimal
      packageCredits: number
      giftCredits: number
      periodDays: number
    },
    now = new Date(),
    opts: { source?: string; sourceRef?: string; meta?: Record<string, unknown> } = {}
  ) {
    const [user, pending] = await Promise.all([
      tx.user.findUnique({
        where: { id: userId },
        select: { subscriptionExpiresAt: true },
      }),
      tx.scheduledPlan.findMany({
        where: { userId, teamId: null, status: ScheduledPlanStatus.PENDING },
        select: { activateAt: true, periodDays: true },
      }),
    ])
    const tails: number[] = []
    if (user?.subscriptionExpiresAt && user.subscriptionExpiresAt > now) {
      tails.push(user.subscriptionExpiresAt.getTime())
    }
    for (const p of pending) tails.push(p.activateAt.getTime() + p.periodDays * DAY_MS)
    const activateAt = tails.length ? new Date(Math.max(...tails)) : now

    const amount = new Decimal(snapshot.packageCredits + snapshot.giftCredits)
    const sp = await tx.scheduledPlan.create({
      data: {
        userId,
        tier: snapshot.tier,
        activateAt,
        status: ScheduledPlanStatus.PENDING,
        planName: snapshot.planName,
        priceCny: snapshot.priceCny,
        packageCredits: snapshot.packageCredits,
        giftCredits: snapshot.giftCredits,
        periodDays: snapshot.periodDays,
      },
    })
    // 付款即记充值流水（不发批次，balanceAfter=null 表示「待生效、未到账」）
    await tx.creditTransaction.create({
      data: {
        userId,
        direction: CreditDirection.CREDIT,
        bucket: CreditBucket.PACKAGE,
        type: CreditTxnType.RECHARGE_PLAN,
        amount,
        balanceAfter: null,
        source: opts.source ?? "admin.recharge.plan",
        meta: {
          tier: snapshot.tier,
          name: snapshot.planName,
          packageCredits: snapshot.packageCredits,
          giftCredits: snapshot.giftCredits,
          priceCny: snapshot.priceCny.toNumber(),
          scheduled: true,
          activateAt: activateAt.toISOString(),
          expiresAt: new Date(activateAt.getTime() + snapshot.periodDays * DAY_MS).toISOString(),
          scheduledPlanId: sp.id,
          ...(opts.sourceRef ? { sourceRef: opts.sourceRef } : {}),
          ...(opts.meta ?? {}),
        },
      },
    })

    // 无可排队对象（activateAt<=now）→ 本事务内立即激活（抢占式，并发重试只生效一次）
    if (activateAt.getTime() <= now.getTime()) {
      const claimed = await tx.scheduledPlan.updateMany({
        where: { id: sp.id, status: ScheduledPlanStatus.PENDING },
        data: { status: ScheduledPlanStatus.ACTIVATED, activatedAt: now },
      })
      if (claimed.count === 1) {
        const u = await tx.user.findUnique({
          where: { id: userId },
          select: { canInvite: true, invitedById: true, subscriptionExpiresAt: true },
        })
        if (!u?.subscriptionExpiresAt || u.subscriptionExpiresAt <= now) {
          const expiresAt = new Date(activateAt.getTime() + snapshot.periodDays * DAY_MS)
          // 套餐本体 PACKAGE + 赠送 GIFT 分两批次（同到期日）
          for (const lot of [
            { bucket: CreditBucket.PACKAGE, amount: snapshot.packageCredits },
            { bucket: CreditBucket.GIFT, amount: snapshot.giftCredits },
          ]) {
            if (lot.amount <= 0) continue
            const lotAmount = new Decimal(lot.amount)
            await tx.creditLot.create({
              data: {
                userId,
                bucket: lot.bucket,
                amount: lotAmount,
                remaining: lotAmount,
                expiresAt,
                sourceType: CreditTxnType.RECHARGE_PLAN,
                sourceRef: `plan:LV${snapshot.tier}`,
                status: CreditLotStatus.ACTIVE,
              },
            })
          }
          await tx.user.update({
            where: { id: userId },
            data: {
              subscriptionTier: snapshot.tier,
              subscriptionStart: activateAt,
              subscriptionExpiresAt: expiresAt,
              membershipLevel: resolveLevel({
                subscriptionTier: snapshot.tier,
              }),
            },
          })
        }
      }
    }
    return sp
  }

  /**
   * 存量套餐批次顺延（续费/后台调整套餐到期日共用）：仍有效的 RECHARGE_PLAN 来源 PACKAGE/GIFT
   * 个人批次统一延长到新有效期。只延不缩（expiresAt 晚于新有效期的批次不动）；非 RECHARGE_PLAN
   * 来源（注册赠送/充值包赠送/客服补偿）不顺延。2026-09-02 bug22 起后台调整到期日也走这里。
   */
  async extendPlanLotExpiryInTx(tx: Tx, userId: number, newExpiry: Date, now = new Date()) {
    await tx.creditLot.updateMany({
      where: {
        userId,
        teamId: null,
        sourceType: CreditTxnType.RECHARGE_PLAN,
        bucket: { in: [CreditBucket.PACKAGE, CreditBucket.GIFT] },
        status: CreditLotStatus.ACTIVE,
        remaining: { gt: 0 },
        expiresAt: { gt: now, lt: newExpiry },
      },
      data: { expiresAt: newExpiry },
    })
  }

  /**
   * 套餐续费/新订阅（**立即生效**，2026-08-25 起新口径，废排队制）：
   * 有效期立即在「当前到期日（已过期/无订阅则 now）」上顺延一个周期；套餐本体 PACKAGE +
   * 赠送 GIFT 两批次立即到账（到期日 = 新有效期）；等级/档立即切换。一条充值流水（recordRecharge
   * 多批次一流水，不带 scheduled 标记 → 充值记录直接显示已到账）。
   * **存量批次顺延（2026-08-28 起）**：续费前未过期的 RECHARGE_PLAN 来源 PACKAGE/GIFT 批次
   * 统一延长到新有效期（订阅延续则积分延续）；充值包本金/注册赠送/充值包赠送/客服补偿不顺延。
   * - 在期且目标档低于当前档 → 400（高等级不能续费低等级；同档=续期，升档续费允许立即切档）。
   * - 线上订单（PLAN_NEW / PLAN_RENEW settle）与后台 renewPlan 共用本实现；在结算事务内调用。
   */
  async renewImmediateInTx(
    tx: Tx,
    userId: number,
    snapshot: {
      tier: number
      planName: string
      priceCny: Decimal
      packageCredits: number
      giftCredits: number
      periodDays: number
    },
    now = new Date(),
    opts: {
      source?: string
      sourceRef?: string
      meta?: Record<string, unknown>
      /** 仅一次性迁移脚本激活改版前已付款排队单时使用：跳过禁降档守卫（队列是旧口径下购买的） */
      allowTierDowngrade?: boolean
    } = {}
  ) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { subscriptionTier: true, subscriptionStart: true, subscriptionExpiresAt: true },
    })
    if (!user) throw new NotFoundException("用户不存在")
    const active = user.subscriptionExpiresAt != null && user.subscriptionExpiresAt > now
    if (
      !opts.allowTierDowngrade &&
      active &&
      user.subscriptionTier != null &&
      snapshot.tier < user.subscriptionTier
    ) {
      throw new BadRequestException("高等级套餐不能续费低等级套餐")
    }
    // 顺延基准：仍在有效期 = 当前到期日；已过期/无订阅 = now（新起一期）
    const base = active ? user.subscriptionExpiresAt! : now
    const newExpiry = new Date(base.getTime() + snapshot.periodDays * DAY_MS)
    // 存量套餐批次顺延（2026-08-28 产品口径）：续费=订阅延续，续费前未过期的套餐本体（PACKAGE）
    // 与套餐随赠（GIFT）批次统一延长到新有效期——仅 RECHARGE_PLAN 来源；充值包/自定义充值本金
    // 本就不过期，注册赠送/充值包赠送/客服补偿按各自 30 天规则不顺延
    await this.extendPlanLotExpiryInTx(tx, userId, newExpiry, now)
    await this.recordRecharge(
      userId,
      {
        type: CreditTxnType.RECHARGE_PLAN,
        source: opts.source ?? "admin.recharge.plan",
        sourceRef: opts.sourceRef ?? `plan:LV${snapshot.tier}`,
        lots: [
          {
            bucket: CreditBucket.PACKAGE,
            amount: snapshot.packageCredits,
            expiresAt: newExpiry,
          },
          { bucket: CreditBucket.GIFT, amount: snapshot.giftCredits, expiresAt: newExpiry },
        ],
        meta: {
          tier: snapshot.tier,
          name: snapshot.planName,
          packageCredits: snapshot.packageCredits,
          giftCredits: snapshot.giftCredits,
          priceCny: snapshot.priceCny.toNumber(),
          expiresAt: newExpiry.toISOString(), // 充值记录读时判「已过期」用
          ...(opts.meta ?? {}),
        },
      },
      tx
    )
    await tx.user.update({
      where: { id: userId },
      data: {
        subscriptionTier: snapshot.tier,
        // 在期续费保留原订阅起点；新起一期从 now 起算
        subscriptionStart: active ? user.subscriptionStart : now,
        subscriptionExpiresAt: newExpiry,
        membershipLevel: resolveLevel({ subscriptionTier: snapshot.tier }),
      },
    })
    return { expiresAt: newExpiry }
  }

  /**
   * 套餐升档（立即生效）：**补差一次到账，到期日不变**（2026-08-25 起差价/积分差按剩余天数
   * 折算，多次续费拉长有效期后升级 = 整段剩余期都按高档补齐；废 2026-08-20 整月一口价口径）。
   * 线上订单（PLAN_UPGRADE）与后台 chargePlan 共用本实现。
   * - 补差拆分两个批次：套餐本体差 PACKAGE + 赠送差 GIFT，过期时间都 = 原订阅到期日（非 now+30）；
   *   旧档剩余积分保留原到期。一条充值流水（recordRecharge 多批次一流水），充值记录显示 1 行「套餐升级」。
   * - 折算系数由调用方（算价层）算好随 packageDiff/giftDiff 传入，本方法只管积分与切档；
   *   可传外层事务 tx（订单 settle 原子化用）。
   */
  async upgradePlanImmediate(
    userId: number,
    snapshot: {
      fromTier: number
      toTier: number
      planName: string
      packageDiff: number // 套餐本体积分差（高档套餐 − 原档套餐）
      giftDiff: number // 赠送积分差（高档赠送 − 原档赠送）
      expiresAt: Date // 原订阅到期日（不变）
    },
    opts: { source?: string; sourceRef?: string; meta?: Record<string, unknown> } = {},
    tx?: Tx
  ) {
    const run = async (c: Tx) => {
      const user = await c.user.findUnique({
        where: { id: userId },
        select: {
          canInvite: true,
          invitedById: true,
          subscriptionTier: true,
          subscriptionExpiresAt: true,
        },
      })
      if (!user) throw new NotFoundException("用户不存在")
      const now = new Date()
      if (
        !user.subscriptionTier ||
        !user.subscriptionExpiresAt ||
        user.subscriptionExpiresAt <= now
      ) {
        throw new BadRequestException("当前无有效套餐，升级不可用")
      }
      if (user.subscriptionTier !== snapshot.fromTier) {
        throw new BadRequestException("当前套餐档已变化，请重新下单")
      }
      if (snapshot.toTier <= user.subscriptionTier) {
        throw new BadRequestException("套餐周期内仅可升级到更高档，不可降级或平级")
      }
      const lots = [
        { bucket: CreditBucket.PACKAGE, amount: snapshot.packageDiff },
        { bucket: CreditBucket.GIFT, amount: snapshot.giftDiff },
      ].filter(l => l.amount > 0)
      if (lots.length) {
        await this.recordRecharge(
          userId,
          {
            type: CreditTxnType.RECHARGE_PLAN,
            source: opts.source ?? "admin.recharge.plan",
            sourceRef: opts.sourceRef ?? `upgrade:LV${snapshot.fromTier}->LV${snapshot.toTier}`,
            lots: lots.map(l => ({
              bucket: l.bucket,
              amount: l.amount,
              expiresAt: snapshot.expiresAt, // 跟随原订阅到期日（非 now+30）
            })),
            meta: {
              tier: snapshot.toTier,
              name: snapshot.planName,
              upgrade: true, // 充值记录据此标「套餐升级」
              fromTier: snapshot.fromTier,
              packageCredits: snapshot.packageDiff,
              giftCredits: snapshot.giftDiff,
              ...(opts.meta ?? {}),
            },
          },
          c
        )
      }
      await c.user.update({
        where: { id: userId },
        data: {
          // 仅切档与等级，subscriptionExpiresAt / subscriptionStart 不变
          subscriptionTier: snapshot.toTier,
          membershipLevel: resolveLevel({
            subscriptionTier: snapshot.toTier,
          }),
        },
      })
    }

    if (tx) {
      await run(tx)
      return null
    }
    await this.activateDuePlans(userId)
    await this.prisma.$transaction(run)
    this.logger.log(
      `upgradePlanImmediate user=${userId} LV${snapshot.fromTier}->LV${snapshot.toTier} package=${snapshot.packageDiff} gift=${snapshot.giftDiff}`
    )
    return this.getWallet(userId)
  }

  /** 可消费积分合计（RECHARGE + PACKAGE + GIFT，ACTIVE 且未过期；不含 REBATE；仅个人批次 teamId=null）。 */
  async consumableBalance(
    tx: Tx | PrismaService,
    userId: number,
    buckets?: CreditBucket[]
  ): Promise<Decimal> {
    const agg = await tx.creditLot.aggregate({
      where: {
        userId,
        teamId: null,
        bucket: buckets
          ? { in: buckets }
          : { in: [CreditBucket.RECHARGE, CreditBucket.PACKAGE, CreditBucket.GIFT] },
        status: CreditLotStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      _sum: { remaining: true },
    })
    return agg._sum.remaining ?? new Decimal(0)
  }

  /**
   * 混合扣费预读（仅 UsageService.consumeRouted 企业成员路径，事务内调用）：
   * FOR UPDATE 锁本人全部可消费批次（顺序固定按 id，防死锁；必须先于企业池锁），
   * 返回分层净额（赠送层 PACKAGE+GIFT / 充值层 RECHARGE / 合计；含透支负批次）。
   */
  async lockPersonalBalancesInTx(
    tx: Tx,
    userId: number
  ): Promise<{ giftLayer: Decimal; recharge: Decimal; total: Decimal }> {
    await tx.$queryRaw`
      SELECT id FROM CreditLot
      WHERE userId = ${userId}
        AND teamId IS NULL
        AND status = ${CreditLotStatus.ACTIVE}
        AND remaining > 0
        AND bucket IN (${Prisma.join([CreditBucket.PACKAGE, CreditBucket.GIFT, CreditBucket.RECHARGE])})
        AND (expiresAt IS NULL OR expiresAt > NOW())
      ORDER BY id
      FOR UPDATE
    `
    const giftLayer = await this.consumableBalance(tx, userId, [
      CreditBucket.PACKAGE,
      CreditBucket.GIFT,
    ])
    const recharge = await this.consumableBalance(tx, userId, [CreditBucket.RECHARGE])
    return { giftLayer, recharge, total: giftLayer.plus(recharge) }
  }

  /**
   * 混合扣费预读（仅 UsageService.consumeRouted 企业成员路径，事务内调用）：
   * FOR UPDATE 锁企业池全部可消费批次（顺序固定按 id，防死锁；必须在个人批次锁之后），返回池净额。
   */
  async lockTeamPoolBalanceInTx(tx: Tx, teamId: number): Promise<Decimal> {
    await tx.$queryRaw`
      SELECT id FROM CreditLot
      WHERE teamId = ${teamId}
        AND status = ${CreditLotStatus.ACTIVE}
        AND remaining > 0
        AND bucket IN (${Prisma.join([CreditBucket.PACKAGE, CreditBucket.GIFT, CreditBucket.RECHARGE])})
        AND (expiresAt IS NULL OR expiresAt > NOW())
      ORDER BY id
      FOR UPDATE
    `
    return this.teamPoolBalance(teamId, tx)
  }

  /** 多个资金所有者的实际可扣额度：每人只贡献正净额，欠账不跨用户抵消共享额度。 */
  private sumAvailableBalances(balances: Iterable<Decimal>): Decimal {
    let available = new Decimal(0)
    for (const balance of balances) {
      if (balance.greaterThan(0)) available = available.plus(balance)
    }
    return available
  }

  /** 消费资金所有者顺序：永远先本人；仅邀请人明确开启共享时才追加邀请人。 */
  private resolveFundingOwnerIds(
    userId: number,
    inviter: { id: number; shareCreditsWithInvitees: boolean; canInvite?: boolean } | null
  ): number[] {
    // 额度共享双闸门（2026-09-02 bug28）：共享开关 + 邀请人当前邀请权都在才放行——
    // 关闭返利邀请后下级不得再消耗邀请人积分（旧调用方 inviter 缺 canInvite 字段时按不共享兜底）
    return inviter?.shareCreditsWithInvitees === true && inviter.canInvite === true
      ? [userId, inviter.id]
      : [userId]
  }

  /**
   * 流水「balanceAfter」展示口径：写哪个桶就显示哪个池子的余额——
   * 可消费桶(RECHARGE/PACKAGE/GIFT)统一显示「可消费积分总额」（用户看到的是总余额，而非单桶剩余）；
   * REBATE 桶（不可消费、独立核算）显示返利桶自身余额。仅在事务内调用。
   */
  private async displayBalance(tx: Tx, userId: number, bucket: CreditBucket): Promise<Decimal> {
    return bucket === CreditBucket.REBATE
      ? this.bucketBalance(tx, userId, CreditBucket.REBATE)
      : this.consumableBalance(tx, userId)
  }

  /** 某桶当前余额（ACTIVE 且未过期批次 remaining 之和；含透支负批次；仅个人批次 teamId=null）。仅在事务内调用。 */
  private async bucketBalance(tx: Tx, userId: number, bucket: CreditBucket): Promise<Decimal> {
    const agg = await tx.creditLot.aggregate({
      where: {
        userId,
        teamId: null,
        bucket,
        status: CreditLotStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      _sum: { remaining: true },
    })
    return agg._sum.remaining ?? new Decimal(0)
  }

  /**
   * 返利提现：从 REBATE 桶 FIFO 扣减 amount，写一条 REBATE_WITHDRAW 流水。
   * REBATE 不可消费、仅可提现；可提现不足抛 400。
   */
  async withdrawRebate(
    userId: number,
    amount: Decimal | number | string,
    opts: { note?: string } = {}
  ): Promise<{ withdrawn: Decimal; balanceAfter: Decimal }> {
    const amt = new Decimal(amount)
    if (amt.lessThanOrEqualTo(0)) throw new BadRequestException("提现积分必须大于 0")

    return this.prisma.$transaction(
      async tx => {
        // 加锁的「当前读」：直接返回最新已提交 remaining 并锁行，杜绝并发提现丢失更新（同 consume）
        const lots = await tx.$queryRaw<Array<{ id: number; remaining: Prisma.Decimal }>>`
          SELECT id, remaining
          FROM CreditLot
          WHERE userId = ${userId} AND bucket = ${CreditBucket.REBATE} AND status = ${CreditLotStatus.ACTIVE} AND remaining > 0
          ORDER BY grantedAt ASC
          FOR UPDATE
        `
        const available = lots.reduce((s, l) => s.plus(l.remaining), new Decimal(0))
        if (available.lessThan(amt)) throw new BadRequestException("可提现返利积分不足")

        let remaining = amt
        for (const lot of lots) {
          if (remaining.lessThanOrEqualTo(0)) break
          const lotRemaining = new Decimal(lot.remaining)
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

        const balanceAfter = await this.bucketBalance(tx, userId, CreditBucket.REBATE)
        await tx.creditTransaction.create({
          data: {
            userId,
            direction: CreditDirection.DEBIT,
            bucket: CreditBucket.REBATE,
            type: CreditTxnType.REBATE_WITHDRAW,
            amount: amt,
            balanceAfter,
            source: "rebate.withdraw",
            meta: opts.note ? { note: opts.note } : undefined,
          },
        })
        this.logger.log(`withdrawRebate user=${userId} amount=${amt.toString()}`)
        return { withdrawn: amt, balanceAfter }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    )
  }

  /**
   * 强制清零某用户全部会过期的赠送类积分——PACKAGE（套餐/充值赠送）+ GIFT（注册赠送），
   * 充值积分 RECHARGE 不动。逐批按各自桶写 EXPIRE 流水。切换为邀请人(LV5)时调用。可传外层事务。
   */
  async clearGrantedCredits(userId: number, tx?: Tx): Promise<number> {
    const run = async (c: Tx) => {
      const lots = await c.creditLot.findMany({
        where: {
          userId,
          teamId: null,
          bucket: { in: [CreditBucket.PACKAGE, CreditBucket.GIFT] },
          status: CreditLotStatus.ACTIVE,
          remaining: { gt: 0 },
        },
      })
      for (const lot of lots) {
        await c.creditLot.update({
          where: { id: lot.id },
          data: { remaining: 0, status: CreditLotStatus.EXPIRED },
        })
        const balanceAfter = await this.displayBalance(c, userId, lot.bucket)
        await c.creditTransaction.create({
          data: {
            userId,
            direction: CreditDirection.DEBIT,
            bucket: lot.bucket,
            type: CreditTxnType.EXPIRE,
            amount: lot.remaining,
            balanceAfter,
            lotId: lot.id,
            source: "invite.switch",
          },
        })
      }
      return lots.length
    }
    return tx ? run(tx) : this.prisma.$transaction(run)
  }

  /**
   * 反记账扣回（银行卡拒付等）：从可消费桶按消费同序 FIFO 扣减（赠送层先、充值层后），
   * 不足部分在 RECHARGE 记负批次（欠账，下次充值抵扣）。不触发返利。每动一个桶写一条 MANUAL_ADJUST 流水。
   */
  async reverseCredits(
    userId: number,
    credits: Decimal | number | string,
    opts: { source?: string; meta?: Record<string, unknown> } = {}
  ): Promise<{ reversed: Decimal }> {
    const amt = new Decimal(credits)
    if (amt.lessThanOrEqualTo(0)) throw new BadRequestException("扣回积分必须大于 0")

    return this.prisma.$transaction(
      async tx => {
        const tiers = consumeBucketTiers()
        const lots = await tx.$queryRaw<
          Array<{
            id: number
            bucket: CreditBucket
            remaining: Prisma.Decimal
            expiresAt: Date | null
            grantedAt: Date
          }>
        >`
          SELECT id, bucket, remaining, expiresAt, grantedAt
          FROM CreditLot
          WHERE userId = ${userId} AND teamId IS NULL AND status = ${CreditLotStatus.ACTIVE} AND remaining > 0
            AND bucket IN (${Prisma.join(tiers.flat())})
            AND (expiresAt IS NULL OR expiresAt > NOW())
          ORDER BY id
          FOR UPDATE
        `
        const byExpiry = (a: (typeof lots)[number], b: (typeof lots)[number]) => {
          const ax = a.expiresAt ? a.expiresAt.getTime() : Number.MAX_SAFE_INTEGER
          const bx = b.expiresAt ? b.expiresAt.getTime() : Number.MAX_SAFE_INTEGER
          if (ax !== bx) return ax - bx
          return a.grantedAt.getTime() - b.grantedAt.getTime()
        }

        let remaining = amt
        const takenByBucket = new Map<CreditBucket, Decimal>()
        for (const tier of tiers) {
          if (remaining.lessThanOrEqualTo(0)) break
          const tierLots = lots.filter(l => tier.includes(l.bucket)).sort(byExpiry)
          for (const lot of tierLots) {
            if (remaining.lessThanOrEqualTo(0)) break
            const lotRemaining = new Decimal(lot.remaining)
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
            takenByBucket.set(
              lot.bucket,
              (takenByBucket.get(lot.bucket) ?? new Decimal(0)).plus(take)
            )
            remaining = remaining.minus(take)
          }
        }
        // 不足部分记 RECHARGE 负批次（欠账）
        if (remaining.greaterThan(0)) {
          const debt = new Decimal(0).minus(remaining)
          await tx.creditLot.create({
            data: {
              userId,
              bucket: CreditBucket.RECHARGE,
              amount: debt,
              remaining: debt,
              expiresAt: null,
              sourceType: CreditTxnType.MANUAL_ADJUST,
              status: CreditLotStatus.ACTIVE,
            },
          })
          takenByBucket.set(
            CreditBucket.RECHARGE,
            (takenByBucket.get(CreditBucket.RECHARGE) ?? new Decimal(0)).plus(remaining)
          )
        }
        let running = await this.consumableBalance(tx, userId)
        running = running.plus(amt) // 流水 balanceAfter 逐行递减（从扣前余额起）
        for (const [bucket, taken] of takenByBucket) {
          running = running.minus(taken)
          await tx.creditTransaction.create({
            data: {
              userId,
              direction: CreditDirection.DEBIT,
              bucket,
              type: CreditTxnType.MANUAL_ADJUST,
              amount: taken,
              balanceAfter: running,
              source: opts.source ?? "billing.dispute",
              meta: opts.meta as Prisma.InputJsonValue | undefined,
            },
          })
        }
        this.logger.warn(
          `reverseCredits user=${userId} amount=${amt.toString()} source=${opts.source ?? "-"}`
        )
        return { reversed: amt }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    )
  }

  /** 企业共享池可消费余额（RECHARGE + PACKAGE + GIFT，ACTIVE 未过期；含透支负批次）。 */
  async teamPoolBalance(teamId: number, tx?: Tx): Promise<Decimal> {
    const run = async (c: Tx) => {
      const agg = await c.creditLot.aggregate({
        where: {
          teamId,
          bucket: { in: [CreditBucket.RECHARGE, CreditBucket.PACKAGE, CreditBucket.GIFT] },
          status: CreditLotStatus.ACTIVE,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        _sum: { remaining: true },
      })
      return agg._sum.remaining ?? new Decimal(0)
    }
    return tx ? run(tx) : this.prisma.$transaction(run)
  }

  /**
   * 可消费余额·路由口径（2026-09-01）：归属占用中企业（成员 ACTIVE + 团队 ACTIVE）→
   * 个人可消费 + 企业池合计；否则个人三桶（含邀请人共享由消费侧处理，余额口径不含）。
   * 与 consumeRouted 的扣费能力一致——对外开放接口 balance 预检用：只报个人会让企业成员误判余额不足。
   */
  async getConsumableBalanceRouted(userId: number): Promise<Decimal> {
    const member = await this.prisma.teamMember.findFirst({
      where: { userId, status: "ACTIVE", team: { status: TeamStatus.ACTIVE } },
      select: { teamId: true },
    })
    const personal = await this.getConsumableBalance(userId)
    if (!member) return personal
    const pool = await this.teamPoolBalance(member.teamId)
    return personal.plus(pool)
  }

  /**
   * 企业共享池消费：与个人 consume 同序（赠送层 PACKAGE+GIFT 按过期先后 → 充值层 RECHARGE），
   * 但扣的是 CreditLot.teamId=该企业的批次；流水 userId=消费成员 + teamId=企业，type=TEAM_CONSUME。
   * 不走邀请人共享；返利按 RebateRule.corpCounts 开关（默认计）走同一多级内核（消耗基数=全额）。
   * 配额/超额策略由调用方（TeamQuotaService）在同事务内预检与记账。
   */
  async consumeTeamCredits(
    teamId: number,
    userId: number,
    credits: Decimal | number | string,
    costCny: Decimal | number | string,
    opts: {
      source?: string
      meta?: Record<string, unknown>
      allowOverdraft?: boolean
      invokeType?: InvokeType
    } = {},
    tx?: Tx
  ): Promise<ConsumeResult> {
    const charge = new Decimal(credits)
    const cost = new Decimal(costCny)
    if (charge.lessThan(0)) throw new BadRequestException("消费积分不能为负")
    if (cost.lessThan(0)) throw new BadRequestException("消费金额不能为负")
    const run = (c: Tx) => this.consumeTeamInTx(c, teamId, userId, charge, cost, opts)
    return tx
      ? run(tx)
      : this.prisma.$transaction(run, {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        })
  }

  private async consumeTeamInTx(
    tx: Tx,
    teamId: number,
    userId: number,
    charge: Decimal,
    cost: Decimal,
    opts: {
      source?: string
      meta?: Record<string, unknown>
      allowOverdraft?: boolean
      invokeType?: InvokeType
    }
  ): Promise<ConsumeResult> {
    if (charge.lessThanOrEqualTo(0)) {
      return {
        creditsCharged: new Decimal(0),
        costCny: cost,
        breakdown: [],
        balanceAfter: await this.teamPoolBalance(teamId, tx),
      }
    }
    const tiers = consumeBucketTiers()
    // 加锁当前读：锁该企业全部可消费批次（顺序固定按 id，防死锁）
    const lots = await tx.$queryRaw<
      Array<{
        id: number
        bucket: CreditBucket
        remaining: Prisma.Decimal
        expiresAt: Date | null
        grantedAt: Date
      }>
    >`
      SELECT id, bucket, remaining, expiresAt, grantedAt
      FROM CreditLot
      WHERE teamId = ${teamId}
        AND status = ${CreditLotStatus.ACTIVE}
        AND remaining > 0
        AND bucket IN (${Prisma.join(tiers.flat())})
        AND (expiresAt IS NULL OR expiresAt > NOW())
      ORDER BY id
      FOR UPDATE
    `
    const poolBefore = await this.teamPoolBalance(teamId, tx)
    if (!opts.allowOverdraft && poolBefore.lessThan(charge)) {
      throw new BadRequestException("企业积分池余额不足，请联系企业管理员充值")
    }
    const byExpiry = (a: (typeof lots)[number], b: (typeof lots)[number]) => {
      const ax = a.expiresAt ? a.expiresAt.getTime() : Number.MAX_SAFE_INTEGER
      const bx = b.expiresAt ? b.expiresAt.getTime() : Number.MAX_SAFE_INTEGER
      if (ax !== bx) return ax - bx
      return a.grantedAt.getTime() - b.grantedAt.getTime()
    }

    let remaining = charge
    const breakdown: ConsumeBreakdownItem[] = []
    let running = poolBefore
    for (const tier of tiers) {
      if (remaining.lessThanOrEqualTo(0)) break
      const tierLots = lots.filter(l => tier.includes(l.bucket)).sort(byExpiry)
      const takenByBucket = new Map<CreditBucket, Decimal>()
      for (const lot of tierLots) {
        if (remaining.lessThanOrEqualTo(0)) break
        const lotRemaining = new Decimal(lot.remaining)
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
        takenByBucket.set(lot.bucket, (takenByBucket.get(lot.bucket) ?? new Decimal(0)).plus(take))
        remaining = remaining.minus(take)
      }
      for (const bucket of tier) {
        const taken = takenByBucket.get(bucket)
        if (taken && taken.greaterThan(0)) {
          running = running.minus(taken)
          await tx.creditTransaction.create({
            data: {
              userId,
              direction: CreditDirection.DEBIT,
              bucket,
              type: CreditTxnType.TEAM_CONSUME,
              amount: taken,
              balanceAfter: running,
              source: opts.source ?? null,
              invokeType: opts.invokeType ?? InvokeType.PLATFORM,
              teamId,
              meta: opts.meta as Prisma.InputJsonValue | undefined,
            },
          })
          breakdown.push({ bucket, amount: taken.toString() })
        }
      }
    }
    // 透支兜底（同个人口径：RECHARGE 负批次欠账，挂在企业池）
    if (remaining.greaterThan(0)) {
      const debt = new Decimal(0).minus(remaining)
      await tx.creditLot.create({
        data: {
          userId,
          bucket: CreditBucket.RECHARGE,
          amount: debt,
          remaining: debt,
          expiresAt: null,
          sourceType: CreditTxnType.TEAM_CONSUME,
          status: CreditLotStatus.ACTIVE,
          teamId,
        },
      })
      running = running.minus(remaining)
      await tx.creditTransaction.create({
        data: {
          userId,
          direction: CreditDirection.DEBIT,
          bucket: CreditBucket.RECHARGE,
          type: CreditTxnType.TEAM_CONSUME,
          amount: remaining,
          balanceAfter: running,
          source: opts.source ?? null,
          invokeType: opts.invokeType ?? InvokeType.PLATFORM,
          teamId,
          meta: opts.meta as Prisma.InputJsonValue | undefined,
        },
      })
      breakdown.push({ bucket: CreditBucket.RECHARGE, amount: remaining.toString() })
    }
    // 企业成员消耗走企业池：计佣沿「企业邀请链」结算（建队时固化的 Team.invitedById 快照；存量团队
    // 无快照回落当前管理员邀请关系）——不沿消费成员个人邀请链（2026-08-31，此前串账）。
    // 计酬闸门（2026-08-31，原型「下级进企业后仍计返利」逐人开关）：
    //   billable = 当前管理员的 corpPassUp（逐人设定优先）?? 全局 RebateRule.corpCounts；
    //   快照口径下仅当「A 仍是企业管理员」（当前管理员邀请关系仍指向快照邀请人）才返，A 被替换/移出 → 不返。
    //   开关关 → 该企业池段全员不返（含管理员本人池消耗）；成员个人段不受影响（仍沿各自邀请链）。
    const rebateRule = await tx.rebateRule.findFirst({ orderBy: { id: "asc" } })
    const team = await tx.team.findUnique({
      where: { id: teamId },
      select: { invitedById: true, admin: { select: { invitedById: true, corpPassUp: true } } },
    })
    const billable = team?.admin ? (team.admin.corpPassUp ?? rebateRule?.corpCounts ?? true) : false
    let chainRoot: number | null = null
    if (team && billable) {
      chainRoot =
        team.invitedById != null
          ? team.admin.invitedById === team.invitedById
            ? team.invitedById
            : null // A 已不再是该企业管理员 → 不再返利
          : (team.admin.invitedById ?? null) // 存量团队回落：当前管理员邀请关系
    }
    if (chainRoot != null) {
      // 团队消耗全额计为本笔消耗基数（无邀请人共享扣额概念）；relatedUserId 仍记消费成员；
      // teamId 透传：返利行落企业标记，分销树据此把池返利卷起到企业管理员节点（2026-09-01）
      await this.settleRebatesInTx(tx, userId, charge, {
        source: opts.source,
        meta: opts.meta,
        chainRootInviterId: chainRoot,
        teamId,
      })
    }
    this.logger.log(
      `consumeTeamCredits team=${teamId} user=${userId} charge=${charge.toString()} buckets=${breakdown.map(b => b.bucket).join("+")}`
    )
    return { creditsCharged: charge, costCny: cost, breakdown, balanceAfter: running }
  }

  /**
   * 企业归档：套餐/赠送池批次清零（EXPIRE 留痕），充值池（RECHARGE）余额退回管理员个人户
   * （新建个人 RECHARGE 批次 + TEAM_ARCHIVE_RETURN 流水）；团队批次全部置终态。幂等：无可处理批次直接返回。
   */
  async archiveTeamPool(teamId: number, adminId: number, tx?: Tx): Promise<{ returned: Decimal }> {
    const run = async (c: Tx) => {
      const lots = await c.creditLot.findMany({
        where: { teamId, status: CreditLotStatus.ACTIVE, remaining: { gt: 0 } },
      })
      let returned = new Decimal(0)
      for (const lot of lots) {
        await c.creditLot.update({
          where: { id: lot.id },
          data: { remaining: 0, status: CreditLotStatus.EXPIRED },
        })
        if (lot.bucket === CreditBucket.RECHARGE) {
          returned = returned.plus(lot.remaining)
          // 退回管理员个人户（个人批次 teamId=null）
          await c.creditLot.create({
            data: {
              userId: adminId,
              bucket: CreditBucket.RECHARGE,
              amount: lot.remaining,
              remaining: lot.remaining,
              expiresAt: null,
              sourceType: CreditTxnType.TEAM_ARCHIVE_RETURN,
              sourceRef: `team:${teamId}`,
              status: CreditLotStatus.ACTIVE,
            },
          })
          await c.creditTransaction.create({
            data: {
              userId: adminId,
              direction: CreditDirection.CREDIT,
              bucket: CreditBucket.RECHARGE,
              type: CreditTxnType.TEAM_ARCHIVE_RETURN,
              amount: lot.remaining,
              source: "team.archive",
              teamId,
              meta: { fromLotId: lot.id },
            },
          })
        } else {
          // 套餐/赠送池：清零留痕（不退）
          await c.creditTransaction.create({
            data: {
              userId: lot.userId,
              direction: CreditDirection.DEBIT,
              bucket: lot.bucket,
              type: CreditTxnType.EXPIRE,
              amount: lot.remaining,
              lotId: lot.id,
              teamId,
              source: "team.archive",
            },
          })
        }
      }
      return { returned }
    }
    return tx ? run(tx) : this.prisma.$transaction(run)
  }

  /** 添加成员时转入有效 GIFT：保留逐批到期日，转出/入账复用入队事务。 */
  async transferGiftLotsToTeam(userId: number, teamId: number, tx: Tx): Promise<Decimal> {
    // 当前读与消费共用批次行锁，不能用快照余额转入；按 id 加锁与消费顺序一致。
    const lots = await tx.$queryRaw<
      Array<{ id: number; remaining: Decimal; expiresAt: Date | null }>
    >`
      SELECT id, remaining, expiresAt FROM CreditLot
      WHERE userId = ${userId} AND teamId IS NULL
        AND bucket = ${CreditBucket.GIFT} AND status = ${CreditLotStatus.ACTIVE}
        AND remaining > 0 AND (expiresAt IS NULL OR expiresAt > NOW())
      ORDER BY id
      FOR UPDATE
    `
    if (!lots.length) return new Decimal(0)

    let total = new Decimal(0)
    for (const lot of lots) {
      total = total.plus(lot.remaining)
      await tx.creditLot.update({
        where: { id: lot.id },
        data: { remaining: 0, status: CreditLotStatus.EXHAUSTED },
      })
    }
    const source = "team.member.gift.transfer"
    const meta = { fromLotIds: lots.map(lot => lot.id) }
    await tx.creditTransaction.create({
      data: {
        userId,
        direction: CreditDirection.DEBIT,
        bucket: CreditBucket.GIFT,
        type: CreditTxnType.MANUAL_ADJUST,
        amount: total,
        balanceAfter: await this.consumableBalance(tx, userId),
        source,
        meta: { ...meta, injectToTeamId: teamId },
      },
    })
    await this.recordRecharge(
      userId,
      {
        // 不沿用个人批次的 RECHARGE_PLAN 来源，避免企业续费/恢复延长原赠送有效期。
        type: CreditTxnType.TEAM_RECHARGE,
        source,
        lots: lots.map(lot => ({
          bucket: CreditBucket.GIFT,
          amount: lot.remaining,
          expiresAt: lot.expiresAt,
        })),
        meta: { ...meta, injectedFromPersonal: true },
        teamId,
      },
      tx
    )
    return total
  }

  /**
   * 个人转团队（packChoice=inject）：把用户个人 RECHARGE 批次余额全部注入企业共享池。
   * 原批次清零（EXHAUSTED），个人侧只写**一条合并 DEBIT 流水**（amount=合计、归属=个人、
   * balanceAfter=转出后个人可消费余额，通常为 0；meta.injectToTeamId 标记转入的企业，
   * 项目列显示「个人充值积分转入企业共享池」）；团队侧建等额 RECHARGE 批次（TEAM_RECHARGE，
   * 永不过期口径沿用，balanceAfter=池余额）。返回转移总额（0=无可注入）。可并入 settle 事务。
   */
  async transferRechargeLotsToTeam(
    userId: number,
    teamId: number,
    opts: { source?: string; meta?: Record<string, unknown> } = {},
    tx?: Tx
  ): Promise<Decimal> {
    const source = opts.source ?? "team.pack.inject"
    const run = async (c: Tx) => {
      const lots = await c.creditLot.findMany({
        where: {
          userId,
          teamId: null,
          bucket: CreditBucket.RECHARGE,
          status: CreditLotStatus.ACTIVE,
          remaining: { gt: 0 },
        },
        orderBy: { id: "asc" },
      })
      let total = new Decimal(0)
      for (const lot of lots) {
        total = total.plus(lot.remaining)
        await c.creditLot.update({
          where: { id: lot.id },
          data: { remaining: 0, status: CreditLotStatus.EXHAUSTED },
        })
      }
      if (total.greaterThan(0)) {
        // 个人侧合并一条扣减行：归属=个人（teamId 为空，企业归属只看流水 teamId——
        // 这是个人户的钱转出，挂 teamId 会被渲染成企业行/企业剩余，且多批次逐条写会把一笔转账碎成 N 行）
        const balanceAfter = await this.displayBalance(c, userId, CreditBucket.RECHARGE)
        await c.creditTransaction.create({
          data: {
            userId,
            direction: CreditDirection.DEBIT,
            bucket: CreditBucket.RECHARGE,
            type: CreditTxnType.MANUAL_ADJUST,
            amount: total,
            balanceAfter,
            source,
            meta: {
              ...(opts.meta ?? {}),
              injectToTeamId: teamId,
            },
          },
        })
        await this.recordRecharge(
          userId,
          {
            type: CreditTxnType.TEAM_RECHARGE,
            source,
            lots: [{ bucket: CreditBucket.RECHARGE, amount: total, expiresAt: null }],
            meta: { ...(opts.meta ?? {}), injectedFromPersonal: true },
            teamId,
          },
          c
        )
      }
      return total
    }
    return tx ? run(tx) : this.prisma.$transaction(run)
  }

  /** 取消某用户全部待生效续费排队单（加入企业/个人转团队时作废；写 CANCELLED）。返回取消笔数。 */
  async cancelPendingScheduledPlans(userId: number, tx?: Tx): Promise<number> {
    const run = async (c: Tx) => {
      const res = await c.scheduledPlan.updateMany({
        where: { userId, teamId: null, status: ScheduledPlanStatus.PENDING },
        data: { status: ScheduledPlanStatus.CANCELLED },
      })
      return res.count
    }
    const count = tx ? await run(tx) : await this.prisma.$transaction(run)
    if (count) this.logger.log(`cancelPendingScheduledPlans user=${userId} cancelled=${count}`)
    return count
  }

  /** 用户本人的可消费积分余额（不含邀请人共享额度；含透支负批次；仅个人批次 teamId=null）。 */
  async getConsumableBalance(userId: number): Promise<Decimal> {
    const agg = await this.prisma.creditLot.aggregate({
      where: {
        userId,
        teamId: null,
        bucket: { in: [CreditBucket.RECHARGE, CreditBucket.PACKAGE, CreditBucket.GIFT] },
        status: CreditLotStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      _sum: { remaining: true },
    })
    return agg._sum.remaining ?? new Decimal(0)
  }

  /**
   * 预检：按消费者折扣把人民币成本换算成应扣积分；若邀请人开启共享额度，
   * 可用额度按「消费者本人正净额 + 邀请人正净额」计算，余额不足抛 400。
   * 供视频等「先提交、出片后才结算」的链路在提交时挡住没余额的请求，避免白跑生成。
   */
  async assertAffordable(userId: number, costCny: Decimal | number | string, exactCredits?: Decimal): Promise<void> {
    // 与非嵌套 consume 一致：预检前先激活已到期的续费，避免漏算刚生效的本人额度。
    await this.activateDuePlans(userId)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        discount: true,
        canInvite: true,
        invitedById: true,
        invitedBy: { select: { id: true, shareCreditsWithInvitees: true, canInvite: true } },
      },
    })
    if (!user) throw new NotFoundException("用户不存在")
    const discount = await this.resolveEffectiveDiscount(this.prisma, user)
    const charge = exactCredits ?? new Decimal(costCny).mul(CREDIT_PER_CNY).mul(discount).ceil()
    const ownerIds = this.resolveFundingOwnerIds(userId, user.invitedBy)
    const balances = await Promise.all(ownerIds.map(id => this.getConsumableBalance(id)))
    const available = this.sumAvailableBalances(balances)
    if (available.lessThan(charge)) {
      throw new BadRequestException(`积分余额不足，无法生成（预计需 ${charge.toString()} 积分）`)
    }
  }
}
