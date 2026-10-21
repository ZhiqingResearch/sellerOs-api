import { recalculateListingAttributeScore } from "./listing-attribute-normalization"
import { CDQ_DIMENSION_METADATA } from "./listing-score-correction"
import { prepareListingScoreDelivery } from "./listing-score-delivery"
import { buildListingScoreSystemPrompt } from "./listing-score-prompt"

const sourceFacts = { title: "Floral skirt", itemHighlights: "", bullets: [], description: "", searchTerms: "",
  structuredAttributes: [{ name: "Color", value: "Blue" }, { name: "Fabric", value: "Chiffon" }],
}
function createReport() {
  const report = { scoreVersion: "cdq-2026-09-16", total: 97.6, suggestions: [], potential: "S", dimensions:
    CDQ_DIMENSION_METADATA.map(metadata => ({ ...metadata, score: metadata.maxScore,
      criteria: metadata.criteria.map(([name, maxScore]) => ({ name, maxScore, score: maxScore, status: "VERIFIED", description: "已核验", deductions: [] })),
    })) }
  Object.assign(report.dimensions[0].criteria[0], {
    score: 24, description: "已核验13项前台可见属性，无明显矛盾或错位，填写规范。",
    deductions: [{ points: 6, reason: "属性填写完整度与重要度加权扣分", ruleId: "attribute.required",
      evidence: "前台可见属性13项，部分推荐属性未填，按权重折算" }],
  })
  return report
}
describe("属性评分按既定规则计算，完整报告正常交付", () => {
  it("截图中错误扣除的6分不参与计分，同步明细、CDQ和总分，不返回错误", () => {
    const original = JSON.stringify(createReport())
    const text = prepareListingScoreDelivery(original, "amazon_us")!
    const result = JSON.parse(text)
    expect(result.dimensions[0].criteria[0]).toMatchObject({ score: 30, status: "VERIFIED", deductions: [] })
    expect(result.dimensions[0].criteria[0].description).toContain("不扣分")
    expect(result.dimensions[0].score).toBe(40)
    expect(result.total).toBe(100)
    expect(result.suggestions).toContain("推荐属性可按实际商品资料补充，仅作优化建议，不影响本项得分。")
    expect(JSON.stringify(createReport())).toBe(original)
    expect(prepareListingScoreDelivery(text, "amazon_us")).toBe(text)
  })
  it("只移除不该扣的6分，其余真实填写错误照常计分", () => {
    const report = createReport()
    const problem = { points: 3, reason: "Color填写与标题颜色矛盾", ruleId: "attribute.required", evidence: "Color: Blue；title: Red skirt" }
    Object.assign(report.dimensions[0].criteria[0], { score: 21, deductions: [...report.dimensions[0].criteria[0].deductions, problem] })
    const result = JSON.parse(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us")!)
    expect(result.dimensions[0].criteria[0]).toMatchObject({ score: 27, status: "MISSING", deductions: [problem] })
    expect(result.dimensions[0].score).toBe(38.8)
    expect(result.total).toBe(98.8)
  })
  it("完整取证表由程序计算权重、扣分及说明，不采用模型主观总分", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[0], { score: 3, assessment: { attributeChecks: [
      { index: 1, weight: 2, errorType: "NONE", comparison: [], suggestion: "" },
      { index: 2, weight: 2, errorType: "NONE", comparison: [], suggestion: "" },
    ] } })
    const result = recalculateListingAttributeScore(report, sourceFacts)
    const criterion = (result.dimensions as typeof report.dimensions)[0].criteria[0]
    expect(criterion).toMatchObject({ score: 30, status: "VERIFIED", deductions: [] })
    expect(criterion.description).toContain("未发现可确认的问题")
  })
  it("不完整取证表沿用正常交付路径，仍纠正明确的推荐属性缺失误扣", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[0], { assessment: { attributeChecks: [] } })
    const result = JSON.parse(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us", { sourceFacts })!)
    expect(result.dimensions[0].criteria[0].score).toBe(30)
  })
  it("完整取证表存在真实问题时按权重扣分，不因移除推荐未填扣分就一律给满分", () => {
    const report = createReport()
    const source = { ...sourceFacts, structuredAttributes: [{ name: "Color", value: "Blue" }, { name: "Fabric", value: "Premium material" }] }
    Object.assign(report.dimensions[0].criteria[0], { assessment: { attributeChecks: [
      { index: 1, weight: 3, errorType: "NONE", comparison: [], suggestion: "" },
      { index: 2, weight: 1, errorType: "MARKETING", comparison: [], suggestion: "填写实际面料成分" },
    ] } })
    const result = recalculateListingAttributeScore(report, source)
    const criterion = (result.dimensions as typeof report.dimensions)[0].criteria[0]
    expect(criterion).toMatchObject({ score: 26.25, status: "MISSING", deductions: [expect.objectContaining({ points: 3.75, reason: expect.stringContaining("Fabric") })] })
  })
  it.each(["Color作为推荐字段填写错误", "推荐属性未填；Color与标题矛盾", "必填属性未填"])("%s不因提到推荐/缺失就整条取消扣分", reason => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[0], { deductions: [{ points: 6, reason, evidence: "Color: Blue", ruleId: "attribute.required" }] })
    expect(recalculateListingAttributeScore(report)).toBe(report)
  })
  it("未知格式及无完整取证的普通报告不新增拦截、不编造满分", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[0], { deductions: [] })
    expect(recalculateListingAttributeScore(report, sourceFacts)).toBe(report)
    expect(prepareListingScoreDelivery(JSON.stringify(report), "amazon_us")).toBeDefined()
  })
  it("首次调用即要求逐项判断，推荐未填只给建议", () => {
    const prompt = buildListingScoreSystemPrompt("评分", `<listing-scoring-source>${JSON.stringify(sourceFacts)}</listing-scoring-source>`)
    expect(prompt).toContain("首次回答请完整填写assessment.attributeChecks")
    expect(prompt).toContain("不生成扣分")
    expect(prompt).toContain("不得一边写填写规范一边以完整度为由扣分")
  })
})
