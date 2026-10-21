import { normalizeCdqImageCriterion } from "./listing-cdq-image-score"

function createImageCriterion() {
  return {
    description: "主图长边297px，未达1000px放大标准；副图7张，覆盖场景、细节、尺寸、包装等，覆盖度良好。",
    score: 1.6667,
    deductions: [
      { points: 3, reason: "主图长边297px，未达到1000px的放大门槛" },
      { points: 3, reason: "主图非纯白底（存在阴影与倒影）" },
      { points: 7.3333, reason: "副图数量7张，覆盖度分折算" },
    ],
  }
}

describe("图片数量与覆盖度扣分", () => {
  it("7张且明确覆盖四类时移除无依据扣分，仅保留主图两项，结果9/15", () => {
    const criterion = createImageCriterion()
    const mainDeductions = criterion.deductions.slice(0, 2)
    normalizeCdqImageCriterion(criterion)
    expect(criterion.score).toBe(9)
    expect(criterion.deductions).toEqual(mainDeductions)
    normalizeCdqImageCriterion(criterion)
    expect(criterion.score).toBe(9)
  })

  it("真实数量不足和覆盖缺失的扣分保留", () => {
    const criterion = {
      description: "副图4张，覆盖场景、细节、尺寸，未覆盖包装。",
      score: 13.25,
      deductions: [
        { points: 1, reason: "副图数量4张，未达6张" },
        { points: 0.75, reason: "副图覆盖度缺少包装清单" },
      ],
    }
    const original = structuredClone(criterion)
    normalizeCdqImageCriterion(criterion)
    expect(criterion).toEqual(original)
  })

  it("覆盖证据不足时不猜测满分，超出6分的副图扣分拒绝通过", () => {
    const criterion = createImageCriterion()
    criterion.description = "副图7张，覆盖类型无法确认。"
    expect(() => normalizeCdqImageCriterion(criterion)).toThrow("图片扣分超过对应检查点满分")
    expect(criterion.score).toBe(1.6667)
  })

  it("7张副图的独立数量扣分移除，明确缺少包装仍保留", () => {
    const criterion = {
      description: "副图7张，覆盖场景、细节、尺寸，未覆盖包装。",
      score: 13.25,
      deductions: [
        { points: 1, reason: "副图数量7张，数量不足" },
        { points: 0.75, reason: "副图覆盖度缺少包装清单" },
      ],
    }
    normalizeCdqImageCriterion(criterion)
    expect(criterion.score).toBe(14.25)
    expect(criterion.deductions).toEqual([{ points: 0.75, reason: "副图覆盖度缺少包装清单" }])
  })

  it("张数达标不抹掉副图具体画质问题", () => {
    const criterion = {
      description: "副图7张，覆盖场景、细节、尺寸、包装。",
      score: 14,
      deductions: [{ points: 1, reason: "副图数量7张，但副图2的文字模糊" }],
    }
    const original = structuredClone(criterion)
    normalizeCdqImageCriterion(criterion)
    expect(criterion).toEqual(original)
  })

  it("不会把套装充电盒和像素不足再算作主图合规扣分", () => {
    const criterion = { description: "主图包含耳机及充电盒，尺寸297×355", score: 6,
      deductions: [
        { points: 6, ruleId: "image.compliance", reason: "主图包含充电盒，非纯产品展示，且像素未达标" },
        { points: 3, ruleId: "image.zoom", reason: "主图长边小于1000px" },
      ],
    }
    normalizeCdqImageCriterion(criterion)
    expect(criterion.score).toBe(12)
    expect(criterion.deductions).toHaveLength(1)
    expect(criterion.deductions[0].ruleId).toBe("image.zoom")
  })

  it("有明确白底违规证据时保留主图合规扣分，按ruleId区分分辨率检查点", () => {
    const criterion = { description: "主图灰色背景，尺寸297×355", score: 6,
      deductions: [
        { points: 6, ruleId: "image.compliance", reason: "主图非纯白底，像素297×355" },
        { points: 3, ruleId: "image.zoom", reason: "主图长边小于1000px" },
      ],
    }
    normalizeCdqImageCriterion(criterion)
    expect(criterion.score).toBe(6)
    expect(criterion.deductions).toHaveLength(2)
  })

  it("白底达标但以高清合规再次扣像素分时，只保留可放大扣分并同步说明", () => {
    const criterion = {
      description: "主图长边355px（<1000px）无法放大，扣3分；主图合规（纯白底、无水印、占比合规），扣3分；副图7张。",
      score: 9,
      deductions: [
        { points: 3, ruleId: "image.compliance", reason: "主图虽为白底，但长边仅355px，未达到高清合规要求" },
        { points: 3, ruleId: "image.zoom", reason: "主图长边小于1000px，不支持放大" },
      ],
    }
    normalizeCdqImageCriterion(criterion)
    expect(criterion.score).toBe(12)
    expect(criterion.deductions).toHaveLength(1)
    expect(criterion.description).toContain("主图合规（纯白底、无水印、占比合规），不扣分")
    normalizeCdqImageCriterion(criterion)
    expect(criterion.score).toBe(12)
  })
})
