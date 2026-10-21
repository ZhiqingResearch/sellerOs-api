/** ASIN 审计 — D/E 证据卡类型（SIF 取证） */

import type { AdCleaningEvidence } from "./ad-cleaning.types"

export interface KeywordTrafficTopRow {
  kw: string
  searchVol: string
  contribution: number
  aba: number | null
  heat: string
  ranking: string
  tags: string[]
}

/** 流量层级打标计数（核心/腰部/长尾/机会）。 */
export interface TrafficTierBuckets {
  core: number
  waist: number
  longtail: number
  opportunity: number
}

/** 流量结构分析指标（用于「增加维度展示」与优化阶段可视化）。 */
export interface TrafficStructure {
  /** 整体自然流量占比 %（Σ naturalScore / Σ totalScore） */
  naturalPct: number | null
  /** 广告依赖度 %（Σ adScore / Σ totalScore） */
  adDependencyPct: number | null
  /** Top5 词贡献流量集中度 % */
  top5ConcentrationPct: number
  /** 首页命中率 %（page==1 词数 / 总词数） */
  homepageHitRate: number
  homepageHits: number
  totalKw: number
}

/** 机会词（优化阶段 子维度3 原料；竞品自然占比用该词 naturalRatio 代理）。 */
export interface OpportunityKeyword {
  kw: string
  searches: number
  searchVolLabel: string
  purchaseRatePct: number | null
  naturalRatioPct: number | null
  page: number | null
  allPageRank: number | null
  value: number
}

/** 位置分配候选行（优化阶段 子维度1 原料）。 */
export interface PositionAllocationRow {
  kw: string
  searches: number
  searchVolLabel: string
  currentRank: string
  suggestPosition: string
}

export interface TrafficPrecompute {
  top10Page1Hits: number
  homepageHitTier: { score: number; max: number; label: string }
  weightedNaturalPct: number | null
  naturalHealthTier: { score: number; max: number; label: string }
  opportunityCount: number
  top1ConcentrationPct: number
  concentrationTier: { score: number; max: number; label: string }
  summaryLines: string[]
  /** 流量层级打标计数 */
  tierBuckets?: TrafficTierBuckets
  /** 流量结构分析指标 */
  structure?: TrafficStructure
  /** 机会词清单（按 searches×purchaseRate 综合价值降序） */
  opportunityList?: OpportunityKeyword[]
  /** Top10 中未进首页的词 → 位置分配候选 */
  positionAllocation?: PositionAllocationRow[]
  /** 集中度风险：头部词 + 可分散的腰部词候选 */
  concentration?: {
    headKeyword: { kw: string; searches: number; searchVolLabel: string; trafficPct: number } | null
    waistCandidates: { kw: string; searchVolLabel: string }[]
  }
  /** I3 · 近 14 天日级 BSR 走势预计算（前 7 天 vs 后 7 天保持率；SIF asinOpTrafficTrend） */
  bsrTrend?: BsrTrendPrecompute
}

/** I3 排名趋势预计算（BSR 口径）：前 7 天 vs 后 7 天，改善封顶不加分 */
export interface BsrTrendPrecompute {
  /** 数据充足可评分；false 时 reason 说明缺口 */
  available: boolean
  reason?: string
  /** 观测窗口天数（固定 14） */
  windowDays: number
  /** 窗口内有效 BSR 天数 */
  validDays: number
  /** 前 7 天平均 BSR（数值越小排名越好） */
  prev7AvgBsr: number | null
  /** 后 7 天平均 BSR */
  last7AvgBsr: number | null
  /** 加权排名保持率 % = min(1, 前7天均 ÷ 后7天均) × 100（改善封顶 100） */
  retainedPct: number | null
  /** 尾部连续高于前 7 天均值（排名劣于基线）的天数 */
  declinedDays: number
  /** 建议得分 tier：score = round2(8 × 保持率)，max = 8 */
  tier: { score: number; max: number; label: string }
  /** 近 14 天逐日序列（供叙述，不打分） */
  series?: Array<{ date: string; bsr: number | null }>
  /** 近 7 天逐日序列（series 尾部 7 天，供前端 7 天视图；天数不足时可能少于 7 条） */
  series7?: Array<{ date: string; bsr: number | null }>
}

export interface KeywordTrafficEvidence {
  filled: boolean
  summary?: {
    coreCognition: string
    trafficStory: string
  }
  kwStats?: {
    reversed: number
    core: number
    organic: number
    ad: number
    opportunity: number
  }
  kwTop: KeywordTrafficTopRow[]
  kwDetail: KeywordTrafficTopRow[]
  period?: { startDate?: string; endDate?: string }
  trafficPrecompute?: TrafficPrecompute
}

/**
 * 优化阶段「关键词与流量」板块的单个子维度建议块。
 * 按扣分量从大到小排序；满分子维度仅给一行「✅ 表现良好，无需调整」。
 */
/** 流量四子维度建议块（v2.0 §八：G1/I3/G3/J2，扣分越多越靠前；满分一行 ✅、待核一行 ⏸） */
export interface TrafficSuggestionBlock {
  /** 子维度名（当日核心词首页观测率 / 排名趋势与稳定性 / 合格机会词曝光承接 / 流量来源韧性） */
  subDimension: string
  /** 来源规则 ID（G1 / I3 / G3 / J2） */
  ruleId: string
  /** 扣分量（满分=0；待核=0） */
  deducted: number
  maxScore: number
  /** 建议级别：ok=✅ 良好 / pending=⏸ 待核不评分 / optimize=🟢 / important=🟡 / urgent=🔴 */
  level: "ok" | "pending" | "optimize" | "important" | "urgent"
  /** 一句话结论（ok："✅ 表现良好"；pending："⏸ 证据不足，本次不评分"） */
  summary: string
  /** G1：词位置分配表 */
  positionTable?: PositionAllocationRow[]
  /** G3：机会词清单（按冻结需求权重降序） */
  opportunityTable?: OpportunityKeyword[]
  /** AI 摘要（≤3 句） */
  aiSummary?: string
}

export interface AsinPriceBsrSnapshot {
  buyboxPrice: number | null
  bsr: number | null
  bsrTrend: string | null
  coupon: string
  listedDate: string | null
  pricePriorityTags?: string[]
  priceExceptionTags?: string[]
}

export interface AsinPerformanceEvidence {
  filled: boolean
  asin: string
  boughtInPastMonth: number | null
  priceBsr: AsinPriceBsrSnapshot
  sales?: null
  traffic?: null
  ad?: null
  profit?: null
  inventory?: null
  adCleaning?: AdCleaningEvidence
}

export interface CompetitorKeywordRow {
  kw: string
  tier: string
  searches: string
}

export interface CompetitorEvidenceDe {
  filled: boolean
  missingReason?: string
  competitorAsins?: string[]
  sharedKeywords?: string[]
  keywords?: CompetitorKeywordRow[]
}

export interface DeEvidenceResult {
  asin: string
  country: string
  C: CompetitorEvidenceDe
  D: KeywordTrafficEvidence
  E: AsinPerformanceEvidence
  meta: {
    sources: { C?: "mcp"[]; D: "sif"[]; E: "sif"[] }
    sifDataReady: boolean | null
    sifWarnings: string[]
    fetchedAt: string
    estimatedPoints: number
  }
}

export type AuditEvidenceCard = "C" | "D" | "E"
