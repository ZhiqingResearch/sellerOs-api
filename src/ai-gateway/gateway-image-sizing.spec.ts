import {
  gatewayImageRequestSizing,
  gatewayImageSizingSchema,
  resolveGatewaySizingIntent,
  resolveGatewaySizingIntentDetailed,
} from "./gateway-image-sizing"

describe("resolveGatewaySizingIntent", () => {
  it("十档常用比例 + 档位 → aspect_ratio + resolution intent（3K 降档 2k）", () => {
    expect(resolveGatewaySizingIntent({ aspectRatio: "16:9", resolutionTier: "2K" })).toEqual({
      aspect_ratio: "16:9",
      resolution: "2k",
    })
    expect(resolveGatewaySizingIntent({ aspectRatio: "1:1", resolutionTier: "3K" })).toEqual({
      aspect_ratio: "1:1",
      resolution: "2k",
    })
    expect(resolveGatewaySizingIntent({ aspectRatio: "9:16", resolutionTier: "4k" })).toEqual({
      aspect_ratio: "9:16",
      resolution: "4k",
    })
  })

  it("极端可表达比例（>8:1、约分后 ≤2 位数/边）→ 回退 intent", () => {
    expect(resolveGatewaySizingIntent({ aspectRatio: "10:1", resolutionTier: "1K" })).toEqual({
      aspect_ratio: "10:1",
      resolution: "1k",
    })
  })

})

describe("统一图片尺寸意图", () => {
  it.each([
    ["16:9", "4K", "16:9", "4k"],
    ["21:9", "2K", "21:9", "2k"],
    ["3200:2000", "1K", "3200:2000", "1k"],
    ["10:3", "3K", "10:3", "2k"],
    ["1:1", undefined, "1:1", "1k"],
    ["2048:614", "2K", "2048:614", "2k"],
    ["463:45", "2K", "463:45", "2k"],
    ["1:20", "2K", "1:20", "2k"],
    ["123456:78901", "2K", "123456:78901", "2k"],
  ])("%s + %s 只发送比例和档位", (aspectRatio, resolutionTier, ratio, tier) => {
    expect(resolveGatewaySizingIntent({ aspectRatio: aspectRatio!, resolutionTier })).toEqual({ aspect_ratio: ratio, resolution: tier })
  })
  it.each(["0:1", "bad", "-1:2", "1:0"])("非法比例格式 %s 明确拒绝", aspectRatio => {
    expect(() => resolveGatewaySizingIntent({ aspectRatio })).toThrow()
  })
  it("模型能力不在本地改写用户档位", () => {
    expect(resolveGatewaySizingIntentDetailed({ aspectRatio: "2:3", resolutionTier: "4K", modelId: "gpt-image-2.5-flare" }))
      .toEqual({ sizing: { aspect_ratio: "2:3", resolution: "4k" }, adjustments: [] })
  })
})

describe("网关提交边界兼容旧字段", () => {
  it.each([
    [{ size: "1920x1080", strict: true }, "1920:1080", "2k"],
    [{ resolution: "1920x1080" }, "1920:1080", "2k"],
    [{ aspect_ratio: "16:9", size: "3K" }, "16:9", "2k"],
    [{ size: "2048x614" }, "2048:614", "2k"],
    [{ width: 3000, height: 2000, quality: "hd" }, "3000:2000", "4k"],
  ])("转换 %j 且不修改调用方参数", (params, ratio, tier) => {
    const before = { ...params }
    const request = gatewayImageRequestSizing(params)
    expect(request).toMatchObject({ aspect_ratio: ratio, resolution: tier, strict: false })
    expect(request).not.toHaveProperty("size")
    expect(request).not.toHaveProperty("width")
    expect(params).toEqual(before)
  })
  it("根引用下的原生枚举不会约束公共尺寸意图", () => {
    const schema = gatewayImageSizingSchema({ $ref: "#/$defs/image", $defs: { image: {
      type: "object", properties: { aspect_ratio: { enum: ["1:1"] }, resolution: { enum: ["1k"] } },
    } } })
    expect(schema.properties.aspect_ratio).not.toHaveProperty("enum")
    expect(schema.properties.resolution.enum).toEqual(["1k", "2k", "4k"])
  })
})
