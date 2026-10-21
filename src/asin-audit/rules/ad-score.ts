/**
 * 广告诊断分提取（v2.0 十板块侧 adDiagnostics → 归档摘要 adScore）：
 * 打分 prompt 按 5 维（权重 24/22/20/18/16）输出独立 100 分的广告诊断，但结构由模型自定——
 * 此处做确定性提取，finalizeScoreResult 附带与归档校验兜底共用；未上传广告（adDiagnostics 恒缺省）→ null。
 * 顶层字段兜底顺序与前端归档预检严格同序：score → total → overallScore（前端按此判断
 * 「后端是否返回有效广告分」，两边不同序会出现前端放行、后端 400 的组合）；
 * 顶层都无分数时按 dimensions 加权（Σscore×weight / Σweight，无权重取平均）。
 */

/** 前端归档预检同序的顶层广告分候选字段 */
const TOP_SCORE_KEYS = ["score", "total", "overallScore"] as const

function clamp100(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function extractAdScore(adDiagnostics: unknown): number | null {
  if (!adDiagnostics || typeof adDiagnostics !== "object" || Array.isArray(adDiagnostics)) {
    return null
  }
  const obj = adDiagnostics as Record<string, unknown>

  for (const key of TOP_SCORE_KEYS) {
    const topScore = finiteNumber(obj[key])
    if (topScore != null) return clamp100(topScore)
  }

  const dimensions = Array.isArray(obj.dimensions) ? obj.dimensions : []
  let weightedSum = 0
  let weightSum = 0
  let plainSum = 0
  let plainCount = 0
  for (const dim of dimensions) {
    if (!dim || typeof dim !== "object" || Array.isArray(dim)) continue
    const d = dim as Record<string, unknown>
    const dimScore = finiteNumber(d.score)
    if (dimScore == null) continue
    const weight = finiteNumber(d.weight)
    if (weight != null && weight > 0) {
      weightedSum += dimScore * weight
      weightSum += weight
    } else {
      plainSum += dimScore
      plainCount++
    }
  }
  if (weightSum > 0) return clamp100(weightedSum / weightSum)
  if (plainCount > 0) return clamp100(plainSum / plainCount)
  return null
}
