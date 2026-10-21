import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import {
  CompetitorAnalysisModuleId,
  CompetitorEvidenceBundle,
  CompetitorEvidenceSource,
} from "./competitor-analysis.types"

interface SifEnvelope {
  code?: number
  message?: string
  data?: unknown
}

const KEEPA_DOMAINS: Record<string, number> = {
  US: 1,
  UK: 2,
  DE: 3,
  FR: 4,
  JP: 5,
  CA: 6,
  IT: 8,
  ES: 9,
  MX: 11,
  BR: 12,
  AU: 13,
}

@Injectable()
export class CompetitorEvidenceProvider {
  private readonly logger = new Logger(CompetitorEvidenceProvider.name)
  private sellerSpriteClientPromise: Promise<Client> | null = null

  constructor(private readonly config: ConfigService) {}

  async collectEvidence(country: string, asins: string[]): Promise<CompetitorEvidenceBundle> {
    const [sifResult, sellerSpriteResult, keepaResult] = await Promise.allSettled([
      this._collectSifEvidence(country, asins),
      this._collectSellerSpriteEvidence(country, asins),
      this._collectKeepaEvidence(country, asins),
    ])

    const sources: CompetitorEvidenceSource[] = []
    const callDetail: Record<string, number> = {}
    const sif = this._settledValue(sifResult, "sif", sources)
    const sellerSprite = this._optionalSettledValue(sellerSpriteResult, "sellersprite", sources)
    const keepa = this._optionalSettledValue(keepaResult, "keepa", sources)

    if (sifResult.status === "fulfilled") callDetail.sif = sifResult.value.callCount
    if (sellerSpriteResult.status === "fulfilled" && sellerSpriteResult.value) {
      callDetail.sellersprite = sellerSpriteResult.value.callCount
    }
    if (keepaResult.status === "fulfilled" && keepaResult.value) {
      callDetail.keepa = keepaResult.value.callCount
    }

    return {
      country,
      asins,
      collectedAt: new Date().toISOString(),
      sif: sif.data,
      sellerSprite: sellerSprite?.data ?? null,
      keepa: keepa?.data ?? null,
      sources,
      callDetail,
    }
  }

  async collectModuleEvidence(
    country: string,
    asins: string[],
    module: CompetitorAnalysisModuleId
  ): Promise<CompetitorEvidenceBundle> {
    const sifPromise =
      module === "profile"
        ? this._collectSifProfileEvidence(country, asins)
        : module === "traffic"
          ? this._collectSifTrafficEvidence(country, asins)
          : this._collectSifPricePromoEvidence(country, asins)
    const sellerSpritePromise =
      module === "traffic"
        ? this._collectSellerSpriteEvidence(country, asins)
        : Promise.resolve(null)
    const keepaPromise =
      module === "pricePromo" ? this._collectKeepaEvidence(country, asins) : Promise.resolve(null)
    const [sifResult, sellerSpriteResult, keepaResult] = await Promise.allSettled([
      sifPromise,
      sellerSpritePromise,
      keepaPromise,
    ])
    const sources: CompetitorEvidenceSource[] = []
    const callDetail: Record<string, number> = {}
    const sif = this._settledValue(sifResult, "sif", sources)
    const sellerSprite =
      module === "traffic"
        ? this._optionalSettledValue(sellerSpriteResult, "sellersprite", sources)
        : null
    const keepa =
      module === "pricePromo" ? this._optionalSettledValue(keepaResult, "keepa", sources) : null

    callDetail.sif = sif.callCount
    if (sellerSprite) callDetail.sellersprite = sellerSprite.callCount
    if (keepa) callDetail.keepa = keepa.callCount

    return {
      country,
      asins,
      collectedAt: new Date().toISOString(),
      sif: sif.data,
      sellerSprite: sellerSprite?.data ?? null,
      keepa: keepa?.data ?? null,
      sources,
      callDetail,
    }
  }

  /** 运营详情只需商品身份与上架日期，不请求月销量和当前价格列表。 */
  async collectOperationProductEvidence(
    country: string,
    asin: string
  ): Promise<CompetitorEvidenceBundle> {
    const profile = await this._requestSif("/api/search/external/v2/batchAsinDetail", country, {
      method: "POST",
      body: { asins: [asin] },
    })
    return {
      country,
      asins: [asin],
      collectedAt: new Date().toISOString(),
      sif: { profile },
      keepa: null,
      sellerSprite: null,
      sources: [{ provider: "sif", status: "used", label: "SIF 商品资料" }],
      callDetail: { sif: 1 },
    }
  }

  /** 牛牛只展示历史曲线和甘特，不获取关键词列表或卖家详情；价格复用profile。 */
  async collectProductHistoryEvidence(
    country: string,
    asin: string
  ): Promise<CompetitorEvidenceBundle> {
    const [sifResult, keepaResult] = await Promise.allSettled([
      this._collectSifProductHistory(country, asin),
      this._collectKeepaEvidence(country, [asin], false),
    ])
    const sources: CompetitorEvidenceSource[] = []
    // 历史SIF失败时仍保留已取得的Keepa曲线，避免精简调用改变降级行为。
    const sif = sifResult.status === "fulfilled" ? sifResult.value : { data: {}, callCount: 0 }
    sources.push(
      sifResult.status === "fulfilled"
        ? { provider: "sif", status: "used", label: "SIF 竞品事实数据" }
        : {
            provider: "sif",
            status: "failed",
            label: "SIF 竞品事实数据",
            message: this._providerFailureMessage("sif", sifResult.reason),
          }
    )
    const keepa = this._optionalSettledValue(keepaResult, "keepa", sources)
    return {
      country,
      asins: [asin],
      collectedAt: new Date().toISOString(),
      sif: sif.data,
      keepa: keepa?.data ?? null,
      sellerSprite: null,
      sources,
      callDetail: { sif: sif.callCount, keepa: keepa?.callCount ?? 0 },
    }
  }

  private async _collectSifProductHistory(country: string, asin: string) {
    const readiness = await this._resolveSifReadyEndDate(country)
    const startDate = new Date(Date.parse(`${readiness.endDate}T00:00:00Z`) - 730 * 86_400_000)
      .toISOString()
      .slice(0, 10)
    const trend = await this._requestSif(
      "/api/search/external/v2/timeMachine/asinOpTrafficTrend",
      country,
      {
        method: "GET",
        query: { asin, startDate, endDate: readiness.endDate },
      }
    )
    return { data: { trafficTrends: { [asin]: trend } }, callCount: readiness.callCount + 1 }
  }

  private async _collectSifProfileEvidence(
    country: string,
    asins: string[]
  ): Promise<{ data: Record<string, unknown>; callCount: number }> {
    const values = await this._collectSifRequests([
      this._requestSif("/api/search/external/v2/batchAsinDetail", country, {
        method: "POST",
        body: { asins },
      }),
      this._requestSif("/api/search/external/v2/batchAsinPrice", country, {
        method: "POST",
        body: { asinList: asins, days: 365 },
      }),
      this._requestSif("/api/search/external/v2/asinsHistorySales", country, {
        method: "POST",
        body: { asins, month: 7 },
      }),
    ])
    return {
      data: { profile: values.data[0], price: values.data[1], monthlySales: values.data[2] },
      callCount: values.callCount,
    }
  }

  private async _collectSifTrafficEvidence(
    country: string,
    asins: string[]
  ): Promise<{ data: Record<string, unknown>; callCount: number }> {
    const requests = [
      this._requestSif("/api/search/external/v2/asinKeywordsSimpleGroupByMonthly", country, {
        method: "POST",
        body: {
          asinList: asins,
          last30d: true,
          sortBy: "totalScore",
          desc: true,
          pageNum: 1,
          pageSize: 1000,
        },
      }),
      this._requestSif("/api/search/external/v2/asinSummaryCompareGroupByMonthly", country, {
        method: "POST",
        body: { asins },
      }),
      ...asins.map(asin =>
        this._requestSif("/api/search/external/v2/ad/keywords", country, {
          method: "POST",
          body: { asin },
        })
      ),
    ]
    const values = await this._collectSifRequests(requests)
    const reverseRows = this._sifRows(values.data[0])
    const competeValues = await this._collectSifRequests(
      asins.map(asin => {
        const keywords = reverseRows
          .filter(row => typeof row.asin === "string" && row.asin.toUpperCase() === asin)
          .map(row => (typeof row.keyword === "string" ? row.keyword.trim() : ""))
          .filter(Boolean)
          .slice(0, 10)
        return keywords.length
          ? this._requestSif(
              "/api/search/external/v2/competePatternFlexibleGroupByWeekly",
              country,
              { method: "POST", body: { keywords, asins: [asin] } }
            )
          : Promise.resolve({ list: [] })
      })
    )
    return {
      data: {
        keywords: values.data[0],
        trafficSummary: values.data[1],
        adKeywords: Object.fromEntries(asins.map((asin, index) => [asin, values.data[index + 2]])),
        competePatterns: Object.fromEntries(
          asins.map((asin, index) => [asin, competeValues.data[index]])
        ),
      },
      callCount: values.callCount + competeValues.callCount,
    }
  }

  private async _collectSifPricePromoEvidence(
    country: string,
    asins: string[]
  ): Promise<{ data: Record<string, unknown>; callCount: number }> {
    const readiness = await this._resolveSifReadyEndDate(country)
    const endTimestamp = Date.parse(`${readiness.endDate}T00:00:00Z`)
    const startDate = new Date(endTimestamp - 730 * 86_400_000).toISOString().slice(0, 10)
    const endDate = readiness.endDate
    const values = await this._collectSifRequests([
      this._requestSif("/api/search/external/v2/batchAsinPrice", country, {
        method: "POST",
        body: { asinList: asins, days: 365 },
      }),
      this._requestSif("/api/search/external/v2/asinKeywordsSimpleGroupByWeekly", country, {
        method: "POST",
        body: {
          asinList: asins,
          last7d: true,
          sortBy: "totalScore",
          desc: true,
          pageNum: 1,
          pageSize: 1000,
        },
      }),
      ...asins.map(asin =>
        this._requestSif("/api/search/external/v2/timeMachine/asinOpTrafficTrend", country, {
          method: "GET",
          query: { asin, startDate, endDate },
        })
      ),
      ...asins.map(asin =>
        this._requestSif("/api/search/external/v2/ad/keywords", country, {
          method: "POST",
          body: { asin },
        })
      ),
    ])
    const trendStartIndex = 2
    const adKeywordStartIndex = trendStartIndex + asins.length
    return {
      data: {
        price: values.data[0],
        keywordTrends: values.data[1],
        trafficTrends: Object.fromEntries(
          asins.map((asin, index) => [asin, values.data[trendStartIndex + index]])
        ),
        adKeywords: Object.fromEntries(
          asins.map((asin, index) => [asin, values.data[adKeywordStartIndex + index]])
        ),
      },
      callCount: values.callCount + readiness.callCount,
    }
  }

  private async _resolveSifReadyEndDate(
    country: string
  ): Promise<{ endDate: string; callCount: number }> {
    const fallbackDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    try {
      const readiness = await this._requestSif(
        "/api/search/external/v2/getSifLastDataTime",
        country,
        { method: "GET" }
      )
      const readyDates = this._sifRows(readiness)
        .filter(row => row.dataReady === true)
        .map(row => (typeof row.dataTime === "string" ? row.dataTime.slice(0, 10) : ""))
        .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .sort()
      return { endDate: readyDates.at(-1) ?? fallbackDate, callCount: 1 }
    } catch (error) {
      this.logger.warn(`SIF 数据就绪检查降级 message=${this._errorMessage(error)}`)
      return { endDate: fallbackDate, callCount: 0 }
    }
  }

  private async _collectSifRequests(
    requests: Array<Promise<unknown>>
  ): Promise<{ data: unknown[]; callCount: number }> {
    const settled = await Promise.allSettled(requests)
    if (settled.every(result => result.status === "rejected")) {
      throw new ServiceUnavailableException(
        this._providerFailureMessage("sif", this._preferredFailureReason(settled))
      )
    }
    return {
      data: settled.map(result =>
        result.status === "fulfilled"
          ? result.value
          : { error: result.reason instanceof Error ? result.reason.message : "SIF 请求失败" }
      ),
      callCount: settled.filter(result => result.status === "fulfilled").length,
    }
  }

  private async _collectSifEvidence(
    country: string,
    asins: string[]
  ): Promise<{ data: Record<string, unknown>; callCount: number }> {
    const apiKey = this.config.get<string>("SIF_API_KEY")?.trim()
    if (!apiKey) throw new ServiceUnavailableException("SIF_API_KEY 未配置")

    const readiness = await this._resolveSifReadyEndDate(country)
    const endDate = readiness.endDate
    const endTimestamp = Date.parse(`${endDate}T00:00:00Z`)
    const startDate = new Date(endTimestamp - 730 * 86_400_000).toISOString().slice(0, 10)
    const requests: Array<Promise<unknown>> = [
      this._requestSif("/api/search/external/v2/batchAsinDetail", country, {
        method: "POST",
        body: { asins },
      }),
      this._requestSif("/api/search/external/v2/asinKeywordsSimpleGroupByMonthly", country, {
        method: "POST",
        body: {
          asinList: asins,
          last30d: true,
          sortBy: "totalScore",
          desc: true,
          pageNum: 1,
          pageSize: 1000,
        },
      }),
      this._requestSif("/api/search/external/v2/batchAsinPrice", country, {
        method: "POST",
        body: { asinList: asins, days: 365 },
      }),
      this._requestSif("/api/search/external/v2/asinsHistorySales", country, {
        method: "POST",
        body: { asins, month: 7 },
      }),
      this._requestSif("/api/search/external/v2/asinSummaryCompareGroupByMonthly", country, {
        method: "POST",
        body: { asins },
      }),
      ...asins.map(asin =>
        this._requestSif("/api/search/external/v2/timeMachine/asinOpTrafficTrend", country, {
          method: "GET",
          query: { asin, startDate, endDate },
        })
      ),
      ...asins.map(asin =>
        this._requestSif("/api/search/external/v2/ad/keywords", country, {
          method: "POST",
          body: { asin },
        })
      ),
    ]
    const settled = await Promise.allSettled(requests)
    const values = settled.map(result =>
      result.status === "fulfilled"
        ? result.value
        : { error: result.reason instanceof Error ? result.reason.message : "SIF 请求失败" }
    )
    if (settled.every(result => result.status === "rejected")) {
      throw new ServiceUnavailableException(
        this._providerFailureMessage("sif", this._preferredFailureReason(settled))
      )
    }

    const trendStartIndex = 5
    const adKeywordStartIndex = trendStartIndex + asins.length
    const reverseRows = this._sifRows(values[1])
    const competeRequests = asins.map(asin => {
      const keywords = reverseRows
        .filter(row => typeof row.asin === "string" && row.asin.toUpperCase() === asin)
        .map(row => (typeof row.keyword === "string" ? row.keyword.trim() : ""))
        .filter(Boolean)
        .slice(0, 10)
      return keywords.length
        ? this._requestSif("/api/search/external/v2/competePatternFlexibleGroupByWeekly", country, {
            method: "POST",
            body: { keywords, asins: [asin] },
          })
        : Promise.resolve({ list: [] })
    })
    const competeSettled = await Promise.allSettled(competeRequests)
    const competeValues = competeSettled.map(result =>
      result.status === "fulfilled"
        ? result.value
        : { error: result.reason instanceof Error ? result.reason.message : "SIF 请求失败" }
    )

    return {
      data: {
        profile: values[0],
        keywords: values[1],
        price: values[2],
        monthlySales: values[3],
        trafficSummary: values[4],
        trafficTrends: Object.fromEntries(
          asins.map((asin, index) => [asin, values[trendStartIndex + index]])
        ),
        adKeywords: Object.fromEntries(
          asins.map((asin, index) => [asin, values[adKeywordStartIndex + index]])
        ),
        competePatterns: Object.fromEntries(
          asins.map((asin, index) => [asin, competeValues[index]])
        ),
      },
      callCount:
        readiness.callCount +
        settled.filter(result => result.status === "fulfilled").length +
        competeSettled.filter(result => result.status === "fulfilled").length,
    }
  }

  private async _requestSif(
    path: string,
    country: string,
    options: {
      method: "GET" | "POST"
      body?: Record<string, unknown>
      query?: Record<string, string>
    }
  ): Promise<unknown> {
    const apiKey = this.config.get<string>("SIF_API_KEY")?.trim()
    if (!apiKey) {
      throw new ServiceUnavailableException("SIF 凭证未配置或已失效，请联系管理员")
    }
    const baseUrl = this.config
      .get<string>("SIF_API_BASE_URL", "https://www.sif.com")
      .replace(/\/+$/, "")
    const response = await axios.request<SifEnvelope>({
      url: `${baseUrl}${path}`,
      method: options.method,
      params: { country, ...(options.query ?? {}) },
      data: options.body,
      headers: { authorization: apiKey, "Content-Type": "application/json" },
      timeout: 45_000,
    })
    if (response.data.code !== 1) {
      throw new Error(response.data.message?.trim() || `SIF 返回错误 code=${response.data.code}`)
    }
    return response.data.data
  }

  private async _collectSellerSpriteEvidence(
    country: string,
    asins: string[]
  ): Promise<{ data: Record<string, unknown>; callCount: number } | null> {
    const secretKey = this.config.get<string>("SELLERSPRITE_SECRET_KEY")?.trim()
    if (!secretKey) return null
    if (["AE", "BR", "SA"].includes(country)) return null

    const client = await this._getSellerSpriteClient(secretKey)
    const tools = await client.listTools()
    const competitorTool =
      tools.tools.find(tool => tool.name === "competitor_lookup")?.name ??
      tools.tools.find(tool => tool.name.includes("competitor") && tool.name.includes("lookup"))
        ?.name
    const month = this._previousMonth()
    const calls = [
      ...(competitorTool
        ? [
            client.callTool({
              name: competitorTool,
              arguments: {
                request: {
                  marketplace: country,
                  month,
                  asins,
                  variation: "Y",
                  page: 1,
                  size: asins.length,
                },
              },
            }),
          ]
        : []),
      ...asins.flatMap(asin => [
        client.callTool({
          name: "traffic_keyword",
          arguments: {
            request: {
              marketplace: country,
              asin,
              month,
              page: 1,
              size: 50,
              order: { field: "trafficPercentage", desc: true },
            },
          },
        }),
        client.callTool({ name: "asin_coupon_trend", arguments: { marketplace: country, asin } }),
        client.callTool({
          name: "asin_prediction",
          arguments: { request: { marketplace: country, asin } },
        }),
      ]),
    ]
    const settled = await Promise.allSettled(calls)
    const normalized = settled.map(result => {
      if (result.status === "rejected") {
        return { success: false as const, error: result.reason as unknown }
      }
      const error = this._mcpErrorMessage(result.value)
      return error
        ? { success: false as const, error: new Error(error) }
        : { success: true as const, data: this._mcpContent(result.value) }
    })
    if (normalized.every(result => !result.success)) {
      throw new ServiceUnavailableException(
        this._providerFailureMessage(
          "sellersprite",
          this._preferredError(normalized.flatMap(result => (result.success ? [] : [result.error])))
        )
      )
    }
    const values = normalized.map(result =>
      result.success ? result.data : { error: this._errorMessage(result.error) }
    )
    return {
      data: { month, results: values },
      callCount: normalized.filter(result => result.success).length,
    }
  }

  private async _getSellerSpriteClient(secretKey: string): Promise<Client> {
    if (this.sellerSpriteClientPromise) return this.sellerSpriteClientPromise
    this.sellerSpriteClientPromise = (async () => {
      const url = this.config.get<string>(
        "SELLERSPRITE_MCP_URL",
        "https://mcp.sellersprite.com/mcp"
      )
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { "secret-key": secretKey } },
      })
      const client = new Client({ name: "selleros-api", version: "1.0.0" })
      await client.connect(transport)
      return client
    })().catch(error => {
      this.sellerSpriteClientPromise = null
      throw error
    })
    return this.sellerSpriteClientPromise
  }

  private async _collectKeepaEvidence(
    country: string,
    asins: string[],
    shouldIncludeSeller = true
  ): Promise<{ data: Record<string, unknown>; callCount: number } | null> {
    const apiKey = this.config.get<string>("KEEPA_API_KEY")?.trim()
    const domain = KEEPA_DOMAINS[country]
    if (!apiKey || !domain) return null
    const baseUrl = this.config.get<string>("KEEPA_API_BASE_URL", "https://api.keepa.com")
    const settled = await Promise.allSettled(
      asins.map(async asin => {
        const response = await axios.get(`${baseUrl.replace(/\/+$/, "")}/product`, {
          params: {
            key: apiKey,
            domain,
            asin,
            stats: 30,
            history: 1,
            offers: 20,
            rating: 1,
            stock: 1,
          },
          timeout: 45_000,
        })
        const productEnvelope = this._keepaEnvelope(response.data)
        if (!shouldIncludeSeller) return { data: productEnvelope, callCount: 1 }
        const product = this._keepaProducts(productEnvelope)[0]
        const sellerId = this._keepaBuyBoxSellerId(product)
        if (!sellerId) return { data: productEnvelope, callCount: 1 }
        try {
          const sellerResponse = await axios.get(`${baseUrl.replace(/\/+$/, "")}/seller`, {
            params: { key: apiKey, domain, seller: sellerId },
            timeout: 45_000,
          })
          const sellerEnvelope = this._keepaEnvelope(sellerResponse.data)
          return {
            data: { ...productEnvelope, sellers: sellerEnvelope.sellers ?? {} },
            callCount: 2,
          }
        } catch (error) {
          this.logger.warn(
            `Keepa Buy Box 卖家详情降级 asin=${asin} message=${this._errorMessage(error)}`
          )
          return { data: productEnvelope, callCount: 1 }
        }
      })
    )
    if (settled.every(result => result.status === "rejected")) {
      throw new ServiceUnavailableException(
        this._providerFailureMessage("keepa", this._preferredFailureReason(settled))
      )
    }
    return {
      data: Object.fromEntries(
        asins.map((asin, index) => [
          asin,
          settled[index].status === "fulfilled"
            ? settled[index].value.data
            : { error: "Keepa 请求失败" },
        ])
      ),
      callCount: settled.reduce(
        (total, result) => total + (result.status === "fulfilled" ? result.value.callCount : 0),
        0
      ),
    }
  }

  private _keepaEnvelope(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Keepa 返回格式无效")
    }
    const envelope = value as Record<string, unknown>
    const error = envelope.error
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message
      throw new Error(typeof message === "string" && message.trim() ? message : "Keepa 请求失败")
    }
    return envelope
  }

  private _keepaProducts(envelope: Record<string, unknown>): Array<Record<string, unknown>> {
    return Array.isArray(envelope.products)
      ? envelope.products.filter(
          (product): product is Record<string, unknown> =>
            Boolean(product) && typeof product === "object" && !Array.isArray(product)
        )
      : []
  }

  private _keepaBuyBoxSellerId(product: Record<string, unknown> | undefined): string | null {
    if (!product || !product.stats || typeof product.stats !== "object") return null
    const sellerId = (product.stats as Record<string, unknown>).buyBoxSellerId
    if (typeof sellerId !== "string" || !sellerId || sellerId === "-1" || sellerId === "-2") {
      return null
    }
    return sellerId
  }

  private _mcpContent(value: unknown): unknown {
    if (!value || typeof value !== "object") return value
    const content = (value as { content?: unknown }).content
    if (!Array.isArray(content)) return value
    const text = content
      .filter(
        item => item && typeof item === "object" && (item as { type?: unknown }).type === "text"
      )
      .map(item => (item as { text?: unknown }).text)
      .filter((item): item is string => typeof item === "string")
      .join("")
    if (!text) return value
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  private _sifRows(value: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(value)) {
      return value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    }
    if (!value || typeof value !== "object") return []
    const list = (value as { list?: unknown }).list
    return Array.isArray(list)
      ? list.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item)
        )
      : []
  }

  private _previousMonth(): string {
    // YearMonth 减一月（不做日算术，避免 setUTCMonth 月末溢出：如 3/31 → 3/3）
    const now = new Date()
    const y = now.getUTCFullYear()
    const m = now.getUTCMonth() // 0-11
    return m === 0 ? `${y - 1}12` : `${y}${String(m).padStart(2, "0")}`
  }

  private _settledValue(
    result: PromiseSettledResult<{ data: Record<string, unknown>; callCount: number }>,
    provider: "sif",
    sources: CompetitorEvidenceSource[]
  ): { data: Record<string, unknown>; callCount: number } {
    if (result.status === "fulfilled") {
      sources.push({ provider, status: "used", label: "SIF 竞品事实数据" })
      return result.value
    }
    const rawMessage = this._errorMessage(result.reason)
    const message = this._providerFailureMessage(provider, result.reason)
    this.logger.error(`竞品数据获取失败 provider=${provider} message=${rawMessage}`)
    throw new ServiceUnavailableException(message)
  }

  private _optionalSettledValue(
    result: PromiseSettledResult<{ data: Record<string, unknown>; callCount: number } | null>,
    provider: "sellersprite" | "keepa",
    sources: CompetitorEvidenceSource[]
  ): { data: Record<string, unknown>; callCount: number } | null {
    if (result.status === "rejected") {
      const rawMessage = this._errorMessage(result.reason)
      const message = this._providerFailureMessage(provider, result.reason)
      this.logger.warn(`竞品数据降级 provider=${provider} message=${rawMessage}`)
      sources.push({
        provider,
        status: "failed",
        label: this._sourceLabel(provider),
        message,
        retryable: !message.includes("凭证") && !message.includes("配额"),
      })
      return null
    }
    if (!result.value) {
      sources.push({
        provider,
        status: "not_configured",
        label: this._sourceLabel(provider),
        message: `${this._providerName(provider)} 未配置，相关补充数据未启用`,
        retryable: false,
      })
      return null
    }
    sources.push({ provider, status: "used", label: this._sourceLabel(provider) })
    return result.value
  }

  private _sourceLabel(provider: "sellersprite" | "keepa"): string {
    return provider === "sellersprite" ? "卖家精灵竞品数据" : "Keepa 历史数据"
  }

  private _mcpErrorMessage(value: unknown): string | null {
    if (!value || typeof value !== "object" || (value as { isError?: unknown }).isError !== true) {
      return null
    }
    const content = (value as { content?: unknown }).content
    if (!Array.isArray(content)) return "卖家精灵请求失败"
    const message = content
      .filter(
        item => item && typeof item === "object" && (item as { type?: unknown }).type === "text"
      )
      .map(item => (item as { text?: unknown }).text)
      .filter((item): item is string => typeof item === "string")
      .join(" ")
      .trim()
    return message || "卖家精灵请求失败"
  }

  private _providerName(provider: "sif" | "sellersprite" | "keepa"): string {
    if (provider === "sif") return "SIF"
    return provider === "sellersprite" ? "卖家精灵" : "Keepa"
  }

  private _preferredFailureReason(results: PromiseSettledResult<unknown>[]): unknown {
    const reasons = results.flatMap(result =>
      result.status === "rejected" ? [result.reason as unknown] : []
    )
    return this._preferredError(reasons)
  }

  private _preferredError(reasons: unknown[]): unknown {
    return (
      reasons.find(reason =>
        /配额|quota|credit|rate.?limit|次数.*(?:用完|不足|超限)/i.test(this._errorMessage(reason))
      ) ??
      reasons.find(reason =>
        /未配置|api.?key|secret|unauthorized|forbidden|401|403|鉴权|认证|密钥|无权限/i.test(
          this._errorMessage(reason)
        )
      ) ??
      reasons[0]
    )
  }

  private _providerFailureMessage(
    provider: "sif" | "sellersprite" | "keepa",
    error: unknown
  ): string {
    const providerName = this._providerName(provider)
    const message = this._errorMessage(error)
    if (/配额|quota|credit|rate.?limit|too many requests|次数.*(?:用完|不足|超限)/i.test(message)) {
      return `${providerName} 配额已用完，请联系管理员补充额度`
    }
    if (
      /未配置|api.?key|secret|unauthorized|forbidden|401|403|鉴权|认证|密钥|无权限/i.test(message)
    ) {
      return `${providerName} 凭证未配置或已失效，请联系管理员`
    }
    if (/timeout|timed out|etimedout|econnaborted|超时/i.test(message)) {
      return `${providerName} 响应超时，请稍后重试`
    }
    if (
      /network|econn|socket|dns|502|503|504|service unavailable|请求失败|获取失败/i.test(message)
    ) {
      return `${providerName} 服务暂不可用，请稍后重试`
    }
    return `${providerName} 服务异常，请稍后重试`
  }

  private _errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim() ? error.message.trim() : "请求失败"
  }
}
