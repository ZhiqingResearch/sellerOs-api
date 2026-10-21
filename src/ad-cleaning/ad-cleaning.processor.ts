import { basename, extname } from "path"
import * as XLSX from "xlsx"
import {
  AD_CLEANING_MAX_CELL_LENGTH,
  AD_CLEANING_MAX_COLUMNS,
  AD_CLEANING_RULE_VERSION,
} from "./ad-cleaning.constants"
import type {
  AdCleaningPreviewCell,
  AdCleaningSheetPreview,
  AdCleaningStats,
} from "./ad-cleaning.types"

type InputField =
  | "currency"
  | "campaign"
  | "adGroup"
  | "targeting"
  | "matchType"
  | "searchTerm"
  | "imp"
  | "clk"
  | "spend"
  | "sales"
  | "orders"

type VerdictClass = "good" | "bad" | "warn" | "watch" | "neutral"

interface Aggregate {
  imp: number
  clk: number
  spendCents: number
  salesCents: number
  orders: number
}

interface ParsedRow extends Aggregate {
  campaign: string
  adGroup: string
  targeting: string
  matchType: string
  searchTerm: string
  sourceRow: number
  zeroImpressionClick: boolean
}

interface DimensionAggregate extends Aggregate {
  campaign?: string
  adGroup?: string
  targeting?: string
  matchType?: string
  searchTerm?: string
  zeroImpressionClick?: boolean
}

interface Metrics {
  ctr: number | null
  cpc: number | null
  cvr: number | null
  acos: number | null
  cpa: number | null
  roas: number | null
}

interface Verdict {
  cls: VerdictClass
  label: string
  suggestion: string
}

interface HeaderCandidate {
  sheetName: string
  sheet: XLSX.WorkSheet
  headerRow: number
  mapping: Record<InputField, number>
}

interface ParseResult {
  rows: ParsedRow[]
  sourceSheet: string
  sourceRows: number
  skippedRows: number
  currency: string
  cleanedInvisibleChars: number
  trimmedWrappingQuotes: number
  zeroImpressionClickRows: number
}

type StyledCell = Omit<XLSX.CellObject, "s"> & {
  s?: Record<string, unknown>
}

export interface AdCleaningProcessResult {
  stats: AdCleaningStats
  sheetPreviews: AdCleaningSheetPreview[]
}

const FIELD_ALIASES: Record<InputField, string[]> = {
  currency: ["币种", "货币", "Currency"],
  campaign: ["广告活动名称", "广告活动", "Campaign Name"],
  adGroup: ["广告组名称", "广告组", "Ad Group Name"],
  targeting: ["投放", "定位", "Targeting"],
  matchType: ["匹配类型", "Match Type"],
  searchTerm: ["客户搜索词", "Customer Search Term"],
  imp: ["展示量", "Impressions"],
  clk: ["点击量", "Clicks"],
  spend: ["花费", "Spend"],
  sales: ["7天总销售额", "销售额", "7 Day Total Sales"],
  orders: ["7天总订单数", "订单数", "7 Day Total Orders", "7 Day Total Orders (#)"],
}

const FIELD_LABELS: Record<InputField, string> = {
  currency: "币种",
  campaign: "广告活动",
  adGroup: "广告组",
  targeting: "投放",
  matchType: "匹配类型",
  searchTerm: "客户搜索词",
  imp: "展示量",
  clk: "点击量",
  spend: "花费",
  sales: "7天销售额",
  orders: "7天订单数",
}

const RAW_AND_METRIC_HEADERS = [
  "展示量",
  "点击量",
  "花费",
  "7天销售额",
  "7天订单数",
  "CTR",
  "CPC",
  "CVR",
  "ACOS",
  "CPA",
  "ROAS",
] as const

const VERDICT_LABELS: Record<VerdictClass, string> = {
  good: "可收割",
  bad: "高风险",
  warn: "待优化",
  watch: "继续观察",
  neutral: "表现中性",
}

const VERDICT_STYLES: Record<VerdictClass, { fill: string; color: string }> = {
  good: { fill: "#E2F3E7", color: "#1F9C4A" },
  bad: { fill: "#FDE8E7", color: "#FF3B30" },
  warn: { fill: "#FFF3D6", color: "#CC7A00" },
  watch: { fill: "#ECEFF1", color: "#607D8B" },
  neutral: { fill: "#ECEFF1", color: "#607D8B" },
}

const blankAggregate = (): Aggregate => ({
  imp: 0,
  clk: 0,
  spendCents: 0,
  salesCents: 0,
  orders: 0,
})

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`
  }
  if (value instanceof Date) return value.toISOString()
  return "[不支持的数据类型]"
}

const normalizeHeader = (value: unknown): string =>
  cellText(value)
    .normalize("NFKC")
    .replace(/^\uFEFF/, "")
    .replace(/[\s()（）#]/g, "")
    .toLowerCase()

const compositeKey = (...parts: string[]): string => JSON.stringify(parts)

const addAggregate = (target: Aggregate, source: Aggregate): void => {
  target.imp += source.imp
  target.clk += source.clk
  target.spendCents += source.spendCents
  target.salesCents += source.salesCents
  target.orders += source.orders

  if (
    !Number.isSafeInteger(target.imp) ||
    !Number.isSafeInteger(target.clk) ||
    !Number.isSafeInteger(target.spendCents) ||
    !Number.isSafeInteger(target.salesCents) ||
    !Number.isSafeInteger(target.orders)
  ) {
    throw new Error("汇总数值超过安全范围，请拆分文件后重试")
  }
}

const metricsOf = (aggregate: Aggregate): Metrics => {
  const spend = aggregate.spendCents / 100
  const sales = aggregate.salesCents / 100
  return {
    ctr: aggregate.imp > 0 ? aggregate.clk / aggregate.imp : null,
    cpc: aggregate.clk > 0 ? spend / aggregate.clk : null,
    cvr: aggregate.clk > 0 ? aggregate.orders / aggregate.clk : null,
    acos: aggregate.salesCents > 0 ? spend / sales : null,
    cpa: aggregate.orders > 0 ? spend / aggregate.orders : null,
    roas: aggregate.spendCents > 0 ? sales / spend : null,
  }
}

const formatPercent = (value: number | null): string =>
  value === null ? "—" : `${(value * 100).toFixed(2)}%`

export class AdCleaningProcessor {
  /**
   * 从文件服务器实时读取到的结果 Excel 中还原统计和 Sheet 预览。
   * 该方法不使用进程缓存，每次调用都以文件内容为准。
   */
  static inspectResultBuffer(buffer: Buffer): AdCleaningProcessResult {
    const workbook = XLSX.read(buffer, {
      type: "buffer",
      cellDates: false,
      cellFormula: true,
      cellNF: true,
      cellStyles: false,
      raw: true,
    })
    const allSheetPreviews = this.buildSheetPreviews(workbook)
    const stats = this.statsFromSheetPreviews(allSheetPreviews)
    // 完整 Excel 保留 7 个 Sheet；接口不展示首个“清洗摘要”和末个“待否定词”。
    const sheetPreviews = allSheetPreviews.slice(1, -1)
    return { stats, sheetPreviews }
  }

  static process(
    inputPath: string,
    outputPath: string,
    originalFilename: string,
    onProgress: (progress: number, stage: string) => void = () => undefined
  ): AdCleaningProcessResult {
    onProgress(5, "正在读取 Excel")
    const workbook = XLSX.readFile(inputPath, {
      cellDates: false,
      cellFormula: true,
      cellNF: true,
      cellStyles: false,
      raw: true,
    })

    onProgress(15, "正在识别表头")
    const candidate = this.findSourceSheet(workbook)
    const parsed = this.parseRows(candidate)

    onProgress(35, "正在聚合广告数据")
    const aggregation = this.aggregate(parsed.rows)

    onProgress(60, "正在计算指标和审计结论")
    const report = this.buildReport(parsed, aggregation)

    onProgress(80, "正在生成清洗结果 Excel")
    const sheetPreviews = this.writeWorkbook(
      outputPath,
      originalFilename,
      parsed,
      aggregation,
      report
    )
    onProgress(100, "清洗完成")

    return { stats: report.stats, sheetPreviews }
  }

  private static findSourceSheet(workbook: XLSX.WorkBook): HeaderCandidate {
    const candidates: HeaderCandidate[] = []
    const duplicateHeaderErrors: string[] = []
    let bestSheetName = workbook.SheetNames[0] ?? ""
    let bestMatchedFields: InputField[] = []

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet || !sheet["!ref"]) continue
      const range = XLSX.utils.decode_range(sheet["!ref"])
      const previewEndRow = Math.min(range.e.r, 19)
      const previewEndCol = Math.min(range.e.c, AD_CLEANING_MAX_COLUMNS - 1)
      const preview = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: true,
        defval: null,
        blankrows: true,
        range: { s: { r: 0, c: 0 }, e: { r: previewEndRow, c: previewEndCol } },
      })

      for (let rowIndex = 0; rowIndex < preview.length; rowIndex++) {
        const mappingResult = this.mapHeaders(preview[rowIndex] ?? [])
        const matchedFields = Object.entries(mappingResult.mapping)
          .filter(([, index]) => index >= 0)
          .map(([field]) => field as InputField)

        if (matchedFields.length > bestMatchedFields.length) {
          bestMatchedFields = matchedFields
          bestSheetName = sheetName
        }
        if (mappingResult.duplicates.length > 0) {
          if (matchedFields.length === Object.keys(FIELD_ALIASES).length) {
            duplicateHeaderErrors.push(
              `Sheet「${sheetName}」第 ${rowIndex + 1} 行存在重复字段：${mappingResult.duplicates
                .map(field => FIELD_LABELS[field])
                .join("、")}`
            )
          }
          continue
        }
        if (matchedFields.length === Object.keys(FIELD_ALIASES).length) {
          candidates.push({
            sheetName,
            sheet,
            headerRow: rowIndex,
            mapping: mappingResult.mapping,
          })
        }
      }
    }

    if (candidates.length === 0) {
      if (duplicateHeaderErrors.length > 0) throw new Error(duplicateHeaderErrors.join("；"))
      const missing = (Object.keys(FIELD_ALIASES) as InputField[]).filter(
        field => !bestMatchedFields.includes(field)
      )
      throw new Error(
        `未找到完整广告搜索词数据表。最接近的 Sheet「${bestSheetName || "未知"}」缺少字段：${missing
          .map(field => FIELD_LABELS[field])
          .join("、")}`
      )
    }
    if (candidates.length > 1) {
      const names = [...new Set(candidates.map(item => item.sheetName))]
      throw new Error(`发现多个符合条件的数据表，请只保留一个：${names.join("、")}`)
    }
    return candidates[0]
  }

  private static mapHeaders(headers: unknown[]): {
    mapping: Record<InputField, number>
    duplicates: InputField[]
  } {
    const normalizedHeaders = headers.map(normalizeHeader)
    const mapping = {} as Record<InputField, number>
    const duplicates: InputField[] = []

    for (const field of Object.keys(FIELD_ALIASES) as InputField[]) {
      const aliasSet = new Set(FIELD_ALIASES[field].map(normalizeHeader))
      const indexes = normalizedHeaders
        .map((header, index) => (aliasSet.has(header) ? index : -1))
        .filter(index => index >= 0)
      mapping[field] = indexes[0] ?? -1
      if (indexes.length > 1) duplicates.push(field)
    }
    return { mapping, duplicates }
  }

  private static parseRows(candidate: HeaderCandidate): ParseResult {
    const range = XLSX.utils.decode_range(candidate.sheet["!ref"] as string)
    const columnCount = range.e.c - range.s.c + 1
    if (columnCount > AD_CLEANING_MAX_COLUMNS) {
      throw new Error(`表格列数不能超过 ${AD_CLEANING_MAX_COLUMNS} 列，当前为 ${columnCount} 列`)
    }

    // WPS 等工具会把整列套格式，使 dimension 声明到百万行但尾部全是空行；
    // 按实际有内容的最后一行收口，避免物化整个声明范围。
    const lastContentRow = this.lastContentRow(candidate.sheet)
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(candidate.sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
      range: {
        s: { r: candidate.headerRow, c: 0 },
        e: { r: Math.min(range.e.r, lastContentRow), c: range.e.c },
      },
    })
    const dataRows = matrix.slice(1)

    const parsedRows: ParsedRow[] = []
    const currencies = new Set<string>()
    let skippedRows = 0
    let cleanedInvisibleChars = 0
    let trimmedWrappingQuotes = 0
    let zeroImpressionClickRows = 0

    for (let index = 0; index < dataRows.length; index++) {
      const raw = dataRows[index] ?? []
      const sourceRow = candidate.headerRow + index + 2
      this.assertNoRequiredFormula(candidate, sourceRow)

      const imp = this.parseInteger(
        raw[candidate.mapping.imp],
        "展示量",
        candidate.sheetName,
        sourceRow
      )
      const clk = this.parseInteger(
        raw[candidate.mapping.clk],
        "点击量",
        candidate.sheetName,
        sourceRow
      )
      const orders = this.parseInteger(
        raw[candidate.mapping.orders],
        "7天订单数",
        candidate.sheetName,
        sourceRow
      )
      const spendCents = this.parseMoneyCents(
        raw[candidate.mapping.spend],
        "花费",
        candidate.sheetName,
        sourceRow
      )
      const salesCents = this.parseMoneyCents(
        raw[candidate.mapping.sales],
        "7天销售额",
        candidate.sheetName,
        sourceRow
      )

      const rawDimensions = {
        currency: this.readText(raw[candidate.mapping.currency]),
        campaign: this.readText(raw[candidate.mapping.campaign]),
        adGroup: this.readText(raw[candidate.mapping.adGroup]),
        targeting: this.readText(raw[candidate.mapping.targeting]),
        matchType: this.readText(raw[candidate.mapping.matchType]),
        searchTerm: this.readText(raw[candidate.mapping.searchTerm]),
      }
      const metricsAllZero =
        imp === 0 && clk === 0 && orders === 0 && spendCents === 0 && salesCents === 0
      const dimensionsAllBlank = Object.values(rawDimensions).every(value => value === "")
      if (metricsAllZero && dimensionsAllBlank) {
        skippedRows += 1
        continue
      }

      for (const [field, value] of Object.entries(rawDimensions)) {
        if (field === "matchType") continue
        const label = FIELD_LABELS[field as keyof typeof rawDimensions]
        if (!value) {
          throw new Error(`Sheet「${candidate.sheetName}」第 ${sourceRow} 行的${label}不能为空`)
        }
        if (value.length > AD_CLEANING_MAX_CELL_LENGTH) {
          throw new Error(
            `Sheet「${candidate.sheetName}」第 ${sourceRow} 行的${label}超过单元格最大长度`
          )
        }
      }

      const currency = rawDimensions.currency.normalize("NFKC").toUpperCase()
      currencies.add(currency)
      if (currencies.size > 1) {
        throw new Error(`检测到多币种数据：${[...currencies].join("、")}，第一版仅支持单币种文件`)
      }

      const searchTermResult = this.cleanSearchTerm(rawDimensions.searchTerm)
      cleanedInvisibleChars += searchTermResult.removedInvisibleChars
      if (searchTermResult.trimmedWrappingQuote) trimmedWrappingQuotes += 1
      if (!searchTermResult.value) {
        throw new Error(`Sheet「${candidate.sheetName}」第 ${sourceRow} 行的客户搜索词清洗后为空`)
      }

      const zeroImpressionClick = imp === 0 && clk > 0
      if (zeroImpressionClick) zeroImpressionClickRows += 1
      parsedRows.push({
        campaign: rawDimensions.campaign,
        adGroup: rawDimensions.adGroup,
        targeting: rawDimensions.targeting,
        matchType: this.normalizeMatchType(rawDimensions.matchType, candidate.sheetName, sourceRow),
        searchTerm: searchTermResult.value,
        imp,
        clk,
        spendCents,
        salesCents,
        orders,
        sourceRow,
        zeroImpressionClick,
      })
    }

    if (parsedRows.length === 0) throw new Error("表格中没有可清洗的有效数据")
    return {
      rows: parsedRows,
      sourceSheet: candidate.sheetName,
      sourceRows: dataRows.length,
      skippedRows,
      currency: [...currencies][0],
      cleanedInvisibleChars,
      trimmedWrappingQuotes,
      zeroImpressionClickRows,
    }
  }

  /** 取工作表中实际有值（或公式）单元格的最大行号，0-based；无内容时返回 -1。 */
  private static lastContentRow(sheet: XLSX.WorkSheet): number {
    let last = -1
    for (const key of Object.keys(sheet)) {
      if (key.startsWith("!")) continue
      const cell = sheet[key] as XLSX.CellObject | undefined
      if (!cell || (cell.v === undefined && cell.f === undefined)) continue
      const row = XLSX.utils.decode_cell(key).r
      if (row > last) last = row
    }
    return last
  }

  private static assertNoRequiredFormula(candidate: HeaderCandidate, sourceRow: number): void {
    for (const [field, column] of Object.entries(candidate.mapping)) {
      const address = XLSX.utils.encode_cell({ r: sourceRow - 1, c: column })
      const cell = this.cellAt(candidate.sheet, address)
      if (cell?.f) {
        throw new Error(
          `Sheet「${candidate.sheetName}」第 ${sourceRow} 行的${FIELD_LABELS[field as InputField]}不允许使用公式`
        )
      }
    }
  }

  private static readText(value: unknown): string {
    return cellText(value).trim()
  }

  private static parseInteger(
    value: unknown,
    field: string,
    sheetName: string,
    sourceRow: number
  ): number {
    const original = cellText(value)
    if (original.trim() === "") return 0
    const cleaned = original.normalize("NFKC").replace(/[,$€£￥¥\s]/g, "")
    const parsed = Number(cleaned)
    if (!Number.isFinite(parsed)) {
      throw new Error(`Sheet「${sheetName}」第 ${sourceRow} 行的${field}不是有效数字：${original}`)
    }
    if (!Number.isInteger(parsed)) {
      throw new Error(`Sheet「${sheetName}」第 ${sourceRow} 行的${field}必须是整数：${original}`)
    }
    if (parsed < 0) {
      throw new Error(`Sheet「${sheetName}」第 ${sourceRow} 行的${field}不能为负数`)
    }
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`Sheet「${sheetName}」第 ${sourceRow} 行的${field}超过安全范围`)
    }
    return parsed
  }

  private static parseMoneyCents(
    value: unknown,
    field: string,
    sheetName: string,
    sourceRow: number
  ): number {
    const original = cellText(value)
    if (original.trim() === "") return 0
    const cleaned = original.normalize("NFKC").replace(/[,$€£￥¥\s]/g, "")
    const parsed = Number(cleaned)
    if (!Number.isFinite(parsed)) {
      throw new Error(`Sheet「${sheetName}」第 ${sourceRow} 行的${field}不是有效金额：${original}`)
    }
    if (parsed < 0) {
      throw new Error(`Sheet「${sheetName}」第 ${sourceRow} 行的${field}不能为负数`)
    }
    const cents = Math.round((parsed + Number.EPSILON) * 100)
    if (!Number.isSafeInteger(cents)) {
      throw new Error(`Sheet「${sheetName}」第 ${sourceRow} 行的${field}超过安全范围`)
    }
    return cents
  }

  private static cleanSearchTerm(value: string): {
    value: string
    removedInvisibleChars: number
    trimmedWrappingQuote: boolean
  } {
    const matches = value.match(/\uFFFC/g)
    let cleaned = value.replace(/\uFFFC/g, "").trim()
    let trimmedWrappingQuote = false
    if (
      cleaned.length >= 2 &&
      ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'")))
    ) {
      cleaned = cleaned.slice(1, -1).trim()
      trimmedWrappingQuote = true
    }
    return {
      value: cleaned,
      removedInvisibleChars: matches?.length ?? 0,
      trimmedWrappingQuote,
    }
  }

  private static normalizeMatchType(value: string, sheetName: string, sourceRow: number): string {
    const normalized = value.normalize("NFKC").trim().toLowerCase()
    const mapping: Record<string, string> = {
      "": "auto",
      "-": "auto",
      auto: "auto",
      automatic: "auto",
      自动: "auto",
      broad: "broad",
      广泛: "broad",
      phrase: "phrase",
      词组: "phrase",
      exact: "exact",
      精准: "exact",
    }
    const result = mapping[normalized]
    if (!result) {
      throw new Error(`Sheet「${sheetName}」第 ${sourceRow} 行存在未知匹配类型：${value}`)
    }
    return result
  }

  private static aggregate(rows: ParsedRow[]) {
    const grand = blankAggregate()
    const campaigns = new Map<string, DimensionAggregate>()
    const adGroups = new Map<string, DimensionAggregate>()
    const targetings = new Map<string, DimensionAggregate>()
    const matchTypes = new Map<string, DimensionAggregate>()
    const searchTerms = new Map<string, DimensionAggregate>()

    for (const row of rows) {
      addAggregate(grand, row)
      this.addToMap(campaigns, compositeKey(row.campaign), { campaign: row.campaign }, row)
      this.addToMap(
        adGroups,
        compositeKey(row.campaign, row.adGroup),
        { campaign: row.campaign, adGroup: row.adGroup },
        row
      )
      this.addToMap(
        targetings,
        compositeKey(row.campaign, row.adGroup, row.targeting),
        { campaign: row.campaign, adGroup: row.adGroup, targeting: row.targeting },
        row
      )
      this.addToMap(matchTypes, compositeKey(row.matchType), { matchType: row.matchType }, row)
      this.addToMap(
        searchTerms,
        compositeKey(row.campaign, row.adGroup, row.targeting, row.matchType, row.searchTerm),
        {
          campaign: row.campaign,
          adGroup: row.adGroup,
          targeting: row.targeting,
          matchType: row.matchType,
          searchTerm: row.searchTerm,
          zeroImpressionClick: row.zeroImpressionClick,
        },
        row
      )
    }
    return { grand, campaigns, adGroups, targetings, matchTypes, searchTerms }
  }

  private static addToMap(
    map: Map<string, DimensionAggregate>,
    key: string,
    dimensions: Omit<DimensionAggregate, keyof Aggregate>,
    row: ParsedRow
  ): void {
    const aggregate = map.get(key) ?? { ...blankAggregate(), ...dimensions }
    addAggregate(aggregate, row)
    aggregate.zeroImpressionClick = Boolean(
      aggregate.zeroImpressionClick || row.zeroImpressionClick
    )
    map.set(key, aggregate)
  }

  private static buildReport(
    parsed: ParseResult,
    aggregation: ReturnType<typeof AdCleaningProcessor.aggregate>
  ) {
    const siteMetrics = metricsOf(aggregation.grand)
    const verdictCounts: Record<VerdictClass, number> = {
      good: 0,
      bad: 0,
      warn: 0,
      watch: 0,
      neutral: 0,
    }

    const auditRows = [...aggregation.searchTerms.values()].map(term => {
      const campaign = aggregation.campaigns.get(compositeKey(term.campaign as string))
      const adGroup = aggregation.adGroups.get(
        compositeKey(term.campaign as string, term.adGroup as string)
      )
      const matchType = aggregation.matchTypes.get(compositeKey(term.matchType as string))
      if (!campaign || !adGroup || !matchType) throw new Error("内部聚合关系不完整")

      const termMetrics = metricsOf(term)
      const campaignMetrics = metricsOf(campaign)
      const adGroupMetrics = metricsOf(adGroup)
      const matchTypeMetrics = metricsOf(matchType)
      const verdict = this.auditVerdict(term, adGroupMetrics.ctr, siteMetrics.acos)
      verdictCounts[verdict.cls] += 1
      return {
        term,
        metrics: termMetrics,
        verdict,
        values: [
          term.campaign,
          term.adGroup,
          term.targeting,
          term.matchType,
          term.searchTerm,
          ...this.aggregateValues(term),
          ...this.metricValues(termMetrics),
          campaignMetrics.ctr,
          adGroupMetrics.ctr,
          matchTypeMetrics.ctr,
          siteMetrics.ctr,
          siteMetrics.cvr,
          siteMetrics.acos,
          verdict.label,
          verdict.suggestion,
        ] as unknown[],
      }
    })
    auditRows.sort((a, b) => this.compareAggregates(a.term, b.term))

    const negativeRows = auditRows.filter(row => row.verdict.cls === "bad" && row.term.orders === 0)
    const negativeCandidateSpendCents = negativeRows.reduce(
      (sum, row) => sum + row.term.spendCents,
      0
    )

    const stats: AdCleaningStats = {
      sourceSheet: parsed.sourceSheet,
      currency: parsed.currency,
      sourceRows: parsed.sourceRows,
      effectiveRows: parsed.rows.length,
      aggregatedSearchTerms: aggregation.searchTerms.size,
      mergedRows: parsed.rows.length - aggregation.searchTerms.size,
      skippedRows: parsed.skippedRows,
      cleanedInvisibleChars: parsed.cleanedInvisibleChars,
      trimmedWrappingQuotes: parsed.trimmedWrappingQuotes,
      zeroImpressionClickRows: parsed.zeroImpressionClickRows,
      verdictCounts,
      negativeCandidateCount: negativeRows.length,
      negativeCandidateSpend: negativeCandidateSpendCents / 100,
    }
    return { siteMetrics, auditRows, negativeRows, stats }
  }

  private static auditVerdict(
    aggregate: DimensionAggregate,
    adGroupCtr: number | null,
    siteAcos: number | null
  ): Verdict {
    const metrics = metricsOf(aggregate)
    const ctrForJudgement = metrics.ctr ?? 0
    const lowCtr = adGroupCtr !== null && adGroupCtr > 0 && ctrForJudgement < adGroupCtr * 0.5
    const anomaly = aggregate.zeroImpressionClick ? "；源数据异常：曝光为0但点击大于0" : ""

    if (aggregate.orders > 0) {
      if (metrics.acos !== null && siteAcos !== null && metrics.acos > siteAcos * 1.5) {
        return {
          cls: "bad",
          label: VERDICT_LABELS.bad,
          suggestion: `高 ACOS（${formatPercent(metrics.acos)} > 全站均值 ${formatPercent(siteAcos)} × 1.5），建议降价控成本${anomaly}`,
        }
      }
      if (metrics.acos !== null && siteAcos !== null && metrics.acos <= siteAcos) {
        return {
          cls: "good",
          label: VERDICT_LABELS.good,
          suggestion: `转化良好且 ACOS ${formatPercent(metrics.acos)} ≤ 全站均值 ${formatPercent(siteAcos)}，建议提价、加预算或转精准词${anomaly}`,
        }
      }
      if (lowCtr) {
        return {
          cls: "warn",
          label: VERDICT_LABELS.warn,
          suggestion: `点击率 ${formatPercent(metrics.ctr)} 显著低于广告组均值 ${formatPercent(adGroupCtr)}，建议优化主图、价格或关键词相关性${anomaly}`,
        }
      }
      return {
        cls: "neutral",
        label: VERDICT_LABELS.neutral,
        suggestion: `已有转化，当前表现处于观察区间，建议维持观察${anomaly}`,
      }
    }

    if (aggregate.clk >= 10) {
      return {
        cls: "bad",
        label: VERDICT_LABELS.bad,
        suggestion: `高点击零转化（点击 ${aggregate.clk} / 订单 0），疑似无效词，建议否定精准或大幅降价${anomaly}`,
      }
    }
    if (lowCtr) {
      return {
        cls: "warn",
        label: VERDICT_LABELS.warn,
        suggestion: `点击率 ${formatPercent(metrics.ctr)} 显著低于广告组均值 ${formatPercent(adGroupCtr)}，建议优化主图、价格或关键词相关性${anomaly}`,
      }
    }
    if (aggregate.clk <= 2) {
      return {
        cls: "watch",
        label: VERDICT_LABELS.watch,
        suggestion: `数据不足（点击 ${aggregate.clk} / 订单 0），继续观察，不下结论${anomaly}`,
      }
    }
    if (aggregate.clk >= 5) {
      return {
        cls: "warn",
        label: VERDICT_LABELS.warn,
        suggestion: `尚未转化且接近否定阈值（点击 ${aggregate.clk} / 订单 0），建议观察或准备临界否定${anomaly}`,
      }
    }
    return {
      cls: "neutral",
      label: VERDICT_LABELS.neutral,
      suggestion: `暂未转化（点击 ${aggregate.clk} / 订单 0），建议维持观察${anomaly}`,
    }
  }

  private static aggregateValues(aggregate: Aggregate): unknown[] {
    return [
      aggregate.imp,
      aggregate.clk,
      aggregate.spendCents / 100,
      aggregate.salesCents / 100,
      aggregate.orders,
    ]
  }

  private static metricValues(metrics: Metrics): unknown[] {
    return [metrics.ctr, metrics.cpc, metrics.cvr, metrics.acos, metrics.cpa, metrics.roas]
  }

  private static compareAggregates(a: DimensionAggregate, b: DimensionAggregate): number {
    if (b.spendCents !== a.spendCents) return b.spendCents - a.spendCents
    const aKey = [a.campaign, a.adGroup, a.targeting, a.matchType, a.searchTerm]
      .filter(Boolean)
      .join("|")
    const bKey = [b.campaign, b.adGroup, b.targeting, b.matchType, b.searchTerm]
      .filter(Boolean)
      .join("|")
    return aKey.localeCompare(bKey, "zh-CN")
  }

  private static dimensionRows(
    values: Iterable<DimensionAggregate>,
    dimensions: Array<keyof DimensionAggregate>
  ): unknown[][] {
    return [...values]
      .sort((a, b) => this.compareAggregates(a, b))
      .map(aggregate => [
        ...dimensions.map(dimension => aggregate[dimension] ?? ""),
        ...this.aggregateValues(aggregate),
        ...this.metricValues(metricsOf(aggregate)),
      ])
  }

  private static writeWorkbook(
    outputPath: string,
    originalFilename: string,
    parsed: ParseResult,
    aggregation: ReturnType<typeof AdCleaningProcessor.aggregate>,
    report: ReturnType<typeof AdCleaningProcessor.buildReport>
  ): AdCleaningSheetPreview[] {
    const workbook = XLSX.utils.book_new()
    workbook.Props = {
      Title: `${basename(originalFilename, extname(originalFilename))}-清洗结果`,
      Subject: "亚马逊 Sponsored Products 搜索词清洗结果",
      Author: "AI Sourcing Platform",
      CreatedDate: new Date(),
    }

    const grandMetrics = metricsOf(aggregation.grand)
    const summaryRows: unknown[][] = [
      ["项目", "值"],
      ["规则版本", AD_CLEANING_RULE_VERSION],
      ["源文件", originalFilename],
      ["源 Sheet", parsed.sourceSheet],
      ["币种", parsed.currency],
      ["生成时间", new Date().toISOString()],
      ["原始数据行", parsed.sourceRows],
      ["有效数据行", parsed.rows.length],
      ["聚合后搜索词行", aggregation.searchTerms.size],
      ["合并行数", parsed.rows.length - aggregation.searchTerms.size],
      ["跳过空行", parsed.skippedRows],
      ["清理不可见字符数", parsed.cleanedInvisibleChars],
      ["去除首尾引号行数", parsed.trimmedWrappingQuotes],
      ["曝光为0但有点击行数", parsed.zeroImpressionClickRows],
      ["展示量", aggregation.grand.imp],
      ["点击量", aggregation.grand.clk],
      ["花费", aggregation.grand.spendCents / 100],
      ["7天销售额", aggregation.grand.salesCents / 100],
      ["7天订单数", aggregation.grand.orders],
      ["CTR", grandMetrics.ctr],
      ["CPC", grandMetrics.cpc],
      ["CVR", grandMetrics.cvr],
      ["ACOS", grandMetrics.acos],
      ["CPA", grandMetrics.cpa],
      ["ROAS", grandMetrics.roas],
      ["可收割", report.stats.verdictCounts.good],
      ["高风险", report.stats.verdictCounts.bad],
      ["待优化", report.stats.verdictCounts.warn],
      ["继续观察", report.stats.verdictCounts.watch],
      ["表现中性", report.stats.verdictCounts.neutral],
      ["待否定词数量", report.stats.negativeCandidateCount],
      ["待否定词浪费花费", report.stats.negativeCandidateSpend],
    ]
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows)
    this.formatSummarySheet(summarySheet, parsed.currency)
    XLSX.utils.book_append_sheet(workbook, summarySheet, "清洗摘要")

    this.appendDataSheet(
      workbook,
      "按广告活动",
      ["广告活动", ...RAW_AND_METRIC_HEADERS],
      this.dimensionRows(aggregation.campaigns.values(), ["campaign"]),
      parsed.currency
    )
    this.appendDataSheet(
      workbook,
      "按广告组",
      ["广告活动", "广告组", ...RAW_AND_METRIC_HEADERS],
      this.dimensionRows(aggregation.adGroups.values(), ["campaign", "adGroup"]),
      parsed.currency
    )
    this.appendDataSheet(
      workbook,
      "按投放",
      ["广告活动", "广告组", "投放", ...RAW_AND_METRIC_HEADERS],
      this.dimensionRows(aggregation.targetings.values(), ["campaign", "adGroup", "targeting"]),
      parsed.currency
    )
    this.appendDataSheet(
      workbook,
      "按匹配类型",
      ["匹配类型", ...RAW_AND_METRIC_HEADERS],
      this.dimensionRows(aggregation.matchTypes.values(), ["matchType"]),
      parsed.currency
    )

    const auditHeaders = [
      "广告活动",
      "广告组",
      "投放",
      "匹配类型",
      "客户搜索词",
      ...RAW_AND_METRIC_HEADERS,
      "活动均CTR",
      "广告组均CTR",
      "匹配类型均CTR",
      "全站均CTR",
      "全站均CVR",
      "全站均ACOS",
      "判断",
      "清洗建议",
    ]
    this.appendDataSheet(
      workbook,
      "搜索词审计",
      auditHeaders,
      report.auditRows.map(row => row.values),
      parsed.currency,
      auditHeaders.indexOf("判断")
    )

    const negativeHeaders = [
      "广告活动",
      "广告组",
      "投放",
      "匹配类型",
      "客户搜索词",
      "建议否定匹配",
      "点击量",
      "花费",
      "判断证据",
    ]
    const negativeRows = report.negativeRows.map(row => [
      row.term.campaign,
      row.term.adGroup,
      row.term.targeting,
      row.term.matchType,
      row.term.searchTerm,
      "Negative Exact",
      row.term.clk,
      row.term.spendCents / 100,
      row.verdict.suggestion,
    ])
    negativeRows.push([
      "合计",
      "",
      "",
      "",
      "",
      "",
      report.stats.negativeCandidateCount,
      report.stats.negativeCandidateSpend,
      "",
    ])
    this.appendDataSheet(workbook, "待否定词", negativeHeaders, negativeRows, parsed.currency)

    const sheetPreviews = this.buildSheetPreviews(workbook)
    XLSX.writeFile(workbook, outputPath, {
      bookType: "xlsx",
      compression: true,
      cellStyles: true,
    })
    return sheetPreviews
  }

  private static appendDataSheet(
    workbook: XLSX.WorkBook,
    name: string,
    headers: readonly string[],
    rows: unknown[][],
    currency: string,
    verdictColumn = -1
  ): void {
    const sheet = XLSX.utils.aoa_to_sheet([[...headers], ...rows])
    const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1")
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range(range) }
    ;(sheet as XLSX.WorkSheet & { "!freeze"?: { xSplit: number; ySplit: number } })["!freeze"] = {
      xSplit: 0,
      ySplit: 1,
    }
    sheet["!cols"] = headers.map((header, columnIndex) => ({
      wch: this.columnWidth(header, rows, columnIndex),
    }))
    sheet["!rows"] = [{ hpt: 24 }]

    for (let column = range.s.c; column <= range.e.c; column++) {
      const cell = this.cellAt(sheet, XLSX.utils.encode_cell({ r: 0, c: column }))
      if (!cell) continue
      cell.s = {
        fill: { patternType: "solid", fgColor: { rgb: "1F4E78" } },
        font: { bold: true, color: { rgb: "FFFFFF" } },
        alignment: { vertical: "center", horizontal: "center", wrapText: true },
      }
    }

    const moneyFormat = this.currencyFormat(currency)
    const moneyHeaders = new Set(["花费", "7天销售额", "CPC", "CPA"])
    const percentHeaders = new Set([
      "CTR",
      "CVR",
      "ACOS",
      "活动均CTR",
      "广告组均CTR",
      "匹配类型均CTR",
      "全站均CTR",
      "全站均CVR",
      "全站均ACOS",
    ])
    const integerHeaders = new Set(["展示量", "点击量", "7天订单数"])
    for (let row = 1; row <= range.e.r; row++) {
      for (let column = 0; column < headers.length; column++) {
        const cell = this.cellAt(sheet, XLSX.utils.encode_cell({ r: row, c: column }))
        if (!cell) continue
        const header = headers[column]
        if (moneyHeaders.has(header)) cell.z = moneyFormat
        else if (percentHeaders.has(header)) cell.z = "0.00%"
        else if (integerHeaders.has(header)) cell.z = "#,##0"
        else if (header === "ROAS") cell.z = "0.00"

        if (column === verdictColumn && typeof cell.v === "string") {
          const cls = (Object.entries(VERDICT_LABELS).find(([, label]) => label === cell.v)?.[0] ??
            "neutral") as VerdictClass
          const style = VERDICT_STYLES[cls]
          cell.s = {
            fill: { patternType: "solid", fgColor: { rgb: style.fill.replace("#", "") } },
            font: { bold: true, color: { rgb: style.color.replace("#", "") } },
            alignment: { horizontal: "center" },
          }
        }
      }
    }
    XLSX.utils.book_append_sheet(workbook, sheet, name)
  }

  private static formatSummarySheet(sheet: XLSX.WorkSheet, currency: string): void {
    sheet["!cols"] = [{ wch: 24 }, { wch: 48 }]
    sheet["!rows"] = [{ hpt: 24 }]
    for (const address of ["A1", "B1"]) {
      const cell = this.cellAt(sheet, address)
      if (!cell) continue
      cell.s = {
        fill: { patternType: "solid", fgColor: { rgb: "1F4E78" } },
        font: { bold: true, color: { rgb: "FFFFFF" } },
        alignment: { horizontal: "center" },
      }
    }
    const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:B1")
    for (let row = 1; row <= range.e.r; row++) {
      const label = cellText(this.cellAt(sheet, XLSX.utils.encode_cell({ r: row, c: 0 }))?.v)
      const valueCell = this.cellAt(sheet, XLSX.utils.encode_cell({ r: row, c: 1 }))
      if (!valueCell) continue
      if (["花费", "7天销售额", "CPC", "CPA", "待否定词浪费花费"].includes(label)) {
        valueCell.z = this.currencyFormat(currency)
      } else if (["CTR", "CVR", "ACOS"].includes(label)) {
        valueCell.z = "0.00%"
      } else if (label === "ROAS") {
        valueCell.z = "0.00"
      } else if (typeof valueCell.v === "number") {
        valueCell.z = "#,##0"
      }
    }
  }

  private static currencyFormat(currency: string): string {
    const formats: Record<string, string> = {
      USD: '"$"#,##0.00',
      CNY: '"¥"#,##0.00',
      EUR: '"€"#,##0.00',
      GBP: '"£"#,##0.00',
    }
    return formats[currency] ?? `#,##0.00 "${currency.replace(/"/g, "")}"`
  }

  private static columnWidth(header: string, rows: unknown[][], column: number): number {
    if (header === "客户搜索词" || header === "清洗建议" || header === "判断证据") return 48
    if (["广告活动", "广告组", "投放"].includes(header)) return 30
    const maxLength = rows.slice(0, 1000).reduce((max, row) => {
      const value = cellText(row[column])
      return Math.max(max, Math.min(value.length, 40))
    }, header.length)
    return Math.max(12, Math.min(maxLength + 2, 32))
  }

  /**
   * 从最终工作簿生成前端预览。表头单独返回，不占用每个 Sheet 的 100 行数据额度；
   * 数字保持 number，空单元格统一为 null，避免前端二次解析金额和百分比字符串。
   */
  private static buildSheetPreviews(workbook: XLSX.WorkBook): AdCleaningSheetPreview[] {
    return workbook.SheetNames.map(sheetName => {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet) return { sheetName, headers: [], rows: [], totalRows: 0 }

      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: true,
        defval: null,
        blankrows: false,
      })
      const headerRow = matrix[0] ?? []
      const headers = headerRow.map(value => cellText(value))
      const dataRows = matrix.slice(1)
      const rows = dataRows
        .slice(0, 100)
        .map(row => headers.map((_, column) => this.previewCell(row[column])))

      return { sheetName, headers, rows, totalRows: dataRows.length }
    })
  }

  private static previewCell(value: unknown): AdCleaningPreviewCell {
    if (value === null || value === undefined) return null
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value
    }
    if (value instanceof Date) return value.toISOString()
    return null
  }

  /** 根据“清洗摘要”Sheet 还原接口需要的结构化统计，不额外持久化 stats。 */
  private static statsFromSheetPreviews(previews: AdCleaningSheetPreview[]): AdCleaningStats {
    const summary = previews.find(preview => preview.sheetName === "清洗摘要")
    if (!summary) throw new Error("清洗结果缺少「清洗摘要」Sheet")
    const values = new Map(summary.rows.map(row => [String(row[0] ?? ""), row[1] ?? null] as const))
    const numberValue = (label: string): number => {
      const value = values.get(label)
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`清洗摘要中的「${label}」不是有效数字`)
      }
      return value
    }
    const textValue = (label: string): string => {
      const value = values.get(label)
      if (typeof value !== "string" || !value) {
        throw new Error(`清洗摘要中的「${label}」不是有效文本`)
      }
      return value
    }

    return {
      sourceSheet: textValue("源 Sheet"),
      currency: textValue("币种"),
      sourceRows: numberValue("原始数据行"),
      effectiveRows: numberValue("有效数据行"),
      aggregatedSearchTerms: numberValue("聚合后搜索词行"),
      mergedRows: numberValue("合并行数"),
      skippedRows: numberValue("跳过空行"),
      cleanedInvisibleChars: numberValue("清理不可见字符数"),
      trimmedWrappingQuotes: numberValue("去除首尾引号行数"),
      zeroImpressionClickRows: numberValue("曝光为0但有点击行数"),
      verdictCounts: {
        good: numberValue("可收割"),
        bad: numberValue("高风险"),
        warn: numberValue("待优化"),
        watch: numberValue("继续观察"),
        neutral: numberValue("表现中性"),
      },
      negativeCandidateCount: numberValue("待否定词数量"),
      negativeCandidateSpend: numberValue("待否定词浪费花费"),
    }
  }

  private static cellAt(sheet: XLSX.WorkSheet, address: string): StyledCell | undefined {
    const value: unknown = sheet[address]
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    return value as StyledCell
  }
}
