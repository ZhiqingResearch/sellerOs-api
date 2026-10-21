/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { BadRequestException, NotFoundException } from "@nestjs/common"
import { createHash } from "crypto"
import { AI_SPLIT_COMPETITOR_SCHEMA_VERSION } from "./ai-split-task.runner"
import { AiSplitService } from "./ai-split.service"
import { AiSplitPromptSnapshot } from "./ai-split.types"

const promptVersions = {
  competitorAnalysis: "v3" as const,
  competitorAnalysisHash: "competitor-hash",
  productImageGeneration: "v4" as const,
  productImageGenerationHash: "product-hash",
}

const competitorTemplate = {
  schema_version: AI_SPLIT_COMPETITOR_SCHEMA_VERSION,
  visual_restatement: {
    overall_scene: "工业风暗色场景",
    product_subject: "{{product.visualIdentity}} 置于金属台面",
    product_owned_elements: "{{product.productName}}",
    creative_carriers: "金属台面",
    creative_elements: "工业管线",
    spatial_relationships: "商品居中摆放",
    composition_camera: "平视中景",
    foreground: "金属台面",
    midground: "商品主体",
    background: "暗色墙面",
    color_mood: "暗色工业调",
    lighting: "侧逆光",
    material_texture: "金属拉丝质感",
    production_technique: "商业摄影",
    text_layout: "顶部标题区",
    brand_layout: "右上角标",
    marketing_tone: "硬核工业",
  },
  element_classification: [
    {
      element: "工业管线",
      ownership: "creative_owned",
      reason: "与商品身份无关的装饰元素",
      treatment: "preserve",
      variable_keys: [],
    },
  ],
  variable_bindings: [
    {
      key: "product.productName",
      placeholder: "{{product.productName}}",
      semantic_role: "商品名",
      visual_usage: "标题区域",
      source: "current_product_keys",
      required_for_visual: true,
      missing_strategy: "skip",
    },
  ],
  generation_prompt: {
    product_subject: "{{product.visualIdentity}} 置于金属台面",
    product_structure: "{{product.visualIdentity}}",
    creative_carriers: "金属台面",
    creative_elements: "工业管线",
    spatial_interaction: "商品居中摆放",
    composition_camera: "平视中景",
    foreground: "金属台面",
    midground: "商品主体",
    background: "暗色墙面",
    color: "暗色",
    lighting: "侧逆光",
    material_texture: "金属拉丝质感",
    production_style: "商业摄影",
    text_layout: "顶部标题区",
    brand_area: "{{product.productName}}",
    marketing_tone: "硬核工业",
    constraints: [],
  },
}

const baseSnapshot: AiSplitPromptSnapshot = {
  schemaVersion: "ai-split.v1",
  analysisModel: {
    id: 1,
    publicId: "ZQ-Multimodal-Gemini-3.1-Pro",
    displayName: "Gemini 3.1 Pro",
    gatewayConfig: {},
  },
  reference: { sourceType: "UPLOAD", url: "https://example.com/competitor.png" },
  currentProduct: { productName: "Running Board" },
  currentProductKeys: ["productName"],
  productImages: [
    {
      id: 11,
      index: 1,
      url: "https://example.com/product.png",
      purpose: "PRODUCT_MAIN",
      description: null,
    },
  ],
  competitorTemplate,
  generationPlan: {
    prompt: "生成商品图",
    negative_prompt: "",
    render_constraints: {
      preserve_product_identity: true,
      do_not_merge_packaging_into_product: true,
      preserve_creative_owned: true,
    },
  },
  generationSettings: {
    site: "AMAZON_US",
    locale: "en-US",
    textAmount: "LOW",
    model: "ZQ-Image-3",
    quantity: 2,
    modelParams: { aspect_ratio: "1:1", size: "2048x2048" },
    supportsNegativePrompt: true,
  },
  promptVersions,
  gatewayCalls: {},
}

describe("AiSplitService", () => {
  // 固定一口价默认未配置(null)→ 预检跳过,保持存量行为
  const usage = {
    gatewayFixedImageCredits: jest.fn().mockResolvedValue(null),
    assertExactCreditsAffordable: jest.fn(),
  }

  it("按文档合同事务保存可编辑 Prompt、参数和竞品模板", async () => {
    let templateCreateArgs: unknown
    const tx = {
      imageTemplateGroup: { findFirst: jest.fn().mockResolvedValue({ id: 12 }) },
      imageTemplate: {
        create: jest.fn((args: unknown) => {
          templateCreateArgs = args
          return Promise.resolve({ id: 90 })
        }),
      },
    }
    const prisma = {
      aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      generatedImage: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 9201,
            url: "https://example.com/result.png",
            order: 0,
            task: {
              prompt: "原 Prompt",
              promptConfig: baseSnapshot,
              directionIndex: 0,
              aspectRatio: "1:1",
              textAmount: "LOW",
            },
          },
        ]),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    }
    const service = new AiSplitService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      usage as never,
      { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) } as never
    )

    await service.saveToTemplate(
      {
        mode: "CREATE",
        templateName: "Running Board 工业风套图",
        groupId: 12,
        items: [
          {
            generatedImageId: 9201,
            name: "暗色工业风主图",
            prompt: "用户确认后的 Prompt",
            generationSettings: {
              site: "AMAZON_US",
              textAmount: "LOW",
              model: "ZQ-Image-3",
              quantity: 2,
              model_params: { aspect_ratio: "1:1", size: "2048x2048" },
            },
          },
        ],
      },
      7
    )

    expect(templateCreateArgs).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 7,
          groupId: 12,
          name: "Running Board 工业风套图",
          items: {
            create: [
              expect.objectContaining({
                name: "暗色工业风主图",
                prompt: "用户确认后的 Prompt",
                refImageUrl: "https://example.com/result.png",
                competitorTemplate,
                generationSettings: expect.objectContaining({
                  model: "ZQ-Image-3",
                  model_params: { aspect_ratio: "1:1", size: "2048x2048" },
                }),
              }),
            ],
          },
        }),
      })
    )
  })

  it("模板复用跳过 Workflow 1，从 PRODUCT_PLANNING 创建新 SKU 任务", async () => {
    const savedPrompt = "历史用户确认 Prompt"
    let createdTask: Record<string, unknown> | null = null
    const templateItem = {
      id: 501,
      prompt: savedPrompt,
      promptVersion: "v3",
      promptHash: createHash("sha256").update(savedPrompt).digest("hex"),
      competitorTemplate,
    }
    const tx = {
      generationTask: {
        create: jest.fn((args: { data: Record<string, unknown> }) => {
          const data = args.data
          createdTask = {
            id: 801,
            ...data,
            retryOfTaskId: null,
            errorMessage: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            generatedImages: [{ id: 901, status: "GENERATING", order: 0 }],
          }
          return Promise.resolve(createdTask)
        }),
      },
      imageProject: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = {
      aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      generationTask: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(() => Promise.resolve(createdTask ? [createdTask] : [])),
      },
      imageTemplate: {
        findFirst: jest.fn().mockResolvedValue({ id: 70, items: [templateItem] }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    }
    const validator = {
      loadAnalysisModel: jest.fn().mockResolvedValue(baseSnapshot.analysisModel),
      buildProjectSnapshot: jest.fn().mockResolvedValue({
        project: { id: 5, name: "新 SKU", userId: 7, type: "ECOMMERCE", status: "DRAFT" },
        currentProduct: { productName: "New Running Board" },
        currentProductKeys: ["productName"],
        productImages: baseSnapshot.productImages,
        locale: "en-US",
      }),
      validateReusableCompetitorTemplate: jest.fn().mockReturnValue(competitorTemplate),
      validateImageModel: jest.fn().mockResolvedValue({
        id: 9,
        publicId: "ZQ-Image-3",
        displayName: "ZQ-Image-3",
        gatewayConfig: {},
        modelParams: { aspect_ratio: "1:1" },
        supportsNegativePrompt: true,
      }),
    }
    const runner = {
      getPromptVersions: jest.fn().mockReturnValue(promptVersions),
      run: jest.fn().mockResolvedValue(undefined),
    }
    const service = new AiSplitService(
      prisma as never,
      validator as never,
      runner as never,
      {} as never,
      usage as never,
      { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) } as never
    )

    const result = await service.createTasksFromTemplate(
      5,
      70,
      {
        clientRequestId: "4a1c5e3a-26ec-4dad-b566-e295ab51d191",
        items: [
          {
            templateItemId: 501,
            site: "AMAZON_US",
            textAmount: "LOW",
            model: "ZQ-Image-3",
            quantity: 1,
            promptConfig: { model_params: { aspect_ratio: "463:625", size: "1728x2304" } },
            deliveryTarget: { aspectRatio: "463:625", resolutionTier: "2K" },
          },
        ],
      },
      7
    )

    expect(validator.validateImageModel).toHaveBeenCalledWith({
      model: "ZQ-Image-3", quantity: 1,
      promptConfig: { model_params: { aspect_ratio: "463:625", size: "1728x2304" } },
      deliveryTarget: { aspectRatio: "463:625", resolutionTier: "2K" },
    }, baseSnapshot.productImages)
    expect(tx.generationTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aiSplitStage: "PRODUCT_PLANNING",
          presetCategory: "AI_SPLIT_TEMPLATE",
          promptConfig: expect.objectContaining({
            reference: { sourceType: "TEMPLATE", sourceId: 501 },
            competitorTemplate,
            gatewayCalls: {},
          }),
        }),
      })
    )
    expect(runner.run).toHaveBeenCalledWith(801)
    expect(result.status).toBe("GENERATING")
  })

  it("竞品参考图列表严格按项目隔离（无归属的图不返回）", async () => {
    let listWhere: Record<string, unknown> | null = null
    const prisma = {
      aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      imageProject: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
      poolImage: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn((args: { where: Record<string, unknown> }) => {
          listWhere = args.where
          return Promise.resolve([])
        }),
      },
    }
    const service = new AiSplitService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      usage as never,
      { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) } as never
    )

    await service.listCompetitorImages(5, { page: 1, pageSize: 20 }, 7)

    expect(listWhere).toEqual({
      userId: 7,
      kind: "competitor",
      url: { not: null },
      projectId: 5,
    })
  })

  it("按 groupId 返回单组详情（含阶段明细）", async () => {
    const task = {
      id: 801,
      groupId: "g-1",
      projectId: 5,
      clientRequestId: "req-1",
      directionIndex: 0,
      retryOfTaskId: null,
      n: 2,
      status: "SUCCESS",
      aiSplitStage: "SUCCESS",
      model: "ZQ-Image-3",
      prompt: "生成商品图",
      errorMessage: null,
      promptConfig: baseSnapshot,
      createdAt: new Date("2026-08-30T10:00:00Z"),
      updatedAt: new Date("2026-08-30T10:05:00Z"),
      generatedImages: [
        { id: 901, status: "SUCCESS", url: "https://example.com/r1.png", order: 0 },
        { id: 902, status: "SUCCESS", url: "https://example.com/r2.png", order: 1 },
      ],
    }
    const prisma = {
      aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      generationTask: { findMany: jest.fn().mockResolvedValue([task]) },
    }
    const service = new AiSplitService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      usage as never,
      { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) } as never
    )

    const result = (await service.getTaskGroup({ groupId: "g-1" }, 7)) as never as {
      groupId: string
      projectId: number
      status: string
      tasks: Array<{ stage: string }>
    }

    expect(result.groupId).toBe("g-1")
    expect(result.projectId).toBe(5)
    expect(result.status).toBe("SUCCESS")
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0].stage).toBe("SUCCESS")
  })

  it("组内 GENERATING 任务读时对账：拿到权威结论后重读再返回", async () => {
    const task = {
      id: 801,
      groupId: "g-1",
      projectId: 5,
      clientRequestId: "req-1",
      directionIndex: 0,
      retryOfTaskId: null,
      n: 1,
      status: "GENERATING",
      aiSplitStage: "IMAGE_GENERATING",
      model: "ZQ-Image-3",
      prompt: "生成商品图",
      errorMessage: null,
      gatewayTaskId: "image_task_1",
      promptConfig: baseSnapshot,
      createdAt: new Date("2026-08-30T10:00:00Z"),
      updatedAt: new Date("2026-08-30T10:05:00Z"),
      generatedImages: [{ id: 901, status: "GENERATING", url: null, order: 0 }],
    }
    const prisma = {
      aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      generationTask: { findMany: jest.fn().mockResolvedValue([task]) },
    }
    const gatewayWebhook = { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(true) }
    const service = new AiSplitService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      usage as never,
      gatewayWebhook as never
    )

    const result = (await service.getTaskGroup({ groupId: "g-1" }, 7)) as never as {
      status: string
    }

    expect(gatewayWebhook.reconcileImageTaskOnRead).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 801,
        status: "GENERATING",
        gatewayTaskId: "image_task_1",
      })
    )
    // 对账拿到网关权威结论后重读，本次响应即最新状态
    expect(prisma.generationTask.findMany).toHaveBeenCalledTimes(2)
    expect(result.status).toBe("GENERATING")
  })

  it("按 projectId 返回项目下全部任务组（最新在前、带汇总与封面图）", async () => {
    const buildTask = (overrides: Record<string, unknown>) => ({
      projectId: 5,
      clientRequestId: "req-1",
      directionIndex: 0,
      retryOfTaskId: null,
      status: "SUCCESS",
      aiSplitStage: "SUCCESS",
      model: "ZQ-Image-3",
      prompt: "生成商品图",
      errorMessage: null,
      promptConfig: baseSnapshot,
      createdAt: new Date("2026-08-29T10:00:00Z"),
      updatedAt: new Date("2026-08-29T10:05:00Z"),
      generatedImages: [],
      ...overrides,
    })
    // findMany 按创建时间倒序返回，新组任务在前
    const taskNew = buildTask({
      id: 801,
      groupId: "g-new",
      clientRequestId: "req-2",
      n: 2,
      createdAt: new Date("2026-08-30T10:00:00Z"),
      updatedAt: new Date("2026-08-30T10:05:00Z"),
      generatedImages: [
        { id: 901, status: "SUCCESS", url: "https://example.com/r1.png", order: 0 },
        { id: 902, status: "SUCCESS", url: "https://example.com/r2.png", order: 1 },
      ],
    })
    const taskOld = buildTask({
      id: 701,
      groupId: "g-old",
      n: 2,
      generatedImages: [
        { id: 801, status: "SUCCESS", url: "https://example.com/old.png", order: 0 },
        { id: 802, status: "FAILED", url: null, order: 1 },
      ],
    })
    let manyWhere: Record<string, unknown> | null = null
    let manyOrderBy: unknown = null
    const prisma = {
      aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      generationTask: {
        findMany: jest.fn((args: { where: Record<string, unknown>; orderBy: unknown }) => {
          manyWhere = args.where
          manyOrderBy = args.orderBy
          return Promise.resolve([taskNew, taskOld])
        }),
      },
    }
    const service = new AiSplitService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      usage as never,
      { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) } as never
    )

    const result = (await service.getTaskGroup({ projectId: 5 }, 7)) as never as {
      projectId: number
      groups: Array<{
        groupId: string
        isLatest: boolean
        status: string
        successCount: number
        coverUrl: string | null
        results: Array<{ url: string | null }>
      }>
    }

    expect(manyWhere).toEqual({
      userId: 7,
      generationMode: "AI_SPLIT",
      projectId: 5,
      source: "platform",
      project: { source: "platform" },
    })
    expect(manyOrderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }])
    expect(result.projectId).toBe(5)
    expect(result.groups).toHaveLength(2)
    expect(result.groups[0].groupId).toBe("g-new")
    expect(result.groups[0].isLatest).toBe(true)
    expect(result.groups[0].status).toBe("SUCCESS")
    expect(result.groups[0].successCount).toBe(2)
    expect(result.groups[0].coverUrl).toBe("https://example.com/r1.png")
    expect(result.groups[0].results.map(image => image.url)).toEqual([
      "https://example.com/r1.png",
      "https://example.com/r2.png",
    ])
    expect(result.groups[1].groupId).toBe("g-old")
    expect(result.groups[1].isLatest).toBe(false)
    expect(result.groups[1].status).toBe("PARTIAL_SUCCESS")
    expect(result.groups[1].successCount).toBe(1)
  })

  it("groupId 与 projectId 至少传一个", async () => {
    const service = new AiSplitService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      usage as never,
      { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) } as never
    )

    await expect(service.getTaskGroup({}, 7)).rejects.toThrow(BadRequestException)
  })

  it("projectId 下没有 AI 拆图任务时返回 404", async () => {
    const prisma = {
      aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      generationTask: { findMany: jest.fn().mockResolvedValue([]) },
    }
    const service = new AiSplitService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      usage as never,
      { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) } as never
    )

    await expect(service.getTaskGroup({ projectId: 5 }, 7)).rejects.toThrow(NotFoundException)
  })
})
