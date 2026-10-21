import { CreditBucket, MembershipLevel } from "@prisma/client"

/** 汇率：1 元 = 10 积分（HTML base = amt*10） */
export const CREDIT_PER_CNY = 10

/** 套餐 / 赠送积分的过期天数（PACKAGE 与 GIFT 同口径） */
export const PACKAGE_EXPIRE_DAYS = 30

export const DAY_MS = 24 * 60 * 60 * 1000

/** 新注册赠送的体验积分（进 GIFT 桶，注册起 30 天过期，与套餐/充值赠送同口径） */
export const SIGNUP_BONUS_CREDITS = 200

/** 注册赠送 200 的过期时点：注册（发放）时间 + PACKAGE_EXPIRE_DAYS 天，与套餐赠送一致 */
export function signupBonusExpiresAt(from: Date): Date {
  return new Date(from.getTime() + PACKAGE_EXPIRE_DAYS * DAY_MS)
}

/** 邀请码有效期（小时），7 天 */
export const INVITE_CODE_TTL_HOURS = 24 * 7

/** 返利默认比例 */
export const DEFAULT_REBATE_RATE = 0.3

/** 二级返利全局默认比例（User.level2RebateRate 为 null 时用） */
export const DEFAULT_LEVEL2_REBATE_RATE = 0.1

/**
 * 自定义充值赠送档（金额区间 → 赠送比例）。
 * 本金进 RECHARGE（永不过期），赠送进 GIFT（30 天过期）。
 */
export const CUSTOM_RECHARGE_TIERS: { min: number; max: number; bonusRate: number }[] = [
  { min: 1, max: 99, bonusRate: 0 },
  { min: 100, max: 499, bonusRate: 0.1 },
  { min: 500, max: 999, bonusRate: 0.2 },
  { min: 1000, max: 4999, bonusRate: 0.25 },
  { min: 5000, max: Infinity, bonusRate: 0.3 },
]

/** 按充值金额取自定义档赠送比例 */
export function customBonusRate(amountCny: number): number {
  const tier = CUSTOM_RECHARGE_TIERS.find(t => amountCny >= t.min && amountCny <= t.max)
  return tier?.bonusRate ?? 0
}

/** resolveLevel 的最小入参（2026-08-20 新口径：等级只反映订阅档；邀请身份不再产生等级） */
export interface LevelInput {
  subscriptionTier: number | null
}

/**
 * 等级判定（与积分余额无关）：仅按订阅档(1/2/3，过期仍保留)，无订阅=NONE。
 * LV4(FOUNDER)/LV5(INVITER) 已取消：邀请/被邀请只是关系（canInvite/invitedById），不再是等级；
 * 任何人可订阅可充值，邀请人同时可以是 LV1-3 会员。enum 值保留仅为兼容历史数据。
 */
export function resolveLevel(u: LevelInput): MembershipLevel {
  if (u.subscriptionTier === 1) return MembershipLevel.LV1
  if (u.subscriptionTier === 2) return MembershipLevel.LV2
  if (u.subscriptionTier === 3) return MembershipLevel.LV3
  return MembershipLevel.NONE
}

/**
 * 消费扣减分层（与等级无关，所有用户一致；不含不可消费的 REBATE）：
 *  - 第①层「赠送积分」(PACKAGE + GIFT)：两桶合池，按 expiresAt 升序（永不过期排最后）跨桶扣，
 *    保证「先扣最快过期的、再扣次过期的、最后扣永不过期的赠送积分」——PACKAGE 与 GIFT 谁先过期先扣。
 *  - 第②层「充值积分」(RECHARGE，永不过期)：赠送积分扣尽后才动，永远最后扣。
 * 目的：永远先消耗会清零的积分，避免赠送积分白白过期。
 */
export function consumeBucketTiers(): CreditBucket[][] {
  return [[CreditBucket.PACKAGE, CreditBucket.GIFT], [CreditBucket.RECHARGE]]
}

/** 「赠送层」桶（PACKAGE + GIFT，会过期）：企业成员混合扣费第①段的桶域。 */
export const GIFT_LAYER_BUCKETS: CreditBucket[] = [CreditBucket.PACKAGE, CreditBucket.GIFT]

/**
 * 企业成员消费的资金来源顺序（个人/团队混合扣费，2026-08-27 起，全消费链路通用）：
 * ① 个人赠送层（PACKAGE+GIFT，30 天过期先烧）→ ② 企业共享池 → ③ 个人充值（RECHARGE，永不过期最后扣）。
 * 企业成员加入时个人套餐/赠送已清零，故常态表现 = 企业池 → 个人充值。
 * ⚠️ 预留产品配置位：以后「先扣企业还是先扣个人」可配置时，从这里派生扣费顺序（见 UsageService.consumeRouted）。
 */
export const TEAM_MEMBER_FUNDING_ORDER = [
  "PERSONAL_GIFT",
  "TEAM_POOL",
  "PERSONAL_RECHARGE",
] as const
export type TeamMemberFundingSource = (typeof TEAM_MEMBER_FUNDING_ORDER)[number]
