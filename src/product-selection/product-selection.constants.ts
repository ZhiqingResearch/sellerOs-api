import { SelectionAnalysisStepType } from "@prisma/client"

export const STEP_PAYLOAD_MAX_BYTES = 4 * 1024 * 1024
export const MAX_CATEGORY_COUNT = 50
export const MAX_RESULT_COUNT = 500
export const MAX_KEYWORD_COUNT = 50
export const MAX_ASIN_COUNT = 500
export const MAX_PICK_COUNT = 500

export const STEP_TYPE_BY_NO: Record<number, SelectionAnalysisStepType> = {
  1: SelectionAnalysisStepType.CATEGORY_DIAGNOSIS,
  2: SelectionAnalysisStepType.TRACK_VALIDATION,
  3: SelectionAnalysisStepType.COMPETITOR_POOL,
  4: SelectionAnalysisStepType.TRAFFIC_AD_VALIDATION,
  5: SelectionAnalysisStepType.PRODUCT_LIST,
}
