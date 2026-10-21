import { buildScoreCorrectionPlan, buildScoreCorrectionRequest, mergeScoreCorrection } from "./listing-score-correction"

function createReport() {
  return {
    scoreVersion: "cdq-2026-09-16", total: 100, potential: "S级", suggestions: [],
    dimensions: [[30, 25, 20, 15, 5, 5], [7, 7, 5, 4, 2], [10, 6, 4], [7, 5, 3]].map((limits, index) => ({
      name: ["CDQ完整性", "关键词覆盖", "COSMO", "Alexa"][index],
      maxScore: [40, 25, 20, 15][index], weight: [40, 25, 20, 15][index], score: [40, 25, 20, 15][index],
      criteria: limits.map(maxScore => ({ name: "评分项", description: "已核验", maxScore, score: maxScore,
        status: "VERIFIED" as string | undefined, deductions: [] })),
    })),
  }
}

describe("取证状态矛盾可定位恢复", () => {
  it.each(["UNAVAILABLE", "NOT_APPLICABLE", undefined])("标题有分数但状态%s时只复核标题，不提前中断", status => {
    const report = createReport()
    report.dimensions[0].criteria[1].status = status
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    expect(plan.criteria).toEqual([{ dimensionIndex: 0, criterionIndex: 1 }])
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify({ corrections: [{
      dimensionIndex: 0, criterionIndex: 1, score: 25, status: "VERIFIED",
      description: "标题已完整提供并符合要求", deductions: [],
    }] }), plan, "amazon_us", true))
    expect(result.total).toBe(100)
    expect(result.dimensions.slice(1)).toEqual(report.dimensions.slice(1))
  })
})


describe("已知CDQ合同中的缺失字段进入局部校对", () => {
  const mutations: Array<[string, (criterion: Record<string, unknown>) => void]> = [
    ["缺失说明", criterion => { delete criterion.description }],
    ["空白说明", criterion => { criterion.description = "  " }],
    ["缺失得分", criterion => { delete criterion.score }],
    ["字符串得分", criterion => { criterion.score = "25" }],
    ["非有限得分", criterion => { criterion.score = Number.NaN }],
    ["错误空得分", criterion => { criterion.score = null }],
    ["越界得分", criterion => { criterion.score = 26 }],
    ["缺失扣分", criterion => { delete criterion.deductions }],
    ["非法扣分列表", criterion => { criterion.deductions = {} }],
    ["零分扣分", criterion => { criterion.deductions = [{ points: 0, reason: "无扣分" }] }],
  ]

  it.each(mutations)("%s仍可定位取证，验证占位不得作为最终分数", (_name, mutate) => {
    const report = createReport()
    mutate(report.dimensions[0].criteria[1] as unknown as Record<string, unknown>)
    const original = JSON.stringify(report)
    const plan = buildScoreCorrectionPlan(original, "amazon_us", true)!
    expect(plan.criteria).toEqual([{ dimensionIndex: 0, criterionIndex: 1 }])
    expect(JSON.stringify(report)).toBe(original)
    expect(() => mergeScoreCorrection('{"corrections":[]}', plan, "amazon_us", true)).toThrow()
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify({ corrections: [{
      dimensionIndex: 0, criterionIndex: 1, score: 20, status: "MISSING",
      description: "核验标题长度为201字符，超过200字符限制", deductions: [{
        points: 5, reason: "标题超过200字符", ruleId: "title.length", evidence: "标题长度201字符",
      }],
    }] }), plan, "amazon_us", true))
    expect(result.dimensions[0].criteria[1].score).toBe(20)
    expect(result.dimensions.slice(1)).toEqual(report.dimensions.slice(1))
  })

  it("真实失败结构：长尾词缺说明与其他项缺ruleId可以一起进入校对", () => {
    const report = createReport()
    const longtail = report.dimensions[1].criteria[2] as unknown as Record<string, unknown>
    delete longtail.description
    longtail.score = 4
    longtail.deductions = [{ points: 1, reason: "覆盖率未达70%" }]
    report.dimensions[1].score = 24
    const image = report.dimensions[0].criteria[3] as unknown as Record<string, unknown>
    image.score = 14.5
    image.deductions = [{ points: 0.5, reason: "副图共5张，少于6张" }]
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true, { confirmedSecondaryCount: 5 })!
    expect(plan.criteria).toEqual([{ dimensionIndex: 0, criterionIndex: 3 }, { dimensionIndex: 1, criterionIndex: 2 }])
    expect(plan.report.dimensions[1].criteria[2].description).toBeUndefined()
    expect(plan.report.dimensions[1].criteria[2].score).toBe(4)
  })

  it("仅固定合同元数据错误由程序恢复，不生成评分事实或调用校对", () => {
    const report = createReport()
    const dimension = report.dimensions[0] as unknown as Record<string, unknown>
    delete dimension.weight
    dimension.maxScore = 100
    dimension.name = "CDQ完整性：维度一"
    const title = report.dimensions[0].criteria[1] as unknown as Record<string, unknown>
    delete title.name
    title.maxScore = 99
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    expect(plan.criteria).toEqual([])
    const result = JSON.parse(mergeScoreCorrection('{"corrections":[]}', plan, "amazon_us", true))
    expect(result.dimensions[0]).toMatchObject({ name: "CDQ完整性", maxScore: 40, weight: 40 })
    expect(result.dimensions[0].criteria[1]).toMatchObject({ name: "标题质量", maxScore: 25, score: 25, description: "已核验", deductions: [] })
    expect(result.total).toBe(100)
  })

  it("完整索引中的空项目重新取证，不直接补分", () => {
    const report = createReport()
    ;(report.dimensions[0].criteria as unknown[])[1] = null
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    expect(plan.criteria).toEqual([{ dimensionIndex: 0, criterionIndex: 1 }])
    expect(plan.report.dimensions[0].criteria[1].score).toBeUndefined()
  })

  it("维度汇总缺失只重核维度额外扣分，保留合法细项", () => {
    const report = createReport()
    delete (report.dimensions[1] as unknown as Record<string, unknown>).score
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    expect(plan.criteria).toEqual([])
    expect(plan.dimensionIndices).toEqual([1])
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify({ corrections: [], dimensionCorrections: [{ dimensionIndex: 1, deductions: [] }] }), plan, "amazon_us", true))
    expect(result.dimensions[1].score).toBe(25)
    expect(result.dimensions[1].criteria).toEqual(report.dimensions[1].criteria)
  })

  it("缺少说明同时缺尾部仍进入同一局部校对，评级按程序归算", () => {
    const report = createReport() as unknown as Record<string, unknown>
    delete report.suggestions
    delete report.potential
    const dimensions = report.dimensions as ReturnType<typeof createReport>["dimensions"]
    delete (dimensions[0].criteria[1] as unknown as Record<string, unknown>).description
    const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
    expect(plan.pendingTailFields).toEqual(["suggestions", "potential"])
    const correctionRequest = buildScoreCorrectionRequest("规则", "原文", plan)
    expect(correctionRequest.systemPrompt).toContain("仅当pendingTailFields包含suggestions")
    expect(correctionRequest.systemPrompt).toContain("按本次校对后确认的扣分给出建议")
    expect(correctionRequest.systemPrompt).not.toContain("不返回建议、完整报告")
    const request = JSON.parse(correctionRequest.userPrompt)
    expect(request.expectedOutput.suggestions).toBeDefined()
    expect(request.expectedOutput.potential).toBeUndefined()
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify({ corrections: [{
      dimensionIndex: 0, criterionIndex: 1, score: 25, status: "VERIFIED", description: "原文标题符合要求", deductions: [],
    }], suggestions: [] }), plan, "amazon_us", true))
    expect(result.suggestions).toEqual([])
    expect(result.potential).toBe("S级 · 可直接上线")
    expect(() => mergeScoreCorrection(JSON.stringify({ corrections: [{
      dimensionIndex: 0, criterionIndex: 1, score: 25, status: "VERIFIED", description: "原文标题符合要求", deductions: [],
    }] }), plan, "amazon_us", true)).toThrow("缺失建议尚未补齐")
  })
})


it("非CDQ小项得分缺失同时重核维度扣分，不能将NaN带入汇总", () => {
  const report = createReport()
  delete (report.dimensions[1].criteria[0] as unknown as Record<string, unknown>).score
  const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
  expect(plan.criteria).toEqual([{ dimensionIndex: 1, criterionIndex: 0 }])
  expect(plan.dimensionIndices).toEqual([1])
  const result = JSON.parse(mergeScoreCorrection(JSON.stringify({ corrections: [{
    dimensionIndex: 1, criterionIndex: 0, score: 7, description: "核心词已在原文标题前75字符出现", deductions: [],
  }], dimensionCorrections: [{ dimensionIndex: 1, deductions: [] }] }), plan, "amazon_us", true))
  expect(result.dimensions[1].score).toBe(25)
  expect(result.total).toBe(100)
})


it("未请求尾部时保留原建议并拒绝模型额外改写", () => {
  const report = createReport()
  report.suggestions = ["保留已核验内容"]
  delete (report.dimensions[0].criteria[1] as unknown as Record<string, unknown>).description
  const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us", true)!
  expect(plan.pendingTailFields).toBeUndefined()
  const patch = { corrections: [{ dimensionIndex: 0, criterionIndex: 1, score: 25, status: "VERIFIED", description: "标题已核验", deductions: [] }] }
  const request = buildScoreCorrectionRequest("规则", "原文", plan)
  expect(JSON.parse(request.userPrompt).expectedOutput.suggestions).toBeUndefined()
  expect(request.systemPrompt).toContain("未请求suggestions时不得返回或修改原建议")
  expect(JSON.parse(mergeScoreCorrection(JSON.stringify(patch), plan, "amazon_us", true)).suggestions).toEqual(report.suggestions)
  expect(() => mergeScoreCorrection(JSON.stringify({ ...patch, suggestions: ["新增建议"] }), plan, "amazon_us", true)).toThrow("返回格式")
})
