import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildScoreCorrectionPlan,
  mergeScoreCorrection,
  type ScoreCorrectionReport,
} from "./listing-score-correction"

const parseReport = (value: string) => JSON.parse(value) as ScoreCorrectionReport

// 生产失败正文解析后的完整对象，仅调整 JSON 排版，不包含用户/账单标识。
const original = parseReport(
  readFileSync(join(__dirname, "fixtures/listing-score-20260915.json"), "utf8")
)
const text = JSON.stringify(original)
const correction = {
  dimensionIndex: 0,
  criterionIndex: 5,
  score: 2,
  description: "逐条核对后内容和格式均符合规则",
  deductions: [],
}
const patch = { corrections: [correction] }

describe("完整评分异常项目恢复", () => {
  it("逐一向全部17个评分项注入空依据零分，均可定点恢复而不改动其他项目", () => {
    for (const [dimensionIndex, dimension] of original.dimensions.entries()) {
      for (const [criterionIndex, criterion] of dimension.criteria.entries()) {
        for (const deductions of [[], [{ points: 0, reason: "无明显问题" }]]) {
          const report = structuredClone(original)
          report.suggestions = []
          report.total = 100
          for (const item of report.dimensions) {
            item.score = item.maxScore
            for (const entry of item.criteria) {
              entry.score = entry.maxScore
              entry.deductions = []
            }
          }
          report.dimensions[0].criteria[5].description = "逐条核验内容"
          Object.assign(report.dimensions[dimensionIndex].criteria[criterionIndex], {
            score: 0,
            deductions,
          })
          const plan = buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us")!
          expect(plan.criteria).toEqual([{ dimensionIndex, criterionIndex }])
          const result = parseReport(
            mergeScoreCorrection(
              JSON.stringify({
                corrections: [
                  {
                    dimensionIndex,
                    criterionIndex,
                    score: criterion.maxScore,
                    description: "原始资料符合对应标准",
                    deductions: [],
                  },
                ],
              }),
              plan,
              "amazon_us"
            )
          )
          expect(result.total).toBe(100)
          expect(result.dimensions.every(item => item.score === item.maxScore)).toBe(true)
        }
      }
    }
  })

  it("生产原文精确定位异常项，后台词未获取不扣分，其余项目保留", () => {
    const plan = buildScoreCorrectionPlan(text, "amazon_us")!
    expect(plan.criteria).toEqual([{ dimensionIndex: 0, criterionIndex: 5 }])
    expect(plan.shouldCorrectSuggestions).toBe(true)
    const result = parseReport(mergeScoreCorrection(JSON.stringify(patch), plan, "amazon_us"))
    expect(result.total).toBe(81)
    expect(result.dimensions[0].score).toBe(28)
    expect(result.dimensions[0].criteria.slice(0, 5)).toEqual(
      original.dimensions[0].criteria.slice(0, 5)
    )
    expect(result.dimensions.slice(2)).toEqual(original.dimensions.slice(2))
    expect(result.dimensions[1].criteria.filter((_, index) => index !== 3)).toEqual(
      original.dimensions[1].criteria.filter((_, index) => index !== 3)
    )
    expect(result.dimensions[1].criteria[3]).toMatchObject({
      score: 4, description: "SEARCH TERMS未获取", deductions: [],
    })
    expect(result.suggestions).toEqual(original.suggestions.slice(0, 4))
    expect(original.dimensions[0].criteria[5].score).toBe(0)
  })

  it("可以核对出真实扣分，不把空依据机械改成满分", () => {
    const result = parseReport(
      mergeScoreCorrection(
        JSON.stringify({
          ...patch,
          corrections: [
            {
              ...correction,
              score: 1,
              deductions: [{ points: 1, reason: "具体条目缺少所需格式" }],
            },
          ],
        }),
        buildScoreCorrectionPlan(text)!,
        "amazon_us"
      )
    )
    expect(result.total).toBe(80)
    expect(result.dimensions[0].criteria[5].score).toBe(1)
  })

  it.each(["score", "reason", "duplicate", "otherCriterion", "total", "newField"])(
    "核对不能带回非法或越权修改：%s",
    fault => {
      const candidate = structuredClone(patch) as {
        corrections: (typeof correction & { maxScore?: number })[]
        total?: number
      }
      if (fault === "score") candidate.corrections[0].score = 0
      if (fault === "reason") candidate.corrections[0].description = "Bullet 数量超过 5 条"
      if (fault === "duplicate") candidate.corrections.push(candidate.corrections[0])
      if (fault === "otherCriterion") candidate.corrections[0].criterionIndex = 4
      if (fault === "total") candidate.total = 100
      if (fault === "newField") candidate.corrections[0].maxScore = 5
      expect(() =>
        mergeScoreCorrection(
          JSON.stringify(candidate),
          buildScoreCorrectionPlan(text)!,
          "amazon_us"
        )
      ).toThrow()
    }
  )

  it.each(["Bullet 建议精简至 5 条以内", "Bullet 至少 3 条", "Reduce to five bullet points"])(
    "即使分数算术正确，错误条数规则也进入核对：%s",
    reason => {
      const valid = parseReport(
        mergeScoreCorrection(JSON.stringify(patch), buildScoreCorrectionPlan(text)!, "amazon_us")
      )
      valid.suggestions.push(reason)
      const plan = buildScoreCorrectionPlan(JSON.stringify(valid), "amazon_us")!
      expect(plan.criteria).toEqual([])
      expect(plan.shouldCorrectSuggestions).toBe(true)
      expect(parseReport(mergeScoreCorrection('{"corrections":[]}', plan, "amazon_us")).total).toBe(
        81
      )
    }
  )

  it.each([
    "Bullet 5 中的型号与标题不一致",
    "每条 Bullet 长度至少 150 字符",
    "建议主图至少 5 张",
    "提供 7 条 Bullet，内容详实",
  ])("不误判条目编号、字符长度、图片数量和事实描述：%s", reason => {
    const valid = parseReport(
      mergeScoreCorrection(JSON.stringify(patch), buildScoreCorrectionPlan(text)!, "amazon_us")
    )
    valid.suggestions.push(reason)
    expect(buildScoreCorrectionPlan(JSON.stringify(valid), "amazon_us")).toBeNull()
  })

  it.each(["half", "severe", "policy"])("恢复保留维度惩罚及总分封顶：%s", kind => {
    const report = structuredClone(original)
    if (kind === "half") report.dimensions[0].score = 13
    if (kind === "severe") report.severeDefects = ["属性严重缺失"]
    if (kind === "policy") {
      report.total = 40
      report.potential = "D级 · 必须重新生成"
    }
    const result = parseReport(
      mergeScoreCorrection(
        JSON.stringify(patch),
        buildScoreCorrectionPlan(JSON.stringify(report))!,
        "amazon_us"
      )
    )
    expect(result.total).toBe(kind === "half" ? 67 : kind === "severe" ? 0 : 40)
    if (kind === "half") expect(result.dimensions[0].score).toBe(14)
  })

  it("custom 的独立标准不被 standard 覆盖", () => {
    const report = structuredClone(original)
    report.mode = "custom"
    report.dimensions[0].criteria[5].score = 2
    expect(buildScoreCorrectionPlan(JSON.stringify(report), "amazon_us")).toBeNull()
  })
})
