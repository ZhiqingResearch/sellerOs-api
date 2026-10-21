import { Decimal } from "@prisma/client/runtime/library"

/**
 * 返利金额精度（2026-08-31 起不抹零）：最多 4 位小数（schema Decimal(18,4)），
 * 仅当小数位超过 4 位时才量化（ROUND_HALF_UP）；整数/少位小数原样保留
 * （30 仍是 "30"，0.9 是 "0.9"）。返利结算内核与成本试算共用，防口径漂移。
 */
export function quantize4(v: Decimal): Decimal {
  return v.decimalPlaces() > 4 ? v.toDecimalPlaces(4, Decimal.ROUND_HALF_UP) : v
}
