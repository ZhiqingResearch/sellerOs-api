/**
 * Scout 选品评分与市场枚举类型（从 Web lib/types.ts 等价迁移的子集，
 * ASIN 审计闭环所需；交付包提交 1fd586c）。
 */

export type ListingMode = "standard" | "custom"

export interface ScoutDeduction {
  /** 扣分点描述，例如 "核心品类词未出现在标题前60字符" */
  reason: string
  /** 扣掉的分数（正数），0 表示仅提示不扣分 */
  points: number
}

export interface ScoutCriterion {
  name: string
  description: string
  score: number
  maxScore: number
  source?:
    | "官方"
    | "官方论文"
    | "行业研究"
    | "操作建议"
    | "官方IDQ"
    | "穿透数据"
    | "广告数据"
    | "Sorftime VOC"
    | "Sif流量API"
  /** 该细则的扣分明细；满分时为空数组 */
  deductions?: ScoutDeduction[]
}

export interface ScoutDimension {
  name: string
  subtitle: string
  weight: number
  maxScore: number
  score: number
  color: string
  criteria: ScoutCriterion[]
}

export interface ScoutScoreResult {
  total: number
  dimensions: ScoutDimension[]
  suggestions: string[]
  potential: string
  /** AI 生成的简短标题，用于历史记录展示 */
  historyTitle?: string
  /** 评分所用的 mode（standard / custom），原样回填。 */
  mode?: ListingMode
  /**
   * CDQ 严重缺陷 / 政策违规命中项（D 级 / U 级一票否决）。由评分服务在 skill 输出后
   * 做兜底校验填充；非空表示触发归零（total=0、potential 为 D 级）。前端据此高亮。
   */
  severeDefects?: string[]
}

export type Market =
  | "amazon_us"
  | "amazon_uk"
  | "amazon_de"
  | "amazon_jp"
  | "walmart_us"
  | "ebay_us"
  | "tiktok_us"
  | "tiktok_mx"
  | "ozon_ru"
  | "wildberries_ru"

export type MarketPlatform = "amazon" | "walmart" | "ebay" | "tiktok" | "ozon" | "wildberries"

export const AMAZON_MARKETS: readonly Market[] = [
  "amazon_us",
  "amazon_uk",
  "amazon_de",
  "amazon_jp",
] as const

export const MARKET_LABELS: Record<Market, string> = {
  amazon_us: "Amazon US",
  amazon_uk: "Amazon UK",
  amazon_de: "Amazon DE",
  amazon_jp: "Amazon JP",
  walmart_us: "Walmart US",
  ebay_us: "eBay US",
  tiktok_us: "TikTok US",
  tiktok_mx: "TikTok MX",
  ozon_ru: "Ozon RU",
  wildberries_ru: "Wildberries RU",
}

export function isAmazonMarket(market: Market): boolean {
  return market.startsWith("amazon_")
}

export function getPlatformForMarket(market: Market): MarketPlatform {
  if (market.startsWith("walmart_")) return "walmart"
  if (market.startsWith("ebay_")) return "ebay"
  if (market.startsWith("tiktok_")) return "tiktok"
  if (market.startsWith("ozon_")) return "ozon"
  if (market.startsWith("wildberries_")) return "wildberries"
  return "amazon"
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  thinkingTokens: number
  totalTokens: number
}
