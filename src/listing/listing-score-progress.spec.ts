import {
  acceptScoreCorrectionProgress,
  buildScoreCorrectionRequest,
  mergeScoreCorrection,
  type ScoreCorrectionPlan,
  type ScoreCorrectionReport,
} from "./listing-score-correction"

function createPlan(criteria: ScoreCorrectionPlan["criteria"]): ScoreCorrectionPlan {
  const report = {
    scoreVersion: "cdq-2026-09-16", total: 100, potential: "S级", suggestions: ["保留原建议"],
    dimensions: [[30, 25, 20, 15, 5, 5], [7, 7, 5, 4, 2], [10, 6, 4], [7, 5, 3]].map((limits, index) => ({
      name: ["CDQ完整性", "关键词覆盖", "COSMO", "Alexa"][index],
      maxScore: [40, 25, 20, 15][index], weight: [40, 25, 20, 15][index], score: [40, 25, 20, 15][index],
      criteria: limits.map(maxScore => ({ name: "评分项", description: "原始资料已核验", maxScore, score: maxScore,
        status: "VERIFIED", deductions: [] })),
      deductions: [],
    })),
  } as ScoreCorrectionReport
  return { report, criteria, shouldCorrectSuggestions: false }
}

function titleCorrection() {
  return {
    dimensionIndex: 0, criterionIndex: 1, score: 20, status: "MISSING",
    description: "标题201字符，超过200字符限制", deductions: [{
      ruleId: "title.length", points: 5, evidence: "原始标题长201字符", reason: "标题超过200字符",
    }],
  }
}

const emptyCorrection = (dimensionIndex: number, criterionIndex: number, score: number) => ({
  dimensionIndex, criterionIndex, score, description: "已按原始资料逐项核验", deductions: [],
})

describe("局部校对逐项接收并保留进度", () => {
  it("一次回复漏项和错项不抹掉合规扣分，后续只补未完成项且不覆盖已接收结果", () => {
    const plan = createPlan([{ dimensionIndex: 0, criterionIndex: 1 }, { dimensionIndex: 1, criterionIndex: 0 }, { dimensionIndex: 1, criterionIndex: 1 }])
    const snapshot = structuredClone(plan)
    const first = acceptScoreCorrectionProgress(JSON.stringify({ total: 100, suggestions: ["越权建议"], corrections: [
      { ...titleCorrection(), name: "越权改名", maxScore: 999, source: "官方" },
      { ...emptyCorrection(1, 0, 0), description: "没有依据仍给0分" },
      emptyCorrection(2, 0, 0),
    ] }), plan, "amazon_us")
    expect(first.acceptedCriteria).toEqual([{ dimensionIndex: 0, criterionIndex: 1 }])
    expect(first.plan.criteria).toEqual(plan.criteria.slice(1))
    expect(first.validationErrors).toHaveLength(2)
    expect(first.plan.report.dimensions[0].criteria[1]).toMatchObject({ name: "评分项", maxScore: 25, score: 20 })
    expect(first.plan.report.suggestions).toEqual(["保留原建议"])
    expect(first.plan.report.dimensions.slice(1)).toEqual(plan.report.dimensions.slice(1))
    expect(plan).toEqual(snapshot)

    const second = acceptScoreCorrectionProgress(JSON.stringify({ corrections: [
      { ...titleCorrection(), score: 25, deductions: [] }, emptyCorrection(1, 0, 7), emptyCorrection(1, 1, 7),
    ] }), first.plan, "amazon_us")
    expect(second.plan.criteria).toEqual([])
    expect(second.plan.report.dimensions[0].criteria[1].score).toBe(20)
    const result = JSON.parse(mergeScoreCorrection('{"corrections":[]}', second.plan, "amazon_us", true))
    expect(result.total).toBe(98)
    expect(result.dimensions[0].criteria[1].deductions[0].points).toBe(5)
  })

  it.each(["array", "data", "result", "bare", "strings"])("兼容%s外壳且原状态可继承，不因格式差异丢失合法事实", format => {
    const plan = createPlan([{ dimensionIndex: 0, criterionIndex: 1 }])
    const item = titleCorrection() as Record<string, unknown>
    delete item.status
    let response: unknown = { corrections: [item] }
    if (format === "array") response = [item]
    if (format === "data") response = { data: response, requestId: "ignored" }
    if (format === "result") response = { result: response }
    if (format === "bare") { delete item.dimensionIndex; delete item.criterionIndex; response = item }
    if (format === "strings") Object.assign(item, { dimensionIndex: "0", criterionIndex: "1" })
    const progress = acceptScoreCorrectionProgress("```json\n" + JSON.stringify(response) + "\n```", plan, "amazon_us")
    expect(progress.acceptedCriteria).toHaveLength(1)
    expect(progress.plan.criteria).toEqual([])
    expect(progress.plan.report.dimensions[0].criteria[1].score).toBe(20)
  })

  it("单项显式错误索引不绑定请求，重复目标也不任意选择", () => {
    const plan = createPlan([{ dimensionIndex: 0, criterionIndex: 1 }])
    for (const response of [
      { ...titleCorrection(), criterionIndex: 2 },
      { corrections: [titleCorrection(), titleCorrection()] },
    ]) {
      const progress = acceptScoreCorrectionProgress(JSON.stringify(response), plan, "amazon_us")
      expect(progress.acceptedCriteria).toEqual([])
      expect(progress.plan).toEqual(plan)
      expect(progress.validationErrors).toHaveLength(1)
    }
  })

  it("未闭合响应仅保留待补项目，不凭空补写得分", () => {
    const plan = createPlan([{ dimensionIndex: 0, criterionIndex: 1 }])
    const progress = acceptScoreCorrectionProgress('{"corrections":[', plan, "amazon_us")
    expect(progress.plan).toEqual(plan)
    expect(progress.acceptedCriteria).toEqual([])
    expect(progress.validationErrors.length).toBeGreaterThan(0)
  })

  it("合法维度扣分先接收，之后补齐小项仍保留原惩罚；错误规则留待重新核验", () => {
    const plan = createPlan([{ dimensionIndex: 1, criterionIndex: 1 }])
    plan.dimensionIndices = [1, 3]
    const penalty = { points: 2, ruleId: "keyword.titleLength", reason: "标题过长", evidence: "标题长201字符" }
    const first = acceptScoreCorrectionProgress(JSON.stringify({ dimensionCorrections: [
      { dimensionIndex: 1, deductions: [penalty], score: 100 },
      { dimensionIndex: 3, deductions: [{ ...penalty, ruleId: "keyword.relevance" }] },
    ] }), plan, "amazon_us")
    expect(first.acceptedDimensions).toEqual([1])
    expect(first.plan.dimensionIndices).toEqual([3])
    expect(first.plan.report.dimensions[1].score).toBe(23)
    const second = acceptScoreCorrectionProgress(JSON.stringify({ corrections: [{
      ...emptyCorrection(1, 1, 6), deductions: [{ points: 1, ruleId: "keyword.sa", reason: "7词覆盖6词", evidence: "已核验关键词7个命中6个" }],
    }], dimensionCorrections: [{ dimensionIndex: 3, deductions: [] }] }), first.plan, "amazon_us")
    expect(second.plan.report.dimensions[1].score).toBe(22)
    expect(second.plan.report.dimensions[1].deductions).toEqual([penalty])
    expect(second.plan.criteria).toEqual([])
    expect(second.plan.dimensionIndices).toEqual([])
    expect(JSON.parse(mergeScoreCorrection('{"corrections":[]}', second.plan, "amazon_us", true)).total).toBe(97)
  })

  it("有未完成小项不阻止建议接收，最终评级仍交给既有汇总", () => {
    const plan = createPlan([{ dimensionIndex: 0, criterionIndex: 1 }])
    plan.pendingTailFields = ["suggestions", "potential"]
    const progress = acceptScoreCorrectionProgress(JSON.stringify({ suggestions: ["缩短标题"], potential: "伪造评级" }), plan, "amazon_us")
    expect(progress.hasAcceptedSuggestions).toBe(true)
    expect(progress.plan.pendingTailFields).toEqual(["potential"])
    expect(progress.plan.report.suggestions).toEqual(["缩短标题"])
    expect(progress.plan.report.potential).toBe("S级")
    expect(progress.plan.criteria).toEqual(plan.criteria)
  })

  it("原文引用错误仍待重取证，合法图片项及扣分不受影响", () => {
    const plan = createPlan([{ dimensionIndex: 0, criterionIndex: 3 }, { dimensionIndex: 3, criterionIndex: 2 }])
    const progress = acceptScoreCorrectionProgress(JSON.stringify({ corrections: [
      { ...emptyCorrection(0, 3, 14.5), status: "MISSING", deductions: [{
        ruleId: "image.count", points: 0.5, reason: "副图5张，少于6张", evidence: "副图共5张",
      }] },
      { ...emptyCorrection(3, 2, 3), assessment: { checks: [
        { checkId: "specifications", isPresent: true, quotes: [{ field: "description", quote: "Contains 140mL" }] },
        { checkId: "overview_scenes", isPresent: false, quotes: [] },
      ] } },
    ] }), plan, "amazon_us", { confirmedSecondaryCount: 5, sourceFacts: {
      title: "Ink bottles", itemHighlights: "", bullets: ["Contains 140mL"], description: "Works in a home office.", searchTerms: "",
    } })
    expect(progress.acceptedCriteria).toEqual([{ dimensionIndex: 0, criterionIndex: 3 }])
    expect(progress.plan.criteria).toEqual([{ dimensionIndex: 3, criterionIndex: 2 }])
    expect(progress.plan.report.dimensions[0].criteria[3].score).toBe(14.5)
    expect(progress.validationErrors[0]).toContain("3:2")
  })
})

it("原始属性可取得时漏表不能锁为成功，反馈缺失索引后按完整表原公式计算", () => {
  const plan = createPlan([{ dimensionIndex: 0, criterionIndex: 0 }, { dimensionIndex: 0, criterionIndex: 1 }])
  const context = { sourceFacts: { title: "Blue ink", itemHighlights: "Ink", bullets: ["Blue ink"], description: "", searchTerms: "",
    structuredAttributes: [{ name: "Color", value: "Blue" }, { name: "Ink Colour", value: "Blue" }, { name: "BSR", value: "100" }],
  } }
  const check = (index: number) => ({ index, weight: 3, errorType: "NONE", comparison: [], suggestion: "" })
  const incomplete = { dimensionIndex: 0, criterionIndex: 0, score: 16.5, status: "MISSING", description: "漏表仍有合计",
    deductions: [{ points: 13.5, ruleId: "attribute.required", reason: "属性问题", evidence: "Color: Blue" }],
    assessment: { attributeChecks: [check(1)] },
  }
  const first = acceptScoreCorrectionProgress(JSON.stringify({ corrections: [incomplete, titleCorrection()] }), plan, "amazon_us", context)
  expect(first.acceptedCriteria).toEqual([{ dimensionIndex: 0, criterionIndex: 1 }])
  expect(first.plan.criteria).toEqual([{ dimensionIndex: 0, criterionIndex: 0 }])
  expect(first.validationErrors[0]).toContain("缺失索引[2]")
  expect(first.validationErrors[0]).toContain("索引[1,2]")
  expect(first.plan.report.dimensions[0].criteria[0]).toEqual(plan.report.dimensions[0].criteria[0])
  const second = acceptScoreCorrectionProgress(JSON.stringify({ corrections: [{
    ...incomplete, assessment: { attributeChecks: [check(1), check(2)] },
  }] }), first.plan, "amazon_us", context)
  expect(second.validationErrors).toEqual([])
  expect(second.plan.criteria).toEqual([])
  expect(second.plan.report.dimensions[0].criteria[0]).toMatchObject({ score: 30, deductions: [] })
})

it("整报告回复仅凭唯一维度及细则名称接收请求项，不覆盖总分建议和无关评分", () => {
  const plan = createPlan([{ dimensionIndex: 0, criterionIndex: 1 }])
  plan.report.dimensions[0].criteria[1].name = "标题质量"
  plan.dimensionIndices = [1]
  const response = structuredClone(plan.report)
  response.total = 0
  response.potential = "越权评级"
  response.suggestions = ["越权建议"]
  response.dimensions[0].criteria[1].name = "无法识别的细则"
  response.dimensions[0].criteria[3] = { ...response.dimensions[0].criteria[3], ...titleCorrection(), name: "标题质量（25）" }
  response.dimensions[1].criteria[0].score = 0
  const penalty = { points: 2, ruleId: "keyword.titleLength", reason: "标题长201字符", evidence: "title=201字符" }
  response.dimensions[1].deductions = [penalty]
  response.dimensions.reverse()
  const progress = acceptScoreCorrectionProgress(JSON.stringify(response), plan, "amazon_us")
  expect(progress.acceptedCriteria).toEqual(plan.criteria)
  expect(progress.acceptedDimensions).toEqual([1])
  expect(progress.plan.report.dimensions[0].criteria[1]).toMatchObject({ name: "标题质量", maxScore: 25, score: 20 })
  expect(progress.plan.report.dimensions[0].criteria[3]).toEqual(plan.report.dimensions[0].criteria[3])
  expect(progress.plan.report.dimensions[1].criteria).toEqual(plan.report.dimensions[1].criteria)
  expect(progress.plan.report.dimensions[1].deductions).toEqual([penalty])
  expect(progress.plan.report.total).toBe(100)
  expect(progress.plan.report.potential).toBe("S级")
  expect(progress.plan.report.suggestions).toEqual(["保留原建议"])
})

it("整报告细则不存在唯一名称匹配时不按旧数组位置取值", () => {
  const plan = createPlan([{ dimensionIndex: 0, criterionIndex: 1 }])
  plan.report.dimensions[0].criteria[1].name = "标题质量"
  for (const kind of ["wrong", "duplicate"] as const) {
    const response = structuredClone(plan.report)
    response.dimensions[0].criteria[1] = { ...response.dimensions[0].criteria[1], ...titleCorrection(), name: kind === "wrong" ? "变体质量" : "标题质量" }
    if (kind === "duplicate") response.dimensions[0].criteria[3].name = "标题质量"
    const progress = acceptScoreCorrectionProgress(JSON.stringify(response), plan, "amazon_us")
    expect(progress.acceptedCriteria).toEqual([])
    expect(progress.plan).toEqual(plan)
    expect(progress.validationErrors[0]).toContain("0:1")
  }
})

it("整报告未知版本或重复维度名称不接受，并保留严格merge原有格式校验", () => {
  const plan = createPlan([{ dimensionIndex: 0, criterionIndex: 1 }])
  plan.report.dimensions[0].criteria[1].name = "标题质量"
  for (const kind of ["unknownVersion", "duplicateDimension"] as const) {
    const response = structuredClone(plan.report)
    Object.assign(response.dimensions[0].criteria[1], titleCorrection())
    if (kind === "unknownVersion") response.scoreVersion = "unknown"
    else response.dimensions[1].name = "CDQ完整性"
    const progress = acceptScoreCorrectionProgress(JSON.stringify(response), plan, "amazon_us")
    expect(progress.acceptedCriteria).toEqual([])
    expect(progress.plan).toEqual(plan)
    expect(() => mergeScoreCorrection(JSON.stringify(response), plan, "amazon_us", true)).toThrow("返回格式")
  }
})

it("维度重复子项扣分只去除三字段完全相同的已验证记录，合法维度额外扣分仍保留", () => {
  const plan = createPlan([])
  plan.dimensionIndices = [1]
  const repeated = { ruleId: "keyword.relevance", points: 2, reason: "属性中有无关型号", evidence: "Printer Model Compatibility: HP Officejet Pro 7720" }
  Object.assign(plan.report.dimensions[1].criteria[4], { score: 0, deductions: [repeated] })
  plan.report.dimensions[1].score = 23
  const extra = { ruleId: "keyword.titleLength", points: 1, reason: "标题过长", evidence: "title长201字符" }
  const response = { dimensionCorrections: [{ dimensionIndex: 1, deductions: [
    { ...repeated, reason: "相同问题另一说法", evidence: "  " + repeated.evidence + "  " }, extra,
  ] }] }
  const snapshot = structuredClone(response)
  const progress = acceptScoreCorrectionProgress(JSON.stringify(response), plan, "amazon_us")
  expect(progress.acceptedDimensions).toEqual([1])
  expect(progress.validationErrors).toEqual([])
  expect(progress.plan.report.dimensions[1].deductions).toEqual([extra])
  expect(progress.plan.report.dimensions[1].criteria[4].deductions).toEqual([repeated])
  expect(progress.plan.report.dimensions[1].score).toBe(22)
  expect(JSON.parse(mergeScoreCorrection('{"corrections":[]}', progress.plan, "amazon_us", true)).total).toBe(97)
  expect(response).toEqual(snapshot)
  expect(plan.report.dimensions[1].deductions).toEqual([])
})

it("不同证据或分值以及尚未核验的子项不能被跨层去重吞掉", () => {
  for (const kind of ["evidence", "points", "invalidChild", "pendingChild"] as const) {
    const plan = createPlan(kind === "pendingChild" ? [{ dimensionIndex: 1, criterionIndex: 4 }] : [])
    plan.dimensionIndices = [1]
    const deduction = { ruleId: "keyword.relevance", points: 2, reason: "无关型号", evidence: "Printer Model Compatibility: HP Officejet Pro 7720" }
    Object.assign(plan.report.dimensions[1].criteria[4], { score: kind === "invalidChild" ? 1 : 0, deductions: [deduction] })
    const candidate = { ...deduction }
    if (kind === "evidence") candidate.evidence = "另一个不同的原文证据"
    if (kind === "points") candidate.points = 1
    const progress = acceptScoreCorrectionProgress(JSON.stringify({ dimensionCorrections: [{ dimensionIndex: 1, deductions: [candidate] }] }), plan, "amazon_us")
    expect(progress.acceptedDimensions).toEqual([])
    expect(progress.plan.dimensionIndices).toEqual([1])
    expect(progress.plan.report).toEqual(plan.report)
    expect(progress.validationErrors.join("\n")).toContain("维度额外扣分必须属于原有规则")
  }
})

it("维度校对提示明确原有唯一允许规则并禁止再次复制子项扣分", () => {
  const plan = createPlan([])
  plan.dimensionIndices = [1, 2, 3]
  const request = buildScoreCorrectionRequest("原评分标准", "原始商品资料", plan)
  const payload = JSON.parse(request.userPrompt)
  const expected = [{ "keyword.titleLength": 10 }, {}, { "alexa.stuffing": 5 }]
  expect(payload.dimensionEvidence.map((item: { allowedRules: Record<string, number> }) => item.allowedRules)).toEqual(expected)
  expect(payload.expectedOutput.dimensionCorrections.map((item: { allowedRules: Record<string, number> }) => item.allowedRules)).toEqual(expected)
  expect(payload.dimensionEvidence[0].instructions).toContain("不得再次复制到维度层")
  expect(request.systemPrompt).toContain("不能复制到维度层重复扣分")
})
