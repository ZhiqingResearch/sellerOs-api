import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import {
  CreditBucket,
  CreditTxnType,
  MembershipLevel,
  Prisma,
  ScheduledPlanStatus,
} from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PaginationDto } from "../common/dto/pagination.dto"
import { maskPhone } from "../common/utils/mask"
import { PrismaService } from "../prisma/prisma.service"
import { CreditService } from "./credit.service"
import { QueryRechargeTransactionsDto, QueryRechargeUsersDto } from "./dto/admin-recharge.dto"
import {
  CREDIT_PER_CNY,
  PACKAGE_EXPIRE_DAYS,
  customBonusRate,
  resolveLevel,
} from "./membership.constants"
import { RechargeAccessService } from "./recharge-access.service"
import {
  collectScheduledPlanIds,
  deriveLifecycle,
  describeTransaction,
} from "./transaction-display"
import { rechargeTypeFilterWhere } from "./transaction-options"

// 后台「充值记录」默认口径：套餐 / 充值包 / 自定义 / 手动调额 / 注册赠送
// SIGNUP_BONUS（注册送 200）也算一笔入账，需在充值记录里可见。
const RECHARGE_TXN_TYPES: CreditTxnType[] = [
  CreditTxnType.RECHARGE_PLAN,
  CreditTxnType.RECHARGE_PACK,
  CreditTxnType.RECHARGE_CUSTOM,
  CreditTxnType.MANUAL_ADJUST,
  CreditTxnType.SIGNUP_BONUS,
]

const DAY_MS = 24 * 60 * 60 * 1000

// 等级排序权重（用户一览按等级排序用）
const LEVEL_ORDER: Record<MembershipLevel, number> = {
  [MembershipLevel.NONE]: 0,
  [MembershipLevel.LV1]: 1,
  [MembershipLevel.LV2]: 2,
  [MembershipLevel.LV3]: 3,
  [MembershipLevel.FOUNDER]: 4,
  [MembershipLevel.INVITER]: 5,
}

@Injectable()
export class AdminRechargeService {
  private readonly logger = new Logger(AdminRechargeService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditService,
    private readonly access: RechargeAccessService
  ) {}

  /**
   * 套餐升级（升档，立即生效，**差价/积分差按剩余天数折算，到期日不变**，2026-08-25 起；
   * 多次续费拉长有效期后升级 = 整段剩余期按高档补齐，废 2026-08-20 整月一口价口径）：
   * 仅当前订阅未过期且升更高档可用；首次开通 / 过期用户走续费 `/plan/renew`（立即生效）。
   * 与线上订单 PLAN_UPGRADE 共用 `CreditService.upgradePlanImmediate`（后台与线上同口径）；
   * 算价与 `quotePlanUpgrade` 共用 `buildUpgradeQuote`（试算与实充同价）。
   */
  async chargePlan(userId: number, tier: number) {
    const plan = await this.prisma.membershipPlan.findUnique({ where: { tier } })
    if (!plan || !plan.active) throw new BadRequestException("套餐不存在或已下架")

    // 读时兜底：先激活到期的待生效续费（历史排队单），保证「当前订阅」是最新状态
    await this.credit.activateDuePlans(userId)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isActive: true, subscriptionTier: true, subscriptionExpiresAt: true },
    })
    if (!user) throw new NotFoundException("用户不存在")
    if (!user.isActive) throw new BadRequestException("用户已被禁用，无法充值")

    const q = await this.buildUpgradeQuote(user, plan, new Date())
    const wallet = await this.credit.upgradePlanImmediate(
      userId,
      {
        fromTier: q.fromTier,
        toTier: tier,
        planName: plan.name,
        packageDiff: q.packageDiff,
        giftDiff: q.giftDiff,
        expiresAt: q.expiresAt, // 升级到期日不变，跟随原订阅
      },
      { meta: { priceCny: q.costCny.toNumber() } }
    )
    this.logger.log(
      `chargePlan(upgrade) user=${userId} LV${q.fromTier}->LV${tier} cost(折算)=${q.costCny.toString()} package=${q.packageDiff} gift=${q.giftDiff}`
    )
    return wallet
  }

  /**
   * 升级补差试算（**只读不落库**）：与 chargePlan 同一算价点（`buildUpgradeQuote`，差价/积分差
   * 按剩余天数折算）。后台充值弹窗的「补差价 / 补积分」一律用它渲染，前端不要本地自算，
   * 避免两端取整/时点口径不一致（参照用户端 orders/quote 同原则）。
   */
  async quotePlanUpgrade(userId: number, tier: number) {
    const plan = await this.prisma.membershipPlan.findUnique({ where: { tier } })
    if (!plan || !plan.active) throw new BadRequestException("套餐不存在或已下架")
    await this.credit.activateDuePlans(userId)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isActive: true, subscriptionTier: true, subscriptionExpiresAt: true },
    })
    if (!user) throw new NotFoundException("用户不存在")
    if (!user.isActive) throw new BadRequestException("用户已被禁用，无法充值")

    const q = await this.buildUpgradeQuote(user, plan, new Date())
    return {
      fromTier: q.fromTier,
      toTier: plan.tier,
      planName: plan.name,
      costCny: q.costCny.toNumber(), // 补差价（元，两位小数）
      packageDiff: q.packageDiff, // 套餐本体补积分
      giftDiff: q.giftDiff, // 赠送补积分
      creditsDiff: q.packageDiff + q.giftDiff, // 补积分合计
      remainingDays: q.remainingDays, // 折算所用剩余天数（展示用）
      expiresAt: q.expiresAt, // 升级后到期日（不变）
    }
  }

  /**
   * chargePlan / quotePlanUpgrade 共用算价点：守卫（在期、仅升更高档、配置齐全）+
   * 折算系数（剩余时长 / 一个周期，毫秒精度）算差价与积分差。
   */
  private async buildUpgradeQuote(
    user: { subscriptionTier: number | null; subscriptionExpiresAt: Date | null },
    plan: { tier: number; priceCny: Decimal; packageCredits: number; giftCredits: number },
    now: Date
  ) {
    const active = user.subscriptionExpiresAt != null && user.subscriptionExpiresAt > now
    if (!active || user.subscriptionTier == null) {
      throw new BadRequestException("当前无有效套餐，升级不可用，请使用续费")
    }
    if (plan.tier <= user.subscriptionTier) {
      throw new BadRequestException("套餐周期内仅可升级到更高档，不可降级或平级")
    }
    const currentPlan = await this.prisma.membershipPlan.findUnique({
      where: { tier: user.subscriptionTier },
    })
    if (!currentPlan) throw new BadRequestException("当前套餐配置缺失，无法计算升级差额")

    // 折算系数 = 剩余时长 / 一个周期（按天折算）；积分差按「套餐本体 / 赠送」分别折算（各自不为负）
    const remainingMs = user.subscriptionExpiresAt!.getTime() - now.getTime()
    const factor = new Decimal(remainingMs).div(currentPlan.periodDays * DAY_MS)
    const costCny = plan.priceCny.minus(currentPlan.priceCny).mul(factor).toDecimalPlaces(2)
    const packageDiff = new Decimal(Math.max(plan.packageCredits - currentPlan.packageCredits, 0))
      .mul(factor)
      .toDecimalPlaces(0)
      .toNumber()
    const giftDiff = new Decimal(Math.max(plan.giftCredits - currentPlan.giftCredits, 0))
      .mul(factor)
      .toDecimalPlaces(0)
      .toNumber()
    return {
      fromTier: user.subscriptionTier,
      costCny,
      packageDiff,
      giftDiff,
      remainingDays: Math.max(Math.ceil(remainingMs / DAY_MS), 1), // 展示用
      expiresAt: user.subscriptionExpiresAt!, // 守卫已保证非空（在期）
    }
  }

  /**
   * 续费（**立即生效**，2026-08-25 起废排队制）：有效期立即在「当前到期日（已过期则 now）」
   * 上顺延一个周期，套餐/赠送积分立即到账，等级立即切换。同档=续期；升档续费=立即切高档；
   * 高等级不能续费低等级（400）。已过期/无订阅 → 立即新起一期。
   */
  async renewPlan(userId: number, tier: number) {
    const plan = await this.prisma.membershipPlan.findUnique({ where: { tier } })
    if (!plan || !plan.active) throw new BadRequestException("套餐不存在或已下架")
    await this.requireUser(userId, true)

    const { expiresAt } = await this.prisma.$transaction(async tx =>
      this.credit.renewImmediateInTx(tx, userId, {
        tier: plan.tier,
        planName: plan.name,
        priceCny: plan.priceCny,
        packageCredits: plan.packageCredits,
        giftCredits: plan.giftCredits,
        periodDays: plan.periodDays,
      })
    )
    this.logger.log(
      `renewPlan(立即) user=${userId} tier=${tier} expiresAt=${expiresAt.toISOString()}`
    )
    return {
      wallet: await this.credit.getWallet(userId),
      // 历史排队单（2026-08-25 前的遗留）仍会在此列出，供后台查看
      scheduledPlans: await this.credit.listScheduledPlans(userId),
    }
  }

  /** 某用户待生效续费队列（后台展示）。 */
  async listScheduledPlans(userId: number) {
    await this.requireUser(userId)
    await this.credit.activateDuePlans(userId)
    return this.credit.listScheduledPlans(userId)
  }

  /** 充固定充值包：base 进 RECHARGE（永不过期），bonus 进 GIFT（30 天清零）；合并为 1 条充值流水。 */
  async chargePack(userId: number, packId: number) {
    const pack = await this.prisma.rechargePack.findUnique({ where: { id: packId } })
    if (!pack || !pack.active) throw new BadRequestException("充值包不存在或已下架")
    await this.requireUser(userId, true)

    const now = new Date()
    await this.credit.recordRecharge(userId, {
      type: CreditTxnType.RECHARGE_PACK,
      source: "admin.recharge.pack",
      sourceRef: `pack:${packId}`,
      lots: [
        { bucket: CreditBucket.RECHARGE, amount: pack.baseCredits, expiresAt: null },
        {
          bucket: CreditBucket.GIFT,
          amount: pack.bonusCredits,
          expiresAt: new Date(now.getTime() + PACKAGE_EXPIRE_DAYS * DAY_MS),
        },
      ],
      meta: {
        packId,
        priceCny: pack.priceCny.toNumber(),
        baseCredits: pack.baseCredits,
        bonusCredits: pack.bonusCredits,
      },
    })
    this.logger.log(`chargePack user=${userId} pack=${packId}`)
    return this.credit.getWallet(userId)
  }

  /** 自定义充值：本金（金额×10）进 RECHARGE，按档赠送进 GIFT（30 天清零）；合并为 1 条充值流水。 */
  async chargeCustom(userId: number, amountCny: number) {
    await this.requireUser(userId, true)

    const base = new Decimal(amountCny).mul(CREDIT_PER_CNY)
    const bonus = base.mul(customBonusRate(amountCny)).toDecimalPlaces(0)
    const now = new Date()
    await this.credit.recordRecharge(userId, {
      type: CreditTxnType.RECHARGE_CUSTOM,
      source: "admin.recharge.custom",
      sourceRef: `custom:${amountCny}`,
      lots: [
        { bucket: CreditBucket.RECHARGE, amount: base, expiresAt: null },
        {
          bucket: CreditBucket.GIFT,
          amount: bonus,
          expiresAt: new Date(now.getTime() + PACKAGE_EXPIRE_DAYS * DAY_MS),
        },
      ],
      meta: {
        priceCny: amountCny,
        baseCredits: base.toNumber(),
        bonusCredits: bonus.toNumber(),
      },
    })
    this.logger.log(
      `chargeCustom user=${userId} amountCny=${amountCny} base=${base.toString()} bonus=${bonus.toString()}`
    )
    return this.credit.getWallet(userId)
  }

  /** 手动调额（任意等级可用，仅作用于 RECHARGE 充值积分）：正=新增永不过期批次；负=只扣充值积分(FIFO)，不足报错。 */
  async manualAdjust(userId: number, amount: number, reason?: string) {
    await this.requireUser(userId, true)
    await this.credit.adjust(userId, amount, {
      source: "admin.recharge.manual",
      sourceRef: reason,
      meta: reason ? { reason } : undefined,
    })
    this.logger.log(`manualAdjust user=${userId} amount=${amount} reason=${reason ?? "-"}`)
    return this.credit.getWallet(userId)
  }

  /** 开 / 关某账号的后台充值权限（账号级白名单），并失效缓存。 */
  async setRechargeFlag(userId: number, canRecharge: boolean) {
    await this.requireUser(userId)
    await this.prisma.user.update({ where: { id: userId }, data: { canRecharge } })
    this.access.invalidate(userId)
    this.logger.log(`setRechargeFlag user=${userId} canRecharge=${canRecharge}`)
    return { userId, canRecharge }
  }

  /** 用户积分一览：默认剩余积分倒序、可切；分页；按关键词 / 邀请状态 / 等级 / 组织筛选。 */
  async listUsers(query: QueryRechargeUsersDto) {
    const { page, pageSize, keyword, inviteStatus, level, orgId } = query
    const sortBy = query.sortBy ?? "points"
    const sortDir = query.sortDir ?? "desc"

    // 禁用（停用，isActive=false）的用户不纳入充值列表
    const where: Prisma.UserWhereInput = { isActive: true }
    if (keyword) {
      where.OR = [{ username: { contains: keyword } }, { phone: { contains: keyword } }]
    }
    if (inviteStatus === "inviter") {
      // 口径（2026-08-31 起）：可邀请 canInvite=true，或已关邀请但返利余额>0（REBATE 桶 ACTIVE 批次剩余，
      // 未过期）——与原型 _hasRebateAccount 一致：关闭分销邀请后该用户仍留在列表里，后台「返利提现」入口
      // 不随邀请开关消失（REBATE 桶只能提现，入口一藏余额即沉淀）。keyword 走 where.OR，此处用 AND 并联。
      where.AND = [
        {
          OR: [
            { canInvite: true },
            {
              creditLots: {
                some: {
                  bucket: CreditBucket.REBATE,
                  status: "ACTIVE",
                  remaining: { gt: 0 },
                  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                },
              },
            },
          ],
        },
      ]
    } else if (inviteStatus === "invited") where.invitedById = { not: null }
    else if (inviteStatus === "none") {
      where.canInvite = false
      where.invitedById = null
    }
    if (orgId) where.orgs = { some: { orgId } }

    const users = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        phone: true,
        canInvite: true,
        invitedById: true,
        subscriptionTier: true,
        subscriptionExpiresAt: true,
        discount: true,
        rebateRate: true,
        canRecharge: true,
        shareCreditsWithInvitees: true,
        subInviteAllowed: true, // 下级可继续邀请（邀请配置弹窗回显）
        // invitedBy 关联即「我的邀请人」，顺带取其共享开关——供被邀请人(LV4)行回显「邀请人是否已开启共享」，
        // 单一真相仍是邀请人自身的 shareCreditsWithInvitees，读时派生、不在被邀请人侧落冗余字段。
        invitedBy: {
          select: { id: true, username: true, shareCreditsWithInvitees: true },
        },
        roles: { select: { role: { select: { code: true, name: true, color: true } } } },
        orgs: { select: { org: { select: { id: true, name: true } } } },
        _count: { select: { invitees: true } },
      },
    })

    // 各用户余额：可消费(RECHARGE+PACKAGE+GIFT) 与 返利可提现(REBATE) 分开汇总
    const ids = users.map(u => u.id)
    const now = new Date()
    const grouped = ids.length
      ? await this.prisma.creditLot.groupBy({
          by: ["userId", "bucket"],
          where: {
            userId: { in: ids },
            status: "ACTIVE",
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          _sum: { remaining: true },
        })
      : []
    // 按桶分别汇总余额：充值(RECHARGE)/套餐(PACKAGE)/赠送(GIFT)/返利(REBATE)
    const zeroBuckets = (): Record<CreditBucket, Decimal> => ({
      [CreditBucket.RECHARGE]: new Decimal(0),
      [CreditBucket.PACKAGE]: new Decimal(0),
      [CreditBucket.GIFT]: new Decimal(0),
      [CreditBucket.REBATE]: new Decimal(0),
    })
    const bucketsByUser = new Map<number, Record<CreditBucket, Decimal>>()
    for (const id of ids) bucketsByUser.set(id, zeroBuckets())
    for (const g of grouped) {
      const bk = bucketsByUser.get(g.userId)
      if (!bk) continue
      bk[g.bucket] = bk[g.bucket].plus(g._sum.remaining ?? new Decimal(0))
    }

    // 累计返利（earned = Σ REBATE_IN 流水），与可提现余额口径区分
    const earnedRows = ids.length
      ? await this.prisma.creditTransaction.groupBy({
          by: ["userId"],
          where: { userId: { in: ids }, type: CreditTxnType.REBATE_IN },
          _sum: { amount: true },
        })
      : []
    const earnedByUser = new Map<number, Decimal>(
      earnedRows.map(r => [r.userId, r._sum.amount ?? new Decimal(0)])
    )

    let items = users.map(u => {
      const bk = bucketsByUser.get(u.id)!
      const rechargePoints = bk[CreditBucket.RECHARGE]
      const packagePoints = bk[CreditBucket.PACKAGE] // 套餐积分（套餐本体，会过期）
      const giftPoints = bk[CreditBucket.GIFT] // 赠送积分（套餐赠送 + 充值赠送 + 注册赠送，会过期）
      const points = rechargePoints.plus(packagePoints).plus(giftPoints) // 可消费合计（不含返利），口径不变
      const rebate = bk[CreditBucket.REBATE]
      return {
        userId: u.id,
        username: u.username,
        // 手机号默认脱敏（与 GET /api/users 同口径；全号走 GET /users/:id/phone 审计接口），关键词仍可按明文搜
        phone: maskPhone(u.phone),
        level: resolveLevel(u),
        canInvite: u.canInvite,
        canRecharge: u.canRecharge,
        shareCredits: u.shareCreditsWithInvitees, // 本人（LV5）的「邀请的用户共享我的额度」开关（邀请配置弹窗回显）
        subInviteAllowed: u.subInviteAllowed, // 「下级可继续邀请」开关（邀请配置弹窗回显；与 PATCH invite-config 对应）
        // 本人的邀请人（LV5）是否已对我开启共享：被邀请人(LV4)行据此判断能否动用邀请人额度；无邀请人则 null
        inviterShareCredits: u.invitedBy?.shareCreditsWithInvitees ?? null,
        roles: u.roles.map(r => ({
          code: r.role.code,
          name: r.role.name,
          color: r.role.color ?? null,
        })),
        invitedBy: u.invitedBy ? { id: u.invitedBy.id, username: u.invitedBy.username } : null,
        invitedCount: u._count.invitees,
        hasDownline: u._count.invitees > 0,
        discount: u.discount.toString(),
        rebateRate: u.rebateRate.toString(),
        points: points.toString(),
        rechargePoints: rechargePoints.toString(), // 充值积分（RECHARGE，永不过期）
        packagePoints: packagePoints.toString(), // 套餐积分（PACKAGE 套餐本体，会过期）
        giftPoints: giftPoints.toString(), // 赠送积分（GIFT：套餐赠送+充值赠送+注册赠送，会过期）
        rebate: rebate.toString(),
        rebateEarned: (earnedByUser.get(u.id) ?? new Decimal(0)).toString(),
        orgs: u.orgs.map(o => ({ id: o.org.id, name: o.org.name })),
        subscriptionExpiresAt: u.subscriptionExpiresAt,
      }
    })

    if (level) items = items.filter(i => i.level === level)

    const dir = sortDir === "asc" ? 1 : -1
    items.sort((a, b) => {
      if (sortBy === "level") return dir * (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
      return dir * new Decimal(a.points).comparedTo(b.points)
    })

    const total = items.length
    const start = (page - 1) * pageSize
    return {
      items: items.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  /** 全站充值记录（默认套餐/充值包/自定义/手动调额；可按用户/类型/日期筛选，分页）。 */
  async listRechargeTransactions(query: QueryRechargeTransactionsDto) {
    const { page, pageSize, userId, type, startDate, endDate } = query
    // 读时兜底：指定用户时先激活其到期待生效套餐，保证「待生效」标记与积分实际到账一致
    if (userId) await this.credit.activateDuePlans(userId)
    const where: Prisma.CreditTransactionWhereInput = {
      // MANUAL_ADJUST 拆分：手动调整（排除正向补偿发放）/ 赠送=GIFT_COMPENSATE（仅正向补偿），与列表「类型」列口径一致
      ...(type ? rechargeTypeFilterWhere(type) : { type: { in: RECHARGE_TXN_TYPES } }),
      ...(userId && { userId }),
    }
    if (startDate || endDate) {
      where.createdAt = {
        ...(startDate && { gte: new Date(startDate) }),
        ...(endDate && { lte: new Date(endDate) }),
      }
    }

    const [rows, total] = await Promise.all([
      this.prisma.creditTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          direction: true,
          bucket: true,
          type: true,
          amount: true,
          balanceAfter: true,
          source: true,
          meta: true,
          createdAt: true,
          user: { select: { id: true, username: true, phone: true } },
        },
      }),
      this.prisma.creditTransaction.count({ where }),
    ])

    // 待生效/已过期读时判定：meta.scheduled 是「下单那刻」快照、激活后不回写，故以关联 ScheduledPlan
    // 真实状态(PENDING=待生效)+ meta.expiresAt(套餐/赠送到期时刻)现算，不依赖快照。
    const now = new Date()
    const planIds = collectScheduledPlanIds(rows)
    const planStatus = new Map<number, ScheduledPlanStatus>()
    if (planIds.length) {
      const plans = await this.prisma.scheduledPlan.findMany({
        where: { id: { in: planIds } },
        select: { id: true, status: true },
      })
      for (const p of plans) planStatus.set(p.id, p.status)
    }

    const items = rows.map(r => {
      const d = describeTransaction(r)
      const { scheduled, expired, effectiveAt } = deriveLifecycle(r, planStatus, now)
      return {
        id: r.id,
        user: r.user,
        direction: r.direction,
        bucket: r.bucket,
        type: r.type,
        category: d.category,
        title: d.title,
        amountCny: d.amountCny,
        amount: r.amount.toString(),
        balanceAfter: r.balanceAfter?.toString() ?? null,
        status: d.status,
        source: r.source,
        scheduled,
        expired,
        effectiveAt,
        createdAt: r.createdAt,
      }
    })
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }

  /** 查看指定用户的返利提现明细（分页）。 */
  async listUserWithdrawals(userId: number, pagination: PaginationDto) {
    await this.requireUser(userId)
    const { page, pageSize } = pagination
    const where = { userId, type: CreditTxnType.REBATE_WITHDRAW }
    const [rows, total] = await Promise.all([
      this.prisma.creditTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, amount: true, balanceAfter: true, meta: true, createdAt: true },
      }),
      this.prisma.creditTransaction.count({ where }),
    ])
    const items = rows.map(r => ({
      id: r.id,
      amount: r.amount.toString(),
      balanceAfter: r.balanceAfter?.toString() ?? null,
      meta: r.meta,
      createdAt: r.createdAt,
    }))
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }

  /**
   * 超管代发返利提现：替某用户执行提现，扣其 REBATE 桶并留痕（标注后台代发）。
   * 不卡邀请权限：关闭 canInvite 只停新增计佣，历史返利保留可提（与用户侧 withdraw 同口径），
   * 可提现余额由 withdrawRebate 内部校验。
   */
  async rebateWithdraw(userId: number, amount: number, note?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    })
    if (!user) throw new NotFoundException("用户不存在")
    const res = await this.credit.withdrawRebate(userId, amount, {
      note: note ? `[后台代发] ${note}` : "[后台代发]",
    })
    this.logger.log(`admin rebateWithdraw user=${userId} amount=${amount}`)
    return {
      userId,
      withdrawn: res.withdrawn.toString(),
      balanceAfter: res.balanceAfter.toString(),
    }
  }

  /** 加载用户；requireActive=true 时禁用（停用）用户抛错（充值类操作前校验）。 */
  private async requireUser(userId: number, requireActive = false) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isActive: true },
    })
    if (!user) throw new NotFoundException("用户不存在")
    if (requireActive && !user.isActive) throw new BadRequestException("用户已被禁用，无法充值")
    return user
  }
}
