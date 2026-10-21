import { prepareListingScoreDelivery } from "./listing-score-delivery"
import { CDQ_DIMENSION_METADATA } from "./listing-score-correction"

function createReport() {
  return {
    scoreVersion: "cdq-2026-09-16", total: 100, potential: "评分", suggestions: [],
    dimensions: CDQ_DIMENSION_METADATA.map(metadata => ({
      name: metadata.name, maxScore: metadata.maxScore, weight: metadata.maxScore, score: metadata.maxScore,
      criteria: metadata.criteria.map(([name, maxScore]) => ({
        name: String(name), maxScore: maxScore as number | null | undefined,
        score: maxScore as number | null, status: "VERIFIED", description: "测试说明",
        deductions: [] as Array<{ points: number; reason: string }>,
      })),
    })),
  }
}

describe("评分交付的未获取项固定满分恢复", () => {
  it.each([-4.0714, 4])("描述分值 %s 无可靠证据时暂不评分并正常交付，不能截成0或满分", score => {
    const report = createReport()
    report.dimensions[3].criteria[2].score = score
    const delivered = JSON.parse(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us")!)
    expect(delivered.dimensions[3].criteria[2].score).toBeNull()
    expect(delivered.total).toBeNull()
  })

  it.each([-1.05, 0, 2, 3])("描述扣1分时按同一公式得2分，不采用模型独立填的%s分", score => {
    const report = createReport()
    Object.assign(report.dimensions[3].criteria[2], { score, deductions: [
      { points: 1, reason: "缺少结构化规格段", ruleId: "alexa.description", evidence: "描述仅有PRODUCT OVERVIEW" },
    ] })
    const delivered = JSON.parse(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us")!)
    expect(delivered.dimensions[3].criteria[2].score).toBe(2)
    expect(delivered.dimensions[3].score).toBe(14)
    expect(delivered.total).toBe(99)
  })

  it.each([-4.0714, 0, 3])("相同描述和取证按相同规则重算，不依赖模型给的分值 %s", score => {
    const report = createReport()
    Object.assign(report.dimensions[3].criteria[2], {
      score,
      assessment: { checks: [
        { checkId: "specifications", isPresent: true, quotes: ["**Material:** Chiffon"] },
        { checkId: "overview_scenes", isPresent: true, quotes: ["weekend garden parties", "summer beach vacations"] },
      ] },
    })
    const sourceFacts = {
      title: "Floral skirt", itemHighlights: "", bullets: [], searchTerms: "",
      description: "For weekend garden parties and summer beach vacations.\n**Material:** Chiffon",
    }
    const delivered = JSON.parse(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us", { sourceFacts })!)
    expect(delivered.dimensions[3].criteria[2]).toMatchObject({ score: 3, deductions: [] })
    expect(delivered.total).toBe(delivered.dimensions.reduce((sum: number, dimension: { score: number }) => sum + dimension.score, 0))
  })

  it.each(["细则超分", "维度负分", "扣分为负"])("%s 不会阻断报告，算术可重算则重算否则暂不评分", scenario => {
    const report = createReport()
    if (scenario === "细则超分") report.dimensions[1].criteria[0].score = 8
    if (scenario === "维度负分") report.dimensions[1].score = -1
    if (scenario === "扣分为负") report.dimensions[1].criteria[0].deductions = [{ points: -1, reason: "异常扣分" }]
    const delivered = JSON.parse(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us")!)
    expect(delivered.dimensions[1].score).toBe(scenario === "维度负分" ? 25 : null)
    expect(delivered.total).toBe(scenario === "维度负分" ? 100 : null)
  })

  it.each([null, undefined])("变体、图片、A+空满分 %s 不阻断完整报告，保留空得分及原始输入", missingLimit => {
    const report = createReport()
    for (const index of [2, 3, 4]) {
      Object.assign(report.dimensions[0].criteria[index], { maxScore: missingLimit, score: null, status: "UNAVAILABLE" })
    }
    const originalText = JSON.stringify(report)
    const delivered = JSON.parse(prepareListingScoreDelivery(originalText, "amazon_us")!)
    expect(delivered.dimensions[0].criteria.map((criterion: { maxScore: number }) => criterion.maxScore)).toEqual([30, 25, 20, 15, 5, 5])
    for (const index of [2, 3, 4]) expect(delivered.dimensions[0].criteria[index]).toMatchObject({ score: null, status: "UNAVAILABLE", deductions: [] })
    expect(delivered.dimensions[0].cdq).toMatchObject({ effectiveMax: 60, earnedScore: 60 })
    expect(JSON.stringify(report)).toBe(originalText)
  })

  it.each(["已评分", "有扣分", "未知名称", "未知版本", "少一项", "其他维度", "满分为零", "非法不适用"])("%s 可正常展示已有内容及固定满分，不触发页面错误", scenario => {
    const report = createReport()
    const criterion = report.dimensions[0].criteria[3]
    Object.assign(criterion, { maxScore: null, score: null, status: "UNAVAILABLE" })
    if (scenario === "已评分") criterion.score = 1
    if (scenario === "有扣分") criterion.deductions = [{ points: 1, reason: "测试" }]
    if (scenario === "未知名称") criterion.name = "未知项"
    if (scenario === "未知版本") report.scoreVersion = "unknown"
    if (scenario === "少一项") report.dimensions[0].criteria.pop()
    if (scenario === "其他维度") report.dimensions[1].criteria[0].maxScore = null
    if (scenario === "满分为零") criterion.maxScore = 0
    if (scenario === "非法不适用") criterion.status = "NOT_APPLICABLE"
    const delivered = JSON.parse(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us")!)
    expect(delivered.dimensions.map((item: { criteria: unknown[] }) => item.criteria.length)).toEqual([6, 5, 3, 3])
    if (["少一项", "非法不适用"].includes(scenario)) expect(delivered.total).toBeNull()
  })

  it("明确不适用的变体和A+仍不参与满分计算", () => {
    const report = createReport()
    for (const index of [2, 4]) Object.assign(report.dimensions[0].criteria[index], { maxScore: null, score: null, status: "NOT_APPLICABLE" })
    const delivered = JSON.parse(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us")!)
    expect(delivered.dimensions[0].cdq).toMatchObject({ applicableMax: 75, effectiveMax: 75, earnedScore: 75 })
  })
})


describe("描述评分与扣分理由来自同一份判断", () => {
  const sourceFacts = { title: "Floral skirt", bullets: ["Chiffon"], itemHighlights: "", searchTerms: "",
    description: "PRODUCT OVERVIEW: For garden parties and summer beach vacations.\nMaterial: Chiffon" }
  it.each([{ deductions: [] }, { deductions: [{ points: 0, reason: "无扣分" }] }])("截图中2分但没有有效扣分明细时暂不评分，不能编造原因或补满分", ({ deductions }) => {
    const report = createReport()
    Object.assign(report.dimensions[3].criteria[2], { score: 2, description: "描述结构合规，包含场景与规格。", deductions })
    const delivered = JSON.parse(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us", { sourceFacts })!)
    expect(delivered.dimensions[3].criteria[2]).toMatchObject({ score: null, status: "PENDING", deductions: [],
      description: "本项未返回可核对的扣分依据，暂未评分。" })
    expect(delivered.dimensions[3].score).toBeNull()
    expect(delivered.total).toBeNull()
    expect(JSON.parse(prepareListingScoreDelivery(JSON.stringify(delivered), "amazon_us", { sourceFacts })!)).toEqual(delivered)
  })
  it.each([[true, true, 3], [true, false, 2], [false, true, 2], [false, false, 1]] as const)("规格%s、场景%s时由原文判断统一给%s分及对应明细", (hasSpecifications, hasScenes, score) => {
    const report = createReport()
    Object.assign(report.dimensions[3].criteria[2], { score: 2, description: "描述结构合规，包含场景与规格。", deductions: [],
      assessment: { checks: [
        { checkId: "specifications", isPresent: hasSpecifications, quotes: hasSpecifications ? ["Material: Chiffon"] : [] },
        { checkId: "overview_scenes", isPresent: hasScenes, quotes: hasScenes ? ["garden parties", "summer beach vacations"] : [] },
      ] },
    })
    const source = { ...sourceFacts, description: (hasScenes ? "For garden parties and summer beach vacations." : "Floral skirt.") +
      (hasSpecifications ? "\nMaterial: Chiffon" : "") }
    const delivered = JSON.parse(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us", { sourceFacts: source })!)
    expect(delivered.dimensions[3].criteria[2].score).toBe(score)
    expect(delivered.dimensions[3].criteria[2].deductions.map((item: { points: number }) => item.points)).toEqual(Array(3 - score).fill(1))
    if (!hasSpecifications) expect(delivered.dimensions[3].criteria[2].description).toContain("结构化规格段缺失")
    if (!hasScenes) expect(delivered.dimensions[3].criteria[2].description).toContain("具体场景缺失")
    expect(delivered.total).toBe(97 + score)
  })
  it("有明确扣分明细时纠正矛盾的达标说明，扣分理由正常交付", () => {
    const report = createReport()
    Object.assign(report.dimensions[3].criteria[2], { score: 2, description: "描述结构合规，包含场景与规格。", deductions: [
      { points: 1, reason: "缺少结构化规格段", ruleId: "alexa.description", evidence: "description仅有场景" },
    ] })
    const delivered = JSON.parse(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us")!)
    expect(delivered.dimensions[3].criteria[2]).toMatchObject({ score: 2, description: "缺少结构化规格段", deductions: [{ points: 1, reason: "缺少结构化规格段" }] })
  })
})
