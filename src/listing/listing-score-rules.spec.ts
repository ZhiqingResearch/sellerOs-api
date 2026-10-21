import { getListingCriterionRuleError } from "./listing-score-rules"
import { buildScoreCorrectionPlan, mergeScoreCorrection } from "./listing-score-correction"

function createReport() {
  return {
    scoreVersion: "cdq-2026-09-16", total: 100, potential: "S级", suggestions: [],
    dimensions: [[30, 25, 20, 15, 5, 5], [7, 7, 5, 4, 2], [10, 6, 4], [7, 5, 3]].map((limits, index) => ({
      name: ["CDQ完整性", "关键词覆盖", "COSMO", "Alexa"][index],
      maxScore: [40, 25, 20, 15][index], weight: [40, 25, 20, 15][index], score: [40, 25, 20, 15][index],
      criteria: limits.map(maxScore => ({
        name: "评分项", description: "已核验满足当前规则", score: maxScore, maxScore,
        status: "VERIFIED", deductions: [] as Array<{ ruleId: string; evidence: string; reason: string; points: number }>,
      })),
    })),
  }
}

describe("按提示词规则校验与单项复核", () => {
  it.each([
    ["outside.rule", 1, "新增扣分项"],
    ["title.length", 1, "跨维度借用扣分"],
    ["image.count", 4, "数量项超过3分"],
  ])("图片项拒绝%s：%s分，%s", (ruleId, points) => {
    expect(getListingCriterionRuleError(0, 3, { score: 15 - Number(points), deductions: [
      { ruleId, points, evidence: "副图2张", reason: "具体证据" },
    ] })).not.toBeNull()
  })

  it("拒绝同一证据重复扣分、拆分绕过检查点上限", () => {
    const deduction = { ruleId: "image.count", points: 2, evidence: "副图2张", reason: "数量不足" }
    expect(getListingCriterionRuleError(0, 3, { score: 11, deductions: [deduction, deduction] })).toContain("重复")
    expect(getListingCriterionRuleError(0, 3, { score: 11, deductions: [deduction, { ...deduction, evidence: "另一说法" }] })).toContain("超过")
  })

  it("合法算术但规则越界的图片项会进入复核，复核后其余项目完整保留", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[3], {
      score: 11, description: "副图2张，覆盖类型无法确认",
      deductions: [{ points: 4, ruleId: "image.count", evidence: "副图2张", reason: "副图数量不足" }],
    })
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    expect(plan.criteria).toEqual([{ dimensionIndex: 0, criterionIndex: 3 }])
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify({ corrections: [{
      dimensionIndex: 0, criterionIndex: 3, score: 13, description: "副图2张，数量项得1分",
      deductions: [{ points: 2, ruleId: "image.count", evidence: "副图2张", reason: "副图数量2张，按3×2/6得1分，扣2分" }],
    }] }), plan, "amazon_us", true))
    expect(result.dimensions[0].criteria[3].score).toBe(13)
    expect(result.dimensions.slice(1)).toEqual(report.dimensions.slice(1))
    expect(result.total).toBe(99.2)
  })

  it("复核可以返回未获取而不会再因null分阻塞", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[0], {
      score: 29, deductions: [{ points: 1, reason: "未提供结构化属性数据且没有后台访问权限" }],
    })
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify({ corrections: [{
      dimensionIndex: 0, criterionIndex: 0, score: null, status: "UNAVAILABLE",
      description: "未提供结构化属性数据及后台必填属性清单", deductions: [],
    }] }), plan, "amazon_us", true))
    expect(result.dimensions[0].criteria[0].score).toBeNull()
    expect(result.total).toBe(100)
  })

  it("维度总分不能另扣无依据分数，维度复核可移除该扣分完成报告", () => {
    const report = createReport()
    report.dimensions[1].score = 22
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    expect(plan.criteria).toEqual([])
    expect(plan.dimensionIndices).toEqual([1])
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify({ corrections: [],
      dimensionCorrections: [{ dimensionIndex: 1, deductions: [] }],
    }), plan, "amazon_us", true))
    expect(result.dimensions[1].score).toBe(25)
    expect(result.total).toBe(100)
  })

  it("复核规则和证据有效时按扣分计算得分，不因模型算术错误中断", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[3], { score: 11, deductions: [{ points: 4, reason: "未引用规则" }] })
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify({ corrections: [{
      dimensionIndex: 0, criterionIndex: 3, score: 4.5, description: "主图长边355px，灰色背景，副图数量与覆盖均达标",
      deductions: [
        { points: 6, ruleId: "image.compliance", evidence: "主图灰色背景", reason: "主图不符合纯白底要求" },
        { points: 3, ruleId: "image.zoom", evidence: "主图长边355px", reason: "主图长边不足1000px" },
      ],
    }] }), plan, "amazon_us", true))
    expect(result.dimensions[0].criteria[3].score).toBe(6)
  })

  it("维度复核不能改未请求维度或超出原有惩罚上限", () => {
    const report = createReport()
    report.dimensions[1].score = 22
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    for (const patch of [
      { dimensionIndex: 3, deductions: [] },
      { dimensionIndex: 1, deductions: [{ ruleId: "keyword.titleLength", points: 11, reason: "标题过长", evidence: "标题100字符" }] },
    ]) {
      expect(() => mergeScoreCorrection(JSON.stringify({ corrections: [], dimensionCorrections: [patch] }), plan, "amazon_us", true)).toThrow()
    }
  })
})
