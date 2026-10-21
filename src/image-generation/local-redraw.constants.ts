export const LOCAL_REDRAW_CATEGORY = "LOCAL_REDRAW"
export const LOCAL_REDRAW_MODEL = "ZQ-Image-2"

export type LocalRedrawPlan = {
  provider: string
  sourceWidth: number
  sourceHeight: number
  generationWidth: number
  generationHeight: number
  resolutionTier?: "1K" | "2K" | "4K"
  providerApplied?: { aspect_ratio: string; resolution: string; quality?: string }
}
