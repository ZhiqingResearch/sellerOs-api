import type { AiSplitReferenceSource, AiSplitSite, AiSplitTextAmount } from "./ai-split.dto"

export const AI_SPLIT_ANALYSIS_MODEL_CATEGORY = "AI_SPLIT_MULTIMODAL"
export const AI_SPLIT_IMAGE_MODEL_CATEGORY = "AI_SPLIT"

export const AI_SPLIT_STAGES = {
  QUEUED: "QUEUED",
  COMPETITOR_ANALYZING: "COMPETITOR_ANALYZING",
  COMPETITOR_BILLING: "COMPETITOR_BILLING",
  PRODUCT_PLANNING: "PRODUCT_PLANNING",
  PRODUCT_ANALYZING: "PRODUCT_ANALYZING",
  PRODUCT_BILLING: "PRODUCT_BILLING",
  IMAGE_SUBMITTING: "IMAGE_SUBMITTING",
  IMAGE_GENERATING: "IMAGE_GENERATING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "CANCELLED",
} as const

export type AiSplitStage = (typeof AI_SPLIT_STAGES)[keyof typeof AI_SPLIT_STAGES]

export interface AiSplitAnalysisModelSnapshot {
  id: number
  publicId: string
  displayName: string
  gatewayConfig: unknown
}

export interface AiSplitInputReferenceSnapshot {
  sourceType: AiSplitReferenceSource
  sourceId?: number
  url: string
}

export type AiSplitReferenceSnapshot =
  | AiSplitInputReferenceSnapshot
  | { sourceType: "TEMPLATE"; sourceId: number }

export interface AiSplitProductImageSnapshot {
  id: number
  index: number
  url: string
  purpose: string
  description: string | null
}

export interface AiSplitGenerationSettings {
  site: AiSplitSite
  /** 商品资料本地化取值 locale（国家码动态推导，查不到回落 en-US） */
  locale: string
  /** 图上文案语言显式标签（如 "Spanish (es-MX)"，查不到回落 "English (en-US)"）。
   *  旧快照可能缺省——运行期一律按 site 现解析，不信任存量值。 */
  language?: string
  textAmount: AiSplitTextAmount
  model: string
  quantity: number
  modelParams: Record<string, unknown>
  supportsNegativePrompt: boolean
}

export interface AiSplitGatewayCalls {
  workflow1RequestId?: string
  workflow1Billed?: boolean
  workflow1Error?: string
  workflow2RequestId?: string
  workflow2Billed?: boolean
  workflow2Error?: string
}

export interface AiSplitPromptSnapshot {
  schemaVersion: "ai-split.v1"
  analysisModel: AiSplitAnalysisModelSnapshot
  reference: AiSplitReferenceSnapshot
  currentProduct: Record<string, unknown>
  currentProductKeys: string[]
  productImages: AiSplitProductImageSnapshot[]
  competitorTemplate?: Record<string, unknown>
  generationPlan?: Record<string, unknown>
  generationSettings: AiSplitGenerationSettings
  promptVersions: {
    competitorAnalysis: "v3"
    competitorAnalysisHash: string
    productImageGeneration: "v4"
    productImageGenerationHash: string
  }
  gatewayCalls: AiSplitGatewayCalls
}

export function readAiSplitSnapshot(value: unknown): AiSplitPromptSnapshot {
  if (!isRecord(value) || value.schemaVersion !== "ai-split.v1") {
    throw new Error("AI 拆图任务快照格式无效")
  }
  if (!isRecord(value.analysisModel) || typeof value.analysisModel.publicId !== "string") {
    throw new Error("AI 拆图任务缺少分析模型快照")
  }
  if (
    !isRecord(value.reference) ||
    (value.reference.sourceType === "TEMPLATE"
      ? typeof value.reference.sourceId !== "number"
      : typeof value.reference.url !== "string")
  ) {
    throw new Error("AI 拆图任务缺少竞品图快照")
  }
  if (!isRecord(value.currentProduct) || !Array.isArray(value.currentProductKeys)) {
    throw new Error("AI 拆图任务缺少商品快照")
  }
  if (!Array.isArray(value.productImages) || !isRecord(value.generationSettings)) {
    throw new Error("AI 拆图任务缺少生图配置快照")
  }
  if (!isRecord(value.gatewayCalls)) value.gatewayCalls = {}
  return value as unknown as AiSplitPromptSnapshot
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
