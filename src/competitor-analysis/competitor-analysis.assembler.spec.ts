import { assembleCompetitorAnalysis } from "./competitor-analysis.assembler"
import type { CompetitorEvidenceBundle } from "./competitor-analysis.types"

describe("assembleCompetitorAnalysis", () => {
  it("按旧页面的数据密度稳定组装画像、流量广告、价格时间线和 SOP", () => {
    const asin = "B0F15TM77B"
    const dates = Array.from({ length: 120 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1))
      return date.toISOString().slice(0, 10)
    })
    const keywordRows = Array.from({ length: 12 }, (_, index) => ({
      asin,
      keyword: `gaming desktop ${index}`,
      searchVolume: 10_000 - index * 100,
      conversionShared: 12,
      naturalPositionSeq: [{ page: 1, currentPageNfRank: index + 1 }],
    }))
    const adRows = keywordRows.map((row, index) => ({
      keyword: row.keyword,
      searchVolume: row.searchVolume,
      spScoreRatio: 0.1,
      kwSpScoreRatio: 0.08,
      variants: [
        {
          asin,
          campaignIds: [`campaign-${index % 3}`],
          adIds: [`group-${index % 4}`],
          campaignIdNum: 3,
          adIdNum: 4,
          adScore: 100 - index,
          days: 30,
          spHistory: dates.slice(-8).map((date, historyIndex) => ({
            date,
            rank: 20 - historyIndex,
            position: {
              page: 1,
              currentPageRank: 20 - historyIndex,
              currentPageTotalAsinCount: 48,
            },
          })),
        },
      ],
    }))
    const evidence: CompetitorEvidenceBundle = {
      country: "US",
      asins: [asin],
      collectedAt: "2026-08-27T00:00:00.000Z",
      sif: {
        profile: {
          list: [
            {
              asin,
              requestAsin: asin,
              title: "Gaming Desktop",
              img: "https://example.com/product.jpg",
              brand: "Example",
              score: 4.6,
              ratingNum: 320,
              boughtInPastMonth: 500,
              firstAvailableDay: "2025-01-01",
              variationNum: 4,
              bsrList: [{ name: "Tower Computers", rank: 120 }],
              featureList: [{ code: "RAM", value: "32GB" }],
              featureDescriptions: ["RTX graphics", "Fast SSD"],
            },
          ],
        },
        price: {
          list: [
            {
              asin,
              currentPrice: 1_499,
              pricePriorityTags: ["price_stable"],
              priceExceptionTags: [],
            },
          ],
        },
        monthlySales: { [asin]: { "2026-06": 400, "2026-07": 450, "2026-08": 500 } },
        trafficSummary: {
          list: [
            {
              asin,
              totalScore: 1_000,
              totalScorePrev: 900,
              naturalScore: 600,
              adScore: 400,
              adScorePrev: 350,
              adKeywordNum: 12,
              spKeywordNum: 10,
            },
          ],
        },
        keywords: { list: keywordRows },
        adKeywords: {
          [asin]: { total: 12, totalCampaignCnt: 3, totalAdCnt: 4, list: adRows },
        },
        competePatterns: {
          [asin]: {
            list: keywordRows.map(row => ({ asin, keyword: row.keyword, totalScoreRatio: 0.05 })),
          },
        },
        trafficTrends: {
          [asin]: {
            dates,
            buyboxPrice: dates.map((_, index) => 1_499 - (index % 4) * 10),
            primePrice: dates.map((_, index) => (index % 20 === 0 ? 1_399 : 0)),
            ldPrice: dates.map((_, index) => (index % 30 === 0 ? 1_299 : 0)),
            dealPrice: dates.map(() => 0),
            couponInfo: dates.map((_, index) => (index % 25 === 0 ? -10 : 0)),
            bsr: dates.map((_, index) => 2_000 - index * 5),
            review: dates.map((_, index) => 200 + Math.floor(index / 3)),
            star: dates.map(() => 4.6),
            bought: dates.map((_, index) => 300 + index),
            seller: dates.map(() => 3),
            adScore: dates.map((_, index) => 100 + index),
            title: dates.map((_, index) => (index === 80 ? 1 : 0)),
            img: dates.map((_, index) => (index === 90 ? 1 : 0)),
            campaign: dates.map((_, index) => (index === 70 ? 1 : 0)),
            ad: dates.map((_, index) => (index === 75 ? 1 : 0)),
          },
        },
      },
      sellerSprite: null,
      keepa: null,
      sources: [{ provider: "sif", status: "used", label: "SIF 竞品事实数据" }],
      callDetail: { sif: 9 },
    }

    const result = assembleCompetitorAnalysis(evidence)
    const profile = result.profiles[0]
    const traffic = result.trafficBoards[0]
    const pricePromo = result.pricePromoBoards[0]
    const adDetail = traffic.adDetail as Record<string, unknown>
    const series = pricePromo.series as Record<string, unknown>
    const sop = pricePromo.sop as Record<string, unknown>

    expect(profile).toMatchObject({ found: true, title: "Gaming Desktop" })
    expect(profile.bullets).toHaveLength(2)
    expect(profile.salesTrend).toHaveLength(3)
    expect(traffic.keywords).toHaveLength(10)
    expect(adDetail.groups).toEqual(expect.any(Array))
    expect((adDetail.campaigns as unknown[]).length).toBeGreaterThan(0)
    expect(adDetail.keywordCards).toHaveLength(10)
    expect(pricePromo.timeline).toHaveLength(12)
    expect(series.salesRank).toHaveLength(90)
    expect((series.channels as Array<{ key: string }>).map(channel => channel.key)).not.toContain(
      "deal"
    )
    expect((sop.weeks as unknown[]).length).toBeGreaterThanOrEqual(14)
    expect(sop.rows).toHaveLength(10)
  })

  it("由 Keepa 触发异常并在 SIF 正负三天窗口反查运营动作", () => {
    const asin = "B0KEEPA001"
    const dates = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 7, 15 + index))
      return date.toISOString().slice(0, 10)
    })
    const keepaMinute = (date: string): number =>
      Math.floor(Date.parse(`${date}T00:00:00Z`) / 60_000) - 21_564_000
    const csv = Array.from({ length: 19 }, () => null) as Array<number[] | null>
    csv[3] = [
      keepaMinute("2026-08-20"),
      1_000,
      keepaMinute("2026-08-21"),
      500,
      keepaMinute("2026-08-24"),
      420,
    ]
    csv[11] = [keepaMinute("2026-08-20"), 2, keepaMinute("2026-08-21"), 4]
    csv[16] = [keepaMinute("2026-08-20"), 45, keepaMinute("2026-08-21"), 47]
    csv[17] = [keepaMinute("2026-08-14"), 100, keepaMinute("2026-08-21"), 160]
    csv[18] = [keepaMinute("2026-08-20"), 10_000, 0, keepaMinute("2026-08-21"), 8_500, 0]
    const campaign = dates.map(() => 0)
    const ad = dates.map(() => 0)
    const title = dates.map(() => 0)
    const actionIndex = dates.indexOf("2026-08-22")
    campaign[actionIndex] = 2
    ad[actionIndex] = 3
    title[actionIndex] = 1

    const evidence: CompetitorEvidenceBundle = {
      country: "US",
      asins: [asin],
      collectedAt: "2026-08-28T00:00:00.000Z",
      sif: {
        price: { list: [{ asin, currentPrice: 99 }] },
        trafficTrends: {
          [asin]: {
            dates,
            buyboxPrice: dates.map(() => 99),
            primePrice: dates.map(() => null),
            dealPrice: dates.map(() => null),
            ldPrice: dates.map(() => null),
            couponInfo: dates.map(() => null),
            bsr: dates.map(() => 900),
            review: dates.map(() => 100),
            star: dates.map(() => 4.5),
            bought: dates.map(() => 100),
            seller: dates.map(() => 2),
            adScore: dates.map((_, index) => (index < actionIndex ? 20 : 60)),
            nfScore: dates.map(() => 30),
            campaign,
            ad,
            title,
            img: dates.map(() => 0),
          },
        },
        adKeywords: { [asin]: { list: [] } },
      },
      sellerSprite: null,
      keepa: {
        [asin]: {
          products: [
            {
              asin,
              csv,
              stats: {
                buyBoxSellerId: "SELLER-1",
                buyBoxIsFBA: true,
                buyBoxIsAmazon: false,
              },
              buyBoxSellerIdHistory: [
                keepaMinute("2026-08-20"),
                "SELLER-0",
                keepaMinute("2026-08-21"),
                "SELLER-1",
              ],
              offers: [{ sellerId: "SELLER-1", isFBA: true, stock: 8 }],
            },
          ],
          sellers: {
            "SELLER-1": {
              sellerName: "Keepa Seller",
              currentRating: 98,
              currentRatingCount: 500,
            },
          },
        },
      },
      sources: [
        { provider: "sif", status: "used", label: "SIF 竞品事实数据" },
        { provider: "keepa", status: "used", label: "Keepa 历史数据" },
      ],
      callDetail: { sif: 3, keepa: 2 },
    }

    const board = assembleCompetitorAnalysis(evidence).pricePromoBoards[0]
    const series = board.series as Record<string, unknown>
    const metrics = board.metrics as Record<string, unknown>
    const metricSources = metrics.fieldSources as Record<string, unknown>
    const timeline = board.timeline as Array<Record<string, unknown>>
    const event = timeline.find(row => row.date === "2026-08-21")
    const actions = event?.actions as Array<Record<string, unknown>>
    const sop = board.sop as Record<string, unknown>
    const weeks = sop.weeks as Array<Record<string, unknown>>

    expect(series).toMatchObject({ source: "keepa", sourceState: "keepa" })
    expect(board.timelineSource).toBe("keepa")
    expect(metricSources).toMatchObject({ currentPrice: "keepa", bsr: "keepa" })
    expect(board.currentPrice).toBe(85)
    expect(board.buyBoxSeller).toMatchObject({ name: "Keepa Seller", fulfillment: "FBA" })
    expect(event?.priceSignal).toMatchObject({ dir: "down", from: 100, to: 85 })
    expect(event?.bsrEffect).toMatchObject({ from: 1_000, to: 420, delta: 580 })
    expect(event?.extraSignals).toEqual(
      expect.arrayContaining([
        expect.stringContaining("BSR 3 日改善"),
        expect.stringContaining("Buy Box 换手"),
        expect.stringContaining("Offer +2"),
      ])
    )
    expect(actions.map(action => action.label)).toEqual(
      expect.arrayContaining([
        "修改标题（SIF ±3 天）",
        "新增 2 个广告活动",
        "新增 3 个广告组",
        "广告得分上升，流量更偏广告驱动",
      ])
    )
    expect(weeks.some(week => (week.sources as Record<string, unknown>).price === "keepa")).toBe(
      true
    )
  })
})
