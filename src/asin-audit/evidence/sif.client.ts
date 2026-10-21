import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import type {
  SifAsinKeywordsMonthlyData,
  SifAsinOpTrafficTrendData,
  SifBatchAsinDetailResult,
  SifBatchAsinPriceData,
  SifKeywordOverviewRow,
  SifLastDataTimeData,
  SifVariantLastSalesRow,
} from "../types/sif.types"
import { memoizeByKey } from "./memoize"

/**
 * SIF 取证客户端（Nest 化，等价迁移交付包 server/sif/{config,client,api}.ts）。
 * 鉴权：`authorization: <SIF_API_KEY>` 原值无 Bearer；country 放 URL Query；
 * 业务成功 code===1（-1 参数/-20 配额/-22 限流/-25 未分配）；1h 缓存、失败不缓存。
 * env 兼容：SIF_BASE_URL 优先，兼容旧名 SIF_API_BASE_URL；未配置时接口运行时明确报错
 * （env.validation 不硬性必配——视频-only 环境要能启动）。
 */

export const SIF_CODE = {
  OK: 1,
  PARAM: -1,
  QUOTA_EXHAUSTED: -20,
  RATE_LIMIT: -22,
  QUOTA_NOT_ALLOCATED: -25,
} as const

export type SifCountry =
  "US" | "UK" | "DE" | "CA" | "JP" | "FR" | "ES" | "IT" | "MX" | "AU" | "AE" | "BR" | "SA"

const VALID_COUNTRIES = new Set<string>([
  "US",
  "UK",
  "DE",
  "CA",
  "JP",
  "FR",
  "ES",
  "IT",
  "MX",
  "AU",
  "AE",
  "BR",
  "SA",
])

export class SifApiError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = "SifApiError"
    this.code = code
  }
}

export function sifCodeMessage(code: number): string {
  const map: Record<string, string> = {
    [String(SIF_CODE.PARAM)]: "参数错误",
    [String(SIF_CODE.QUOTA_EXHAUSTED)]: "API 配额已用完",
    [String(SIF_CODE.RATE_LIMIT)]: "访问过于频繁，请稍后重试",
    [String(SIF_CODE.QUOTA_NOT_ALLOCATED)]: "API 未分配配额",
  }
  return map[String(code)] ?? "未知错误"
}

const SIF_CACHE_TTL_MS = 60 * 60 * 1000 // 1h — 降低重复审计的配额消耗

interface SifEnvelope<T> {
  code: number
  message?: string
  data: T
}

@Injectable()
export class SifClient {
  private readonly logger = new Logger(SifClient.name)

  constructor(private readonly config: ConfigService) {}

  private apiKey(): string {
    const key = this.config.get<string>("SIF_API_KEY")?.trim()
    if (!key) throw new SifApiError(-1, "SIF_API_KEY 未配置")
    return key
  }

  private baseUrl(): string {
    const base =
      this.config.get<string>("SIF_BASE_URL")?.trim() ||
      this.config.get<string>("SIF_API_BASE_URL")?.trim() || // 兼容竞品分析的旧 env 名
      "https://www.sif.com"
    return base.replace(/\/$/, "")
  }

  private normalizeCountry(input: string | undefined): SifCountry {
    const c =
      input?.trim().toUpperCase() ||
      this.config.get<string>("SIF_DEFAULT_COUNTRY")?.trim().toUpperCase() ||
      "US"
    if (!VALID_COUNTRIES.has(c)) {
      throw new SifApiError(-1, `不支持的 SIF 站点 country: ${c}`)
    }
    return c as SifCountry
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST"
      country?: string
      body?: unknown
      query?: Record<string, string | number | boolean | undefined | null>
    } = {}
  ): Promise<T> {
    const method = options.method ?? "POST"
    const country = this.normalizeCountry(options.country)
    const params = new URLSearchParams({ country })
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null && v !== "") params.set(k, String(v))
      }
    }
    const sep = path.includes("?") ? "&" : "?"
    const url = `${this.baseUrl()}${path}${sep}${params.toString()}`

    const headers: Record<string, string> = { authorization: this.apiKey() }
    const init: RequestInit = { method, headers }
    if (options.body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json"
      init.body = JSON.stringify(options.body)
    }

    const resp = await fetch(url, init)
    let json: SifEnvelope<T>
    try {
      json = (await resp.json()) as SifEnvelope<T>
    } catch {
      throw new SifApiError(-1, `SIF 响应非 JSON（HTTP ${resp.status}）`)
    }
    if (json.code !== SIF_CODE.OK) {
      const msg = json.message?.trim() || sifCodeMessage(json.code)
      throw new SifApiError(json.code, `SIF API 错误 ${json.code}：${msg}`)
    }
    return json.data
  }

  private cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return memoizeByKey(key, fn, SIF_CACHE_TTL_MS)
  }

  /** 数据就绪状态检查（granularity 取证链固定 last_30d） */
  getLastDataTime(country: string, granularity = "last_30d"): Promise<SifLastDataTimeData> {
    return this.cached(`sif:lastDataTime:${country}:${granularity}`, () =>
      this.request<SifLastDataTimeData>("/api/search/external/v2/getSifLastDataTime", {
        method: "GET",
        country,
        query: { granularity },
      })
    )
  }

  /** ASIN 反查流量词-按月（近30天核心流量词），取证主请求 */
  asinKeywordsMonthly(
    country: string,
    asinList: string[],
    opts: { last30d?: boolean } = {}
  ): Promise<SifAsinKeywordsMonthlyData> {
    return this.cached(
      `sif:kwMonthly:${country}:${asinList.join(",")}:${JSON.stringify(opts)}`,
      () =>
        this.request<SifAsinKeywordsMonthlyData>(
          "/api/search/external/v2/asinKeywordsSimpleGroupByMonthly",
          {
            country,
            body: {
              asinList,
              last30d: opts.last30d ?? true,
              sortBy: "totalScore",
              desc: true,
              pageNum: 1,
              pageSize: 10000,
            },
          }
        )
    )
  }

  /** 批量关键词搜索量概览 */
  batchKeywordOverview(country: string, keywords: string[]): Promise<SifKeywordOverviewRow[]> {
    return this.cached(`sif:kwOverview:${country}:${keywords.join("|")}`, () =>
      this.request<SifKeywordOverviewRow[]>("/api/search/external/v2/batchKeywordSimpleOverview", {
        country,
        body: { keywords },
      })
    )
  }

  /** 近月前台购买量 */
  variantLastSales(country: string, asin: string): Promise<SifVariantLastSalesRow[]> {
    return this.cached(`sif:variantSales:${country}:${asin}`, () =>
      this.request<SifVariantLastSalesRow[]>("/api/search/external/v2/variantLastSales", {
        method: "GET",
        country,
        query: { asin },
      })
    )
  }

  /** 价格/coupon/上架日期（365 天） */
  batchAsinPrice(country: string, asinList: string[], days = 365): Promise<SifBatchAsinPriceData> {
    return this.cached(`sif:asinPrice:${country}:${asinList.join(",")}:${days}`, () =>
      this.request<SifBatchAsinPriceData>("/api/search/external/v2/batchAsinPrice", {
        country,
        body: { asinList, days },
      })
    )
  }

  /** ASIN 详情批量（title/brand/bsrList 等），C 卡竞品过滤的目标参照 */
  batchAsinDetail(country: string, asins: string[]): Promise<SifBatchAsinDetailResult> {
    return this.cached(`sif:asinDetail:${country}:${asins.join(",")}`, () =>
      this.request<SifBatchAsinDetailResult>("/api/search/external/v2/batchAsinDetail", {
        country,
        body: { asins },
      })
    )
  }

  /** BSR/运营趋势（近 30 天） */
  asinOpTrafficTrend(
    country: string,
    asin: string,
    startDate: string,
    endDate: string
  ): Promise<SifAsinOpTrafficTrendData> {
    return this.cached(`sif:trafficTrend:${country}:${asin}:${startDate}:${endDate}`, () =>
      this.request<SifAsinOpTrafficTrendData>(
        "/api/search/external/v2/timeMachine/asinOpTrafficTrend",
        {
          method: "GET",
          country,
          query: { asin, startDate, endDate },
        }
      )
    )
  }
}
