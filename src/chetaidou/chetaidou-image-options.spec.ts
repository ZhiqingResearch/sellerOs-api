import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common"
import {
  ChetaidouImageOptionsService,
  generationCanvasPrompt,
  imageSelectionHashFields,
  planChetaidouImage,
  reduceImageRatio,
  resolveImageSelection,
} from "./chetaidou-image-options.service"

export const imageModelFixture = {
  publicId: "gpt-image-2.5-sunburst",
  category: "CHETAIDOU_IMAGE",
  modality: "IMAGE",
  enabled: true,
  gatewayActive: true,
  gatewayConfig: {
    detail: { facts: { modes: ["generate", "edit"] } },
    requestSchema: {
      version: 7,
      request_schema: {
        type: "object",
        required: ["model", "prompt", "operation", "reference_images"],
        additionalProperties: false,
        properties: {
          model: { type: "string" },
          prompt: { type: "string" },
          operation: { enum: ["generate", "edit"] },
          n: { const: 1 },
          callback: { const: true },
          response_format: { const: "url" },
          reference_images: { type: "array", minItems: 1 },
          aspect_ratio: { enum: ["1:1"] },
          resolution: { enum: ["1k"] },
          size: { enum: ["1024x1024"] },
          quality: { enum: ["standard", "hd"], default: "standard" },
        },
      },
    },
  },
}

describe("车泰斗生图参数与模型", () => {
  it("母版比例由前端传实际值；自定义是比例，不是像素", () => {
    expect(reduceImageRatio(166, 182)).toBe("83:91")
    expect(
      resolveImageSelection({ aspectRatio: "custom", customAspectW: 166, customAspectH: 182 })
    ).toMatchObject({ ratio: "166:182", tier: "1K" })
    expect(() => resolveImageSelection({ aspectRatio: "original" })).toThrow(BadRequestException)
    expect(() => resolveImageSelection({})).toThrow("必须由前端传入")
  })
  it.each(["0:1", "1:0", "1.5:2", "NaN:1", "9007199254740992:1", "", "-1:2"])(
    "拒绝非法比例 %s",
    aspectRatio => {
      expect(() => resolveImageSelection({ aspectRatio })).toThrow(BadRequestException)
    }
  )
  it("拒绝缺失/非法 custom 字段及非 custom 的附加字段", () => {
    for (const params of [
      { aspectRatio: "custom" },
      { aspectRatio: "custom", customAspectW: 2, customAspectH: 0 },
      { aspectRatio: "1:1", customAspectW: 2 },
      { aspectRatio: null },
      { aspectRatio: "1:1", resolutionTier: null },
    ]) {
      expect(() => resolveImageSelection(params as any)).toThrow(BadRequestException)
    }
  })
  it("显式字段才参与幂等哈希，缺省兼容旧任务", () => {
    expect(imageSelectionHashFields({})).toEqual({})
    expect(imageSelectionHashFields({ aspectRatio: " 32:18 ", resolutionTier: " 2k " })).toEqual({
      aspectRatio: "16:9",
      resolutionTier: "2K",
    })
  })
  it("3K 兼容转换并提示；非法档位拒绝", () => {
    expect(resolveImageSelection({ aspectRatio: "1:1", resolutionTier: "3k" })).toMatchObject({
      tier: "2K",
      warnings: [expect.stringContaining("3K")],
    })
    expect(() => resolveImageSelection({ aspectRatio: "1:1", resolutionTier: "8K" })).toThrow(
      BadRequestException
    )
  })

  it("仅模型 Schema 必填质量时使用默认值，缺默认则模型未就绪", () => {
    const model = structuredClone(imageModelFixture)
    model.gatewayConfig.requestSchema.request_schema.required.push("quality")
    expect(planChetaidouImage(model, { aspectRatio: "1:1" }, 1).providerDefaults).toEqual({
      quality: "standard",
    })
    delete (model.gatewayConfig.requestSchema.request_schema.properties.quality as any).default
    expect(() => planChetaidouImage(model, { aspectRatio: "1:1" }, 1)).toThrow(
      ServiceUnavailableException
    )
  })
  it("无 Schema、Schema 无效或仅支持 generate 时提前阻止任务", () => {
    expect(() =>
      planChetaidouImage({ publicId: "m", gatewayConfig: {} }, { aspectRatio: "1:1" }, 1)
    ).toThrow(ServiceUnavailableException)
    const model = structuredClone(imageModelFixture)
    model.gatewayConfig.detail.facts.modes = ["generate"]
    expect(() => planChetaidouImage(model, { aspectRatio: "1:1" }, 1)).toThrow("不支持参考图编辑")
  })
  it.each(["standard", "hd"])("显式质量 %s 归一、校验并冻结", quality => {
    const input = { aspectRatio: "1:1", quality: ` ${quality.toUpperCase()} ` }
    expect(imageSelectionHashFields(input)).toEqual({ aspectRatio: "1:1", quality })
    expect(planChetaidouImage(imageModelFixture, input, 4)).toMatchObject({
      count: 4,
      quality,
      providerDefaults: {},
    })
  })
  it.each(["", "auto", "high", "low", null, 1, {}, []])("拒绝非法质量 %j", quality => {
    expect(() => imageSelectionHashFields({ quality } as any)).toThrow(BadRequestException)
  })
  it("显式质量覆盖必填默认值；不支持的质量在落库前返回 400", () => {
    const model = structuredClone(imageModelFixture)
    model.gatewayConfig.requestSchema.request_schema.required.push("quality")
    expect(planChetaidouImage(model, { aspectRatio: "1:1", quality: "hd" }, 1)).toMatchObject({
      quality: "hd",
      providerDefaults: {},
    })
    model.gatewayConfig.requestSchema.request_schema.properties.quality.enum = ["standard"]
    expect(() => planChetaidouImage(model, { aspectRatio: "1:1", quality: "hd" }, 1)).toThrow(
      "当前生图模型不支持所选图片质量"
    )
    delete (model.gatewayConfig.requestSchema.request_schema.properties as any).quality
    expect(() => planChetaidouImage(model, { aspectRatio: "1:1", quality: "hd" }, 1)).toThrow(
      BadRequestException
    )
  })
  it("画布指令覆盖比例且保留原组合文本", () => {
    const prompt = "Preserve source aspect ratio. Keep the text unchanged."
    expect(generationCanvasPrompt(prompt, "16:9")).toContain(prompt)
    expect(generationCanvasPrompt(prompt, "16:9")).toContain("16:9")
    expect(generationCanvasPrompt(prompt, "16:9")).toContain("aspect ratio only")
  })
  it.each([
    [{ aspectRatio: "16:9" }, "16:9"],
    [{ aspectRatio: "9:16" }, "9:16"],
    [{ aspectRatio: "custom", customAspectW: 166, customAspectH: 182 }, "166:182"],
  ])("中心裁剪指令使用目标比例 %j，不使用模型适配后的比例", (selection, ratio) => {
    const plan = planChetaidouImage(imageModelFixture, selection, 1)
    const prompt = generationCanvasPrompt("Keep the text unchanged.", plan.aspectRatio)
    expect(prompt).toContain(`裁剪为${ratio}比例的图像画面`)
    expect(prompt).toContain("全部外轮廓均可见")
    expect(prompt).toContain("缩小商品在画面中的占比")
    expect(prompt).toContain("不得裁掉商品、人物、文字或其他重要信息")
    expect(prompt).not.toContain("{特殊比例}")
    expect(plan.generationPromptVersion).toBe("canvas-v2")
  })
  it("支持本地根引用与组合条件，仍验证实际完整请求", () => {
    const referenced = {
      publicId: "image",
      gatewayConfig: {
        requestSchema: {
          request_schema: {
            $ref: "#/$defs/editRequest",
            $defs: { editRequest: imageModelFixture.gatewayConfig.requestSchema.request_schema },
          },
        },
      },
    }
    expect(
      planChetaidouImage(referenced, { aspectRatio: "16:9", resolutionTier: "2K" }, 1)
        .providerApplied
    ).toMatchObject({ aspect_ratio: "16:9", resolution: "2k" })
    const branched = structuredClone(imageModelFixture) as any
    branched.gatewayConfig.requestSchema.request_schema.allOf = [
      {
        anyOf: [
          { properties: { operation: { const: "generate" } } },
          { properties: { operation: { const: "edit" }, n: { const: 1 } } },
        ],
      },
    ]
    expect(planChetaidouImage(branched, { aspectRatio: "16:9" }, 1)).toHaveProperty(
      "providerApplied"
    )
  })
  it("生成时按分类排序选择默认模型，允许多行，缺失时拒绝", async () => {
    const findMany = jest.fn().mockResolvedValue([imageModelFixture])
    const service = new ChetaidouImageOptionsService(
      { aiGatewayModel: { findMany } } as any,
      {} as any
    )
    expect(await service.resolveModel()).toEqual(imageModelFixture)
    expect(findMany).toHaveBeenCalledWith({
      where: { category: "CHETAIDOU_IMAGE", modality: "IMAGE", enabled: true, gatewayActive: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      take: 1,
    })
    findMany.mockResolvedValue([imageModelFixture, imageModelFixture])
    await expect(service.resolveModel()).resolves.toEqual(imageModelFixture)
    findMany.mockResolvedValue([])
    await expect(service.resolveModel()).rejects.toThrow(ServiceUnavailableException)
  })
  it("事务中重新锁定检查模型，配置变化则 409", async () => {
    const tx = {
      $queryRaw: jest.fn(),
      aiGatewayModel: { findMany: jest.fn().mockResolvedValue([imageModelFixture]) },
    }
    await expect(
      new ChetaidouImageOptionsService({} as any, {} as any).assertUnchanged(tx as any, "old")
    ).rejects.toThrow(ConflictException)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
  })
  it("停用旧模型阻止新重试，即使之前已经通过事务外预检", async () => {
    const tx = {
      $queryRaw: jest.fn(),
      aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
    }
    await expect(
      new ChetaidouImageOptionsService({} as any, {} as any).assertRetryModel(tx as any, {
        publicId: "old",
        category: "CHETAIDOU_IMAGE",
      })
    ).rejects.toThrow("原生图模型已停用")
    expect(tx.aiGatewayModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ publicId: "old", enabled: true, gatewayActive: true }),
      })
    )
  })
  it("实时读取图片模型能力，查询失败或模型下架时拒绝创建", async () => {
    const snapshot = { ...imageModelFixture.gatewayConfig, detail: { modality: "image" } }
    const gateway = { fetchModelSnapshot: jest.fn().mockResolvedValue(snapshot) }
    const service = new ChetaidouImageOptionsService({} as any, gateway as any)
    await expect(service.fetchCapabilities("image")).resolves.toEqual(snapshot)
    expect(gateway.fetchModelSnapshot).toHaveBeenCalledWith("image", "images.generations")
    gateway.fetchModelSnapshot.mockRejectedValueOnce(new Error("timeout"))
    await expect(service.fetchCapabilities("image")).rejects.toThrow("能力查询失败")
    gateway.fetchModelSnapshot.mockResolvedValueOnce(null)
    await expect(service.fetchCapabilities("image")).rejects.toThrow("模型未就绪")
  })
})

describe("车泰斗普通生图与重绘共用尺寸意图", () => {
  const model = { publicId: "gpt-image-2.5-sunburst", gatewayConfig: {
    detail: { facts: { modes: ["edit"] } },
    requestSchema: { request_schema: { type: "object", properties: {
      aspect_ratio: { enum: ["1:1"] }, resolution: { enum: ["1k"] },
    } } },
  } }
  it.each([undefined, { width: 1200, height: 800, referenceCount: 2 }])("普通和重绘都将 3:2 + 4K 交给网关适配", edit => {
    const result = planChetaidouImage(model, { aspectRatio: "3:2", resolutionTier: "4K" }, 1, "edit", edit)
    expect(result).toMatchObject({ providerApplied: { aspect_ratio: "3:2", resolution: "4k" }, normalizationMode: "CROP_ONLY", sizingAdjustments: [] })
    expect(result.providerApplied).not.toHaveProperty("size")
  })
  it("完整编辑请求仍校验操作约束", () => {
    const invalid = { ...model, gatewayConfig: { requestSchema: { request_schema: { type: "object", properties: { operation: { const: "generate" } } } } } }
    expect(() => planChetaidouImage(invalid, { aspectRatio: "16:9", resolutionTier: "2K" }, 1)).toThrow()
  })
})
