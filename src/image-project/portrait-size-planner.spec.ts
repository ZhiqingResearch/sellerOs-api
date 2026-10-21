import { BadRequestException } from "@nestjs/common"
import {
  normalizePortraitDeliveryTarget,
  planPortraitSizing,
  ratioTierFromDimensions,
  tierFromLongestSide,
} from "./portrait-size-planner"

describe("normalizePortraitDeliveryTarget", () => {
  it("比例 + 档位 → 原始比例与目标像素（档位 = 长边）", () => {
    expect(normalizePortraitDeliveryTarget({ aspectRatio: "4:5", resolutionTier: "2K" })).toEqual({
      aspectRatio: "4:5",
      resolutionTier: "2K",
      width: 1638,
      height: 2048,
    })
  })

  it("自定义比例保留原始宽高", () => {
    expect(
      normalizePortraitDeliveryTarget({ aspectRatio: "1600:2000", resolutionTier: "1K" })
    ).toEqual({
      aspectRatio: "1600:2000",
      resolutionTier: "1K",
      width: 819,
      height: 1024,
    })
  })

  it("拒绝指定像素输出（统一 ratio 模式）", () => {
    expect(() =>
      normalizePortraitDeliveryTarget({
        customSizeMode: "pixels",
        customWidth: 1600,
        customHeight: 2000,
      })
    ).toThrow("不再支持指定像素输出")
  })

  it("ratio 模式缺比例或档位时报错", () => {
    expect(() => normalizePortraitDeliveryTarget({ resolutionTier: "2K" })).toThrow(
      "比例模式必须填写图片比例"
    )
    expect(() => normalizePortraitDeliveryTarget({ aspectRatio: "4:5" })).toThrow(
      "比例模式必须填写清晰度档位"
    )
  })

  it("拒绝非法格式，比例能力交给网关", () => {
    expect(() =>
      normalizePortraitDeliveryTarget({ aspectRatio: "0:5", resolutionTier: "1K" })
    ).toThrow(BadRequestException)
    expect(() =>
      normalizePortraitDeliveryTarget({ aspectRatio: "10001:1", resolutionTier: "1K" })
    ).not.toThrow()
    // 不在项目内限制比例范围。
    expect(() =>
      normalizePortraitDeliveryTarget({ aspectRatio: "1:10000", resolutionTier: "4K" })
    ).not.toThrow()
  })
})

describe("tierFromLongestSide / ratioTierFromDimensions", () => {
  it("像素长边 → 就近档位，平手向上取高档位", () => {
    expect(tierFromLongestSide(1024)).toBe("1K")
    expect(tierFromLongestSide(2048)).toBe("2K")
    expect(tierFromLongestSide(4096)).toBe("4K")
    // 1536 与 1K/2K 等距 → 平手向上取 2K
    expect(tierFromLongestSide(1536)).toBe("2K")
  })

  it("旧像素目标保留原始宽高 + 就近档位", () => {
    expect(ratioTierFromDimensions(1600, 2000)).toEqual({
      aspectRatio: "1600:2000",
      resolutionTier: "2K",
    })
  })
})

describe("planPortraitSizing（网关 intent 口径，与通用生图同语义）", () => {
  it.each(["21:9", "5:4", "4:5", "10:3", "3:10"])("特殊比例 %s 在新快照记中心裁剪", aspectRatio => {
    const { deliveryPlan } = planPortraitSizing({
      target: { aspectRatio, resolutionTier: "2K" }, modelParams: {},
    })
    expect(deliveryPlan.cropAnchor).toBe("centre")
    expect(deliveryPlan.requested.aspectRatio).toBe(aspectRatio)
  })

  it("3K 档降档 2k 并透出警告（网关枚举仅 1k/2k/4k）", () => {
    const { providerModelParams, deliveryPlan } = planPortraitSizing({
      target: { aspectRatio: "1:1", resolutionTier: "3K" },
      modelParams: {},
    })
    expect(providerModelParams.resolution).toBe("2k")
    expect(deliveryPlan.warnings).toEqual(["清晰度档位 3K 已下线，已按 2K 档生成"])
  })

  it("极端比例（>8:1）且约分后 ≤2 位数/边 → 回退 intent", () => {
    // 10:1 @1K → 1024x102，短边 <512 抬到 512 后长边 5140 >4096 截断；
    // 约分后 10:1 每边 ≤2 位数 → 发 intent，比例交给网关就近解析
    const { providerModelParams } = planPortraitSizing({
      target: { aspectRatio: "10:1", resolutionTier: "1K" },
      modelParams: {},
    })
    expect(providerModelParams).toEqual({ aspect_ratio: "10:1", resolution: "1k" })
  })

})

describe("planPortraitSizing + modelId（已核验尺寸能力预检，2026-09-22）", () => {

  it("未登记模型零行为变化（4k intent 原样，无能力 warnings）", () => {
    const plan = planPortraitSizing({
      target: { aspectRatio: "2:3", resolutionTier: "4K" },
      modelParams: {},
      modelId: "ZQ-Image-2",
    })
    expect(plan.providerModelParams).toMatchObject({ aspect_ratio: "2:3", resolution: "4k" })
    expect(plan.deliveryPlan.warnings).toEqual([])
  })
})

describe("统一人像与拆图尺寸意图", () => {
  it.each(["ZQ-Image-2", "gpt-image-2.5-flare"])("%s 不在本地降档", modelId => {
    const result = planPortraitSizing({ target: { aspectRatio: "2:3", resolutionTier: "4K" }, modelId,
      modelParams: { size: "1024x1024", quality: "standard", width: 1024, height: 1024 } })
    expect(result.providerModelParams).toEqual({ aspect_ratio: "2:3", resolution: "4k", quality: "standard" })
    expect(result.deliveryPlan).toMatchObject({ cropAnchor: "centre", delivery: { strategy: "crop_to_ratio" }, warnings: [] })
  })
  it("自定义比例统一提交，不推导 size", () => {
    const result = planPortraitSizing({ target: { aspectRatio: "11:10", resolutionTier: "2K" }, modelParams: {} })
    expect(result.providerModelParams).toEqual({ aspect_ratio: "11:10", resolution: "2k" })
  })
})
