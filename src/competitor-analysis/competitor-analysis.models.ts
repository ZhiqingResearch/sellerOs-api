export const COMPETITOR_ANALYSIS_MODELS = [
  "ZQ-Think-Flash",
  "ZQ-Think-Lite",
  "ZQ-Think-Pro",
] as const

export type CompetitorAnalysisModel = (typeof COMPETITOR_ANALYSIS_MODELS)[number]

export const DEFAULT_COMPETITOR_ANALYSIS_MODEL: CompetitorAnalysisModel = "ZQ-Think-Flash"
