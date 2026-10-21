import { Injectable } from "@nestjs/common"
import {
  CreditBucket,
  CreditDirection,
  CreditTxnType,
  InvokeType,
  Prisma,
  ScheduledPlanStatus,
  TeamRole,
  TeamStatus,
} from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { CLAIMABLE_RECEIPT_TYPES } from "../billing/billing.constants"
import { PrismaService } from "../prisma/prisma.service"
import { TeamMemberStatus, quotaMonthOf } from "../team/team.constants"
import { CreditService } from "./credit.service"
import { QueryTransactionsDto } from "./dto/wallet.dto"
import {
  collectScheduledPlanIds,
  deriveLifecycle,
  describeTransaction,
} from "./transaction-display"
import {
  CONSUME_SOURCE_LABEL,
  CONSUME_SOURCE_OPTIONS,
  ConsumeSource,
  INVOKE_TYPE_LABEL,
  INVOKE_TYPE_OPTIONS,
  OwnershipSplitMeta,
  RECHARGE_TYPE_OPTIONS,
  TRANSACTION_BUCKET_OPTIONS,
  TRANSACTION_OWNERSHIP_OPTIONS,
  classifyConsumeSource,
  rechargeTypeFilterWhere,
} from "./transaction-options"

/** 用户侧钱包 / 套餐配置 / 积分明细。 */

/** 批次明细-积分类型标签（原型「积分类型」列口径） */
function lotTypeLabel(bucket: CreditBucket, sourceType: CreditTxnType): string {
  switch (bucket) {
    case CreditBucket.PACKAGE:
      return "套餐积分"
    case CreditBucket.GIFT:
      return sourceType === CreditTxnType.RECHARGE_PLAN ? "套餐赠送积分" : "活动赠送积分"
    case CreditBucket.RECHARGE:
      return sourceType === CreditTxnType.RECHARGE_PACK ? "充值包积分" : "充值积分"
    case CreditBucket.REBATE:
      return "返利积分"
  }
}

/** 批次明细-状态标签 */
const LOT_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "生效中",
  EXHAUSTED: "已用完",
  EXPIRED: "已过期",
}

/** 以下业务按“一次用户操作”折叠积分明细；其他模块维持现有逐笔展示。 */
const BUSINESS_TRANSACTION_SOURCES = new Set([
  "category.analysis",
  "listing.generate",
  "listing.score",
  "competitor.research",
  "category.analysis",
  "launch.plan",
  "pricing.quote",
])

function transactionMeta(meta: Prisma.JsonValue | null): Record<string, unknown> {
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {}
}

function resolveBusinessEventId(
  row: { source: string | null; meta: Prisma.JsonValue | null },
  listingRunIdsByHistoryId?: Map<number, string>
): string | null {
  if (!row.source || !BUSINESS_TRANSACTION_SOURCES.has(row.source)) return null
  const meta = transactionMeta(row.meta)
  if (
    meta.pricing === "fixed_module" &&
    row.source !== "listing.generate" &&
    row.source !== "listing.score"
  )
    return null
  if (typeof meta.businessEventId === "string" && meta.businessEventId.trim()) {
    return meta.businessEventId
  }
  if (row.source === "listing.generate" || row.source === "listing.score") {
    if (typeof meta.listingRunId === "string" && meta.listingRunId.trim()) {
      return meta.listingRunId
    }
    if (typeof meta.listingHistoryId === "number") {
      return listingRunIdsByHistoryId?.get(meta.listingHistoryId) ?? null
    }
  }
  if (row.source === "competitor.research" && typeof meta.runId === "string" && meta.runId.trim()) {
    return meta.runId
  }
  return null
}

function businessEventKey(
  row: { source: string | null; meta: Prisma.JsonValue | null },
  listingRunIdsByHistoryId?: Map<number, string>
): string | null {
  const eventId = resolveBusinessEventId(row, listingRunIdsByHistoryId)
  return row.source && eventId ? `business:${row.source}:${eventId}` : null
}

function consumeEventKey(row: { id: number; meta: Prisma.JsonValue | null }): string {
  const eventId = transactionMeta(row.meta).consumeEventId
  return typeof eventId === "string" && eventId.trim() ? `consume:${eventId}` : `row:${row.id}`
}

/** 金额展示：整数不带小数（¥100），非整数两位（¥10.50） */
function fmtYuan(v: string | number): string {
  const n = Number(v)
  return `¥${Number.isInteger(n) ? n : n.toFixed(2)}`
}

/** 批次「来源」富标签解析所需的批量查询结果 */
interface LotSourceContext {
  orderByNo: Map<string, { snapshot: unknown }>
  packPriceById: Map<number, string>
  spById: Map<number, { tier: number; planName: string }>
  planNameByTier: Map<number, string>
}

/**
 * 批次「来源」富标签（原型口径）：套餐给「Lv.x 名称 月度套餐 / Lv.x 套餐随赠」、
 * 充值包给「¥x 充值包(/赠送)」、升级给「会员升级补差（Lv.a → Lv.b）」等具体描述。
 */
function lotSourceLabel(
  row: { bucket: CreditBucket; sourceType: CreditTxnType; sourceRef: string | null },
  ctx: LotSourceContext
): string {
  const ref = row.sourceRef ?? ""
  const isGift = row.bucket === CreditBucket.GIFT
  const order = ctx.orderByNo.get(ref)
  const snap = order?.snapshot as Record<string, unknown> | null | undefined
  switch (row.sourceType) {
    case CreditTxnType.RECHARGE_PLAN: {
      const um = ref.match(/^upgrade:LV(\d)->LV(\d)$/)
      if (um) return `会员升级补差（Lv.${um[1]} → Lv.${um[2]}）`
      if (snap?.kind === "upgrade") {
        return `会员升级补差（Lv.${String(snap.fromTier)} → Lv.${String(snap.toTier)}）`
      }
      let tier: number | null = null
      let planName: string | null = null
      if (snap?.kind === "plan" && typeof snap.tier === "number") {
        tier = snap.tier
        planName = typeof snap.planName === "string" ? snap.planName : null
      } else {
        const pm = ref.match(/^plan:LV(\d)$/)
        if (pm) tier = Number(pm[1])
        const sm = ref.match(/^scheduledPlan:(\d+)$/)
        const sp = sm ? ctx.spById.get(Number(sm[1])) : null
        if (sp) {
          tier = sp.tier
          planName = sp.planName
        }
        planName = planName ?? (tier != null ? (ctx.planNameByTier.get(tier) ?? null) : null)
      }
      if (tier != null) {
        if (isGift) return `Lv.${tier} 套餐随赠`
        return [`Lv.${tier}`, planName, "月度套餐"].filter(Boolean).join(" ")
      }
      return isGift ? "套餐随赠" : "会员套餐"
    }
    case CreditTxnType.RECHARGE_PACK: {
      let price: string | null = null
      if (snap?.kind === "pack") price = String(snap.priceCny)
      else {
        const pm = ref.match(/^pack:(\d+)$/)
        if (pm) price = ctx.packPriceById.get(Number(pm[1])) ?? null
      }
      const base = price ? `${fmtYuan(price)} 充值包` : "充值包"
      return isGift ? `${base}赠送` : base
    }
    case CreditTxnType.RECHARGE_CUSTOM: {
      if (isGift) return "自定义充值赠送"
      let amount: string | null = null
      if (snap?.kind === "custom") amount = String(snap.amountCny)
      else {
        const m = ref.match(/^custom:(.+)$/)
        if (m) amount = m[1]
      }
      return amount ? `${fmtYuan(amount)} 自定义充值` : "自定义充值"
    }
    case CreditTxnType.SIGNUP_BONUS:
      return "新用户注册赠送"
    case CreditTxnType.MANUAL_ADJUST:
      return isGift ? "后台积分发放" : "手动调整"
    case CreditTxnType.REBATE_IN:
      return "邀请返利"
    case CreditTxnType.TEAM_RECHARGE:
      return /^team:\d+$/.test(ref) ? "企业池退回" : "企业池入账"
    default:
      return "其他"
  }
}

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditService
  ) {}

  /** 钱包卡片：各桶余额、当前等级、本月已用、累计消耗、最近清零 + 身份视图 + 批次逐笔明细（追加式，不破坏老前端）。 */
  async getWallet(userId: number, currentOrgId: number | null = null) {
    const wallet = await this.credit.getWallet(userId)
    const [identityView, lots] = await Promise.all([
      this.resolveIdentityView(userId, currentOrgId),
      this.listLots(userId),
    ])
    return { ...wallet, ...identityView, lots }
  }

  /** VidFlowOS 钱包：完整复用钱包数据，并保留原接口额度字段以兼容调用方。 */
  async getWalletWithQuota(userId: number) {
    const wallet = await this.getWallet(userId)
    const { team } = wallet
    return {
      ...wallet,
      teamId: team?.teamId ?? null,
      teamStatus: team?.status ?? null,
      totalQuota: team?.monthlyQuota?.toString() ?? null,
      remainingQuota: team?.myAvailable ?? wallet.total.toString(),
      quotaMode: team?.quotaMode ?? null,
      overLimitPolicy: team?.overLimitPolicy ?? null,
    }
  }

  /**
   * 批次逐笔明细（BucketDetailModal 用）：个人批次（teamId=null），按获得时间倒序，封顶 100 条。
   * 状态读时推导（到期清零是每日任务懒执行）：到期已过→EXPIRED；剩余≤0→EXHAUSTED；否则 ACTIVE。
   * 「积分类型 / 来源」按原型口径给富标签（批量解析 订单快照 / 充值包 / 套餐 / 排队单）。
   */
  private async listLots(userId: number) {
    const now = new Date()
    const rows = await this.prisma.creditLot.findMany({
      where: { userId, teamId: null },
      orderBy: { grantedAt: "desc" },
      take: 100,
      select: {
        id: true,
        bucket: true,
        sourceType: true,
        sourceRef: true,
        amount: true,
        remaining: true,
        grantedAt: true,
        expiresAt: true,
        status: true,
      },
    })
    const sourceLabels = await this.resolveLotSourceLabels(rows)
    return rows.map(l => {
      const amount = new Decimal(l.amount)
      const remaining = new Decimal(l.remaining)
      const status =
        l.status === "EXPIRED" || (l.expiresAt != null && l.expiresAt <= now)
          ? "EXPIRED"
          : remaining.lte(0)
            ? "EXHAUSTED"
            : "ACTIVE"
      return {
        id: l.id,
        bucket: l.bucket,
        bucketLabel: lotTypeLabel(l.bucket, l.sourceType), // 积分类型（原型口径）
        sourceType: l.sourceType,
        sourceLabel: sourceLabels.get(l.id) ?? "其他", // 来源（富标签）
        sourceRef: l.sourceRef, // 订单号 / 引用（在线单为 SR 单号）
        grantedAt: l.grantedAt, // 获得时间
        amount: amount.toString(), // 总额
        used: amount.minus(remaining).toString(), // 已用 = 总额 - 剩余
        remaining: remaining.toString(),
        expiresAt: l.expiresAt, // null = 永不过期
        status, // ACTIVE / EXHAUSTED / EXPIRED
        statusLabel: LOT_STATUS_LABEL[status],
      }
    })
  }

  /** 批量解析批次「来源」富标签所需的关联数据（订单快照 / 充值包 / 排队单 / 套餐名），再逐行映射。 */
  private async resolveLotSourceLabels(
    rows: {
      id: number
      bucket: CreditBucket
      sourceType: CreditTxnType
      sourceRef: string | null
    }[]
  ): Promise<Map<number, string>> {
    const orderNos = new Set<string>()
    const packIds = new Set<number>()
    const spIds = new Set<number>()
    const tiers = new Set<number>()
    for (const r of rows) {
      const ref = r.sourceRef ?? ""
      if (/^SR\d+/.test(ref)) orderNos.add(ref)
      let m = ref.match(/^pack:(\d+)$/)
      if (m) packIds.add(Number(m[1]))
      m = ref.match(/^scheduledPlan:(\d+)$/)
      if (m) spIds.add(Number(m[1]))
      m = ref.match(/^plan:LV(\d)$/)
      if (m) tiers.add(Number(m[1]))
    }
    const [orders, packs, sps] = await Promise.all([
      orderNos.size
        ? this.prisma.billingOrder.findMany({
            where: { orderNo: { in: [...orderNos] } },
            select: { orderNo: true, snapshot: true },
          })
        : Promise.resolve([]),
      packIds.size
        ? this.prisma.rechargePack.findMany({
            where: { id: { in: [...packIds] } },
            select: { id: true, priceCny: true },
          })
        : Promise.resolve([]),
      spIds.size
        ? this.prisma.scheduledPlan.findMany({
            where: { id: { in: [...spIds] } },
            select: { id: true, tier: true, planName: true },
          })
        : Promise.resolve([]),
    ])
    // 订单快照 / 排队单里的套餐档也纳入套餐名批量查询
    for (const o of orders) {
      const s = o.snapshot as Record<string, unknown> | null
      if (s && typeof s.tier === "number") tiers.add(s.tier)
    }
    for (const sp of sps) tiers.add(sp.tier)
    const plans = tiers.size
      ? await this.prisma.membershipPlan.findMany({
          where: { tier: { in: [...tiers] } },
          select: { tier: true, name: true },
        })
      : []
    const ctx: LotSourceContext = {
      orderByNo: new Map(orders.map(o => [o.orderNo, o])),
      packPriceById: new Map(packs.map(p => [p.id, p.priceCny.toString()])),
      spById: new Map(sps.map(s => [s.id, { tier: s.tier, planName: s.planName }])),
      planNameByTier: new Map(plans.map(p => [p.tier, p.name])),
    }
    return new Map(rows.map(r => [r.id, lotSourceLabel(r, ctx)]))
  }

  /**
   * 身份视图（对应需求 §8）：identity ∈ NONE / SUB_ACTIVE / SUB_EXPIRED / DISTRIBUTOR /
   * TEAM_MEMBER / TEAM_ADMIN / TEAM_ARCHIVED_MEMBER / TEAM_ARCHIVED_ADMIN；
   * 企业成员/管理员附带 team 块（池余额/我的额度/席位/生命周期），前端据此切换视图与入口。
   * canInvite 与 identity 独立下发（§5.6 两笔账独立）：团队身份优先于分销身份，但
   * 团队管理员/成员可同时是分销代理（canInvite=true），前端据此保留邀请入口与返利格。
   * 归档身份：团队归档后成员行已置 ARCHIVED，数据保留期（dataKeepUntil）内仍识别为
   * TEAM_ARCHIVED_*（保留入口 + 续费恢复）；保留期过后回落个人身份（视为数据已清理）。
   */
  private async resolveIdentityView(userId: number, currentOrgId: number | null = null) {
    const now = new Date()
    const membership = await this.prisma.teamMember.findFirst({
      where: { userId, status: "ACTIVE" },
      include: { team: { include: { admin: { select: { username: true } } } } },
      orderBy: { joinedAt: "desc" },
    })
    // 归档团队兜底：归档时成员行已置 ARCHIVED，但数据保留期（dataKeepUntil）内仍要识别归档身份
    // （左侧保留「企业团队管理」入口 + 归档后续费恢复）；保留期过后视为已清理，回落个人身份
    const effective =
      membership ??
      (await this.prisma.teamMember.findFirst({
        where: {
          userId,
          status: "ARCHIVED",
          team: {
            status: "ARCHIVED",
            OR: [{ dataKeepUntil: null }, { dataKeepUntil: { gt: now } }],
          },
        },
        include: { team: { include: { admin: { select: { username: true } } } } },
        orderBy: { team: { archivedAt: "desc" } },
      }))

    if (!effective) {
      const me = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          canInvite: true,
          subscriptionExpiresAt: true,
        },
      })
      // 邀请权读落库值（2026-09-01 起落库制：上级开关打开时已批量写入下级 canInvite）
      const canInvite = me?.canInvite ?? false
      // SUB_EXPIRED 以「曾有订阅且已过期」判定（到期降级后 tier 会被每日任务置空，不能只看 tier）
      let identity = "NONE"
      if (canInvite) identity = "DISTRIBUTOR"
      else if (me?.subscriptionExpiresAt && me.subscriptionExpiresAt > now) identity = "SUB_ACTIVE"
      else if (me?.subscriptionExpiresAt != null) identity = "SUB_EXPIRED"
      return { identity, canInvite, team: null }
    }

    const t = effective.team
    const isAdmin = effective.role === "ADMIN"
    const archived = t.status === "ARCHIVED"
    const identity = archived
      ? isAdmin
        ? "TEAM_ARCHIVED_ADMIN"
        : "TEAM_ARCHIVED_MEMBER"
      : isAdmin
        ? "TEAM_ADMIN"
        : "TEAM_MEMBER"

    // 所属组织名：优先当前组织（token currentOrgId），否则取第一个组织；无组织 null
    const orgRows = await this.prisma.userOrganization.findMany({
      where: { userId },
      select: { orgId: true, org: { select: { name: true } } },
    })
    const orgName =
      (currentOrgId != null ? orgRows.find(o => o.orgId === currentOrgId)?.org.name : undefined) ??
      orgRows[0]?.org.name ??
      null

    const adminName = t.admin.username
    // 企业名展示回落：空名（存量数据）按「{管理员用户名}的团队」显示，新建团队已在创建时落默认名
    const teamDisplayName = t.name ?? `${adminName}的团队`

    // 共享池余额：套餐池（PACKAGE，会过期）与充值池（RECHARGE，永不过期）分开汇总；
    // GRACE 宽限期含冻结批次展示（批次已过到期日但物理保留、续费顺延可恢复——冻结可见而非显示 0）
    const graceFrozen = t.status === "GRACE"
    const poolRows = await this.prisma.creditLot.groupBy({
      by: ["bucket"],
      where: {
        teamId: t.id,
        status: "ACTIVE",
        ...(graceFrozen ? {} : { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }),
      },
      _sum: { remaining: true },
    })
    let poolPackage = new Decimal(0)
    let poolRecharge = new Decimal(0)
    for (const r of poolRows) {
      if (r.bucket === "PACKAGE" || r.bucket === "GIFT") {
        poolPackage = poolPackage.plus(r._sum.remaining ?? 0)
      } else if (r.bucket === "RECHARGE") {
        poolRecharge = poolRecharge.plus(r._sum.remaining ?? 0)
      }
    }
    const poolRemaining = poolPackage.plus(poolRecharge)

    // 月度配额（懒重置口径：quotaMonth 非本月则视为 0 已用；北京自然月，与 quotaMonthOf 同切点）
    const monthKey = quotaMonthOf(now)
    const usedThisMonth =
      effective.quotaMonth === monthKey ? new Decimal(effective.quotaUsedThisMonth) : new Decimal(0)
    const quotaRemaining =
      effective.monthlyQuota != null
        ? Decimal.max(new Decimal(effective.monthlyQuota).minus(usedThisMonth), new Decimal(0))
        : null
    // 本月还能用 = min(我的额度剩余, 池剩余)；无月度上限时 = 池剩余
    const myAvailable =
      quotaRemaining != null ? Decimal.min(quotaRemaining, poolRemaining) : poolRemaining
    // 达限状态标签（读时推导，仅在期 ACTIVE 团队下发）：本月已用 ≥ 月度上限 →
    // 超额策略「仅提醒」(WARN) = 已超额（仍可从池扣减）；硬上限（BLOCK 阻止使用 / INDEPENDENT 独立配额）= 已限额
    const quotaReached =
      effective.monthlyQuota != null &&
      usedThisMonth.greaterThanOrEqualTo(new Decimal(effective.monthlyQuota))
    const limitState: "CAPPED" | "EXCEEDED" | null =
      quotaReached && t.status === "ACTIVE"
        ? t.quotaMode === "SHARED" && t.overLimitPolicy === "WARN"
          ? "EXCEEDED"
          : "CAPPED"
        : null

    const [
      me,
      memberCount,
      poolUsedAgg,
      myPoolUsedAgg,
      archivedMemberCount,
      archiveReturnAgg,
      grantedAgg,
      manualDeductAgg,
    ] = await Promise.all([
      // 分销身份（§5.6 与团队身份独立）：团队管理员/成员可同时是邀请人，前端据此保留邀请入口与返利格
      // 邀请权读落库值（2026-09-01 起落库制）
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { canInvite: true },
      }),
      // 在用成员数；归档企业成员行已整体置 ARCHIVED，改按归档保留名单统计（与总览/身份条同口径，不再返回 0）
      this.prisma.teamMember.count({
        where: { teamId: t.id, status: archived ? "ARCHIVED" : "ACTIVE" },
      }),
      // 池累计已用（TEAM_CONSUME 流水合计，正数；原型充值弹窗「已用」口径）
      this.prisma.creditTransaction.aggregate({
        where: { teamId: t.id, type: "TEAM_CONSUME" },
        _sum: { amount: true },
      }),
      // 我本人企业段累计消耗（TEAM_CONSUME 行 userId=消费成员；归档成员视图「企业期间累计用量」）
      this.prisma.creditTransaction.aggregate({
        where: { teamId: t.id, type: "TEAM_CONSUME", userId },
        _sum: { amount: true },
      }),
      // 归档保留的成员名单数（归档摘要「席位 N/M」的 N；仅归档有值）
      archived
        ? this.prisma.teamMember.count({ where: { teamId: t.id, status: "ARCHIVED" } })
        : Promise.resolve(null),
      // 归档退回管理员个人户的充值池积分（仅归档管理员视角下发）
      archived && isAdmin
        ? this.prisma.creditTransaction.aggregate({
            where: { teamId: t.id, type: "TEAM_ARCHIVE_RETURN" },
            _sum: { amount: true },
          })
        : Promise.resolve(null),
      // 池累计发放（全部批次 amount 合计，含已耗尽/已清零/已过期；正向池调整入批次自然计入）
      this.prisma.creditLot.aggregate({
        where: { teamId: t.id },
        _sum: { amount: true },
      }),
      // 平台手动扣减合计（池调整负向行；正向调整已入批次含在累计发放里）
      this.prisma.creditTransaction.aggregate({
        where: { teamId: t.id, type: "MANUAL_ADJUST", direction: "DEBIT" },
        _sum: { amount: true },
      }),
    ])
    const poolUsedTotal = poolUsedAgg._sum.amount ?? new Decimal(0)

    return {
      identity,
      canInvite: me?.canInvite ?? false,
      team: {
        teamId: t.id,
        name: teamDisplayName,
        nameFilled: t.nameFilled, // 企业名是否被显式设置过（false=系统默认名）；「未命名/去补填」提示以此为准，不再比对默认名字符串
        source: t.source,
        status: t.status,
        tier: t.tier,
        role: effective.role,
        adminName, // 企业管理员用户名（「有事找谁」）
        orgName, // 当前用户所属组织名（优先当前组织，否则第一个；无组织 null）
        seats: t.seats,
        memberCount,
        quotaMode: t.quotaMode,
        overLimitPolicy: t.overLimitPolicy,
        discount: t.discount.toString(),
        expiresAt: t.expiresAt,
        graceUntil: t.graceUntil,
        dataKeepUntil: t.dataKeepUntil,
        monthlyQuota: effective.monthlyQuota,
        quotaUsedThisMonth: usedThisMonth.toString(),
        quotaRemaining: quotaRemaining?.toString() ?? null,
        limitState, // 达限状态：CAPPED=已限额（BLOCK/INDEPENDENT 硬上限）/ EXCEEDED=已超额（WARN 仅提醒仍可用）；未达限/不限/非在期 null
        limitStateLabel:
          limitState === "EXCEEDED" ? "已超额" : limitState === "CAPPED" ? "已限额" : null,
        poolPackage: poolPackage.toString(),
        poolRecharge: poolRecharge.toString(),
        poolRemaining: poolRemaining.toString(),
        poolUsedTotal: poolUsedTotal.toString(),
        poolGrantedTotal: (grantedAgg._sum.amount ?? new Decimal(0)).toString(), // 池累计发放（侧栏「共」/与剩余差额核对用）
        poolManualDeducted: (manualDeductAgg._sum.amount ?? new Decimal(0)).toString(), // 平台手动扣减合计（发放-扣减-已用=剩余 的手动扣减项）
        myAvailable: myAvailable.toString(),
        // ---- 归档摘要（仅 ARCHIVED 有值，其余 null；归档管理员/成员视图按原型渲染） ----
        archivedAt: t.archivedAt, // 归档时间（「于 X 归档」）
        archivedMemberCount, // 归档保留的成员名单数（席位 N/M 的 N；成员已释放为个人计费）
        archiveReturned: archiveReturnAgg?._sum.amount?.toString() ?? null, // 退回我个人户的充值池积分（仅管理员）
        myPoolUsedTotal: (myPoolUsedAgg._sum.amount ?? new Decimal(0)).toString(), // 我本人企业段累计消耗
      },
    }
  }

  /**
   * 积分明细 / 充值记录筛选下拉项（前后端唯一约定，前端不再硬编码）：
   * - rechargeTypes：充值记录「类型」筛选（所有用户一致）
   * - buckets：积分桶粗筛（RECHARGE/PACKAGE/GIFT），对应 transactions 的 bucket 参数（所有用户一致）
   * - consumeSources：「扣费来源」细分（个人/邀请人各桶），对应 transactions 的 consumeSource
   *   参数——**所有用户一致返回**，不区分等级（含邀请人查看下级流水的场景，前端统一渲染该筛选）。
   * - ownerships：「积分归属」筛选（个人/企业），对应 transactions 的 ownership 参数（所有用户一致）
   * - consumers：【LV5】使用用户筛选（本人 + 各下级），对应 transactions 的 consumerUserId 参数
   * buckets 与 consumeSources 同时下发，前端按需取用。「来源(source)」筛选项见 GET /api/usage/source-options。
   */
  async getTransactionOptions(userId: number) {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { canInvite: true },
    })
    // 桶粗筛 + 扣费来源细分 + 调用方式均对所有用户一致下发（普通用户的 INVITER_* 项无对应流水、筛选自然为空，不另行裁剪）
    const base = {
      rechargeTypes: RECHARGE_TYPE_OPTIONS,
      buckets: TRANSACTION_BUCKET_OPTIONS,
      consumeSources: CONSUME_SOURCE_OPTIONS,
      ownerships: TRANSACTION_OWNERSHIP_OPTIONS,
      invokeTypes: INVOKE_TYPE_OPTIONS,
    }
    // 「使用用户」名单：本人 + 各下级（邀请人）+ 本企业成员（企业管理员），按 value 去重；
    // 两类身份都没有则不下发 consumers（前端隐藏该筛选）。
    const consumers = [{ value: "self", label: "本人" }]
    const seen = new Set<string>(["self"])
    if (me?.canInvite) {
      const invitees = await this.prisma.user.findMany({
        where: { invitedById: userId },
        orderBy: { createdAt: "desc" },
        select: { id: true, username: true },
      })
      for (const u of invitees) {
        const v = String(u.id)
        if (!seen.has(v)) {
          seen.add(v)
          consumers.push({ value: v, label: u.username })
        }
      }
    }
    const teamAdminId = await this.resolveTeamAdminTeamId(userId)
    if (teamAdminId != null) {
      const members = await this.prisma.teamMember.findMany({
        where: { teamId: teamAdminId, status: { not: TeamMemberStatus.ARCHIVED } },
        select: { userId: true, user: { select: { username: true } } },
        orderBy: { joinedAt: "asc" },
      })
      for (const m of members) {
        if (m.userId === userId) continue // 本人已在首项
        const v = String(m.userId)
        if (!seen.has(v)) {
          seen.add(v)
          consumers.push({ value: v, label: m.user.username })
        }
      }
    }
    return consumers.length > 1 ? { ...base, consumers } : base
  }

  /** 套餐 + 充值包配置（前端渲染选择区）。 */
  async getPlans() {
    const [plans, packs] = await Promise.all([
      this.prisma.membershipPlan.findMany({
        where: { active: true },
        orderBy: { tier: "asc" },
      }),
      this.prisma.rechargePack.findMany({
        where: { active: true },
        orderBy: { sortOrder: "asc" },
      }),
    ])
    return { plans, packs }
  }

  /**
   * 积分明细（分页，按方向/桶/类型/功能模块/日期区间筛选；附中文项目名 + 人民币金额）。
   * 等级感知双视角：
   * - 被邀请人(LV4)：纳入「动用邀请人额度」的消费行（记在邀请人账上、relatedUserId=自己），
   *   每条消费行附 consumeSource 细分（个人/邀请人各桶）；支持按 consumeSource 筛选。
   * - 邀请人(LV5)：其下级动用其额度的消费行本就记在自己账上（relatedUserId=下级），附「使用用户」
   *   (consumerName)；支持按 consumerUserId 筛选（'self'=本人 / 某下级 id）。
   */
  async listTransactions(userId: number, query: QueryTransactionsDto) {
    const { page, pageSize, direction, bucket, type, source, startDate, endDate } = query
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { canInvite: true, invitedById: true },
    })
    const isFounder = !!me && !me.canInvite && me.invitedById != null
    // 企业管理员视角（记录隔离 2026-08-27）：本人行 ∪ 本企业池行；成员（非管理员）维持仅本人行。
    // 成员的个人侧流水（个人充值/个人段消费）不对管理员暴露——池行以 teamId 界定。
    const teamAdminId = await this.resolveTeamAdminTeamId(userId)

    // 通用筛选（方向/来源/类型/时间）。返利入账/提现独立核算，未显式按 type 查询时排除。
    // type=MANUAL_ADJUST/GIFT_COMPENSATE 走拆分口径（手动调整不含正向补偿发放，赠送=仅正向补偿）。
    const common: Prisma.CreditTransactionWhereInput = {
      ...(direction && { direction }),
      ...(source && { source: { contains: source } }),
      ...(type
        ? rechargeTypeFilterWhere(type)
        : { type: { notIn: [CreditTxnType.REBATE_IN, CreditTxnType.REBATE_WITHDRAW] } }),
    }
    if (startDate || endDate) {
      common.createdAt = {
        ...(startDate && { gte: new Date(startDate) }),
        ...(endDate && { lte: new Date(endDate) }),
      }
    }

    // 用户范围 + 扣费来源/桶 筛选（用 AND 组合，避免 type/bucket 等键冲突）
    const and: Prisma.CreditTransactionWhereInput[] = [common]
    // 积分归属筛选：个人=个人批次(teamId 空) / 企业=企业共享池批次(teamId 有值)
    if (query.ownership === "PERSONAL") and.push({ teamId: null })
    else if (query.ownership === "TEAM") and.push({ teamId: { not: null } })
    // 调用方式筛选：PLATFORM=平台使用（默认）/ API=开放平台扣费
    if (query.invokeType) and.push({ invokeType: query.invokeType })
    // 扣费来源筛选对所有用户生效（普通用户的 INVITER_*/TEAM_* 无对应行、自然空集）；
    // 该 where 已自带 userId / relatedUserId / teamId 范围约束，故走此分支即完成用户范围限定。
    if (query.consumeSource) {
      and.push(this.consumeSourceWhere(userId, query.consumeSource, teamAdminId))
    } else if (teamAdminId != null) {
      // 企业管理员：缺省=本人行 ∪ 本企业池行；consumerUserId=self=仅本人行（含我在池里的行）；
      // 指定成员 id=该成员的企业池行（其个人侧流水不暴露）
      if (query.consumerUserId === undefined) {
        and.push({ OR: [{ userId }, { teamId: teamAdminId }] })
      } else if (query.consumerUserId === "self") {
        and.push({ userId })
      } else {
        const memberId = Number(query.consumerUserId)
        and.push(
          Number.isInteger(memberId)
            ? { teamId: teamAdminId, userId: memberId }
            : { OR: [{ userId }, { teamId: teamAdminId }] }
        )
      }
      if (bucket) and.push({ bucket })
    } else if (isFounder) {
      // 自己的全部流水 ∪ 动用邀请人额度的消费行（记在邀请人账上、relatedUserId=自己）
      and.push({ OR: [{ userId }, { relatedUserId: userId, type: CreditTxnType.CONSUME }] })
      if (bucket) and.push({ bucket })
    } else {
      and.push({ userId })
      if (bucket) and.push({ bucket })
      if (query.consumerUserId !== undefined) and.push(this.consumerWhere(query.consumerUserId))
    }
    // 本人个人历史始终可见；企业身份只决定上面的用户范围，不按入队时间裁剪流水。
    const where: Prisma.CreditTransactionWhereInput = { AND: and }

    const rowSelect = {
      id: true,
      userId: true, // 区分本行归属人（自己 / 邀请人池），不直接外泄
      direction: true,
      bucket: true,
      type: true,
      amount: true,
      balanceAfter: true,
      source: true,
      invokeType: true,
      relatedUserId: true,
      teamId: true, // 积分归属（个人/企业）判定
      meta: true,
      createdAt: true,
    } as const
    const skip = (page - 1) * pageSize

    // 混合扣费事件（个人与企业都扣）在库里是多行（个人段/企业段各一条，盖同一
    // consumeEventId），列表按「展示单元」合并：一笔事件只出一行，分页/总数也按合并后计——
    // 否则按行分页会把同一事件切到相邻两页，前端页内合并会重复显示。
    // 代表行优先企业段行（teamId 有值）：成员/管理员视角都可见（成员个人段行不对管理员暴露），
    // 且携 ownershipSplit 快照可直接渲染双归属/双剩余。
    // CREDIT 方向无事件章，走老路径直查。
    let rows: Array<{
      id: number
      userId: number
      direction: CreditDirection
      bucket: CreditBucket | null
      type: CreditTxnType
      amount: Decimal
      balanceAfter: Decimal | null
      source: string | null
      invokeType: InvokeType
      relatedUserId: number | null
      teamId: number | null
      meta: Prisma.JsonValue | null
      createdAt: Date
    }>
    let total: number
    let selectedUnitKeys: string[] = []
    const selectedBusinessKeys = new Set<string>()
    const listingRunIdsByHistoryId = new Map<number, string>()
    if (direction === CreditDirection.CREDIT) {
      ;[rows, total] = await Promise.all([
        this.prisma.creditTransaction.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip,
          take: pageSize,
          select: rowSelect,
        }),
        this.prisma.creditTransaction.count({ where }),
      ])
    } else {
      // 轻量全量扫描（只取 id/teamId/meta）找事件章；无事件章落回老路径
      const scan = await this.prisma.creditTransaction.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, teamId: true, source: true, meta: true },
      })
      const listingHistoryIds = [
        ...new Set(
          scan
            .filter(row => row.source === "listing.generate" || row.source === "listing.score")
            .map(row => transactionMeta(row.meta).listingHistoryId)
            .filter((historyId): historyId is number => typeof historyId === "number")
        ),
      ]
      if (listingHistoryIds.length) {
        const listingRuns = await this.prisma.listingRun.findMany({
          where: { historyId: { in: listingHistoryIds } },
          select: { historyId: true, runId: true },
        })
        listingRuns.forEach(run => listingRunIdsByHistoryId.set(run.historyId, run.runId))
      }
      const hasEvent = scan.some(
        r => (r.meta as { consumeEventId?: unknown } | null)?.consumeEventId != null
      )
      const hasBusinessEvent = scan.some(r => businessEventKey(r, listingRunIdsByHistoryId) != null)
      if (!hasEvent && !hasBusinessEvent) {
        ;[rows, total] = await Promise.all([
          this.prisma.creditTransaction.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip,
            take: pageSize,
            select: rowSelect,
          }),
          this.prisma.creditTransaction.count({ where }),
        ])
      } else if (!hasBusinessEvent) {
        // 展示单元 = 单行 / 同事件合并；位置按该单元最新行（desc 首见），代表行优先企业段
        const unitByKey = new Map<string, { repId: number; repIsTeam: boolean; pos: number }>()
        scan.forEach((r, pos) => {
          const eid = (r.meta as { consumeEventId?: string } | null)?.consumeEventId
          const key = eid ?? `row:${r.id}`
          const cur = unitByKey.get(key)
          if (!cur) {
            unitByKey.set(key, { repId: r.id, repIsTeam: r.teamId != null, pos })
            return
          }
          if (eid && r.teamId != null && !cur.repIsTeam) {
            cur.repId = r.id // 换企业段做代表（位置不变，事件段几乎同刻）
            cur.repIsTeam = true
          }
        })
        const units = [...unitByKey.values()].sort((a, b) => a.pos - b.pos)
        total = units.length
        const pageIds = units.slice(skip, skip + pageSize).map(u => u.repId)
        const fetched = await this.prisma.creditTransaction.findMany({
          where: { id: { in: pageIds } },
          select: rowSelect,
        })
        const order = new Map(pageIds.map((id, i) => [id, i] as const))
        rows = fetched.sort(
          (a, b) => (order.get(a.id) ?? pageIds.length) - (order.get(b.id) ?? pageIds.length)
        )
      } else {
        // businessEventId 优先：把一次用户操作里的模型/MCP 扣费合成父记录；
        // 没有业务章的行仍沿用 consumeEventId（个人/企业拆分）或单行规则。
        const unitByKey = new Map<
          string,
          {
            key: string
            repId: number
            repIsTeam: boolean
            pos: number
            business: boolean
            source: string | null
            businessEventId: string | null
            consumeEventId: string | null
          }
        >()
        scan.forEach((r, pos) => {
          const businessKey = businessEventKey(r, listingRunIdsByHistoryId)
          const meta = transactionMeta(r.meta)
          const consumeEventId =
            typeof meta.consumeEventId === "string" ? meta.consumeEventId : null
          const key = businessKey ?? consumeEventKey(r)
          const current = unitByKey.get(key)
          if (!current) {
            unitByKey.set(key, {
              key,
              repId: r.id,
              repIsTeam: r.teamId != null,
              pos,
              business: businessKey != null,
              source: r.source,
              businessEventId: resolveBusinessEventId(r, listingRunIdsByHistoryId),
              consumeEventId,
            })
            return
          }
          // 非业务父记录仍沿用企业段作为混合扣费代表；业务父记录保留最新步骤作为代表。
          if (!current.business && consumeEventId && r.teamId != null && !current.repIsTeam) {
            current.repId = r.id
            current.repIsTeam = true
          }
        })
        const units = [...unitByKey.values()].sort((a, b) => a.pos - b.pos)
        total = units.length
        const pageUnits = units.slice(skip, skip + pageSize)
        selectedUnitKeys = pageUnits.map(unit => unit.key)
        pageUnits.filter(unit => unit.business).forEach(unit => selectedBusinessKeys.add(unit.key))

        const selectedUnitKeySet = new Set(selectedUnitKeys)
        const pageIds = scan
          .filter(row => {
            const key = businessEventKey(row, listingRunIdsByHistoryId) ?? consumeEventKey(row)
            return selectedUnitKeySet.has(key)
          })
          .map(row => row.id)
        const fetched = pageIds.length
          ? await this.prisma.creditTransaction.findMany({
              where: { id: { in: pageIds } },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              select: rowSelect,
            })
          : []
        const unitOrder = new Map(selectedUnitKeys.map((key, index) => [key, index] as const))
        rows = fetched.sort((a, b) => {
          const aKey = businessEventKey(a, listingRunIdsByHistoryId) ?? consumeEventKey(a)
          const bKey = businessEventKey(b, listingRunIdsByHistoryId) ?? consumeEventKey(b)
          const unitDiff =
            (unitOrder.get(aKey) ?? selectedUnitKeys.length) -
            (unitOrder.get(bKey) ?? selectedUnitKeys.length)
          if (unitDiff) return unitDiff
          const timeDiff = b.createdAt.getTime() - a.createdAt.getTime()
          return timeDiff || b.id - a.id
        })
      }
    }

    // 混合扣费事件（一笔消费个人与企业都扣）事件级聚合：同 consumeEventId 的多段行
    // （个人段/企业段各一条）汇总「事件总扣分 + 全量扣费来源」，供前端单行展示总额与
    // 双来源标签；行级 amount/consumeSource 保持本段口径不变
    const eventIds = [
      ...new Set(
        rows
          .map(r => (r.meta as { consumeEventId?: unknown } | null)?.consumeEventId)
          .filter((x): x is string => typeof x === "string")
      ),
    ]
    const eventAggBy = new Map<
      string,
      {
        total: Decimal
        sources: { consumeSource: ConsumeSource; label: string; credits: string }[]
      }
    >()
    if (eventIds.length) {
      const siblings = await this.prisma.creditTransaction.findMany({
        where: { OR: eventIds.map(id => ({ meta: { path: "$.consumeEventId", equals: id } })) },
        orderBy: { id: "asc" },
        select: {
          id: true,
          userId: true,
          direction: true,
          bucket: true,
          type: true,
          amount: true,
          teamId: true,
          meta: true,
        },
      })
      for (const s of siblings) {
        const eid = (s.meta as { consumeEventId?: string } | null)?.consumeEventId
        if (!eid) continue
        const agg = eventAggBy.get(eid) ?? { total: new Decimal(0), sources: [] }
        agg.total = agg.total.plus(s.amount)
        const cs = classifyConsumeSource(
          s.type,
          s.bucket,
          s.userId !== userId,
          s.direction,
          s.teamId
        )
        if (cs) {
          const hit = agg.sources.find(x => x.consumeSource === cs)
          if (hit) hit.credits = new Decimal(hit.credits).plus(s.amount).toString()
          else
            agg.sources.push({
              consumeSource: cs,
              label: CONSUME_SOURCE_LABEL[cs],
              credits: s.amount.toString(),
            })
        }
        eventAggBy.set(eid, agg)
      }
      // 来源排序与扣减顺序一致：个人赠送层 → 企业池 → 个人充值/邀请人
      const rank = (cs: ConsumeSource) =>
        cs === "OWN_PACKAGE" || cs === "OWN_GIFT"
          ? 0
          : cs.startsWith("TEAM_")
            ? 1
            : cs === "OWN_RECHARGE"
              ? 2
              : 3
      for (const agg of eventAggBy.values())
        agg.sources.sort((a, b) => rank(a.consumeSource) - rank(b.consumeSource))
    }

    // 待生效/已过期标识（与后台充值记录同源 deriveLifecycle）
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

    // 「使用用户」名称解析（LV5 视角的 relatedUserId → 用户名；本人为 null）
    // 企业管理员视角的池行（teamId 有值）使用用户=行属主（哪个成员扣的/入的），一并解析
    const relatedIds = [
      ...new Set(
        rows
          .flatMap(r => [r.relatedUserId, r.teamId != null ? r.userId : null])
          .filter((x): x is number => x != null)
      ),
    ]
    const nameById = new Map<number, string>()
    if (relatedIds.length) {
      const us = await this.prisma.user.findMany({
        where: { id: { in: relatedIds } },
        select: { id: true, username: true },
      })
      for (const u of us) nameById.set(u.id, u.username)
    }

    // 收据关联（批量）：在线单按 meta.orderNo → Receipt.order.orderNo；后台人工充值补开按 manualRef=txn:{id}
    const orderNos = [
      ...new Set(
        rows
          .map(r => {
            const m = (r.meta ?? {}) as Record<string, unknown>
            return typeof m.orderNo === "string" ? m.orderNo : null
          })
          .filter((x): x is string => x != null)
      ),
    ]
    const receipts = rows.length
      ? await this.prisma.receipt.findMany({
          where: {
            OR: [
              ...(orderNos.length
                ? [{ order: { orderNo: { in: orderNos } } } as Prisma.ReceiptWhereInput]
                : []),
              { manualRef: { in: rows.map(r => `txn:${r.id}`) } },
            ],
          },
          select: {
            receiptNo: true,
            manualRef: true,
            order: { select: { orderNo: true } },
          },
        })
      : []
    const receiptNoByOrderNo = new Map<string, string>()
    const receiptNoByTxnId = new Map<number, string>()
    for (const r of receipts) {
      if (r.order?.orderNo) receiptNoByOrderNo.set(r.order.orderNo, r.receiptNo)
      const m = r.manualRef?.match(/^txn:(\d+)$/)
      if (m) receiptNoByTxnId.set(Number(m[1]), r.receiptNo)
    }

    const rawItems = rows.map(r => {
      const { userId: ownerId, teamId, ...rest } = r
      const d = describeTransaction(r)
      const { scheduled, expired, effectiveAt } = deriveLifecycle(r, planStatus, now)
      // 本行扣的是邀请人池 ⇔ 归属人≠查看者（被邀请人视角动用邀请人额度的行）
      const fromInviterPool = ownerId !== userId
      // 功能点4：扣费来源细分（个人/邀请人/企业各桶，与筛选项同枚举）
      const cs = classifyConsumeSource(r.type, r.bucket, fromInviterPool, r.direction, r.teamId)
      const meta = r.meta as {
        consumeEventId?: string
        ownershipSplit?: OwnershipSplitMeta
      } | null
      // balanceAfter 口径（2026-09-01 bug13 产品口径）：动用邀请人额度的行（被邀请人视角），
      // 剩余积分展示**邀请人侧扣后余额**——行上存的就是邀请人池余额（credit.service 写侧口径），
      // 直接展示。此前改取 meta.consumerBalanceAfter（消费者自己净额，其为 0 时显示 0，
      // 与「扣费来源=邀请人赠送积分」的真实来源余额矛盾，已作废；meta 字段仍写但读侧不再使用）。
      const balanceAfter = rest.balanceAfter
      // 积分归属（2026-08-27 混合扣费）：个人=teamId 空 / 企业=teamId 有值。
      // 混合扣费事件（一笔消费个人与企业都扣）以 meta 事件章为准：双归属标签 + 悬浮拆分 + 双剩余快照；
      // 纯单归属行按 teamId 推导单边值（另一边 null，前端不显示）。CREDIT 行同规则（归属侧的变动额）。
      const split = meta?.ownershipSplit
      const ownership = teamId != null ? ("TEAM" as const) : ("PERSONAL" as const)
      const ownerships = split ? ["PERSONAL", "TEAM"] : [ownership]
      const personalCredits = split ? split.personal : ownership === "PERSONAL" ? rest.amount : null
      const teamCredits = split ? split.team : ownership === "TEAM" ? rest.amount : null
      const personalBalanceAfter = split
        ? split.personalBalanceAfter
        : ownership === "PERSONAL"
          ? balanceAfter
          : null
      const teamBalanceAfter = split
        ? split.teamBalanceAfter
        : ownership === "TEAM"
          ? balanceAfter
          : null
      // 收据列：已开票的给收据编号（前端渲染「查看收据」）；后台人工充值且未开票的允许补开
      const metaOrderNo = (r.meta as { orderNo?: unknown } | null)?.orderNo
      const receiptNo =
        (typeof metaOrderNo === "string" ? receiptNoByOrderNo.get(metaOrderNo) : null) ??
        receiptNoByTxnId.get(r.id) ??
        null
      // 事件级聚合（仅混合扣费事件行有值）：总额 = 各段合计；来源 = 全部段的扣费来源（按扣减顺序）
      const eventAgg =
        split && meta?.consumeEventId ? eventAggBy.get(meta.consumeEventId) : undefined
      const canClaimReceipt =
        receiptNo == null &&
        r.direction === CreditDirection.CREDIT &&
        (CLAIMABLE_RECEIPT_TYPES as readonly string[]).includes(r.type) &&
        (r.source?.startsWith("admin.recharge.") ?? false)
      return {
        ...rest,
        balanceAfter,
        category: d.category,
        title: d.title,
        amountCny: d.amountCny,
        status: d.status,
        receiptNo,
        canClaimReceipt,
        scheduled,
        expired,
        effectiveAt,
        // 积分归属：标签数组（混合扣费事件=[个人,企业]）+ 悬浮拆分 + 双剩余
        ownership,
        ownerships,
        personalCredits,
        teamCredits,
        personalBalanceAfter,
        teamBalanceAfter,
        consumeEventId: split ? (meta?.consumeEventId ?? null) : null,
        // 混合事件级字段：eventTotalCredits=本笔总扣分（各段合计，如企业1+个人2=3），
        // eventConsumeSources=本笔全部扣费来源（含每来源扣分，按扣减顺序排）——前端单行展示
        // 「-3 · 企业套餐积分+个人充值积分」用这两个字段；行级 amount/consumeSource 仍是本段值
        eventTotalCredits: eventAgg ? eventAgg.total.toString() : null,
        eventConsumeSources: eventAgg ? eventAgg.sources : null,
        // 功能点4：扣费来源细分 + 中文标签（仅消费/调减类扣费行有值，与筛选项一一对应）
        consumeSource: cs,
        consumeSourceLabel: cs ? CONSUME_SOURCE_LABEL[cs] : null,
        // 调用方式（CreditTransaction.invokeType 列；存量/旧 mock 缺省兜底 PLATFORM 平台使用）
        invokeType: r.invokeType ?? InvokeType.PLATFORM,
        invokeTypeLabel: INVOKE_TYPE_LABEL[r.invokeType ?? InvokeType.PLATFORM],
        // 使用用户（本人 / 下级名）：池行（teamId 有值）= 行属主（哪个成员扣的/入的，管理员视角）；
        // 个人行 = relatedUserId（LV5 邀请人视角的下级）
        consumerUserId: teamId != null ? (ownerId === userId ? null : ownerId) : r.relatedUserId,
        consumerName: (() => {
          const cid = teamId != null ? (ownerId === userId ? null : ownerId) : r.relatedUserId
          return cid == null ? "本人" : (nameById.get(cid) ?? null)
        })(),
      }
    })
    if (!selectedBusinessKeys.size) {
      return { items: rawItems, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
    }

    type TransactionItem = (typeof rawItems)[number]
    const itemsByUnit = new Map<string, TransactionItem[]>()
    for (const item of rawItems) {
      const key = businessEventKey(item, listingRunIdsByHistoryId) ?? consumeEventKey(item)
      const bucket = itemsByUnit.get(key) ?? []
      bucket.push(item)
      itemsByUnit.set(key, bucket)
    }

    const mergeSources = (group: TransactionItem[]) => {
      const sourceCredits = new Map<ConsumeSource, { label: string; credits: Decimal }>()
      for (const item of group) {
        const sources =
          item.consumeSource && item.consumeSourceLabel
            ? [
                {
                  consumeSource: item.consumeSource,
                  label: item.consumeSourceLabel,
                  credits: item.amount,
                },
              ]
            : []
        for (const sourceItem of sources) {
          const current = sourceCredits.get(sourceItem.consumeSource)
          sourceCredits.set(sourceItem.consumeSource, {
            label: sourceItem.label,
            credits: (current?.credits ?? new Decimal(0)).plus(sourceItem.credits),
          })
        }
      }
      return [...sourceCredits.entries()].map(([consumeSource, value]) => ({
        consumeSource,
        label: value.label,
        credits: value.credits.toString(),
      }))
    }

    const mergeChargeRows = (group: TransactionItem[]): TransactionItem => {
      const representative = group[0]
      const amount = group.reduce((sum, item) => sum.plus(item.amount), new Decimal(0))
      const personalCredits = group.reduce(
        (sum, item) => (item.ownership === "PERSONAL" ? sum.plus(item.amount) : sum),
        new Decimal(0)
      )
      const teamCredits = group.reduce(
        (sum, item) => (item.ownership === "TEAM" ? sum.plus(item.amount) : sum),
        new Decimal(0)
      )
      const ownerships = [
        ...(personalCredits.greaterThan(0) ? (["PERSONAL"] as const) : []),
        ...(teamCredits.greaterThan(0) ? (["TEAM"] as const) : []),
      ]
      const sources = mergeSources(group)
      return {
        ...representative,
        amount,
        ownership: ownerships.length === 1 ? ownerships[0] : representative.ownership,
        ownerships,
        personalCredits: personalCredits.greaterThan(0) ? personalCredits.toString() : null,
        teamCredits: teamCredits.greaterThan(0) ? teamCredits.toString() : null,
        eventTotalCredits: amount.toString(),
        eventConsumeSources: sources.length ? sources : null,
      }
    }

    const aggregateBusinessUnit = (key: string, group: TransactionItem[]) => {
      const chargeGroups = new Map<string, TransactionItem[]>()
      for (const item of group) {
        const meta = transactionMeta(item.meta)
        const chargeId =
          typeof meta.usageChargeId === "string"
            ? meta.usageChargeId
            : typeof meta.listingStepId === "number"
              ? `listing-step:${meta.listingStepId}`
              : typeof meta.consumeEventId === "string"
                ? `consume:${meta.consumeEventId}`
                : `row:${item.id}`
        const chargeRows = chargeGroups.get(chargeId) ?? []
        chargeRows.push(item)
        chargeGroups.set(chargeId, chargeRows)
      }
      const details = [...chargeGroups.values()].map(mergeChargeRows).sort((a, b) => a.id - b.id)
      const summary = mergeChargeRows(group)
      const eventId = resolveBusinessEventId(summary, listingRunIdsByHistoryId)
      return {
        ...summary,
        consumeEventId: null,
        eventTotalCredits: null,
        businessEventId: eventId ?? key,
        businessGroupKey: key,
        businessDetails: details,
      }
    }

    const items = selectedUnitKeys.flatMap(key => {
      const group = itemsByUnit.get(key) ?? []
      if (!group.length) return []
      if (selectedBusinessKeys.has(key)) return [aggregateBusinessUnit(key, group)]
      // 同页存在的旧混合扣费单元仍只返回一条代表记录。
      return [mergeChargeRows(group)]
    })
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }

  /**
   * 扣费来源 → where 片段（与行级 classifyConsumeSource 同口径，保证「按列筛选」不丢行）：
   * 个人侧 relatedUserId=null + teamId=null；邀请人侧 relatedUserId=自己；企业侧 teamId 约束
   * （管理员=本企业全部池行；成员记录隔离=本人池行）。
   */
  private consumeSourceWhere(
    userId: number,
    cs: ConsumeSource,
    teamAdminId: number | null
  ): Prisma.CreditTransactionWhereInput {
    const base = { type: CreditTxnType.CONSUME }
    switch (cs) {
      case "OWN_PACKAGE":
        // 个人套餐积分：消费扣 PACKAGE，或客服补偿扣回（PACKAGE+GIFT 赠送层合池扣减，bucket=null）
        return {
          userId,
          relatedUserId: null,
          teamId: null,
          OR: [
            { type: CreditTxnType.CONSUME, bucket: CreditBucket.PACKAGE },
            { type: CreditTxnType.MANUAL_ADJUST, direction: CreditDirection.DEBIT, bucket: null },
          ],
        }
      case "OWN_RECHARGE":
        // 个人充值积分：消费扣 RECHARGE，或手动调减（只动 RECHARGE）
        return {
          userId,
          relatedUserId: null,
          teamId: null,
          bucket: CreditBucket.RECHARGE,
          OR: [
            { type: CreditTxnType.CONSUME },
            { type: CreditTxnType.MANUAL_ADJUST, direction: CreditDirection.DEBIT },
          ],
        }
      case "OWN_GIFT":
        return {
          userId,
          relatedUserId: null,
          teamId: null,
          bucket: CreditBucket.GIFT,
          OR: [
            { type: CreditTxnType.CONSUME },
            { type: CreditTxnType.MANUAL_ADJUST, direction: CreditDirection.DEBIT },
          ],
        }
      case "INVITER_GIFT":
        return {
          ...base,
          relatedUserId: userId,
          bucket: { in: [CreditBucket.PACKAGE, CreditBucket.GIFT] },
        }
      case "INVITER_RECHARGE":
        return { ...base, relatedUserId: userId, bucket: CreditBucket.RECHARGE }
      case "TEAM_PACKAGE":
        return {
          ...this.teamRowsScope(userId, teamAdminId),
          type: CreditTxnType.TEAM_CONSUME,
          bucket: CreditBucket.PACKAGE,
        }
      case "TEAM_GIFT":
        return {
          ...this.teamRowsScope(userId, teamAdminId),
          type: CreditTxnType.TEAM_CONSUME,
          bucket: CreditBucket.GIFT,
        }
      case "TEAM_RECHARGE":
        // 企业充值积分：池消费 RECHARGE 段 + 平台池调整扣减（MANUAL_ADJUST DEBIT，仅动 RECHARGE）
        return {
          ...this.teamRowsScope(userId, teamAdminId),
          bucket: CreditBucket.RECHARGE,
          OR: [
            { type: CreditTxnType.TEAM_CONSUME },
            { type: CreditTxnType.MANUAL_ADJUST, direction: CreditDirection.DEBIT },
          ],
        }
    }
  }

  /** 企业池行可见范围：管理员=本企业全部池行（全部成员）；成员（记录隔离）=本人池行。 */
  private teamRowsScope(
    userId: number,
    teamAdminId: number | null
  ): Prisma.CreditTransactionWhereInput {
    return teamAdminId != null ? { teamId: teamAdminId } : { userId, teamId: { not: null } }
  }

  /** LV5 使用用户筛选 → where 片段（'self'=本人 relatedUserId=null；否则按下级 id）。 */
  private consumerWhere(consumerUserId: string): Prisma.CreditTransactionWhereInput {
    if (consumerUserId === "self") return { relatedUserId: null }
    const id = Number(consumerUserId)
    return Number.isInteger(id) ? { relatedUserId: id } : {}
  }

  /**
   * 记录隔离（2026-08-27）：当前用户作为企业管理员所管的占用中企业 id
   * （成员 ACTIVE + 角色 ADMIN + 团队 ACTIVE/GRACE），无则 null。
   * 管理员可见范围=本人行 ∪ 该企业的池行（teamId）；成员（非管理员）仅本人行。
   */
  private async resolveTeamAdminTeamId(userId: number): Promise<number | null> {
    const m = await this.prisma.teamMember.findFirst({
      where: {
        userId,
        status: TeamMemberStatus.ACTIVE,
        role: TeamRole.ADMIN,
        team: { status: { in: [TeamStatus.ACTIVE, TeamStatus.GRACE] } },
      },
      select: { teamId: true },
    })
    return m?.teamId ?? null
  }
}
