import { normalizeUnavailableSearchTerms } from "./listing-search-terms-score"
import { normalizeCdqImageCriterion } from "./listing-cdq-image-score"

/** CDQ 标准化提示词 2026-09-16；前后端共用同一契约（同步文件）。 */
export const CDQ_SCORE_VERSION = "cdq-2026-09-16"
const CDQ_LIMITS = [30, 25, 20, 15, 5, 5]
const DIMENSION_LIMITS = [40, 25, 20, 15]
const OTHER_LIMITS = [
  [7, 7, 5, 4, 2],
  [10, 6, 4],
  [7, 5, 3],
]
const DIMENSION_NAMES = [/^CDQ完整性$/, /关键词/, /COSMO/i, /Alexa/i]
const roundScore = (value: number) => Math.round(value * 10000) / 10000
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export function isCdqScoreReport(value: unknown): boolean {
  return isRecord(value) && value.scoreVersion === CDQ_SCORE_VERSION
}

/** 校验取证状态和扣分依据，并由程序计算折算分。不给未获取项补分。 */
export function normalizeCdqScoreReport(value: unknown): Record<string, unknown> {
  const fail = (): never => {
    throw new Error("CDQ评分数据与取证状态不一致，请重新评分")
  }
  if (
    !isRecord(value) ||
    !isCdqScoreReport(value) ||
    !Array.isArray(value.dimensions) ||
    value.dimensions.length !== 4
  )
    return fail()
  const report = structuredClone(normalizeUnavailableSearchTerms(value))
  const dimensions = report.dimensions as Record<string, unknown>[]
  let applicableMax = 100
  let effectiveMax = 100
  let earnedScore = 0
  dimensions.forEach((dimension, index) => {
    const limits = index === 0 ? CDQ_LIMITS : OTHER_LIMITS[index - 1]
    if (
      !isRecord(dimension) ||
      typeof dimension.name !== "string" ||
      !DIMENSION_NAMES[index].test(dimension.name) ||
      dimension.maxScore !== DIMENSION_LIMITS[index] ||
      dimension.weight !== DIMENSION_LIMITS[index] ||
      !Array.isArray(dimension.criteria) ||
      dimension.criteria.length !== limits.length
    )
      return fail()
    let sum = 0
    dimension.criteria.forEach((criterion: unknown, criterionIndex: number) => {
      if (
        !isRecord(criterion) ||
        typeof criterion.name !== "string" ||
        !criterion.name.trim() ||
        criterion.maxScore !== limits[criterionIndex] ||
        typeof criterion.description !== "string" ||
        !criterion.description.trim() ||
        !Array.isArray(criterion.deductions)
      )
        return fail()
      const { status, score, maxScore, deductions } = criterion
      if (index === 0) {
        if (!["VERIFIED", "MISSING", "UNAVAILABLE", "NOT_APPLICABLE"].includes(String(status)))
          return fail()
        if (status === "UNAVAILABLE" || status === "NOT_APPLICABLE") {
          if (score !== null || deductions.length) return fail()
          effectiveMax -= Number(maxScore)
          if (status === "NOT_APPLICABLE") {
            if (![2, 4].includes(criterionIndex)) return fail()
            applicableMax -= Number(maxScore)
          }
          return
        }
      }
      if (
        typeof score !== "number" ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > Number(maxScore)
      )
        return fail()
      let deducted = 0
      for (const deduction of deductions) {
        if (
          !isRecord(deduction) ||
          typeof deduction.points !== "number" ||
          !Number.isFinite(deduction.points) ||
          deduction.points <= 0 ||
          typeof deduction.reason !== "string" ||
          !deduction.reason.trim()
        )
          return fail()
        deducted += deduction.points
      }
      if (Math.abs(score + deducted - Number(maxScore)) > 0.0001) return fail()
      if (index === 0 && criterionIndex === 3) normalizeCdqImageCriterion(criterion)
      // 状态及汇总采用校验后的有效扣分。
      if (index === 0) criterion.status = (criterion.deductions as unknown[]).length > 0 ? "MISSING" : "VERIFIED"
      sum += Number(criterion.score)
    })
    if (index === 0) {
      earnedScore = roundScore(sum)
      dimension.score = effectiveMax > 0 ? roundScore((40 * sum) / effectiveMax) : null
      const normalizedScore = effectiveMax > 0 ? roundScore((100 * sum) / effectiveMax) : null
      dimension.cdq = {
        applicableMax,
        effectiveMax,
        earnedScore,
        normalizedScore,
        evidenceCoverage: applicableMax > 0 ? effectiveMax / applicableMax : null,
      }
      const grade =
        normalizedScore === null
          ? ""
          : normalizedScore >= 90
            ? "优秀"
            : normalizedScore >= 80
              ? "良好"
              : normalizedScore >= 60
                ? "一般"
                : "待改善"
      dimension.subtitle =
        effectiveMax === 0
          ? "未获取评分证据 · 暂不出分"
          : `${effectiveMax === applicableMax ? "完整最终分" : `折算分 · 证据覆盖率 ${roundScore((100 * effectiveMax) / applicableMax)}%`} · ${grade}`
    } else if (
      typeof dimension.score !== "number" ||
      !Number.isFinite(dimension.score) ||
      dimension.score < 0 ||
      dimension.score > roundScore(sum)
    )
      return fail()
  })
  const total =
    effectiveMax > 0
      ? roundScore(dimensions.reduce((sum, dimension) => sum + Number(dimension.score), 0))
      : null
  report.total = total
  report.potential =
    total === null
      ? "证据不足 · 暂不出综合分"
      : total >= 90
        ? "S级 · 可直接上线"
        : total >= 80
          ? "A级 · 小幅调整后上线"
          : total >= 68
            ? "B级 · 优化后上线"
            : total >= 55
              ? "C级 · 建议重新生成"
              : "D级 · 必须重新生成"
  // 新版标题违禁仅影响标题子项；旧报告的全局归零标记不得传入新模型。
  delete report.severeDefects
  return report
}
