type JsonRecord = Record<string, unknown>

export interface KeepaSeriesPoint {
  date: string
  value: number
}

export const KEEPA_CSV = {
  AMAZON: 0,
  NEW: 1,
  USED: 2,
  SALES: 3,
  LISTPRICE: 4,
  NEW_FBM_SHIPPING: 7,
  LIGHTNING_DEAL: 8,
  NEW_FBA: 10,
  COUNT_NEW: 11,
  RATING: 16,
  COUNT_REVIEWS: 17,
  BUY_BOX_SHIPPING: 18,
} as const

const KEEPA_TIME_MINUTES_OFFSET = 21_564_000
const SHIPPING_CSV_INDICES = new Set<number>([
  KEEPA_CSV.NEW_FBM_SHIPPING,
  KEEPA_CSV.BUY_BOX_SHIPPING,
])

export function keepaProduct(envelopeValue: unknown, asin: string): JsonRecord | null {
  const envelope = recordValue(envelopeValue)
  const products = recordArray(envelope.products)
  return (
    products.find(product => stringValue(product.asin).toUpperCase() === asin.toUpperCase()) ??
    products[0] ??
    null
  )
}

export function keepaSellers(envelopeValue: unknown): JsonRecord {
  return recordValue(recordValue(envelopeValue).sellers)
}

export function keepaCsvSeries(
  product: JsonRecord | null,
  csvIndex: number,
  kind: "price" | "raw" = "price"
): KeepaSeriesPoint[] {
  if (!product) return []
  const csv = Array.isArray(product.csv) ? product.csv : []
  const values = Array.isArray(csv[csvIndex]) ? (csv[csvIndex] as unknown[]) : []
  const stride = SHIPPING_CSV_INDICES.has(csvIndex) ? 3 : 2
  const byDate = new Map<string, number>()
  for (let index = 0; index + stride - 1 < values.length; index += stride) {
    const minute = finiteNumber(values[index])
    let value = finiteNumber(values[index + 1])
    if (minute === null || value === null || value < 0) continue
    if (stride === 3) {
      const shipping = finiteNumber(values[index + 2])
      if (shipping !== null && shipping > 0) value += shipping
    }
    byDate.set(keepaMinuteToDate(minute), kind === "price" ? value / 100 : value)
  }
  return [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((left, right) => left.date.localeCompare(right.date))
}

export function keepaCouponSeries(product: JsonRecord | null): KeepaSeriesPoint[] {
  if (!product || !Array.isArray(product.couponHistory)) return []
  const values = product.couponHistory
  const byDate = new Map<string, number>()
  for (let index = 0; index + 2 < values.length; index += 3) {
    const minute = finiteNumber(values[index])
    const oneTime = finiteNumber(values[index + 1]) ?? 0
    const subscribeAndSave = finiteNumber(values[index + 2]) ?? 0
    const coupon = normalizeCoupon(oneTime || subscribeAndSave)
    if (minute === null || coupon === null) continue
    byDate.set(keepaMinuteToDate(minute), coupon)
  }
  return [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((left, right) => left.date.localeCompare(right.date))
}

export function keepaCurrentCoupon(product: JsonRecord | null): number | null {
  if (!product || !Array.isArray(product.coupon)) return null
  const oneTime = finiteNumber(product.coupon[0]) ?? 0
  const subscribeAndSave = finiteNumber(product.coupon[1]) ?? 0
  return normalizeCoupon(oneTime || subscribeAndSave)
}

export function keepaStockSeries(product: JsonRecord | null): KeepaSeriesPoint[] {
  const offer = preferredOffer(product)
  return decodeStrideTwo(offer?.stockCSV)
}

export function keepaCurrentStock(product: JsonRecord | null): number | null {
  const offer = preferredOffer(product)
  const stock = finiteNumber(offer?.stock)
  if (stock !== null && stock >= 0) return stock
  return keepaStockSeries(product).at(-1)?.value ?? null
}

export function keepaMonthlySoldSeries(product: JsonRecord | null): KeepaSeriesPoint[] {
  return decodeStrideTwo(product?.monthlySoldHistory)
}

export function keepaValueAsOf(points: KeepaSeriesPoint[], date: string): number | null {
  let value: number | null = null
  for (const point of points) {
    if (point.date > date) break
    value = point.value
  }
  return value
}

export function keepaFirstInRange(
  points: KeepaSeriesPoint[],
  fromDate: string,
  toDate: string
): number | null {
  return points.find(point => point.date >= fromDate && point.date <= toDate)?.value ?? null
}

export function keepaLatestDate(product: JsonRecord | null): string | null {
  if (!product) return null
  const series = [
    keepaCsvSeries(product, KEEPA_CSV.BUY_BOX_SHIPPING, "price"),
    keepaCsvSeries(product, KEEPA_CSV.AMAZON, "price"),
    keepaCsvSeries(product, KEEPA_CSV.SALES, "raw"),
    keepaCsvSeries(product, KEEPA_CSV.COUNT_REVIEWS, "raw"),
    keepaCouponSeries(product),
    keepaStockSeries(product),
  ]
  return series.reduce<string | null>((latest, points) => {
    const date = points.at(-1)?.date
    return date && (!latest || date > latest) ? date : latest
  }, null)
}

export function keepaBuyBoxHistory(product: JsonRecord | null): Array<{
  date: string
  sellerId: string
}> {
  if (!product || !Array.isArray(product.buyBoxSellerIdHistory)) return []
  const history = product.buyBoxSellerIdHistory
  const byDate = new Map<string, string>()
  for (let index = 0; index + 1 < history.length; index += 2) {
    const minute = finiteNumber(history[index])
    if (minute === null) continue
    byDate.set(keepaMinuteToDate(minute), String(history[index + 1]))
  }
  return [...byDate.entries()]
    .map(([date, sellerId]) => ({ date, sellerId }))
    .sort((left, right) => left.date.localeCompare(right.date))
}

export function keepaCurrentBuyBoxSeller(
  product: JsonRecord | null,
  sellers: JsonRecord,
  startDate: string
): JsonRecord | null {
  if (!product) return null
  const stats = recordValue(product.stats)
  const sellerId = stringValue(stats.buyBoxSellerId)
  const history = keepaBuyBoxHistory(product)
  const changes90d = history.reduce(
    (count, item, index) =>
      item.date >= startDate && index > 0 && item.sellerId !== history[index - 1].sellerId
        ? count + 1
        : count,
    0
  )
  if (!sellerId || sellerId === "-1" || sellerId === "-2") {
    return changes90d
      ? {
          name: "当前无 Buybox",
          fulfillment: "FBM",
          rating: null,
          ratingCount: null,
          changes90d,
        }
      : null
  }
  const seller = recordValue(sellers[sellerId])
  const isAmazon = stats.buyBoxIsAmazon === true
  return {
    name: isAmazon ? "Amazon.com" : stringValue(seller.sellerName) || sellerId,
    fulfillment: isAmazon ? "Amazon" : stats.buyBoxIsFBA === true ? "FBA" : "FBM",
    rating: finiteNumber(seller.currentRating),
    ratingCount: finiteNumber(seller.currentRatingCount),
    changes90d,
  }
}

export function keepaListedDays(product: JsonRecord | null): number | null {
  const minute = finiteNumber(product?.listedSince)
  if (minute === null) return null
  const timestamp = (minute + KEEPA_TIME_MINUTES_OFFSET) * 60_000
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000))
}

export function keepaSuggestedPrice(product: JsonRecord | null): number | null {
  const cents = finiteNumber(product?.suggestedLowerPrice)
  return cents !== null && cents > 0 ? cents / 100 : null
}

function preferredOffer(product: JsonRecord | null): JsonRecord | null {
  const offers = recordArray(product?.offers)
  return (
    offers.find(offer => offer.isAmazon === true) ??
    offers.find(offer => offer.isFBA === true) ??
    offers[0] ??
    null
  )
}

function decodeStrideTwo(value: unknown): KeepaSeriesPoint[] {
  if (!Array.isArray(value)) return []
  const byDate = new Map<string, number>()
  for (let index = 0; index + 1 < value.length; index += 2) {
    const minute = finiteNumber(value[index])
    const itemValue = finiteNumber(value[index + 1])
    if (minute === null || itemValue === null || itemValue < 0) continue
    byDate.set(keepaMinuteToDate(minute), itemValue)
  }
  return [...byDate.entries()]
    .map(([date, itemValue]) => ({ date, value: itemValue }))
    .sort((left, right) => left.date.localeCompare(right.date))
}

function normalizeCoupon(rawValue: number): number | null {
  if (!Number.isFinite(rawValue) || rawValue === 0) return null
  return rawValue < 0 ? rawValue : rawValue / 100
}

function keepaMinuteToDate(minute: number): string {
  return new Date((minute + KEEPA_TIME_MINUTES_OFFSET) * 60_000).toISOString().slice(0, 10)
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonRecord =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    : []
}
