function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** 列表沿用 A/B 方案最高分；报告明确暂未评分时不能回退到旧的方案分数。 */
export function getListingHistoryScore(data: unknown): number | null | undefined {
  if (!isRecord(data) || !Array.isArray(data.plans)) return undefined
  const scores = data.plans.flatMap(plan => {
    if (!isRecord(plan) || !plan.result) return []
    const score = isRecord(plan.scoreResult) ? plan.scoreResult.total : plan.score
    return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100
      ? [score] : []
  })
  return scores.length ? Math.max(...scores) : null
}
