import { BadRequestException, NotFoundException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { InvokeType, PricingTier, Prisma, UsageType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { CreditService } from "../membership/credit.service"
import { PricingService } from "../pricing/pricing.service"
import { PrismaService } from "../prisma/prisma.service"
import { TeamModelConfigService } from "../team/team-model-config.service"
import { TeamQuotaService } from "../team/team-quota.service"
import { quotaMonthOf } from "../team/team.constants"
import { StatsPeriod } from "./dto/query-usage-stats.dto"
import { FeatureRegistryService } from "./feature-registry.service"
import { UsageService } from "./usage.service"

describe("UsageService", () => {
  let service: UsageService
  let prisma: {
    user: {
      findUnique: jest.Mock
      update: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
      aggregate: jest.Mock
    }
    teamMember: { findFirst: jest.Mock }
    team: { findUnique: jest.Mock }
    usageLog: {
      findMany: jest.Mock
      count: jest.Mock
      create: jest.Mock
      findUnique: jest.Mock
      groupBy: jest.Mock
      aggregate: jest.Mock
    }
    aiGatewayModel: { findFirst: jest.Mock }
    aiGatewayVideoFixedPrice: { findMany: jest.Mock }
    creditLot: { groupBy: jest.Mock; aggregate: jest.Mock }
    $transaction: jest.Mock
  }
  let pricing: {
    getTokenPriceTier: jest.Mock
    getMcpCallPrice: jest.Mock
  }
  let credit: {
    consume: jest.Mock
    consumeCredits: jest.Mock
    getWallet: jest.Mock
    assertAffordable: jest.Mock
    getConsumableBalance: jest.Mock
    teamPoolBalance: jest.Mock
    lockPersonalBalancesInTx: jest.Mock
    lockTeamPoolBalanceInTx: jest.Mock
    resolveEffectiveDiscount: jest.Mock
  }
  let teamQuota: { deductWithQuota: jest.Mock }
  let teamModelConfig: { resolveModuleModels: jest.Mock }

  /** 归属 active 企业的成员行（扣费路由上下文）：默认 SHARED/WARN、无月度上限；BLOCK 等场景按需覆盖 */
  const memberCtx = (teamId: number, over: Record<string, unknown> = {}) => ({
    teamId,
    monthlyQuota: null,
    quotaUsedThisMonth: new Decimal(0),
    quotaMonth: null,
    team: { quotaMode: "SHARED", overLimitPolicy: "WARN", discount: new Decimal(1) },
    ...over,
  })

  it.each(["NORMAL", "REFERENCE", "MOTION_CONTROL", "STORYBOARD", "BEAUTY"])(
    "按量计费倍率精确读取 %s 类别，不串用同模型其他类别",
    async category => {
      prisma.aiGatewayModel.findFirst.mockResolvedValue({ priceMultiplier: new Decimal(3) })
      expect((await service.gatewayPriceMultiplier("shared-model", category)).toString()).toBe("3")
      expect(prisma.aiGatewayModel.findFirst).toHaveBeenCalledWith({
        where: { publicId: "shared-model", category },
        select: { priceMultiplier: true },
      })
    }
  )

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        aggregate: jest.fn(),
      },
      teamMember: {
        // 默认无企业归属 → 走个人扣费路径；团队路由用例按需覆盖
        findFirst: jest.fn().mockResolvedValue(null),
      },
      team: {
        // 模型落账兜底：默认团队无全局文本默认模型；「通用 source 记默认」用例按需覆盖
        findUnique: jest.fn().mockResolvedValue(null),
      },
      usageLog: {
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
        groupBy: jest.fn(),
        aggregate: jest.fn(),
      },
      creditLot: {
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { remaining: new Decimal(0) } }),
      },
      aiGatewayModel: {
        findFirst: jest.fn(),
      },
      aiGatewayVideoFixedPrice: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(),
    }

    // 模拟 $transaction：直接执行回调，传入 prisma 本身作为 tx
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma))

    pricing = {
      getTokenPriceTier: jest.fn(),
      getMcpCallPrice: jest.fn(),
    }

    // 默认 consume 成功，返回 0 积分余额；各用例按需覆盖
    credit = {
      consume: jest.fn().mockResolvedValue({
        creditsCharged: new Decimal(0),
        costCny: new Decimal(0),
        breakdown: [],
        balanceAfter: new Decimal(0),
      }),
      consumeCredits: jest.fn().mockResolvedValue({
        creditsCharged: new Decimal(0),
        costCny: new Decimal(0),
        breakdown: [],
        balanceAfter: new Decimal(0),
      }),
      getWallet: jest.fn(),
      assertAffordable: jest.fn(),
      getConsumableBalance: jest.fn().mockResolvedValue(new Decimal(0)),
      teamPoolBalance: jest.fn(),
      // 混合扣费预读默认：个人余额全 0 + 池充足 → 纯企业段（与老用例口径一致）；混合场景按需覆盖
      lockPersonalBalancesInTx: jest.fn().mockResolvedValue({
        giftLayer: new Decimal(0),
        recharge: new Decimal(0),
        total: new Decimal(0),
      }),
      lockTeamPoolBalanceInTx: jest.fn().mockResolvedValue(new Decimal(100000)),
      // 生效折扣解析：mock 透传——直接用入参 user 的 discount（等效 canInvite=true/无邀请人分支）
      resolveEffectiveDiscount: jest
        .fn()
        .mockImplementation(async (_c: unknown, u: { discount: Decimal | string | number }) =>
          Promise.resolve(new Decimal(u.discount))
        ),
    }

    teamQuota = {
      deductWithQuota: jest.fn().mockResolvedValue({
        creditsCharged: new Decimal(0),
        costCny: new Decimal(0),
        breakdown: [],
        balanceAfter: new Decimal(0),
      }),
    }

    teamModelConfig = {
      // 默认无模块默认模型；「记默认模型」用例按需覆盖
      resolveModuleModels: jest.fn().mockResolvedValue({
        source: "module",
        allowedModels: [],
        defaultModel: null,
        memberSelectable: true,
      }),
    }

    const module = await Test.createTestingModule({
      providers: [
        UsageService,
        { provide: PrismaService, useValue: prisma },
        { provide: PricingService, useValue: pricing },
        { provide: CreditService, useValue: credit },
        { provide: TeamQuotaService, useValue: teamQuota },
        { provide: TeamModelConfigService, useValue: teamModelConfig },
        {
          provide: FeatureRegistryService,
          useValue: {
            ensureFresh: jest.fn().mockResolvedValue(undefined),
            // 默认注册表含 listing.generate / video-project.generate；用例按需覆盖 get
            get: jest
              .fn()
              .mockImplementation((source: string) =>
                ["listing.generate", "video-project.generate"].includes(source)
                  ? { source, label: "Listing 生成", module: "listing", moduleLabel: "Listing" }
                  : null
              ),
            list: jest.fn().mockReturnValue([]),
          },
        },
      ],
    }).compile()

    service = module.get(UsageService)
  })

  describe("Seedance 2.5 视频计费", () => {
    it("两个模式都按 $0.134/秒，5 秒预检人民币费用为 9.38 元", async () => {
      for (const mode of ["NORMAL", "REFERENCE"]) {
        await service.assertVideoAffordable(1, {
          mode,
          model: "video-seedance-2-5",
          durationSec: 5,
          resolution: "720p",
        })
      }

      const calls = credit.assertAffordable.mock.calls as unknown as Array<[number, Decimal]>
      const costs = calls.map(([, cost]) => cost.toString())
      expect(costs).toEqual(["9.38", "9.38"])
    })

    it("批量视频预检按整批预计费用一次性校验", async () => {
      await service.assertVideosAffordable(1, [
        {
          mode: "NORMAL",
          model: "video-seedance-2-5",
          durationSec: 5,
          resolution: "720p",
        },
        {
          mode: "REFERENCE",
          model: "video-seedance-2-5",
          durationSec: 5,
          resolution: "720p",
        },
      ])

      expect(credit.assertAffordable).toHaveBeenCalledTimes(1)
      const call = credit.assertAffordable.mock.calls[0] as unknown as [number, Decimal]
      expect(call[0]).toBe(1)
      expect(call[1].toString()).toBe("18.76")
    })

    it("能力预览显示 19 积分/秒，且分辨率不影响价格", () => {
      expect(
        service.getVideoCreditsPerSecondPreview({
          mode: "NORMAL",
          model: "video-seedance-2-5",
          resolutions: ["480p", "720p"],
          defaultResolution: "720p",
        })
      ).toEqual({ default: 19, min: 19, max: 19 })
    })
  })

  describe("Atlas Seedance 2.0 Fast 视频计费", () => {
    it("两个模式和两个分辨率都按 $0.072/秒，5 秒预检为 5.04 元", async () => {
      for (const [mode, model] of [
        ["NORMAL", "video-ultra"],
        ["REFERENCE", "video-ultra-reference"],
      ]) {
        for (const resolution of ["480p", "720p"]) {
          await service.assertVideoAffordable(1, {
            mode,
            model,
            durationSec: 5,
            resolution,
          })
        }
      }

      const calls = credit.assertAffordable.mock.calls as unknown as Array<[number, Decimal]>
      expect(calls.map(([, cost]) => cost.toString())).toEqual(["5.04", "5.04", "5.04", "5.04"])
    })

    it("能力预览为 11 积分/秒，且分辨率不影响价格", () => {
      expect(
        service.getVideoCreditsPerSecondPreview({
          mode: "REFERENCE",
          model: "video-ultra-reference",
          resolutions: ["480p", "720p"],
          defaultResolution: "720p",
        })
      ).toEqual({ default: 11, min: 11, max: 11 })
    })
  })

  describe("Atlas Seedance 2.0 Mini 七折价计费", () => {
    it("480p 档按 $0.0392/秒，5 秒预检为 2.744 元", async () => {
      await service.assertVideoAffordable(1, {
        mode: "REFERENCE",
        model: "video-mini",
        durationSec: 5,
        resolution: "480p",
      })

      const calls = credit.assertAffordable.mock.calls as unknown as Array<[number, Decimal]>
      expect(calls[0][1].toString()).toBe("2.744")
    })

    it("720p 档按 $0.0847/秒，5 秒预检为 5.929 元", async () => {
      await service.assertVideoAffordable(1, {
        mode: "REFERENCE",
        model: "video-mini",
        durationSec: 5,
        resolution: "720p",
      })

      const calls = credit.assertAffordable.mock.calls as unknown as Array<[number, Decimal]>
      expect(calls[0][1].toString()).toBe("5.929")
    })

    it("能力预览默认 12 积分/秒，不同分辨率范围为 6-12", () => {
      expect(
        service.getVideoCreditsPerSecondPreview({
          mode: "REFERENCE",
          model: "video-mini",
          resolutions: ["480p", "720p", "720p-SR", "1080p-SR", "1440p-SR"],
          defaultResolution: "720p",
        })
      ).toEqual({ default: 12, min: 6, max: 12 })
    })
  })

  describe("chargeTokens - 档位由 promptTokens 决定 + 走 CreditService 扣积分", () => {
    it.each([InvokeType.API, InvokeType.PLATFORM])(
      "服务端 token 计费将 %s 传递到积分流水内核",
      async invokeType => {
        pricing.getTokenPriceTier.mockResolvedValue({
          tier: PricingTier.LOW,
          inputPriceCny: new Decimal(9),
          outputPriceCny: new Decimal(54),
        })
        await service.chargeTokens(
          1,
          { promptTokens: 100, completionTokens: 50, source: "aicreative.image_generate" },
          { invokeType }
        )
        expect(credit.consume).toHaveBeenCalledWith(
          1,
          expect.any(Decimal),
          expect.objectContaining({ source: "aicreative.image_generate", invokeType }),
          expect.anything()
        )
      }
    )

    const consumeOk = (balanceAfter: string, creditsCharged = "0") => ({
      creditsCharged: new Decimal(creditsCharged),
      costCny: new Decimal(0),
      breakdown: [],
      balanceAfter: new Decimal(balanceAfter),
    })

    it("LOW 档：输入15万、输出50万 → costCny = 1.35 + 27 = 28.35 元", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })
      credit.consume.mockResolvedValue(consumeOk("1000", "283.5"))

      const result = await service.chargeTokens(1, {
        promptTokens: 150000,
        completionTokens: 500000,
      })

      expect(pricing.getTokenPriceTier).toHaveBeenCalledWith(150000)
      expect(result.costCny.toString()).toBe("28.35")
      expect(result.creditsCharged.toString()).toBe("283.5")
      expect(result.balance.toString()).toBe("1000")
      // 不再直接改 user.balance
      expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it("HIGH 档：输入25万、输出5万 → costCny = 4.5 + 4.05 = 8.55 元", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.HIGH,
        inputPriceCny: new Decimal(18),
        outputPriceCny: new Decimal(81),
      })
      credit.consume.mockResolvedValue(consumeOk("100"))

      const result = await service.chargeTokens(1, {
        promptTokens: 250000,
        completionTokens: 50000,
      })

      expect(result.costCny.toString()).toBe("8.55")
    })

    it("thinkingTokens 合并到输出计费：输入10万、输出3万、思考2万 → costCny = 0.9 + 2.7 = 3.6", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })
      credit.consume.mockResolvedValue(consumeOk("100"))

      const result = await service.chargeTokens(1, {
        promptTokens: 100000,
        completionTokens: 30000,
        thinkingTokens: 20000,
      })

      expect(result.costCny.toString()).toBe("3.6")
    })

    it("调用 CreditService.consume（带 source/meta），UsageLog.balanceAfter=积分余额", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })
      credit.consume.mockResolvedValue(consumeOk("888", "45"))

      await service.chargeTokens(1, {
        promptTokens: 100000,
        completionTokens: 50000,
        source: "customer.strategy",
        meta: { model: "gemini-2.5-flash" },
      })

      const consumeCalls = credit.consume.mock.calls as unknown as Array<
        [number, Decimal, { source?: string; meta?: unknown }, unknown]
      >
      expect(consumeCalls[0][0]).toBe(1)
      expect(consumeCalls[0][2]).toEqual({
        source: "customer.strategy",
        meta: { model: "gemini-2.5-flash" },
      })

      const logCalls = prisma.usageLog.create.mock.calls as unknown as Array<
        [{ data: Record<string, unknown> }]
      >
      expect(logCalls).toHaveLength(1)
      expect(logCalls[0][0].data).toMatchObject({
        userId: 1,
        type: UsageType.TOKEN,
        promptTokens: 100000,
        completionTokens: 50000,
        thinkingTokens: 0,
        mcpCalls: null,
        source: "customer.strategy",
        meta: { model: "gemini-2.5-flash" },
      })
      expect((logCalls[0][0].data.balanceAfter as Decimal).toString()).toBe("888")
    })

    it("在单个事务中完成扣积分 + 写流水", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })
      credit.consume.mockResolvedValue(consumeOk("100"))

      await service.chargeTokens(1, { promptTokens: 100000, completionTokens: 50000 })

      expect(prisma.$transaction).toHaveBeenCalledTimes(1)
      expect(credit.consume).toHaveBeenCalledTimes(1)
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "ReadCommitted",
        maxWait: 10_000,
        timeout: 20_000,
      })
    })

    it("模型落账：显式传 dto.model → 直接记录（优先于 meta.model 与团队默认）", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })
      credit.consume.mockResolvedValue(consumeOk("100"))

      await service.chargeTokens(1, {
        promptTokens: 100000,
        completionTokens: 50000,
        source: "ai.chat",
        model: "gemini-3.1-flash",
        meta: { model: "gemini-2.5-flash", traceId: "t1" },
      })

      const logCalls = prisma.usageLog.create.mock.calls as unknown as Array<
        [{ data: { meta?: Record<string, unknown> } }]
      >
      expect(logCalls[0][0].data.meta).toEqual({
        model: "gemini-3.1-flash", // 显式传覆盖 meta.model
        traceId: "t1",
      })
      expect(teamModelConfig.resolveModuleModels).not.toHaveBeenCalled()
    })

    it("带 businessEventId 的 Token 扣费写入单次扣费 ID，供积分明细聚合", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })
      credit.consume.mockResolvedValue(consumeOk("100"))

      await service.chargeTokens(1, {
        promptTokens: 100,
        completionTokens: 50,
        source: "llm.generic",
        meta: { businessEventId: "pricing-run-1", operation: "generation" },
      })

      const logCalls = prisma.usageLog.create.mock.calls as unknown as Array<
        [{ data: { meta?: Record<string, unknown> } }]
      >
      expect(logCalls[0][0].data.meta).toMatchObject({
        businessEventId: "pricing-run-1",
        operation: "generation",
        usageKind: "token",
        usageChargeId: expect.any(String) as unknown,
      })
    })

    it("模型落账：团队成员未传模型 → 记该功能模块在团队模型配置中的默认模型", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })
      credit.consume.mockResolvedValue(consumeOk("100"))
      prisma.teamMember.findFirst.mockResolvedValue(memberCtx(3))
      teamModelConfig.resolveModuleModels.mockResolvedValue({
        source: "module",
        allowedModels: ["gemini-3.1-pro"],
        defaultModel: "gemini-3.1-pro",
        memberSelectable: true,
      })

      await service.chargeTokens(1, {
        promptTokens: 100000,
        completionTokens: 50000,
        source: "video-project.generate", // 测试注册表模块映射
      })

      expect(teamModelConfig.resolveModuleModels).toHaveBeenCalledWith(3, "listing", "text")
      const logCalls = prisma.usageLog.create.mock.calls as unknown as Array<
        [{ data: { meta?: Record<string, unknown> } }]
      >
      expect(logCalls[0][0].data.meta).toEqual({ model: "gemini-3.1-pro" })
    })

    it("模型落账：通用 source（未归菜单，llm.generic/ai.chat）企业成员 → 记团队全局文本默认模型", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })
      credit.consume.mockResolvedValue(consumeOk("100"))
      prisma.teamMember.findFirst.mockResolvedValue(memberCtx(3))
      prisma.team.findUnique.mockResolvedValue({ defaultModelText: "gemini-2.5-flash" })

      await service.chargeTokens(1, {
        promptTokens: 100000,
        completionTokens: 50000,
        source: "llm.generic", // spec 注册表 mock 对它返回 null（未归菜单）
      })

      expect(teamModelConfig.resolveModuleModels).not.toHaveBeenCalled()
      const logCalls = prisma.usageLog.create.mock.calls as unknown as Array<
        [{ data: { meta?: Record<string, unknown> } }]
      >
      expect(logCalls[0][0].data.meta).toEqual({ model: "gemini-2.5-flash" })
    })

    it("模型落账：个人用户（无企业归属）不传模型 → 不记录，也不查模型配置", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })
      credit.consume.mockResolvedValue(consumeOk("100"))

      await service.chargeTokens(1, {
        promptTokens: 100000,
        completionTokens: 50000,
        source: "ai.chat",
      })

      expect(teamModelConfig.resolveModuleModels).not.toHaveBeenCalled()
      const logCalls = prisma.usageLog.create.mock.calls as unknown as Array<
        [{ data: { meta?: unknown } }]
      >
      expect(logCalls[0][0].data.meta).toBeUndefined()
    })

    it("余额不足时 consume 抛 400，透传给调用方", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })
      credit.consume.mockRejectedValue(new BadRequestException("积分余额不足，请充值"))

      await expect(
        service.chargeTokens(1, { promptTokens: 100000, completionTokens: 50000 })
      ).rejects.toThrow("积分余额不足，请充值")
    })
  })

  describe("团队消费路由（归属 active 企业 → 共享池扣费）", () => {
    const joinTeam = (teamId = 7, discount = "1") => {
      prisma.teamMember.findFirst.mockResolvedValue(memberCtx(teamId))
      prisma.user.findUnique.mockResolvedValue({ discount: new Decimal(discount) })
    }

    it("chargeTokens：走 deductWithQuota（积分=成本×10×折扣向上取整），不动个人额度", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })
      joinTeam()
      teamQuota.deductWithQuota.mockResolvedValue({
        creditsCharged: new Decimal(36),
        costCny: new Decimal("3.6"),
        breakdown: [],
        balanceAfter: new Decimal(964),
      })

      const res = await service.chargeTokens(1, {
        promptTokens: 100000,
        completionTokens: 50000,
        source: "customer.strategy",
      })

      // cost = 0.9 + 2.7 = 3.6 → 36 积分
      expect(teamQuota.deductWithQuota).toHaveBeenCalledTimes(1)
      const args = teamQuota.deductWithQuota.mock.calls[0] as unknown as [
        number,
        number,
        Decimal,
        Decimal,
        { source?: string },
        unknown,
      ]
      expect(args[0]).toBe(7)
      expect(args[1]).toBe(1)
      expect(args[2].toString()).toBe("36")
      expect(args[3].toString()).toBe("3.6")
      expect(args[4]).toEqual({ source: "customer.strategy", meta: undefined })
      expect(credit.consume).not.toHaveBeenCalled()
      expect(res.balance.toString()).toBe("964")
      // UsageLog 仍记成员本人 + 池余额
      const logCalls = prisma.usageLog.create.mock.calls as unknown as Array<
        [{ data: Record<string, unknown> }]
      >
      expect(logCalls).toHaveLength(1)
      expect(logCalls[0][0].data.userId).toBe(1)
      expect((logCalls[0][0].data.balanceAfter as Decimal).toString()).toBe("964")
    })

    it("chargeTokens：池段按 Team.discount 换算（团队 0.8：3.6 × 10 × 0.8 = 28.8 → 29），成员个人折扣不影响池段", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })
      joinTeam(7, "0.7") // 成员个人折扣 0.7——池段不看它
      prisma.teamMember.findFirst.mockResolvedValue(
        memberCtx(7, {
          team: { quotaMode: "SHARED", overLimitPolicy: "WARN", discount: new Decimal("0.8") },
        })
      )

      await service.chargeTokens(1, { promptTokens: 100000, completionTokens: 50000 })

      const args = teamQuota.deductWithQuota.mock.calls[0] as unknown as [number, number, Decimal]
      expect(args[2].toString()).toBe("29")
    })

    it("双费率分段：个人赠送段按成员生效折扣、池段按 Team.discount 各自换算（成员 0.8 / 池 0.75）", async () => {
      // 成本 5 元：赠送层 20 积分先烧（20÷8=2.5 元），余 2.5 元走池 → 2.5×7.5=18.75→19 积分
      joinTeam(7, "0.8")
      prisma.teamMember.findFirst.mockResolvedValue(
        memberCtx(7, {
          team: { quotaMode: "SHARED", overLimitPolicy: "WARN", discount: new Decimal("0.75") },
        })
      )
      credit.lockPersonalBalancesInTx.mockResolvedValue({
        giftLayer: new Decimal(20),
        recharge: new Decimal(100),
        total: new Decimal(120),
      })
      credit.lockTeamPoolBalanceInTx.mockResolvedValue(new Decimal(1000))

      await service.deductCustom(1, 5, { source: "listing.generate" })

      const giftCall = credit.consumeCredits.mock.calls[0] as unknown as [
        number,
        Decimal,
        Decimal,
        Record<string, unknown>,
        unknown,
      ]
      expect(giftCall[1].toString()).toBe("20") // 赠送段 20 积分
      expect(giftCall[2].toString()).toBe("2.5") // 覆盖成本 2.5 元
      const teamArgs = teamQuota.deductWithQuota.mock.calls[0] as unknown as [
        number,
        number,
        Decimal,
        Decimal,
        unknown,
        unknown,
      ]
      expect(teamArgs[2].toString()).toBe("19") // 池段 19 积分（池率 7.5 而非个人率 8）
      expect(credit.consumeCredits).toHaveBeenCalledTimes(1) // 无个人充值段
    })

    it("deductCustom：归属企业同样走团队扣费", async () => {
      joinTeam()
      teamQuota.deductWithQuota.mockResolvedValue({
        creditsCharged: new Decimal(50),
        costCny: new Decimal(5),
        breakdown: [],
        balanceAfter: new Decimal(950),
      })

      const res = await service.deductCustom(1, 5)

      expect(teamQuota.deductWithQuota).toHaveBeenCalledTimes(1)
      expect(credit.consume).not.toHaveBeenCalled()
      expect(res.balance.toString()).toBe("950")
      expect(prisma.usageLog.create).not.toHaveBeenCalled()
    })

    it("视频预检：个人+池合计充足放行（池不足但个人够也放行）；合计不足抛「积分余额不足」", async () => {
      joinTeam()
      const dto = { mode: "NORMAL", model: "video-lite", durationSec: 5 } as const
      // 0.75 × 5s × 2倍 = 7.5 元 → 75 积分
      credit.teamPoolBalance.mockResolvedValue(new Decimal(100))
      credit.getConsumableBalance.mockResolvedValue(new Decimal(0))
      await expect(service.assertVideoAffordable(1, { ...dto })).resolves.toBeUndefined()
      expect(credit.assertAffordable).not.toHaveBeenCalled()

      // 池 10 < 75，但个人 500 兜底 → 放行（与 consumeRouted 个人充值段同口径）
      credit.teamPoolBalance.mockResolvedValue(new Decimal(10))
      credit.getConsumableBalance.mockResolvedValue(new Decimal(500))
      await expect(service.assertVideoAffordable(1, { ...dto })).resolves.toBeUndefined()

      // 池 10 + 个人 20 < 75 → 拦截
      credit.getConsumableBalance.mockResolvedValue(new Decimal(20))
      await expect(service.assertVideoAffordable(1, { ...dto })).rejects.toThrow("积分余额不足")
    })

    it("无企业归属：保持个人路径（consume + 个人预检）", async () => {
      pricing.getTokenPriceTier.mockResolvedValue({
        tier: PricingTier.LOW,
        inputPriceCny: new Decimal(9),
        outputPriceCny: new Decimal(54),
      })

      await service.chargeTokens(1, { promptTokens: 100000, completionTokens: 50000 })

      expect(credit.consume).toHaveBeenCalledTimes(1)
      expect(teamQuota.deductWithQuota).not.toHaveBeenCalled()
    })
  })

  describe("混合扣费（企业成员：个人赠送 → 企业池 → 个人充值）", () => {
    const joinTeam = (teamId = 7) => {
      prisma.teamMember.findFirst.mockResolvedValue(memberCtx(teamId))
      prisma.user.findUnique.mockResolvedValue({ discount: new Decimal("1") })
    }
    const personalBalances = (giftLayer: number, recharge: number) => ({
      giftLayer: new Decimal(giftLayer),
      recharge: new Decimal(recharge),
      total: new Decimal(giftLayer + recharge),
    })
    // deductCustom(1, 5)：5 元 × 10 = 50 积分（折扣 1）
    const deductOptsOf = (mock: jest.Mock) =>
      mock.mock.calls[0] as unknown as [number, Decimal, Decimal, Record<string, unknown>, unknown]

    it("个人赠送层不足 → 先烧赠送再扣企业池，混合事件盖章（双归属拆分+双剩余）", async () => {
      joinTeam()
      credit.lockPersonalBalancesInTx.mockResolvedValue(personalBalances(20, 100))
      credit.lockTeamPoolBalanceInTx.mockResolvedValue(new Decimal(1000))
      teamQuota.deductWithQuota.mockResolvedValue({
        creditsCharged: new Decimal(30),
        costCny: new Decimal(3),
        breakdown: [{ bucket: "PACKAGE", amount: "30" }],
        balanceAfter: new Decimal(970),
      })

      await service.deductCustom(1, 5, { source: "listing.generate" })

      // 第①段：个人赠送层 20（桶域=赠送层，跳过邀请人共享）
      expect(credit.consumeCredits).toHaveBeenCalledTimes(1)
      const giftArgs = deductOptsOf(credit.consumeCredits)
      expect(giftArgs[0]).toBe(1)
      expect(giftArgs[1].toString()).toBe("20")
      expect(giftArgs[2].toString()).toBe("2") // 5 × 20/50
      expect(giftArgs[3].bucketScope).toEqual(["PACKAGE", "GIFT"])
      expect(giftArgs[3].skipInviterShare).toBe(true)
      // 第②段：企业池 30（人民币按积分占比切分）
      expect(teamQuota.deductWithQuota).toHaveBeenCalledTimes(1)
      const teamArgs = teamQuota.deductWithQuota.mock.calls[0] as unknown as [
        number,
        number,
        Decimal,
        Decimal,
        { meta?: Record<string, unknown> },
        unknown,
      ]
      expect(teamArgs[2].toString()).toBe("30")
      expect(teamArgs[3].toString()).toBe("3")
      // 两段同章：consumeEventId 一致 + ownershipSplit 快照（个人 20/企业 30；个人剩 100、池剩 970）
      const giftMeta = giftArgs[3].meta as Record<string, unknown>
      const teamMeta = teamArgs[4].meta as Record<string, unknown>
      expect(typeof giftMeta.consumeEventId).toBe("string")
      expect(teamMeta.consumeEventId).toBe(giftMeta.consumeEventId)
      expect(teamMeta.ownershipSplit).toEqual({
        personal: "20",
        team: "30",
        personalBalanceAfter: "100",
        teamBalanceAfter: "970",
      })
      expect(giftMeta.ownershipSplit).toEqual(teamMeta.ownershipSplit)
    })

    it("企业池不足 → 个人充值兜底（RECHARGE 桶域 + 透支标记透传）", async () => {
      joinTeam()
      credit.lockPersonalBalancesInTx.mockResolvedValue(personalBalances(0, 500))
      credit.lockTeamPoolBalanceInTx.mockResolvedValue(new Decimal(30))

      await service.deductCustom(1, 5, { source: "listing.generate" })

      expect(teamQuota.deductWithQuota).toHaveBeenCalledTimes(1)
      const calls = credit.consumeCredits.mock.calls as unknown as Array<
        [number, Decimal, Decimal, Record<string, unknown>, unknown]
      >
      expect(calls).toHaveLength(1)
      expect(calls[0][1].toString()).toBe("20") // 充值段兜底 50-30
      expect(calls[0][3].bucketScope).toEqual(["RECHARGE"])
      expect(calls[0][3].skipInviterShare).toBe(true)
      const split = (calls[0][3].meta as Record<string, unknown>).ownershipSplit
      expect(split).toEqual({
        personal: "20",
        team: "30",
        personalBalanceAfter: "480",
        teamBalanceAfter: "0",
      })
    })

    it("企业池为 0 → 全部走个人充值（不动配额、不盖章）", async () => {
      joinTeam()
      credit.lockPersonalBalancesInTx.mockResolvedValue(personalBalances(0, 500))
      credit.lockTeamPoolBalanceInTx.mockResolvedValue(new Decimal(0))

      await service.deductCustom(1, 5, { source: "listing.generate" })

      expect(teamQuota.deductWithQuota).not.toHaveBeenCalled()
      const args = deductOptsOf(credit.consumeCredits)
      expect(args[1].toString()).toBe("50")
      expect(args[3].bucketScope).toEqual(["RECHARGE"])
      expect((args[3].meta as Record<string, unknown>)?.consumeEventId).toBeUndefined()
    })

    it("个人赠送层充足 → 全部走个人赠送（不锁企业池、不盖章）", async () => {
      joinTeam()
      credit.lockPersonalBalancesInTx.mockResolvedValue(personalBalances(100, 500))

      await service.deductCustom(1, 5, { source: "listing.generate" })

      expect(credit.lockTeamPoolBalanceInTx).not.toHaveBeenCalled()
      expect(teamQuota.deductWithQuota).not.toHaveBeenCalled()
      const args = deductOptsOf(credit.consumeCredits)
      expect(args[1].toString()).toBe("50")
      expect(args[3].bucketScope).toEqual(["PACKAGE", "GIFT"])
      expect((args[3].meta as Record<string, unknown>)?.consumeEventId).toBeUndefined()
    })

    it("SHARED+BLOCK：企业段按配额剩余封顶，超出落个人充值段（阻止企业不阻止个人）", async () => {
      // 配额 10 已用 9 → 企业段只扣 1，其余 49 落个人充值
      joinTeam()
      prisma.teamMember.findFirst.mockResolvedValue(
        memberCtx(7, {
          monthlyQuota: 10,
          quotaUsedThisMonth: new Decimal(9),
          quotaMonth: quotaMonthOf(), // 当月
          team: { quotaMode: "SHARED", overLimitPolicy: "BLOCK", discount: new Decimal(1) },
        })
      )
      credit.lockPersonalBalancesInTx.mockResolvedValue(personalBalances(0, 500))
      credit.lockTeamPoolBalanceInTx.mockResolvedValue(new Decimal(1000))

      await service.deductCustom(1, 5, { source: "listing.generate" })

      const teamArgs = teamQuota.deductWithQuota.mock.calls[0] as unknown as [
        number,
        number,
        Decimal,
        Decimal,
        unknown,
        unknown,
      ]
      expect(teamArgs[2].toString()).toBe("1") // 企业段 = 配额剩余 1（不是全额 50）
      const calls = credit.consumeCredits.mock.calls as unknown as Array<
        [number, Decimal, Decimal, Record<string, unknown>, unknown]
      >
      expect(calls).toHaveLength(1)
      expect(calls[0][1].toString()).toBe("49") // 超出配额部分落个人充值
      expect(calls[0][3].bucketScope).toEqual(["RECHARGE"])
    })

    it("SHARED+BLOCK 配额为 0 → 全部走个人充值（不再 400 已达上限）", async () => {
      joinTeam()
      prisma.teamMember.findFirst.mockResolvedValue(
        memberCtx(7, {
          monthlyQuota: 10,
          quotaUsedThisMonth: new Decimal(10),
          quotaMonth: quotaMonthOf(), // 当月
          team: { quotaMode: "SHARED", overLimitPolicy: "BLOCK", discount: new Decimal(1) },
        })
      )
      credit.lockPersonalBalancesInTx.mockResolvedValue(personalBalances(0, 500))

      await service.deductCustom(1, 5, { source: "listing.generate" })

      expect(teamQuota.deductWithQuota).not.toHaveBeenCalled()
      const args = deductOptsOf(credit.consumeCredits)
      expect(args[1].toString()).toBe("50")
      expect(args[3].bucketScope).toEqual(["RECHARGE"])
    })

    it("SHARED+BLOCK 跨月：上月已用不计，企业段按全配额封顶", async () => {
      joinTeam()
      prisma.teamMember.findFirst.mockResolvedValue(
        memberCtx(7, {
          monthlyQuota: 10,
          quotaUsedThisMonth: new Decimal(999),
          quotaMonth: "2026-07", // 上月 → 懒重置口径视为 0 已用
          team: { quotaMode: "SHARED", overLimitPolicy: "BLOCK", discount: new Decimal(1) },
        })
      )
      credit.lockPersonalBalancesInTx.mockResolvedValue(personalBalances(0, 500))
      credit.lockTeamPoolBalanceInTx.mockResolvedValue(new Decimal(1000))

      await service.deductCustom(1, 5, { source: "listing.generate" })

      const teamArgs = teamQuota.deductWithQuota.mock.calls[0] as unknown as [
        number,
        number,
        Decimal,
        Decimal,
        unknown,
        unknown,
      ]
      expect(teamArgs[2].toString()).toBe("10") // 封顶 = 全配额 10
      const calls = credit.consumeCredits.mock.calls as unknown as Array<
        [number, Decimal, Decimal, Record<string, unknown>, unknown]
      >
      expect(calls[0][1].toString()).toBe("40")
    })
  })

  describe("chargeMcp", () => {
    it("100 次 × 0.12375 = 12.375 元", async () => {
      pricing.getMcpCallPrice.mockResolvedValue(new Decimal("0.12375"))
      credit.consume.mockResolvedValue({
        creditsCharged: new Decimal("123.75"),
        costCny: new Decimal(0),
        breakdown: [],
        balanceAfter: new Decimal("500"),
      })

      const result = await service.chargeMcp(1, { calls: 100 })

      expect(result.costCny.toString()).toBe("12.375")
      expect(result.balance.toString()).toBe("500")
    })

    it("UsageLog 记录 MCP type 和 calls 字段", async () => {
      pricing.getMcpCallPrice.mockResolvedValue(new Decimal("0.12375"))
      credit.consume.mockResolvedValue({
        creditsCharged: new Decimal("1.2375"),
        costCny: new Decimal(0),
        breakdown: [],
        balanceAfter: new Decimal("999"),
      })

      await service.chargeMcp(1, { calls: 1, source: "mcp.context7" })

      const calls = prisma.usageLog.create.mock.calls as unknown as Array<
        [{ data: Record<string, unknown> }]
      >
      expect(calls).toHaveLength(1)
      expect(calls[0][0].data).toMatchObject({
        userId: 1,
        type: UsageType.MCP,
        mcpCalls: 1,
        promptTokens: null,
        completionTokens: null,
        source: "mcp.context7",
      })
    })
  })

  describe("chargeMcpInTransaction", () => {
    const input = {
      calls: 3,
      source: "category.analysis",
      requestId: "category:1:0:data",
      meta: { businessEventId: "analysis-1", callDetail: { sif: 2, keepa: 1 } },
    }
    it("沿用竞品 MCP 单价与个人扣费路由，流水记录调用次数和幂等编号", async () => {
      pricing.getMcpCallPrice.mockResolvedValue(new Decimal("0.12375"))
      const result = await service.chargeMcpInTransaction(
        prisma as unknown as Prisma.TransactionClient,
        1,
        input
      )
      expect(result.costCny.toString()).toBe("0.37125")
      expect(result.duplicate).toBe(false)
      expect(credit.consume).toHaveBeenCalledWith(
        1,
        new Decimal("0.37125"),
        expect.objectContaining({ source: "category.analysis" }),
        prisma
      )
      const logCalls = prisma.usageLog.create.mock.calls as unknown as Array<
        [{ data: Record<string, unknown> }]
      >
      expect(logCalls).toHaveLength(1)
      expect(logCalls[0][0].data).toMatchObject({
        type: UsageType.MCP,
        mcpCalls: 3,
        requestId: input.requestId,
        cost: new Decimal("0.37125"),
        meta: {
          usageKind: "mcp",
          businessEventId: "analysis-1",
          callDetail: { sif: 2, keepa: 1 },
          mcpUnitPriceCny: "0.12375",
        },
      })
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })
    it("开放接口锁定预检单价并透传API流水类型，不受后续调价影响", async () => {
      pricing.getMcpCallPrice.mockResolvedValue(new Decimal("9"))
      await service.chargeMcpInTransaction(
        prisma as unknown as Prisma.TransactionClient,
        1,
        input,
        { invokeType: InvokeType.API, unitPriceCny: new Decimal("0.12375") }
      )
      expect(pricing.getMcpCallPrice).not.toHaveBeenCalled()
      expect(credit.consume).toHaveBeenCalledWith(
        1,
        new Decimal("0.37125"),
        expect.objectContaining({ invokeType: InvokeType.API }),
        prisma
      )
    })
    it.each(["0", "-1", "NaN", "Infinity"])("非法锁定单价 %s 不扣费", async price => {
      await expect(
        service.chargeMcpInTransaction(prisma as unknown as Prisma.TransactionClient, 1, input, {
          unitPriceCny: new Decimal(price),
        })
      ).rejects.toThrow("单价必须大于0")
      expect(credit.consume).not.toHaveBeenCalled()
    })
    it("命中相同流水时不再计价、扣减或写日志", async () => {
      prisma.usageLog.findUnique.mockResolvedValue({
        userId: 1,
        source: input.source,
        type: UsageType.MCP,
        cost: new Decimal(1),
        credits: new Decimal(10),
        balanceAfter: new Decimal(90),
      })
      const result = await service.chargeMcpInTransaction(
        prisma as unknown as Prisma.TransactionClient,
        1,
        input
      )
      expect(result.duplicate).toBe(true)
      expect(result.creditsCharged.toString()).toBe("10")
      expect(pricing.getMcpCallPrice).not.toHaveBeenCalled()
      expect(credit.consume).not.toHaveBeenCalled()
      expect(prisma.usageLog.create).not.toHaveBeenCalled()
    })
    it("跨用户幂等键拒绝复用", async () => {
      prisma.usageLog.findUnique.mockResolvedValue({
        userId: 2,
        source: input.source,
        type: UsageType.MCP,
      })
      await expect(
        service.chargeMcpInTransaction(prisma as unknown as Prisma.TransactionClient, 1, input)
      ).rejects.toThrow("已被占用")
      expect(credit.consume).not.toHaveBeenCalled()
    })
    it("日志唯一键冲突向外抛出供外层事务回滚，不吞异常", async () => {
      pricing.getMcpCallPrice.mockResolvedValue(new Decimal("0.1"))
      const error = new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      })
      prisma.usageLog.create.mockRejectedValue(error)
      await expect(
        service.chargeMcpInTransaction(prisma as unknown as Prisma.TransactionClient, 1, input)
      ).rejects.toBe(error)
    })
    it.each([0, -1, 1.5, NaN])("非法次数 %s 不扣费", async calls => {
      await expect(
        service.chargeMcpInTransaction(prisma as unknown as Prisma.TransactionClient, 1, {
          ...input,
          calls,
        })
      ).rejects.toThrow("正整数")
      expect(credit.consume).not.toHaveBeenCalled()
    })
  })

  describe("deductCustom（公共扣款：人民币 → 复用 consume）", () => {
    it("按人民币金额委托 CreditService.consume（换算/折扣均在 consume 内），不写 UsageLog", async () => {
      credit.consume.mockResolvedValue({
        creditsCharged: new Decimal("800"),
        costCny: new Decimal("100"),
        breakdown: [{ bucket: "RECHARGE", amount: "800" }],
        balanceAfter: new Decimal("1200"),
      })

      const result = await service.deductCustom(1, 100, {
        source: "feature.export",
        meta: { o: 1 },
      })

      const consumeCalls = credit.consume.mock.calls as unknown as Array<
        [number, Decimal, { source?: string; meta?: unknown; allowOverdraft?: boolean }]
      >
      expect(consumeCalls[0][0]).toBe(1)
      expect(consumeCalls[0][1].toString()).toBe("100")
      expect(consumeCalls[0][2]).toMatchObject({ source: "feature.export", meta: { o: 1 } })
      // 返回 ChargeResult 形（balance 取自 consume 的 balanceAfter）
      expect(result.creditsCharged.toString()).toBe("800")
      expect(result.balance.toString()).toBe("1200")
      // 公共扣款不写 UsageLog（仅靠 consume 写积分流水）
      expect(prisma.usageLog.create).not.toHaveBeenCalled()
    })

    it("缺省来源为 manual.deduct", async () => {
      await service.deductCustom(1, 5)
      const consumeCalls = credit.consume.mock.calls as unknown as Array<
        [number, Decimal, { source?: string }]
      >
      expect(consumeCalls[0][2].source).toBe("manual.deduct")
    })

    it("金额 <= 0 抛 BadRequest，不调用 consume", async () => {
      await expect(service.deductCustom(1, 0)).rejects.toBeInstanceOf(BadRequestException)
      expect(credit.consume).not.toHaveBeenCalled()
    })
  })

  describe("chargeModel（公共扣费 v2：底座计费，双写 UsageLog + 注册表校验 + 幂等）", () => {
    const params = { source: "listing.generate", model: "gemini-2.5-flash" }

    it("正常扣费：走个人 consume 路由，写 UsageLog（meta 带 model/module），返回注册表标签", async () => {
      credit.consume.mockResolvedValue({
        creditsCharged: new Decimal("4"),
        costCny: new Decimal("0.35"),
        breakdown: [{ bucket: "GIFT", amount: "4" }],
        balanceAfter: new Decimal("196"),
      })

      const res = await service.chargeModel(1, 0.35, { ...params, requestId: "r1" })

      // 幂等预查 + 扣费 + 写日志
      expect(prisma.usageLog.findUnique).toHaveBeenCalledWith({
        where: { requestId: "r1" },
        select: { cost: true, credits: true, balanceAfter: true },
      })
      expect(credit.consume).toHaveBeenCalled()
      const logCall = prisma.usageLog.create.mock.calls[0] as [
        { data: { userId: number; source: string; requestId: string; meta: unknown } },
      ]
      expect(logCall[0].data.userId).toBe(1)
      expect(logCall[0].data.source).toBe("listing.generate")
      expect(logCall[0].data.requestId).toBe("r1")
      expect(logCall[0].data.meta).toMatchObject({ model: "gemini-2.5-flash", module: "listing" })
      expect(res).toMatchObject({
        source: "listing.generate",
        sourceLabel: "Listing 生成",
        module: "listing",
        moduleLabel: "Listing",
        model: "gemini-2.5-flash",
        requestId: "r1",
        duplicate: false,
      })
      expect(res.creditsCharged.toString()).toBe("4")
      expect(res.balance.toString()).toBe("196")
    })

    it("source 未登记注册表 → 400，不扣费", async () => {
      await expect(service.chargeModel(1, 1, { source: "unknown.x", model: "m" })).rejects.toThrow(
        "功能来源未登记"
      )
      expect(credit.consume).not.toHaveBeenCalled()
      expect(prisma.usageLog.create).not.toHaveBeenCalled()
    })

    it("model 为空 → 400，不扣费", async () => {
      await expect(
        service.chargeModel(1, 1, { source: "listing.generate", model: "  " })
      ).rejects.toThrow("模型标识不能为空")
      expect(credit.consume).not.toHaveBeenCalled()
    })

    it("requestId 命中历史行 → duplicate=true 返回首次结果，不重复扣费", async () => {
      prisma.usageLog.findUnique.mockResolvedValue({
        cost: new Decimal("0.35"),
        credits: new Decimal("4"),
        balanceAfter: new Decimal("196"),
      })

      const res = await service.chargeModel(1, 0.35, { ...params, requestId: "r1" })

      expect(res.duplicate).toBe(true)
      expect(res.creditsCharged.toString()).toBe("4")
      expect(res.balance.toString()).toBe("196")
      expect(credit.consume).not.toHaveBeenCalled()
      expect(prisma.usageLog.create).not.toHaveBeenCalled()
    })

    it("并发撞 requestId 唯一索引（P2002）→ 事务回滚（不重复扣费），事务外重查返回首次结果", async () => {
      prisma.usageLog.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002" } as never)
      )
      prisma.usageLog.findUnique
        .mockResolvedValueOnce(null) // 事务内预查未命中
        .mockResolvedValueOnce({
          cost: new Decimal("0.35"),
          credits: new Decimal("4"),
          balanceAfter: new Decimal("196"),
        }) // P2002 后（事务外）重查命中

      const res = await service.chargeModel(1, 0.35, { ...params, requestId: "r1" })

      expect(res.duplicate).toBe(true)
      expect(res.creditsCharged.toString()).toBe("4")
      // 注意：mock 事务不模拟回滚，consume 在 mock 下仍被调用；真实 Prisma 中 P2002 抛出即整事务回滚，
      // 扣减不生效——本用例断言的是「返回首次结果且不二次入账 UsageLog」
      expect(prisma.usageLog.create).toHaveBeenCalledTimes(1)
    })

    it("P2002 撞库但重查仍无记录（对方也回滚的极端竞态）→ 原样抛错，不假装成功", async () => {
      prisma.usageLog.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002" } as never)
      )
      prisma.usageLog.findUnique.mockResolvedValue(null) // 预查与重查都未命中

      await expect(service.chargeModel(1, 0.35, { ...params, requestId: "r1" })).rejects.toThrow(
        "unique"
      )
    })

    it("归属 active 企业 → 团队共享池扣费（deductWithQuota），UsageLog 仍写", async () => {
      prisma.teamMember.findFirst.mockResolvedValue(memberCtx(9))
      prisma.user.findUnique.mockResolvedValue({ discount: new Decimal(1) })
      teamQuota.deductWithQuota.mockResolvedValue({
        creditsCharged: new Decimal("10"),
        costCny: new Decimal("1"),
        breakdown: [],
        balanceAfter: new Decimal("990"),
      })

      const res = await service.chargeModel(2, 1, params)

      expect(teamQuota.deductWithQuota).toHaveBeenCalled()
      expect(credit.consume).not.toHaveBeenCalled()
      expect(prisma.usageLog.create).toHaveBeenCalled()
      expect(res.balance.toString()).toBe("990")
    })
  })

  describe("chargeModel exactCredits（图片固定一口价：精确积分、不打折）", () => {
    const params = { source: "listing.generate", model: "ZQ-Image-1-Backup" }

    it("exactCredits 模式：consumeCredits 按给定积分直扣（不走折扣换算），UsageLog.cost 记名义售价", async () => {
      credit.consumeCredits.mockResolvedValue({
        creditsCharged: new Decimal("15"),
        costCny: new Decimal("1.5"),
        breakdown: [{ bucket: "RECHARGE", amount: "15" }],
        balanceAfter: new Decimal("85"),
      })

      const res = await service.chargeModel(1, 1.5, { ...params, exactCredits: 15 })

      expect(credit.consume).not.toHaveBeenCalled()
      expect(credit.consumeCredits).toHaveBeenCalled()
      const call = credit.consumeCredits.mock.calls[0] as [number, Decimal, Decimal]
      expect(call[1].toString()).toBe("15") // 精确积分 = 15，未经 userRate 换算
      expect(call[2].toString()).toBe("1.5") // cost 仍是名义售价
      const logCall = prisma.usageLog.create.mock.calls[0] as [
        { data: { userId: number; cost: Decimal; source: string; meta: unknown } },
      ]
      expect(logCall[0].data.cost.toString()).toBe("1.5")
      expect(logCall[0].data.meta).toMatchObject({
        model: "ZQ-Image-1-Backup",
        module: "listing",
      })
      expect(res.creditsCharged.toString()).toBe("15")
    })

    it("exactCredits 与 creditMultiplier 同时传 → 400", async () => {
      await expect(
        service.chargeModel(1, 1, {
          ...params,
          exactCredits: 10,
          creditMultiplier: 2,
        })
      ).rejects.toThrow("不能同时使用")
      expect(credit.consumeCredits).not.toHaveBeenCalled()
    })

    it("exactCredits 非正数 → 400，不扣费", async () => {
      await expect(service.chargeModel(1, 1, { ...params, exactCredits: 0 })).rejects.toThrow(
        "精确扣费积分必须大于 0"
      )
      expect(credit.consumeCredits).not.toHaveBeenCalled()
    })
  })

  describe("gatewayFixedVideoCreditsPerSec（视频固定一口价：积分/秒，按 mode×分辨率分档）", () => {
    it("按 (publicId, category) 读全部行，键=mode|分辨率各自小写归一，0/负值档跳过", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([
        { mode: "", resolution: "480P", creditsPerSec: new Decimal(15) },
        { mode: "reference_to_video", resolution: "720p-SR", creditsPerSec: new Decimal(20) },
        { mode: "", resolution: "720p", creditsPerSec: new Decimal(0) }, // 误配 0：跳过该档
        { mode: "", resolution: "1080p", creditsPerSec: null }, // 仅预估成本，不启用一口价
        { mode: "", resolution: "", creditsPerSec: new Decimal(5) }, // 空键：跳过
      ])

      const map = await service.gatewayFixedVideoCreditsPerSec("sourcing-veo-fast", "NORMAL")

      expect(prisma.aiGatewayVideoFixedPrice.findMany).toHaveBeenCalledWith({
        where: { publicId: "sourcing-veo-fast", category: "NORMAL" },
        select: { mode: true, resolution: true, creditsPerSec: true },
      })
      expect(map).not.toBeNull()
      expect([...map!.entries()].map(([k, v]) => [k, v.toString()])).toEqual([
        ["|480p", "15"],
        ["reference_to_video|720p-sr", "20"],
      ])
    })

    it("无行返回 null（调用方回落按量）", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([])

      await expect(
        service.gatewayFixedVideoCreditsPerSec("sourcing-veo-fast", "NORMAL")
      ).resolves.toBeNull()
    })

    it("仅有成本配置且一口价为空时，实际扣费仍回落按量", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([
        { mode: "", resolution: "480p", creditsPerSec: null },
      ])
      await expect(
        service.gatewayFixedVideoCreditsPerSec("sourcing-test-video", "NORMAL")
      ).resolves.toBeNull()
    })

    it("resolveFixedVideoCreditsPerSec 单档便捷读取：先精确 mode 行，未命中退通配行", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([
        { mode: "", resolution: "1080p", creditsPerSec: new Decimal(20) },
        { mode: "video_to_video", resolution: "1080p", creditsPerSec: new Decimal(25) },
      ])

      await expect(
        service.resolveFixedVideoCreditsPerSec("sourcing-veo-fast", "NORMAL", " 1080P ")
      ).resolves.toEqual(new Decimal(20)) // 不带 mode → 通配行
      await expect(
        service.resolveFixedVideoCreditsPerSec(
          "sourcing-veo-fast",
          "NORMAL",
          "1080p",
          "video_to_video"
        )
      ).resolves.toEqual(new Decimal(25)) // 精确 mode 行优先
      await expect(
        service.resolveFixedVideoCreditsPerSec("sourcing-veo-fast", "NORMAL", "1080p", "other")
      ).resolves.toEqual(new Decimal(20)) // mode 未命中退通配
      await expect(
        service.resolveFixedVideoCreditsPerSec("sourcing-veo-fast", "NORMAL", "480p")
      ).resolves.toBeNull() // 缺档
      await expect(
        service.resolveFixedVideoCreditsPerSec("sourcing-veo-fast", "NORMAL", null)
      ).resolves.toBeNull() // 自动分辨率
    })

    it("resolveFixedVideoCreditsPerSec 仅配精确 mode 行时，不带 mode 的请求不命中（回落按量）", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([
        { mode: "video_to_video", resolution: "720p", creditsPerSec: new Decimal(25) },
      ])

      await expect(
        service.resolveFixedVideoCreditsPerSec("sourcing-veo-fast", "NORMAL", "720p")
      ).resolves.toBeNull()
      await expect(
        service.resolveFixedVideoCreditsPerSec(
          "sourcing-veo-fast",
          "NORMAL",
          "720p",
          "VIDEO_TO_VIDEO"
        )
      ).resolves.toEqual(new Decimal(25)) // 大小写归一
    })

    it("resolveFixedVideoTier 无分辨率（自适应模型）兜底 adaptive 保留档，标记按次一口价", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([
        { mode: "", resolution: "adaptive", creditsPerSec: new Decimal(150) },
      ])

      await expect(
        service.resolveFixedVideoTier("sourcing-kling-o3-video-edit", "REFERENCE", null)
      ).resolves.toEqual({ creditsPerSec: new Decimal(150), flat: true })
      await expect(
        service.resolveFixedVideoCreditsPerSec("sourcing-kling-o3-video-edit", "REFERENCE", null)
      ).resolves.toEqual(new Decimal(150))
      // 有分辨率但缺档 → 回落按量，不退 adaptive（adaptive 是无分辨率模型专用兜底档）
      await expect(
        service.resolveFixedVideoTier("sourcing-kling-o3-video-edit", "REFERENCE", "720p")
      ).resolves.toBeNull()
    })

    it("resolveFixedVideoTier 带分辨率未命中精确档时兜底 flat 按次档；精确档优先", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([
        { mode: "motion_control", resolution: "flat", creditsPerSec: new Decimal(100) },
      ])

      // 动作复刻场景：带 720p/1080p 分辨率但只配了按次档 → 按次一口价，不分分辨率
      await expect(
        service.resolveFixedVideoTier(
          "sourcing-kling-v2-6-motion-control",
          "MOTION_CONTROL",
          "1080p",
          "motion_control"
        )
      ).resolves.toEqual({ creditsPerSec: new Decimal(100), flat: true })
      await expect(
        service.resolveFixedVideoTier(
          "sourcing-kling-v2-6-motion-control",
          "MOTION_CONTROL",
          "720p",
          "motion_control"
        )
      ).resolves.toEqual({ creditsPerSec: new Decimal(100), flat: true })
      // 仅配精确 mode 的 flat 行：mode 不匹配且无通配行 → 回落按量（与精确档同语义）
      await expect(
        service.resolveFixedVideoTier(
          "sourcing-kling-v2-6-motion-control",
          "MOTION_CONTROL",
          "1080p",
          "other_mode"
        )
      ).resolves.toBeNull()
    })

    it("resolveFixedVideoTier 精确分辨率档优先于 flat 按次档", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([
        { mode: "", resolution: "flat", creditsPerSec: new Decimal(100) },
        { mode: "", resolution: "1080p", creditsPerSec: new Decimal(12) },
      ])

      await expect(
        service.resolveFixedVideoTier("sourcing-veo-fast", "NORMAL", "1080p")
      ).resolves.toEqual({ creditsPerSec: new Decimal(12), flat: false })
      await expect(
        service.resolveFixedVideoTier("sourcing-veo-fast", "NORMAL", "720p")
      ).resolves.toEqual({ creditsPerSec: new Decimal(100), flat: true })
    })
  })

  describe("chargeExactCreditsInTransaction（精确积分扣费）", () => {
    it("保留小数积分并写 UsageLog", async () => {
      credit.consumeCredits.mockResolvedValue({
        creditsCharged: new Decimal("9.6"),
        costCny: new Decimal("0.96"),
        breakdown: [{ bucket: "RECHARGE", amount: "9.6" }],
        balanceAfter: new Decimal("90.4"),
      })

      const result = await service.chargeExactCreditsInTransaction(prisma as never, 1, {
        credits: "9.6",
        costCny: "0.96",
        source: "rpa-creation.generate",
        allowOverdraft: true,
        meta: { taskId: 7 },
      })

      expect(credit.consumeCredits).toHaveBeenCalledWith(
        1,
        expect.objectContaining({}),
        expect.objectContaining({}),
        {
          source: "rpa-creation.generate",
          meta: { taskId: 7 },
          allowOverdraft: true,
        },
        prisma
      )
      const call = credit.consumeCredits.mock.calls[0] as [number, Decimal, Decimal]
      expect(call[1].toString()).toBe("9.6")
      expect(call[2].toString()).toBe("0.96")
      const logCall = prisma.usageLog.create.mock.calls[0] as [
        { data: { userId: number; credits: Decimal; cost: Decimal; source: string } },
      ]
      expect(logCall[0].data.userId).toBe(1)
      expect(logCall[0].data.credits.toString()).toBe("9.6")
      expect(logCall[0].data.cost.toString()).toBe("0.96")
      expect(logCall[0].data.source).toBe("rpa-creation.generate")
      expect(result.creditsCharged.toString()).toBe("9.6")
    })
  })

  describe("getBalance", () => {
    it("委托 CreditService.getWallet 返回积分钱包", async () => {
      const wallet = {
        level: "LV2",
        buckets: {
          recharge: new Decimal(50),
          package: new Decimal(30),
          gift: new Decimal(0),
          rebate: new Decimal(0),
        },
        total: new Decimal(80),
        monthUsed: new Decimal(10),
        totalConsumed: new Decimal(200),
        nextExpireAt: null,
      }
      credit.getWallet.mockResolvedValue(wallet)

      const result = await service.getBalance(1)

      expect(credit.getWallet).toHaveBeenCalledWith(1)
      expect(result).toBe(wallet)
    })
  })

  describe("getSourceOptions", () => {
    it("首项为「全部」(空 value)，并含已知来源的完整 source + 中文名", () => {
      const opts = service.getSourceOptions()
      expect(opts[0]).toEqual({ value: "", label: "全部" })
      expect(opts).toContainEqual({ value: "llm.generic", label: "通用 LLM" })
      expect(opts).toContainEqual({ value: "aicreative.image_generate", label: "图片生成" })
      // 后台手动调额来源也要返回（功能模块可筛/可显示）
      expect(opts).toContainEqual({ value: "admin.recharge.manual", label: "手动调整" })
      expect(opts).toContainEqual({ value: "invite.switch", label: "套餐/赠送积分清零" })
      expect(opts).toContainEqual({ value: "system.expire", label: "系统回收" })
      // value 全是完整 source（除首项「全部」外不含空串）
      expect(opts.slice(1).every(o => o.value.length > 0)).toBe(true)
    })
  })

  describe("listLogs", () => {
    it("分页查询 + 按 type 过滤", async () => {
      prisma.usageLog.findMany.mockResolvedValue([])
      prisma.usageLog.count.mockResolvedValue(25)

      const result = await service.listLogs(1, { page: 2, pageSize: 10, type: UsageType.TOKEN })

      expect(result.totalPages).toBe(3)
      expect(prisma.usageLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 1, type: UsageType.TOKEN },
          skip: 10,
          take: 10,
        })
      )
    })
  })

  describe("statsByUser", () => {
    it("聚合用户：剩余=积分余额 / 已消耗积分 / tokens，按已消耗 DESC", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 1,
          username: "alice",
          phone: "18000000001",
          canInvite: false,
          invitedById: null,
          subscriptionTier: 2,
        },
        {
          id: 2,
          username: "bob",
          phone: "18000000002",
          canInvite: true,
          invitedById: null,
          subscriptionTier: null,
        },
      ])
      prisma.usageLog.groupBy.mockResolvedValue([
        {
          userId: 2,
          _sum: {
            credits: new Decimal("321"),
            promptTokens: 30000,
            completionTokens: 8000,
            thinkingTokens: 0,
          },
        },
        {
          userId: 1,
          _sum: {
            credits: new Decimal("1234.56"),
            promptTokens: 100000,
            completionTokens: 20000,
            thinkingTokens: 5000,
          },
        },
      ])
      prisma.creditLot.groupBy.mockResolvedValue([
        { userId: 1, _sum: { remaining: new Decimal("7076") } },
        { userId: 2, _sum: { remaining: new Decimal("500") } },
      ])

      const result = await service.statsByUser({ period: StatsPeriod.ALL })

      expect(result).toEqual([
        {
          userId: 1,
          username: "alice",
          phone: "18000000001",
          level: "LV2",
          totalQuota: "8310.56",
          remaining: "7076",
          totalConsumed: "1234.56",
          totalTokens: 125000,
          roles: [],
          permissions: [],
        },
        {
          userId: 2,
          username: "bob",
          phone: "18000000002",
          level: "NONE",
          totalQuota: "821",
          remaining: "500",
          totalConsumed: "321",
          totalTokens: 38000,
          roles: [],
          permissions: [],
        },
      ])
    })

    it("返回用户多角色 + 菜单权限并集（按 sortOrder 升序）", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 1,
          username: "alice",
          phone: "18000000001",
          balance: new Decimal("720"),
          totalSpent: new Decimal("0"),
          roles: [
            {
              role: {
                code: "ADMIN",
                name: "管理员",
                color: "#ff3b30",
                permissions: [
                  {
                    permission: {
                      key: "tool.listing_generate",
                      label: "Listing 生成",
                      groupCode: "tools",
                      parentKey: null,
                      route: "/listing",
                      subRoutes: null,
                      sortOrder: 1,
                    },
                  },
                  {
                    permission: {
                      key: "company.admin",
                      label: "后台管理",
                      groupCode: "company",
                      parentKey: null,
                      route: null,
                      subRoutes: ["/admin/x"],
                      sortOrder: 91,
                    },
                  },
                ],
              },
            },
          ],
        },
      ])
      prisma.usageLog.groupBy.mockResolvedValue([])

      const result = await service.statsByUser({ period: StatsPeriod.ALL })

      expect(result[0].roles).toEqual([{ code: "ADMIN", name: "管理员", color: "#ff3b30" }])
      expect(result[0].permissions).toEqual([
        {
          key: "tool.listing_generate",
          label: "Listing 生成",
          groupCode: "tools",
          parentKey: null,
          route: "/listing",
          subRoutes: null,
          sortOrder: 1,
        },
        {
          key: "company.admin",
          label: "后台管理",
          groupCode: "company",
          parentKey: null,
          route: null,
          subRoutes: ["/admin/x"],
          sortOrder: 91,
        },
      ])
    })

    it("无使用记录的用户也返回（已消耗 0 / 剩余=积分余额 / tokens 0），排末尾", async () => {
      const u = (id: number, username: string) => ({
        id,
        username,
        phone: `1800000000${id}`,
        canInvite: false,
        invitedById: null,
        subscriptionTier: null,
      })
      prisma.user.findMany.mockResolvedValue([u(1, "alice"), u(2, "no-usage"), u(3, "carol")])
      prisma.usageLog.groupBy.mockResolvedValue([
        {
          userId: 1,
          _sum: {
            credits: new Decimal("5"),
            promptTokens: 100,
            completionTokens: 50,
            thinkingTokens: 0,
          },
        },
        {
          userId: 3,
          _sum: {
            credits: new Decimal("2"),
            promptTokens: 50,
            completionTokens: 10,
            thinkingTokens: 0,
          },
        },
      ])

      const result = await service.statsByUser({ period: StatsPeriod.ALL })

      expect(result.map(r => r.username)).toEqual(["alice", "carol", "no-usage"])
      expect(result[2]).toMatchObject({
        userId: 2,
        username: "no-usage",
        level: "NONE",
        totalConsumed: "0",
        remaining: "0",
        totalTokens: 0,
      })
    })

    it("groupBy 按 userId 聚合（不再依赖 DB 排序）", async () => {
      prisma.user.findMany.mockResolvedValue([])
      prisma.usageLog.groupBy.mockResolvedValue([])
      await service.statsByUser({ period: StatsPeriod.ALL })

      const calls = prisma.usageLog.groupBy.mock.calls as unknown as Array<
        [{ by: string[]; orderBy?: unknown; where: Record<string, unknown> }]
      >
      expect(calls[0][0].by).toEqual(["userId"])
      expect(calls[0][0].orderBy).toBeUndefined()
    })

    it("period=THIS_MONTH 默认：createdAt gte 当月 1 号零点", async () => {
      prisma.user.findMany.mockResolvedValue([])
      prisma.usageLog.groupBy.mockResolvedValue([])
      jest.useFakeTimers().setSystemTime(new Date(2026, 3, 15, 10, 30).getTime())

      await service.statsByUser({})

      const calls = prisma.usageLog.groupBy.mock.calls as unknown as Array<
        [{ where: { createdAt?: { gte?: Date; lt?: Date } } }]
      >
      expect(calls[0][0].where.createdAt?.gte).toEqual(new Date(2026, 3, 1))
      expect(calls[0][0].where.createdAt?.lt).toBeUndefined()

      jest.useRealTimers()
    })

    it("period=LAST_MONTH：createdAt 区间 [上月1号, 本月1号)", async () => {
      prisma.user.findMany.mockResolvedValue([])
      prisma.usageLog.groupBy.mockResolvedValue([])
      jest.useFakeTimers().setSystemTime(new Date(2026, 3, 15).getTime())

      await service.statsByUser({ period: StatsPeriod.LAST_MONTH })

      const calls = prisma.usageLog.groupBy.mock.calls as unknown as Array<
        [{ where: { createdAt?: { gte?: Date; lt?: Date } } }]
      >
      expect(calls[0][0].where.createdAt?.gte).toEqual(new Date(2026, 2, 1))
      expect(calls[0][0].where.createdAt?.lt).toEqual(new Date(2026, 3, 1))

      jest.useRealTimers()
    })

    it("period=LAST_7_DAYS：createdAt gte 为 7 天前", async () => {
      prisma.user.findMany.mockResolvedValue([])
      prisma.usageLog.groupBy.mockResolvedValue([])
      const now = new Date(2026, 3, 15, 12, 0, 0)
      jest.useFakeTimers().setSystemTime(now.getTime())

      await service.statsByUser({ period: StatsPeriod.LAST_7_DAYS })

      const calls = prisma.usageLog.groupBy.mock.calls as unknown as Array<
        [{ where: { createdAt?: { gte?: Date } } }]
      >
      const expectedFrom = new Date(now)
      expectedFrom.setDate(expectedFrom.getDate() - 7)
      expect(calls[0][0].where.createdAt?.gte).toEqual(expectedFrom)

      jest.useRealTimers()
    })

    it("period=ALL：不带 createdAt", async () => {
      prisma.user.findMany.mockResolvedValue([])
      prisma.usageLog.groupBy.mockResolvedValue([])
      await service.statsByUser({ period: StatsPeriod.ALL })

      const calls = prisma.usageLog.groupBy.mock.calls as unknown as Array<
        [{ where: Record<string, unknown> }]
      >
      expect(calls[0][0].where).toEqual({ type: UsageType.TOKEN })
    })

    it("没有用户时返回 []", async () => {
      prisma.user.findMany.mockResolvedValue([])
      prisma.usageLog.groupBy.mockResolvedValue([])
      const result = await service.statsByUser({ period: StatsPeriod.ALL })
      expect(result).toEqual([])
    })

    it("usageLog 中 userId 找不到对应 user 时被静默丢弃", async () => {
      prisma.user.findMany.mockResolvedValue([])
      prisma.usageLog.groupBy.mockResolvedValue([
        {
          userId: 99,
          _sum: {
            cost: new Decimal("1"),
            promptTokens: 100,
            completionTokens: 50,
            thinkingTokens: 0,
          },
        },
      ])

      const result = await service.statsByUser({ period: StatsPeriod.ALL })

      expect(result).toEqual([])
    })

    it("_sum 字段全 null 时：已消耗 0、剩余=积分余额、tokens 0", async () => {
      prisma.usageLog.groupBy.mockResolvedValue([
        {
          userId: 1,
          _sum: { credits: null, promptTokens: null, completionTokens: null, thinkingTokens: null },
        },
      ])
      prisma.user.findMany.mockResolvedValue([
        {
          id: 1,
          username: "alice",
          phone: "18000000001",
          canInvite: false,
          invitedById: null,
          subscriptionTier: null,
        },
      ])
      prisma.creditLot.groupBy.mockResolvedValue([
        { userId: 1, _sum: { remaining: new Decimal("300") } },
      ])

      const result = await service.statsByUser({ period: StatsPeriod.ALL })

      expect(result[0]).toMatchObject({ totalConsumed: "0", remaining: "300", totalTokens: 0 })
    })

    it("剩余取自各桶积分余额聚合", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 1,
          username: "alice",
          phone: "18000000001",
          canInvite: false,
          invitedById: null,
          subscriptionTier: null,
        },
      ])
      prisma.usageLog.groupBy.mockResolvedValue([
        {
          userId: 1,
          _sum: {
            credits: new Decimal("100"),
            promptTokens: 1000,
            completionTokens: 200,
            thinkingTokens: 0,
          },
        },
      ])
      prisma.creditLot.groupBy.mockResolvedValue([
        { userId: 1, _sum: { remaining: new Decimal("900") } },
      ])

      const result = await service.statsByUser({ period: StatsPeriod.ALL })

      expect(result[0]).toMatchObject({ totalConsumed: "100", remaining: "900" })
    })
  })

  describe("statsSourcesByUser", () => {
    it("用户不存在抛 NotFoundException", async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      await expect(service.statsSourcesByUser(999, { period: StatsPeriod.ALL })).rejects.toThrow(
        NotFoundException
      )
    })

    it("返回按 source 聚合的明细（totalConsumed 积分 / totalTokens / callCount），DESC", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1 })
      prisma.usageLog.groupBy.mockResolvedValue([
        {
          source: "listing_generate",
          _sum: {
            credits: new Decimal("105"),
            promptTokens: 100000,
            completionTokens: 20000,
            thinkingTokens: 5000,
          },
          _count: { _all: 3 },
        },
        {
          source: "customer.strategy",
          _sum: {
            credits: new Decimal("22.5"),
            promptTokens: 30000,
            completionTokens: 8000,
            thinkingTokens: 0,
          },
          _count: { _all: 1 },
        },
      ])

      const result = await service.statsSourcesByUser(1, { period: StatsPeriod.ALL })

      expect(result).toEqual([
        { source: "listing_generate", totalConsumed: "105", totalTokens: 125000, callCount: 3 },
        { source: "customer.strategy", totalConsumed: "22.5", totalTokens: 38000, callCount: 1 },
      ])
    })

    it("where 条件：userId + type=TOKEN + source not null + period", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 5 })
      prisma.usageLog.groupBy.mockResolvedValue([])

      await service.statsSourcesByUser(5, { period: StatsPeriod.ALL })

      const calls = prisma.usageLog.groupBy.mock.calls as unknown as Array<
        [{ where: Record<string, unknown>; by: string[] }]
      >
      expect(calls[0][0].where).toEqual({
        userId: 5,
        type: UsageType.TOKEN,
        source: { not: null },
      })
      expect(calls[0][0].by).toEqual(["source"])
    })
  })

  describe("statsSummary", () => {
    it("返回 userCount / 已消耗积分 / 剩余积分 / 总 tokens", async () => {
      prisma.user.count.mockResolvedValue(10)
      prisma.usageLog.aggregate.mockResolvedValue({
        _sum: {
          credits: new Decimal("12345"),
          promptTokens: 1000000,
          completionTokens: 300000,
          thinkingTokens: 50000,
        },
      })
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal("70765") } })

      const result = await service.statsSummary({ period: StatsPeriod.ALL })

      expect(result).toEqual({
        userCount: 10,
        totalQuota: "83110", // 70765 剩余 + 12345 已消耗
        totalCost: "12345",
        remaining: "70765",
        totalTokens: 1350000,
      })
    })

    it("aggregate _sum 全 null 时：剩余 0、已消耗 0、tokens 0", async () => {
      prisma.user.count.mockResolvedValue(0)
      prisma.usageLog.aggregate.mockResolvedValue({
        _sum: { credits: null, promptTokens: null, completionTokens: null, thinkingTokens: null },
      })
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: null } })

      const result = await service.statsSummary({ period: StatsPeriod.ALL })

      expect(result).toMatchObject({
        userCount: 0,
        totalQuota: "0",
        totalCost: "0",
        remaining: "0",
        totalTokens: 0,
      })
    })

    it("period 默认 THIS_MONTH：aggregate 的 where 带 createdAt gte", async () => {
      prisma.user.count.mockResolvedValue(1)
      prisma.usageLog.aggregate.mockResolvedValue({ _sum: {} })
      jest.useFakeTimers().setSystemTime(new Date(2026, 3, 15).getTime())

      await service.statsSummary({})

      const calls = prisma.usageLog.aggregate.mock.calls as unknown as Array<
        [{ where: { createdAt?: { gte?: Date } } }]
      >
      expect(calls[0][0].where.createdAt?.gte).toEqual(new Date(2026, 3, 1))

      jest.useRealTimers()
    })
  })
})
