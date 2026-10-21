import { buildScoreCorrectionPlan, buildScoreCorrectionRequest, CDQ_DIMENSION_METADATA, mergeScoreCorrection } from "./listing-score-correction"
import { getListingEvidenceError, getListingEvidenceRequirement, parseListingScoreSource, type ListingScoreSource } from "./listing-score-evidence"
import { projectListingReportEvidence } from "./listing-score-evidence-flow"
import { validateScoreReport } from "./listing-score-recovery"
import { validateListingReportRules } from "./listing-score-rules"

interface TestCriterion {
  name: string
  maxScore: number
  score: number | null
  status?: string
  description: string
  deductions: Array<{ ruleId: string; points: number; reason: string; evidence: string }>
  assessment?: Record<string, unknown>
}

function buildSource(): ListingScoreSource {
  return {
    mode: "standard", title: "502 ink refill bottles for office printers", itemHighlights: "",
    bullets: ["Refill ink bottles with 140 mL ink for office users."],
    description: "Capacity: 140 mL. Use in the home office. Use in the school classroom.", searchTerms: "",
    structuredAttributes: [
      { name: "Color", value: "Black" },
      { name: "Compatible Printer Models", value: "False" },
      { name: "Model Name", value: "Replacement for 502 ink refill bottles" },
      { name: "Page Yield", value: "35000" },
      { name: "Ink Type", value: "Dye" },
      { name: "ASIN", value: "REGRESSION-ONLY" },
      { name: "Best Sellers Rank", value: "#100" },
      { name: "Customer Reviews", value: "4.5 out of 5 stars (42)" },
    ],
  }
}

function buildAttributeAssessment(): Record<string, unknown> {
  return { attributeChecks: [
    { index: 1, weight: 3, errorType: "NONE", comparison: [], suggestion: "" },
    { index: 2, weight: 3, errorType: "TYPE_MISMATCH", comparison: [], suggestion: "用实际兼容型号替换布尔占位值False" },
    { index: 3, weight: 3, errorType: "PRODUCT_DESCRIPTION", comparison: [], suggestion: "型号字段填写502，不复述商品描述" },
    { index: 4, weight: 2, errorType: "PENDING", comparison: [], suggestion: "待确认页产量是单瓶还是整套口径" },
    { index: 5, weight: 2, errorType: "NONE", comparison: [], suggestion: "" },
  ] }
}

function buildReport(source: ListingScoreSource) {
  const report = {
    scoreVersion: "cdq-2026-09-16", mode: "standard", total: 100,
    suggestions: ["按原文完善属性"], potential: "S级",
    dimensions: CDQ_DIMENSION_METADATA.map((metadata, dimensionIndex) => ({
      name: metadata.name, maxScore: metadata.maxScore, weight: metadata.maxScore, score: metadata.maxScore,
      deductions: [], criteria: metadata.criteria.map(([name, maxScore]): TestCriterion => ({
        name, maxScore, score: maxScore, description: `${name}已依据原文评估`, deductions: [],
        ...(dimensionIndex === 0 ? { status: "VERIFIED" } : {}),
      })),
    })),
  }
  report.dimensions[1].criteria[2].assessment = { basis: "inferred", terms: [
    { term: "refill ink bottles", field: "bullets.1", quote: "Refill ink bottles" },
  ] }
  report.dimensions[2].criteria[2].assessment = { relations: [
    { type: "IS_A", field: "title", quote: "ink refill bottles" },
    { type: "USED_TO", field: "bullets.1", quote: "Refill" },
    { type: "USED_BY", field: "bullets.1", quote: "office users" },
    { type: "USED_FOR_EVE", field: "", quote: "" },
  ] }
  report.dimensions[3].criteria[1].assessment = { bullets: [{ index: 1, kind: "numeric", quote: "140 mL" }] }
  report.dimensions[3].criteria[2].assessment = { checks: [
    { checkId: "specifications", isPresent: true, quotes: ["Capacity: 140 mL"] },
    { checkId: "overview_scenes", isPresent: true, quotes: ["Use in the home office.", "Use in the school classroom."] },
  ] }
  return JSON.parse(validateScoreReport(projectListingReportEvidence(JSON.stringify(report), source), "amazon_us")) as typeof report
}

function buildSourcePrompt(source: Record<string, unknown>): string {
  return `mode：standard\n<listing-scoring-source>${JSON.stringify(source)}</listing-scoring-source>`
}

describe("结构化属性加权核算贯穿原文解析与局部恢复", () => {
  it("原始属性保留False、空字符串及统计行，不将原值改成缺失或预先删除统计证据", () => {
    const source = buildSource()
    source.structuredAttributes!.push({ name: "Special Features", value: "" })
    const parsed = parseListingScoreSource(buildSourcePrompt({ ...source }))!
    expect(parsed.structuredAttributes).toEqual(source.structuredAttributes)
    expect(parsed.structuredAttributes![1].value).toBe("False")
    expect(parsed.structuredAttributes!.at(-1)!.value).toBe("")
    expect(parsed.structuredAttributes!.slice(5, 8).map(item => item.name)).toEqual(["ASIN", "Best Sellers Rank", "Customer Reviews"])
    const requirement = getListingEvidenceRequirement(0, 0, parsed)
    expect(requirement?.assessment).toHaveProperty("attributeChecks")
  })

  it.each([
    null, "not-an-array", [], [null], [{ name: "Color", value: false }],
    [{ name: "Color", value: "Black" }, { name: "Unknown" }],
  ])("非法属性输入%s不进入新分母，也不破坏旧版原文字段解析", structuredAttributes => {
    const source = buildSource()
    const parsed = parseListingScoreSource(buildSourcePrompt({ ...source, structuredAttributes }))!
    expect(parsed.title).toBe(source.title)
    expect(parsed.bullets).toEqual(source.bullets)
    expect(parsed).not.toHaveProperty("structuredAttributes")
    expect(getListingEvidenceRequirement(0, 0, parsed)).toBeUndefined()
  })

  it("旧source不含属性字段时沿用既有输入，不增加属性assessment要求", () => {
    const { structuredAttributes: _attributes, ...legacySource } = buildSource()
    const parsed = parseListingScoreSource(buildSourcePrompt(legacySource))!
    expect(parsed).toEqual(legacySource)
    expect(getListingEvidenceRequirement(0, 0, parsed)).toBeUndefined()
  })

  it("首次投影用完整属性表覆盖错误得分及总括描述，统计行不参与分母，非CDQ保持不变", () => {
    const source = buildSource()
    const report = buildReport(source)
    const otherDimensions = structuredClone(report.dimensions.slice(1))
    Object.assign(report.dimensions[0].criteria[0], {
      score: 7, status: "UNAVAILABLE", description: "模型误写全部属性缺失且权重分母8",
      deductions: [], assessment: buildAttributeAssessment(),
    })
    const projected = JSON.parse(projectListingReportEvidence(JSON.stringify(report), source))
    const attribute = projected.dimensions[0].criteria[0]
    expect(attribute.score).toBe(19.6154)
    expect(attribute.status).toBe("MISSING")
    expect(attribute.description).not.toBe(report.dimensions[0].criteria[0].description)
    expect(attribute.assessment.attributePresentation.totalWeight).toBe(13)
    expect(attribute.description).toContain("本次取得5项前台可见属性")
    expect(attribute.deductions).toHaveLength(2)
    expect(attribute.deductions.map((item: { points: number }) => item.points)).toEqual([6.9231, 3.4615])
    expect(attribute.deductions.reduce((sum: number, item: { points: number }) => sum + item.points, 0)).toBeCloseTo(10.3846, 4)
    expect(projected.dimensions.slice(1)).toEqual(otherDimensions)
    const validated = JSON.parse(validateScoreReport(JSON.stringify(projected), "amazon_us"))
    expect(validated.dimensions[0].criteria[0]).toEqual(attribute)
    expect(() => validateListingReportRules(validated, { sourceFacts: source })).not.toThrow()
  })

  it("局部校对0:0采用同源属性公式，保留程序生成status和description，其余评分不变", () => {
    const source = buildSource()
    const report = buildReport(source)
    delete (report.dimensions[0].criteria[0] as { description?: string }).description
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true, { sourceFacts: source })!
    expect(plan.criteria).toEqual([{ dimensionIndex: 0, criterionIndex: 0 }])
    const request = buildScoreCorrectionRequest("属性规则", "属性原文", plan, undefined, { sourceFacts: source })
    expect(JSON.parse(request.userPrompt).requestedCriteria[0].assessmentRequirement.assessment).toHaveProperty("attributeChecks")
    const correction = { dimensionIndex: 0, criterionIndex: 0, score: 30, status: "VERIFIED",
      description: "模型错误地声称没有扣分", deductions: [], assessment: buildAttributeAssessment() }
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify({ corrections: [correction] }), plan, "amazon_us", true, { sourceFacts: source }))
    const attribute = result.dimensions[0].criteria[0]
    expect(attribute).toMatchObject({ score: 19.6154, status: "MISSING" })
    expect(attribute.description).not.toBe(correction.description)
    expect(attribute.assessment.attributePresentation.totalWeight).toBe(13)
    expect(attribute.description).toContain("本次取得5项前台可见属性")
    expect(attribute.deductions).toHaveLength(2)
    expect(result.dimensions[0].criteria.slice(1)).toEqual(report.dimensions[0].criteria.slice(1))
    expect(result.dimensions.slice(1)).toEqual(report.dimensions.slice(1))
    expect(result.suggestions).toEqual(report.suggestions)
    expect(() => validateListingReportRules(result, { sourceFacts: source })).not.toThrow()
  })

  it.each([undefined, { attributeChecks: [] }, { attributeChecks: [{ index: 1, weight: 3, errorType: "NONE", comparison: [], suggestion: "" }] }])(
    "旧JSON无完整attributeChecks时不新增校验拦截：%s", assessment => {
      const source = buildSource()
      const report = buildReport(source)
      const criterion = report.dimensions[0].criteria[0]
      if (assessment) criterion.assessment = assessment
      const before = structuredClone(criterion)
      expect(getListingEvidenceError(0, 0, criterion, source)).toBeNull()
      const projected = JSON.parse(projectListingReportEvidence(JSON.stringify(report), source))
      expect(projected.dimensions[0].criteria[0]).toEqual(before)
      expect(buildScoreCorrectionPlan(JSON.stringify(projected), "amazon_us", true, { sourceFacts: source })).toBeNull()
    },
  )
})
