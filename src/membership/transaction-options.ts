import { CreditBucket, CreditDirection, CreditTxnType, InvokeType, Prisma } from "@prisma/client"

/** 筛选下拉项：value 为空串表示「全部」(不带该筛选参数)。 */
export interface FilterOption<T extends string = string> {
  value: "" | T
  label: string
}

/**
 * 充值记录「类型」筛选伪值「赠送」（不占 CreditTxnType 枚举）：
 * = MANUAL_ADJUST + meta.compensation=true + CREDIT（后台个人订阅调整的正向发放/延长有效期）。
 * 2026-08-28 起「手动调整」与「赠送」筛选拆分——选手动调整不再混入赠送行。
 */
export const GIFT_COMPENSATE_FILTER = "GIFT_COMPENSATE"
export type RechargeTypeFilter = CreditTxnType | typeof GIFT_COMPENSATE_FILTER

/** 正向客服补偿的判定片段（发放/延长有效期行；负向扣回 direction=DEBIT 不在此列）。
 * MySQL 的 Prisma JSON path 是字符串形式（'$.key'，不是 Postgres 的数组形式）。 */
const COMPENSATION_CREDIT: Prisma.CreditTransactionWhereInput = {
  direction: CreditDirection.CREDIT,
  meta: { path: "$.compensation", equals: true },
}

/** 充值记录「类型」筛选 → where 片段：MANUAL_ADJUST 拆分 手动调整（排除正向补偿）/ 赠送（仅正向补偿）；其余类型原样透传 */
export function rechargeTypeFilterWhere(type: string): Prisma.CreditTransactionWhereInput {
  if (type === GIFT_COMPENSATE_FILTER) {
    return { type: CreditTxnType.MANUAL_ADJUST, ...COMPENSATION_CREDIT }
  }
  if (type === CreditTxnType.MANUAL_ADJUST) {
    return { type: CreditTxnType.MANUAL_ADJUST, NOT: COMPENSATION_CREDIT }
  }
  return { type: type as CreditTxnType }
}

/**
 * 积分明细「扣费来源(积分桶)」筛选项（对应 GET /api/membership/transactions 的 bucket 参数）。
 * REBATE(返利)桶不可消费、独立核算，不纳入该筛选。前后端唯一约定，前端不再硬编码。
 */
export const TRANSACTION_BUCKET_OPTIONS: FilterOption<CreditBucket>[] = [
  { value: "", label: "全部" },
  { value: CreditBucket.RECHARGE, label: "充值积分" },
  { value: CreditBucket.PACKAGE, label: "套餐积分" },
  { value: CreditBucket.GIFT, label: "赠送积分" },
]

/**
 * 充值记录「类型」筛选项（对应 GET /api/membership/transactions 的 type 参数，CREDIT 方向）。
 * 标签与积分明细「类型」列(transaction-display 的 category)同源同义。前端不再硬编码。
 * 「赠送」是伪值 GIFT_COMPENSATE（MANUAL_ADJUST 里的正向补偿发放），与「手动调整」互斥拆分。
 */
export const RECHARGE_TYPE_OPTIONS: FilterOption<RechargeTypeFilter>[] = [
  { value: "", label: "全部" },
  { value: CreditTxnType.RECHARGE_PLAN, label: "套餐订阅" },
  { value: CreditTxnType.RECHARGE_PACK, label: "充值包" },
  { value: CreditTxnType.RECHARGE_CUSTOM, label: "自定义充值" },
  { value: CreditTxnType.SIGNUP_BONUS, label: "注册赠送" },
  { value: GIFT_COMPENSATE_FILTER, label: "赠送" },
  { value: CreditTxnType.MANUAL_ADJUST, label: "手动调整" },
  { value: CreditTxnType.TEAM_RECHARGE, label: "企业池入账" },
  { value: CreditTxnType.TEAM_ARCHIVE_RETURN, label: "企业池退回" },
]

/**
 * 积分明细「积分归属」筛选项（对应 GET /api/membership/transactions 的 ownership 参数）：
 * 个人=个人批次（teamId 空）/ 企业=企业共享池批次（teamId 有值）。前后端唯一约定，前端不再硬编码。
 */
export type TransactionOwnership = "PERSONAL" | "TEAM"

export const TRANSACTION_OWNERSHIP_OPTIONS: FilterOption<TransactionOwnership>[] = [
  { value: "", label: "全部" },
  { value: "PERSONAL", label: "个人" },
  { value: "TEAM", label: "企业" },
]

/**
 * 混合扣费事件章（企业成员消费：个人赠送层 → 企业池 → 个人充值，一笔消费可能同时动个人与企业池）。
 * 仅「个人与企业都扣」的混合事件才在流水 meta 盖章；纯单归属事件由 teamId 天然区分、读取侧直接推导。
 */
export interface OwnershipSplitMeta {
  personal: string // 事件个人侧合计扣减（赠送层+充值层）
  team: string // 事件企业池合计扣减
  personalBalanceAfter: string // 事件后个人可消费净额
  teamBalanceAfter: string // 事件后企业池净额
}

/**
 * 「扣费来源」细分（对应 transactions 的 consumeSource 参数）：个人三桶 / 邀请人两桶 / 企业池三桶，
 * 与列表「扣费来源」列（classifyConsumeSource 打标）同一枚举，保证筛选项与列表展示值一一对应。
 * 企业行（teamId 有值）的 TEAM_CONSUME/池调整扣减同样打标，企业成员与管理员均可按企业桶筛选。
 * 所有用户一致下发，不区分等级（无对应流水的用户筛选自然为空，不裁剪）。
 */
export type ConsumeSource =
  | "OWN_PACKAGE"
  | "OWN_RECHARGE"
  | "OWN_GIFT"
  | "INVITER_GIFT"
  | "INVITER_RECHARGE"
  | "TEAM_PACKAGE"
  | "TEAM_RECHARGE"
  | "TEAM_GIFT"

export const CONSUME_SOURCE_OPTIONS: FilterOption<ConsumeSource>[] = [
  { value: "", label: "全部" },
  { value: "OWN_PACKAGE", label: "个人套餐积分" },
  { value: "OWN_RECHARGE", label: "个人充值积分" },
  { value: "OWN_GIFT", label: "个人赠送积分" },
  { value: "INVITER_GIFT", label: "邀请人赠送积分" },
  { value: "INVITER_RECHARGE", label: "邀请人充值积分" },
  { value: "TEAM_PACKAGE", label: "企业套餐积分" },
  { value: "TEAM_RECHARGE", label: "企业充值积分" },
  { value: "TEAM_GIFT", label: "企业赠送积分" },
]

export const CONSUME_SOURCE_LABEL: Record<ConsumeSource, string> = {
  OWN_PACKAGE: "个人套餐积分",
  OWN_RECHARGE: "个人充值积分",
  OWN_GIFT: "个人赠送积分",
  INVITER_GIFT: "邀请人赠送积分",
  INVITER_RECHARGE: "邀请人充值积分",
  TEAM_PACKAGE: "企业套餐积分",
  TEAM_RECHARGE: "企业充值积分",
  TEAM_GIFT: "企业赠送积分",
}

/**
 * 积分明细「调用方式」筛选项（对应 transactions 的 invokeType 参数，CreditTransaction.invokeType 列）：
 * PLATFORM=平台使用（默认）/ API=开放平台服务间扣费（/api/open/credit/* 与 KeyB 入口）。
 * 前后端唯一约定，前端不再硬编码。
 */
export const INVOKE_TYPE_OPTIONS: FilterOption<InvokeType>[] = [
  { value: "", label: "全部" },
  { value: InvokeType.PLATFORM, label: "平台使用" },
  { value: InvokeType.API, label: "API 调用" },
]

export const INVOKE_TYPE_LABEL: Record<InvokeType, string> = {
  PLATFORM: "平台使用",
  API: "API 调用",
}

/**
 * 单条「扣费行」的扣费来源归类：fromInviter=该行扣的是邀请人的池子；teamId=企业归属（池行）。
 * - TEAM_CONSUME（企业池消费）：按 bucket 归 TEAM_*（混合扣费事件的企业段行同样是 TEAM_CONSUME 逐桶行）。
 * - MANUAL_ADJUST 调减(DEBIT)：企业侧（池调整扣减，仅动 RECHARGE）→ TEAM_RECHARGE；
 *   个人侧 bucket=RECHARGE → OWN_RECHARGE（如个人充值转入企业池的转出行）；
 *   bucket=GIFT → OWN_GIFT（成员赠送转入企业）；bucket=null → 客服补偿扣回 → OWN_PACKAGE；调增归 null。
 * - CONSUME：按 (是否邀请人池, bucket) 归个人/邀请人 5 类。
 * 其余类型（充值/赠送/清零/返利等）非扣费行，返回 null。
 */
export function classifyConsumeSource(
  type: CreditTxnType,
  bucket: CreditBucket | null,
  fromInviter: boolean,
  direction: CreditDirection,
  teamId: number | null = null
): ConsumeSource | null {
  if (type === CreditTxnType.MANUAL_ADJUST) {
    if (direction !== CreditDirection.DEBIT) return null
    if (teamId != null) return "TEAM_RECHARGE" // 池调整扣减只动 RECHARGE（adjustPoolRecharge）
    if (bucket === CreditBucket.GIFT) return "OWN_GIFT"
    return bucket === CreditBucket.RECHARGE ? "OWN_RECHARGE" : "OWN_PACKAGE"
  }
  if (type === CreditTxnType.TEAM_CONSUME) {
    if (bucket === CreditBucket.PACKAGE) return "TEAM_PACKAGE"
    if (bucket === CreditBucket.RECHARGE) return "TEAM_RECHARGE"
    if (bucket === CreditBucket.GIFT) return "TEAM_GIFT"
    return null
  }
  if (type !== CreditTxnType.CONSUME) return null
  if (fromInviter) {
    if (bucket === CreditBucket.RECHARGE) return "INVITER_RECHARGE"
    if (bucket === CreditBucket.PACKAGE || bucket === CreditBucket.GIFT) return "INVITER_GIFT"
    return null
  }
  if (bucket === CreditBucket.PACKAGE) return "OWN_PACKAGE"
  if (bucket === CreditBucket.RECHARGE) return "OWN_RECHARGE"
  if (bucket === CreditBucket.GIFT) return "OWN_GIFT"
  return null
}
