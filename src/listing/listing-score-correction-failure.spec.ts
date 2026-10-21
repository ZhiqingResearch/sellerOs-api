import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseListingJsonObject } from "./listing-result-parser"
import { buildScoreCorrectionPlan, mergeScoreCorrection } from "./listing-score-correction"

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/listing-score-failure-20260916.json"), "utf8")
) as { original: string; repair: string }

interface RepairedCriterion {
  score: number | null
  status?: string
  description: string
  deductions: Array<{ points: number; reason: string; ruleId?: string; evidence?: string }>
}

const repairedReport = parseListingJsonObject(fixture.repair) as {
  dimensions: Array<{ criteria: RepairedCriterion[] }>
}

describe("真实整报告修复失败的防回归", () => {
  it("拒绝模型回传整报告，不能覆盖未请求复核的项目", () => {
    const plan = buildScoreCorrectionPlan(fixture.original, "amazon_us", true)!
    const snapshot = structuredClone(plan.report)
    const unrelatedCriteria = [
      { dimensionIndex: 0, criterionIndex: 4 },
      { dimensionIndex: 1, criterionIndex: 2 },
      { dimensionIndex: 2, criterionIndex: 0 },
      { dimensionIndex: 3, criterionIndex: 0 },
    ]

    for (const item of unrelatedCriteria) {
      expect(plan.criteria).not.toContainEqual(item)
      expect(repairedReport.dimensions[item.dimensionIndex].criteria[item.criterionIndex].score)
        .not.toBe(plan.report.dimensions[item.dimensionIndex].criteria[item.criterionIndex].score)
    }
    expect(() => mergeScoreCorrection(fixture.repair, plan, "amazon_us", true)).toThrow()
    expect(plan.report).toEqual(snapshot)
  })

  it("即使只抽取请求项，缺少规则和证据的扣分也不能放行", () => {
    const plan = buildScoreCorrectionPlan(fixture.original, "amazon_us", true)!
    const snapshot = structuredClone(plan.report)
    const corrections = plan.criteria.map(item => {
      const criterion = repairedReport.dimensions[item.dimensionIndex].criteria[item.criterionIndex]
      return {
        ...item,
        score: criterion.score,
        ...(criterion.status ? { status: criterion.status } : {}),
        description: criterion.description,
        deductions: criterion.deductions,
      }
    })
    const deductions = corrections.flatMap(item => item.deductions)
    expect(deductions.length).toBeGreaterThan(0)
    expect(deductions.every(item => item.ruleId === undefined && item.evidence === undefined)).toBe(true)

    expect(() => mergeScoreCorrection(JSON.stringify({
      corrections,
      dimensionCorrections: [{ dimensionIndex: 1, deductions: [] }],
    }), plan, "amazon_us", true)).toThrow()
    expect(plan.report).toEqual(snapshot)
  })
})
