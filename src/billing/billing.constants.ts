/** 自定义充值最低金额（元）：折算美元后须 ≥ Stripe 最低 $0.50，留足汇率波动余量 */
export const MIN_CUSTOM_RECHARGE_CNY = 10

/** 开发环境小额测试：dev3 使用 development，其他环境保持 10 元下限。 */
export function getCustomMinCny(): number {
  return process.env.NODE_ENV === "development" ? 0.1 : MIN_CUSTOM_RECHARGE_CNY
}

/** 支付超时（全渠道统一）：下单/发起支付后 15 分钟未支付 → EXPIRED（微信二维码有效期同口径） */
export const PAY_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 可补开收据的流水类型（仅「真实收款」的充值类）：
 * 手动调整（MANUAL_ADJUST）等非付款行不可开收据。receipts.service 补开校验与 wallet 明细 canClaimReceipt 共用。
 */
export const CLAIMABLE_RECEIPT_TYPES = [
  "RECHARGE_PLAN",
  "RECHARGE_PACK",
  "RECHARGE_CUSTOM",
] as const

/** 订单/收据/交易编号规则：SR + YYYYMMDDHHmmss + 3 位随机（DB 唯一索引兜底，冲突重试） */
export function genSerialNo(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `SR${ts}${p(Math.floor(Math.random() * 1000), 3)}`
}
