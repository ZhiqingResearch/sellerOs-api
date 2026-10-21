import type { buildHistoricalOperations } from "./open-product-analysis.service"

type DataRecord = Record<string, unknown>
function asRecord(value: unknown): DataRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as DataRecord) : {}
}
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
function source(value: unknown): "sif" | "keepa" | null {
  return value === "sif" || value === "keepa" ? value : null
}

/** 仅组织既有历史事实与规则分析，不构造未来排期或调用模型。 */
export function buildCompetitorOperationDetail(
  sop: DataRecord,
  historical: ReturnType<typeof buildHistoricalOperations>,
  collectedDate: string,
  country: string
) {
  const periods = (Array.isArray(sop.weeks) ? sop.weeks : [])
    .map(asRecord)
    .filter(
      period =>
        typeof period.startDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(period.startDate) &&
        Number.isFinite(Date.parse(period.startDate)) &&
        period.startDate <= collectedDate
    )
    .map(period => {
      const startDate = String(period.startDate)
      const endDate = new Date(
        Date.parse(`${startDate}T00:00:00Z`) + (historical.bucketDays - 1) * 86400000
      )
        .toISOString()
        .slice(0, 10)
      const sources = asRecord(period.sources)
      const signal = (key: string, isPrice = false) => {
        const origin = source(sources[key])
        const value = origin ? finite(period[key]) : null
        return {
          value:
            value === null
              ? null
              : value * (isPrice && origin === "keepa" && country === "JP" ? 100 : 1),
          source: value === null ? null : origin,
        }
      }
      return {
        startDate,
        endDate: endDate > collectedDate ? collectedDate : endDate,
        price: signal("price", true),
        salesRank: signal("bsr"),
        reviewCount: signal("review"),
        rating: signal("star"),
        boughtInPastMonth: signal("bought"),
        adScore: signal("adScore"),
        offerCount: signal("offerCount"),
        stock: signal("stock"),
      }
    })
    .filter(period =>
      [
        period.price,
        period.salesRank,
        period.reviewCount,
        period.rating,
        period.boughtInPastMonth,
        period.adScore,
        period.offerCount,
        period.stock,
      ].some(item => item.value !== null)
    )
  return {
    ...historical,
    kind: "competitor_operations",
    basis: "external_data_and_rules",
    listedDays: finite(sop.listedDays),
    listedDaysSource: source(sop.listedDaysSource),
    stageEvidence: {
      salesTrendPct: finite(sop.salesTrendPct),
      salesRankTrendPct: finite(sop.bsrTrendPct),
    },
    periodSignals: periods,
    notes: typeof sop.earlyStageNote === "string" ? [sop.earlyStageNote] : [],
  }
}
