import { BadRequestException } from "@nestjs/common"
import axios from "axios"
import { lookup } from "dns/promises"
import { Agent } from "https"
import type { LookupFunction } from "net"
import { AiSplitValidator } from "./ai-split.validator"

jest.mock("dns/promises", () => ({ lookup: jest.fn() }))

const gateway = {
  fetchModelSnapshot: jest.fn().mockResolvedValue({
    detail: { modality: "image", facts: {} },
    requestSchema: { request_schema: { type: "object", properties: {} } },
  }),
}

describe("AiSplitValidator", () => {
  const requestSchema = {
    type: "object",
    additionalProperties: false,
    required: ["model"],
    properties: {
      model: { type: "string" },
      prompt: { type: "string" },
      operation: { enum: ["edit"] },
      n: { type: "integer", minimum: 1, maximum: 4 },
      callback: { type: "boolean" },
      reference_images: { type: "array" },
      aspect_ratio: { enum: ["1:1", "3:4"] },
      size: { enum: ["2048x2048", "1728x2304"] },
      quality: { enum: ["standard", "hd"] },
      output_format: { enum: ["png"] },
    },
  }

  function setup() {
    const prisma = {
      aiGatewayModel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 8,
          publicId: "ZQ-Image-3",
          displayName: "ZQ-Image-3",
          gatewayConfig: {
            detail: {
              facts: {
                modes: ["generate", "edit"],
                max_reference_images: 14,
                max_images_per_request: 10,
                supports_negative_prompt: true,
              },
            },
            requestSchema: { request_schema: requestSchema },
          },
        }),
      },
    }
    const spaces = {}
    return {
      prisma,
      validator: new AiSplitValidator(prisma as never, spaces as never, gateway as never),
    }
  }

  const productImages = [
    {
      id: 1,
      index: 1,
      url: "https://example.com/main.png",
      purpose: "PRODUCT_MAIN",
      description: null,
    },
  ]

  it.each([
    ["1K", 819, 1024],
    ["2K", 1638, 2048],
  ])(
    "旧目录参考图请求 4:5 × %s 走网关 intent（不再按目录就近映射）",
    async (tier, width, height) => {
      const { validator } = setup()
      const result = await validator.validateImageModel(
        {
          model: "ZQ-Image-Ultra",
          quantity: 1,
          promptConfig: { model_params: { aspect_ratio: "4:5", resolution: tier } },
        },
        productImages
      )
      // 旧目录 facts/Schema enum 不再约束提交参数：4:5 为十档比例 → intent 直发，
      // 模型能力差异由网关就近解析、回调后按目标比例裁回
      expect(result.modelParams).toEqual({ aspect_ratio: "4:5", resolution: tier.toLowerCase() })
      expect(result.deliveryPlan?.requested).toEqual({
        aspectRatio: "4:5",
        resolutionTier: tier,
        width,
        height,
      })
      expect(result.deliveryPlan?.warnings).toEqual([])
    }
  )

  it("显式像素与结构化比例冲突时拒绝提交", async () => {
    const { validator } = setup()
    await expect(
      validator.validateImageModel(
        {
          model: "ZQ-Image-Ultra",
          quantity: 1,
          promptConfig: { model_params: { aspect_ratio: "4:5", size: "1024x1536" } },
        },
        productImages
      )
    ).rejects.toThrow("图片比例冲突")
  })

  describe("validateDirectImageUrl", () => {
    const url = "https://cdn.example.com/competitor.png"
    const png = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
    png.writeUInt32BE(1024, 16)
    png.writeUInt32BE(1024, 20)

    afterEach(() => {
      jest.restoreAllMocks()
      jest.mocked(lookup).mockReset()
    })

    it.each([
      { address: "93.184.216.34", family: 4, all: true },
      { address: "93.184.216.34", family: 4, all: false },
      { address: "2606:4700:4700::1111", family: 6, all: true },
      { address: "2606:4700:4700::1111", family: 6, all: false },
    ])("固定已校验的 IPv$family 地址，兼容 all=$all", async ({ address, family, all }) => {
      const target = { address, family }
      jest.mocked(lookup).mockResolvedValue([target])
      const get = jest.spyOn(axios, "get").mockResolvedValue({
        data: png,
        headers: { "content-type": "image/png" },
      })
      const { validator } = setup()

      await expect(validator.validateDirectImageUrl(url)).resolves.toEqual({
        url,
        contentType: "image/png",
        fileSize: png.length,
        width: 1024,
        height: 1024,
      })
      const agent = get.mock.calls[0][1]?.httpsAgent as Agent
      const pinnedLookup = agent.options.lookup as LookupFunction
      const callback = jest.fn()
      pinnedLookup("cdn.example.com", { all }, callback)
      if (all) expect(callback).toHaveBeenCalledWith(null, [target])
      else expect(callback).toHaveBeenCalledWith(null, address, family)
      expect(lookup).toHaveBeenCalledTimes(1)
    })

    it("DNS 结果混有内网地址时仍拒绝下载", async () => {
      jest.mocked(lookup).mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ])
      const get = jest.spyOn(axios, "get")
      const { validator } = setup()

      await expect(validator.validateDirectImageUrl(url)).rejects.toEqual(
        new BadRequestException("竞品图地址不允许访问内网或保留地址")
      )
      expect(get).not.toHaveBeenCalled()
    })

    it("仍禁止跟随重定向", async () => {
      jest.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }])
      const get = jest.spyOn(axios, "get").mockRejectedValue(new Error("HTTP 302"))
      const { validator } = setup()

      await expect(validator.validateDirectImageUrl(url)).rejects.toEqual(
        new BadRequestException("竞品图地址无法直接访问或返回了重定向")
      )
      expect(get).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ maxRedirects: 0, proxy: false })
      )
    })
  })

  it("按 AI_SPLIT 类别和真实 requestSchema 校验用户生图参数", async () => {
    const { prisma, validator } = setup()

    const result = await validator.validateImageModel(
      {
        model: "ZQ-Image-3",
        quantity: 2,
        promptConfig: {
          model_params: {
            aspect_ratio: "1:1",
            size: "2048x2048",
            quality: "hd",
            output_format: "png",
          },
        },
      },
      productImages
    )

    expect(prisma.aiGatewayModel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ publicId: "ZQ-Image-3", category: "AI_SPLIT" }),
      })
    )
    // 网关 intent 口径：model_params 原始尺寸键剥离后注入 aspect_ratio + resolution
    expect(result.modelParams).toEqual({
      aspect_ratio: "2048:2048",
      resolution: "2k",
      quality: "hd",
      output_format: "png",
    })
    expect(result.deliveryPlan?.requested).toEqual({
      aspectRatio: "2048:2048",
      resolutionTier: "2K",
      width: 2048,
      height: 2048,
    })
    expect(result.supportsNegativePrompt).toBe(true)
  })

  it.each([
    { size: "1536x1024" },
    { width: 1536, height: 1024 },
    { resolution: "1k", resolution_tier: "4K" },
  ])("显式交付目标覆盖旧比例及尺寸参数：%j", async legacySizing => {
    const { prisma } = setup()
    const validator = new AiSplitValidator(prisma as never, {} as never, {
      fetchModelSnapshot: jest.fn().mockResolvedValue({
        detail: { modality: "image", facts: {} },
        requestSchema: { request_schema: requestSchema },
      }),
    } as never)

    const result = await validator.validateImageModel(
      {
        model: "ZQ-Image-3",
        quantity: 1,
        promptConfig: {
          model_params: {
            aspect_ratio: "3:2",
            ...legacySizing,
            quality: "standard",
            output_format: "png",
          },
        },
        deliveryTarget: { aspectRatio: "970:600", resolutionTier: "2K" },
      },
      productImages
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

  it("模型固定尺寸枚举不含请求目标时仍走网关 intent（不再按目录就近）", async () => {
    const fixedSizeSchema = {
      type: "object",
      additionalProperties: false,
      required: ["model"],
      properties: {
        model: { type: "string" },
        prompt: { type: "string" },
        operation: { enum: ["edit"] },
        n: { type: "integer", minimum: 1, maximum: 4 },
        callback: { type: "boolean" },
        reference_images: { type: "array" },
        aspect_ratio: { enum: ["1:1", "4:3", "3:4", "3:2"] },
        resolution: { enum: ["2048x2048", "2304x1728", "1728x2304", "4096x4096"] },
        output_format: { enum: ["png"] },
      },
    }
    const prisma = {
      aiGatewayModel: {
        findFirst: jest.fn().mockResolvedValue({
          id: 8,
          publicId: "ZQ-Image-4",
          displayName: "ZQ-Image-4",
          gatewayConfig: {
            detail: {
              facts: {
                modes: ["generate", "edit"],
                aspect_ratios: ["1:1", "4:3", "3:4"],
                resolutions: ["2048x2048", "2304x1728", "1728x2304", "4096x4096"],
                output_formats: ["png"],
              },
            },
            requestSchema: { request_schema: fixedSizeSchema },
          },
        }),
      },
    }
    const validator = new AiSplitValidator(prisma as never, {} as never, gateway as never)

    const result = await validator.validateImageModel(
      {
        model: "ZQ-Image-4",
        quantity: 1,
        promptConfig: { model_params: { aspect_ratio: "1536:1024", resolution: "1536x1024" } },
      },
      productImages
    )

    // 3:2 / 1536x1024 均不在上游路由支持列表内：像素串归一为 3:2 + 2K 档位，
    // 走网关 intent（3:2 为十档比例），由网关就近解析、回调后裁剪适配；
    // 提交参数经 normalizeGatewayImageSizing 校验后原样通过
    expect(result.modelParams).toEqual({
      aspect_ratio: "1536:1024",
      resolution: "2k",
      output_format: "png",
    })
    expect(result.deliveryPlan?.requested).toEqual({
      aspectRatio: "1536:1024",
      resolutionTier: "2K",
      width: 2048,
      height: 1365,
    })
    expect(result.deliveryPlan?.providerApplied).toEqual({
      aspectRatio: "1536:1024",
      resolutionTier: "2k",
      size: null,
      width: null,
      height: null,
    })
  })

  it("model_params 使用 width/height 数字形式时同样归一为比例+档位目标", async () => {
    const { validator } = setup()

    const result = await validator.validateImageModel(
      {
        model: "ZQ-Image-3",
        quantity: 1,
        promptConfig: { model_params: { width: 1600, height: 2000 } },
      },
      productImages
    )

    expect(result.deliveryPlan?.requested).toEqual({
      aspectRatio: "1600:2000",
      resolutionTier: "2K",
      width: 1638,
      height: 2048,
    })
    // 原始 width/height 由规划器剥离，不透传给网关
    expect(result.modelParams).not.toHaveProperty("width")
    expect(result.modelParams).not.toHaveProperty("height")
  })

  it("model_params 未声明档位时补 1K 并冻结比例交付计划", async () => {
    const { validator } = setup()

    const result = await validator.validateImageModel(
      {
        model: "ZQ-Image-3",
        quantity: 1,
        promptConfig: { model_params: { aspect_ratio: "1:1" } },
      },
      productImages
    )

    expect(result.modelParams).toEqual({ aspect_ratio: "1:1", resolution: "1k" })
    expect(result.deliveryPlan).toMatchObject({ cropAnchor: "centre" })
  })

  it("拒绝前端通过 model_params 覆盖回调等受保护字段", async () => {
    const { validator } = setup()

    await expect(
      validator.validateImageModel(
        {
          model: "ZQ-Image-3",
          quantity: 1,
          promptConfig: { model_params: { callback: false } },
        },
        productImages
      )
    ).rejects.toEqual(
      new BadRequestException("promptConfig.model_params.callback 由后端控制，不能传入")
    )
  })

  it("竞品素材引用严格按项目隔离校验", async () => {
    let findWhere: Record<string, unknown> | null = null
    const validator = new AiSplitValidator({
      poolImage: {
        findFirst: jest.fn((args: { where: Record<string, unknown> }) => {
          findWhere = args.where
          return Promise.resolve(null)
        }),
      },
    } as never, {} as never, gateway as never)

    await expect(
      validator.resolveCompetitorReferences(
        [{ sourceType: "COMPETITOR_DATA", sourceId: 123 } as never],
        136,
        7
      )
    ).rejects.toEqual(new BadRequestException("所选竞品素材不存在或没有可用图片"))
    expect(findWhere).toEqual({ id: 123, userId: 7, projectId: 136, url: { not: null } })
  })

  describe("buildProjectSnapshot — 站点语言动态推导", () => {
    function projectSetup(site: string) {
      const project = {
        id: 31,
        name: "电动车项目",
        userId: 7,
        type: "ECOMMERCE",
        status: "ACTIVE",
        productProfile: {
          productName: "户外电动车",
          sku: "SK1",
          brandName: "BrandX",
          categoryL1: "户外",
          categoryL2: "代步",
          categoryL3: "",
          targetCountries: [],
          ecommercePlatforms: [],
          commerce: {},
          attributes: {},
          sellingPoints: ["高负重"],
          certifications: [],
          audience: "",
          extra: {},
          defaultLocale: "zh-CN",
          localizations: [
            { locale: "zh-CN", content: { productName: "户外电动车", sellingPoints: ["高负重"] } },
            {
              locale: "es-MX",
              content: {
                productName: "Patinete eléctrico todo terreno",
                sellingPoints: ["Alta carga"],
              },
            },
            { locale: "en-US", content: { productName: "Outdoor e-scooter" } },
          ],
        },
        productImages: [
          {
            id: 1,
            order: 0,
            url: "https://example.com/main.png",
            purpose: "PRODUCT_MAIN",
            note: null,
            tag: null,
            isPrimary: true,
            deletedAt: null,
          },
        ],
      }
      const prisma = {
        imageProject: { findUnique: jest.fn().mockResolvedValue(project) },
      }
      const validator = new AiSplitValidator(prisma as never, {} as never, gateway as never)
      return { validator, call: () => validator.buildProjectSnapshot(31, 7, site) }
    }

    it("旧枚举外的新站点（TIKTOK_MX）零改动生效：locale/language 按国家码推导，资料取对应本地化", async () => {
      const { validator, call } = projectSetup("TIKTOK_MX")
      const snapshot = await call()
      expect(snapshot.locale).toBe("es-MX")
      expect(snapshot.language).toBe("Spanish (es-MX)")
      expect((snapshot.currentProduct as { productName?: string }).productName).toBe(
        "Patinete eléctrico todo terreno"
      )
      expect((snapshot.currentProduct as { sellingPoints?: string[] }).sellingPoints).toEqual([
        "Alta carga",
      ])
      expect(validator).toBeDefined()
    })

    it("旧站点 AMAZON_US：locale en-US，无对应卖点本地化时资料字段回落默认 locale", async () => {
      const { call } = projectSetup("AMAZON_US")
      const snapshot = await call()
      expect(snapshot.locale).toBe("en-US")
      expect(snapshot.language).toBe("English (en-US)")
      expect((snapshot.currentProduct as { productName?: string }).productName).toBe(
        "Outdoor e-scooter"
      )
      // en-US 本地化没填卖点 → 回落 defaultLocale（zh-CN）内容
      expect((snapshot.currentProduct as { sellingPoints?: string[] }).sellingPoints).toEqual([
        "高负重",
      ])
    })

    it("国家码查不到（AMAZON_ZZ）：locale 回落 en-US、语言标签兜底 English，资料回落默认 locale", async () => {
      const { call } = projectSetup("AMAZON_ZZ")
      const snapshot = await call()
      expect(snapshot.locale).toBe("en-US")
      expect(snapshot.language).toBe("English (en-US)")
      expect((snapshot.currentProduct as { productName?: string }).productName).toBe(
        "Outdoor e-scooter"
      )
    })
  })
})
