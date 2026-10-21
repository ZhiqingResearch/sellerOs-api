import { ServiceUnavailableException } from "@nestjs/common"
import { gatewayImageRequestSizing } from "../ai-gateway/gateway-image-sizing"
import { AiSplitValidator } from "./ai-split.validator"
import { buildPortraitImageTaskRequest } from "./portrait-image-generator"
import { PortraitTaskValidator } from "./portrait-task.validator"
import type { PortraitDeliveryTarget } from "./portrait-size-planner"

function snapshot(ratios = ["2:3", "21:9"], resolutions = ["2k", "4k"]) {
  return {
    detail: { modality: "image", facts: {
      modes: ["generate", "edit"], qualities: ["standard"], output_formats: ["png"],
    } },
    requestSchema: { request_schema: {
      type: "object", additionalProperties: false, required: ["model", "quality", "output_format"],
      properties: {
        model: { type: "string" }, prompt: { type: "string" },
        operation: { enum: ["generate", "edit"] }, n: { type: "integer", maximum: 4 },
        callback: { type: "boolean" }, reference_images: { type: "array" },
        aspect_ratio: { enum: ratios }, resolution: { enum: resolutions },
        quality: { enum: ["standard"], default: "standard" }, output_format: { enum: ["png"] },
      },
    } },
  }
}

describe.each(["portrait", "ai-split"] as const)("%s 统一尺寸意图", kind => {
  function setup(model = "gpt-image-2.5-flare") {
    const gateway = { fetchModelSnapshot: jest.fn().mockResolvedValue(snapshot()) }
    const localConfig = snapshot(["1:1"], ["1k"])
    // 本地目录仍是旧能力，原生判断应以本次查询结果为准。
    const prisma = { aiGatewayModel: { findFirst: jest.fn().mockResolvedValue({
      id: 8, publicId: model, displayName: "Flare", gatewayConfig: localConfig,
    }) } }
    const portrait = new PortraitTaskValidator(prisma as never, gateway as never)
    const split = new AiSplitValidator(prisma as never, {} as never, gateway as never)
    const validate = (params: Record<string, unknown> = {}, target?: PortraitDeliveryTarget) => kind === "portrait"
      ? portrait.validateTask({
          model, prompt: "保留商品完整", quantity: 2,
          promptConfig: { schema_version: 1, creation_type: "SINGLE_PORTRAIT", modules: {}, references: [], model_params: params },
          viewConfig: {}, deliveryTarget: target,
        } as never, 7)
      : split.validateImageModel({
          model, quantity: 2,
          promptConfig: { model_params: params }, deliveryTarget: target,
        } as never, [{ id: 1, index: 1, url: "https://cdn.test/product.png", purpose: "PRODUCT_MAIN", description: null }])
    return { validate, gateway }
  }

  describe.each(["ZQ-Image-Ultra", "ZQ-Image-Ultra-Backup", "ZQ-Image-1", "gpt-image-2.5-flare"])(
    "%s 显式交付目标优先于所有旧尺寸字段",
    model => {
      it.each<Record<string, unknown>>([
        { aspect_ratio: "463:625", size: "1728x2304" },
        { aspect_ratio: "3:2", size: "1728x2304", resolution: "1k" },
        { aspect_ratio: "3:2", size: "1K", resolution: "4k", resolution_tier: "1K" },
        { size: "1728x2304", resolution: "2048x614", width: 1920, height: 1080 },
        { aspect_ratio: "0:0", size: "invalid", resolution: "invalid", width: -1, height: 0 },
      ])("创建到网关提交均忽略冲突旧字段：%j", async legacySizing => {
        const { validate } = setup(model)
        const params = { ...legacySizing, quality: "standard", output_format: "png" }
        const original = structuredClone(params)
        const result = await validate(params, { aspectRatio: "463:625", resolutionTier: "2K" })
        expect(result.modelParams).toEqual({
          aspect_ratio: "463:625", resolution: "2k", quality: "standard", output_format: "png",
        })
        expect(result.deliveryPlan).toMatchObject({
          cropAnchor: "centre", requested: { aspectRatio: "463:625", resolutionTier: "2K" },
        })
        const request = gatewayImageRequestSizing(buildPortraitImageTaskRequest({
          model, prompt: "保留商品完整", quantity: 2,
          referenceImages: [], modelParams: result.modelParams,
        }) as unknown as Record<string, unknown>)
        expect(request).toMatchObject({ model, aspect_ratio: "463:625", resolution: "2k", strict: false })
        for (const key of ["size", "width", "height", "resolution_tier"])
          expect(request).not.toHaveProperty(key)
        expect(params).toEqual(original)
      })
    }
  )

  it.each([
    { aspectRatio: "0:1", resolutionTier: "2K" },
    { aspectRatio: "463:625", resolutionTier: "8K" },
  ])("覆盖旧尺寸时仍拒绝非法交付目标 %j", async target => {
    const { validate } = setup()
    await expect(validate({ size: "1728x2304", quality: "standard" }, target as PortraitDeliveryTarget))
      .rejects.toThrow()
  })

  it.each([{ callback: false }, { quality: "invalid" }])("尺寸覆盖不绕过其他参数校验 %j", async params => {
    const { validate } = setup()
    await expect(validate(params, { aspectRatio: "463:625", resolutionTier: "2K" })).rejects.toThrow()
  })

  it("显式比例档位命中实时能力时不降档，冻结比例交付及模型默认参数", async () => {
    const { validate, gateway } = setup()
    const result = await validate({}, { aspectRatio: "2:3", resolutionTier: "4K" })
    expect(gateway.fetchModelSnapshot).toHaveBeenCalledWith("gpt-image-2.5-flare", "images.generations")
    expect(result.modelParams).toEqual({ aspect_ratio: "2:3", resolution: "4k", quality: "standard", output_format: "png" })
    expect(result.deliveryPlan).toMatchObject({ cropAnchor: "centre",
      requested: { aspectRatio: "2:3", resolutionTier: "4K" },
      delivery: { strategy: "crop_to_ratio" }, warnings: [],
    })
  })

  it("自定义宽高原值传给网关，不约分、不限制比例位数", async () => {
    const { validate } = setup()
    const result = await validate({}, { aspectRatio: "2048:614", resolutionTier: "2K" })
    expect(result.modelParams).toMatchObject({ aspect_ratio: "2048:614", resolution: "2k" })
    expect(result.deliveryPlan?.requested.aspectRatio).toBe("2048:614")
  })

  it("旧比例档位参数同样直传，并保留 21:9 原值", async () => {
    const { validate } = setup()
    const result = await validate({ aspect_ratio: "21:9", resolution: "2k" })
    expect(result.modelParams).toMatchObject({ aspect_ratio: "21:9", resolution: "2k" })
    expect(result.deliveryPlan).toMatchObject({ cropAnchor: "centre", requested: { aspectRatio: "21:9" } })
    expect(result.deliveryPlan?.cropAnchor).toBe("centre")
  })

  it("清晰度按统一协议转为小写，仍检查交付比例", async () => {
    const { validate, gateway } = setup()
    gateway.fetchModelSnapshot.mockResolvedValue(snapshot(["21:9"], ["2K"]))
    const result = await validate({}, { aspectRatio: "21:9", resolutionTier: "2K" })
    expect(result.modelParams).toMatchObject({ aspect_ratio: "21:9", resolution: "2k" })
    expect(result.deliveryPlan?.cropAnchor).toBe("centre")
  })

  it("连续创建使用本次最新 Schema，相同 $id 的能力更新不影响后续请求", async () => {
    const { validate, gateway } = setup()
    const first = snapshot()
    const second = snapshot(["21:9"], ["2k"])
    for (const current of [first, second])
      Object.assign(current.requestSchema.request_schema, { $id: "https://gateway.test/image-schema" })
    gateway.fetchModelSnapshot.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    expect((await validate({}, { aspectRatio: "2:3", resolutionTier: "4K" })).deliveryPlan?.cropAnchor).toBe("centre")
    const result = await validate({}, { aspectRatio: "21:9", resolutionTier: "2K" })
    expect(result.modelParams).toMatchObject({ aspect_ratio: "21:9", resolution: "2k" })
    expect(result.deliveryPlan?.cropAnchor).toBe("centre")
    expect(gateway.fetchModelSnapshot).toHaveBeenCalledTimes(2)
  })

  it("原生能力不匹配时仍将用户档位交给网关", async () => {
    const { validate, gateway } = setup()
    gateway.fetchModelSnapshot.mockResolvedValue(snapshot(["1:1"], ["1k"]))
    const result = await validate({ quality: "standard" }, { aspectRatio: "2:3", resolutionTier: "4K" })
    expect(result.modelParams).toMatchObject({ aspect_ratio: "2:3", resolution: "4k" })
    expect(result.deliveryPlan?.nativeSizing).toBeUndefined()
    expect(result.deliveryPlan?.warnings).toEqual([])
    expect(result.deliveryPlan?.delivery.strategy).toBe("crop_to_ratio")
  })

  it("操作与数量组合不通过 Schema 时拒绝请求", async () => {
    const { validate, gateway } = setup()
    const current = snapshot()
    Object.assign(current.requestSchema.request_schema, { allOf: [{
      if: { properties: { n: { const: 2 } } },
      then: { properties: { resolution: { const: "2k" } } },
    }] })
    gateway.fetchModelSnapshot.mockResolvedValue(current)
    await expect(validate({ quality: "standard" }, { aspectRatio: "2:3", resolutionTier: "4K" }))
      .rejects.toThrow("生图参数与模型配置不兼容")
  })

  it("历史像素字段即使反推出支持的比例档位，也不进入原生分支", async () => {
    const { validate, gateway } = setup()
    gateway.fetchModelSnapshot.mockResolvedValue(snapshot(["4:5"], ["2k"]))
    const result = await validate({ width: 1600, height: 2000, quality: "standard" })
    expect(gateway.fetchModelSnapshot).not.toHaveBeenCalled()
    expect(result.modelParams).toMatchObject({ aspect_ratio: "1600:2000", resolution: "2k" })
    expect(result.deliveryPlan?.nativeSizing).toBeUndefined()
  })

  it("显式指定像素继续沿用原有拒绝行为", async () => {
    const { validate, gateway } = setup()
    await expect(validate({}, { customSizeMode: "pixels", customWidth: 1600, customHeight: 2000 }))
      .rejects.toThrow("不再支持指定像素输出")
    expect(gateway.fetchModelSnapshot).not.toHaveBeenCalled()
  })

  it("查询失败时不假定原生支持", async () => {
    const { validate, gateway } = setup()
    gateway.fetchModelSnapshot.mockRejectedValue(new ServiceUnavailableException("能力查询失败"))
    await expect(validate({}, { aspectRatio: "2:3", resolutionTier: "4K" })).rejects.toThrow("能力查询失败")
  })
})
