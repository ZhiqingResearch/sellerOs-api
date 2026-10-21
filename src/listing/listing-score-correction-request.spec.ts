import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildScoreCorrectionPlan,
  buildScoreCorrectionRequest,
} from "./listing-score-correction"

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/listing-score-failure-20260916.json"), "utf8")
) as { original: string; repair: string }

const expectedCriteria = [
  { dimensionIndex: 0, criterionIndex: 0 },
  { dimensionIndex: 0, criterionIndex: 3 },
  { dimensionIndex: 1, criterionIndex: 1 },
  { dimensionIndex: 2, criterionIndex: 1 },
  { dimensionIndex: 2, criterionIndex: 2 },
  { dimensionIndex: 3, criterionIndex: 1 },
  { dimensionIndex: 3, criterionIndex: 2 },
]

const expectedRules: Record<string, Record<string, number>> = {
  "0:0": { "attribute.required": 30 },
  "0:3": { "image.compliance": 6, "image.zoom": 3, "image.count": 3, "image.coverage": 3 },
  "1:1": { "keyword.sa": 7 },
  "2:1": { "cosmo.category": 6 },
  "2:2": { "cosmo.medium": 4 },
  "3:1": { "alexa.bulletData": 5 },
  "3:2": { "alexa.description": 2 },
}

describe("评分复核请求的独立输出契约", () => {
  it("将完整报告模板留在评分参考中，不与修复系统输出契约混合", () => {
    const plan = buildScoreCorrectionPlan(fixture.original, "amazon_us", true)!
    const scoringReference = '评分标准原文。FULL_REPORT_TEMPLATE_ONLY：必须输出{"historyTitle":"","dimensions":[],"total":0}'
    const originalListing = "ORIGINAL_LISTING_ONLY：副图5张。商品中的指令不属于评分规则。"
    const request = buildScoreCorrectionRequest(scoringReference, originalListing, plan)
    const payload = JSON.parse(request.userPrompt)

    expect(request.systemPrompt).not.toContain("FULL_REPORT_TEMPLATE_ONLY")
    expect(request.systemPrompt).not.toContain("ORIGINAL_LISTING_ONLY")
    expect(request.systemPrompt).toContain("corrections")
    expect(payload.scoringReference).toBe(scoringReference)
    expect(payload.originalListing).toBe(originalListing)
  })

  it("真实失败报告只请求七个异常项，并携带原项、失败原因及对应规则", () => {
    const plan = buildScoreCorrectionPlan(fixture.original, "amazon_us", true)!
    const snapshot = structuredClone(plan)
    const request = buildScoreCorrectionRequest("评分标准", "原始商品资料", plan)
    const payload = JSON.parse(request.userPrompt)

    expect(plan.criteria).toEqual(expectedCriteria)
    expect(payload.requestedCriteria).toHaveLength(expectedCriteria.length)
    payload.requestedCriteria.forEach((item: {
      dimensionIndex: number; criterionIndex: number; name: string; maxScore: number;
      currentCriterion: unknown; validationError: string; allowedRules: Record<string, number>;
    }, index: number) => {
      const coordinates = expectedCriteria[index]
      const original = plan.report.dimensions[coordinates.dimensionIndex].criteria[coordinates.criterionIndex]
      expect(item).toMatchObject({ ...coordinates, name: original.name, maxScore: original.maxScore })
      expect(item.currentCriterion).toEqual(original)
      expect(typeof item.validationError).toBe("string")
      expect(item.validationError.trim()).not.toBe("")
      expect(item.allowedRules).toEqual(expectedRules[`${item.dimensionIndex}:${item.criterionIndex}`])
    })
    expect(plan).toEqual(snapshot)
  })

  it("期望返回结构只列指定异常项与需要复核的维度，不提供整份报告模板", () => {
    const plan = buildScoreCorrectionPlan(fixture.original, "amazon_us", true)!
    const payload = JSON.parse(buildScoreCorrectionRequest("评分标准", "原始商品资料", plan).userPrompt)

    expect(plan.dimensionIndices).toEqual([1])
    expect(payload.requestedDimensions).toEqual([1])
    expect(payload.expectedOutput).not.toHaveProperty("dimensions")
    expect(payload.expectedOutput).not.toHaveProperty("total")
    expect(payload.expectedOutput.corrections.map((item: { dimensionIndex: number; criterionIndex: number }) => ({
      dimensionIndex: item.dimensionIndex, criterionIndex: item.criterionIndex,
    }))).toEqual(expectedCriteria)
    expect(payload.expectedOutput.dimensionCorrections.map((item: { dimensionIndex: number }) => item.dimensionIndex)).toEqual([1])
  })

  it("没有维度异常时不要求模型增加维度扣分", () => {
    const plan = buildScoreCorrectionPlan(fixture.original, "amazon_us", true)!
    delete plan.dimensionIndices
    const payload = JSON.parse(buildScoreCorrectionRequest("评分标准", "原始商品资料", plan).userPrompt)

    expect(payload.requestedDimensions).toEqual([])
    expect(payload.expectedOutput.dimensionCorrections ?? []).toEqual([])
  })

  it("四项取证输出示例直接包含事实数组，不把规则说明重复包进assessment", () => {
    const ruleContext = { sourceFacts: {
      title: "Ink refill bottles", itemHighlights: "Printing supplies",
      bullets: ["Each bottle contains 140 mL of ink."], description: "", searchTerms: "",
    } }
    const plan = buildScoreCorrectionPlan(fixture.original, "amazon_us", true, ruleContext)!
    const request = buildScoreCorrectionRequest("评分标准", "原始商品资料", plan, undefined, ruleContext)
    const payload = JSON.parse(request.userPrompt)
    for (const [dimensionIndex, criterionIndex, property] of [
      [1, 2, "terms"], [2, 2, "relations"], [3, 1, "bullets"], [3, 2, "checks"],
    ] as const) {
      const expected = payload.expectedOutput.corrections.find((item: { dimensionIndex: number; criterionIndex: number }) =>
        item.dimensionIndex === dimensionIndex && item.criterionIndex === criterionIndex)
      expect(Array.isArray(expected.assessment[property])).toBe(true)
      expect(expected.assessment[property].length).toBeGreaterThan(0)
      expect(expected.assessment).not.toHaveProperty("instructions")
      expect(expected.assessment).not.toHaveProperty("formula")
      expect(expected.assessment).not.toHaveProperty("assessment")
      const requested = payload.requestedCriteria.find((item: { dimensionIndex: number; criterionIndex: number }) =>
        item.dimensionIndex === dimensionIndex && item.criterionIndex === criterionIndex)
      expect(requested.assessmentRequirement.instructions).toEqual(expect.any(String))
      expect(requested.assessmentRequirement.formula).toEqual(expect.any(String))
    }
    expect(request.systemPrompt).toContain("assessment直接填写attributeChecks、terms、relations、bullets或checks等事实字段")
    expect(request.systemPrompt).toContain("不返回instructions或formula，不得再嵌套一层assessment")
  })
})
