/** Stripe 扣款币种：订单人民币计价，经 FxService 实时汇率折美元收款——webhook/查单结算时按它核对实收币种 */
export const STRIPE_CHARGE_CURRENCY = "usd"

/** 美分 → 美元两位小数字符串（1299 → "12.99"）；负值带负号（折抵行） */
export function usdFromCents(cents: number): string {
  const sign = cents < 0 ? "-" : ""
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`
}
