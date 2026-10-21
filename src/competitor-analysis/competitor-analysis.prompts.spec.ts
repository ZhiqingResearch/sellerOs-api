import { buildCompetitorAnalysisPrompts } from "./competitor-analysis.prompts"
import { AssembledCompetitorAnalysis, CompetitorEvidenceBundle } from "./competitor-analysis.types"

describe("buildCompetitorAnalysisPrompts", () => {
  it("只向 AI 发送摘要所需的确定性模块事实，不发送超长原始证据", () => {
    const evidence: CompetitorEvidenceBundle = {
      country: "US",
      asins: ["B0F15TM77B"],
      collectedAt: "2026-08-26T00:00:00.000Z",
      sif: {
        keywords: Array.from({ length: 2_000 }, (_, index) => ({
          keyword: `keyword-${index}`,
          description: "竞品关键词证据".repeat(100),
        })),
      },
      sellerSprite: {
        results: Array.from({ length: 1_000 }, (_, index) => ({ rank: index + 1 })),
      },
      keepa: {
        B0F15TM77B: { csv: [Array.from({ length: 10_000 }, (_, index) => index)] },
      },
      sources: [
        { provider: "sif", status: "used", label: "SIF 竞品事实数据" },
        { provider: "sellersprite", status: "used", label: "卖家精灵竞品数据" },
        { provider: "keepa", status: "used", label: "Keepa 历史数据" },
      ],
      callDetail: { sif: 5, sellersprite: 4, keepa: 1 },
    }

    const assembled: AssembledCompetitorAnalysis = {
      profiles: [
        { asin: "B0F15TM77B", found: true, salesTrend: [{ month: "2026-08", sales: 100 }] },
      ],
      trafficBoards: [
        {
          asin: "B0F15TM77B",
          found: true,
          summary: { totalScore: 100 },
          keywords: Array.from({ length: 20 }, (_, index) => ({ keyword: `keyword-${index}` })),
          adDetail: { keywordCount: 20, campaigns: Array.from({ length: 100 }, () => ({})) },
        },
      ],
      pricePromoBoards: [
        {
          asin: "B0F15TM77B",
          found: true,
          currentPrice: 99,
          metrics: { bsrDelta: 10 },
          sop: { stage: "增长期", weeks: Array.from({ length: 40 }, () => ({})) },
        },
      ],
    }
    const { userPrompt } = buildCompetitorAnalysisPrompts(evidence, assembled)
    const evidenceJson = userPrompt.split("事实数据：\n")[1]
    const parsed = JSON.parse(evidenceJson) as {
      profiles: Array<{ asin: string }>
      traffic: Array<{ keywords: Array<{ keyword: string }>; adDetail: Record<string, unknown> }>
      pricePromo: Array<{ sop: Record<string, unknown> }>
    }

    expect(evidenceJson.length).toBeLessThan(20_000)
    expect(parsed.profiles[0].asin).toBe("B0F15TM77B")
    expect(parsed.traffic[0].keywords).toHaveLength(10)
    expect(parsed.traffic[0].adDetail).not.toHaveProperty("campaigns")
    expect(parsed.pricePromo[0].sop).not.toHaveProperty("weeks")
  })
})
