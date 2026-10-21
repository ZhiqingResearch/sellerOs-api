export interface CompetitorEvidenceSource {
  provider: "sif" | "sellersprite" | "keepa"
  status: "used" | "not_configured" | "not_supported" | "failed" | "unavailable"
  label: string
  message?: string
  retryable?: boolean
}

export interface CompetitorEvidenceBundle {
  country: string
  asins: string[]
  collectedAt: string
  sif: Record<string, unknown>
  sellerSprite: Record<string, unknown> | null
  keepa: Record<string, unknown> | null
  sources: CompetitorEvidenceSource[]
  callDetail: Record<string, number>
}

export interface AiCompetitorAnalysis {
  summary: {
    insights: Array<Record<string, unknown>>
    rankings: Array<Record<string, unknown>>
  }
}

export interface AssembledCompetitorAnalysis {
  profiles: Array<Record<string, unknown>>
  trafficBoards: Array<Record<string, unknown>>
  pricePromoBoards: Array<Record<string, unknown>>
}

export interface CompetitorAnalysisResponse {
  snapshot: Record<string, unknown>
  tokenUsage: {
    promptTokens: number
    completionTokens: number
    thinkingTokens: number
  }
  gateway: {
    model: string
    requestId: string | null
  }
  billingHandled: true
}

export type CompetitorAnalysisModuleId = "profile" | "traffic" | "pricePromo"

export interface CompetitorAnalysisSummaryResponse {
  summary: AiCompetitorAnalysis["summary"]
  recordId: string
  tokenUsage: CompetitorAnalysisResponse["tokenUsage"]
  gateway: CompetitorAnalysisResponse["gateway"]
  billingHandled: true
}
