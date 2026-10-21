import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CDQ_SCORE_VERSION, normalizeCdqScoreReport } from "./listing-cdq-score"
import { buildScoreCorrectionPlan, mergeScoreCorrection } from "./listing-score-correction"
import { extractScoreRecoveryCore, validateScoreReport } from "./listing-score-recovery"

function createReport() {
  return {
    scoreVersion: CDQ_SCORE_VERSION,
    mode: "standard",
    total: 100,
    potential: "S级",
    suggestions: ["建议保持已核验项"],
    dimensions: [
      [30, 25, 20, 15, 5, 5],
      [7, 7, 5, 4, 2],
      [10, 6, 4],
      [7, 5, 3],
    ].map((limits, index) => ({
      name: ["CDQ完整性", "关键词覆盖", "COSMO 关系覆盖", "Alexa 语义质量"][index],
      maxScore: [40, 25, 20, 15][index],
      weight: [40, 25, 20, 15][index],
      score: [40, 25, 20, 15][index] as number | null,
      criteria: limits.map((maxScore, criterionIndex) => ({
        name:
          index === 0
            ? ["结构化属性", "标题质量", "变体质量", "图片质量", "A+ 内容", "五点描述"][
                criterionIndex
              ]
            : `评分项${criterionIndex}`,
        maxScore,
        score: maxScore as number | null,
        status: "VERIFIED",
        description: "已完整取证，当前字段满足规则",
        deductions: [] as { points: number; reason: string }[],
      })),
    })),
  }
}

interface ParsedScore {
  total: number | null
  dimensions: Array<
    ReturnType<typeof createReport>["dimensions"][number] & {
      subtitle: string
      cdq: {
        applicableMax: number
        effectiveMax: number
        earnedScore: number
        normalizedScore: number | null
        evidenceCoverage: number
      }
    }
  >
}

describe("新版 CDQ 取证与折算", () => {
  it("实跑负分只复核异常项，图片扣分保留并统一已取证状态", () => {
    const text = readFileSync(join(__dirname, "fixtures/listing-score-cdq-20260916.json"), "utf8")
    const plan = buildScoreCorrectionPlan(text, "amazon_us")!
    expect(plan.criteria).toEqual([{ dimensionIndex: 3, criterionIndex: 2 }])
    expect(plan.shouldCorrectSuggestions).toBe(false)
    const result = JSON.parse(
      mergeScoreCorrection(
        JSON.stringify({
          corrections: [
            {
              dimensionIndex: 3,
              criterionIndex: 2,
              score: 1,
              description: "已核验描述缺少结构化规格及具体场景",
              deductions: [
                { points: 2, reason: "描述缺少结构化规格及具体场景，建议按现有参数补齐" },
              ],
            },
          ],
        }),
        plan,
        "amazon_us"
      )
    ) as ParsedScore
    expect(result.dimensions[0].criteria[3]).toMatchObject({ score: 10.5, status: "MISSING" })
    expect(result.dimensions[0].cdq).toMatchObject({
      effectiveMax: 50,
      earnedScore: 45.5,
      normalizedScore: 91,
      evidenceCoverage: 0.5,
    })
    expect(result.total).toBe(88.5666) // 后台搜索词未获取，不再扣4分。
  })

  it("完整六维100分折算40分；其他三维保持60分", () => {
    const report = JSON.parse(
      validateScoreReport(JSON.stringify(createReport()), "amazon_us")
    ) as ParsedScore
    expect(report.total).toBe(100)
    expect(report.dimensions[0]).toMatchObject({
      score: 40,
      cdq: {
        applicableMax: 100,
        effectiveMax: 100,
        earnedScore: 100,
        normalizedScore: 100,
        evidenceCoverage: 1,
      },
    })
  })

  it("未获取属性保留适用权重，无变体N/A剔除，已核验标题扣分按有效满分折算", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[0], { status: "UNAVAILABLE", score: null })
    Object.assign(report.dimensions[0].criteria[2], {
      status: "NOT_APPLICABLE",
      score: null,
      description: "确认单SKU且类目不支持变体",
    })
    Object.assign(report.dimensions[0].criteria[1], {
      status: "MISSING",
      score: 20,
      deductions: [{ points: 5, reason: "标题当前201字符，超过200，建议缩短至200以内" }],
    })
    const result = JSON.parse(
      validateScoreReport(JSON.stringify(report), "amazon_us")
    ) as ParsedScore
    expect(result.dimensions[0]).toMatchObject({
      score: 36,
      cdq: {
        applicableMax: 80,
        effectiveMax: 50,
        earnedScore: 45,
        normalizedScore: 90,
        evidenceCoverage: 0.625,
      },
    })
    expect(result.dimensions[0].subtitle).toContain("证据覆盖率 62.5%")
    expect(result.total).toBe(96)
    expect(result.dimensions[0].criteria[0].score).toBeNull()
  })

  it("所有字段未获取时不出CDQ分或综合分", () => {
    const report = createReport()
    report.dimensions[0].criteria.forEach(criterion =>
      Object.assign(criterion, { status: "UNAVAILABLE", score: null })
    )
    const result = JSON.parse(
      validateScoreReport(JSON.stringify(report), "amazon_us")
    ) as ParsedScore
    expect(result.total).toBeNull()
    expect(result.dimensions[0].score).toBeNull()
    expect(result.dimensions[0].cdq.normalizedScore).toBeNull()
    expect(result.dimensions[0].cdq.evidenceCoverage).toBe(0)
  })

  it("标题违禁仅标题25分归零，保留其他三维分数", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[1], {
      status: "MISSING",
      score: 0,
      deductions: [{ points: 25, reason: "标题含Free Shipping，建议删除促销词" }],
    })
    const result = JSON.parse(
      validateScoreReport(JSON.stringify(report), "amazon_us")
    ) as ParsedScore
    expect(result.dimensions[0].score).toBe(30)
    expect(result.total).toBe(90)
  })

  it("1–2条五点可计半分，不触发旧条数纠错；截断尾部可恢复", () => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[5], {
      status: "MISSING",
      score: 2.5,
      description: "五点当前2条，至少3条满分",
      deductions: [{ points: 2.5, reason: "五点当前2条，建议补足3条" }],
    })
    expect(buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us")).toBeNull()
    const core = {
      scoreVersion: report.scoreVersion,
      mode: report.mode,
      total: report.total,
      dimensions: report.dimensions,
    }
    expect(
      extractScoreRecoveryCore(
        JSON.stringify(core).slice(0, -1) + ',"suggestions":["未完成',
        "amazon_us"
      )
    ).toEqual(core)
    expect(normalizeCdqScoreReport(report).total).toBe(99)
  })

  it.each([0, 30])("未获取项禁止填%d分", score => {
    const report = createReport()
    Object.assign(report.dimensions[0].criteria[0], { status: "UNAVAILABLE", score })
    expect(() => validateScoreReport(JSON.stringify(report), "amazon_us")).toThrow()
  })

  it("拒绝未知状态、错误权重、无理由扣分和非法N/A", () => {
    for (const patch of [
      { status: "UNKNOWN" },
      { maxScore: 12 },
      { score: 29 },
      { status: "NOT_APPLICABLE", score: null },
    ]) {
      const report = createReport()
      Object.assign(report.dimensions[0].criteria[0], patch)
      expect(() => normalizeCdqScoreReport(report)).toThrow()
    }
  })
})
