export type ModerationMediaType = "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT"

export interface ModerationInput {
  key: string
  type: ModerationMediaType
  content?: string
  url?: string
  documentType?: string
  detectMime?: boolean
}

export interface ModerationLabel {
  code: string
  name: string | null
}

export interface ModerationDimension {
  type: string | null
  level: string | null
  suggestion: string | null
  labels: ModerationLabel[]
}

export interface ModerationResult {
  suggestion: string | null
  riskLevel: string | null
  dimensions: ModerationDimension[]
}

export interface ModerationReceipt {
  taskId: string
  requestId: string | null
  region: string
  service: string
}

export type ModerationDecision = "PASSED" | "REJECTED" | "UNDETERMINED"

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function field(value: unknown, name: string): unknown {
  const object = record(value)
  return object[name] ?? object[name[0].toLowerCase() + name.slice(1)]
}

export function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}
