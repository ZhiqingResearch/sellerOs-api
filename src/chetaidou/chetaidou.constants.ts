// 车泰斗素材工作台 — 状态、限制、source 与幂等键约定
// 方案：docs/designs/2026-09-28-chetaidou-material-workbench-backend-implementation-plan.md §3/§8

export const CHETAIDOU_BUSINESS_TYPE = "CHETAIDOU" as const
export const IMAGE_CREATIVE_BUSINESS_TYPE = "IMAGE_CREATIVE" as const

export const CHETAIDOU_CALL_PREFIX = "chetaidou:call:" as const
export const CHETAIDOU_CHARGE_PREFIX = "chetaidou:charge:" as const

/** Task.type */
export type ChetaidouTaskType =
  | "BREAKDOWN"
  | "IDEATION"
  | "REFRESH_GROUP"
  | "DIVERGE"
  | "COMPOSE"
  | "GENERATE"

/** 非 GENERATE Task.status；GENERATE 不落 status，由 Job 投影 */
export type ChetaidouTaskStatus =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_RECONCILIATION"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED"

/** Group.status */
export type ChetaidouGroupStatus =
  | "PENDING"
  | "RUNNING"
  | "SETTLING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN"

/** CHETAIDOU ImageGenItem.status（沿用现有列，扩展细分值） */
export type ChetaidouItemStatus =
  | "QUEUED"
  | "RUNNING"
  | "SETTLING"
  | "DELIVERY_PENDING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN"

/** CHETAIDOU ImageGenJob.status（全成功沿用 COMPLETED，DTO 映射 SUCCEEDED） */
export type ChetaidouJobStatus =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_RECONCILIATION"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED"

/** Call.state */
export type ChetaidouCallState =
  | "PREPARED"
  | "SUBMITTING"
  | "WAITING"
  | "RECEIVED"
  | "UNKNOWN"
  | "FINISHED"

/** Call.outcome */
export type ChetaidouCallOutcome =
  | "ACCEPTED"
  | "INVALID"
  | "PROVIDER_FAILED"
  | "CANCELLED"
  | "DELIVERY_FAILED"

/** Call.billingStatus */
export type ChetaidouBillingStatus = "PENDING" | "SETTLED" | "FREE" | "REVIEW"

/** 收费 source（FeatureModule 注册表 key） */
export const CHETAIDOU_USAGE_SOURCES = {
  breakdown: "chetaidou.breakdown",
  ideation: "chetaidou.ideation",
  diverge: "chetaidou.diverge",
  compose: "chetaidou.compose",
  image: "chetaidou.image",
} as const

/** 站点 → locale（方案 §5.4，后端映射，前端不传任意 locale） */
export const CHETAIDOU_SITES: Record<string, string | null> = {
  original: null,
  amazon_us: "en-US",
  amazon_de: "de-DE",
  amazon_fr: "fr-FR",
  amazon_es: "es-ES",
  amazon_it: "it-IT",
  amazon_jp: "ja-JP",
}

export const CHETAIDOU_TEXT_MODES = ["keep", "hide", "translate", "show"] as const
export const CHETAIDOU_PERSON_MODES = ["keep", "replace"] as const
export const CHETAIDOU_GENERATE_COUNTS = [1, 2, 4, 8] as const
export const CHETAIDOU_IMAGE_QUALITIES = ["standard", "hd"] as const

// ── PRD 中的业务数量与文字限制（config 接口同源下发） ──────────────────
export const CHETAIDOU_MIN_DIMENSIONS = 10
export const CHETAIDOU_MAX_DIMENSIONS = 20
export const CHETAIDOU_MIN_OPTIONS_PER_GROUP = 30
export const CHETAIDOU_MAX_OPTIONS_PER_GROUP = 60
export const CHETAIDOU_MAX_CUSTOM_DIMENSIONS = 10
export const CHETAIDOU_MAX_CUSTOM_LABEL_LENGTH = 60
export const CHETAIDOU_MAX_CUSTOM_TEXT_LENGTH = 1000
export const CHETAIDOU_MAX_OPTIONS_PER_DIMENSION = 300

// ── 后台扫描 ─────────────────────────────────────────────────────────────
export const CHETAIDOU_SCAN_INTERVAL_MS = 5_000

// ── deadline（env 可调） ───────────────────────────────────────────────────
export function chetaidouTextDeadlineMs(): number {
  return Number(process.env.CHETAIDOU_TEXT_DEADLINE_MS) || 10 * 60_000
}
export function chetaidouImageDeadlineMs(): number {
  return Number(process.env.CHETAIDOU_IMAGE_DEADLINE_MS) || 15 * 60_000
}
export function chetaidouIdeationDeadlineMs(): number {
  return Number(process.env.CHETAIDOU_IDEATION_DEADLINE_MS) || 45 * 60_000
}

export function chetaidouRepairBudget(): number {
  // PRD：格式错误、超时和限流均不自动重试付费请求，旧环境变量不再生效。
  return 0
}
// ── 业务模型分类：具体 publicId 只维护在 AiGatewayModel 目录 ──────────────
export const CHETAIDOU_TEXT_CATEGORY = "CHETAIDOU_MULTIMODAL"
export const CHETAIDOU_BREAKDOWN_CATEGORY = "CHETAIDOU_BREAKDOWN"
export const CHETAIDOU_IMAGE_CATEGORY = "CHETAIDOU_IMAGE"

export function chetaidouEnabled(): boolean {
  return process.env.CHETAIDOU_ENABLED !== "false"
}

// ── 业务错误码（放响应 body 的 code 字段，经全局过滤器 code 透出） ──
export const CHETAIDOU_ERROR_CODES = {
  PERMISSION_DENIED: "PERMISSION_DENIED",
  INVALID_INPUT: "INVALID_INPUT",
  FILE_UNSUPPORTED: "FILE_UNSUPPORTED",
  SOURCE_VERSION_CHANGED: "SOURCE_VERSION_CHANGED",
  BREAKDOWN_UNCONFIRMED: "BREAKDOWN_UNCONFIRMED",
  FACT_CONFLICT: "FACT_CONFLICT",
  SETTINGS_CHANGED: "SETTINGS_CHANGED",
  MODEL_OUTPUT_INVALID: "MODEL_OUTPUT_INVALID",
  REQUIRED_DIMENSION_MISSING: "REQUIRED_DIMENSION_MISSING",
  NEEDS_RESOLUTION: "NEEDS_RESOLUTION",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  DIMENSION_CAPACITY_EXCEEDED: "DIMENSION_CAPACITY_EXCEEDED",
  MODEL_NOT_READY: "MODEL_NOT_READY",
  CALL_STATUS_UNKNOWN: "CALL_STATUS_UNKNOWN",
  BILLING_PENDING: "BILLING_PENDING",
  DELIVERY_PENDING: "DELIVERY_PENDING",
  DRAFT_CONFLICT: "DRAFT_CONFLICT",
} as const

export function chetaidouIdeationStatus(
  groups: { status: string }[]
): Exclude<ChetaidouTaskStatus, "QUEUED" | "CANCELLED"> {
  if (groups.some(g => ["PENDING", "RUNNING", "SETTLING"].includes(g.status))) return "RUNNING"
  if (groups.some(g => g.status === "UNKNOWN")) return "WAITING_RECONCILIATION"
  if (!groups.some(g => g.status === "FAILED")) return "SUCCEEDED"
  return groups.some(g => g.status === "SUCCEEDED") ? "PARTIAL" : "FAILED"
}

/** 取消与执行器共用批次聚合，取消全部排队位置后无需等待下一次扫描。 */
export function chetaidouImageJobStatus(items: { status: string }[]): string {
  if (items.some(i => ["QUEUED", "RUNNING"].includes(i.status))) return "RUNNING"
  if (items.some(i => ["UNKNOWN", "SETTLING", "DELIVERY_PENDING"].includes(i.status)))
    return "WAITING_RECONCILIATION"
  if (items.length && items.every(i => i.status === "SUCCEEDED")) return "COMPLETED"
  if (items.some(i => i.status === "SUCCEEDED")) return "PARTIAL"
  if (items.length && items.every(i => i.status === "CANCELLED")) return "CANCELLED"
  return "FAILED"
}
