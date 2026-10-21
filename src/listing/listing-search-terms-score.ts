const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** 仅修正 Amazon 关键词第 4 项：未获取后台搜索词不能作为扣分依据。 */
export function normalizeUnavailableSearchTerms<T>(value: T): T {
  if (!isRecord(value) || !Array.isArray(value.dimensions) || value.dimensions.length !== 4)
    return value
  const [cdq, keywords] = value.dimensions
  if (!isRecord(cdq) || !/CDQ/i.test(String(cdq.name)) || !isRecord(keywords) ||
    !/关键词/.test(String(keywords.name)) || keywords.maxScore !== 25 ||
    !Array.isArray(keywords.criteria) || keywords.criteria.length !== 5) return value
  const criterion = keywords.criteria[3]
  if (!isRecord(criterion) || criterion.maxScore !== 4 ||
    !/后台搜索词|search\s*terms/i.test(String(criterion.name))) return value
  const evidence = [criterion.description, ...(Array.isArray(criterion.deductions)
    ? criterion.deductions.map(item => isRecord(item) ? item.reason : "") : [])].join(" ")
  const isUnavailable = criterion.status === "UNAVAILABLE" ||
    /未获取|未提供|未抓取|未抓到|无法获取|无法抓取|前台不可见/i.test(evidence)
  if (!isUnavailable || (criterion.score !== null &&
    (typeof criterion.score !== "number" || !Number.isFinite(criterion.score) ||
      criterion.score < 0 || criterion.score > 4)) ||
    typeof keywords.score !== "number" || !Number.isFinite(keywords.score)) return value

  const report = structuredClone(value) as Record<string, unknown>
  const dimension = (report.dimensions as Record<string, unknown>[])[1]
  const item = (dimension.criteria as Record<string, unknown>[])[3]
  // 保持原有 25 分权重及其他扣分，只退回本项因未获取而扣掉的分数。
  const score = Math.min(25, keywords.score + 4 - Number(criterion.score))
  const restoredScore = score - keywords.score
  Object.assign(item, { status: "UNAVAILABLE", description: "SEARCH TERMS未获取", score: 4, deductions: [] })
  dimension.score = score
  if (typeof report.total === "number" && Number.isFinite(report.total) &&
    !(Array.isArray(report.severeDefects) && report.severeDefects.length) &&
    !(/^D\s*级/.test(String(report.potential)) && report.total <= 54)) {
    report.total = Math.min(100, Math.round((report.total + restoredScore) * 10000) / 10000)
    if (restoredScore > 0) {
      const total = Number(report.total)
      report.potential = total >= 90 ? "S级 · 可直接上线"
        : total >= 80 ? "A级 · 小幅调整后上线"
        : total >= 68 ? "B级 · 优化后上线"
        : total >= 55 ? "C级 · 建议重新生成" : "D级 · 必须重新生成"
    }
  }
  return report as T
}
