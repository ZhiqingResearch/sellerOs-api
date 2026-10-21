import { buildCompetitorOperationDetail } from "./competitor-operation-detail"
import { buildHistoricalOperations } from "./open-product-analysis.service"

describe("竞品运营详情历史信号", () => {
  it("只保留有来源的历史数据，缺失不造零；日元按来源恢复单位", () => {
    const sop = {
      bucketDays: 7,
      weeks: [
        {
          startDate: "2026-09-20",
          price: 14,
          review: 0,
          bought: 100,
          bsr: 20,
          sources: { price: "keepa", review: "sif", bought: "keepa" },
        },
        { startDate: "2026-10-01", price: 25, sources: { price: "sif" } },
      ],
      rows: [],
      listedDays: 30,
      listedDaysSource: "sif",
    }
    const result = buildCompetitorOperationDetail(
      sop,
      buildHistoricalOperations(sop, "2026-09-23"),
      "2026-09-23",
      "JP"
    )
    expect(result.periodSignals).toHaveLength(1)
    expect(result.periodSignals[0]).toMatchObject({
      startDate: "2026-09-20",
      endDate: "2026-09-23",
      price: { value: 1400, source: "keepa" },
      reviewCount: { value: 0, source: "sif" },
      salesRank: { value: null, source: null },
      boughtInPastMonth: { value: 100, source: "keepa" },
    })
    expect(result).not.toHaveProperty("generatedAt")
    expect(result).not.toHaveProperty("durationDays")
  })
})
