/** 新属性取证表是可选扩展；无法可靠投影时交回原评分兼容路径，不新增拦截。 */
export interface ListingAttributeSource {
  structuredAttributes: Array<{ name: string; value: string }>
  title: string
  itemHighlights: string | string[]
  bullets: string[]
  description: string
}

export interface ListingAttributePresentation {
  summary: string
  scope: string
  attributeCount: number
  totalWeight: number
  totalLoss: number
  rows: Array<{
    field: string
    currentValue: string
    comparison: string
    suggestion: string
    severity: "severe" | "moderate" | "pending"
    deductionIndex?: number
    weight: number
    deductionRate: number
    errorType: string
  }>
}

export interface ListingAttributeProjection {
  score: number
  status: "VERIFIED" | "MISSING"
  description: string
  deductions: Array<{ ruleId: "attribute.required"; points: number; reason: string; evidence: string }>
  assessment: Record<string, unknown>
}

const ATTRIBUTE_SEVERITIES = {
  NONE: 0, CONTRADICTION: 1, TYPE_MISMATCH: 1, WRONG_FIELD: 1, GRANULARITY: 1,
  PRODUCT_DESCRIPTION: 0.5, UNIT_MISMATCH: 1, MISSING_UNIT: 0.5, MARKETING: 0.5, PENDING: 0,
} as const
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const normalizeText = (value: string): string => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()
const isStatistic = (name: string): boolean => /^(?:asin|bsr|best sellers? rank|customer reviews?|reviews?|review count|ratings?|rating count|评论数|商品评分|客户评价|评分)$/i.test(normalizeText(name))

interface AttributeEvidence {
  field: string
  quote: string
  attribute?: { name: string; value: string }
}

function readComparison(source: ListingAttributeSource, value: unknown): AttributeEvidence | undefined {
  if (!isRecord(value) || typeof value.field !== "string" || typeof value.quote !== "string" || !value.quote.trim()) return undefined
  let text: string | undefined
  let attribute: AttributeEvidence["attribute"]
  if (value.field === "title" || value.field === "description") text = source[value.field]
  else if (value.field === "itemHighlights") text = Array.isArray(source.itemHighlights) ? source.itemHighlights.join(" ") : source.itemHighlights
  else {
    const match = /^(bullets|attributes)\.([1-9]\d*)$/.exec(value.field)
    if (!match) return undefined
    const index = Number(match[2]) - 1
    if (match[1] === "bullets") text = source.bullets[index]
    else {
      attribute = source.structuredAttributes[index]
      if (attribute) text = `${attribute.name}: ${attribute.value}`
    }
  }
  if (typeof text !== "string" || !normalizeText(text).includes(normalizeText(value.quote))) return undefined
  return { field: value.field, quote: value.quote.trim(), ...(attribute ? { attribute } : {}) }
}

const isGenericPrinter = (value: string): boolean => /^(?:(?:inkjet|laser)\s+)?printers?$/i.test(normalizeText(value))
const isColorField = (name: string): boolean => /\bcolou?r\b|颜色|色彩/i.test(name)

function hasColorEvidence(comparison: AttributeEvidence, source: ListingAttributeSource): boolean {
  if (comparison.attribute) return isColorField(comparison.attribute.name)
  const quote = normalizeText(comparison.quote)
  if (/\b(?:black|white|red|green|blue|yellow|cyan|magenta|gray|grey|orange|pink|purple|brown|silver|gold|beige|multicolou?r|multi[- ]colou?r)\b|黑色|白色|红色|绿色|蓝色|黄色|青色|品红|灰色|彩色|多色/.test(quote)) return true
  const words = (value: string) => (normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? []).join(" ")
  return source.structuredAttributes.some(attribute => isColorField(attribute.name) && words(attribute.value) &&
    (" " + words(quote) + " ").includes(" " + words(attribute.value) + " "))
}

function describeComparison(comparison: AttributeEvidence): string {
  if (comparison.attribute) return comparison.attribute.name + "=“" + comparison.attribute.value + "”"
  const bullet = /^bullets\.(\d+)$/.exec(comparison.field)
  const name = bullet ? "第" + bullet[1] + "条Bullet" : comparison.field === "title" ? "标题"
    : comparison.field === "description" ? "产品描述" : comparison.field === "itemHighlights" ? "商品亮点" : comparison.field
  return name + "=“" + comparison.quote + "”"
}

function hasPackagingEvidence(comparisons: AttributeEvidence[], ownField: string): boolean {
  return comparisons.some(comparison => {
    if (comparison.field === ownField) return false
    const name = comparison.attribute?.name ?? ""
    // 件数不是包数证据；必须另有明确包装数量/层级原文。
    if (/^(?:number of items|item count|件数|商品数量)$/i.test(normalizeText(name))) return false
    const quote = normalizeText(comparison.quote)
    if (/\b(?:one|two|three|single|\d+)\s*[- ]?\s*(?:packs?|packages?|sets?|boxes|box|kits?|bundles?)\b/.test(quote) || /(?:一|两|二|三|\d+)\s*(?:套|盒|包|组)/.test(quote)) return true
    return /^(?:package quantity|package count|number of packages|pack count|包装数量|包数)$/i.test(normalizeText(name)) && /\d|one|two|single|一|两|二/i.test(comparison.attribute?.value ?? "")
  })
}

/** 已有取证表完整有效时才按原文的权重×严重度投影，模型自行写的分数和总数均不采用。 */
export function projectListingAttributeCriterion(
  criterion: { assessment?: unknown; score?: unknown },
  source: ListingAttributeSource | undefined,
): ListingAttributeProjection | undefined {
  try {
    if (!source || !Array.isArray(source.structuredAttributes) || !Array.isArray(source.bullets) ||
      !isRecord(criterion.assessment) || !Array.isArray(criterion.assessment.attributeChecks)) return undefined
    const attributes = source.structuredAttributes.map((attribute, offset) => ({ ...attribute, index: offset + 1 }))
      .filter(attribute => typeof attribute.name === "string" && attribute.name.trim() && typeof attribute.value === "string" && !isStatistic(attribute.name))
    if (!attributes.length) return undefined
    const checks = criterion.assessment.attributeChecks
    if (checks.length !== attributes.length) return undefined
    const projectedAssessment = structuredClone(criterion.assessment)
    const projectedChecks = projectedAssessment.attributeChecks as Record<string, unknown>[]
    const byIndex = new Map(attributes.map(attribute => [attribute.index, attribute]))
    const seen = new Set<number>()
    const rows: Array<{ index: number; name: string; value: string; weight: number; severity: number; errorType: keyof typeof ATTRIBUTE_SEVERITIES; suggestion: string; comparisons: AttributeEvidence[] }> = []
    for (const check of checks) {
      if (!isRecord(check)) return undefined
      const index = typeof check.index === "string" && /^[1-9]\d*$/.test(check.index.trim())
        ? Number(check.index.trim()) : check.index
      const weight = typeof check.weight === "string" && /^[123]$/.test(check.weight.trim())
        ? Number(check.weight.trim()) : check.weight
      if (typeof index !== "number" || !Number.isSafeInteger(index) || !byIndex.has(index) || seen.has(index) ||
        typeof weight !== "number" || ![1, 2, 3].includes(weight) ||
        typeof check.errorType !== "string" || !Object.hasOwn(ATTRIBUTE_SEVERITIES, check.errorType) ||
        !Array.isArray(check.comparison) || typeof check.suggestion !== "string") return undefined
      seen.add(index)
      const projectedCheck = projectedChecks.find(item => item.index === check.index)!
      projectedCheck.index = index
      projectedCheck.weight = weight
      const attribute = byIndex.get(index)!
      let errorType = check.errorType as keyof typeof ATTRIBUTE_SEVERITIES
      let severity = ATTRIBUTE_SEVERITIES[errorType]
      let hasUnverifiableEvidence = false
      if (severity > 0 && !check.suggestion.trim()) return undefined
      const comparisons: AttributeEvidence[] = []
      for (const value of check.comparison) {
        const comparison = readComparison(source, value)
        if (!comparison) hasUnverifiableEvidence = true
        else comparisons.push(comparison)
      }
      if (errorType === "CONTRADICTION") {
        const others = comparisons.filter(comparison => comparison.field !== `attributes.${index}`)
        if (!attribute.value.trim() || !others.length) hasUnverifiableEvidence = true
        if (isGenericPrinter(attribute.value) || others.some(comparison => isGenericPrinter(comparison.attribute?.value ?? comparison.quote))) hasUnverifiableEvidence = true
        if (isColorField(attribute.name) && others.some(comparison => !hasColorEvidence(comparison, source))) hasUnverifiableEvidence = true
        if (others.every(comparison => normalizeText(comparison.attribute?.value ?? comparison.quote) === normalizeText(attribute.value))) hasUnverifiableEvidence = true
      }
      if (errorType === "GRANULARITY" && /^(?:number of packs|pack count|包数)$/i.test(normalizeText(attribute.name)) &&
        !hasPackagingEvidence(comparisons, `attributes.${index}`)) hasUnverifiableEvidence = true
      if (hasUnverifiableEvidence) {
        errorType = "PENDING"
        severity = 0
        projectedCheck.errorType = "PENDING"
        projectedCheck.comparison = []
        projectedCheck.suggestion = "建议补充同口径的原文证据后核验"
      }
      rows.push({ ...attribute, weight, severity, errorType, suggestion: hasUnverifiableEvidence ? "建议补充同口径的原文证据后核验" : check.suggestion.trim(), comparisons })
    }
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0)
    const losses = rows.filter(row => row.severity > 0).sort((left, right) =>
      right.weight * right.severity - left.weight * left.severity || left.index - right.index)
    const totalLoss = losses.reduce((sum, row) => sum + row.weight * row.severity, 0)
    // 以万分之一分分配余数，明细合计严格对应一次取整后的总扣分，避免全扣时出现负尾差。
    const totalUnits = Math.round(300000 * totalLoss / totalWeight)
    const allocations = losses.map((row, index) => {
      const quota = 300000 * row.weight * row.severity / totalWeight
      return { index, units: Math.floor(quota), remainder: quota - Math.floor(quota) }
    })
    const remaining = totalUnits - allocations.reduce((sum, allocation) => sum + allocation.units, 0)
    const ranked = [...allocations].sort((left, right) => right.remainder - left.remainder || left.index - right.index)
    for (let index = 0; index < remaining; index++) ranked[index].units++
    const deductions = losses.map((row, index) => ({
      ruleId: "attribute.required" as const,
      points: allocations[index].units / 10000,
      reason: `${row.name}：现在填“${row.value}”${row.comparisons.filter(comparison => comparison.field !== `attributes.${row.index}`).length ? `；对照${row.comparisons.filter(comparison => comparison.field !== `attributes.${row.index}`).map(describeComparison).join("；")}` : ""}。→ ${/^建议/.test(row.suggestion) ? row.suggestion : `建议${row.suggestion}`}`,
      evidence: [`attributes.${row.index} ${row.name}: ${row.value}`, ...row.comparisons.map(comparison => `${comparison.field}: ${comparison.quote}`)].join("；"),
    })).filter(deduction => deduction.points > 0)
    const pendingRows = rows.filter(row => row.errorType === "PENDING")
    const summary = `本次取得${rows.length}项前台可见属性，已核验${rows.length - pendingRows.length}项，${deductions.length ? `${deductions.length}项有问题` : "未发现可确认的问题"}${pendingRows.length ? `；另有${pendingRows.length}项待确认，本次不扣分` : ""}。`
    const presentationRows: ListingAttributePresentation["rows"] = []
    let deductionIndex = 0
    losses.forEach((row, index) => {
      if (allocations[index].units <= 0) return
      presentationRows.push({
        field: row.name, currentValue: row.value,
        comparison: row.comparisons.filter(comparison => comparison.field !== `attributes.${row.index}`).map(describeComparison).join("；"),
        suggestion: /^建议/.test(row.suggestion) ? row.suggestion : `建议${row.suggestion}`,
        severity: row.severity === 1 ? "severe" : "moderate", deductionIndex: deductionIndex++,
        weight: row.weight, deductionRate: row.severity, errorType: row.errorType,
      })
    })
    pendingRows.forEach(row => presentationRows.push({
      field: row.name, currentValue: row.value,
      comparison: row.comparisons.filter(comparison => comparison.field !== `attributes.${row.index}`).map(describeComparison).join("；"),
      suggestion: row.suggestion || "建议补充证据后核验", severity: "pending",
      weight: row.weight, deductionRate: 0, errorType: row.errorType,
    }))
    const attributePresentation: ListingAttributePresentation = {
      summary, scope: "前台可见属性", attributeCount: rows.length, totalWeight, totalLoss, rows: presentationRows,
    }
    projectedAssessment.attributePresentation = attributePresentation
    return {
      score: (300000 - totalUnits) / 10000,
      status: deductions.length ? "MISSING" : "VERIFIED",
      description: summary,
      deductions,
      assessment: projectedAssessment,
    }
  } catch {
    return undefined
  }
}
