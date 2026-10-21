import { Test } from "@nestjs/testing"
import { BillingOrderType, CreditBucket } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"
import { TeamService } from "../team/team.service"
import { CustomLadderService } from "./custom-ladder.service"
import { CreateOrderDto } from "./dto/billing.dto"
import { OrderPricingService } from "./order-pricing.service"

/** 算价唯一入口：各类型订单的金额/积分重算（后端权威，前端传值不采信）。目录全部人民币（元）。 */
describe("OrderPricingService", () => {
  let service: OrderPricingService
  let prisma: {
    membershipPlan: { findUnique: jest.Mock }
    rechargePack: { findUnique: jest.Mock }
    teamPlan: { findUnique: jest.Mock }
    teamPack: { findUnique: jest.Mock }
    team: { findUnique: jest.Mock }
    scheduledPlan: { findMany: jest.Mock }
    creditLot: { aggregate: jest.Mock }
    user: { findUnique: jest.Mock }
    billingOrder: { findFirst: jest.Mock }
  }
  let credit: { activateDuePlans: jest.Mock }
  let ladder: { bonusRate: jest.Mock }
  let teamSvc: { findOccupiedTeamId: jest.Mock }

  const plans: Record<
    number,
    {
      tier: number
      name: string
      active: boolean
      priceCny: string
      packageCredits: number
      giftCredits: number
      periodDays: number
    }
  > = {
    1: {
      tier: 1,
      name: "Explorer",
      active: true,
      priceCny: "199",
      packageCredits: 2000,
      giftCredits: 200,
      periodDays: 30,
    },
    2: {
      tier: 2,
      name: "Plus",
      active: true,
      priceCny: "399",
      packageCredits: 4000,
      giftCredits: 600,
      periodDays: 30,
    },
    3: {
      tier: 3,
      name: "Ultra",
      active: true,
      priceCny: "699",
      packageCredits: 7000,
      giftCredits: 2000,
      periodDays: 30,
    },
  }

  /** 团队套餐档 fixture（1 standard / 2 flagship） */
  const teamPlans: Record<
    number,
    {
      tier: number
      name: string
      active: boolean
      priceCny: string
      seats: number
      poolPackageCredits: number
      poolGiftCredits: number
      periodDays: number
    }
  > = {
    1: {
      tier: 1,
      name: "Standard",
      active: true,
      priceCny: "1299",
      seats: 5,
      poolPackageCredits: 10000,
      poolGiftCredits: 1000,
      periodDays: 30,
    },
    2: {
      tier: 2,
      name: "Flagship",
      active: true,
      priceCny: "2999",
      seats: 20,
      poolPackageCredits: 30000,
      poolGiftCredits: 6000,
      periodDays: 30,
    },
  }

  const selfTeam = (over: Record<string, unknown> = {}) => ({
    id: 10,
    adminId: 1,
    source: "SELF",
    status: "ACTIVE",
    tier: 1,
    seats: 5,
    expiresAt: new Date(Date.now() + 10 * 86400000),
    ...over,
  })

  afterEach(() => jest.restoreAllMocks())

  beforeEach(async () => {
    jest.replaceProperty(process, "env", { ...process.env, NODE_ENV: "" })
    prisma = {
      membershipPlan: {
        findUnique: jest.fn(({ where: { tier } }: { where: { tier: number } }) =>
          Promise.resolve(plans[tier] ?? null)
        ),
      },
      rechargePack: { findUnique: jest.fn() },
      teamPlan: {
        findUnique: jest.fn(({ where: { tier } }: { where: { tier: number } }) =>
          Promise.resolve(teamPlans[tier] ?? null)
        ),
      },
      teamPack: { findUnique: jest.fn() },
      team: { findUnique: jest.fn() },
      scheduledPlan: { findMany: jest.fn().mockResolvedValue([]) },
      creditLot: { aggregate: jest.fn().mockResolvedValue({ _sum: { remaining: null } }) },
      user: { findUnique: jest.fn() },
      // 互斥单拦截：默认无未终态冲突订单；相关用例按需覆盖
      billingOrder: { findFirst: jest.fn().mockResolvedValue(null) },
    }
    credit = { activateDuePlans: jest.fn().mockResolvedValue({ activated: 0 }) }
    ladder = { bonusRate: jest.fn().mockResolvedValue(0) }
    teamSvc = { findOccupiedTeamId: jest.fn().mockResolvedValue(null) }

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrderPricingService,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: credit },
        { provide: CustomLadderService, useValue: ladder },
        { provide: TeamService, useValue: teamSvc },
      ],
    }).compile()
    service = moduleRef.get(OrderPricingService)
  })

  const dto = (partial: Partial<CreateOrderDto>): CreateOrderDto => partial as CreateOrderDto

  it("PLAN_NEW：无有效订阅 → 金额=套餐人民币价、积分=套餐+赠送", async () => {
    prisma.user.findUnique.mockResolvedValue({ subscriptionExpiresAt: null })
    const before = Date.now()
    const q = await service.quote(1, dto({ type: BillingOrderType.PLAN_NEW, targetTier: 2 }))
    expect(q.amountCny.toString()).toBe("399")
    expect(q.creditsTotal).toBe(4600)
    expect(q.snapshot).toMatchObject({
      kind: "plan",
      tier: 2,
      priceCny: "399",
      packageCredits: 4000,
      giftCredits: 600,
    })
    // 预计到期 = now + 30 天（支付后立即激活）
    expect(q.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 86400000)
    expect(q.expiresAt!.getTime()).toBeLessThan(Date.now() + 30 * 86400000 + 5000)
  })

  it("PLAN_NEW：已有有效订阅 → 拦截", async () => {
    prisma.user.findUnique.mockResolvedValue({
      subscriptionExpiresAt: new Date(Date.now() + 86400000),
    })
    await expect(
      service.quote(1, dto({ type: BillingOrderType.PLAN_NEW, targetTier: 2 }))
    ).rejects.toThrow("续费或升级")
  })

  it("PLAN_UPGRADE：差价/积分差按剩余天数折算，到期日不变（剩 3 天 = 0.1 期）", async () => {
    const expiresAt = new Date(Date.now() + 3 * 86400000)
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 2,
      subscriptionExpiresAt: expiresAt,
    })
    const q = await service.quote(1, dto({ type: BillingOrderType.PLAN_UPGRADE, targetTier: 3 }))
    expect(q.amountCny.toString()).toBe("30") // (699-399) × 3/30
    expect(q.creditsTotal).toBe(440) // (3000+1400) × 3/30
    expect(q.expiresAt).toEqual(expiresAt) // 升级后到期日不变
    expect(q.remainingDays).toBe(3) // 折算所用剩余天数（ceil），前端两个弹窗统一用它
    expect(q.snapshot).toMatchObject({
      kind: "upgrade",
      fromTier: 2,
      toTier: 3,
      creditsDiff: 440,
      expiresAt: expiresAt.toISOString(),
    })
  })

  it("PLAN_UPGRADE：续费 2 期后（剩 60 天）升级 = 整段剩余期按高档补齐（×2 折算）", async () => {
    const expiresAt = new Date(Date.now() + 60 * 86400000)
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 2,
      subscriptionExpiresAt: expiresAt,
    })
    const q = await service.quote(1, dto({ type: BillingOrderType.PLAN_UPGRADE, targetTier: 3 }))
    expect(q.amountCny.toString()).toBe("600") // (699-399) × 60/30
    expect(q.creditsTotal).toBe(8800) // (3000+1400) × 2
    expect(q.remainingDays).toBe(60)
    expect(q.snapshot).toMatchObject({ packageDiff: 6000, giftDiff: 2800 })
  })

  it("PLAN_UPGRADE：平级/降级/无有效订阅 → 拦截", async () => {
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 3,
      subscriptionExpiresAt: new Date(Date.now() + 86400000),
    })
    await expect(
      service.quote(1, dto({ type: BillingOrderType.PLAN_UPGRADE, targetTier: 2 }))
    ).rejects.toThrow("更高档")

    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: null,
      subscriptionExpiresAt: null,
    })
    await expect(
      service.quote(1, dto({ type: BillingOrderType.PLAN_UPGRADE, targetTier: 2 }))
    ).rejects.toThrow("无有效套餐")
  })

  it("PLAN_RENEW：在期续费 → 预计到期 = 原到期日 + 周期（立即顺延口径）", async () => {
    const subExpires = new Date(Date.now() + 10 * 86400000)
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 2,
      subscriptionExpiresAt: subExpires,
    })
    prisma.scheduledPlan.findMany.mockResolvedValue([])
    const q = await service.quote(1, dto({ type: BillingOrderType.PLAN_RENEW, targetTier: 2 }))
    expect(q.amountCny.toString()).toBe("399")
    expect(q.expiresAt!.toISOString()).toBe(
      new Date(subExpires.getTime() + 30 * 86400000).toISOString()
    )
  })

  it("PLAN_RENEW：高等级续费低等级 → 拦截（立即生效后不允许降档）", async () => {
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 3,
      subscriptionExpiresAt: new Date(Date.now() + 10 * 86400000),
    })
    await expect(
      service.quote(1, dto({ type: BillingOrderType.PLAN_RENEW, targetTier: 2 }))
    ).rejects.toThrow("高等级套餐不能续费低等级套餐")
    // 同档/升档续费放行
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 2,
      subscriptionExpiresAt: new Date(Date.now() + 10 * 86400000),
    })
    await expect(
      service.quote(1, dto({ type: BillingOrderType.PLAN_RENEW, targetTier: 3 }))
    ).resolves.toMatchObject({ amountCny: new Decimal("699") })
  })

  it("PLAN_RENEW：已有排队套餐 → 预计到期排在队尾之后", async () => {
    const subExpires = new Date(Date.now() + 10 * 86400000)
    prisma.user.findUnique.mockResolvedValue({ subscriptionExpiresAt: subExpires })
    // 已排队一笔：activateAt=原到期，周期 30 天 → 队尾=原到期+30 天；本笔到期=队尾+30 天
    prisma.scheduledPlan.findMany.mockResolvedValue([{ activateAt: subExpires, periodDays: 30 }])
    const q = await service.quote(1, dto({ type: BillingOrderType.PLAN_RENEW, targetTier: 2 }))
    expect(q.expiresAt!.toISOString()).toBe(
      new Date(subExpires.getTime() + 60 * 86400000).toISOString()
    )
  })

  it("PLAN_RENEW：无有效订阅且无排队 → 预计到期 = now + 周期", async () => {
    prisma.user.findUnique.mockResolvedValue({ subscriptionExpiresAt: null })
    prisma.scheduledPlan.findMany.mockResolvedValue([])
    const before = Date.now()
    const q = await service.quote(1, dto({ type: BillingOrderType.PLAN_RENEW, targetTier: 2 }))
    expect(q.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 86400000)
    expect(q.expiresAt!.getTime()).toBeLessThan(Date.now() + 30 * 86400000 + 5000)
  })

  it("PACK：金额=包人民币价、积分=基础+赠送", async () => {
    prisma.rechargePack.findUnique.mockResolvedValue({
      id: 2,
      active: true,
      priceCny: "100",
      baseCredits: 1000,
      bonusCredits: 100,
    })
    const q = await service.quote(1, dto({ type: BillingOrderType.PACK, packId: 2 }))
    expect(q.amountCny.toString()).toBe("100")
    expect(q.creditsTotal).toBe(1100)
    expect(q.snapshot).toMatchObject({
      kind: "pack",
      packId: 2,
      priceCny: "100",
      baseCredits: 1000,
      bonusCredits: 100,
    })
  })

  it("CUSTOM：本金=元×CREDIT_PER_CNY、赠送走个人阶梯", async () => {
    ladder.bonusRate.mockResolvedValue(0.25)
    const q = await service.quote(1, dto({ type: BillingOrderType.CUSTOM, amountCny: "100.00" }))
    expect(q.amountCny.toString()).toBe("100") // Prisma Decimal 归一化：去掉末尾零
    // base = ¥100 × 10 = 1000；bonus = 1000 × 25% = 250
    expect(q.creditsTotal).toBe(1250)
    expect(q.snapshot).toMatchObject({ kind: "custom", amountCny: "100", bonusRate: 0.25 })
    expect(ladder.bonusRate).toHaveBeenCalledWith("PERSONAL", 100)
  })

  it.each([BillingOrderType.CUSTOM, BillingOrderType.TEAM_CUSTOM])("%s：development 的 0.10 元为 1 积分，低于下限拒绝", async type => {
    process.env.NODE_ENV = "development"
    prisma.team.findUnique.mockResolvedValue(selfTeam())
    const q = await service.quote(1, dto({ type, teamId: 10, amountCny: "0.10" }))
    expect(q.amountCny.toString()).toBe("0.1")
    expect(q.creditsTotal).toBe(1)
    expect(q.snapshot.baseCredits).toBe("1")
    await expect(service.quote(1, dto({ type, teamId: 10, amountCny: "0.09" }))).rejects.toThrow("最低 ¥0.10")
  })

  it.each(["", "dev3", "test", "dev", "dev1", "dev2", "dev30", "uat", "prod", "production"])(
    "非 development 环境 %s 保持 10 元下限，数据库名不影响判断",
    async value => {
      process.env.NODE_ENV = value
      process.env.DATABASE_URL = "mysql://localhost/agent-api-dev3"
      await expect(
        service.quote(1, dto({ type: BillingOrderType.CUSTOM, amountCny: "0.10" }))
      ).rejects.toThrow("最低 ¥10.00")
    }
  )

  it("CUSTOM：低于 ¥10 / 金额格式非法 → 拦截", async () => {
    await expect(
      service.quote(1, dto({ type: BillingOrderType.CUSTOM, amountCny: "9.99" }))
    ).rejects.toThrow("最低")
    await expect(
      service.quote(1, dto({ type: BillingOrderType.CUSTOM, amountCny: "100.001" }))
    ).rejects.toThrow("两位小数")
  })

  it("TEAM_PLAN：金额=团队档人民币价、积分=池套餐+池赠送；已归属企业 → 拦截", async () => {
    const q = await service.quote(
      1,
      dto({ type: BillingOrderType.TEAM_PLAN, teamTier: 2, teamName: "Acme" })
    )
    expect(q.amountCny.toString()).toBe("2999")
    expect(q.creditsTotal).toBe(36000)
    expect(q.snapshot).toMatchObject({
      kind: "team_plan",
      teamTier: 2,
      priceCny: "2999",
      seats: 20,
      teamName: "Acme",
    })

    teamSvc.findOccupiedTeamId.mockResolvedValue(10)
    await expect(
      service.quote(1, dto({ type: BillingOrderType.TEAM_PLAN, teamTier: 1 }))
    ).rejects.toThrow("已归属")
  })

  it("TEAM_PLAN：packChoice 落 quote 与快照（inject / 缺省 keep），TEAM_RENEW 恒 null", async () => {
    const q = await service.quote(
      1,
      dto({ type: BillingOrderType.TEAM_PLAN, teamTier: 1, packChoice: "inject" })
    )
    expect(q.packChoice).toBe("inject")
    expect(q.snapshot).toMatchObject({ kind: "team_plan", packChoice: "inject" })

    const q2 = await service.quote(1, dto({ type: BillingOrderType.TEAM_PLAN, teamTier: 1 }))
    expect(q2.packChoice).toBe("keep")
    expect(q2.snapshot).toMatchObject({ kind: "team_plan", packChoice: "keep" })
  })

  it("TEAM_RENEW：默认同档；DISABLED / 非管理员 → 拦截", async () => {
    const team = selfTeam()
    prisma.team.findUnique.mockResolvedValue(team)
    const q = await service.quote(1, dto({ type: BillingOrderType.TEAM_RENEW, teamId: 10 }))
    expect(q.amountCny.toString()).toBe("1299")
    expect(q.teamId).toBe(10)
    expect(q.snapshot).toMatchObject({ kind: "team_renew", teamId: 10, teamTier: 1 })
    // ACTIVE 在期续费：预计到期 = 团队当前到期 + 周期
    expect(q.expiresAt!.toISOString()).toBe(
      new Date(team.expiresAt.getTime() + 30 * 86400000).toISOString()
    )

    prisma.team.findUnique.mockResolvedValue(selfTeam({ status: "DISABLED" }))
    await expect(
      service.quote(1, dto({ type: BillingOrderType.TEAM_RENEW, teamId: 10 }))
    ).rejects.toThrow("停用")

    prisma.team.findUnique.mockResolvedValue(selfTeam({ adminId: 99 }))
    await expect(
      service.quote(1, dto({ type: BillingOrderType.TEAM_RENEW, teamId: 10 }))
    ).rejects.toThrow("管理员")
  })

  it("TEAM_RENEW：平台定制企业不开放自助续费 → 400（走客户成功经理）", async () => {
    prisma.team.findUnique.mockResolvedValue(selfTeam({ source: "CUSTOM", tier: null }))
    await expect(
      service.quote(1, dto({ type: BillingOrderType.TEAM_RENEW, teamId: 10 }))
    ).rejects.toThrow("客户成功")
    // 显式传档同样拦截（口径不按传参放行）
    await expect(
      service.quote(1, dto({ type: BillingOrderType.TEAM_RENEW, teamId: 10, teamTier: 1 }))
    ).rejects.toThrow("客户成功")
  })

  it("TEAM_RENEW：高等级续费低等级 → 拦截", async () => {
    prisma.team.findUnique.mockResolvedValue(selfTeam({ tier: 2 }))
    await expect(
      service.quote(1, dto({ type: BillingOrderType.TEAM_RENEW, teamId: 10, teamTier: 1 }))
    ).rejects.toThrow("高等级套餐不能续费低等级套餐")
  })

  it("TEAM_SEAT_UPGRADE：差价/池积分差按剩余天数折算 + 席位，到期日不变；平级 → 拦截", async () => {
    prisma.team.findUnique.mockResolvedValue(selfTeam())
    const q = await service.quote(
      1,
      dto({ type: BillingOrderType.TEAM_SEAT_UPGRADE, teamId: 10, teamTier: 2 })
    )
    // 团队剩 10 天 → 系数 10/30：(2999-1299)×10/30 = 566.67；池积分差同比例折算
    expect(q.amountCny.toString()).toBe("566.67")
    expect(q.creditsTotal).toBe(6667 + 1667)
    expect(q.remainingDays).toBe(10)
    expect(q.snapshot).toMatchObject({
      kind: "team_seat_upgrade",
      fromTier: 1,
      toTier: 2,
      seats: 20,
      packageDiff: 6667,
      giftDiff: 1667,
    })

    await expect(
      service.quote(1, dto({ type: BillingOrderType.TEAM_SEAT_UPGRADE, teamId: 10, teamTier: 1 }))
    ).rejects.toThrow("更高")

    prisma.team.findUnique.mockResolvedValue(selfTeam({ status: "GRACE" }))
    await expect(
      service.quote(1, dto({ type: BillingOrderType.TEAM_SEAT_UPGRADE, teamId: 10, teamTier: 2 }))
    ).rejects.toThrow("不在有效期")

    // 平台定制企业席位由平台侧维护（无法按标准套餐折算差价、升档会覆盖定制席位）
    prisma.team.findUnique.mockResolvedValue(selfTeam({ source: "CUSTOM", tier: null }))
    await expect(
      service.quote(1, dto({ type: BillingOrderType.TEAM_SEAT_UPGRADE, teamId: 10, teamTier: 2 }))
    ).rejects.toThrow("平台定制企业席位由平台侧维护")
  })

  it("TEAM_PACK：入共享池（基础+赠送）；GRACE 团队 → 拦截", async () => {
    prisma.team.findUnique.mockResolvedValue(selfTeam())
    prisma.teamPack.findUnique.mockResolvedValue({
      id: 3,
      active: true,
      priceCny: "500",
      baseCredits: 5000,
      bonusCredits: 500,
    })
    const q = await service.quote(
      1,
      dto({ type: BillingOrderType.TEAM_PACK, teamId: 10, packId: 3 })
    )
    expect(q.amountCny.toString()).toBe("500")
    expect(q.creditsTotal).toBe(5500)
    expect(q.snapshot).toMatchObject({
      kind: "team_pack",
      teamId: 10,
      packId: 3,
      priceCny: "500",
    })

    prisma.team.findUnique.mockResolvedValue(selfTeam({ status: "GRACE" }))
    await expect(
      service.quote(1, dto({ type: BillingOrderType.TEAM_PACK, teamId: 10, packId: 3 }))
    ).rejects.toThrow("续费")
  })

  it("TEAM_CUSTOM：赠送走团队阶梯", async () => {
    prisma.team.findUnique.mockResolvedValue(selfTeam())
    ladder.bonusRate.mockResolvedValue(0.35)
    const q = await service.quote(
      1,
      dto({ type: BillingOrderType.TEAM_CUSTOM, teamId: 10, amountCny: "100.00" })
    )
    expect(q.creditsTotal).toBe(1350)
    expect(ladder.bonusRate).toHaveBeenCalledWith("TEAM", 100)
    expect(q.snapshot).toMatchObject({ kind: "team_custom", teamId: 10, bonusRate: 0.35 })
  })

  it("TEAM_PACK / TEAM_CUSTOM：平台定制企业可自助池充值", async () => {
    prisma.team.findUnique.mockResolvedValue(selfTeam({ source: "CUSTOM", tier: null }))
    prisma.teamPack.findUnique.mockResolvedValue({
      id: 3,
      active: true,
      priceCny: "500",
      baseCredits: 5000,
      bonusCredits: 500,
    })
    const pack = await service.quote(
      1,
      dto({ type: BillingOrderType.TEAM_PACK, teamId: 10, packId: 3 })
    )
    expect(pack.amountCny.toString()).toBe("500")
    expect(pack.creditsTotal).toBe(5500)

    ladder.bonusRate.mockResolvedValue(0.35)
    const custom = await service.quote(
      1,
      dto({ type: BillingOrderType.TEAM_CUSTOM, teamId: 10, amountCny: "100.00" })
    )
    expect(custom.creditsTotal).toBe(1350)
  })

  it("PERSONAL_TO_TEAM：折抵=floor(月费（元） × min(剩余天数/30, 积分比例))，负 item；无套餐折抵 0", async () => {
    // 剩 15 天（factor 0.5）；PACKAGE 剩余 4600 ÷ 月发放套餐本体 4000 = 115%（不封顶）≥ 时间比例 → 折抵 = floor(399 × 0.5) = 199
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 2,
      subscriptionExpiresAt: new Date(Date.now() + 15 * 86400000),
    })
    prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(4600) } })
    const q = await service.quote(
      1,
      dto({ type: BillingOrderType.PERSONAL_TO_TEAM, teamTier: 1, packChoice: "inject" })
    )
    expect(q.amountCny.toString()).toBe("1100") // 1299 - 199
    expect(q.items).toHaveLength(2)
    expect(q.items[1].name).toBe("个人套餐折抵")
    expect(q.items[1].amountCny.toString()).toBe("-199")
    expect(q.packChoice).toBe("inject")
    // floor 边界：mock 到期时刻与 quote 执行可能差 1ms（15 - ε → 14），两个值都合法
    expect([14, 15]).toContain(q.remainingDays)
    expect(q.snapshot).toMatchObject({ kind: "personal_to_team", offsetCny: "199" })

    // 无有效个人套餐 → 折抵 0，全额
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: null,
      subscriptionExpiresAt: null,
    })
    const q2 = await service.quote(1, dto({ type: BillingOrderType.PERSONAL_TO_TEAM, teamTier: 1 }))
    expect(q2.amountCny.toString()).toBe("1299")
    expect(q2.items).toHaveLength(1)
    expect(q2.packChoice).toBe("keep")
    expect(q2.remainingDays).toBeNull()
  })

  it("PERSONAL_TO_TEAM：积分比例低于天数比例时按积分比例折抵（取低防套利）", async () => {
    // 剩 30 天（factor 1.0）；PACKAGE 剩余 2000 ÷ 月发放本体 4000 = 50% → 折抵 = floor(399 × 0.5) = 199
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 2,
      subscriptionExpiresAt: new Date(Date.now() + 30 * 86400000),
    })
    prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(2000) } })
    const q = await service.quote(1, dto({ type: BillingOrderType.PERSONAL_TO_TEAM, teamTier: 1 }))
    expect(q.amountCny.toString()).toBe("1100") // 1299 - 199

    // bug20（2026-09-02）：折抵聚合只数 PACKAGE 套餐本体桶——GIFT（注册/套餐/充值赠送、客服补偿）不参与
    const aggWhere = prisma.creditLot.aggregate.mock.calls[0]?.[0] as {
      where: { bucket: unknown }
    }
    expect(aggWhere.where.bucket).toEqual(CreditBucket.PACKAGE)
  })

  it("PERSONAL_TO_TEAM：积分比例不封顶——抵扣可超 1 倍；≤企业价实付差价，>企业价实付 0 + 超出 ×10 返积分", async () => {
    // 2026-09-02 起只算套餐本体：Ultra 699（月发放 PACKAGE 7000），PACKAGE 剩余 29800（比例≈4.2571），剩 147 天（比例 4.9）
    // 系数 = min(4.9, 4.2571) = 4.2571 → 可抵扣 = floor(699 × 4.2571) = 2975
    prisma.user.findUnique.mockResolvedValue({
      subscriptionTier: 3,
      subscriptionExpiresAt: new Date(Date.now() + 147 * 86400000),
    })
    prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(29800) } })

    // 升旗舰版 2999：实付 24，不返还
    const q1 = await service.quote(1, dto({ type: BillingOrderType.PERSONAL_TO_TEAM, teamTier: 2 }))
    expect(q1.amountCny.toString()).toBe("24")
    expect(q1.snapshot).toMatchObject({
      offsetCny: "2975",
      appliedOffsetCny: "2975",
      refundCny: "0",
      refundCredits: 0,
      personalTier: 3,
      personalPriceCny: "699",
    })
    expect(q1.items).toHaveLength(2) // 团队版 + 折抵（无返还行）

    // 升团队版 1299：实付 0，超出 1676 → 返 16760 积分（信息行入 items）
    const q2 = await service.quote(1, dto({ type: BillingOrderType.PERSONAL_TO_TEAM, teamTier: 1 }))
    expect(q2.amountCny.toString()).toBe("0")
    expect(q2.snapshot).toMatchObject({
      offsetCny: "2975",
      appliedOffsetCny: "1299",
      refundCny: "1676",
      refundCredits: 16760,
    })
    // creditsTotal = 池积分(10000+1000) + 返还 16760（收据合计/支付记录同口径，含返还）
    expect(q2.creditsTotal).toBe(11000 + 16760)
    expect(q2.items).toHaveLength(3)
    expect(q2.items[1].amountCny.toString()).toBe("-1299") // 折抵行只抵到企业价
    expect(q2.items[2]).toMatchObject({ name: "超出抵扣返还充值积分", credits: 16760 })
    expect(q2.items[2].amountCny.toString()).toBe("0")
    expect(q2.items[2].detail).toContain("个人充值积分") // keep → 返还留个人户

    // inject → 返还去向文案联动为「团队共享池」（与个人充值包同一选择，原型③二选一）
    const q3 = await service.quote(
      1,
      dto({ type: BillingOrderType.PERSONAL_TO_TEAM, teamTier: 1, packChoice: "inject" })
    )
    expect(q3.items[2].detail).toContain("团队共享池")
    expect(q3.packChoice).toBe("inject")
  })

  describe("互斥订单拦截（个人套餐单 ↔ 建队单）", () => {
    it("存在未终态建队单 → 个人新购/续费/升级一律 400", async () => {
      prisma.billingOrder.findFirst.mockResolvedValue({ orderNo: "SR20260827000000001" })
      prisma.user.findUnique.mockResolvedValue({
        subscriptionTier: 2,
        subscriptionExpiresAt: new Date(Date.now() + 86400000),
      })
      await expect(
        service.quote(1, dto({ type: BillingOrderType.PLAN_NEW, targetTier: 2 }))
      ).rejects.toThrow("互斥")
      await expect(
        service.quote(1, dto({ type: BillingOrderType.PLAN_RENEW, targetTier: 2 }))
      ).rejects.toThrow("互斥")
      await expect(
        service.quote(1, dto({ type: BillingOrderType.PLAN_UPGRADE, targetTier: 3 }))
      ).rejects.toThrow("互斥")
    })

    it("存在未终态个人套餐单 → 团队版新购/个人转企业一律 400", async () => {
      prisma.billingOrder.findFirst.mockResolvedValue({ orderNo: "SR20260827000000002" })
      await expect(
        service.quote(1, dto({ type: BillingOrderType.TEAM_PLAN, teamTier: 1 }))
      ).rejects.toThrow("互斥")
      await expect(
        service.quote(1, dto({ type: BillingOrderType.PERSONAL_TO_TEAM, teamTier: 1 }))
      ).rejects.toThrow("互斥")
    })

    it("占用中企业成员不可购买个人套餐 → 400（DISABLED 成员不算占用中，不受限）", async () => {
      teamSvc.findOccupiedTeamId.mockResolvedValue(10)
      prisma.user.findUnique.mockResolvedValue({ subscriptionExpiresAt: null })
      await expect(
        service.quote(1, dto({ type: BillingOrderType.PLAN_NEW, targetTier: 2 }))
      ).rejects.toThrow("你已归属企业团队")
    })

    it("占用中企业成员不可下个人充值单（PACK/CUSTOM 一律 400，2026-09-01 产品收口，废 8-29「成员允许个人充值」定稿）", async () => {
      teamSvc.findOccupiedTeamId.mockResolvedValue(10) // 在期企业成员（不分角色）
      prisma.rechargePack.findUnique.mockResolvedValue({
        id: 2,
        active: true,
        priceCny: "100",
        baseCredits: 1000,
        bonusCredits: 100,
      })
      await expect(
        service.quote(1, dto({ type: BillingOrderType.PACK, packId: 2 }))
      ).rejects.toThrow("你已归属企业团队")
      await expect(
        service.quote(1, dto({ type: BillingOrderType.CUSTOM, amountCny: "100.00" }))
      ).rejects.toThrow("你已归属企业团队")
    })

    it("充值类订单（PACK）不参与互斥拦截", async () => {
      prisma.rechargePack.findUnique.mockResolvedValue({
        id: 2,
        active: true,
        priceCny: "100",
        baseCredits: 1000,
        bonusCredits: 100,
      })
      const q = await service.quote(1, dto({ type: BillingOrderType.PACK, packId: 2 }))
      expect(q.amountCny.toString()).toBe("100")
      expect(prisma.billingOrder.findFirst).not.toHaveBeenCalled()
    })
  })
})
