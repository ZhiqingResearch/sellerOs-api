import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"

// ==================== 类型 ====================

export interface AmazonProductData {
  platform: "amazon"
  marketplace: string
  productId: string
  url: string
  fetchAt: string
  title: string
  brand?: string
  bullets?: string[]
  description?: string[]
  backendKeywords?: string[]
  price?: string
  priceValue?: string
  currency?: string
  rating?: string | number
  reviewCount?: string | number
  imageCount?: number
  imageUrl?: string
  nodeLabelPath?: string
  nodeIdPath?: string
  bsr?: string
  lqs?: number | null
  overviews?: Record<string, unknown>
  variations?: number
  sellers?: unknown
  fulfillment?: string
}

export interface WalmartProductData {
  platform: "walmart"
  marketplace: string
  productId: string
  url: string
  fetchAt: string
  title: string
  brand?: string
  keyFeatures?: string[]
  description?: string
  price?: string
  priceValue?: string
  currency?: string
  rating?: string | number
  reviewCount?: string | number
  imageCount?: number
  imageUrl?: string
  category?: unknown
  categoryPath?: unknown
  productAttributes?: unknown[]
}

export interface MarketplaceProductData {
  platform: "ozon" | "wildberries" | "gigacloud"
  marketplace: string
  productId: string
  url: string
  fetchAt: string
  title: string
  brand?: string
  bullets?: string[]
  description?: string | string[]
  price?: string
  priceValue?: string
  currency?: string
  rating?: string | number
  reviewCount?: string | number
  imageCount?: number
  imageUrl?: string
  category?: unknown
  categoryPath?: unknown
  productAttributes?: unknown[]
  extra?: Record<string, unknown>
}

interface TikTokShopReview {
  rating: string | number | null
  text: string
  author: string | null
  date: string | null
}

interface TikTokShopSku {
  skuId: string | null
  price: string | null
  stock: number | null
}

export interface TikTokShopProductData {
  platform: "tiktokshop"
  marketplace: string
  productId: string
  url: string
  fetchAt: string
  title: string
  brand?: string
  bullets?: string[]
  description?: string
  price?: string
  priceValue?: string
  currency?: string
  rating?: string | number
  reviewCount?: string | number
  imageCount?: number
  imageUrl?: string
  otherImagesUrl?: string[]
  videoUrl?: string[]
  categoryPath?: string
  aplus?: string[]
  review?: TikTokShopReview[]
  product_information?: string[][]
  bsr?: string | null
  fulfillment?: string | null
  extra?: {
    soldCount: number | null
    stock: number | null
    originalPrice: string | null
    discount: string | null
    sellerId: string | null
    sellerName: string | null
    sellerRating: string | number | null
    sellerLocation: string | null
    categoryId: string | null
    skus: TikTokShopSku[]
    salePropNames: string[]
    aplusImageCount: number
  }
}

export type RawProductData =
  | AmazonProductData
  | WalmartProductData
  | MarketplaceProductData
  | TikTokShopProductData

/** 审计爬虫返回（契约待确认，先用宽松 Json；含 qa/review/product_information_hhl 等富字段） */
export type RawAuditData = Record<string, unknown>

/** 审计爬虫端点路径（契约确认后改） */
const AUDIT_PATH = "/audit"

/** 爬虫成功包络：{ code: 200, data: {...}, msg: "成功" } */
export interface CrawlerSuccessEnvelope {
  code: number
  data: RawProductData
  msg?: string
}

/** 爬虫失败包络：{ error: { code, message } } */
export interface CrawlerErrorBody {
  error: { code: string; message: string }
}

export class CrawlerError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "CrawlerError"
  }
}

// ==================== Provider ====================

@Injectable()
export class CrawlerProvider {
  private readonly logger = new Logger(CrawlerProvider.name)

  constructor(private readonly config: ConfigService) {}

  /** 调爬虫 PDP 接口；爬虫返回 { error } 时抛 CrawlerError，5xx 也抛 CrawlerError */
  async fetchPdp(url: string): Promise<RawProductData> {
    const start = Date.now()
    const resp = await this.post("/pdp", url)
    return this.parseEnvelope<RawProductData>(resp.status, resp.data, "pdp", url, start)
  }

  /** 调审计爬虫接口（返回含 qa/review/product_information_hhl 等富字段）；信封解析同 fetchPdp */
  async fetchAudit(url: string): Promise<RawAuditData> {
    const start = Date.now()
    const resp = await this.post(AUDIT_PATH, url)
    // 审计兜底按 HTTP 失败触发，不能被异常服务的 code:200 信封掩盖。
    if (resp.status < 200 || resp.status >= 300) {
      throw new CrawlerError(`UPSTREAM_HTTP_${resp.status}`, "商品详情数据源暂不可用")
    }
    return this.parseEnvelope<RawAuditData>(resp.status, resp.data, "audit", url, start)
  }

  /** 统一向爬虫服务 POST { url }（Bearer + 60s 超时 + 所有状态码都解析 body）。 */
  private post(path: string, url: string) {
    const baseUrl = this.config.get<string>("CRAWLER_API_BASE_URL", "http://47.108.114.243:6666")
    const token = this.config.get<string>("CRAWLER_API_TOKEN", "")
    return axios.post<unknown>(
      `${baseUrl}${path}`,
      { url },
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        timeout: 60_000,
        validateStatus: () => true,
      }
    )
  }

  /**
   * 爬虫响应信封解析（pdp / audit 共用）：5xx → UPSTREAM_5XX；{ error:{code,message} } → 该错误；
   * { code:200, data } → data，非 200 / 缺 data → 错误；其余 → MALFORMED_RESPONSE。
   */
  private parseEnvelope<T>(
    status: number,
    body: unknown,
    label: string,
    url: string,
    start: number
  ): T {
    if (status >= 500) {
      throw new CrawlerError("UPSTREAM_5XX", `爬虫服务返回 ${status}`)
    }
    if (body && typeof body === "object" && "error" in body) {
      const err = (body as CrawlerErrorBody).error
      if (err) throw new CrawlerError(err.code, err.message)
    }
    if (body && typeof body === "object" && "code" in body) {
      const env = body as { code: number; data?: T; msg?: string }
      if (env.code !== 200 || !env.data) {
        throw new CrawlerError(String(env.code ?? "UNKNOWN"), env.msg ?? "爬虫返回非 200")
      }
      this.logger.log(`${label} ok url=${url} ms=${Date.now() - start}`)
      return env.data
    }
    throw new CrawlerError("MALFORMED_RESPONSE", "爬虫响应格式异常")
  }
}
