import { projectListingCriterionEvidence, type ListingScoreSource } from "./listing-score-evidence"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** 描述项的分数和明细来自同一份判断；没有扣分依据时不保留凭空失分，也不补满分。 */
export function reconcileListingDescriptionScore<T>(report: T, source?: ListingScoreSource): T {
  if (!isRecord(report) || report.scoreVersion !== "cdq-2026-09-16" || !Array.isArray(report.dimensions)) return report
  const dimension = report.dimensions[3]
  if (!isRecord(dimension) || !Array.isArray(dimension.criteria)) return report
  const criterion = dimension.criteria[2]
  if (!isRecord(criterion) || criterion.maxScore !== 3) return report
  let normalized = criterion
  if (source) {
    try {
      normalized = { ...criterion, ...projectListingCriterionEvidence(3, 2, criterion, source) }
    } catch { /* 原文取证不完整时仍展示报告，不追加模型调用。 */ }
  }
  const deductions = Array.isArray(normalized.deductions) ? normalized.deductions.filter(item =>
    isRecord(item) && typeof item.points === "number" && item.points > 0 &&
    typeof item.reason === "string" && item.reason.trim()) : []
  if (typeof normalized.score === "number" && normalized.score < 3 && !deductions.length) {
    normalized = { ...normalized, score: null, status: "PENDING", deductions: [],
      description: "本项未返回可核对的扣分依据，暂未评分。" }
  } else if (deductions.length && typeof normalized.description === "string" &&
    /包含|合规|齐全/.test(normalized.description) && !/缺|未|不足/.test(normalized.description)) {
    normalized = { ...normalized, description: deductions.map(item => item.reason).join("；") }
  }
  if (normalized === criterion) return report
  const criteria = [...dimension.criteria]
  criteria[2] = normalized
  // 保留原维度额外扣分，只同步本项变化；未知项不能算作0分。
  const score = typeof dimension.score === "number" && typeof criterion.score === "number" && typeof normalized.score === "number"
    ? Math.round((dimension.score + normalized.score - criterion.score) * 10000) / 10000 : null
  const dimensions = [...report.dimensions]
  dimensions[3] = { ...dimension, criteria, score }
  return { ...report, dimensions }
}
