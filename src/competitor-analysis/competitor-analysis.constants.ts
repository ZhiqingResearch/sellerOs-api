export const COMPETITOR_ANALYSIS_SCHEMA_VERSION = 1
export const COMPETITOR_ANALYSIS_MAX_BYTES = 4 * 1024 * 1024
export const COMPETITOR_ANALYSIS_MAX_JSON_DEPTH = 30
export const COMPETITOR_ANALYSIS_MAX_COMPETITORS = 20
export const COMPETITOR_ANALYSIS_MAX_SOURCE_TEXT_LENGTH = 20_000

export const COMPETITOR_ANALYSIS_MARKETPLACES = [
  "US",
  "UK",
  "DE",
  "CA",
  "JP",
  "FR",
  "ES",
  "IT",
  "MX",
  "AU",
  "AE",
  "BR",
  "SA",
] as const
export const COMPETITOR_ANALYSIS_MODES = ["ASIN", "KEYWORD"] as const

export type CompetitorAnalysisMarketplace = (typeof COMPETITOR_ANALYSIS_MARKETPLACES)[number]
export type CompetitorAnalysisModeValue = (typeof COMPETITOR_ANALYSIS_MODES)[number]

export const COMPETITOR_ANALYSIS_ASIN_PATTERN = /^[A-Z0-9]{10}$/
