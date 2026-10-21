import { Decimal } from "@prisma/client/runtime/library"

/**
 * 价格倍率安全换算：AiGatewayModel.priceMultiplier 统一入口。
 * 空/非法/非正倍率一律按 1（既不放大也不改价），Decimal 入参直接换算。
 */
export function safeMultiplier(value: Decimal | string | number | null | undefined): Decimal {
  if (value == null) return new Decimal(1)
  try {
    const multiplier = new Decimal(value)
    return multiplier.isFinite() && multiplier.greaterThan(0) ? multiplier : new Decimal(1)
  } catch {
    return new Decimal(1)
  }
}
