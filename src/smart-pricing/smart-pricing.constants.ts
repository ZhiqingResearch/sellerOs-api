export const SMART_PRICING_SCHEMA_VERSION = 1
export const SMART_PRICING_MAX_BYTES = 1 * 1024 * 1024
export const SMART_PRICING_MAX_COMPETITORS = 100
export const SMART_PRICING_MAX_FILENAMES = 20
export const SMART_PRICING_STAGE_COUNT = 4
export const SMART_PRICING_MAX_JSON_DEPTH = 30

export const SMART_PRICING_MARKETPLACES = {
  AMAZON_US: "Amazon US",
  WALMART_US: "Walmart US",
  AMAZON_UK: "Amazon UK",
  AMAZON_DE: "Amazon DE",
  TIKTOK_MX: "TikTok MX",
} as const

export type SmartPricingMarketplaceCode = keyof typeof SMART_PRICING_MARKETPLACES

/** 归档记录允许的币种（ISO 4217），覆盖全部站点本币，按前端实际选择保存 */
export const SMART_PRICING_CURRENCIES = ["USD", "MXN", "GBP", "EUR"] as const

export type SmartPricingCurrency = (typeof SMART_PRICING_CURRENCIES)[number]

export const SMART_PRICING_MARKETPLACE_CODES = Object.keys(
  SMART_PRICING_MARKETPLACES
) as SmartPricingMarketplaceCode[]

export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
