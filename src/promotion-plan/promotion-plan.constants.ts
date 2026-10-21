export const PROMOTION_PLAN_SCHEMA_VERSION = 1
export const PROMOTION_PLAN_MAX_COMPETITORS = 5
export const PROMOTION_PLAN_MAX_PRODUCT_TEXT_LENGTH = 10000

/// 前端 Market 枚举（站点会扩展，只在 DTO 层校验，DB 存 string）
export const PROMOTION_PLAN_MARKETS = [
  "amazon_us",
  "amazon_uk",
  "amazon_de",
  "walmart_us",
  "ebay_us",
  "tiktok_us",
  "tiktok_mx",
  "ozon_ru",
  "wildberries_ru",
] as const

export type PromotionPlanMarket = (typeof PROMOTION_PLAN_MARKETS)[number]
