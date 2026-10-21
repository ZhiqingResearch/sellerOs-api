import { buildScoreCorrectionPlan, mergeScoreCorrection } from "./listing-score-correction"

interface Deduction {
  ruleId: string
  points: number
  reason: string
  evidence: string
  checkId?: string
}

function createReport() {
  return {
    scoreVersion: "cdq-2026-09-16", total: 100, potential: "S级", suggestions: [],
    dimensions: [[30, 25, 20, 15, 5, 5], [7, 7, 5, 4, 2], [10, 6, 4], [7, 5, 3]].map((limits, index) => ({
      name: ["CDQ完整性", "关键词覆盖", "COSMO", "Alexa"][index],
      maxScore: [40, 25, 20, 15][index], weight: [40, 25, 20, 15][index], score: [40, 25, 20, 15][index],
      criteria: limits.map(maxScore => ({ name: "评分项", description: "已核验", maxScore, score: maxScore,
        status: "VERIFIED", deductions: [] as Deduction[] })),
    })),
  }
}

function createCorrection(dimensionIndex: number, criterionIndex: number, deductions: Deduction[]) {
  const report = createReport()
  const criterion = report.dimensions[dimensionIndex].criteria[criterionIndex]
  Object.assign(criterion, {
    score: criterion.maxScore - deductions.reduce((sum, deduction) => sum + deduction.points, 0),
    deductions,
    status: "MISSING",
  })
  const sum = report.dimensions[dimensionIndex].criteria.reduce((total, item) => total + item.score, 0)
  report.dimensions[dimensionIndex].score = dimensionIndex === 0 ? sum * 0.4 : sum
  report.total = report.dimensions.reduce((total, dimension) => total + dimension.score, 0)
  const patch = { corrections: [{ dimensionIndex, criterionIndex, score: criterion.score,
    ...(dimensionIndex === 0 ? { status: "MISSING" } : {}), description: criterion.description, deductions }] }
  return { report, patch }
}

describe("校对按原始上下文和明确检查点恢复", () => {
  it("描述把5张副图错写为6张时，旧归一化不能绕过定向校对", () => {
    const deductions = [{ ruleId: "image.count", points: 0.5,
      reason: "副图数量5张，按公式扣0.5分", evidence: "后端图片清单：副图1至副图5" }]
    const { report, patch } = createCorrection(0, 3, deductions)
    report.dimensions[0].criteria[3].description = "副图6张，覆盖场景、细节、尺寸、包装"
    const context = { confirmedSecondaryCount: 5 }
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true, context)!
    expect(plan.criteria).toEqual([{ dimensionIndex: 0, criterionIndex: 3 }])
    patch.corrections[0].description = "副图5张，覆盖场景、细节、尺寸、包装"
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify(patch), plan, "amazon_us", true, context))
    expect(result.dimensions[0].criteria[3]).toMatchObject({ score: 14.5, deductions })
    expect(result.dimensions.slice(1)).toEqual(report.dimensions.slice(1))
  })

  it("只把evidence中明确写出的单个checkId提取成字段，保留原始证据和分值", () => {
    const deduction = { ruleId: "alexa.description", points: 1,
      reason: "缺少规格段", evidence: "description：未包含规格段；checkId=specifications" }
    const { report, patch } = createCorrection(3, 2, [deduction])
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify(patch), plan, "amazon_us", true))
    expect(result.dimensions[3].criteria[2]).toMatchObject({ score: 2,
      deductions: [{ ...deduction, checkId: "specifications" }] })
    expect(result.dimensions.slice(1, 3)).toEqual(report.dimensions.slice(1, 3))
    expect(result.dimensions[0].criteria).toEqual(report.dimensions[0].criteria)
  })

  it.each([
    [3, 2, "alexa.description", ["specifications", "overview_scenes"], 1],
    [0, 3, "image.coverage", ["dimensions", "package"], 0.75],
  ] as const)("%s:%s 多个明确ID按原规则固定分值拆分", (dimensionIndex, criterionIndex, ruleId, ids, points) => {
    const deduction = { ruleId, points: points * ids.length, reason: "两类内容均缺失",
      evidence: ids.map(checkId => `checkId=${checkId}`).join("；") }
    const { report, patch } = createCorrection(dimensionIndex, criterionIndex, [deduction])
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify(patch), plan, "amazon_us", true))
    expect(result.dimensions[dimensionIndex].criteria[criterionIndex].deductions)
      .toEqual(ids.map(checkId => ({ ...deduction, checkId, points })))
    expect(result.dimensions[dimensionIndex].criteria[criterionIndex].score)
      .toBe(report.dimensions[dimensionIndex].criteria[criterionIndex].score)
  })

  it.each([
    [1, "description：缺少规格段"],
    [1, "checkId=heading_format"],
    [2, "checkId=specifications；checkId=specifications"],
  ])("分数%s对应缺ID、未知或重复ID时仍拒绝：%s", (points, evidence) => {
    const { report, patch } = createCorrection(3, 2, [{ ruleId: "alexa.description",
      points: Number(points), reason: "缺少规格段", evidence: String(evidence) }])
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    expect(() => mergeScoreCorrection(JSON.stringify(patch), plan, "amazon_us", true)).toThrow("checkId")
  })

  it("两个明确描述检查点即使模型合计错写1分，仍按原规则各扣1分", () => {
    const deduction = { ruleId: "alexa.description", points: 1, reason: "两类内容均缺失",
      evidence: "checkId=specifications；checkId=overview_scenes" }
    const { report, patch } = createCorrection(3, 2, [deduction])
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify(patch), plan, "amazon_us", true))
    expect(result.dimensions[3].criteria[2]).toMatchObject({ score: 1, deductions: [
      { ...deduction, checkId: "specifications", points: 1 },
      { ...deduction, checkId: "overview_scenes", points: 1 },
    ] })
  })

  it("实跑包装缺失标签checkId冒号格式兼容，模型错扣1分归算为原规则0.75分", () => {
    const deduction = { ruleId: "image.coverage", points: 1, reason: "副图缺少包装清单",
      evidence: "checkId: package" }
    const { report, patch } = createCorrection(0, 3, [deduction])
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify(patch), plan, "amazon_us", true))
    expect(result.dimensions[0].criteria[3]).toMatchObject({ score: 14.25, deductions: [
      { ...deduction, checkId: "package", points: 0.75 },
    ] })
    expect(result.dimensions.slice(1)).toEqual(report.dimensions.slice(1))
  })

  it.each([
    [0, 3, "image.coverage", "package", 0.75],
    [3, 2, "alexa.description", "specifications", 1],
  ] as const)("%s:%s独立checkId字段明确但模型分值错误时按固定规则归算", (dimensionIndex, criterionIndex, ruleId, checkId, points) => {
    const deduction = { ruleId, checkId, points: 2, reason: "所指检查点缺失", evidence: "原始内容未包含此检查点要求的信息" }
    const { report, patch } = createCorrection(dimensionIndex, criterionIndex, [deduction])
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify(patch), plan, "amazon_us", true))
    expect(result.dimensions[dimensionIndex].criteria[criterionIndex]).toMatchObject({
      score: report.dimensions[dimensionIndex].criteria[criterionIndex].maxScore - points,
      deductions: [{ ...deduction, points }],
    })
  })

  it.each([
    ["image.coverage", 0, 3, "package"],
    ["alexa.description", 3, 2, "specifications"],
  ] as const)("%s明确检查点也不能把零、负数或非法分值变为正扣分", (ruleId, dimensionIndex, criterionIndex, checkId) => {
    const deduction = { ruleId, checkId, points: 2, reason: "所指检查点待核验", evidence: "原始内容待核验" }
    const { report, patch } = createCorrection(dimensionIndex, criterionIndex, [deduction])
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    patch.corrections[0].score = report.dimensions[dimensionIndex].criteria[criterionIndex].maxScore
    for (const points of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
      for (const hasIndependentCheckId of [true, false]) {
        patch.corrections[0].deductions = [{
          ruleId, points: points as number, reason: "所指检查点待核验",
          evidence: `checkId: ${checkId}`,
          ...(hasIndependentCheckId ? { checkId } : {}),
        }]
        const merge = () => mergeScoreCorrection(JSON.stringify(patch), plan, "amazon_us", true)
        if (typeof points === "number" && Number.isFinite(points))
          expect(merge).toThrow("扣分记录必须有正数points")
        else expect(merge).toThrow()
      }
    }
    expect(report.dimensions[dimensionIndex].criteria[criterionIndex].deductions).toEqual([deduction])
  })
})
