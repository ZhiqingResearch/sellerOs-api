/** 仅重算新版 CDQ 的加总、折算和总分，不判断证据，也不改写任何评分细则。前后端同步。 */
const CDQ_SCORE_VERSION = "cdq-2026-09-16"
const CDQ_CRITERION_LIMITS = [30, 25, 20, 15, 5, 5]
const CDQ_WEIGHT = 40
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const isFiniteScore = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
const roundScore = (value: number) => Math.round(value * 10000) / 10000

export function recalculateCdqScoreSummary<T>(value: T): T {
  if (!isRecord(value) || value.scoreVersion !== CDQ_SCORE_VERSION ||
    !Array.isArray(value.dimensions) || value.dimensions.length !== 4) return value
  const [dimension, ...otherDimensions] = value.dimensions
  if (!isRecord(dimension) || dimension.maxScore !== CDQ_WEIGHT ||
    !Array.isArray(dimension.criteria) || dimension.criteria.length !== CDQ_CRITERION_LIMITS.length) return value
  // 其他维度可能含维度级扣分，直接沿用已有维度分，不能用小项重新覆盖。
  if (!otherDimensions.every(item => isRecord(item) && isFiniteScore(item.score))) return value
  let applicableMax = 100
  let effectiveMax = 100
  let earnedScore = 0
  for (const [index, criterion] of dimension.criteria.entries()) {
    const maxScore = CDQ_CRITERION_LIMITS[index]
    if (!isRecord(criterion) || criterion.maxScore !== maxScore) return value
    if (criterion.status === "NOT_APPLICABLE") {
      applicableMax -= maxScore
      effectiveMax -= maxScore
    } else if (criterion.status === "UNAVAILABLE") {
      effectiveMax -= maxScore
    } else {
      // 缺失或不可计算的分数保持原报告，不编造得分，也不抛出交付错误。
      if (!isFiniteScore(criterion.score) || criterion.score < 0 || criterion.score > maxScore) return value
      earnedScore += criterion.score
    }
  }
  earnedScore = roundScore(earnedScore)
  const normalizedScore = effectiveMax > 0 ? roundScore(100 * earnedScore / effectiveMax) : null
  const score = effectiveMax > 0 ? roundScore(CDQ_WEIGHT * earnedScore / effectiveMax) : null
  const total = score === null ? null : roundScore(score + otherDimensions.reduce((sum, item) => sum + item.score, 0))
  const potential = total === null ? "证据不足 · 暂不出综合分"
    : total >= 90 ? "S级 · 可直接上线"
    : total >= 80 ? "A级 · 小幅调整后上线"
    : total >= 68 ? "B级 · 优化后上线"
    : total >= 55 ? "C级 · 建议重新生成"
    : "D级 · 必须重新生成"
  return {
    ...value,
    dimensions: [{
      ...dimension,
      score,
      cdq: {
        ...(isRecord(dimension.cdq) ? dimension.cdq : {}),
        applicableMax, effectiveMax, earnedScore, normalizedScore,
        evidenceCoverage: applicableMax > 0 ? effectiveMax / applicableMax : null,
      },
    }, ...otherDimensions],
    total,
    potential,
  }
}