import { projectListingAttributeCriterion } from "./listing-attribute-score"
import type { ListingScoreSource } from "./listing-score-evidence"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

function isOptionalAttributeAbsence(deduction: unknown): boolean {
  if (!isRecord(deduction) || typeof deduction.points !== "number" || !Number.isFinite(deduction.points) || deduction.points <= 0) return false
  const text = `${String(deduction.reason ?? "")}；${String(deduction.evidence ?? "")}`
  // 一条明细混有真实错误时，不能猜测各自扣分并整条返还；完整取证表会走上方的精确核算。
  if (/矛盾|填错|错误|错位|不符|不一致|\b(?:wrong|incorrect|conflict|mismatch)\b/i.test(text)) return false
  return /(?:推荐|选填|可选|非必填)(?:属性|字段|项)?[^。；;\n]{0,40}(?:未填|漏填|缺失|缺少|未提供|未补齐)|(?:recommended|optional)[^.;\n]{0,60}(?:missing|not (?:filled|provided)|unfilled)|\bmissing\s+(?:recommended|optional)\b/i.test(text)
}

/** AI逐项取证，程序按既定公式计分；旧格式只撤销明确不允许的推荐属性缺失扣分，不新增交付拦截。 */
export function recalculateListingAttributeScore(report: Record<string, unknown>, source?: ListingScoreSource): Record<string, unknown> {
  if (report.scoreVersion !== "cdq-2026-09-16" || !Array.isArray(report.dimensions)) return report
  const dimension = report.dimensions[0]
  if (!isRecord(dimension) || !/CDQ/i.test(String(dimension.name)) || !Array.isArray(dimension.criteria)) return report
  const criterion = dimension.criteria[0]
  if (!isRecord(criterion) || criterion.maxScore !== 30) return report
  const projection = source?.structuredAttributes?.length
    ? projectListingAttributeCriterion(criterion, { ...source, structuredAttributes: source.structuredAttributes }) : undefined
  let updatedCriterion: Record<string, unknown>
  let suggestions = report.suggestions
  if (projection) {
    updatedCriterion = { ...criterion, ...projection }
  } else {
    if (typeof criterion.score !== "number" || !Number.isFinite(criterion.score) || criterion.score < 0 || criterion.score > 30 ||
      !Array.isArray(criterion.deductions)) return report
    const excluded = criterion.deductions.filter(isOptionalAttributeAbsence) as Array<{ points: number }>
    if (!excluded.length) return report
    const deductions = criterion.deductions.filter(deduction => !isOptionalAttributeAbsence(deduction))
    // 只返还明确错扣的分数，其余失分保持，不能把未知问题一并改成满分。
    const remainingLoss = deductions.reduce((sum, deduction) => sum +
      (isRecord(deduction) && typeof deduction.points === "number" && Number.isFinite(deduction.points) && deduction.points > 0 ? deduction.points : 0), 0)
    const score = Math.max(0, Math.min(30 - remainingLoss,
      Math.round((criterion.score + excluded.reduce((sum, item) => sum + item.points, 0)) * 10000) / 10000))
    const assessment = isRecord(criterion.assessment) ? { ...criterion.assessment } : undefined
    if (assessment) delete assessment.attributePresentation
    updatedCriterion = { ...criterion, score, deductions, status: score === 30 ? "VERIFIED" : "MISSING",
      description: score === 30 ? "未发现可确认的属性填写问题；推荐属性未填仅作优化建议，不扣分。"
        : "推荐属性未填不扣分；其余属性问题仍按已有依据计分。",
      ...(assessment ? { assessment } : {}),
    }
    const suggestion = "推荐属性可按实际商品资料补充，仅作优化建议，不影响本项得分。"
    const updatedSuggestions = Array.isArray(report.suggestions) ? [...report.suggestions] : []
    if (!updatedSuggestions.includes(suggestion)) updatedSuggestions.push(suggestion)
    suggestions = updatedSuggestions
  }
  return { ...report, suggestions, dimensions: [
    { ...dimension, criteria: [updatedCriterion, ...dimension.criteria.slice(1)] },
    ...report.dimensions.slice(1),
  ] }
}
