/** 新任务执行参数；旧任务按冻结版本使用旧规则。数量范围不设业务档位上限。 */
export interface CountRange {
  min: number
  max: number
}

export interface ExecutionSettings {
  model?: string
  dimensionCountRange?: CountRange
  optionCountRange?: CountRange
}

export const IDEATION_BATCH_VERSION = "ideation-batch-v1"
export const IDEATION_BATCH_SIZE = 3
export const LEGACY_DIMENSION_RANGE: CountRange = { min: 10, max: 20 }
export const LEGACY_OPTION_RANGE: CountRange = { min: 30, max: 60 }

export function contentSettingsOf<T extends ExecutionSettings>(settings: T) {
  const { model, dimensionCountRange, optionCountRange, ...content } = settings
  void model
  void dimensionCountRange
  void optionCountRange
  return content
}

export function dimensionRangeOf(settings: ExecutionSettings): CountRange {
  return settings.dimensionCountRange ?? LEGACY_DIMENSION_RANGE
}

export function optionRangeOf(settings: ExecutionSettings): CountRange {
  return settings.optionCountRange ?? LEGACY_OPTION_RANGE
}

export function validCountRange(value: unknown): value is CountRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const range = value as CountRange
  return (
    Number.isSafeInteger(range.min) &&
    Number.isSafeInteger(range.max) &&
    range.min >= 0 &&
    range.max >= range.min
  )
}
