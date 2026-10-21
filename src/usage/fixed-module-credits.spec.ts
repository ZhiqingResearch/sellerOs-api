import { Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"
import { PricingService } from "../pricing/pricing.service"
import { TeamQuotaService } from "../team/team-quota.service"
import { TeamModelConfigService } from "../team/team-model-config.service"
import { FeatureRegistryService } from "./feature-registry.service"
import { UsageService } from "./usage.service"
import { quotaMonthOf } from "../team/team.constants"

function setup() {
  const prisma = {
    teamMember: { findFirst: jest.fn().mockResolvedValue(null) },
    usageLog: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    $transaction: jest.fn(),
  }
  prisma.$transaction.mockImplementation(callback => callback(prisma))
  const credit = {
    consume: jest.fn(),
    consumeCredits: jest.fn().mockImplementation(async (_user, credits, cost) => ({
      creditsCharged: credits, costCny: cost, balanceAfter: new Decimal(100), breakdown: [],
    })),
    assertAffordable: jest.fn(),
    consumableBalance: jest.fn().mockResolvedValue(new Decimal(0)),
    getConsumableBalanceRouted: jest.fn().mockResolvedValue(new Decimal(100)),
    teamPoolBalance: jest.fn().mockResolvedValue(new Decimal(100)),
    lockPersonalBalancesInTx: jest.fn().mockResolvedValue({ giftLayer: new Decimal(10), recharge: new Decimal(20), total: new Decimal(30) }),
    lockTeamPoolBalanceInTx: jest.fn().mockResolvedValue(new Decimal(100)),
  }
  const teamQuota = { deductWithQuota: jest.fn().mockImplementation(async (_team, _user, credits, cost) => ({
    creditsCharged: credits, costCny: cost, balanceAfter: new Decimal(85), breakdown: [],
  })) }
  const service = new UsageService(prisma as unknown as PrismaService, {} as PricingService,
    credit as unknown as CreditService, teamQuota as unknown as TeamQuotaService,
    { ensureFresh: jest.fn(), get: (source: string) => ({ source, label: source, module: "listing", moduleLabel: "Listing" }) } as unknown as FeatureRegistryService,
    {} as TeamModelConfigService)
  return { service, prisma, credit, teamQuota }
}

describe("固定模块积分结算与预检", () => {
  it.each([1, 2, 5])("类目分析 %s 个，余额预检、实扣和流水数量一致", async quantity => {
    const f = setup()
    const expected = 80 * quantity
    await expect(f.service.assertFixedModuleAffordable(7, "category.analysis", undefined, undefined, quantity)).resolves.toEqual({ credits: expected })
    expect(f.credit.assertAffordable).toHaveBeenCalledWith(7, new Decimal(expected / 10), new Decimal(expected))
    const result = await f.service.chargeFixedModule(7, "category.analysis", { quantity, model: "model", requestId: "categories" })
    expect(result.creditsCharged.toNumber()).toBe(expected)
    expect(f.prisma.usageLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ credits: new Decimal(expected), meta: expect.objectContaining({ unitCredits: 80, quantity, fixedCredits: expected }) }) })
  })
  it.each([0, -1, 1.5, 6])("非法类目数量 %s 不能预检或扣费", async quantity => {
    const f = setup()
    await expect(f.service.assertFixedModuleAffordable(7, "category.analysis", undefined, undefined, quantity)).rejects.toThrow("计费数量无效")
    await expect(f.service.chargeFixedModule(7, "category.analysis", { quantity, model: "model", requestId: "invalid" })).rejects.toThrow("计费数量无效")
    expect(f.credit.consumeCredits).not.toHaveBeenCalled()
  })
  it.each([1, 2, 3])("竞品分析 %s 个，预检和实扣均按每个25积分", async quantity => {
    const f = setup()
    const expected = quantity * 25
    await expect(f.service.assertFixedModuleAffordable(7, "competitor.research", undefined, undefined, quantity))
      .resolves.toEqual({ credits: expected })
    expect(f.credit.assertAffordable).toHaveBeenCalledWith(7, new Decimal(expected / 10), new Decimal(expected))
    const result = await f.service.chargeFixedModule(7, "competitor.research", {
      quantity, model: "model", requestId: "competitors",
    })
    expect(result.creditsCharged.toNumber()).toBe(expected)
    expect(f.prisma.usageLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      credits: new Decimal(expected),
      meta: expect.objectContaining({ unitCredits: 25, quantity, fixedCredits: expected }),
    }) })
  })
  it("企业余额仅够一个竞品时，两个竞品的预检拒绝启动", async () => {
    const f = setup()
    f.prisma.teamMember.findFirst.mockResolvedValue({
      teamId: 2, monthlyQuota: null, team: { quotaMode: "SHARED", overLimitPolicy: "WARN" },
    })
    f.credit.teamPoolBalance.mockResolvedValue(new Decimal(25))
    await expect(f.service.assertFixedModuleAffordable(7, "competitor.research", undefined, undefined, 2))
      .rejects.toThrow("积分余额不足，本次需要 50 积分")
    expect(f.credit.consumeCredits).not.toHaveBeenCalled()
  })
  it("批量竞品结算重复请求返回首次75积分，不重复扣费", async () => {
    const f = setup()
    f.prisma.usageLog.findUnique.mockResolvedValue({
      cost: new Decimal(7.5), credits: new Decimal(75), balanceAfter: new Decimal(25),
    })
    const result = await f.service.chargeFixedModule(7, "competitor.research", {
      quantity: 3, model: "model", requestId: "repeat-batch",
    })
    expect(result.duplicate).toBe(true)
    expect(result.creditsCharged.toNumber()).toBe(75)
    expect(f.credit.consumeCredits).not.toHaveBeenCalled()
  })
  it("Listing第二方案复用已付25积分，余额不足仍可完成同次生成", async () => {
    const f = setup()
    f.prisma.usageLog.findFirst.mockResolvedValue({ id: 1 })
    f.credit.assertAffordable.mockRejectedValue(new Error("积分余额不足"))
    await expect(f.service.assertFixedModuleAffordable(7, "listing.generate", undefined, "batch")).resolves.toEqual({ credits: 0 })
    expect(f.prisma.usageLog.findFirst).toHaveBeenCalledWith({
      where: { userId: 7, source: "listing.generate", requestId: "listing-generation:7:batch" }, select: { id: true },
    })
    expect(f.credit.assertAffordable).not.toHaveBeenCalled()
    await expect(f.service.assertFixedModuleAffordable(7, "listing.generate", "optimization", "batch")).rejects.toThrow("积分余额不足")
  })
  it.each([
    ["listing.generate", 25], ["listing.score", 15], ["category.analysis", 80],
    ["flow.workbench", 50], ["competitor.research", 25], ["launch.plan", 15], ["pricing.quote", 10],
  ] as const)("%s 精确扣 %s，不走成本折扣换算", async (source, expected) => {
    const f = setup()
    const result = await f.service.chargeFixedModule(7, source, { model: "model", requestId: "request" })
    expect(result.creditsCharged.toNumber()).toBe(expected)
    expect(f.credit.consume).not.toHaveBeenCalled()
    expect(f.prisma.usageLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      credits: new Decimal(expected), requestId: "request", meta: expect.objectContaining({
        pricing: "fixed_module", consumeEventId: expect.any(String),
      }),
    }) })
  })
  it("AI优化建议5积分，原始模型成本不影响售价", async () => {
    const f = setup()
    const result = await f.service.chargeFixedModule(7, "listing.generate", {
      model: "model", requestId: "optimize", meta: { operation: "optimization", actualCostCny: "19.99" },
    })
    expect(result.creditsCharged.toNumber()).toBe(5)
  })
  it("个人预检传精确积分，避免折扣用户按低价放行", async () => {
    const f = setup()
    await f.service.assertFixedModuleAffordable(7, "listing.generate")
    expect(f.credit.assertAffordable).toHaveBeenCalledWith(7, new Decimal(2.5), new Decimal(25))
  })
  it("企业折扣不改变25积分，赠送10+企业15按原顺序扣减", async () => {
    const f = setup()
    f.prisma.teamMember.findFirst.mockResolvedValue({ teamId: 2, monthlyQuota: null, team: { discount: new Decimal(0.2), quotaMode: "SHARED", overLimitPolicy: "WARN" } })
    const result = await f.service.chargeFixedModule(7, "listing.generate", { model: "model", requestId: "mixed" })
    expect(result.creditsCharged.toNumber()).toBe(25)
    expect(f.credit.consumeCredits.mock.calls[0][1].toNumber()).toBe(10)
    expect(f.teamQuota.deductWithQuota.mock.calls[0][2].toNumber()).toBe(15)
    expect(f.credit.consume).not.toHaveBeenCalled()
  })
  it("共享池BLOCK达到配额不能把不可用池余额计入预检", async () => {
    const f = setup()
    f.prisma.teamMember.findFirst.mockResolvedValue({ teamId: 2, monthlyQuota: new Decimal(10), quotaUsedThisMonth: new Decimal(10), quotaMonth: quotaMonthOf(), team: { quotaMode: "SHARED", overLimitPolicy: "BLOCK" } })
    await expect(f.service.assertFixedModuleAffordable(7, "listing.generate")).rejects.toThrow("积分余额不足")
    expect(f.credit.consumeCredits).not.toHaveBeenCalled()
  })
  it("共享池受限时个人充值足够仍可启动", async () => {
    const f = setup()
    f.prisma.teamMember.findFirst.mockResolvedValue({ teamId: 2, monthlyQuota: new Decimal(0), quotaUsedThisMonth: new Decimal(0), quotaMonth: quotaMonthOf(), team: { quotaMode: "SHARED", overLimitPolicy: "BLOCK" } })
    f.credit.consumableBalance.mockResolvedValueOnce(new Decimal(0)).mockResolvedValueOnce(new Decimal(25))
    await expect(f.service.assertFixedModuleAffordable(7, "listing.generate")).resolves.toEqual({ credits: 25 })
  })
  it("重复请求直接返回原扣费，不动余额", async () => {
    const f = setup()
    f.prisma.usageLog.findUnique.mockResolvedValue({ cost: new Decimal(2.5), credits: new Decimal(25), balanceAfter: new Decimal(75) })
    expect((await f.service.chargeFixedModule(7, "listing.generate", { model: "model", requestId: "repeat" })).duplicate).toBe(true)
    expect(f.credit.consumeCredits).not.toHaveBeenCalled()
  })
  it("并发唯一键冲突向事务外冒泡，再读取首次结果", async () => {
    const f = setup()
    f.prisma.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" }))
    f.prisma.usageLog.findUnique.mockResolvedValue({ cost: new Decimal(2.5), credits: new Decimal(25), balanceAfter: new Decimal(75) })
    expect((await f.service.chargeFixedModule(7, "listing.generate", { model: "model", requestId: "race" })).duplicate).toBe(true)
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1)
  })
  it("旧浏览器补报Token与MCP不会叠加扣费", async () => {
    const f = setup()
    const token = await f.service.chargeTokens(7, { source: "listing.generate", promptTokens: 100, completionTokens: 50 })
    const mcp = await f.service.chargeMcp(7, { source: "category.analysis", calls: 20 })
    expect(token.creditsCharged.toNumber()).toBe(0)
    expect(mcp.creditsCharged.toNumber()).toBe(0)
    expect(f.prisma.$transaction).not.toHaveBeenCalled()
  })
})
