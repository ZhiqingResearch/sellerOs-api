import { beijingMonthKey } from "../common/utils/datetime"
import { DAY_MS } from "../membership/membership.constants"

/** 团队版宽限期天数（到期后池冻结但不清零） */
export const TEAM_GRACE_DAYS = 30

/** 团队版数据保留天数（到期后 60 天，仅记录 dataKeepUntil） */
export const TEAM_DATA_KEEP_DAYS = 60

/** 宽限截止快照 = 到期日 + 30 天（建团队/续费恢复时落库） */
export function graceUntilOf(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() + TEAM_GRACE_DAYS * DAY_MS)
}

/** 数据保留截止 = 到期日 + 60 天 */
export function dataKeepUntilOf(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() + TEAM_DATA_KEEP_DAYS * DAY_MS)
}

/** 配额月份标记（懒重置用，格式 "2026-08"，按北京自然月，与钱包「本月已用」同口径） */
export function quotaMonthOf(date = new Date()): string {
  return beijingMonthKey(date)
}

/** TeamMember.status 取值（schema 为自由 String，这里收敛口径） */
export const TeamMemberStatus = {
  ACTIVE: "ACTIVE",
  DISABLED: "DISABLED",
  ARCHIVED: "ARCHIVED",
} as const
export type TeamMemberStatusValue = (typeof TeamMemberStatus)[keyof typeof TeamMemberStatus]

/** TeamAuditLog.action 取值（所有管理动作写审计） */
export const TeamAuditAction = {
  TEAM_CREATE: "TEAM_CREATE",
  TEAM_UPDATE: "TEAM_UPDATE",
  TEAM_ADJUST: "TEAM_ADJUST",
  TEAM_DISABLE: "TEAM_DISABLE",
  TEAM_ENABLE: "TEAM_ENABLE",
  TEAM_RESTORE: "TEAM_RESTORE",
  TEAM_RENEW: "TEAM_RENEW",
  TEAM_SEAT_UPGRADE: "TEAM_SEAT_UPGRADE",
  POOL_RECHARGE: "POOL_RECHARGE",
  TEAM_GRACE: "TEAM_GRACE",
  TEAM_ARCHIVE: "TEAM_ARCHIVE",
  MEMBER_ADD: "MEMBER_ADD",
  MEMBER_REMOVE: "MEMBER_REMOVE",
  MEMBER_ROLE: "MEMBER_ROLE",
  MEMBER_STATUS: "MEMBER_STATUS",
  QUOTA_UPDATE: "QUOTA_UPDATE",
  QUOTA_BATCH: "QUOTA_BATCH",
  SETTINGS_UPDATE: "SETTINGS_UPDATE",
  MODEL_DEFAULT: "MODEL_DEFAULT",
  MODEL_CONFIG: "MODEL_CONFIG",
} as const
export type TeamAuditActionValue = (typeof TeamAuditAction)[keyof typeof TeamAuditAction]

/**
 * 模型配置-功能模块注册表（产品确认的一级菜单口径，代码常量，不建表）。
 * kind 约束该模块可选的模型类型（AiModel.kind）；批量保存时 payload 必须恰好覆盖全部 moduleKey。
 */
export const TEAM_MODEL_MODULES = [
  { moduleKey: "selection", label: "选品台", kind: "TEXT" },
  { moduleKey: "listing", label: "Listing", kind: "TEXT" },
  { moduleKey: "competitor", label: "竞品分析", kind: "TEXT" },
  { moduleKey: "asin_audit", label: "ASIN 审计", kind: "TEXT" },
  { moduleKey: "pricing", label: "智能定价", kind: "TEXT" },
  { moduleKey: "launch_plan", label: "新品推广计划", kind: "TEXT" },
  { moduleKey: "ad_opt", label: "广告优化建议", kind: "TEXT" },
  { moduleKey: "img", label: "AI 生图", kind: "IMAGE" },
  { moduleKey: "video", label: "AI 生视频", kind: "VIDEO" },
] as const
export type TeamModelModuleDef = (typeof TEAM_MODEL_MODULES)[number]

/** 生命周期定时任务的系统操作者标识（TeamAuditLog.actorId 无外键，0=系统） */
export const SYSTEM_ACTOR_ID = 0
