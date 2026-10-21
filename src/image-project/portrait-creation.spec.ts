import { BadRequestException, ServiceUnavailableException } from "@nestjs/common"
import { PortraitCreationService } from "./portrait-creation.service"
import type { PortraitImageGenerator } from "./portrait-image-generator"
import { PortraitTaskValidator } from "./portrait-task.validator"

const gateway = {
  fetchModelSnapshot: jest.fn().mockResolvedValue({
    detail: { modality: "image", facts: {} },
    requestSchema: { request_schema: { type: "object", properties: {} } },
  }),
}

describe("人像创作冒烟测试", () => {
  // 固定一口价默认未配置(null)→ 预检跳过,保持存量行为
  const usage = {
    gatewayFixedImageCredits: jest.fn().mockResolvedValue(null),
    assertExactCreditsAffordable: jest.fn(),
  }
  const gatewayConfig = {
    detail: {
      facts: {
        modes: ["generate", "edit"],
        resolutions: ["2048x2048"],
        qualities: ["standard"],
        output_formats: ["png"],
        max_reference_images: 3,
        max_images_per_request: 4,
      },
    },
    requestSchema: {
      request_schema: {
        type: "object",
        required: ["model"],
        properties: {
          model: { type: "string" },
          prompt: { type: "string" },
          operation: { enum: ["generate", "edit"] },
          n: { type: "integer", minimum: 1, maximum: 4 },
          callback: { type: "boolean" },
          size: { enum: ["2048x2048"] },
          quality: { enum: ["standard"] },
          output_format: { enum: ["png"] },
          aspect_ratio: { enum: ["1:1"] },
          reference_images: { type: "array" },
        },
        additionalProperties: false,
      },
    },
  }

  beforeEach(() => gateway.fetchModelSnapshot.mockResolvedValue({
    detail: { modality: "image", ...gatewayConfig.detail },
    requestSchema: gatewayConfig.requestSchema,
  }))

  describe.each(["ZQ-Image-Ultra", "ZQ-Image-Ultra-Backup"])(
    "%s 旧目录模型走网关 intent（不再按目录就近规划）",
    model => {
      it.each([
        ["1K", 819, 1024],
        ["2K", 1638, 2048],
      ] as const)("保留 4:5 × %s", async (tier, width, height) => {
        const validator = new PortraitTaskValidator({
          poolImage: { findMany: jest.fn() },
          aiGatewayModel: {
            findFirst: jest
              .fn()
              .mockResolvedValue({ publicId: model, displayName: model, gatewayConfig }),
          },
        } as any, gateway as never)
        const result = await validator.validateTask(
          {
            model,
            prompt: "小女孩，819×1024",
            viewConfig: {},
            deliveryTarget: { aspectRatio: "4:5", resolutionTier: tier },
            promptConfig: {
              schema_version: 1,
              creation_type: "SINGLE_PORTRAIT",
              modules: {},
              references: [],
            },
          },
          7
        )
        // 旧目录 facts/Schema enum 不再约束提交参数：4:5 为十档比例 → intent 直发，
        // 模型能力差异由网关就近解析、回调后按目标比例裁回
        expect(result.modelParams).toEqual({
          aspect_ratio: "4:5",
          resolution: tier.toLowerCase(),
          output_format: "png",
        })
        expect(result.deliveryPlan?.requested).toEqual({
          aspectRatio: "4:5",
          resolutionTier: tier,
          width,
          height,
        })
        expect(result.deliveryPlan?.warnings).toEqual([])
      })
    }
  )

  it("模型未接入时返回 503且不创建任务", async () => {
    const prisma = {
      imageProject: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          userId: 7,
          type: "PORTRAIT",
          status: "DRAFT",
        }),
      },
      $transaction: jest.fn(),
    }
    const validator = { validateTask: jest.fn() }
    const runner = { run: jest.fn() }
    const generator: PortraitImageGenerator = {
      isAvailable: () => false,
      submit: jest.fn(),
    }
    const service = new PortraitCreationService(
      prisma as any,
      validator as any,
      runner as any,
      usage as any,
      generator
    )

    await expect(
      service.createTask(
        1,
        {
          prompt: "原样提示词",
          promptConfig: {
            schema_version: 1,
            creation_type: "SINGLE_PORTRAIT",
            modules: {},
          },
          viewConfig: {},
          model: "future-model",
        },
        7
      )
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(validator.validateTask).not.toHaveBeenCalled()
  })

  it("模型可用时原样保存提示词和两份快照，并创建对应图片席位", async () => {
    const taskCreate = jest
      .fn()
      .mockResolvedValue({ id: 31, generatedImages: [{ id: 1 }, { id: 2 }] })
    const projectUpdate = jest.fn().mockResolvedValue({})
    const tx = {
      generationTask: { create: taskCreate },
      imageProject: { update: projectUpdate },
    }
    const prisma = {
      imageProject: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          userId: 7,
          type: "PORTRAIT",
          status: "DRAFT",
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    }
    const validator = {
      validateTask: jest.fn().mockResolvedValue({
        creationType: "FOUR_VIEW_CHARACTER",
        references: [{ url: "https://example.com/ref.png", purpose: "参考脸型" }],
        modelParams: { size: "2048x2048", output_format: "png" },
      }),
    }
    const runner = { run: jest.fn().mockResolvedValue(undefined) }
    const generator: PortraitImageGenerator = {
      isAvailable: () => true,
      submit: jest.fn(),
    }
    const service = new PortraitCreationService(
      prisma as any,
      validator as any,
      runner as any,
      usage as any,
      generator
    )
    const promptConfig = {
      schema_version: 1,
      creation_type: "FOUR_VIEW_CHARACTER",
      modules: {},
    }
    const viewConfig = {
      views: [1, 2, 3, 4].map(index => ({ index, content: `视角${index}` })),
    }

    await service.createTask(
      1,
      {
        prompt: "  不应被后端改写的最终提示词  ",
        promptConfig,
        viewConfig,
        model: "future-model",
        quantity: 2,
      },
      7
    )

    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prompt: "  不应被后端改写的最终提示词  ",
          promptConfig: {
            ...promptConfig,
            model_params: { size: "2048x2048", output_format: "png" },
          },
          viewConfig,
          n: 2,
          refImageUrls: ["https://example.com/ref.png"],
          generatedImages: {
            create: [
              { source: "platform", status: "GENERATING", order: 0 },
              { source: "platform", status: "GENERATING", order: 1 },
            ],
          },
        }),
      })
    )
    expect(runner.run).toHaveBeenCalledWith(31)
  })

  it("创建任务时保存用户目标比例和交付规划快照", async () => {
    const taskCreate = jest.fn().mockResolvedValue({ id: 32, generatedImages: [] })
    const tx = {
      generationTask: { create: taskCreate },
      imageProject: { update: jest.fn() },
    }
    const prisma = {
      imageProject: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          userId: 7,
          type: "PORTRAIT",
          status: "DRAFT",
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    }
    const deliveryPlan = {
      requested: { aspectRatio: "4:5", resolutionTier: "2K", width: 1638, height: 2048 },
      providerApplied: { aspectRatio: "3:4", size: "1536x2048" },
      delivery: {
        width: 1638,
        height: 2048,
        strategy: "adapter",
        nativeResolution: true,
      },
      warnings: ["模型不支持 4:5，已使用 3:4 生成后适配"],
    }
    const service = new PortraitCreationService(
      prisma as any,
      {
        validateTask: jest.fn().mockResolvedValue({
          creationType: "SINGLE_PORTRAIT",
          references: [],
          modelParams: { aspect_ratio: "3:4", size: "1536x2048" },
          deliveryPlan,
        }),
      } as any,
      { run: jest.fn() } as any,
      usage as any,
      { isAvailable: () => true, submit: jest.fn() }
    )

    await service.createTask(
      1,
      {
        prompt: "完整人像提示词",
        promptConfig: {
          schema_version: 1,
          creation_type: "SINGLE_PORTRAIT",
          modules: {},
          model_params: { aspect_ratio: "3:4", size: "1536x2048" },
        },
        viewConfig: {},
        model: "ZQ-Image-3",
        deliveryTarget: { aspectRatio: "4:5", resolutionTier: "2K" },
      },
      7
    )

    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aspectRatio: "4:5",
          deliveryPlan,
        }),
      })
    )
  })

  it("多角度角色卡缺少视角时拒绝", async () => {
    const validator = new PortraitTaskValidator({ poolImage: { findMany: jest.fn() } } as any, gateway as never)
    await expect(
      validator.validate(
        {
          schema_version: 1,
          creation_type: "FOUR_VIEW_CHARACTER",
          modules: {},
          references: [],
        },
        { views: [{ index: 1, content: "正面" }] },
        7
      )
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("素材池参考图校验归属和 URL", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ id: 18, url: "https://example.com/current.png" }])
    const validator = new PortraitTaskValidator({ poolImage: { findMany } } as any, gateway as never)

    await expect(
      validator.validate(
        {
          schema_version: 1,
          creation_type: "SINGLE_PORTRAIT",
          modules: {},
          references: [
            {
              source_type: "POOL",
              pool_image_id: 18,
              url: "https://example.com/stale.png",
              purpose: "参考发型",
            },
          ],
        },
        {},
        7
      )
    ).rejects.toThrow("URL 与当前记录不一致")
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [18] }, userId: 7 } })
    )
  })

  it("按 AiGatewayModel.gatewayConfig 校验并规范化动态模型参数", async () => {
    const validator = new PortraitTaskValidator({
      poolImage: { findMany: jest.fn() },
      aiGatewayModel: {
        findFirst: jest.fn().mockResolvedValue({
          publicId: "ZQ-Image-3",
          displayName: "ZQ-Image-3",
          gatewayConfig,
        }),
      },
    } as any, gateway as never)

    await expect(
      validator.validateTask(
        {
          prompt: "完整人像提示词",
          promptConfig: {
            schema_version: 1,
            creation_type: "SINGLE_PORTRAIT",
            modules: {},
            references: [],
            model_params: { quality: "standard" },
          },
          viewConfig: { description: "正面半身" },
          model: "ZQ-Image-3",
          quantity: 1,
        },
        7
      )
    ).resolves.toMatchObject({
      creationType: "SINGLE_PORTRAIT",
      references: [],
      modelParams: { quality: "standard", output_format: "png", aspect_ratio: "1:1", resolution: "1k" },
      deliveryPlan: { cropAnchor: "centre" },
    })
  })

  it.each([undefined, "4:3"])("显式交付目标覆盖旧比例 %s 和模型尺寸参数", async aspectRatio => {
    const validator = new PortraitTaskValidator({
      poolImage: { findMany: jest.fn() },
      aiGatewayModel: {
        findFirst: jest.fn().mockResolvedValue({
          publicId: "ZQ-Image-3",
          displayName: "ZQ-Image-3",
          gatewayConfig,
        }),
      },
    } as any, gateway as never)

    const result = await validator.validateTask(
      {
        prompt: "完整人像提示词",
        promptConfig: {
          schema_version: 1,
          creation_type: "SINGLE_PORTRAIT",
          modules: {},
          model_params: {
            aspect_ratio: "3:2",
            size: "1536x1024",
            width: 1536,
            height: 1024,
            resolution: "1k",
            resolution_tier: "4K",
            quality: "standard",
            output_format: "png",
          },
        },
        viewConfig: {},
        model: "ZQ-Image-3",
        aspectRatio,
        deliveryTarget: { aspectRatio: "970:600", resolutionTier: "2K" },
      },
      7
    )

    expect(result.modelParams).toEqual({
      aspect_ratio: "970:600",
      resolution: "2k",
      quality: "standard",
      output_format: "png",
    })
    expect(result.deliveryPlan).toMatchObject({
      requested: { aspectRatio: "970:600", resolutionTier: "2K" },
      cropAnchor: "centre",
    })
  })

  it("旧请求不传 deliveryTarget 时从 model_params 尺寸反推交付目标并规划", async () => {
    const validator = new PortraitTaskValidator({
      poolImage: { findMany: jest.fn() },
      aiGatewayModel: {
        findFirst: jest.fn().mockResolvedValue({
          publicId: "ZQ-Image-3",
          displayName: "ZQ-Image-3",
          gatewayConfig,
        }),
      },
    } as any, gateway as never)

    const result = await validator.validateTask(
      {
        prompt: "完整人像提示词",
        promptConfig: {
          schema_version: 1,
          creation_type: "SINGLE_PORTRAIT",
          modules: {},
          references: [],
          model_params: { size: "315x145", quality: "standard" },
        },
        viewConfig: {},
        model: "ZQ-Image-3",
        quantity: 1,
      },
      7
    )

    // 原始宽高保留为 315:145，清晰度仍按历史像素兼容推导为 1K。
    // 网关准入边界（短边 471 <512 等比抬升）后发精确 size，回调后裁回 1024x471
    expect(result.modelParams).toEqual({
      quality: "standard",
      aspect_ratio: "315:145", resolution: "1k",
      output_format: "png",
    })
    expect(result.deliveryPlan?.requested).toEqual({
      aspectRatio: "315:145",
      resolutionTier: "1K",
      width: 1024,
      height: 471,
    })
    expect(result.deliveryPlan?.delivery).toEqual(
      expect.objectContaining({ width: 1024, height: 471 })
    )
  })

  it("旧请求 model_params 尺寸参数无法解析时直接拒绝", async () => {
    const validator = new PortraitTaskValidator({
      poolImage: { findMany: jest.fn() },
      aiGatewayModel: {
        findFirst: jest.fn().mockResolvedValue({
          publicId: "ZQ-Image-3",
          displayName: "ZQ-Image-3",
          gatewayConfig,
        }),
      },
    } as any, gateway as never)

    await expect(
      validator.validateTask(
        {
          prompt: "完整人像提示词",
          promptConfig: {
            schema_version: 1,
            creation_type: "SINGLE_PORTRAIT",
            modules: {},
            references: [],
            model_params: { resolution: "abc" },
          },
          viewConfig: {},
          model: "ZQ-Image-3",
        },
        7
      )
    ).rejects.toThrow("格式应为 宽x高 像素或 1K～4K 档位")
  })

  it("根据用户交付目标规划模型参数并保存适配快照", async () => {
    const adaptationGatewayConfig = {
      detail: {
        facts: {
          modes: ["generate", "edit"],
          aspect_ratios: ["1:1", "3:4"],
          resolutions: ["1536x2048", "2048x2048"],
          qualities: ["standard"],
          output_formats: ["png"],
          max_images_per_request: 4,
        },
      },
      requestSchema: {
        request_schema: {
          type: "object",
          required: ["model"],
          properties: {
            model: { type: "string" },
            prompt: { type: "string" },
            operation: { enum: ["generate", "edit"] },
            n: { type: "integer", minimum: 1, maximum: 4 },
            callback: { type: "boolean" },
            size: { enum: ["1536x2048", "2048x2048"] },
            quality: { enum: ["standard"] },
            output_format: { enum: ["png"] },
            aspect_ratio: { enum: ["1:1", "3:4"] },
          },
          additionalProperties: false,
        },
      },
    }
    const validator = new PortraitTaskValidator({
      poolImage: { findMany: jest.fn() },
      aiGatewayModel: {
        findFirst: jest.fn().mockResolvedValue({
          publicId: "ZQ-Image-3",
          displayName: "ZQ-Image-3",
          gatewayConfig: adaptationGatewayConfig,
        }),
      },
    } as any, gateway as never)

    const result = await validator.validateTask(
      {
        prompt: "完整人像提示词",
        promptConfig: {
          schema_version: 1,
          creation_type: "SINGLE_PORTRAIT",
          modules: {},
          references: [],
          model_params: {
            aspect_ratio: "4:5",
            size: "9999x9999",
            quality: "standard",
          },
        },
        viewConfig: {},
        model: "ZQ-Image-3",
        deliveryTarget: {
          aspectRatio: "4:5",
          resolutionTier: "4K",
        },
      },
      7
    )

    // 网关 intent 口径（与通用生图同语义）：4:5 为十档比例 → aspect_ratio + resolution
    // intent 直发，模型目录的固定尺寸枚举不再约束提交参数；模型原生能力差异由
    // 回调后 AiGatewayImageArtifactService 按目标比例裁剪适配（永不放大）
    expect(result.modelParams).toEqual({
      quality: "standard",
      output_format: "png",
      aspect_ratio: "4:5",
      resolution: "4k",
    })
    expect(result.deliveryPlan?.requested).toEqual({
      aspectRatio: "4:5",
      resolutionTier: "4K",
      width: 3277,
      height: 4096,
    })
    expect(result.deliveryPlan?.providerApplied).toEqual({
      aspectRatio: "4:5",
      resolutionTier: "4k",
      size: null,
      width: null,
      height: null,
    })
    expect(result.deliveryPlan?.delivery).toEqual({
      width: 3277,
      height: 4096,
      strategy: "crop_to_ratio",
      nativeResolution: null,
    })
    expect(result.deliveryPlan?.warnings).toEqual([])
  })

  it("模型 facts 未声明原生比例时仍提交网关意图", async () => {
    const validator = new PortraitTaskValidator({
      poolImage: { findMany: jest.fn() },
      aiGatewayModel: {
        findFirst: jest.fn().mockResolvedValue({
          publicId: "ZQ-Image-3",
          displayName: "ZQ-Image-3",
          gatewayConfig,
        }),
      },
    } as any, gateway as never)

    await expect(
      validator.validateTask(
        {
          prompt: "完整人像提示词",
          promptConfig: {
            schema_version: 1,
            creation_type: "SINGLE_PORTRAIT",
            modules: {},
            references: [],
            model_params: { aspect_ratio: "1:1" },
          },
          viewConfig: {},
          model: "ZQ-Image-3",
        },
        7
      )
    ).resolves.toMatchObject({ modelParams: { aspect_ratio: "1:1", resolution: "1k" } })
  })

  it("动态模型参数不能覆盖后端控制字段", async () => {
    const validator = new PortraitTaskValidator({
      poolImage: { findMany: jest.fn() },
      aiGatewayModel: { findFirst: jest.fn().mockResolvedValue({}) },
    } as any, gateway as never)

    await expect(
      validator.validateTask(
        {
          prompt: "完整人像提示词",
          promptConfig: {
            schema_version: 1,
            creation_type: "SINGLE_PORTRAIT",
            modules: {},
            references: [],
            model_params: { callback: false },
          },
          viewConfig: {},
          model: "ZQ-Image-3",
        },
        7
      )
    ).rejects.toThrow("model_params.callback 由后端控制")
  })

  it("参考图数量超过所选模型上限时拒绝", async () => {
    const validator = new PortraitTaskValidator({
      poolImage: { findMany: jest.fn() },
      aiGatewayModel: {
        findFirst: jest.fn().mockResolvedValue({
          publicId: "ZQ-Image-2",
          displayName: "ZQ-Image-2",
          gatewayConfig,
        }),
      },
    } as any, gateway as never)

    const references = [1, 2, 3, 4].map(index => ({
      source_type: "UPLOAD",
      url: `https://example.com/ref-${index}.png`,
      purpose: "参考五官",
    }))

    await expect(
      validator.validateTask(
        {
          prompt: "完整人像提示词",
          promptConfig: {
            schema_version: 1,
            creation_type: "SINGLE_PORTRAIT",
            modules: {},
            references,
          },
          viewConfig: {},
          model: "ZQ-Image-2",
          quantity: 1,
        },
        7
      )
    ).rejects.toThrow("最多支持 3 张参考图")
  })

  it("参考图超过 3 张但模型允许时正常通过", async () => {
    const permissiveGatewayConfig = {
      detail: {
        facts: {
          modes: ["generate", "edit"],
          resolutions: ["2048x2048"],
          qualities: ["standard"],
          output_formats: ["png"],
          max_reference_images: 14,
          max_images_per_request: 4,
        },
      },
      requestSchema: {
        request_schema: {
          type: "object",
          required: ["model"],
          properties: {
            model: { type: "string" },
            prompt: { type: "string" },
            operation: { enum: ["generate", "edit"] },
            n: { type: "integer", minimum: 1, maximum: 4 },
            callback: { type: "boolean" },
            size: { enum: ["2048x2048"] },
            quality: { enum: ["standard"] },
            output_format: { enum: ["png"] },
            reference_images: { type: "array" },
          },
          additionalProperties: false,
        },
      },
    }
    gateway.fetchModelSnapshot.mockResolvedValue({
      detail: { modality: "image", ...permissiveGatewayConfig.detail },
      requestSchema: permissiveGatewayConfig.requestSchema,
    })
    const validator = new PortraitTaskValidator({
      poolImage: { findMany: jest.fn() },
      aiGatewayModel: {
        findFirst: jest.fn().mockResolvedValue({
          publicId: "ZQ-Image-1",
          displayName: "ZQ-Image-1",
          gatewayConfig: permissiveGatewayConfig,
        }),
      },
    } as any, gateway as never)

    const references = [1, 2, 3, 4, 5, 6].map(index => ({
      source_type: "UPLOAD",
      url: `https://example.com/ref-${index}.png`,
      purpose: "参考五官",
    }))

    const result = await validator.validateTask(
      {
        prompt: "完整人像提示词",
        promptConfig: {
          schema_version: 1,
          creation_type: "SINGLE_PORTRAIT",
          modules: {},
          references,
        },
        viewConfig: {},
        model: "ZQ-Image-1",
        quantity: 1,
      },
      7
    )

    expect(result.references).toHaveLength(6)
  })

  it("多张成功图片一次创建成一个多图模板", async () => {
    const images = [
      {
        id: 11,
        url: "https://example.com/11.png",
        task: { id: 3, prompt: "prompt-11", aspectRatio: "3:4", imageLabelBase: null },
      },
      {
        id: 12,
        url: "https://example.com/12.png",
        task: { id: 4, prompt: "prompt-12", aspectRatio: "1:1", imageLabelBase: null },
      },
    ]
    const templateCreate = jest.fn().mockResolvedValue({ id: 88 })
    const tx = {
      generatedImage: { findMany: jest.fn().mockResolvedValue(images) },
      imageTemplate: {
        create: templateCreate,
        findUnique: jest.fn().mockResolvedValue({ id: 88, items: [{ id: 1 }, { id: 2 }] }),
      },
      imageTemplateGroup: {},
    }
    const prisma = {
      imageProject: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          userId: 7,
          type: "PORTRAIT",
          status: "COMPLETED",
          name: "林夏",
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    }
    const service = new PortraitCreationService(
      prisma as any,
      {} as any,
      {} as any,
      usage as any,
      {} as PortraitImageGenerator
    )

    const result = await service.saveToTemplate(
      1,
      { imageIds: [11, 12], mode: "CREATE", templateName: "林夏职业写真" },
      7
    )

    expect(templateCreate).toHaveBeenCalledTimes(1)
    const createData = templateCreate.mock.calls[0][0].data
    expect(createData.items.create).toHaveLength(2)
    expect(
      createData.items.create.map((item: { refImageUrl: string }) => item.refImageUrl)
    ).toEqual(["https://example.com/11.png", "https://example.com/12.png"])
    expect(result).toEqual({ id: 88, items: [{ id: 1 }, { id: 2 }] })
  })
})
