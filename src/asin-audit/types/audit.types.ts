/** ASIN 审计 — 服务端类型（证据 + 打分） */

import type { AsinPerformanceEvidence, KeywordTrafficEvidence } from "./de.types"
import type { Market } from "./scout.types"

export type {
  AsinPerformanceEvidence,
  AsinPriceBsrSnapshot,
  AuditEvidenceCard,
  DeEvidenceResult,
  KeywordTrafficEvidence,
  KeywordTrafficTopRow,
  OpportunityKeyword,
  PositionAllocationRow,
  TrafficPrecompute,
  TrafficStructure,
  TrafficSuggestionBlock,
  TrafficTierBuckets,
} from "./de.types"

import type { TrafficPrecompute, TrafficSuggestionBlock } from "./de.types"

export interface QaItem {
  q: string
  a: string
  votes?: number
}

export interface ProductParamGroup {
  name: string
  fields: { k: string; v: string }[]
}

export interface ReviewDistItem {
  label: string
  pct: string
  bad: boolean
}

export interface ReviewPainPoint {
  text: string
  freq?: number
  /** 代表性原文逐字摘录（原语言，仅评论分析双输出模式产出） */
  quote?: string
}

/** 好评亮点（与痛点同构，语义正向） */
export interface ReviewHighlight {
  text: string
  freq?: number
  quote?: string
}

/** 评论原文抽样（爬虫 comment_list 原样透传，非 AI 产出；字段缺失即缺省） */
export interface ReviewSample {
  date?: string
  rating?: number | string
  title?: string
  text: string
}

export interface ListingEvidence {
  filled: boolean
  title?: string
  /** 商品副标题（爬虫 second_title）；键恒在，无值时为 null */
  secondTitle?: string | null
  /** 品牌词（爬虫详情 brand / P 卡 Brand 属性兜底），用于 A1 品牌词机械预检 */
  brand?: string
  /** 类目路径（爬虫 nodeLabelPath），用于电脑类目覆盖层的确定性判定 */
  categoryPath?: string
  productImages?: { url: string; role: "main" | "secondary" }[]
  bullets?: string[]
  description?: string
  searchTerms?: string[]
  rawPaste?: string
  imageCount?: number | null
  hasVideo?: boolean | null
  qaCount?: number | null
  hasAplus?: boolean | null
  qa?: QaItem[]
  aplusImages?: string[]
  aplusModules?: { type: string; desc: string }[]
}

export interface ProductParamsEvidence {
  filled: boolean
  missingReason?: string
  attributes?: { name: string; value: string }[]
  groups?: ProductParamGroup[]
}

export interface ReviewEvidence {
  filled: boolean
  missingReason?: string
  rating?: number | null
  stars?: number
  reviewCount?: number | null
  painPoints?: string[]
  dist?: ReviewDistItem[]
  richPainPoints?: ReviewPainPoint[]
  /** 好评亮点（仅取证模块 type=module 双输出模式产出） */
  highlights?: ReviewHighlight[]
  /** 评论原文抽样（爬虫 comment_list 前 N 条原样透传，N 为 1~10 随机条数，与 AI 分析无关） */
  reviewSamples?: ReviewSample[]
}

export interface CompetitorEvidence {
  filled: boolean
  missingReason?: string
  competitorAsins?: string[]
  sharedKeywords?: string[]
  keywords?: { kw: string; tier: string; searches: string }[]
}

export type EvidenceSource = "sif" | "mcp" | "paste" | "erp" | "apify" | "upload"

/** 六卡完整证据包 — LLM 打分入参 */
export interface AuditEvidence {
  asin: string
  country: string
  market: Market
  A: ListingEvidence
  P: ProductParamsEvidence
  B: ReviewEvidence
  C: CompetitorEvidence
  D: KeywordTrafficEvidence
  E: AsinPerformanceEvidence
  meta: {
    sources: Partial<Record<"A" | "P" | "B" | "C" | "D" | "E", EvidenceSource[]>>
    sifDataReady?: boolean | null
    sifWarnings?: string[]
    fetchedAt: string
    estimatedPoints?: number
  }
}

// ── 十板块评分类型（v2.0 · 2026-09-08，A–J · 24 项目 · 100 分）──

export type AuditGrade = "EXCELLENT" | "GOOD" | "FAIR" | "POOR"

/** 项目数据状态：verified 已核验 / pending 待核（得分留空，权重留 A 不进 V）/ na 不适用（从 A 与 V 同时剔除） */
export type AuditItemStatus = "verified" | "pending" | "na"

export interface AuditItemDeduction {
  /** 含数值证据的扣分原因（v2.0 §四格式：扣 N 分 · 当前 x/max · 原因与证据） */
  reason: string
  points: number
}

export interface AuditBoardItem {
  id: string
  name: string
  maxScore: number
  /** verified 必填；pending/na 必须为 null */
  score: number | null
  status: AuditItemStatus
  pendingReason?: string | null
  naReason?: string | null
  deductions: AuditItemDeduction[]
}

export interface AuditBoard {
  id: string
  name: string
  weight: number
  maxScore: number
  /** 板块得分（百分制）= Σ已核验实得 / Σ已核验满分 × 100；全部待核/NA 时为 null（服务端重算） */
  score: number | null
  items: AuditBoardItem[]
}

/** A/V/E 三分母折算（v2.0 §3.3，服务端重算，不信模型聚合值） */
export interface AuditScoreSummary {
  /** A 适用满分 = 100 − 已判 N/A 项目满分 */
  applicableMax: number
  /** V 有效证据满分 = A − 待核项目满分 */
  evidenceMax: number
  /** E 有效得分 = 已核验项目实得分之和 */
  earnedScore: number
  /** 已核验部分折算分 = 100×E/V（V=0 时 null） */
  convertedScore: number | null
  /** 证据覆盖率 = V/A */
  coverageRate: number
  /** V=A 才为完整最终分 */
  isComplete: boolean
}

export interface AuditDiagnosisIssue {
  boardId: string
  summary: string
  /** ≤2 条带数值证据的问题句（含 owner_rule 语义） */
  evidences: string[]
}

export interface AuditDiagnosis {
  /** 最弱 ≤3 板块 id（按板块得分升序） */
  weakestBoards: string[]
  contentNarrative: string
  operationsNarrative: string
  issues: AuditDiagnosisIssue[]
}

/** 打分结果（v2.0 十板块；total 在覆盖率<60% 或 V=0 时为 null，不出总分） */
export interface AuditScoreResult {
  historyTitle: string
  /** 十板块折算总分；证据覆盖率 <60% 或 V=0 → null（前端只展示折算分+覆盖率） */
  total: number | null
  grade: AuditGrade
  gradeLabel: string
  domainScores: { content: number | null; operations: number | null }
  boards: AuditBoard[]
  scoring: AuditScoreSummary
  diagnosis: AuditDiagnosis
  aiVerdict?: string
  aiSecondary?: string
  actionItems: string[]
  suggestions: string[]
  /** 广告投放诊断（并列独立 100 分，不进十板块；未上传恒缺省）——模型输出透传 */
  adDiagnostics?: unknown
  /**
   * 归档兼容摘要（AsinAuditRecord 摘要列口径）：由服务端从 total/domainScores/adDiagnostics
   * 确定性附带（total=null 时折算分兜底、域分无已核验项为 0），前端把 scoreResult 原样
   * 回传到 /asin-audit/records 即可通过 v2 校验落库；广告分未上传/提不出时缺省。
   */
  overallScore?: number
  contentScore?: number
  trafficScore?: number
  adScore?: number
  trafficPrecompute?: TrafficPrecompute
  /** 流量四子维度建议（G1/I3/G3/J2，按扣分量降序） */
  trafficSuggestions?: TrafficSuggestionBlock[]
  missingEvidence?: string[]
  severeDefects?: string[]
}

/** LLM 原始 JSON（聚合分/等级由服务端重算覆盖） */
export interface AuditScoreLlmPayload {
  historyTitle?: string
  boards?: AuditBoard[]
  diagnosis?: AuditDiagnosis
  suggestions?: string[]
  aiVerdict?: string
  aiSecondary?: string
  actionItems?: string[]
  adDiagnostics?: unknown
  severeDefects?: string[]
}

// ── 优化交付物类型（从 Web lib/asin-audit/audit-types.ts 等价迁移）──

export interface ImageSellingPoint {
  type: string
  name: string
  description: string
}

export interface AplusModule {
  name: string
  nameEn: string
  description: string
}

export interface KeywordTier {
  tier: "S" | "A" | "B" | "longtail"
  label: string
  keywords: string[]
}

export interface ReviewResponseStrategy {
  painPoint: string
  response: string
  improvement: string
}

export interface DifferentiationUSP {
  title: string
  analysis: string
}

export interface LaunchPhase {
  name: string
  timeline: string
  goal: string
  tactics: string[]
}

export interface AuditFieldRewrite {
  field: string
  original: string
  rewritten: string
  reason: string
}

export interface AuditImprovementPriority {
  level: "P0" | "P1" | "P2" | "P3"
  title: string
  impact: string
  effort: string
  action: string
}

export interface AuditOptimizeListing {
  title: string
  bullets: string[]
  description: string
  searchTerms: string[]
  qaCandidates: { q: string; a: string }[]
}

export interface AuditOptimizeResult {
  listing: AuditOptimizeListing
  imageSellingPoints: ImageSellingPoint[]
  aplusModules: AplusModule[]
  keywordTiers: KeywordTier[]
  reviewStrategies: ReviewResponseStrategy[]
  differentiationUSPs: DifferentiationUSP[]
  launchPhases: LaunchPhase[]
  fieldRewrites?: AuditFieldRewrite[]
  improvementPriorities?: AuditImprovementPriority[]
}

/** audit/detail 接口响应包络（等价迁移 Web audit-types.ts） */
export interface AuditDetailResponse {
  id: number
  url: string
  platform: string
  country: string
  asin: string | null
  name: string
  data: Record<string, unknown> | null
  fetchedAt: string
  createdAt: string
  updatedAt: string
}
