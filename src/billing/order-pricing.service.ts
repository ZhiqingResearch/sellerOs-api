import { BadRequestException, Injectable } from "@nestjs/common"
import {
  BillingOrderStatus,
  BillingOrderType,
  CreditBucket,
  CreditLotStatus,
  ScheduledPlanStatus,
  TeamSource,
  TeamStatus,
} from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { CreditService } from "../membership/credit.service"
import { CREDIT_PER_CNY, DAY_MS } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { TeamService } from "../team/team.service"
import { getCustomMinCny } from "./billing.constants"
import { CustomLadderService } from "./custom-ladder.service"
import { CreateOrderDto } from "./dto/billing.dto"

export interface OrderQuoteItem {
  name: string // 项目名（不含"赠送"字样，赠送并入主项积分）
  detail?: string
  qty: number
  amountCny: Decimal // 人民币（元），折抵行为负
  credits: number | null
}

/** 各类型订单的结算快照（下单即冻结；settle 按 kind 分发入账动作） */
export interface PlanSnapshot {
  kind: "plan"
  tier: number
  planName: string
  priceCny: string // 人民币（元），Decimal.toString()
  packageCredits: number
  giftCredits: number
  periodDays: number
}
export interface UpgradeSnapshot {
  kind: "upgrade"
  fromTier: number
  toTier: number
  planName: string
  creditsDiff: number // 合计积分差（= packageDiff + giftDiff，展示用）
  packageDiff: number // 套餐本体积分差 → PACKAGE 批次
  giftDiff: number // 赠送积分差 → GIFT 批次
  expiresAt: string // ISO；升级后到期日不变
}
export interface PackSnapshot {
  kind: "pack"
  packId: number
  priceCny: string
  baseCredits: number
  bonusCredits: number
}
export interface CustomSnapshot {
  kind: "custom"
  amountCny: string
  baseCredits: string
  bonusRate: number
  bonusCredits: string
}
/** 团队版新购（自助）：settle 时建队 + 池入账 */
export interface TeamPlanSnapshot {
  kind: "team_plan"
  teamTier: number
  planName: string
  seats: number
  priceCny: string
  poolPackageCredits: number
  poolGiftCredits: number
  periodDays: number
  teamName: string | null
  /** 个人充值包(RECHARGE)存量去向（2026-08-29 起与 P2T 同口径）：inject=注入共享池 / keep=留个人；老快照无此字段=keep */
  packChoice?: "inject" | "keep"
}
/** 团队续费：ACTIVE 排队 / GRACE、ARCHIVED 恢复立即生效 */
export interface TeamRenewSnapshot {
  kind: "team_renew"
  teamId: number
  teamTier: number
  planName: string
  priceCny: string
  poolPackageCredits: number
  poolGiftCredits: number
  periodDays: number
}
/** 团队升席位档：整月差价/整月池积分差，到期日不变 */
export interface TeamSeatUpgradeSnapshot {
  kind: "team_seat_upgrade"
  teamId: number
  fromTier: number
  toTier: number
  planName: string
  seats: number
  creditsDiff: number // 池积分合计差（= packageDiff + giftDiff，展示用）
  packageDiff: number // 池套餐积分差 → PACKAGE 批次
  giftDiff: number // 池赠送积分差 → GIFT 批次
  expiresAt: string // ISO；升级后到期日不变
}
export interface TeamPackSnapshot {
  kind: "team_pack"
  teamId: number
  packId: number
  priceCny: string
  baseCredits: number
  bonusCredits: number
}
export interface TeamCustomSnapshot {
  kind: "team_custom"
  teamId: number
  amountCny: string
  baseCredits: string
  bonusRate: number
  bonusCredits: string
}
/** 个人转团队：建队 + 池入账 + 个人套餐清零/取消排队单 + 订阅身份注销；packChoice 决定个人充值包去向 */
export interface PersonalToTeamSnapshot {
  kind: "personal_to_team"
  teamTier: number
  planName: string
  seats: number
  priceCny: string
  poolPackageCredits: number
  poolGiftCredits: number
  periodDays: number
  teamName: string | null
  packChoice: "inject" | "keep"
  // —— 折抵/返还快照（下单即冻结，settle 按此结算；支付过程中余额变化不影响结果）——
  offsetCny: string // 个人套餐可抵扣价值（floor 到元；积分比例不封顶，可能 > priceCny）
  appliedOffsetCny: string // 实际抵入本单的金额 = min(offsetCny, priceCny)
  refundCny: string // 超出金额 = offsetCny - appliedOffsetCny（无则 "0"）
  refundCredits: number // 超出部分返还充值积分 = refundCny × CREDIT_PER_CNY（settle 入个人 RECHARGE，永不过期）
  personalTier: number | null // 原个人套餐档（无有效套餐 null）
  personalPriceCny: string | null // 原套餐月费（元）
  personalExpiresAt: string | null // 原个人套餐到期时刻 ISO（历史留痕；joinTeam 会注销订阅字段）
  remainingDays: number | null // 参与折算的剩余有效时间（天，浮点）
  remainingCredits: string | null // 参与折算的 PACKAGE 套餐本体剩余积分（2026-09-02 bug20 起不含 GIFT）
  factor: string | null // 折算系数 = min(时间比例, 积分比例)（积分比例不封顶）
}
export type OrderSnapshot =
  | PlanSnapshot
  | UpgradeSnapshot
  | PackSnapshot
  | CustomSnapshot
  | TeamPlanSnapshot
  | TeamRenewSnapshot
  | TeamSeatUpgradeSnapshot
  | TeamPackSnapshot
  | TeamCustomSnapshot
  | PersonalToTeamSnapshot

export interface OrderQuote {
  amountCny: Decimal
  creditsTotal: number
  items: OrderQuoteItem[]
  /** 本次购买后的预计到期时刻（套餐类订单：订阅/续费=队尾+周期，升级=原到期日不变；充值类=null） */
  expiresAt?: Date | null
  /** 按天折算所用的剩余天数（PLAN_UPGRADE/TEAM_SEAT_UPGRADE=ceil、PERSONAL_TO_TEAM=floor，与 items detail 文案同口径；非折算类型=null） */
  remainingDays?: number | null
  /** 团队单归属（TEAM_RENEW/SEAT_UPGRADE/PACK/CUSTOM 下单时已知；TEAM_PLAN/PERSONAL_TO_TEAM 建队后由 settle 回写） */
  teamId?: number | null
  /** PERSONAL_TO_TEAM 的充值包去向（inject|keep） */
  packChoice?: string | null
  /** 结算动作所需的全部冻结数据（下单即锁定，SETTLED 时按此入账，不受配置后续变动影响） */
  snapshot: OrderSnapshot
}

/**
 * 订单算价：金额与到账积分的**唯一计算点**（下单时重算，前端传值不采信）。
 * 目录/计价全部人民币（元）；积分锚点固定 1 元 = CREDIT_PER_CNY 积分。
 * 个人单：PLAN_NEW/RENEW/UPGRADE/PACK/CUSTOM；团队单：TEAM_PLAN/TEAM_RENEW/TEAM_SEAT_UPGRADE/
 * TEAM_PACK/TEAM_CUSTOM/PERSONAL_TO_TEAM（池口径见 TeamPoolService.grantPool）。
 */
@Injectable()
export class OrderPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditService,
    private readonly ladder: CustomLadderService,
    private readonly team: TeamService
  ) {}

  async quote(userId: number, dto: CreateOrderDto): Promise<OrderQuote> {
    switch (dto.type) {
      case BillingOrderType.PLAN_NEW:
        return this.quotePlanNew(userId, dto)
      case BillingOrderType.PLAN_RENEW:
        return this.quotePlanRenew(userId, dto)
      case BillingOrderType.PLAN_UPGRADE:
        return this.quotePlanUpgrade(userId, dto)
      case BillingOrderType.PACK:
        return this.quotePack(userId, dto)
      case BillingOrderType.CUSTOM:
        return this.quoteCustom(userId, dto)
      case BillingOrderType.TEAM_PLAN:
        return this.quoteTeamPlan(userId, dto)
      case BillingOrderType.TEAM_RENEW:
        return this.quoteTeamRenew(userId, dto)
      case BillingOrderType.TEAM_SEAT_UPGRADE:
        return this.quoteTeamSeatUpgrade(userId, dto)
      case BillingOrderType.TEAM_PACK:
        return this.quoteTeamPack(userId, dto)
      case BillingOrderType.TEAM_CUSTOM:
        return this.quoteTeamCustom(userId, dto)
      case BillingOrderType.PERSONAL_TO_TEAM:
        return this.quotePersonalToTeam(userId, dto)
      default:
        throw new BadRequestException("不支持的订单类型")
    }
  }

  /**
   * 互斥订单拦截（2026-08-27）：个人套餐单（PLAN_NEW/RENEW/UPGRADE）与建队单
   * （TEAM_PLAN/PERSONAL_TO_TEAM）不允许同时存在未终态订单——两类单都会改写订阅身份，
   * 交叉支付必然有一边按旧快照错结（续费先到账、转团队仍按旧折抵结算这类事故）。
   * 后建的一律 400，提示先完成支付或等订单过期（OrderExpiryTask 15 分钟收口）。
   */
  private async assertNoConflictingOpenOrder(userId: number, creating: "personal" | "team") {
    const blocking =
      creating === "personal"
        ? [BillingOrderType.TEAM_PLAN, BillingOrderType.PERSONAL_TO_TEAM]
        : [BillingOrderType.PLAN_NEW, BillingOrderType.PLAN_RENEW, BillingOrderType.PLAN_UPGRADE]
    const open = await this.prisma.billingOrder.findFirst({
      where: {
        userId,
        type: { in: blocking },
        status: {
          in: [BillingOrderStatus.CREATED, BillingOrderStatus.PENDING, BillingOrderStatus.PAID],
        },
      },
      select: { orderNo: true },
      orderBy: { createdAt: "desc" },
    })
    if (!open) return
    throw new BadRequestException(
      creating === "personal"
        ? `存在待支付的个人转企业/团队版订单（${open.orderNo}），与个人套餐互斥：请先完成该订单支付，或待其过期（15 分钟）后再购买个人套餐`
        : `存在待支付的个人套餐订单（${open.orderNo}），与购买团队版互斥：请先完成该订单支付，或待其过期（15 分钟）后再下单`
    )
  }

  /**
   * 个人充值单（PACK/CUSTOM）身份守卫（2026-09-01 产品收口，作废 2026-08-29「成员允许个人充值」定稿）：
   * 占用中企业成员（不分角色，成员 ACTIVE + 团队 ACTIVE/GRACE）不可购买个人充值——成员积分一律由
   * 管理员充企业共享池。前端已对企业身份隐藏个人充值入口；此守卫防直接调接口与「个人下单→入企业→
   * 再付款」的身份切换错结（下单/发起支付/结算三处同源调用本方法）。
   */
  async assertPersonalRechargeAllowed(userId: number) {
    const occupied = await this.team.findOccupiedTeamId(userId)
    if (occupied != null) {
      throw new BadRequestException(
        "你已归属企业团队，不可购买个人充值；如需积分请联系企业管理员充值企业共享池"
      )
    }
  }

  /** 个人套餐单前置守卫：互斥单拦截 + 占用中企业成员不可购买个人套餐（DISABLED 成员不受限——其购买后自动移出企业） */
  private async assertPersonalPlanAllowed(userId: number) {
    await this.assertNoConflictingOpenOrder(userId, "personal")
    const occupied = await this.team.findOccupiedTeamId(userId)
    if (occupied != null) {
      throw new BadRequestException(
        "你已归属企业团队，不可购买个人套餐；如需恢复个人计费，请联系企业管理员将你移出后再操作"
      )
    }
  }

  /** 个人新订阅：当前无有效订阅才允许（有则走续费/升档） */
  private async quotePlanNew(userId: number, dto: CreateOrderDto): Promise<OrderQuote> {
    const plan = await this.requirePlan(dto.targetTier)
    await this.assertPersonalPlanAllowed(userId)
    await this.credit.activateDuePlans(userId)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionExpiresAt: true },
    })
    if (user?.subscriptionExpiresAt && user.subscriptionExpiresAt > new Date()) {
      throw new BadRequestException("当前已有有效套餐，请使用续费或升级")
    }
    // 无有效订阅 → 支付后立即激活，到期 = now + 周期
    const q = this.planQuote(plan)
    q.expiresAt = new Date(Date.now() + plan.periodDays * DAY_MS)
    return q
  }

  /** 个人续费（**立即生效**）：同档=顺延一期，升档=立即切高档；高等级不能续费低等级。到期 = max(当前到期, 已排队遗留队尾, now) + 周期 */
  private async quotePlanRenew(userId: number, dto: CreateOrderDto): Promise<OrderQuote> {
    const plan = await this.requirePlan(dto.targetTier)
    await this.assertPersonalPlanAllowed(userId)
    await this.credit.activateDuePlans(userId)
    const now = new Date()
    const [user, pending] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { subscriptionTier: true, subscriptionExpiresAt: true },
      }),
      this.prisma.scheduledPlan.findMany({
        where: { userId, teamId: null, status: ScheduledPlanStatus.PENDING },
        select: { activateAt: true, periodDays: true },
      }),
    ])
    const active = user?.subscriptionExpiresAt != null && user.subscriptionExpiresAt > now
    if (active && user.subscriptionTier != null && plan.tier < user.subscriptionTier) {
      throw new BadRequestException("高等级套餐不能续费低等级套餐")
    }
    // 与 renewImmediateInTx 同一顺延口径：当前订阅到期 与 已排队（遗留）套餐到期 中的最晚者；都没有=now
    const tails: number[] = []
    if (active) tails.push(user.subscriptionExpiresAt!.getTime())
    for (const p of pending) tails.push(p.activateAt.getTime() + p.periodDays * DAY_MS)
    const activateAt = tails.length ? Math.max(...tails) : now.getTime()
    const q = this.planQuote(plan)
    q.expiresAt = new Date(activateAt + plan.periodDays * DAY_MS)
    return q
  }

  /**
   * 个人升档（立即生效）：**差价/积分差按剩余天数折算，到期日不变**（2026-08-25 起；
   * 多次续费拉长有效期后升级 = 整段剩余期按高档补齐）。要求当前订阅在有效期且目标档更高。
   */
  private async quotePlanUpgrade(userId: number, dto: CreateOrderDto): Promise<OrderQuote> {
    const plan = await this.requirePlan(dto.targetTier)
    await this.assertPersonalPlanAllowed(userId)
    await this.credit.activateDuePlans(userId)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionTier: true, subscriptionExpiresAt: true },
    })
    const now = new Date()
    if (
      !user?.subscriptionTier ||
      !user.subscriptionExpiresAt ||
      user.subscriptionExpiresAt <= now
    ) {
      throw new BadRequestException("当前无有效套餐，升级不可用，请使用订阅或续费")
    }
    if (plan.tier <= user.subscriptionTier) {
      throw new BadRequestException("套餐周期内仅可升级到更高档，不可降级或平级")
    }
    const currentPlan = await this.prisma.membershipPlan.findUnique({
      where: { tier: user.subscriptionTier },
    })
    if (!currentPlan) throw new BadRequestException("当前套餐配置缺失，无法计算升级差额")
    // 折算系数 = 剩余时长 / 一个周期（按天折算，毫秒精度）：续费 N 期后升级 = 整段剩余期按高档补齐
    const remainingMs = user.subscriptionExpiresAt.getTime() - now.getTime()
    const factor = new Decimal(remainingMs).div(currentPlan.periodDays * DAY_MS)
    const amount = new Decimal(plan.priceCny)
      .minus(currentPlan.priceCny)
      .mul(factor)
      .toDecimalPlaces(2)
    if (amount.lessThanOrEqualTo(0)) throw new BadRequestException("升级差价异常，请联系客服")
    // 积分差按「套餐本体 / 赠送」分别折算（各自不为负），入账时拆 PACKAGE / GIFT 两个批次
    const packageDiff = new Decimal(Math.max(plan.packageCredits - currentPlan.packageCredits, 0))
      .mul(factor)
      .toDecimalPlaces(0)
      .toNumber()
    const giftDiff = new Decimal(Math.max(plan.giftCredits - currentPlan.giftCredits, 0))
      .mul(factor)
      .toDecimalPlaces(0)
      .toNumber()
    const creditsDiff = packageDiff + giftDiff
    const remainingDays = Math.max(Math.ceil(remainingMs / DAY_MS), 1) // 展示用（quote.remainingDays 同源下发）
    return {
      amountCny: amount,
      creditsTotal: creditsDiff,
      expiresAt: user.subscriptionExpiresAt, // 升级后到期日不变
      remainingDays,
      items: [
        {
          name: `${plan.name} 会员升级补差（${currentPlan.name} → ${plan.name}）`,
          detail: `按剩余 ${remainingDays} 天折算补差，到期日不变（${user.subscriptionExpiresAt.toISOString().slice(0, 10)} 到期）`,
          qty: 1,
          amountCny: amount,
          credits: creditsDiff,
        },
      ],
      snapshot: {
        kind: "upgrade",
        fromTier: currentPlan.tier,
        toTier: plan.tier,
        planName: plan.name,
        creditsDiff,
        packageDiff,
        giftDiff,
        expiresAt: user.subscriptionExpiresAt.toISOString(), // 升级后到期日不变
      },
    }
  }

  /** 固定充值包（企业成员也可个人充值：积分进个人户，消费时按三段扣减兜底） */
  /** 个人充值包：金额=包人民币价、积分=基础+赠送（基础永不过期/赠送 30 天）。占用中企业成员 400（2026-09-01 起） */
  private async quotePack(userId: number, dto: CreateOrderDto): Promise<OrderQuote> {
    await this.assertPersonalRechargeAllowed(userId)
    if (!dto.packId) throw new BadRequestException("缺少充值包 id")
    const pack = await this.prisma.rechargePack.findUnique({ where: { id: dto.packId } })
    if (!pack || !pack.active) throw new BadRequestException("充值包不存在或已下架")
    const amountCny = new Decimal(pack.priceCny)
    const credits = pack.baseCredits + pack.bonusCredits
    return {
      amountCny,
      creditsTotal: credits,
      items: [
        {
          name: `充值包（${pack.baseCredits + pack.bonusCredits} 积分）`,
          detail: `基础 ${pack.baseCredits}（永不过期）+ 赠送 ${pack.bonusCredits}（30 天有效）`,
          qty: 1,
          amountCny,
          credits,
        },
      ],
      snapshot: {
        kind: "pack",
        packId: pack.id,
        priceCny: amountCny.toString(),
        baseCredits: pack.baseCredits,
        bonusCredits: pack.bonusCredits,
      },
    }
  }

  /** 自定义充值：本金 = 元 × CREDIT_PER_CNY（永不过期），赠送按个人阶梯（30 天有效）。占用中企业成员 400（2026-09-01 起，废「企业成员同可充」旧口径） */
  private async quoteCustom(userId: number, dto: CreateOrderDto): Promise<OrderQuote> {
    await this.assertPersonalRechargeAllowed(userId)
    if (!dto.amountCny) throw new BadRequestException("缺少充值金额")
    const amountCny = new Decimal(dto.amountCny)
    const minCny = getCustomMinCny()
    if (amountCny.decimalPlaces() > 2 || amountCny.lessThan(minCny)) {
      throw new BadRequestException(`充值金额最低 ¥${minCny.toFixed(2)}，且最多两位小数`)
    }
    const base = amountCny.mul(CREDIT_PER_CNY)
    const bonusRate = await this.ladder.bonusRate("PERSONAL", amountCny.toNumber())
    const bonus = base.mul(bonusRate).toDecimalPlaces(0)
    const total = base.plus(bonus)
    return {
      amountCny,
      creditsTotal: total.toDecimalPlaces(0).toNumber(),
      items: [
        {
          name: `自定义充值（${total.toDecimalPlaces(0).toString()} 积分）`,
          detail:
            `基础 ${base.toDecimalPlaces(0).toString()}（永不过期）` +
            (bonus.greaterThan(0) ? ` + 赠送 ${bonus.toString()}（30 天有效）` : ""),
          qty: 1,
          amountCny,
          credits: total.toDecimalPlaces(0).toNumber(),
        },
      ],
      snapshot: {
        kind: "custom",
        amountCny: amountCny.toString(),
        baseCredits: base.toString(),
        bonusRate,
        bonusCredits: bonus.toString(),
      },
    }
  }

  // ==================== 团队单 ====================

  /** 团队版新购（自助）：购买人不得已归属占用中企业；与个人套餐单互斥（防交叉支付旧快照错结） */
  private async quoteTeamPlan(userId: number, dto: CreateOrderDto): Promise<OrderQuote> {
    const plan = await this.requireTeamPlan(dto.teamTier)
    await this.assertNoConflictingOpenOrder(userId, "team")
    const occupied = await this.team.findOccupiedTeamId(userId)
    if (occupied != null) throw new BadRequestException("你已归属企业团队，无法再次购买团队版")
    const q = this.teamPlanQuote(plan, {
      kind: "team_plan",
      teamName: dto.teamName?.trim() || null,
      // 建队时个人充值包(RECHARGE)存量去向（与 P2T 同口径）：inject=支付后注入共享池；缺省 keep 留个人
      packChoice: dto.packChoice ?? "keep",
    })
    q.expiresAt = new Date(Date.now() + plan.periodDays * DAY_MS) // 支付后建队即生效
    return q
  }

  /** 团队续费（**立即生效**）：默认同档，可升档（立即切档+顺延）；高等级不能续费低等级；GRACE/ARCHIVED 单 settle 时立即恢复；平台定制企业可自助续费（tier 为空时必须显式传 teamTier） */
  private async quoteTeamRenew(userId: number, dto: CreateOrderDto): Promise<OrderQuote> {
    const team = await this.requireTeamAdminOrder(userId, dto.teamId)
    // 产品口径（2026-08-28 定）：平台定制企业不开放自助续费，续费/席位调整走客户成功经理线下处理
    if (team.source === TeamSource.CUSTOM) {
      throw new BadRequestException("平台定制企业的续费由客户成功经理处理，请联系客户成功")
    }
    if (team.status === TeamStatus.DISABLED) {
      throw new BadRequestException("团队已被平台停用，无法续费")
    }
    const plan = await this.requireTeamPlan(dto.teamTier ?? team.tier ?? undefined)
    const now = new Date()
    const active = team.status === TeamStatus.ACTIVE && team.expiresAt > now
    if (active && team.tier != null && plan.tier < team.tier) {
      throw new BadRequestException("高等级套餐不能续费低等级套餐")
    }
    const q = this.teamPlanQuote(plan, { kind: "team_renew", teamId: team.id })
    if (active) {
      // 与 renewTeamImmediateInTx 同一顺延口径：当前到期 与 已排队（遗留）套餐到期 中的最晚者
      const pending = await this.prisma.scheduledPlan.findMany({
        where: { teamId: team.id, status: ScheduledPlanStatus.PENDING },
        select: { activateAt: true, periodDays: true },
      })
      const tails = [
        team.expiresAt.getTime(),
        ...pending.map(p => p.activateAt.getTime() + p.periodDays * DAY_MS),
      ]
      q.expiresAt = new Date(Math.max(...tails) + plan.periodDays * DAY_MS)
    } else {
      q.expiresAt = new Date(now.getTime() + plan.periodDays * DAY_MS) // GRACE/ARCHIVED 支付后立即恢复
    }
    return q
  }

  /** 团队升席位档（立即生效）：**差价/池积分差按剩余天数折算，到期日不变**；仅 ACTIVE 在期可升；平台定制企业席位由平台侧维护（无法按标准套餐折算差价、且升档会覆盖定制席位），不支持自助升级 */
  private async quoteTeamSeatUpgrade(userId: number, dto: CreateOrderDto): Promise<OrderQuote> {
    const team = await this.requireTeamAdminOrder(userId, dto.teamId)
    if (team.source !== TeamSource.SELF || team.tier == null) {
      throw new BadRequestException("平台定制企业席位由平台侧维护，不支持自助升级")
    }
    if (team.status !== TeamStatus.ACTIVE || team.expiresAt <= new Date()) {
      throw new BadRequestException("团队不在有效期，升级不可用，请使用续费")
    }
    const target = await this.requireTeamPlan(dto.teamTier)
    if (target.tier <= (team.tier ?? 0)) {
      throw new BadRequestException("周期内仅可升级到更高席位档，不可降级或平级")
    }
    const current = await this.prisma.teamPlan.findUnique({ where: { tier: team.tier ?? -1 } })
    if (!current) throw new BadRequestException("当前团队套餐配置缺失，无法计算升级差额")
    // 折算系数 = 剩余时长 / 一个周期（按天折算）：续费拉长有效期后升席位 = 整段剩余期按高档补齐
    const remainingMs = team.expiresAt.getTime() - Date.now()
    const factor = new Decimal(remainingMs).div(current.periodDays * DAY_MS)
    const amount = new Decimal(target.priceCny)
      .minus(current.priceCny)
      .mul(factor)
      .toDecimalPlaces(2)
    if (amount.lessThanOrEqualTo(0)) throw new BadRequestException("升级差价异常，请联系客服")
    // 池积分差按「套餐 / 赠送」分别折算（各自不为负），入账时拆 PACKAGE / GIFT 两个批次
    const packageDiff = new Decimal(
      Math.max(target.poolPackageCredits - current.poolPackageCredits, 0)
    )
      .mul(factor)
      .toDecimalPlaces(0)
      .toNumber()
    const giftDiff = new Decimal(Math.max(target.poolGiftCredits - current.poolGiftCredits, 0))
      .mul(factor)
      .toDecimalPlaces(0)
      .toNumber()
    const creditsDiff = packageDiff + giftDiff
    const remainingDays = Math.max(Math.ceil(remainingMs / DAY_MS), 1) // 展示用（quote.remainingDays 同源下发）
    return {
      amountCny: amount,
      creditsTotal: creditsDiff,
      expiresAt: team.expiresAt, // 升级后到期日不变
      remainingDays,
      teamId: team.id,
      items: [
        {
          name: `${target.name} 团队席位升级补差（${current.name} → ${target.name}）`,
          detail: `按剩余 ${remainingDays} 天折算补差，到期日不变（${team.expiresAt.toISOString().slice(0, 10)} 到期）；席位 ${current.seats} → ${target.seats}`,
          qty: 1,
          amountCny: amount,
          credits: creditsDiff,
        },
      ],
      snapshot: {
        kind: "team_seat_upgrade",
        teamId: team.id,
        fromTier: current.tier,
        toTier: target.tier,
        planName: target.name,
        seats: target.seats,
        creditsDiff,
        packageDiff,
        giftDiff,
        expiresAt: team.expiresAt.toISOString(),
      },
    }
  }

  /** 团队共享池充值包（仅 ACTIVE 在期团队；GRACE/ARCHIVED 请先续费恢复） */
  private async quoteTeamPack(userId: number, dto: CreateOrderDto): Promise<OrderQuote> {
    const team = await this.requireActiveTeamForRecharge(userId, dto.teamId)
    if (!dto.packId) throw new BadRequestException("缺少充值包 id")
    const pack = await this.prisma.teamPack.findUnique({ where: { id: dto.packId } })
    if (!pack || !pack.active) throw new BadRequestException("充值包不存在或已下架")
    const amountCny = new Decimal(pack.priceCny)
    const credits = pack.baseCredits + pack.bonusCredits
    return {
      amountCny,
      creditsTotal: credits,
      teamId: team.id,
      items: [
        {
          name: `团队充值包（${credits} 积分）`,
          detail: `基础 ${pack.baseCredits}（永不过期）+ 赠送 ${pack.bonusCredits}（30 天有效），入共享池`,
          qty: 1,
          amountCny,
          credits,
        },
      ],
      snapshot: {
        kind: "team_pack",
        teamId: team.id,
        packId: pack.id,
        priceCny: amountCny.toString(),
        baseCredits: pack.baseCredits,
        bonusCredits: pack.bonusCredits,
      },
    }
  }

  /** 团队自定义充值：本金 = 元 × CREDIT_PER_CNY（永不过期），赠送按团队阶梯（30 天有效） */
  private async quoteTeamCustom(userId: number, dto: CreateOrderDto): Promise<OrderQuote> {
    const team = await this.requireActiveTeamForRecharge(userId, dto.teamId)
    if (!dto.amountCny) throw new BadRequestException("缺少充值金额")
    const amountCny = new Decimal(dto.amountCny)
    const minCny = getCustomMinCny()
    if (amountCny.decimalPlaces() > 2 || amountCny.lessThan(minCny)) {
      throw new BadRequestException(`充值金额最低 ¥${minCny.toFixed(2)}，且最多两位小数`)
    }
    const base = amountCny.mul(CREDIT_PER_CNY)
    const bonusRate = await this.ladder.bonusRate("TEAM", amountCny.toNumber())
    const bonus = base.mul(bonusRate).toDecimalPlaces(0)
    const total = base.plus(bonus)
    return {
      amountCny,
      creditsTotal: total.toDecimalPlaces(0).toNumber(),
      teamId: team.id,
      items: [
        {
          name: `团队自定义充值（${total.toDecimalPlaces(0).toString()} 积分）`,
          detail:
            `基础 ${base.toDecimalPlaces(0).toString()}（永不过期）` +
            (bonus.greaterThan(0) ? ` + 赠送 ${bonus.toString()}（30 天有效）` : "") +
            "，入共享池",
          qty: 1,
          amountCny,
          credits: total.toDecimalPlaces(0).toNumber(),
        },
      ],
      snapshot: {
        kind: "team_custom",
        teamId: team.id,
        amountCny: amountCny.toString(),
        baseCredits: base.toString(),
        bonusRate,
        bonusCredits: bonus.toString(),
      },
    }
  }

  /**
   * 个人转团队：目标团队档全价 − 个人套餐折抵
   * （floor(月费（元） × min(剩余天数/30, 剩余套餐积分比例))，取低者防套利；无有效个人套餐折抵 0）。
   * settle：建队 + 池入账 + 个人套餐/赠送清零 + 取消个人排队单 + packChoice 决定充值包去向。
   */
  private async quotePersonalToTeam(userId: number, dto: CreateOrderDto): Promise<OrderQuote> {
    const plan = await this.requireTeamPlan(dto.teamTier)
    await this.assertNoConflictingOpenOrder(userId, "team")
    const occupied = await this.team.findOccupiedTeamId(userId)
    if (occupied != null) throw new BadRequestException("你已归属企业团队，无法再次购买团队版")
    await this.credit.activateDuePlans(userId)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionTier: true, subscriptionExpiresAt: true },
    })
    const now = new Date()
    const planPrice = new Decimal(plan.priceCny)
    // 折抵三件套：可抵扣价值（积分比例不封顶，可 > 企业价）/ 实际抵入本单（≤ 企业价）/ 超出部分返还（×10 积分）
    let offsetValue = new Decimal(0)
    let offsetDetail: string | undefined
    let remainingDaysFloor: number | null = null // 折算所用剩余天数（与 offsetDetail 同口径 floor），quote 下发
    let personal: {
      tier: number
      priceCny: string
      expiresAt: string
      remainingDays: number
      remainingCredits: string
      factor: string
    } | null = null
    if (user?.subscriptionTier && user.subscriptionExpiresAt && user.subscriptionExpiresAt > now) {
      const currentPlan = await this.prisma.membershipPlan.findUnique({
        where: { tier: user.subscriptionTier },
      })
      if (currentPlan) {
        const remainingDays = (user.subscriptionExpiresAt.getTime() - now.getTime()) / DAY_MS
        remainingDaysFloor = Math.floor(remainingDays)
        // 2026-09-02 bug20 口径：折抵只算 PACKAGE 套餐本体——月发放量不含套餐赠送，
        // 剩余聚合也只数 PACKAGE 批次（注册赠送/充值包赠送/客服补偿等 GIFT 一概不抬折抵）
        const grantedTotal = currentPlan.packageCredits
        // 积分比例 = 个人 PACKAGE 剩余 / 该档月发放套餐本体（**不封顶**：续费多期/积分富余时可 >1）
        const agg = await this.prisma.creditLot.aggregate({
          where: {
            userId,
            teamId: null,
            bucket: CreditBucket.PACKAGE,
            status: CreditLotStatus.ACTIVE,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          _sum: { remaining: true },
        })
        const remaining = new Decimal(agg._sum.remaining ?? 0)
        const ratio = grantedTotal > 0 ? remaining.div(grantedTotal) : new Decimal(0)
        // 折算系数 = min(时间比例, 积分比例)；可抵扣价值 = floor(月费 × 系数)
        const factor = Decimal.min(new Decimal(remainingDays).div(30), ratio)
        offsetValue = Decimal.max(new Decimal(currentPlan.priceCny).mul(factor).floor(), 0)
        personal = {
          tier: currentPlan.tier,
          priceCny: currentPlan.priceCny.toString(),
          expiresAt: user.subscriptionExpiresAt.toISOString(),
          remainingDays,
          remainingCredits: remaining.toDecimalPlaces(0).toString(),
          factor: factor.toDecimalPlaces(4).toString(),
        }
        if (offsetValue.greaterThan(0)) {
          offsetDetail = `个人 ${currentPlan.name} 剩余 ${Math.floor(remainingDays)} 天 / 套餐积分剩余 ${personal.remainingCredits}，按低者折抵`
        }
      }
    }
    // 抵扣 ≤ 企业价：实付 = 差价（等于时实付 0，不返）；抵扣 > 企业价：实付 0，超出部分按 1 元=10 积分返还个人 RECHARGE（永不过期）
    const appliedOffset = Decimal.min(offsetValue, planPrice)
    const refundCny = offsetValue.minus(appliedOffset)
    const refundCredits = refundCny.greaterThan(0)
      ? refundCny.mul(CREDIT_PER_CNY).toDecimalPlaces(0).toNumber()
      : 0
    const amount = planPrice.minus(appliedOffset)
    const credits = plan.poolPackageCredits + plan.poolGiftCredits
    const items: OrderQuoteItem[] = [
      {
        name: `${plan.name} 团队版（${plan.seats} 席位 · ${plan.periodDays} 天）`,
        detail: `共享池 套餐 ${plan.poolPackageCredits} + 赠送 ${plan.poolGiftCredits}（均 30 天有效）`,
        qty: 1,
        amountCny: planPrice,
        credits,
      },
    ]
    if (appliedOffset.greaterThan(0)) {
      items.push({
        name: "个人套餐折抵",
        detail: offsetDetail,
        qty: 1,
        amountCny: appliedOffset.neg(),
        credits: null,
      })
    }
    if (refundCredits > 0) {
      // 返还去向与个人充值包同一选择（原型③二选一）：inject=团队共享池 / keep=个人账户
      const refundTarget = dto.packChoice === "inject" ? "团队共享池" : "个人充值积分"
      items.push({
        name: "超出抵扣返还充值积分",
        detail: `抵扣价值 ¥${offsetValue.toString()} 超出套餐价格 ¥${refundCny.toString()}，按 1 元=${CREDIT_PER_CNY} 积分返还至${refundTarget}（永不过期）`,
        qty: 1,
        amountCny: new Decimal(0),
        credits: refundCredits,
      })
    }
    return {
      amountCny: amount,
      // 合计到账 = 池套餐/赠送 + 超额返还充值积分（订单 creditsTotal = 实际发放总量，
      // 收据合计/支付记录/拒付反记账同口径；2026-08-28 起含返还，此前只有池积分导致收据合计漏算）
      creditsTotal: credits + refundCredits,
      expiresAt: new Date(now.getTime() + plan.periodDays * DAY_MS), // 支付后建队即生效
      remainingDays: remainingDaysFloor,
      packChoice: dto.packChoice ?? "keep",
      items,
      snapshot: {
        kind: "personal_to_team",
        teamTier: plan.tier,
        planName: plan.name,
        seats: plan.seats,
        priceCny: planPrice.toString(),
        poolPackageCredits: plan.poolPackageCredits,
        poolGiftCredits: plan.poolGiftCredits,
        periodDays: plan.periodDays,
        teamName: dto.teamName?.trim() || null,
        packChoice: dto.packChoice ?? "keep",
        offsetCny: offsetValue.toString(),
        appliedOffsetCny: appliedOffset.toString(),
        refundCny: refundCny.toString(),
        refundCredits,
        personalTier: personal?.tier ?? null,
        personalPriceCny: personal?.priceCny ?? null,
        personalExpiresAt: personal?.expiresAt ?? null,
        remainingDays: personal?.remainingDays ?? null,
        remainingCredits: personal?.remainingCredits ?? null,
        factor: personal?.factor ?? null,
      },
    }
  }

  // ---- 团队单共用 ----

  private async requireTeamPlan(tier: number | undefined) {
    if (!tier) throw new BadRequestException("缺少团队套餐档")
    const plan = await this.prisma.teamPlan.findUnique({ where: { tier } })
    if (!plan || !plan.active) throw new BadRequestException("团队套餐不存在或已下架")
    return plan
  }

  /** 团队单通用校验：团队存在 + 购买人=管理员（平台定制企业同样可自助续费/池充值） */
  private async requireTeamAdminOrder(userId: number, teamId: number | undefined) {
    if (!teamId) throw new BadRequestException("缺少团队 id")
    const team = await this.prisma.team.findUnique({ where: { id: teamId } })
    if (!team) throw new BadRequestException("团队不存在")
    if (team.adminId !== userId) throw new BadRequestException("仅企业管理员可下单")
    return team
  }

  /** 池充值类（TEAM_PACK/TEAM_CUSTOM）：仅 ACTIVE 在期团队（GRACE/ARCHIVED 请先续费恢复） */
  private async requireActiveTeamForRecharge(userId: number, teamId: number | undefined) {
    const team = await this.requireTeamAdminOrder(userId, teamId)
    if (team.status !== TeamStatus.ACTIVE || team.expiresAt <= new Date()) {
      throw new BadRequestException("团队不在有效期，请先续费恢复后再充值")
    }
    return team
  }

  /** TEAM_PLAN / TEAM_RENEW 共用的报价骨架（快照差异由 extra 合并） */
  private teamPlanQuote(
    plan: {
      tier: number
      name: string
      priceCny: Decimal
      seats: number
      poolPackageCredits: number
      poolGiftCredits: number
      periodDays: number
    },
    extra:
      | { kind: "team_plan"; teamName: string | null; packChoice: "inject" | "keep" }
      | { kind: "team_renew"; teamId: number }
  ): OrderQuote {
    const credits = plan.poolPackageCredits + plan.poolGiftCredits
    const amountCny = new Decimal(plan.priceCny)
    const snapshot: TeamPlanSnapshot | TeamRenewSnapshot =
      extra.kind === "team_plan"
        ? {
            kind: "team_plan",
            teamTier: plan.tier,
            planName: plan.name,
            seats: plan.seats,
            priceCny: amountCny.toString(),
            poolPackageCredits: plan.poolPackageCredits,
            poolGiftCredits: plan.poolGiftCredits,
            periodDays: plan.periodDays,
            teamName: extra.teamName,
            packChoice: extra.packChoice,
          }
        : {
            kind: "team_renew",
            teamId: extra.teamId,
            teamTier: plan.tier,
            planName: plan.name,
            priceCny: amountCny.toString(),
            poolPackageCredits: plan.poolPackageCredits,
            poolGiftCredits: plan.poolGiftCredits,
            periodDays: plan.periodDays,
          }
    return {
      amountCny,
      creditsTotal: credits,
      teamId: extra.kind === "team_renew" ? extra.teamId : null,
      packChoice: extra.kind === "team_plan" ? extra.packChoice : null, // TEAM_PLAN 建队时个人充值包去向（inject/keep）
      items: [
        {
          name: `${plan.name} 团队版（${plan.seats} 席位 · ${plan.periodDays} 天）`,
          detail: `共享池 套餐 ${plan.poolPackageCredits} + 赠送 ${plan.poolGiftCredits}（均 30 天有效）`,
          qty: 1,
          amountCny,
          credits,
        },
      ],
      snapshot,
    }
  }

  private async requirePlan(tier: number | undefined) {
    if (!tier) throw new BadRequestException("缺少目标套餐档")
    const plan = await this.prisma.membershipPlan.findUnique({ where: { tier } })
    if (!plan || !plan.active) throw new BadRequestException("套餐不存在或已下架")
    return plan
  }

  private planQuote(plan: {
    tier: number
    name: string
    priceCny: Decimal
    packageCredits: number
    giftCredits: number
    periodDays: number
  }): OrderQuote {
    const credits = plan.packageCredits + plan.giftCredits
    const amountCny = new Decimal(plan.priceCny)
    return {
      amountCny,
      creditsTotal: credits,
      items: [
        {
          name: `${plan.name} 会员套餐（${plan.periodDays} 天）`,
          detail: `套餐 ${plan.packageCredits} + 赠送 ${plan.giftCredits}（均 30 天有效）`,
          qty: 1,
          amountCny,
          credits,
        },
      ],
      snapshot: {
        kind: "plan",
        tier: plan.tier,
        planName: plan.name,
        priceCny: amountCny.toString(),
        packageCredits: plan.packageCredits,
        giftCredits: plan.giftCredits,
        periodDays: plan.periodDays,
      },
    }
  }
}
