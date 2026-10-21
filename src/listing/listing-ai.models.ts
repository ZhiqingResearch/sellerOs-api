export const LISTING_AI_MODELS = [
  "ZQ-Think-Flash",
  "ZQ-Think-Lite",
  "ZQ-Think-Pro",
  "ZQ-Multimodal-Gemini-3.8-Flash",
  "claude-haiku-5-5",
  "gpt-6-luna",
  "gpt-6.1-sol",
] as const

export const INTERNAL_LISTING_AI_MODELS = ["claude-haiku-5-5", "gpt-6-luna", "gpt-6.1-sol"] as const

export type ListingAiModel = (typeof LISTING_AI_MODELS)[number]

export const DEFAULT_LISTING_AI_MODEL: ListingAiModel = "ZQ-Think-Flash"
