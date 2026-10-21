/**
 * SIF API 返回结构类型（仅覆盖第二步「机会+市场验证」会用到的端点，字段依据
 * 真实调用核对，详见 docs/references/选品工具调研/02-机会与市场验证.md 第七节）。
 * 后续开发其它步骤时按需补充。
 */

/* ── 数据就绪检查 · getSifLastDataTime ── */
export interface SifDataModule {
  moduleCode: string
  name: string
  dataTime: string
  dataReady: boolean
  startTime?: string
  endTime?: string
  granularity?: string | null
}
export interface SifDataReadiness {
  request: string
  timeZone: string
  countryName: string
  list: SifDataModule[]
  nextTickMinutes?: number
}

/* ── 关键词查询竞品数(按月) · keywordCompetitorGroupByMonthly ── */
export interface SifKeywordCompetitorRow {
  keyword: string
  /** 周期起始日（yyyy-MM-dd）。 */
  startDate: string
  /** 月搜索量。 */
  searchVolume: number
  /** 搜索排名。 */
  searchRank: number
  /** ASIN 总数（在线商品数，用于供需比）。 */
  totalAsinNum: number
  /** 自然搜索产品数。 */
  nfAsinNum: number
  /** PPC 广告产品数。 */
  ppcAdAsinNum: number
  /** SP 广告产品数。 */
  spAdAsinNum: number
  [key: string]: unknown
}
export interface SifKeywordCompetitorResult {
  startDate: string
  endDate: string
  list: SifKeywordCompetitorRow[]
}

/* ── 关键词竞争流量分析(按周) · competePatternFlexibleGroupByWeekly ── */
export interface SifCompetePatternAsinDetail {
  title: string
  img?: string
  price: number
  /** 评论总数。 */
  ratingNum: number
  /** 商品评分（如 4.4）。 */
  score: number
  /** 星级（如 4.5）。 */
  star: number
  lastUpdateTime?: number
}
export interface SifCompetePatternRow {
  keyword: string
  asin: string
  startDate: string
  /** 总流量份额（totalScore/keywordTotalScore，0~1）。 */
  totalScoreRatio: number
  /** 自然流量份额。 */
  nfScoreRatio: number
  /** SP 广告流量份额。 */
  spScoreRatio: number
  asinDetail: SifCompetePatternAsinDetail
  [key: string]: unknown
}
export interface SifCompetePatternResult {
  total: number
  list: SifCompetePatternRow[]
}

/* ── ASIN 每日变化(Listing、流量) · timeMachine/asinOpTrafficTrend ──
 * 各指标均为与 dates 一一对应的按日数组(2026-07-17 实调核对:dates 升序,
 * nfScoreRatios/adScoreRatios 为 0~1 小数,review 为评论数时序,bought 为近30天销量)。 */
export interface SifAsinOpTrafficTrend {
  asin: string
  /** 日期序列(yyyy-MM-dd,升序),各指标数组与其一一对应。 */
  dates: string[]
  /** 全部流量得分(搜索量加权)。 */
  totalScore: (number | null)[]
  /** 自然流量占比(0~1)。 */
  nfScoreRatios: (number | null)[]
  /** 广告流量占比(0~1)。 */
  adScoreRatios: (number | null)[]
  /** 评论数量时序。 */
  review: (number | null)[]
  /** 评分时序。 */
  star: (number | null)[]
  /** 近30天前台销量时序。 */
  bought: (number | null)[]
  /** BuyBox 价格时序。 */
  buyboxPrice: (number | null)[]
  [key: string]: unknown
}

/* ── 月前台销量趋势 · asinsHistorySales ──
 * { ASIN: { "yyyy-MM": 月前台销量 } }(实调核对,含未完成的当月)。 */
export type SifAsinsHistorySales = Record<string, Record<string, number>>

/* ── 关键词建议竞价与转化(最新) · keywordConversionLast ── */
export interface SifConversionRange {
  start?: number
  median?: number
  end?: number
}
export interface SifKeywordConversionRow {
  keyword: string
  startDate?: string
  /** PPC 建议竞价(USD/次点击)。 */
  ppc?: SifConversionRange | null
  /** ACOS(小数,如 0.668 = 66.8%)。 */
  acos?: SifConversionRange | null
  [key: string]: unknown
}
export interface SifKeywordConversionResult {
  list: SifKeywordConversionRow[]
}

/* ── ASIN 详情批量 · batchAsinDetail ── */
export interface SifBsrEntry {
  id: string
  name: string
  /** 类目排名，-1 表示已退出该类目排名。 */
  rank: number
}
export interface SifFeatureAttr {
  code: string
  value: string
}
export interface SifAsinDetail {
  asin: string
  title: string
  img?: string
  ratingNum: number
  price: number
  score: number
  /** 近30天前台销量（bought in past month）。 */
  boughtInPastMonth: number
  brand: string
  color?: string
  size?: string
  variationNum: number
  /** 首次上架日期（yyyy-MM-dd）。 */
  firstAvailableDay: string
  bsrList: SifBsrEntry[]
  weight?: string
  dimensions?: string
  featureList?: SifFeatureAttr[]
  featureDescriptions?: string[]
  [key: string]: unknown
}
export interface SifBatchAsinDetailResult {
  list: SifAsinDetail[]
}

/* ══ 以下为 asin-audit（六类数据取证）使用的 SIF 类型 ══ */

/** Minimal SIF response envelopes — extend as more endpoints are wired. */

export interface SifEnvelope<T> {
  code: number
  message: string | null
  data: T
}

export interface SifAsinKeywordRow {
  asin: string
  keyword: string
  updateTime?: string
  startDate?: string
  saleNum?: number
  totalScore?: number
  naturalScore?: number
  /** SP 广告总流量得分 */
  allSpScore?: number
  /** SP 常规流量得分 */
  spScore?: number
  /** SB 广告总流量得分 */
  allSbScore?: number
  sbScore?: number
  sbvScore?: number
  /** 广告流量得分（sp + sb + sbv + recAd） */
  adScore?: number
  searchRank?: number | null
  searchVolume?: number
  /** 当前 ASIN 在该词下的共享点击率%（仅当 ASIN 在 ABA 前三时有值） */
  clickShared?: number | null
  /** 当前 ASIN 在该词下的共享转化率%（仅当 ASIN 在 ABA 前三时有值）— 作为逐词购买率代理 */
  conversionShared?: number | null
  keywordTags?: string[]
  naturalPositionSeq?: Array<{
    date: string
    allPageRank?: number
    page?: number
    currentPageNfRank?: number
  }>
  spPositionSeq?: Array<{
    date: string
    allPageRank?: number
    page?: number
    currentPagSpfRank?: number
  }>
}

export interface SifAsinKeywordsWeeklyData {
  startDate?: string
  endDate?: string
  total?: number
  list: SifAsinKeywordRow[]
}

/** ASIN 反查流量词-按月（asinKeywordsSimpleGroupByMonthly）返回结构与按周一致。 */
export type SifAsinKeywordsMonthlyData = SifAsinKeywordsWeeklyData

export interface SifKeywordOverviewRow {
  keyword: string
  estSearchesNum?: number
  searchesRank?: number
  saleNum?: number
  updateTime?: string
}

export interface SifVariantLastSalesRow {
  asin: string
  boughtInPastMonth?: number
  updateTime?: string
}

export interface SifBatchAsinPriceRow {
  asin: string
  currentPrice?: number
  listedDate?: string
  lastUpdate?: string
  notfound?: boolean
  pricePriorityTags?: string[]
  priceExceptionTags?: string[]
}

export interface SifBatchAsinPriceData {
  list: SifBatchAsinPriceRow[]
}

export interface SifAsinOpTrafficTrendData {
  asin?: string
  dates?: string[]
  bsr?: Array<number | null>
  buyboxPrice?: Array<number | null>
  couponInfo?: Array<number | null>
  review?: Array<number | null>
  star?: Array<number | null>
  bought?: Array<number | null>
}

export interface SifDataReadyModule {
  moduleCode: string
  name: string
  dataReady: boolean
  dataTime?: string
  granularity?: string | null
}

export interface SifLastDataTimeData {
  request?: string
  timeZone?: string
  countryName?: string
  nextTickMinutes?: number
  list: SifDataReadyModule[]
}

// ── 证据链路端点类型（从交付包 asin-audit-backend-source server/sif/types.ts 等价迁移）──

export interface SifKeywordOverviewRow {
  keyword: string
  estSearchesNum?: number
  searchesRank?: number
  saleNum?: number
  updateTime?: string
}

export interface SifVariantLastSalesRow {
  asin: string
  boughtInPastMonth?: number
  updateTime?: string
}

export interface SifBatchAsinPriceRow {
  asin: string
  currentPrice?: number
  listedDate?: string
  lastUpdate?: string
  notfound?: boolean
  pricePriorityTags?: string[]
  priceExceptionTags?: string[]
}

export interface SifBatchAsinPriceData {
  list: SifBatchAsinPriceRow[]
}

export interface SifAsinOpTrafficTrendData {
  asin?: string
  dates?: string[]
  bsr?: Array<number | null>
  buyboxPrice?: Array<number | null>
  couponInfo?: Array<number | null>
  review?: Array<number | null>
  star?: Array<number | null>
  bought?: Array<number | null>
}

export interface SifDataReadyModule {
  moduleCode: string
  name: string
  dataReady: boolean
  dataTime?: string
  granularity?: string | null
}

export interface SifLastDataTimeData {
  request?: string
  timeZone?: string
  countryName?: string
  nextTickMinutes?: number
  list: SifDataReadyModule[]
}
