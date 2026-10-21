import { readFileSync } from "node:fs"
import { join } from "node:path"
import { recalculateCdqScoreSummary } from "./listing-cdq-summary"

const createReport = () => JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-summary-20260917.json"), "utf8"))

describe("CDQ 汇总仅做算术，不拦截报告或改写细则", () => {
  it("真实截图57分按有效细则折算为79分，保留原始小数和其他维度整维扣分", () => {
    const report = createReport()
    const original = structuredClone(report)
    const result = recalculateCdqScoreSummary(report)
    expect(result.dimensions[0].cdq).toMatchObject({
      applicableMax: 100, effectiveMax: 80, earnedScore: 62.8571,
      normalizedScore: 78.5714, evidenceCoverage: 0.8,
    })
    expect(result.dimensions[0].score).toBe(31.4286)
    expect(result.total).toBe(86.4286)
    expect(result.potential).toBe("A级 · 小幅调整后上线")
    expect(result.dimensions[0].criteria).toEqual(report.dimensions[0].criteria)
    expect(result.dimensions.slice(1)).toEqual(report.dimensions.slice(1))
    expect(result.validationStatus).toBe("BEST_EFFORT")
    expect(report).toEqual(original)
    expect(recalculateCdqScoreSummary(result)).toEqual(result)
  })

  it("N/A减适用和有效分母，未获取仅减有效分母", () => {
    const report = createReport()
    report.dimensions[0].criteria[2].status = "NOT_APPLICABLE"
    Object.assign(report.dimensions[0].criteria[4], { status: "UNAVAILABLE", score: null })
    expect(recalculateCdqScoreSummary(report).dimensions[0].cdq).toMatchObject({
      applicableMax: 80, effectiveMax: 75, earnedScore: 57.8571,
      normalizedScore: 77.1428, evidenceCoverage: 0.9375,
    })
  })

  it.each(["UNAVAILABLE", "NOT_APPLICABLE"])("全部%s时不除零，也不补零分或满分", status => {
    const report = createReport()
    report.dimensions[0].criteria.forEach((criterion: { status: string; score: number | null }) => Object.assign(criterion, { status, score: null }))
    const result = recalculateCdqScoreSummary(report)
    expect(result.dimensions[0].score).toBeNull()
    expect(result.dimensions[0].cdq.normalizedScore).toBeNull()
    expect(result.dimensions[0].cdq.earnedScore).toBe(0)
    expect(result.dimensions[0].cdq.evidenceCoverage).toBe(status === "UNAVAILABLE" ? 0 : null)
    expect(result.total).toBeNull()
  })

  it("空分数缺状态时不猜测获取状态，直接保留报告", () => {
    const report = createReport()
    delete report.dimensions[0].criteria[2].status
    expect(recalculateCdqScoreSummary(report)).toBe(report)
  })

  it("旧版本与非CDQ报告保持原有汇总", () => {
    const report = createReport()
    delete report.scoreVersion
    expect(recalculateCdqScoreSummary(report)).toBe(report)
  })
})