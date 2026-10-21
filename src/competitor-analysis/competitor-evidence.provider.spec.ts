import { ConfigService } from "@nestjs/config"
import type { AxiosRequestConfig } from "axios"
import axios from "axios"
import { assembleCompetitorAnalysis } from "./competitor-analysis.assembler"
import type { CompetitorEvidenceSource } from "./competitor-analysis.types"
import { CompetitorEvidenceProvider } from "./competitor-evidence.provider"

interface CompetitorEvidenceProviderInternals {
  _providerFailureMessage(provider: "sif" | "sellersprite" | "keepa", error: unknown): string
  _optionalSettledValue(
    result: PromiseSettledResult<{ data: Record<string, unknown>; callCount: number } | null>,
    provider: "sellersprite" | "keepa",
    sources: CompetitorEvidenceSource[]
  ): { data: Record<string, unknown>; callCount: number } | null
  _mcpErrorMessage(value: unknown): string | null
  _collectKeepaEvidence(
    country: string,
    asins: string[]
  ): Promise<{ data: Record<string, unknown>; callCount: number } | null>
}

describe("CompetitorEvidenceProvider", () => {
  afterEach(() => jest.restoreAllMocks())
  const provider = new CompetitorEvidenceProvider(
    {} as ConfigService
  ) as unknown as CompetitorEvidenceProviderInternals

  it("把外部服务错误归一成安全且可操作的提示", () => {
    expect(provider._providerFailureMessage("sif", new Error("API配额已用完,联系运营顾问"))).toBe(
      "SIF 配额已用完，请联系管理员补充额度"
    )
    expect(provider._providerFailureMessage("keepa", new Error("401 key=secret-value"))).toBe(
      "Keepa 凭证未配置或已失效，请联系管理员"
    )
    expect(provider._providerFailureMessage("sellersprite", new Error("ETIMEDOUT"))).toBe(
      "卖家精灵 响应超时，请稍后重试"
    )
  })

  it("可选数据源失败时把原因写入来源契约", () => {
    const sources: CompetitorEvidenceSource[] = []
    const value = provider._optionalSettledValue(
      { status: "rejected", reason: new Error("Keepa quota exceeded") },
      "keepa",
      sources
    )

    expect(value).toBeNull()
    expect(sources).toEqual([
      {
        provider: "keepa",
        status: "failed",
        label: "Keepa 历史数据",
        message: "Keepa 配额已用完，请联系管理员补充额度",
        retryable: false,
      },
    ])
  })

  it("识别卖家精灵 MCP 以成功响应承载的业务错误", () => {
    expect(
      provider._mcpErrorMessage({
        isError: true,
        content: [{ type: "text", text: "quota exceeded" }],
      })
    ).toBe("quota exceeded")
  })

  it("Keepa 历史请求补齐 Buy Box、评分和库存所需参数", async () => {
    const config = {
      get: jest.fn((key: string, fallback?: string) => {
        if (key === "KEEPA_API_KEY") return "test-key"
        if (key === "KEEPA_API_BASE_URL") return fallback
        return undefined
      }),
    } as unknown as ConfigService
    const keepaProvider = new CompetitorEvidenceProvider(
      config
    ) as unknown as CompetitorEvidenceProviderInternals
    const getSpy = jest.spyOn(axios, "get").mockResolvedValueOnce({
      data: { products: [{ asin: "B0KEEPA001", stats: { buyBoxSellerId: "-1" } }] },
    })

    const result = await keepaProvider._collectKeepaEvidence("US", ["B0KEEPA001"])
    const [requestUrl, requestConfig] = getSpy.mock.calls[0] as [string, AxiosRequestConfig]

    expect(requestUrl).toBe("https://api.keepa.com/product")
    expect(requestConfig.params).toMatchObject({
      history: 1,
      offers: 20,
      rating: 1,
      stock: 1,
      stats: 30,
    })
    expect(result?.callCount).toBe(1)
    getSpy.mockRestore()
  })

  it("牛牛最多5次SIF及1次Keepa，精简前后商品、历史曲线及甘特一致", async () => {
    const asin = "B0F15TM77B"
    const config = {
      get: (key: string, fallback?: string) => (key.endsWith("API_KEY") ? "test-key" : fallback),
    } as ConfigService
    const subject = new CompetitorEvidenceProvider(config)
    const trend = {
      dates: ["2026-09-20", "2026-09-21"],
      buyboxPrice: [15, 14],
      bsr: [300, 250],
      review: [3, 4],
      bought: [100, 120],
      title: [0, 1],
      adScore: [10, 20],
    }
    const responses: Record<string, unknown> = {
      batchAsinDetail: [{ asin, title: "商品", firstAvailableDay: "2026-08-01" }],
      batchAsinPrice: [{ asin, currentPrice: 14 }],
      asinsHistorySales: { [asin]: { "2026-08": 200 } },
      getSifLastDataTime: [{ dataReady: true, dataTime: "2026-09-21" }],
      asinOpTrafficTrend: trend,
      asinKeywordsSimpleGroupByWeekly: [{ asin, keyword: "sample", naturalRank: 2, spRank: 4 }],
      keywords: [{ keyword: "sample", kwSpScoreRatio: 30 }],
    }
    const sifSpy = jest
      .spyOn(axios, "request")
      .mockImplementation((options: AxiosRequestConfig) =>
        Promise.resolve({ data: { code: 1, data: responses[options.url!.split("/").at(-1)!] } })
      )
    const keepaSpy = jest.spyOn(axios, "get").mockImplementation((url: string) =>
      Promise.resolve({
        data: url.endsWith("/seller")
          ? { sellers: { seller1: { sellerName: "卖家" } } }
          : {
              products: [
                { asin, stats: { buyBoxSellerId: "seller1", current: [-1, -1, -1, -1, 1999] } },
              ],
            },
      })
    )
    const profile = await subject.collectModuleEvidence("US", [asin], "profile")
    const original = await subject.collectModuleEvidence("US", [asin], "pricePromo")
    expect(sifSpy).toHaveBeenCalledTimes(8)
    expect(keepaSpy).toHaveBeenCalledTimes(2)
    sifSpy.mockClear()
    keepaSpy.mockClear()
    const slimProfile = await subject.collectModuleEvidence("US", [asin], "profile")
    const slim = await subject.collectProductHistoryEvidence("US", asin)
    expect(sifSpy).toHaveBeenCalledTimes(5)
    expect(keepaSpy).toHaveBeenCalledTimes(1)
    expect(
      sifSpy.mock.calls.map(([options]) => String(options.url).split("/").at(-1)).sort()
    ).toEqual([
      "asinOpTrafficTrend",
      "asinsHistorySales",
      "batchAsinDetail",
      "batchAsinPrice",
      "getSifLastDataTime",
    ])
    expect(keepaSpy.mock.calls[0][0]).toBe("https://api.keepa.com/product")
    expect(slimProfile.callDetail).toEqual({ sif: 3 })
    expect(slim.callDetail).toEqual({ sif: 2, keepa: 1 })
    const before = assembleCompetitorAnalysis({
      ...profile,
      sif: { ...profile.sif, ...original.sif },
      keepa: original.keepa,
    })
    const after = assembleCompetitorAnalysis({
      ...slimProfile,
      sif: { ...slimProfile.sif, ...slim.sif },
      keepa: slim.keepa,
    })
    expect(after.profiles).toEqual(before.profiles)
    expect(after.pricePromoBoards[0].series).toEqual(before.pricePromoBoards[0].series)
    expect(after.pricePromoBoards[0].sop).toEqual(before.pricePromoBoards[0].sop)
  })

  it("运营详情只用一次商品身份查询，不加载售价和月销量", async () => {
    const subject = new CompetitorEvidenceProvider({
      get: (key: string, fallback?: string) => (key.endsWith("API_KEY") ? "test-key" : fallback),
    } as ConfigService)
    const spy = jest
      .spyOn(axios, "request")
      .mockResolvedValue({ data: { code: 1, data: [{ asin: "B0F15TM77B", title: "商品" }] } })
    const result = await subject.collectOperationProductEvidence("US", "B0F15TM77B")
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].url).toContain("/batchAsinDetail")
    expect(result.callDetail).toEqual({ sif: 1 })
    expect(result.sif).toEqual({ profile: [{ asin: "B0F15TM77B", title: "商品" }] })
  })

  it("牛牛历史SIF失败仍保留Keepa数据和成功调用计数", async () => {
    const subject = new CompetitorEvidenceProvider({
      get: (key: string, fallback?: string) => (key.endsWith("API_KEY") ? "test-key" : fallback),
    } as ConfigService)
    jest.spyOn(axios, "request").mockRejectedValue(new Error("timeout"))
    jest.spyOn(axios, "get").mockResolvedValue({ data: { products: [{ asin: "B0F15TM77B" }] } })
    const result = await subject.collectProductHistoryEvidence("US", "B0F15TM77B")
    expect(result.callDetail).toEqual({ sif: 0, keepa: 1 })
    expect(result.keepa).toEqual({ B0F15TM77B: { products: [{ asin: "B0F15TM77B" }] } })
    expect(result.sources).toContainEqual(
      expect.objectContaining({ provider: "sif", status: "failed" })
    )
  })

  it("牛牛历史查询Keepa失败时保留SIF历史，失败调用不计费", async () => {
    const subject = new CompetitorEvidenceProvider({
      get: (key: string, fallback?: string) => (key.endsWith("API_KEY") ? "test-key" : fallback),
    } as ConfigService)
    jest
      .spyOn(axios, "request")
      .mockResolvedValue({ data: { code: 1, data: { dates: ["2026-09-21"] } } })
    const keepaSpy = jest.spyOn(axios, "get").mockRejectedValue(new Error("timeout"))
    const result = await subject.collectProductHistoryEvidence("US", "B0F15TM77B")
    expect(result.callDetail).toEqual({ sif: 2, keepa: 0 })
    expect(result.sif.trafficTrends).toEqual({ B0F15TM77B: { dates: ["2026-09-21"] } })
    expect(result.keepa).toBeNull()
    expect(keepaSpy).toHaveBeenCalledTimes(1)
  })
})
