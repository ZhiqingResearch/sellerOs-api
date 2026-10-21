import { buildScoreCorrectionPlan, CDQ_DIMENSION_METADATA, mergeScoreCorrection, type ScoreCorrectionPlan } from "./listing-score-correction"
import { extractScoreRecoveryCore, mergeScoreRepair, validateScoreReport } from "./listing-score-recovery"
import { validateListingReportRules } from "./listing-score-rules"
import { buildCdqStructureRecoveryPlan } from "./listing-score-structure-recovery"

interface FixtureDeduction {
  ruleId: string
  reason: string
  evidence: string
  points: number
  checkId?: string
}

interface FixtureCriterion {
  name: string
  maxScore: number
  score: number
  description: string
  status?: string
  deductions: FixtureDeduction[]
}

function buildReport() {
  const report = {
    scoreVersion: "cdq-2026-09-16", mode: "standard", total: 100,
    suggestions: ["减少标题重复词，补充未覆盖长尾词和规格场景"], potential: "S级",
    dimensions: CDQ_DIMENSION_METADATA.map((metadata, dimensionIndex) => ({
      name: metadata.name, maxScore: metadata.maxScore, weight: metadata.maxScore, score: metadata.maxScore,
      criteria: metadata.criteria.map(([name, maxScore]): FixtureCriterion => ({
        name, maxScore, score: maxScore, description: `${name}：已根据原始资料核验`, deductions: [],
        ...(dimensionIndex === 0 ? { status: "VERIFIED" } : {}),
      })), deductions: [] as FixtureDeduction[],
    })),
  }
  const deduct = (dimensionIndex: number, criterionIndex: number, deduction: FixtureDeduction) => {
    const criterion = report.dimensions[dimensionIndex].criteria[criterionIndex]
    criterion.deductions.push(deduction)
    criterion.score -= deduction.points
    if (dimensionIndex === 0) criterion.status = "MISSING"
    else report.dimensions[dimensionIndex].score -= deduction.points
  }
  deduct(0, 1, { ruleId: "title.repeat", points: 2.5, reason: "标题同词出现三次", evidence: "title: ink ink ink" })
  deduct(1, 2, { ruleId: "keyword.longtail", points: 1, reason: "长尾词未充分覆盖", evidence: "原始词表25个，Bullet/描述/后台词合计覆盖14个，覆盖率56%" })
  deduct(2, 2, { ruleId: "cosmo.medium", points: 1.5, reason: "中优先级关系距三类缺一类", evidence: "仅IS_A及USED_TO有原文证据" })
  deduct(3, 2, { ruleId: "alexa.description", points: 1, reason: "描述没有规格段", evidence: "description未包含结构化规格", checkId: "specifications" })
  deduct(3, 2, { ruleId: "alexa.description", points: 1, reason: "描述没有总览具体场景", evidence: "description未包含PRODUCT OVERVIEW具体场景", checkId: "overview_scenes" })
  return JSON.parse(validateScoreReport(JSON.stringify(report), "amazon_us")) as typeof report
}

function buildPatch(plan: ScoreCorrectionPlan, report: ReturnType<typeof buildReport>) {
  return {
    corrections: plan.criteria.map(({ dimensionIndex, criterionIndex }) => {
      const criterion = report.dimensions[dimensionIndex].criteria[criterionIndex]
      return { dimensionIndex, criterionIndex, score: criterion.score, description: criterion.description,
        deductions: criterion.deductions, ...(criterion.status ? { status: criterion.status } : {}) }
    }),
    ...(plan.dimensionIndices?.length ? {
      dimensionCorrections: plan.dimensionIndices.map(dimensionIndex => ({ dimensionIndex, deductions: report.dimensions[dimensionIndex].deductions })),
    } : {}),
    ...(plan.pendingTailFields?.includes("suggestions") ? { suggestions: report.suggestions } : {}),
  }
}

function expectMergedReport(plan: ScoreCorrectionPlan, report: ReturnType<typeof buildReport>) {
  const patch = buildPatch(plan, report)
  // 占位分不能直接放行，少返回任何一个待核验项都会拒绝合并。
  expect(() => mergeScoreCorrection(JSON.stringify({ ...patch, corrections: patch.corrections.slice(1) }), plan, "amazon_us", true)).toThrow()
  const mergedText = mergeScoreCorrection(JSON.stringify(patch), plan, "amazon_us", true)
  const merged = JSON.parse(mergedText)
  expect(merged.total).toBe(94.5)
  expect(merged.total).toBeLessThan(100)
  expect(mergedText).not.toContain("原始评分结构缺失")
  expect(mergedText).not.toContain("仅用于结构验证的占位")
  expect(merged.dimensions.map(({ criteria }) => criteria)).toEqual(report.dimensions.map(({ criteria }) => criteria))
  expect(() => validateListingReportRules(merged)).not.toThrow()
  return merged
}

describe("CDQ结构缺失进入原文取证恢复", () => {
  it("缺中间关键词维时按名称保留COSMO及Alexa，不按下标错位改分", () => {
    const complete = buildReport()
    const partial = structuredClone(complete)
    partial.dimensions.splice(1, 1)
    const plan = buildCdqStructureRecoveryPlan(JSON.stringify(partial), "amazon_us")!
    expect(plan.criteria).toEqual(complete.dimensions[1].criteria.map((_, criterionIndex) => ({ dimensionIndex: 1, criterionIndex })))
    expect(plan.dimensionIndices).toEqual([1])
    for (const dimensionIndex of [0, 2, 3]) expect(plan.report.dimensions[dimensionIndex]).toEqual(complete.dimensions[dimensionIndex])
    const merged = expectMergedReport(plan, complete)
    for (const dimensionIndex of [0, 2, 3]) expect(merged.dimensions[dimensionIndex]).toEqual(complete.dimensions[dimensionIndex])
  })

  it("维度缺中间子项时整个受影响维度重新取证，其他维度保持完整原值", () => {
    const complete = buildReport()
    const partial = structuredClone(complete)
    partial.dimensions[3].criteria.splice(1, 1)
    const plan = buildCdqStructureRecoveryPlan(JSON.stringify(partial), "amazon_us")!
    expect(plan.criteria).toEqual(complete.dimensions[3].criteria.map((_, criterionIndex) => ({ dimensionIndex: 3, criterionIndex })))
    expect(plan.dimensionIndices).toEqual([3])
    for (const dimensionIndex of [0, 1, 2]) expect(plan.report.dimensions[dimensionIndex]).toEqual(complete.dimensions[dimensionIndex])
    expectMergedReport(plan, complete)
  })

  it("已声明新版但JSON截断时所有17项都必须重新取证，评级和建议补齐后才返回", () => {
    const complete = buildReport()
    const truncated = '{"scoreVersion":"cdq-2026-09-16","mode":"standard","dimensions":[{"name":"CDQ完整性","criteria":['
    const plan = buildCdqStructureRecoveryPlan(truncated, "amazon_us")!
    expect(plan.criteria).toEqual(complete.dimensions.flatMap((dimension, dimensionIndex) =>
      dimension.criteria.map((_, criterionIndex) => ({ dimensionIndex, criterionIndex }))))
    expect(plan.criteria).toHaveLength(17)
    expect(plan.dimensionIndices).toEqual([1, 2, 3])
    expect(plan.pendingTailFields).toEqual(["suggestions", "potential"])
    const merged = expectMergedReport(plan, complete)
    expect(merged.suggestions).toEqual(complete.suggestions)
    expect(merged.potential).toBe("S级 · 可直接上线")
  })

  it("完整报告不创建结构恢复计划，未知旧版本和无版本截断不套用新规则", () => {
    expect(buildCdqStructureRecoveryPlan(JSON.stringify(buildReport()), "amazon_us")).toBeNull()
    expect(buildCdqStructureRecoveryPlan('{"dimensions":[', "amazon_us")).toBeNull()
    expect(buildCdqStructureRecoveryPlan('{"scoreVersion":"legacy","dimensions":[]}', "amazon_us")).toBeNull()
  })

  it("完整评分核心只有suggestions截断时保留核心并交尾部恢复，不重新取证17项", () => {
    const complete = buildReport()
    const coreText = JSON.stringify({ scoreVersion: complete.scoreVersion, mode: complete.mode,
      total: complete.total, dimensions: complete.dimensions })
    const truncated = coreText.slice(0, -1) + ',"suggestions":["未完成的建议'
    expect(buildCdqStructureRecoveryPlan(truncated, "amazon_us")).toBeNull()
    const core = extractScoreRecoveryCore(truncated, "amazon_us")
    expect(core.dimensions).toEqual(complete.dimensions)
    const merged = JSON.parse(mergeScoreRepair(JSON.stringify({ suggestions: complete.suggestions,
      potential: complete.potential }), core, "amazon_us"))
    expect(merged.dimensions).toEqual(complete.dimensions)
    expect(merged.total).toBe(94.5)
  })

  it("附加无关第五维时仅剔除无关结构，不改四维事实或发起取证", () => {
    const complete = buildReport()
    const extended = { ...structuredClone(complete), dimensions: [
      ...complete.dimensions, { name: "无关附加维度", maxScore: 8, weight: 8, score: 8, criteria: [] },
    ] }
    const plan = buildCdqStructureRecoveryPlan(JSON.stringify(extended), "amazon_us")!
    expect(plan.criteria).toEqual([])
    expect(plan.dimensionIndices).toBeUndefined()
    expect(plan.report.dimensions).toEqual(complete.dimensions)
    const merged = JSON.parse(mergeScoreCorrection('{"corrections":[]}', plan, "amazon_us", true))
    expect(merged).toEqual(complete)
  })

  it("维度中单一null槽保留已知索引，仅交普通计划核验这一项", () => {
    const complete = buildReport()
    const partial = structuredClone(complete)
    ;(partial.dimensions[3].criteria as Array<FixtureCriterion | null>)[1] = null
    const rawText = JSON.stringify(partial)
    expect(buildCdqStructureRecoveryPlan(rawText, "amazon_us")).toBeNull()
    const plan = buildScoreCorrectionPlan(rawText, "amazon_us", true)!
    expect(plan.criteria).toEqual([{ dimensionIndex: 3, criterionIndex: 1 }])
    expectMergedReport(plan, complete)
    for (const dimensionIndex of [0, 1, 2]) expect(plan.report.dimensions[dimensionIndex]).toEqual(complete.dimensions[dimensionIndex])
  })

  it("COSMO与Alexa同为三项时交换位置也按名称归位，仅修元数据不重评", () => {
    const complete = buildReport()
    const swapped = structuredClone(complete)
    const originalCosmo = swapped.dimensions[2]
    swapped.dimensions[2] = swapped.dimensions[3]
    swapped.dimensions[3] = originalCosmo
    const plan = buildCdqStructureRecoveryPlan(JSON.stringify(swapped), "amazon_us")!
    expect(plan.criteria).toEqual([])
    expect(plan.dimensionIndices).toBeUndefined()
    expect(plan.report.dimensions).toEqual(complete.dimensions)
    const merged = JSON.parse(mergeScoreCorrection('{"corrections":[]}', plan, "amazon_us", true))
    expect(merged).toEqual(complete)
  })

})
