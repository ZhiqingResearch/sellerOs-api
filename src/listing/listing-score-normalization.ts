import { CDQ_DIMENSION_METADATA } from "./listing-score-correction"

const isRecord = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const isFiniteScore = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const roundScore = (value: number) => Math.round(value * 10000) / 10000
const isWithin = (value: unknown, max: number): value is number => isFiniteScore(value) && value >= 0 && value <= max
const PENDING_SCORE_NOTICE = "已展示返回的评分内容，缺少依据的项目暂未评分。"
const CRITERION_NAMES = [
  [/^结构化/, /^标题/, /^变体/, /^图片/, /^A\+/, /^五点/],
  [/^核心关键词/, /^S\s*\/\s*A/i, /^B\s*\/\s*C/i, /^后台搜索/, /^关键词真实/],
  [/^通用/, /^品类/, /^中优先级/],
  [/^标题/, /Bullet/i, /^描述/],
]

/** 缺项仅补展示结构，保留已有结论；未知分数用 null，不补零分或满分。 */
export function normalizeListingScoreStructure(report: Record<string, unknown>, market?: string): Record<string, unknown> {
  const dimensions = Array.isArray(report.dimensions) ? report.dimensions.filter(isRecord) : []
  const isAmazon = report.scoreVersion === "cdq-2026-09-16" ||
    (!dimensions.length && market?.startsWith("amazon_"))
  const metadata = isAmazon ? CDQ_DIMENSION_METADATA : dimensions.map(item => ({
    name: String(item.name ?? "评分"), namePattern: /^$/, maxScore: isFiniteScore(item.maxScore) && item.maxScore > 0 ? item.maxScore : 100,
    criteria: Array.isArray(item.criteria) ? item.criteria.filter(isRecord).map(criterion =>
      [String(criterion.name ?? "评分项"), isFiniteScore(criterion.maxScore) && criterion.maxScore > 0 ? criterion.maxScore : 100] as const) : [],
  }))
  let hasPending = false
  const normalizedDimensions = metadata.map((dimensionMetadata, index) => {
    const dimension = isAmazon
      ? dimensions.find(item => dimensionMetadata.namePattern.test(String(item.name))) ?? {}
      : dimensions[index] ?? {}
    const originalCriteria = Array.isArray(dimension.criteria) ? dimension.criteria.filter(isRecord) : []
    const criteria = dimensionMetadata.criteria.map(([name, maxScore], criterionIndex) => {
      const criterion = originalCriteria.length === dimensionMetadata.criteria.length ? originalCriteria[criterionIndex]
        : originalCriteria.find(item => String(item.name).startsWith(name) ||
          (isAmazon && CRITERION_NAMES[index]?.[criterionIndex]?.test(String(item.name))))
      if (!criterion) hasPending = true
      return { ...criterion, name: typeof criterion?.name === "string" ? criterion.name : name, maxScore,
        score: criterion?.score ?? null,
        ...(!criterion ? { description: "该项暂无完整评分依据" } : {}),
        ...(criterion?.description !== undefined && typeof criterion.description !== "string" ? { description: "" } : {}),
        ...(criterion?.source !== undefined && typeof criterion.source !== "string" ? { source: "" } : {}),
        ...(!criterion ? { status: "PENDING" } : {}),
        deductions: Array.isArray(criterion?.deductions) ? criterion.deductions : [],
      }
    })
    return { ...dimension, name: typeof dimension.name === "string" ? dimension.name : dimensionMetadata.name, maxScore: dimensionMetadata.maxScore,
      ...(dimension.weight === undefined ? {} : { weight: dimension.weight }), score: dimension.score ?? null, criteria }
  })
  return { ...report, ...(isAmazon ? { scoreVersion: "cdq-2026-09-16" } : {}), dimensions: normalizedDimensions,
    ...(hasPending ? { recoveryNotice: PENDING_SCORE_NOTICE } : {}),
  }
}

/** 依据已返回的扣分明细计算，数值异常且无依据时暂不评分；绝不以算术错误阻断交付。 */
export function normalizeListingScoreArithmetic(report: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(report.dimensions)) return report
  let hasPending = false
  const dimensions = report.dimensions.filter(isRecord).map((dimension, dimensionIndex) => {
    const criteria = (dimension.criteria as Record<string, any>[]).map((criterion, criterionIndex) => {
      const max = Number(criterion.maxScore)
      const deductions = Array.isArray(criterion.deductions) ? criterion.deductions : []
      const hasValidDeductions = deductions.length > 0 && deductions.every(item =>
        isRecord(item) && isWithin(item.points, max) && typeof item.reason === "string" && item.reason.trim())
      const loss = hasValidDeductions ? deductions.reduce((sum, item) => sum + item.points, 0) : 0
      const hasInvalidDeductions = deductions.some(item => !isRecord(item) || !isWithin(item.points, max) || typeof item.reason !== "string")
      const hasInvalidStatus = dimensionIndex === 0 && criterion.status === "NOT_APPLICABLE" && ![2, 4].includes(criterionIndex)
      const shouldCalculateDescription = report.scoreVersion === "cdq-2026-09-16" && dimensionIndex === 3 && criterionIndex === 2 &&
        hasValidDeductions && loss <= 2 && deductions.every(item => item.ruleId === "alexa.description" && item.points === 1)
      const score = hasInvalidDeductions || hasInvalidStatus ? null : shouldCalculateDescription ? roundScore(max - loss)
        : isWithin(criterion.score, max) ? criterion.score
        : hasValidDeductions && loss <= max ? roundScore(max - loss) : null
      const safeDeductions = deductions.filter(item => isRecord(item) && isWithin(item.points, max) && typeof item.reason === "string")
        .map(item => ({ ...item, ...(item.evidence !== undefined && typeof item.evidence !== "string" ? { evidence: "" } : {}) }))
      const isPending = score === null && (hasInvalidDeductions || hasInvalidStatus || criterion.status === "PENDING" ||
        (criterion.score !== null && !["UNAVAILABLE", "NOT_APPLICABLE"].includes(criterion.status)))
      if (isPending) hasPending = true
      return { ...criterion, score, deductions: safeDeductions, ...(isPending ? { status: "PENDING" }
        : criterion.status === "PENDING" && score !== null ? { status: score === max ? "VERIFIED" : "MISSING" } : {}) }
    })
    const hasDescriptionFormula = report.scoreVersion === "cdq-2026-09-16" && dimensionIndex === 3 &&
      criteria[2]?.deductions.length > 0 && criteria[2].deductions.length <= 2 &&
      criteria[2].deductions.every(item => item.ruleId === "alexa.description" && item.points === 1)
    let score: number | null = null
    if (report.scoreVersion === "cdq-2026-09-16" && dimensionIndex === 0) {
      // CDQ 由专用汇总按可获取项折算；未知项不可冒充未获取项抬高得分。
      score = criteria.some(item => item.status === "PENDING")
        ? null : isWithin(dimension.score, dimension.maxScore) ? dimension.score : null
    } else if (!hasDescriptionFormula && isWithin(dimension.score, dimension.maxScore) &&
      !criteria.some(item => item.status === "PENDING") && criteria.every((item, index) => item.score === dimension.criteria[index].score)) {
      score = dimension.score
    } else if (criteria.length && criteria.every(item => isFiniteScore(item.score))) {
      const sum = roundScore(criteria.reduce((total, item) => total + Number(item.score), 0))
      const explicit = Array.isArray(dimension.deductions) ? dimension.deductions : []
      const ruleId = dimensionIndex === 1 ? "keyword.titleLength" : "alexa.stuffing"
      const limit = dimensionIndex === 1 ? 10 : 5
      const hasExtra = explicit.length > 0 && explicit.every(item => isRecord(item) && item.ruleId === ruleId && isWithin(item.points, limit))
      const extra = hasExtra ? explicit.reduce((total, item) => total + item.points, 0) : 0
      // 兼容旧 Alexa 报告明确保存在维度分中的 3～5 分堆砌扣分。
      const oldSum = (dimension.criteria as Record<string, any>[]).reduce((total, item) => total + Number(item.score), 0)
      const implicit = roundScore(oldSum - Number(dimension.score))
      const penalty = dimensionIndex === 1 && hasExtra && extra <= 10 ? extra
        : /Alexa/i.test(String(dimension.name)) ? (extra >= 3 && extra <= 5 ? extra : !explicit.length && implicit >= 3 && implicit <= 5 ? implicit : 0) : 0
      const computed = roundScore(Math.max(0, sum - penalty))
      score = isWithin(computed, dimension.maxScore) ? computed : null
    }
    return { ...dimension, criteria, score }
  })
  const total = dimensions.length && dimensions.every(item => isFiniteScore(item.score))
    ? roundScore(dimensions.reduce((sum, item) => sum + Number(item.score), 0)) : null
  const normalizedReport = { ...report }
  if (!hasPending && normalizedReport.recoveryNotice === PENDING_SCORE_NOTICE) delete normalizedReport.recoveryNotice
  return { ...normalizedReport, dimensions, total,
    ...(report.scoreVersion === "cdq-2026-09-16" || hasPending ? { validationStatus: "BEST_EFFORT" } : {}),
    ...(hasPending ? { recoveryNotice: PENDING_SCORE_NOTICE } : {}),
    ...(total === null ? { potential: "证据不足 · 暂不出综合分" } : {}),
  }
}
