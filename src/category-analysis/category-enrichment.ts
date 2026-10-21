import { divide, median, numberOrNull } from "./category-analysis.math"
import type {
  CategoryEvidence,
  HeadTrend,
  KeywordResolution,
  MonthSample,
  SampleRow,
} from "./category-analysis.types"

const DAY_MS = 86400000
const objectOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const validNumber = (value: unknown) => {
  const number = numberOrNull(value)
  return number !== null && number >= 0 ? number : null
}

export function parseSalesHistory(
  value: unknown,
  rows: SampleRow[],
  now = new Date()
): MonthSample[] {
  const data = objectOf(value)
  const currentMonth = now.toISOString().slice(0, 7)
  const months = new Map<string, SampleRow[]>()
  for (const row of rows) {
    const points = Object.entries(objectOf(data[row.asin]))
      .filter(
        ([month, sales]) =>
          /^\d{4}-\d{2}$/.test(month) && month < currentMonth && (validNumber(sales) ?? 0) > 0
      )
      .sort(([a], [b]) => a.localeCompare(b))
    for (const [month, value] of points) {
      const sales = Number(value)
      months.set(month, [
        ...(months.get(month) ?? []),
        {
          ...row,
          sales,
          revenue: row.price === null ? null : row.price * sales,
          seller: null,
          sellerId: null,
          sellerCountry: null,
        },
      ])
    }
    const recent = points.slice(-6).map(([, value]) => Number(value))
    if (recent.length >= 2) {
      const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
      const ratio =
        recent.length >= 6
          ? divide(average(recent.slice(-3)), average(recent.slice(0, 3)))
          : divide(recent.at(-1)!, recent[0])
      row.growth = ratio === null ? null : (ratio - 1) * 100
    }
  }
  const minimum = Math.max(10, Object.keys(data).length * 0.3)
  const result = [...months]
    .filter(([, items]) => items.length >= minimum)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([month, items]) => ({ month, rows: items }))
  return result.length >= 2 ? result : []
}

export function parseHeadTrend(asin: string, value: unknown): HeadTrend | null {
  const data = objectOf(value)
  if (!Array.isArray(data.dates) || !data.dates.length) return null
  const dates = data.dates.map(date => Date.parse(String(date)))
  const latest = Math.max(...dates.filter(Number.isFinite))
  const series = (key: string) =>
    (Array.isArray(data[key]) ? (data[key] as unknown[]) : [])
      .map((value, index) => ({ time: dates[index], value: validNumber(value) }))
      .filter(point => Number.isFinite(point.time) && point.time > latest - 90 * DAY_MS)
      .sort((a, b) => a.time - b.time)
  const numbers = (key: string) =>
    series(key)
      .map(point => point.value)
      .filter((v): v is number => v !== null)
  const reviews = series("review").filter(
    (point): point is { time: number; value: number } => point.value !== null
  )
  const last = reviews.at(-1)
  const first = last
    ? (reviews.filter(point => point.time <= last.time - 30 * DAY_MS).at(-1) ?? reviews[0])
    : undefined
  const days = last && first ? (last.time - first.time) / DAY_MS : 0
  const reviewsNew =
    days >= 10 ? Math.max(0, Math.round(((last!.value - first!.value) / days) * 30)) : null
  const prices = numbers("buyboxPrice")
  return {
    asin,
    sellerCount: median(
      series("seller")
        .filter(p => p.time > latest - 14 * DAY_MS)
        .map(p => p.value)
    ),
    reviewsNew,
    naturalShare: numbers("nfScoreRatios").at(-1) ?? null,
    bsrNow: numbers("bsr").at(-1) ?? null,
    bsrAvg90: median(numbers("bsr")),
    priceMin90: prices.length ? Math.min(...prices) : null,
    priceMax90: prices.length ? Math.max(...prices) : null,
    priceAvg90: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
    drops90: null,
    offers: null,
    buybox: null,
    reviewVelocity: reviewsNew,
  }
}

export function focusEvidence(evidence: CategoryEvidence, keywords: string[]) {
  const tokens = keywords
    .map(keyword =>
      keyword
        .toLowerCase()
        .split(/\s+/)
        .filter(token => token.length > 2)
    )
    .filter(parts => parts.length)
  const match = (strict: boolean) =>
    evidence.rows.filter(row =>
      tokens.some(parts =>
        (strict ? parts : parts.slice(-1)).every(part =>
          (row.title ?? "").toLowerCase().includes(part)
        )
      )
    )
  let rows = match(true)
  if (rows.length < 30) rows = match(false)
  if (rows.length < 30) return { evidence, count: rows.length, isFallback: true }
  const asins = new Set(rows.map(row => row.asin))
  return {
    count: rows.length,
    isFallback: false,
    evidence: {
      ...evidence,
      rows,
      months: evidence.months.map(month => ({
        ...month,
        rows: month.rows.filter(row => asins.has(row.asin)),
      })),
      keepa: evidence.keepa.filter(item => asins.has(item.asin)),
      trends: evidence.trends?.filter(item => asins.has(item.asin)),
      newReleaseMerged: rows.filter(row => row.isNewRelease).length,
    },
  }
}

export function keywordConsistency(evidence: CategoryEvidence, resolution: KeywordResolution) {
  const asins = new Set(evidence.rows.map(row => row.asin))
  const topAsins = [...new Set(resolution.topAsins)]
  const overlap = topAsins.length
    ? topAsins.filter(asin => asins.has(asin)).length / topAsins.length
    : null
  return {
    overlap,
    consistent:
      resolution.candidates.length || topAsins.length
        ? resolution.candidates.some(candidate => candidate.categoryId === evidence.categoryId) ||
          (overlap ?? 0) >= 0.2
        : null,
  }
}
