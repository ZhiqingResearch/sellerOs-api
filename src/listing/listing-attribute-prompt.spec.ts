import { buildScoreCorrectionPlan, buildScoreCorrectionRequest, mergeScoreCorrection } from "./listing-score-correction"
import { getListingCriterionRuleError, validateListingReportRules, LISTING_ATTRIBUTE_RULE_PROMPT, LISTING_RULE_CHECK_PROMPT } from "./listing-score-rules"
import { validateScoreReport } from "./listing-score-recovery"

interface AttributeFinding {
  field: string
  currentValue: string
  kind: string
  weight: number
  severity: number
  evidence: string
}

const ATTRIBUTE_WEIGHT_TOTAL = 40
const ATTRIBUTE_FINDINGS: AttributeFinding[] = [
  { field: "Printer Model Compatibility", currentValue: "HP OfficeJet Pro", kind: "同口径兼容型号矛盾", weight: 3, severity: 1, evidence: "Printer Model Compatibility=HP OfficeJet Pro；标题兼容型号=Epson EcoTank ET-2850" },
  { field: "Compatible Printer Models", currentValue: "False", kind: "字段错位：类型不符", weight: 3, severity: 1, evidence: "Compatible Printer Models=False，兼容型号字段要求型号值而非布尔占位值" },
  { field: "Color", currentValue: "black color", kind: "同口径颜色矛盾", weight: 3, severity: 1, evidence: "Color=black color；Ink Colour=Multicolor，均描述本套墨水颜色" },
  { field: "Model Name", currentValue: "Replacement for 502 ink refill bottles", kind: "字段错位：复述产品名", weight: 3, severity: 0.5, evidence: "Model Name=Replacement for 502 ink refill bottles；同页Model Number=502" },
  { field: "Manufacturer", currentValue: "SUPRINT for 502 ink refill bottles", kind: "字段错位：复述产品名", weight: 2, severity: 0.5, evidence: "Manufacturer=SUPRINT for 502 ink refill bottles，包含产品描述而非单独厂商标识" },
  { field: "Number of Packs", currentValue: "5", kind: "字段错位：粒度不符", weight: 2, severity: 1, evidence: "Number of Packs=5；包装为一套，Number of Items=5为瓶数" },
  { field: "Mfr Part Number", currentValue: "Replacement for 502 ink refill bottles", kind: "字段错位：复述产品名", weight: 1, severity: 0.5, evidence: "Mfr Part Number=Replacement for 502 ink refill bottles，零件号字段填写整句产品描述" },
]

function createAttributeDeductions() {
  return ATTRIBUTE_FINDINGS.map(finding => ({
    ruleId: "attribute.required",
    points: 30 * finding.weight * finding.severity / ATTRIBUTE_WEIGHT_TOTAL,
    reason: `${finding.field}当前值为${finding.currentValue}；${finding.kind}，建议按实际字段含义修正`,
    evidence: finding.evidence,
  }))
}

function createReport() {
  return {
    scoreVersion: "cdq-2026-09-16", mode: "standard", total: 100,
    suggestions: ["Page Yield为35000，单瓶与整套口径尚未确认，建议注明口径，不扣分"], potential: "S级",
    dimensions: [[30, 25, 20, 15, 5, 5], [7, 7, 5, 4, 2], [10, 6, 4], [7, 5, 3]].map((limits, index) => ({
      name: ["CDQ完整性", "关键词覆盖", "COSMO关系覆盖", "Alexa语义质量"][index],
      maxScore: [40, 25, 20, 15][index], weight: [40, 25, 20, 15][index], score: [40, 25, 20, 15][index],
      criteria: limits.map((maxScore, criterionIndex) => ({
        name: index === 0 && criterionIndex === 0 ? "结构化属性" : `评分项${index}:${criterionIndex}`,
        maxScore, score: maxScore, description: "原始项目已完整核验", status: "VERIFIED",
        deductions: [] as ReturnType<typeof createAttributeDeductions>,
      })),
    })),
  }
}

const ATTRIBUTE_DESCRIPTION = "口径=前台可见属性，共25项；按重要度分档后的属性权重合计40，失分份额14，得分30×(1−14/40)=19.5。Page Yield口径待确认，不扣分。"

describe("新版结构化属性加权扣分兼容现有评分恢复", () => {
  it("权重分母40、失分份额14对应7条扣分共10.5，现有规则不拦截半额扣分", () => {
    const report = createReport()
    const deductions = createAttributeDeductions()
    expect(ATTRIBUTE_FINDINGS.reduce((sum, finding) => sum + finding.weight * finding.severity, 0)).toBe(14)
    expect(deductions.map(deduction => deduction.points)).toEqual([2.25, 2.25, 2.25, 1.125, 0.75, 1.5, 0.375])
    expect(deductions.reduce((sum, deduction) => sum + deduction.points, 0)).toBe(10.5)
    Object.assign(report.dimensions[0].criteria[0], {
      score: 19.5, status: "MISSING", description: ATTRIBUTE_DESCRIPTION, deductions,
    })
    expect(getListingCriterionRuleError(0, 0, report.dimensions[0].criteria[0])).toBeNull()
    expect(() => validateListingReportRules(report)).not.toThrow()
    const normalized = JSON.parse(validateScoreReport(JSON.stringify(report), "amazon_us"))
    expect(normalized.dimensions[0].criteria[0]).toMatchObject({ score: 19.5, status: "MISSING", deductions })
    expect(normalized.dimensions[0].score).toBe(35.8)
    expect(normalized.total).toBe(95.8)
    expect(normalized.dimensions.slice(1)).toEqual(report.dimensions.slice(1))
  })

  it.each([19.5, 30, 7])("缺说明的结构化属性用合法扣分恢复，模型回传%s分不影响既定加权结果", score => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[0], { score: 30, deductions: createAttributeDeductions() })
    delete (report.dimensions[0].criteria[0] as { description?: string }).description
    const original = structuredClone(report)
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    expect(plan.criteria).toEqual([{ dimensionIndex: 0, criterionIndex: 0 }])
    expect(plan.dimensionIndices).toBeUndefined()
    expect(plan.report.dimensions[0].criteria[0].description).toBeUndefined()
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify({ corrections: [{
      dimensionIndex: 0, criterionIndex: 0, status: "MISSING", score,
      description: ATTRIBUTE_DESCRIPTION, deductions: createAttributeDeductions(),
    }] }), plan, "amazon_us", true))
    expect(result.dimensions[0].criteria[0]).toMatchObject({ score: 19.5, status: "MISSING", description: ATTRIBUTE_DESCRIPTION })
    expect(result.dimensions[0].criteria[0].deductions).toEqual(createAttributeDeductions())
    expect(result.dimensions[0].criteria.slice(1)).toEqual(original.dimensions[0].criteria.slice(1))
    expect(result.dimensions.slice(1)).toEqual(original.dimensions.slice(1))
    expect(result.suggestions).toEqual(original.suggestions)
    expect(result.total).toBe(95.8)
    expect(report).toEqual(original)
  })

  it("待确认的产量口径仅保留建议，不加入扣分，不把前台可见数量叫作必填数量", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[0], {
      score: 19.5, status: "MISSING", description: ATTRIBUTE_DESCRIPTION, deductions: createAttributeDeductions(),
    })
    const normalized = JSON.parse(validateScoreReport(JSON.stringify(report), "amazon_us"))
    expect(normalized.dimensions[0].criteria[0].description).toContain("口径=前台可见属性，共25项")
    expect(normalized.dimensions[0].criteria[0].description).not.toContain("必填")
    expect(normalized.dimensions[0].criteria[0].deductions).toHaveLength(7)
    expect(normalized.dimensions[0].criteria[0].deductions.some((deduction: { reason: string }) => /Page Yield|Printer=|营销话术/.test(deduction.reason))).toBe(false)
    expect(normalized.suggestions).toEqual(report.suggestions)
  })
})


describe("新版属性提示词的执行口径", () => {
  it("首次评分和局部校对都包含相同的新属性规则，不再要求缺必填清单时整项留空", () => {
    expect(LISTING_RULE_CHECK_PROMPT).toContain(LISTING_ATTRIBUTE_RULE_PROMPT)
    expect(LISTING_RULE_CHECK_PROMPT).not.toContain("attribute.required必须依据原始资料中的类目必填清单和必填总数N")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("缺后台清单不等于整项未获取")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("本次取得N项前台可见属性")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("属性本身也未获取时，才使用status=UNAVAILABLE")
    const report = createReport()
    delete (report.dimensions[0].criteria[0] as { description?: string }).description
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    const request = buildScoreCorrectionRequest("新CDQ文档", "已获取前台属性", plan)
    expect(request.systemPrompt).toContain(LISTING_ATTRIBUTE_RULE_PROMPT)
    expect(JSON.parse(request.userPrompt).requestedCriteria[0].allowedRules).toEqual({ "attribute.required": 30 })
  })

  it("优先加权与严重度，前台分母不冒称后台必填分母", () => {
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("优先于文档简述")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("前台可见属性数≠必填项数")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("正确与有错的全部属性权重")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("失分份额=属性权重×扣除比例")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("每条扣分=30×该条失分份额/W")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("score=30−全部扣分之和")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("50%")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("重要度待校准")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("不新增输出必填字段")
  })

  it("矛盾必须同口径双证据，中性描述不能误分类营销，待确认不得扣分", () => {
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("③矛盾→①字段错位→②单位/量纲→④营销话术")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("必须列两处字段名和原值")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("Compatible Devices=Printer不能用作与HP/Epson具体型号冲突的证据")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("是中性描述")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("不得称营销话术")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("②口径不明、实物核验缺证据=0%")
    expect(LISTING_ATTRIBUTE_RULE_PROMPT).toContain("每次只按本次实际原文核验")
  })
})
