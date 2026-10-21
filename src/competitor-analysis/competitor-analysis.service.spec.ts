import { Decimal } from "@prisma/client/runtime/library"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { CompetitorAnalysisRecordService } from "./competitor-analysis-record.service"
import { CompetitorAnalysisService } from "./competitor-analysis.service"
import { CompetitorEvidenceProvider } from "./competitor-evidence.provider"

describe("CompetitorAnalysisService", () => {
  it("把 AI 结果封装成前端原有的完整 Snapshot 契约", async () => {
    const collectEvidence = jest.fn().mockResolvedValue({
      country: "US",
      asins: ["B000000001"],
      collectedAt: "2026-08-26T00:00:00.000Z",
      sif: {
        profile: {
          list: [
            {
              asin: "B000000001",
              requestAsin: "B000000001",
              title: "Test",
              price: 29.99,
              firstAvailableDay: "2026-01-01",
            },
          ],
        },
        price: { list: [{ asin: "B000000001", currentPrice: 29.99 }] },
        monthlySales: { B000000001: { "2026-07": 100, "2026-08": 120 } },
        trafficSummary: {
          list: [{ asin: "B000000001", totalScore: 100, naturalScore: 60, adScore: 40 }],
        },
        keywords: { list: [{ asin: "B000000001", keyword: "gaming pc" }] },
        trafficTrends: {
          B000000001: {
            dates: ["2026-08-01", "2026-08-08"],
            buyboxPrice: [31.99, 29.99],
            bsr: [1000, 800],
          },
        },
        adKeywords: { B000000001: { total: 0, totalCampaignCnt: 0, totalAdCnt: 0, list: [] } },
        competePatterns: { B000000001: { list: [] } },
      },
      sellerSprite: null,
      keepa: null,
      sources: [
        { provider: "sif", status: "used", label: "SIF 竞品事实数据" },
        { provider: "sellersprite", status: "not_configured", label: "卖家精灵竞品数据" },
        { provider: "keepa", status: "not_configured", label: "Keepa 历史数据" },
      ],
      callDetail: { sif: 4 },
    })
    const evidenceProvider = {
      collectEvidence,
      collectModuleEvidence: collectEvidence,
    } as unknown as CompetitorEvidenceProvider
    const generateJson = jest.fn().mockResolvedValue({
      data: {
        summary: {
          insights: [
            {
              kind: "landscape",
              status: "available",
              title: "格局",
              description: "测试",
              evidence: [],
            },
          ],
          rankings: [{ asin: "B000000001", rank: 1 }],
        },
      },
      tokenUsage: { promptTokens: 100, completionTokens: 20, thinkingTokens: 0 },
      model: "ZQ-Think-Lite",
      requestId: "req-1",
      billing: {
        costCny: "0.234567",
        currency: "CNY",
        model: "ZQ-Think-Lite",
        requestId: "req-1",
        requestIds: ["req-1"],
      },
    })
    const aiGatewayProvider = {
      generateJson,
    } as unknown as AiGatewayProvider
    const chargeFixedModule = jest.fn().mockResolvedValue({})
    const service = new CompetitorAnalysisService(
      evidenceProvider,
      aiGatewayProvider,
      {
        chargeFixedModule, assertFixedModuleAffordable: jest.fn(),
        gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal("4")),
      } as unknown as UsageService,
      {} as PrismaService,
      {
        create: jest.fn().mockResolvedValue({ recordId: "record-1" }),
      } as unknown as CompetitorAnalysisRecordService
    )

    const result = await service.analyze(8, {
      country: "US",
      asins: ["B000000001"],
      model: "ZQ-Think-Pro",
    })

    expect(result.snapshot).toMatchObject({
      version: 1,
      country: "US",
      competitorAsins: ["B000000001"],
      modules: {
        profile: { module: "profile", status: "success" },
        traffic: { module: "traffic", status: "success" },
        pricePromo: { module: "pricePromo", status: "success" },
      },
      usage: { total: { totalCalls: 4, callDetail: { sif: 4 } } },
    })
    expect(
      (result.snapshot.summary as { insights: Array<{ method: string }> }).insights[0]
    ).toMatchObject({
      method: "ai_generated",
    })
    expect(result.gateway).toEqual({ model: "ZQ-Think-Lite", requestId: "req-1" })
    expect(result.billingHandled).toBe(true)
    expect(chargeFixedModule).toHaveBeenCalledWith(8, "competitor.research", {
      quantity: 1,
      model: "ZQ-Think-Lite",
      requestId: "req-1",
      meta: {
        phase: "analyze",
        operation: "analyze",
        country: "US",
        asins: ["B000000001"],
        actualCostCny: "0.234567",
        gatewayRequestIds: ["req-1"],
        tokenUsage: { promptTokens: 100, completionTokens: 20, thinkingTokens: 0 },
      },
    })
    const snapshot = result.snapshot as {
      modules: {
        pricePromo: {
          boards: Array<{
            timeline: Array<{ extraSignals: unknown[]; actions: unknown[] }>
            series: {
              channels: Array<{ key: string; points: unknown[] }>
              salesRank: unknown[]
            }
          }>
        }
      }
    }
    const pricePromoBoard = snapshot.modules.pricePromo.boards[0]
    expect(pricePromoBoard.timeline.length).toBeGreaterThan(0)
    expect(pricePromoBoard.timeline[0].extraSignals).toEqual([])
    expect(Array.isArray(pricePromoBoard.timeline[0].actions)).toBe(true)
    expect(pricePromoBoard.series.channels[0].key).toBe("buyBox")
    expect(pricePromoBoard.series.channels[0].points.length).toBeGreaterThan(0)
    expect(pricePromoBoard.series.salesRank.length).toBeGreaterThan(0)
    const trafficBoard = (
      result.snapshot as {
        modules: {
          traffic: {
            boards: Array<{
              keywords: Array<Record<string, unknown>>
              adDetail: {
                groups: Array<{ keywords: unknown[] }>
                keywords: Array<Record<string, unknown>>
              }
            }>
          }
        }
      }
    ).modules.traffic.boards[0]
    expect(trafficBoard.keywords[0]).toMatchObject({
      keyword: "gaming pc",
      searchVolume: 0,
      totalScoreRatio: null,
      adScoreRatio: 0,
      listingAdScoreRatio: 0,
      adRatioRising: false,
    })
    expect(trafficBoard.adDetail.groups).toEqual([])
    expect(trafficBoard.adDetail.keywords).toEqual([])

    generateJson.mockResolvedValueOnce({
      data: {},
      tokenUsage: { promptTokens: 100, completionTokens: 5, thinkingTokens: 0 },
      model: "ZQ-Think-Lite",
      requestId: "req-2",
      billing: {
        costCny: "0.1",
        currency: "CNY",
        model: "ZQ-Think-Lite",
        requestId: "req-2",
        requestIds: ["req-2"],
      },
    })

    const fallbackResult = await service.analyze(8, {
      country: "US",
      asins: ["B000000001"],
    })
    const fallbackSummary = fallbackResult.snapshot.summary as {
      insights: Array<{ status: string; title: string; description: string }>
      rankings: Array<{ asin: string; rank: number | null }>
    }

    expect(fallbackSummary.insights).toHaveLength(4)
    expect(
      fallbackSummary.insights.some(
        insight =>
          insight.status === "insufficient" &&
          insight.title === "AI 总结待重试" &&
          insight.description.includes("不代表事实数据不足")
      )
    ).toBe(true)
    expect(fallbackSummary.rankings).toEqual([
      expect.objectContaining({ asin: "B000000001", rank: null }),
    ])
    type GenerateJsonOptions = {
      isDataValid: (value: unknown) => boolean
      retryInstruction: string
      maxOutputTokens?: number
      model: string
      resolveBilling: boolean
    }
    const generateJsonCalls = generateJson.mock.calls as unknown as Array<
      [string, string, GenerateJsonOptions]
    >
    const options = generateJsonCalls[0]?.[2]
    expect(options).toBeDefined()
    if (!options) throw new Error("测试未捕获 AI Gateway 调用参数")
    expect(options.isDataValid({})).toBe(false)
    expect(options.isDataValid({ summary: { insights: [], rankings: [] } })).toBe(true)
    expect(options.isDataValid({ insights: [], rankings: [] })).toBe(true)
    expect(options.retryInstruction).toContain("insights 数组和 rankings 数组")
    expect(options.maxOutputTokens).toBeUndefined()
    expect(options.model).toBe("ZQ-Think-Pro")
    expect(options.resolveBilling).toBe(true)
    expect(generateJsonCalls[1]?.[2].maxOutputTokens).toBeUndefined()

    const [profile, traffic, pricePromo] = await Promise.all([
      service.analyzeProfile({ country: "US", asins: ["B000000001"] }),
      service.analyzeTraffic({ country: "US", asins: ["B000000001"] }),
      service.analyzePricePromo({ country: "US", asins: ["B000000001"] }),
    ])
    expect(profile).toMatchObject({ module: "profile", status: "success" })
    expect(traffic).toMatchObject({ module: "traffic", status: "success" })
    expect(pricePromo).toMatchObject({ module: "pricePromo", status: "success" })

    const summaryResult = await service.summarize(8, {
      country: "US",
      asins: ["B000000001"],
      model: "ZQ-Think-Lite",
      modules: { profile, traffic, pricePromo },
    })
    expect(summaryResult.summary.insights).toHaveLength(4)
    expect(summaryResult.gateway).toEqual({ model: "ZQ-Think-Lite", requestId: "req-1" })
    expect(generateJsonCalls.at(-1)?.[2]).toEqual(
      expect.objectContaining({ model: "ZQ-Think-Lite" })
    )
    expect(generateJsonCalls.at(-1)?.[2].maxOutputTokens).toBeUndefined()
  })
})
