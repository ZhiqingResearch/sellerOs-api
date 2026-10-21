import { NotFoundException } from "@nestjs/common"
import { AiModelExecMode, AiModelModality } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { AiGatewayModelService } from "./ai-gateway-model.service"
import { AiGatewayProvider } from "./ai-gateway.provider"

describe("AiGatewayModelService", () => {
  const prisma = {
    aiGatewayModel: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    aiGatewayVideoFixedPrice: {
      findMany: jest.fn(),
    },
  }
  const gateway = { estimateVideoPrice: jest.fn(), isConfigured: jest.fn(() => false) }
  const usage = { resolveFixedVideoTier: jest.fn() }
  const service = new AiGatewayModelService(
    prisma as unknown as PrismaService,
    gateway as unknown as AiGatewayProvider,
    usage as unknown as UsageService
  )

  beforeEach(() => {
    jest.clearAllMocks()
    // 默认无一口价/成本配置。
    usage.resolveFixedVideoTier.mockResolvedValue(null)
    prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([])
  })

  /** 取 mock 首个调用的入参（强类型读取，供字段级断言） */
  function firstCallArg(mockFn: { mock: { calls: unknown[][] } }): unknown {
    return mockFn.mock.calls[0][0]
  }

  /**
   * 构造可触发后台刷新的独立实例（isConfigured=true）。
   * lastSyncedAt 为该分类最近一次成功同步时间：默认 1 小时前（超过 30 分钟间隔 → 触发刷新）。
   */
  function setupRefresh(
    rows: unknown[],
    snapshotByPublicId: Record<string, unknown>,
    lastSyncedAt: Date | null = new Date(Date.now() - 60 * 60 * 1000)
  ) {
    const refreshPrisma = {
      aiGatewayModel: {
        findFirst: jest.fn().mockResolvedValue(lastSyncedAt ? { syncedAt: lastSyncedAt } : null),
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn().mockResolvedValue({}),
      },
    }
    const refreshGateway = {
      isConfigured: jest.fn(() => true),
      fetchModelSnapshot: jest.fn((publicId: string) => snapshotByPublicId[publicId] ?? null),
    }
    const refreshService = new AiGatewayModelService(
      refreshPrisma as unknown as PrismaService,
      refreshGateway as unknown as AiGatewayProvider,
      usage as unknown as UsageService
    )
    return { refreshService, refreshPrisma, refreshGateway }
  }

  it("按分类返回模型能力和请求 Schema", async () => {
    prisma.aiGatewayModel.findMany.mockResolvedValue([
      {
        publicId: "sourcing-test-video",
        displayName: "测试视频模型",
        modality: AiModelModality.VIDEO,
        execMode: AiModelExecMode.ASYNC,
        gatewayConfig: {
          detail: { facts: { durations: [5, 10] } },
          requestSchema: { request_schema: { type: "object" } },
        },
      },
    ])
    prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([])

    const result = await service.findAll({ modality: AiModelModality.VIDEO, category: "NORMAL" })

    expect(result.items[0]).toEqual({
      publicId: "sourcing-test-video",
      displayName: "测试视频模型",
      modality: AiModelModality.VIDEO,
      execMode: AiModelExecMode.ASYNC,
      facts: { durations: [5, 10] },
      requestSchema: { type: "object" },
      fixedCreditsByResolution: null,
      fixedCreditsByMode: null,
    })
  })

  it("车泰斗别名和推荐仅改变对应分类展示，保留 publicId", async () => {
    prisma.aiGatewayModel.findMany.mockResolvedValue([
      {
        publicId: "ZQ-Multimodal-Gemini-3.8-Flash",
        displayName: "Gemini",
        modality: AiModelModality.TEXT,
        gatewayConfig: {},
      },
      {
        publicId: "ZQ-Think-Lite",
        displayName: "Think",
        modality: AiModelModality.TEXT,
        gatewayConfig: {},
      },
      { publicId: "other", displayName: "其他", modality: AiModelModality.TEXT, gatewayConfig: {} },
    ])
    const text = await service.findAll({ category: "CHETAIDOU_MULTIMODAL" })
    expect(text.items.map(row => [row.publicId, row.displayName])).toEqual([
      ["ZQ-Multimodal-Gemini-3.8-Flash", "ZQ-ZL-1"],
      ["ZQ-Think-Lite", "ZQ-ZL-2"],
      ["other", "其他"],
    ])
    const other = await service.findAll({ category: "OTHER" })
    expect(other.items[0].displayName).toBe("Gemini")
    expect(other.items[0]).not.toHaveProperty("recommended")
    prisma.aiGatewayModel.findMany.mockResolvedValue([
      {
        publicId: "ZQ-Image-1",
        displayName: "Nano",
        modality: AiModelModality.IMAGE,
        gatewayConfig: {},
      },
      {
        publicId: "old",
        displayName: "旧默认",
        modality: AiModelModality.IMAGE,
        gatewayConfig: {},
      },
    ])
    const image = await service.findAll({ category: "CHETAIDOU_IMAGE" })
    expect(image.items.map(row => row.recommended)).toEqual([true, false])
  })

  it("视频目录随行下发按分辨率分档的固定一口价，未配置模型为 null", async () => {
    prisma.aiGatewayModel.findMany.mockResolvedValue([
      { publicId: "model-a", displayName: "A", modality: AiModelModality.VIDEO, gatewayConfig: {} },
      { publicId: "model-b", displayName: "B", modality: AiModelModality.VIDEO, gatewayConfig: {} },
    ])
    prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([
      { publicId: "model-a", mode: "", resolution: "480P", creditsPerSec: 15 },
      { publicId: "model-a", mode: "", resolution: "720p", creditsPerSec: 20 },
      { publicId: "model-a", mode: "video_to_video", resolution: "720p", creditsPerSec: 25 },
      { publicId: "model-b", mode: "", resolution: "720p", creditsPerSec: null },
    ])

    const result = await service.findAll({ modality: AiModelModality.VIDEO, category: "NORMAL" })

    // 档位键统一小写归一下发；通配行走 fixedCreditsByResolution，按模式分价行走 fixedCreditsByMode
    expect(result.items[0].fixedCreditsByResolution).toEqual({ "480p": "15", "720p": "20" })
    expect(result.items[0].fixedCreditsByMode).toEqual({
      video_to_video: { "720p": "25" },
    })
    expect(result.items[1].fixedCreditsByResolution).toBeNull()
    expect(result.items[1].fixedCreditsByMode).toBeNull()
  })

  it("固定一口价模型报价：本地确定性返回，不打网关估价", async () => {
    prisma.aiGatewayModel.findFirst.mockResolvedValue({
      publicId: "sourcing-test-video",
      priceMultiplier: 2,
    })
    usage.resolveFixedVideoTier.mockResolvedValue({ creditsPerSec: new Decimal(15), flat: false })

    const result = await service.quote({
      category: "NORMAL",
      publicId: "sourcing-test-video",
      params: {
        prompt: "海边日出",
        duration_seconds: 6,
        resolution: "1080P",
      },
    })

    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    // 返回单位一口价，不乘请求中的时长或模型倍率。
    expect(usage.resolveFixedVideoTier).toHaveBeenCalledWith(
      "sourcing-test-video",
      "NORMAL",
      "1080P",
      undefined
    )
    expect(result.variants[0].parameters).not.toHaveProperty("duration_seconds")
    expect(result.currency).toBe("CNY")
    expect(result.variants).toHaveLength(1)
    expect(result.variants[0]).toMatchObject({
      estimated_amount: "1.5",
      minimum_amount: "1.5",
      maximum_amount: "1.5",
      estimated_credits: "15",
      minimum_credits: "15",
      maximum_credits: "15",
      billingUnit: "SECOND",
      exact: true,
      pricingMode: "fixed",
    })
  })

  it("自适应模型报价：无分辨率命中 adaptive 保留档按次一口价，不乘时长", async () => {
    prisma.aiGatewayModel.findFirst.mockResolvedValue({
      publicId: "sourcing-kling-o3-video-edit",
      priceMultiplier: 1,
    })
    usage.resolveFixedVideoTier.mockResolvedValue({ creditsPerSec: new Decimal(150), flat: true })

    const result = await service.quote({
      category: "REFERENCE",
      publicId: "sourcing-kling-o3-video-edit",
      params: { prompt: "编辑这段视频", mode: "video_to_video" },
    })

    expect(usage.resolveFixedVideoTier).toHaveBeenCalledWith(
      "sourcing-kling-o3-video-edit",
      "REFERENCE",
      undefined,
      "video_to_video"
    )
    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    expect(result.variants[0]).toMatchObject({
      estimated_amount: "15",
      minimum_amount: "15",
      maximum_amount: "15",
      estimated_credits: "150",
      billingUnit: "REQUEST",
      exact: true,
      pricingMode: "fixed",
    })
  })

  describe("本地视频成本报价", () => {
    const quote = (params = {}) =>
      service.quote({
        publicId: "sourcing-test-video",
        category: "NORMAL",
        params: { resolution: "480p", ...params },
      })
    beforeEach(() => {
      prisma.aiGatewayModel.findFirst.mockResolvedValue({
        publicId: "sourcing-test-video",
        priceMultiplier: new Decimal("1.5"),
      })
    })
    const rate = (
      resolution: string,
      min: string | null,
      max: string | null,
      mode = "",
      costPerRequest = false
    ) => ({
      resolution,
      mode,
      costMinCny: min == null ? null : new Decimal(min),
      costMaxCny: max == null ? null : new Decimal(max),
      costPerRequest,
    })

    it("Excel 区间成本返回积分上下限，单个预估值为空，不调用网关", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([rate("480p", "0.784", "0.833")])
      const result = await quote()
      expect(result.variants[0]).toMatchObject({
        minimum_amount: "1.176",
        maximum_amount: "1.2495",
        estimated_amount: null,
        minimum_credits: "11.76",
        maximum_credits: "12.495",
        billingUnit: "SECOND",
        estimated_credits: null,
        exact: false,
      })
      expect(prisma.aiGatewayVideoFixedPrice.findMany).toHaveBeenCalledWith({
        where: { publicId: "sourcing-test-video", category: "NORMAL" },
        select: {
          mode: true,
          resolution: true,
          costMinCny: true,
          costMaxCny: true,
          costPerRequest: true,
        },
      })
      expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    })

    it("按秒积分保留小数，更新数据库成本下一次报价立即生效", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([rate("480p", "0.23", "0.23")])
      expect((await quote()).variants[0]).toMatchObject({
        estimated_credits: "3.45",
        minimum_credits: "3.45",
        maximum_credits: "3.45",
        billingUnit: "SECOND",
      })
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([rate("480p", "0.5", "0.5")])
      expect((await quote({ duration_seconds: 10 })).variants[0].estimated_credits).toBe("7.5")
    })

    it("精确 mode 优先，未指定分辨率时展开配置档位，不能混用其他模式", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([
        rate("480p", "0.5", "0.5"),
        rate("720P", "1", "1"),
        rate(" 480P ", "2", "2", " VIDEO_TO_VIDEO "),
        rate("1080p", "9", "9", "reference_to_video"),
      ])
      const result = await quote({ resolution: undefined, mode: "video_to_video" })
      expect(result.variants.map(v => [v.parameters.resolution, v.estimated_credits])).toEqual([
        ["480p", "30"],
        ["720p", "15"],
      ])
    })

    it.each([
      ["adaptive", "8.82", undefined, "133"],
      ["flat", "9.38", "480p", "141"],
      ["flat", "9.38", "720p", "141"],
    ])(
      "%s 按次成本 %s 在 %s 档不乘时长",
      async (resolution, cost, requestedResolution, expected) => {
        prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([rate(resolution, cost, cost)])
        for (const duration_seconds of [undefined, 7, 10]) {
          const result = await quote({ resolution: requestedResolution, duration_seconds })
          expect(result.variants[0]).toMatchObject({
            billingUnit: "REQUEST",
            estimated_credits: expected,
            minimum_credits: expected,
            maximum_credits: expected,
          })
        }
      }
    )

    it("保留通配档：省略 mode 时仍可按参考视频成本报价", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([
        rate("480p", "1.867", "1.867"),
        rate("480p", "1.867", "1.867", "reference_to_video"),
        rate("480p", "9.38", "9.38", "video_to_video", true),
      ])
      expect((await quote({ mode: undefined })).variants[0].estimated_credits).toBe("28.005")
      expect(
        (await quote({ mode: "reference_to_video", duration_seconds: 10 })).variants[0]
          .estimated_credits
      ).toBe("28.005")
      expect(
        (await quote({ mode: "video_to_video", duration_seconds: 10 })).variants[0]
          .estimated_credits
      ).toBe("141")
    })

    it("按次成本保留独立分辨率：修改 720p 不影响 480p，不乘时长", async () => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([
        rate("480p", "9.38", "9.38", "video_to_video", true),
        rate("720p", "10", "11", "video_to_video", true),
      ])
      for (const duration_seconds of [undefined, 7, 10]) {
        expect(
          (await quote({ mode: "video_to_video", duration_seconds })).variants[0].estimated_credits
        ).toBe("141")
        expect(
          (await quote({ mode: "video_to_video", resolution: "720p", duration_seconds }))
            .variants[0]
        ).toMatchObject({
          estimated_credits: null,
          minimum_credits: "150",
          maximum_credits: "165",
          billingUnit: "REQUEST",
        })
      }
      const expanded = await quote({
        mode: "video_to_video",
        resolution: undefined,
        duration_seconds: undefined,
      })
      expect(expanded.variants.map(v => v.parameters.resolution)).toEqual(["480p", "720p"])
    })

    it.each([undefined, 0, -1, 5, 10])("时长 %s 不影响按秒单位报价", async duration_seconds => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([rate("480p", "0.5", "0.5")])
      expect((await quote({ duration_seconds })).variants[0]).toMatchObject({
        estimated_credits: "7.5",
        minimum_credits: "7.5",
        maximum_credits: "7.5",
        billingUnit: "SECOND",
      })
    })

    it("成本缺失、半套配置、模式或分辨率不匹配均不伪造报价", async () => {
      for (const rows of [
        [],
        [rate("480p", "0.5", null)],
        [rate("720p", "0.5", "0.5")],
        [rate("480p", "0.5", "0.5", "video_to_video")],
      ]) {
        prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue(rows)
        expect((await quote()).variants[0].estimated_credits).toBeNull()
      }
      expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    })

    it.each([
      ["-1", "1"],
      ["2", "1"],
    ])("成本上下限 %s/%s 无效时拒绝报价", async (min, max) => {
      prisma.aiGatewayVideoFixedPrice.findMany.mockResolvedValue([rate("480p", min, max)])
      await expect(quote()).rejects.toThrow("视频预估成本配置无效")
    })

    it("一口价优先于展示成本，报价仍为原一口价且不读取成本", async () => {
      usage.resolveFixedVideoTier.mockResolvedValue({ creditsPerSec: new Decimal(15), flat: false })
      expect((await quote()).variants[0]).toMatchObject({
        estimated_credits: "15",
        billingUnit: "SECOND",
        pricingMode: "fixed",
      })
      expect(prisma.aiGatewayVideoFixedPrice.findMany).not.toHaveBeenCalled()
    })
  })

  it("未启用的模型不读取展示成本或调用 Gateway", async () => {
    prisma.aiGatewayModel.findFirst.mockResolvedValue(null)

    await expect(
      service.quote({
        category: "NORMAL",
        publicId: "sourcing-test-video",
        params: { prompt: "海边日出", duration_seconds: 5 },
      })
    ).rejects.toThrow(NotFoundException)
    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    expect(prisma.aiGatewayVideoFixedPrice.findMany).not.toHaveBeenCalled()
  })

  it("findAll 查询 VIDEO/IMAGE 时都按 category 触发后台刷新，TEXT 不触发", async () => {
    const spy = jest.spyOn(service, "maybeRefreshModels").mockResolvedValue()
    prisma.aiGatewayModel.findMany.mockResolvedValue([])

    await service.findAll({ modality: AiModelModality.IMAGE, category: "PORTRAIT" })
    expect(spy).toHaveBeenCalledWith(AiModelModality.IMAGE, "PORTRAIT")

    await service.findAll({ modality: AiModelModality.VIDEO, category: "REFERENCE" })
    expect(spy).toHaveBeenCalledWith(AiModelModality.VIDEO, "REFERENCE")

    expect(spy).toHaveBeenCalledTimes(2)
  })

  it("分类 30 分钟内已同步过（syncedAt 新鲜）则不打网关", async () => {
    const { refreshService, refreshPrisma, refreshGateway } = setupRefresh(
      [{ publicId: "sourcing-test-video", category: "NORMAL" }],
      {},
      new Date(Date.now() - 10 * 60 * 1000) // 10 分钟前同步过
    )

    await refreshService.maybeRefreshModels(AiModelModality.VIDEO, "NORMAL")

    expect(refreshPrisma.aiGatewayModel.findFirst).toHaveBeenCalledWith({
      where: { modality: AiModelModality.VIDEO, category: "NORMAL" },
      orderBy: { syncedAt: "desc" },
      select: { syncedAt: true },
    })
    expect(refreshGateway.fetchModelSnapshot).not.toHaveBeenCalled()
    expect(refreshPrisma.aiGatewayModel.update).not.toHaveBeenCalled()
  })

  it("后台刷新用网关最新详情更新本地快照", async () => {
    const detail = { display_name: "新模型名", modality: "video", exec_mode: "async" }
    const requestSchema = { version: 2, request_schema: { type: "object" } }
    const { refreshService, refreshPrisma } = setupRefresh(
      [{ publicId: "sourcing-test-video", category: "NORMAL" }],
      { "sourcing-test-video": { detail, requestSchema } }
    )

    await refreshService.maybeRefreshModels(AiModelModality.VIDEO, "NORMAL")

    expect(refreshPrisma.aiGatewayModel.findMany).toHaveBeenCalledWith({
      where: { modality: AiModelModality.VIDEO, category: "NORMAL" },
      select: { publicId: true, category: true },
    })
    expect(refreshPrisma.aiGatewayModel.update).toHaveBeenCalledTimes(1)
    const arg = firstCallArg(refreshPrisma.aiGatewayModel.update) as {
      where: { publicId_category: { publicId: string; category: string } }
      data: Record<string, unknown>
    }
    expect(arg.where).toEqual({
      publicId_category: { publicId: "sourcing-test-video", category: "NORMAL" },
    })
    expect(arg.data).toMatchObject({
      displayName: "新模型名",
      execMode: AiModelExecMode.ASYNC,
      gatewayActive: true,
      gatewayConfig: { detail, requestSchema },
    })
  })

  it("图片模型按 images.generations 拉取快照并按模态校验", async () => {
    const detail = { display_name: "ZQ 图片模型", modality: "image", exec_mode: "sync" }
    const { refreshService, refreshPrisma, refreshGateway } = setupRefresh(
      [{ publicId: "ZQ-Image-3", category: "PORTRAIT" }],
      { "ZQ-Image-3": { detail, requestSchema: { version: 1 } } }
    )

    await refreshService.maybeRefreshModels(AiModelModality.IMAGE, "PORTRAIT")

    expect(refreshGateway.fetchModelSnapshot).toHaveBeenCalledWith(
      "ZQ-Image-3",
      "images.generations"
    )
    const imageArg = firstCallArg(refreshPrisma.aiGatewayModel.update) as {
      where: { publicId_category: { publicId: string; category: string } }
      data: Record<string, unknown>
    }
    expect(imageArg.where).toEqual({
      publicId_category: { publicId: "ZQ-Image-3", category: "PORTRAIT" },
    })
    expect(imageArg.data).toMatchObject({ execMode: AiModelExecMode.SYNC, gatewayActive: true })
  })

  it("网关已下架（404）的模型置 gatewayActive=false，非视频模型跳过不更新", async () => {
    const { refreshService, refreshPrisma, refreshGateway } = setupRefresh(
      [
        { publicId: "sourcing-gone", category: "NORMAL" },
        { publicId: "sourcing-not-video", category: "NORMAL" },
      ],
      {}
    )
    refreshGateway.fetchModelSnapshot.mockImplementation((publicId: string) =>
      publicId === "sourcing-not-video"
        ? { detail: { modality: "image" }, requestSchema: {} }
        : null
    )

    await refreshService.maybeRefreshModels(AiModelModality.VIDEO, "NORMAL")

    expect(refreshPrisma.aiGatewayModel.update).toHaveBeenCalledTimes(1)
    const arg = firstCallArg(refreshPrisma.aiGatewayModel.update) as {
      where: { publicId_category: { publicId: string; category: string } }
      data: Record<string, unknown>
    }
    expect(arg.where).toEqual({
      publicId_category: { publicId: "sourcing-gone", category: "NORMAL" },
    })
    expect(arg.data).toMatchObject({ gatewayActive: false })
  })

  it("刷新间隔内不重复刷新，单行失败不影响其余行", async () => {
    const detail = { display_name: "正常模型", modality: "video", exec_mode: "async" }
    const { refreshService, refreshPrisma, refreshGateway } = setupRefresh(
      [
        { publicId: "sourcing-bad", category: "NORMAL" },
        { publicId: "sourcing-good", category: "NORMAL" },
      ],
      {}
    )
    refreshGateway.fetchModelSnapshot.mockImplementation((publicId: string) => {
      if (publicId === "sourcing-bad") throw new Error("网关抖动")
      return { detail, requestSchema: { version: 1 } }
    })

    await refreshService.maybeRefreshModels(AiModelModality.VIDEO, "NORMAL")
    await refreshService.maybeRefreshModels(AiModelModality.VIDEO, "NORMAL")

    expect(refreshGateway.fetchModelSnapshot).toHaveBeenCalledTimes(2)
    expect(refreshPrisma.aiGatewayModel.update).toHaveBeenCalledTimes(1)
    expect(refreshPrisma.aiGatewayModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publicId_category: { publicId: "sourcing-good", category: "NORMAL" } },
      })
    )
  })
})
