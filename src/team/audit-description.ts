/**
 * 审计日志读时文案装配：列表接口在返回前给每行补 actorName + description，
 * 前端直接渲染，不再逐字段翻译 meta。新增 action 只需在此补一个分支。
 */
import { TeamAuditAction } from "./team.constants"

type Meta = Record<string, unknown>

const num = (m: Meta, k: string): number | null => (typeof m[k] === "number" ? m[k] : null)
const str = (m: Meta, k: string): string | null => (typeof m[k] === "string" ? m[k] : null)

/** 月度上限展示：null = 不限 */
const quotaText = (v: number | null): string => (v == null ? "不限" : String(v))

/**
 * 拼一条中文操作描述。
 * nameOf：userId → 用户名（列表页批量解析后传入；解析不到返回 null，文案退化为「成员」）。
 */
export function describeAuditLog(
  action: string,
  meta: unknown,
  nameOf: (userId: number | null) => string | null
): string {
  const m = (meta ?? {}) as Meta
  const subject = nameOf(num(m, "memberUserId") ?? num(m, "userId")) ?? "成员"
  switch (action) {
    case TeamAuditAction.TEAM_CREATE: {
      const name = str(m, "name")
      if (m.source === "CUSTOM" || name) return `创建企业团队「${name ?? "未命名"}」（平台定制）`
      return "创建企业团队（自助购买）"
    }
    case TeamAuditAction.TEAM_UPDATE:
      return "修改团队信息"
    case TeamAuditAction.TEAM_ADJUST: {
      const parts: string[] = []
      const delta = num(m, "rechargeCreditsDelta")
      const extend = num(m, "extendDays")
      if (delta != null) parts.push(`充值积分 ${delta > 0 ? "+" : ""}${delta}`)
      if (extend != null) parts.push(`有效期延长 ${extend} 天`)
      return parts.length ? `平台调整：${parts.join("，")}` : "平台调整"
    }
    case TeamAuditAction.TEAM_DISABLE:
      return "停用团队"
    case TeamAuditAction.TEAM_ENABLE:
      return "启用团队"
    case TeamAuditAction.TEAM_RESTORE:
      return "续费恢复团队（重新生效）"
    case TeamAuditAction.TEAM_RENEW:
      return m.scheduledPlanId != null ? "排队续费到期激活" : "团队续费"
    case TeamAuditAction.TEAM_SEAT_UPGRADE: {
      const from = num(m, "fromTier")
      const to = num(m, "toTier")
      const seats = num(m, "seats")
      return `席位档升级${from != null && to != null ? ` Lv.${from} → Lv.${to}` : ""}${seats != null ? `（${seats} 席位）` : ""}`
    }
    case TeamAuditAction.POOL_RECHARGE: {
      const recharge = num(m, "rechargeCredits")
      const bonus = num(m, "bonusCredits")
      return recharge != null
        ? `共享池充值：充值积分 +${recharge}${bonus ? `，赠送 +${bonus}` : ""}`
        : "共享池充值"
    }
    case TeamAuditAction.TEAM_GRACE:
      return "团队到期，进入宽限期"
    case TeamAuditAction.TEAM_ARCHIVE: {
      const returned = str(m, "returnedToAdmin")
      return returned && returned !== "0"
        ? `团队归档，充值池 ${returned} 积分退回管理员个人户`
        : "团队归档"
    }
    case TeamAuditAction.MEMBER_ADD: {
      const created = m.created === true
      return `添加成员「${subject}」加入团队${created ? "（并开通新账号）" : ""}`
    }
    case TeamAuditAction.MEMBER_REMOVE:
      return `移除成员「${subject}」`
    case TeamAuditAction.MEMBER_ROLE:
      return m.role === "ADMIN" ? `将「${subject}」设为管理员` : `将「${subject}」调整为成员`
    case TeamAuditAction.MEMBER_STATUS:
      return m.status === "DISABLED" ? `停用成员「${subject}」` : `启用成员「${subject}」`
    case TeamAuditAction.QUOTA_UPDATE: {
      const before = num(m, "monthlyQuotaBefore")
      const after = num(m, "monthlyQuota")
      return before != null
        ? `将「${subject}」月度上限由 ${quotaText(before)} 调整为 ${quotaText(after)}`
        : `将「${subject}」月度上限调整为 ${quotaText(after)}`
    }
    case TeamAuditAction.QUOTA_BATCH: {
      const quota = num(m, "monthlyQuota")
      const affected = num(m, "affected")
      return `批量设置成员月度上限为 ${quotaText(quota)}${affected != null ? `（${affected} 人）` : ""}`
    }
    case TeamAuditAction.SETTINGS_UPDATE: {
      const from = (m.from ?? {}) as Meta
      const to = (m.to ?? {}) as Meta
      const fromName = typeof from.name === "string" ? from.name : null
      const toName = typeof to.name === "string" ? to.name : null
      if (fromName !== toName && toName)
        return `团队名称由「${fromName ?? "未命名"}」改为「${toName}」`
      return "修改团队设置"
    }
    case TeamAuditAction.MODEL_DEFAULT:
      return "设置默认模型"
    case TeamAuditAction.MODEL_CONFIG:
      return "保存模型配置"
    default:
      return action
  }
}

/** 从一条审计 meta 里收集需要解析用户名的 userId（主体/相关人）。 */
export function collectAuditUserIds(meta: unknown): number[] {
  const m = (meta ?? {}) as Meta
  return [num(m, "memberUserId"), num(m, "userId"), num(m, "previousAdminId")].filter(
    (x): x is number => x != null
  )
}
