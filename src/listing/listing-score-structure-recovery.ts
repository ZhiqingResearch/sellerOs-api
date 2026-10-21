import { CDQ_SCORE_VERSION, isCdqScoreReport } from "./listing-cdq-score"
import { parseListingJsonObject } from "./listing-result-parser"
import {
  buildScoreCorrectionPlan,
  CDQ_DIMENSION_METADATA,
  type ScoreCorrectionPlan,
  type ScoreCorrectionReport,
} from "./listing-score-correction"
import type { ListingRuleContext } from "./listing-score-rules"
import { extractScoreRecoveryCore } from "./listing-score-recovery"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** 结构不完整时只建立待取证清单；占位数据必须全部被真实校对替换才可返回。 */
export function buildCdqStructureRecoveryPlan(
  text: string,
  market?: string,
  context?: ListingRuleContext,
  shouldReassessAll = false
): ScoreCorrectionPlan | null {
  let original: Record<string, unknown>
  try { original = parseListingJsonObject(text) }
  catch {
    // 尾部截断但评分核心完整时，沿用只补尾部的路径，不能把已有评分全部重算。
    try { extractScoreRecoveryCore(text, market); return null } catch { /* 核心同样需要恢复。 */ }
    // 已声明新版契约但正文截断：由原始商品资料重新取证，不能补造被截断的分数。
    if (!/"scoreVersion"\s*:\s*"cdq-2026-09-16"/.test(text)) return null
    original = { scoreVersion: CDQ_SCORE_VERSION }
  }
  if (!isCdqScoreReport(original)) return null
  const dimensions = Array.isArray(original.dimensions) ? original.dimensions : []
  const hasSwappedKnownDimension = dimensions.some((dimension, index) => isRecord(dimension) &&
    typeof dimension.name === "string" && CDQ_DIMENSION_METADATA.some((metadata, expectedIndex) =>
      expectedIndex !== index && metadata.namePattern.test(dimension.name as string)))
  const hasCompleteStructure = dimensions.length === CDQ_DIMENSION_METADATA.length &&
    dimensions.every((dimension, index) => isRecord(dimension) &&
      Array.isArray(dimension.criteria) && dimension.criteria.length === CDQ_DIMENSION_METADATA[index].criteria.length) &&
    !hasSwappedKnownDimension
  if (hasCompleteStructure && !shouldReassessAll) return null

  const affectedDimensions: number[] = []
  const recovered = CDQ_DIMENSION_METADATA.map((metadata, dimensionIndex) => {
    // 缺维时不能再按数组下标错认评分维度，只有名称唯一对应的完整维度可以保留。
    const matches = dimensions.filter(dimension => isRecord(dimension) &&
      typeof dimension.name === "string" && metadata.namePattern.test(dimension.name))
    const candidate = matches.length === 1 ? matches[0] as Record<string, unknown> : undefined
    if (!shouldReassessAll && candidate && Array.isArray(candidate.criteria) &&
      candidate.criteria.length === metadata.criteria.length)
      return structuredClone(candidate)
    affectedDimensions.push(dimensionIndex)
    return {
      name: metadata.name, weight: metadata.maxScore, maxScore: metadata.maxScore, score: 0,
      criteria: metadata.criteria.map(([name, maxScore]) => ({
        name, maxScore, score: Number.NaN, description: "原始评分结构缺失，须根据商品原文重新核验", deductions: [],
      })),
      deductions: [],
    }
  })
  const report = { ...original, total: 0, dimensions: recovered }
  const plan = buildScoreCorrectionPlan(JSON.stringify(report), market, true, context)
  if (!plan) return { report: report as unknown as ScoreCorrectionReport, criteria: [], shouldCorrectSuggestions: false }
  // 缺失维度没有可信旧汇总，额外扣分同样重新取证，不能由占位0推导惩罚。
  const dimensionIndices = new Set(plan.dimensionIndices ?? [])
  affectedDimensions.filter(index => index > 0).forEach(index => dimensionIndices.add(index))
  return { ...plan, ...(dimensionIndices.size ? { dimensionIndices: [...dimensionIndices].sort() } : {}) }
}
