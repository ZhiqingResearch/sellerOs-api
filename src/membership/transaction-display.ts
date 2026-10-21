import { CreditBucket, CreditDirection, CreditTxnType, ScheduledPlanStatus } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { labelForSource } from "../usage/usage-source-labels"
import { CREDIT_PER_CNY } from "./membership.constants"

export interface TxnLike {
  type: CreditTxnType
  source: string | null
  meta: unknown
  amount?: Decimal | number | string | null
  bucket?: CreditBucket | null
  direction?: CreditDirection | null
  teamId?: number | null // 企业归属（池行）：企业池调整/企业归档清零的项目文案分流用
}

/** 充值状态：退款功能未上线，目前一律 COMPLETED（前端 COMPLETED→已完成 / REFUNDED→已退款）。 */
export type TxnStatus = "COMPLETED" | "REFUNDED"

export interface TxnDescription {
  category: string // 「类型」列：套餐订阅 / 充值包 / 自定义充值 / 赠送 / 手动调整 / 消费 …
  title: string // 「项目」列：具体的套餐 / 充值包 / 来源等详细文案
  amountCny: number | null // 「金额」列：充值金额（元）；无对应付款（赠送/调额/消费等）为 null
  status: TxnStatus // 「状态」列
}

function num(meta: Record<string, unknown>, key: string): number | null {
  const v = meta[key]
  return typeof v === "number" ? v : null
}

/** 充值类金额：优先取 meta.priceCny；老数据无该字段时，对「本金桶(RECHARGE)」按 积分÷10 反推（本金=元×10）。 */
function rechargeAmountCny(
  meta: Record<string, unknown>,
  type: CreditTxnType,
  amount: TxnLike["amount"],
  bucket: TxnLike["bucket"]
): number | null {
  const price = num(meta, "priceCny")
  if (price != null) return price
  if (
    (type === CreditTxnType.RECHARGE_CUSTOM || type === CreditTxnType.RECHARGE_PACK) &&
    bucket === CreditBucket.RECHARGE &&
    amount != null
  ) {
    const credits = new Decimal(amount.toString())
    if (credits.greaterThan(0)) {
      return credits.div(CREDIT_PER_CNY).toDecimalPlaces(2).toNumber()
    }
  }
  return null
}

/** 充值包/自定义的「（本金+赠送）」明细后缀；缺数据时返回空串。 */
function bonusSuffix(meta: Record<string, unknown>): string {
  const base = num(meta, "baseCredits")
  const bonus = num(meta, "bonusCredits")
  if (base == null) return ""
  return bonus && bonus > 0 ? `（${base}+赠${bonus}）` : `（${base}）`
}

/**
 * 流水展示派生：
 * - category「类型」、title「项目」、amountCny「充值金额(元)」、status「状态」。
 * 充值类金额取 meta.priceCny（充值接口写入；老数据回退按本金积分反推）。
 */
export function describeTransaction(txn: TxnLike): TxnDescription {
  const meta = (txn.meta ?? {}) as Record<string, unknown>
  const status: TxnStatus = "COMPLETED" // 退款未上线，统一已完成
  if (txn.source === "team.member.gift.transfer") {
    return {
      category: txn.type === CreditTxnType.TEAM_RECHARGE ? "企业池入账" : "手动调整",
      title: "个人赠送积分转入企业共享池",
      amountCny: null,
      status,
    }
  }
  switch (txn.type) {
    case CreditTxnType.RECHARGE_PLAN: {
      const tier = num(meta, "tier")
      const name = typeof meta.name === "string" ? meta.name : null
      const isUpgrade = meta.upgrade === true // 升级补差额：类型标「套餐升级」、项目加「（升级）」
      const isPersonalToTeam = meta.personalToTeam === true // 个人转企业：项目加「（个人订阅转团队订阅）」
      const base =
        tier != null && name
          ? `Lv.${tier} ${name} 月度套餐`
          : tier != null
            ? `Lv.${tier} 月度套餐`
            : name
              ? `${name} 月度套餐`
              : "会员套餐"
      const title = isUpgrade
        ? `${base}【套餐升级】`
        : isPersonalToTeam
          ? `${base}（个人订阅转团队订阅）`
          : base
      return {
        category: isUpgrade ? "套餐升级" : "套餐订阅",
        title,
        amountCny: rechargeAmountCny(meta, txn.type, txn.amount, txn.bucket),
        status,
      }
    }
    case CreditTxnType.RECHARGE_PACK: {
      const price = rechargeAmountCny(meta, txn.type, txn.amount, txn.bucket)
      const title = price != null ? `¥${price} 充值包${bonusSuffix(meta)}` : "充值包"
      return {
        category: "充值包",
        title,
        amountCny: price,
        status,
      }
    }
    case CreditTxnType.RECHARGE_CUSTOM: {
      const price = rechargeAmountCny(meta, txn.type, txn.amount, txn.bucket)
      const title = price != null ? `¥${price} 自定义充值${bonusSuffix(meta)}` : "自定义充值"
      return {
        category: "自定义充值",
        title,
        amountCny: price,
        status,
      }
    }
    case CreditTxnType.SIGNUP_BONUS: {
      const title =
        txn.source && txn.source.includes("invite") ? "邀请注册赠送积分" : "注册赠送积分"
      return { category: "注册赠送", title, amountCny: null, status }
    }
    case CreditTxnType.MANUAL_ADJUST:
      // 客服补偿（个人订阅调整/延长有效期）：meta.compensation 标记。
      // 正向（发赠送/延长有效期）= 赠送/后台积分发放；负向扣回（DEBIT 或 meta.giftCredits<0）= 手动调整/后台积分扣减
      if (meta.compensation === true) {
        const isDeduct =
          txn.direction === CreditDirection.DEBIT ||
          (typeof meta.giftCredits === "number" && meta.giftCredits < 0)
        return isDeduct
          ? { category: "手动调整", title: "后台积分扣减", amountCny: null, status }
          : { category: "赠送", title: "后台积分发放", amountCny: null, status }
      }
      // 个人转企业（packChoice=inject）：个人充值积分整额转入企业共享池的扣减行（meta.injectToTeamId=目标企业）
      if (typeof meta.injectToTeamId === "number") {
        return {
          category: "手动调整",
          title: "个人充值积分转入企业共享池",
          amountCny: null, // 余额搬家不是付款，不开收据
          status,
        }
      }
      // 个人转企业抵扣超出企业价的差额返还：类型仍「手动调整」，项目列给具体文案（金额/积分明细在 meta）
      if (txn.source === "billing.p2t.refund") {
        return {
          category: "手动调整",
          title: "个人套餐转企业套餐差额返还",
          amountCny: null, // 非付款行不开收据；超出金额 refundCny / 返还积分 refundCredits 在 meta
          status,
        }
      }
      // 企业池调整（平台侧调整池充值积分）：项目列给明确文案，与筛选项 label 一致
      if (txn.teamId != null) {
        return {
          category: "手动调整",
          title: "企业池调整",
          amountCny: null,
          status,
        }
      }
      // 项目列固定为操作名「手动调整」；用户填写的备注在 meta.reason，前端按需单列「备注」列展示
      return {
        category: "手动调整",
        title: "手动调整",
        amountCny: null,
        status,
      }
    case CreditTxnType.CONSUME:
      return {
        category: "消费",
        title: labelForSource(txn.source),
        amountCny: null,
        status,
      }
    case CreditTxnType.EXPIRE:
      // 企业归档清理（team.archive）与日常到期清零区分，与筛选项 label 一致
      if (txn.source === "team.archive") {
        return {
          category: "清零",
          title: "企业归档积分清零",
          amountCny: null,
          status,
        }
      }
      return {
        category: "清零",
        title: "套餐积分清零",
        amountCny: null,
        status,
      }
    case CreditTxnType.REBATE_IN:
      return { category: "返利", title: "邀请返利", amountCny: null, status }
    case CreditTxnType.REBATE_WITHDRAW:
      return { category: "提现", title: "返利提现", amountCny: null, status }
    case CreditTxnType.TEAM_RECHARGE: {
      // 企业共享池非付款入账（挂 teamId，记在企业管理员 userId 下；属团队资产不是个人余额）：
      // 仅余两类——平台定制开通（admin.team.custom）、个人余额注入共享池（injectedFromPersonal）。
      // 团队付款链路（新购/续费/升级/充值包/自定义）已重归类 RECHARGE_PLAN/PACK/CUSTOM。
      const title =
        meta.p2tRefund === true
          ? "个人转企业超额折抵返还·企业共享池"
          : meta.injectedFromPersonal === true
            ? "个人余额注入·企业共享池"
            : txn.source === "admin.team.custom"
              ? "平台定制开通·企业共享池"
              : "企业共享池入账"
      return { category: "企业池入账", title, amountCny: num(meta, "priceCny"), status }
    }
    case CreditTxnType.TEAM_ARCHIVE_RETURN:
      // 企业归档时充值池余额退回管理员个人户
      return { category: "企业池退回", title: "企业归档退回·充值池积分", amountCny: null, status }
    default:
      return {
        category: "其他",
        title: txn.source ?? "积分变动",
        amountCny: null,
        status,
      }
  }
}

/** 充值记录生命周期标识（待生效 / 已过期），供前端打徽标。 */
export interface TxnLifecycle {
  scheduled: boolean // 待生效：排队续费，尚未激活到账
  expired: boolean // 已过期：套餐/注册赠送积分到期清零
  effectiveAt: string | null // 待生效时的生效时刻（scheduled=false 时为 null）
}

/** 从一批流水的 meta 收集需查状态的 ScheduledPlan id（仅带 scheduled 标记且有 planId 的续费记录）。 */
export function collectScheduledPlanIds(rows: { meta: unknown }[]): number[] {
  return rows
    .map(r => {
      const m = (r.meta ?? {}) as Record<string, unknown>
      return m.scheduled === true && typeof m.scheduledPlanId === "number"
        ? m.scheduledPlanId
        : null
    })
    .filter((x): x is number => x != null)
}

/**
 * 读时推导单条充值记录的生命周期（不改库）：
 * - scheduled：meta.scheduled 且关联 ScheduledPlan 仍 PENDING（无 planId 的退化为按 activateAt 是否到期）
 * - expired：非待生效，且 meta.expiresAt（套餐/注册赠送写入的到期时刻）已过
 * - effectiveAt：待生效时的 activateAt
 * planStatus：scheduledPlanId → 状态映射，由调用方批量查好传入。
 */
export function deriveLifecycle(
  txn: { meta: unknown },
  planStatus: Map<number, ScheduledPlanStatus>,
  now: Date
): TxnLifecycle {
  const meta = (txn.meta ?? {}) as Record<string, unknown>
  const planId = typeof meta.scheduledPlanId === "number" ? meta.scheduledPlanId : null
  let scheduled = false
  if (meta.scheduled === true) {
    scheduled =
      planId != null
        ? planStatus.get(planId) === ScheduledPlanStatus.PENDING
        : typeof meta.activateAt === "string" && new Date(meta.activateAt) > now
  }
  const expiresAt = typeof meta.expiresAt === "string" ? meta.expiresAt : null
  const expired = !scheduled && expiresAt != null && new Date(expiresAt) < now
  const effectiveAt = scheduled && typeof meta.activateAt === "string" ? meta.activateAt : null
  return { scheduled, expired, effectiveAt }
}
