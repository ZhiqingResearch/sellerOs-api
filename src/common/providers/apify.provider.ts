import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import {
  Country,
  parseAmazonAuditTarget,
  type AmazonAuditTarget,
} from "../../audit/audit.marketplace"
import { adaptAmazonAuditResults, adaptAmazonReviewResults } from "./amazon-audit.adapter"
import type { RawAuditData } from "./crawler.provider"

// ==================== 类型 ====================

export interface ApifyMediaItem {
  platform: "PINTEREST" | "INSTAGRAM" | "TIKTOK"
  mediaType: "image" | "video"
  mediaUrl: string
  thumbnailUrl?: string
  sourceUrl?: string
  title?: string
  likes: number
  comments: number
  saves: number
  views: number
  durationSec?: number
  authorName?: string
  authorUrl?: string
  externalId: string
}

export const TIKTOK_SHOP_REGIONS = [
  "US",
  "GB",
  "ID",
  "MY",
  "TH",
  "VN",
  "PH",
  "SG",
  "DE",
  "FR",
  "IT",
  "ES",
] as const
export type TikTokShopRegion = (typeof TIKTOK_SHOP_REGIONS)[number]

interface UnifiedReview {
  rating: string | number | null
  text: string
  author: string | null
  date: string | null
}

interface UnifiedSku {
  skuId: string | null
  price: string | null
  stock: number | null
}

interface TikTokShopExtra {
  soldCount: number | null
  stock: number | null
  originalPrice: string | null
  discount: string | null
  sellerId: string | null
  sellerName: string | null
  sellerRating: string | number | null
  sellerLocation: string | null
  categoryId: string | null
  skus: UnifiedSku[]
  salePropNames: string[]
  aplusImageCount: number
}

export interface TikTokShopUnifiedProduct {
  title: string | null
  url: string | null
  productId: string | null
  platform: "tiktokshop"
  marketplace: TikTokShopRegion
  imageUrl: string | null
  otherImagesUrl: string[]
  videoUrl: string[]
  categoryPath: string | null
  brand: null
  fetchAt: string
  aplus: string[]
  qa: null
  review: UnifiedReview[]
  bullets: string[]
  product_information: string[][]
  description: string
  price: string | null
  currency: string | null
  rating: string | null
  reviewCount: string | null
  bsr: null
  totalPrice: null
  deliveryLeadTime: null
  refusePercent: null
  availableInventory: null
  warehouseRent: null
  extra: TikTokShopExtra
}

// ==================== Actor 配置 ====================

const PINTEREST_ACTOR = "fatihtahta~pinterest-scraper-search"
const INSTAGRAM_ACTOR = "apify~instagram-scraper"
const TIKTOK_ACTOR = "clockworks~tiktok-scraper"
const TIKTOK_SHOP_ACTOR = "cunning_soil~tiktok-shop-product-scraper-mobile-api"
const AMAZON_AUDIT_ACTOR = "junglee~amazon-crawler"
const AMAZON_REVIEWS_ACTOR = "junglee~amazon-reviews-scraper"
const AMAZON_REVIEWS_LIMIT = 20
const AMAZON_RUN_TIMEOUT_SECS = 120
const AMAZON_HTTP_TIMEOUT_MS = 130_000

interface RunActorOptions {
  maxRetries?: number
  httpTimeoutMs?: number
  runTimeoutSecs?: number
}

const RUN_SYNC_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 15_000

interface ApifyErrorInfo {
  status: number | null
  message: string
  body: string
  retryAfterMs: number | null
}

@Injectable()
export class ApifyProvider {
  private readonly logger = new Logger(ApifyProvider.name)
  private readonly apiToken: string
  private readonly baseUrl: string
  private readonly maxRetries: number
  private readonly retryBaseDelayMs: number

  constructor(private readonly config: ConfigService) {
    this.apiToken = this.config.get<string>("APIFY_API_TOKEN") || ""
    this.baseUrl = (this.config.get<string>("APIFY_BASE_URL") || "https://api.apify.com").replace(
      /\/$/,
      ""
    )
    this.maxRetries = this.readPositiveInt("APIFY_MAX_RETRIES", DEFAULT_MAX_RETRIES)
    this.retryBaseDelayMs = this.readPositiveInt(
      "APIFY_RETRY_BASE_DELAY_MS",
      DEFAULT_RETRY_BASE_DELAY_MS
    )
  }

  async searchPinterest(keywords: string[], maxItems: number): Promise<ApifyMediaItem[]> {
    if (!this.apiToken) {
      this.logger.warn("[Apify] 未配置 APIFY_API_TOKEN，跳过 Pinterest 抓取")
      return []
    }

    const input = {
      queries: keywords,
      type: "all-pins",
      limit: Math.ceil(maxItems / keywords.length),
    }

    const raw = await this.runActorSync(PINTEREST_ACTOR, input)
    return this.parsePinterestResults(raw)
  }

  async searchInstagram(keywords: string[], maxItems: number): Promise<ApifyMediaItem[]> {
    if (!this.apiToken) {
      this.logger.warn("[Apify] 未配置 APIFY_API_TOKEN，跳过 Instagram 抓取")
      return []
    }

    const hashtags = keywords
      .filter(k => /^[a-zA-Z0-9\s]+$/.test(k))
      .map(k => k.replace(/\s+/g, "").toLowerCase())
    const uniqueTags = [...new Set(hashtags)].slice(0, 5)

    if (uniqueTags.length === 0) {
      this.logger.warn("[Apify] Instagram 无可用英文关键词，跳过")
      return []
    }

    const input = {
      directUrls: uniqueTags.map(tag => `https://www.instagram.com/explore/tags/${tag}/`),
      resultsType: "posts",
      resultsLimit: Math.ceil(maxItems / uniqueTags.length),
    }

    const raw = await this.runActorSync(INSTAGRAM_ACTOR, input)
    return this.parseInstagramResults(raw)
  }

  async searchTikTok(keywords: string[], maxItems: number): Promise<ApifyMediaItem[]> {
    if (!this.apiToken) {
      this.logger.warn("[Apify] 未配置 APIFY_API_TOKEN，跳过 TikTok 抓取")
      return []
    }

    const input = {
      searchQueries: keywords,
      resultsPerPage: Math.ceil(maxItems / keywords.length),
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false,
      shouldDownloadSlideshowImages: false,
    }

    const raw = await this.runActorSync(TIKTOK_ACTOR, input)
    return this.parseTikTokResults(raw)
  }

  async fetchTikTokShopProduct(
    productInput: string,
    region: TikTokShopRegion = "US"
  ): Promise<TikTokShopUnifiedProduct> {
    if (!this.apiToken) {
      this.logger.error("[Apify] 未配置 APIFY_API_TOKEN，无法抓取 TikTok Shop 商品")
      throw new InternalServerErrorException("服务器内部错误")
    }

    const fetchAt = new Date().toISOString()
    const input = {
      productInput,
      region,
      outputMode: "full_readable",
    }

    const raw = await this.runActorSync(TIKTOK_SHOP_ACTOR, input)
    const product = this.extractTikTokShopProduct(raw)
    if (!product) {
      this.logger.warn(
        `[Apify] TikTok Shop 未返回商品 productInput=${productInput} region=${region} items=${raw.length}`
      )
      throw new BadGatewayException("未抓取到 TikTok Shop 商品信息")
    }
    return toTikTokShopUnifiedProduct(product, { url: productInput, region, fetchAt })
  }

  async fetchAmazonAuditProduct(target: AmazonAuditTarget): Promise<RawAuditData> {
    if (!this.apiToken) {
      this.logger.warn("[Apify] 未配置 APIFY_API_TOKEN，跳过 Amazon 兜底")
      throw new BadGatewayException("备用商品数据源暂不可用")
    }
    const parsed = parseAmazonAuditTarget(target.url)
    if (!parsed || parsed.asin !== target.asin || parsed.country !== target.country) {
      throw new BadGatewayException("备用数据源不支持该商品地址")
    }
    const raw = await this.runActorSync(
      AMAZON_AUDIT_ACTOR,
      {
        categoryOrProductUrls: [{ url: parsed.url }],
        maxItemsPerStartUrl: 1,
        maxProductVariantsAsSeparateResults: 0,
        maxOffers: 0,
        scrapeSellers: false,
        scrapeProductVariantPrices: false,
        scrapeProductDetails: true,
        proxyCountry: target.country === Country.UK ? "GB" : target.country,
      },
      {
        maxRetries: 0,
        httpTimeoutMs: AMAZON_HTTP_TIMEOUT_MS,
        runTimeoutSecs: AMAZON_RUN_TIMEOUT_SECS,
      }
    )
    const data = adaptAmazonAuditResults(raw, target)
    const review = data.review as { star_percent: string[]; comment_list: unknown[] }
    // 评论是可选补充；失败不能丢弃已抓到的商品详情，也不重试付费启动。
    try {
      const reviews = await this.runActorSync(
        AMAZON_REVIEWS_ACTOR,
        {
          productUrls: [{ url: parsed.url }],
          maxReviews: AMAZON_REVIEWS_LIMIT,
          includeGdprSensitive: false,
          sort: "helpful",
          reviewsUseProductVariantFilter: true,
          scrapeProductDetails: false,
        },
        { maxRetries: 0, httpTimeoutMs: 70_000, runTimeoutSecs: 60 }
      )
      review.comment_list = adaptAmazonReviewResults(reviews, target).slice(0, AMAZON_REVIEWS_LIMIT)
    } catch {
      this.logger.warn(`[Apify] amazon 评论补充失败 asin=${target.asin}，保留商品详情`)
    }
    this.logger.log(
      `[Apify] amazon asin=${target.asin} country=${target.country} reviewTexts=${review.comment_list.length} starDistribution=${review.star_percent.length > 0}`
    )
    return data
  }

  // ==================== 私有 ====================

  private async runActorSync(
    actorId: string,
    input: unknown,
    options: RunActorOptions = {}
  ): Promise<unknown[]> {
    const amazon = actorId === AMAZON_AUDIT_ACTOR || actorId === AMAZON_REVIEWS_ACTOR
    const url = `${this.baseUrl}/v2/${amazon ? "actors" : "acts"}/${actorId}/run-sync-get-dataset-items`
    const start = Date.now()
    const maxAttempts = (options.maxRetries ?? this.maxRetries) + 1

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await axios.post(url, input, {
          params: {
            ...(!amazon ? { token: this.apiToken } : {}),
            ...(options.runTimeoutSecs !== undefined ? { timeout: options.runTimeoutSecs } : {}),
          },
          headers: {
            "Content-Type": "application/json",
            ...(amazon ? { Authorization: `Bearer ${this.apiToken}` } : {}),
          },
          timeout: options.httpTimeoutMs ?? RUN_SYNC_TIMEOUT_MS,
        })
        const elapsed = ((Date.now() - start) / 1000).toFixed(1)
        const items: unknown[] = Array.isArray(res.data) ? res.data : []
        this.logger.log(
          `[Apify] ${actorId} 完成 items=${items.length} 耗时=${elapsed}s attempt=${attempt}/${maxAttempts}`
        )
        return items
      } catch (error: unknown) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1)
        if (amazon) {
          // 同步启动断连后不重发；仅记 HTTP 状态，避免响应/异常内的凭证泄漏。
          const status = axios.isAxiosError(error) ? error.response?.status : undefined
          this.logger.warn(`[Apify] Amazon 兜底失败 status=${status ?? "NETWORK"} 耗时=${elapsed}s`)
          throw new BadGatewayException("备用商品数据源暂不可用")
        }
        const info = this.describeError(error)
        const retryable = this.isRetryableError(error, info)

        if (this.isBillingError(info)) {
          this.logger.error(
            `[Apify] ${actorId} 账号/计费类错误，已隐藏给用户 status=${info.status ?? "N/A"} 耗时=${elapsed}s attempt=${attempt}/${maxAttempts}: ${info.message} ${info.body}`
          )
          throw new InternalServerErrorException("服务器内部错误")
        }

        if (!retryable || attempt >= maxAttempts) {
          this.logger.error(
            `[Apify] ${actorId} 失败 status=${info.status ?? "N/A"} retryable=${retryable} 耗时=${elapsed}s attempt=${attempt}/${maxAttempts}: ${info.message} ${info.body}`
          )
          throw new InternalServerErrorException("服务器内部错误")
        }

        const delayMs = this.retryDelayMs(attempt, info.retryAfterMs)
        this.logger.warn(
          `[Apify] ${actorId} 临时失败，将重试 status=${info.status ?? "N/A"} delay=${delayMs}ms attempt=${attempt}/${maxAttempts}: ${info.message}`
        )
        await sleep(delayMs)
      }
    }

    throw new InternalServerErrorException("服务器内部错误")
  }

  private readPositiveInt(key: string, fallback: number): number {
    const raw = this.config.get<string>(key)
    const value = raw == null ? fallback : Number(raw)
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
  }

  private describeError(error: unknown): ApifyErrorInfo {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? null
      const body = preview(error.response?.data)
      const retryAfterMs = parseRetryAfterMs(error.response?.headers?.["retry-after"])
      return {
        status,
        body,
        retryAfterMs,
        message: error.message,
      }
    }
    return {
      status: null,
      body: "",
      retryAfterMs: null,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  private isRetryableError(error: unknown, info: ApifyErrorInfo): boolean {
    if (!axios.isAxiosError(error)) return false
    if (!error.response) return true
    const status = info.status
    return status === 408 || status === 429 || (status != null && status >= 500)
  }

  private isBillingError(info: ApifyErrorInfo): boolean {
    if (info.status === 402) return true
    const text = `${info.message} ${info.body}`.toLowerCase()
    return [
      "insufficient",
      "not enough",
      "balance",
      "credit",
      "billing",
      "payment",
      "quota exceeded",
      "monthly usage",
    ].some(keyword => text.includes(keyword))
  }

  private retryDelayMs(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs != null) return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS)
    const exponential = this.retryBaseDelayMs * 2 ** (attempt - 1)
    const jitter = Math.floor(Math.random() * this.retryBaseDelayMs)
    return Math.min(exponential + jitter, MAX_RETRY_DELAY_MS)
  }

  private parsePinterestResults(raw: unknown[]): ApifyMediaItem[] {
    const results: ApifyMediaItem[] = []
    for (const item of raw) {
      const r = item as Record<string, unknown>

      const pin = r.pin as Record<string, unknown> | undefined
      const creator = r.creator as Record<string, unknown> | undefined
      const media = r.media as Record<string, unknown> | undefined
      const images = media?.images as Record<string, Record<string, unknown>> | undefined

      const originalImg = images?.original?.url as string | undefined
      const largeImg = images?.large?.url as string | undefined
      const mediumImg = images?.medium?.url as string | undefined
      const imageUrl = originalImg ?? largeImg ?? mediumImg
      if (!imageUrl) continue

      const story = pin?.story as Record<string, unknown> | undefined
      const totalVideoDuration = story?.total_video_duration as number | undefined
      const isVideo = !!(totalVideoDuration && totalVideoDuration > 0)

      const reactionCounts = pin?.reaction_counts as Record<string, number> | undefined
      const likes = reactionCounts ? Object.values(reactionCounts).reduce((a, b) => a + b, 0) : 0

      results.push({
        platform: "PINTEREST",
        mediaType: isVideo ? "video" : "image",
        mediaUrl: imageUrl,
        thumbnailUrl:
          (images?.thumb?.url as string | undefined) ?? (images?.small?.url as string | undefined),
        sourceUrl:
          (r.url as string | undefined) ??
          (r.id ? `https://www.pinterest.com/pin/${String(r.id as string)}/` : undefined),
        title: (r.title ?? pin?.title ?? pin?.description) as string | undefined,
        likes: toInt(likes),
        comments: 0,
        saves: 0,
        views: 0,
        durationSec: isVideo ? toFloat(totalVideoDuration) : undefined,
        authorName: (creator?.full_name ?? creator?.username) as string | undefined,
        authorUrl: creator?.url as string | undefined,
        externalId: String((r.id ?? `p_${results.length}`) as string | number),
      })
    }
    return results
  }

  private parseInstagramResults(raw: unknown[]): ApifyMediaItem[] {
    const results: ApifyMediaItem[] = []
    for (const item of raw) {
      const r = item as Record<string, unknown>
      const type = r.type as string | undefined
      const isVideo = type === "Video" || type === "Reel" || !!r.videoUrl

      const mediaUrl = isVideo
        ? ((r.videoUrl ?? r.displayUrl) as string | undefined)
        : ((r.displayUrl ?? r.imageUrl) as string | undefined)
      if (!mediaUrl) continue

      const ownerUsername = r.ownerUsername as string | undefined

      results.push({
        platform: "INSTAGRAM",
        mediaType: isVideo ? "video" : "image",
        mediaUrl,
        thumbnailUrl: isVideo ? (r.displayUrl as string | undefined) : undefined,
        sourceUrl: (r.url ?? r.postUrl) as string | undefined,
        title: (r.caption ?? r.alt) as string | undefined,
        likes: toInt(r.likesCount ?? r.likes ?? 0),
        comments: toInt(r.commentsCount ?? r.comments ?? 0),
        saves: toInt(r.savesCount ?? r.saves ?? 0),
        views: toInt(r.videoViewCount ?? r.views ?? r.playsCount ?? 0),
        durationSec: isVideo ? toFloat(r.videoDuration ?? r.duration) : undefined,
        authorName: (ownerUsername ?? r.username) as string | undefined,
        authorUrl: ownerUsername ? `https://www.instagram.com/${ownerUsername}` : undefined,
        externalId: String(
          (r.id ?? r.shortCode ?? r.code ?? `i_${results.length}`) as string | number
        ),
      })
    }
    return results
  }

  private parseTikTokResults(raw: unknown[]): ApifyMediaItem[] {
    const results: ApifyMediaItem[] = []
    for (const item of raw) {
      const r = item as Record<string, unknown>

      const authorMeta = r.authorMeta as Record<string, unknown> | undefined
      const videoMeta = r.videoMeta as Record<string, unknown> | undefined

      const webVideoUrl = r.webVideoUrl as string | undefined
      const coverUrl = (videoMeta?.coverUrl ?? r.coverUrl ?? r.thumbnailUrl) as string | undefined
      if (!webVideoUrl && !coverUrl) continue

      const authorName = (authorMeta?.name ?? authorMeta?.nickName ?? r.authorName) as
        | string
        | undefined

      results.push({
        platform: "TIKTOK",
        mediaType: "video",
        mediaUrl: webVideoUrl || coverUrl!,
        thumbnailUrl: coverUrl,
        sourceUrl: webVideoUrl,
        title: (r.text ?? r.caption ?? r.desc) as string | undefined,
        likes: toInt(r.diggCount ?? r.likes ?? 0),
        comments: toInt(r.commentCount ?? r.comments ?? 0),
        saves: toInt(r.collectCount ?? r.saves ?? r.bookmarks ?? 0),
        views: toInt(r.playCount ?? r.views ?? 0),
        durationSec: toFloat(videoMeta?.duration ?? r.duration),
        authorName,
        authorUrl: authorName
          ? `https://www.tiktok.com/@${authorName}`
          : (r.authorUrl as string | undefined),
        externalId: String((r.id ?? r.videoId ?? `t_${results.length}`) as string | number),
      })
    }
    return results
  }

  private extractTikTokShopProduct(raw: unknown[]): UnknownRecord | null {
    const first = asRecord(raw[0])
    const products = getPathArray(first, ["product_info", "products"])
    return asRecord(products[0])
  }
}

// ==================== 工具函数 ====================

type UnknownRecord = Record<string, unknown>

function toTikTokShopUnifiedProduct(
  product: UnknownRecord,
  opts: { url: string; region: TikTokShopRegion; fetchAt: string }
): TikTokShopUnifiedProduct {
  const aplus = parseTikTokShopAplus(product)
  const images = getPathArray(product, ["media", "image_urls"]).flatMap(toStringArrayItem)
  const input = opts.url.trim()
  const productId =
    getString(product, "product_id") ?? (isTikTokShopProductId(input) ? input : null)
  const sourceUrl = isLikelyUrl(input) ? input : null
  const videoUrl = extractTikTokShopVideoUrls(product)
  const specs = getPathArray(product, [
    "additional",
    "raw_product",
    "product_base",
    "specifications",
  ])
  const productInformation = specs.map(item => {
    const spec = asRecord(item)
    return [stringOrEmpty(spec?.name), stringOrEmpty(spec?.value)]
  })

  return {
    title: getString(product, "title"),
    url:
      sourceUrl ??
      (productId ? `https://shop.tiktok.com/${opts.region.toLowerCase()}/pdp/${productId}` : null),
    productId,
    platform: "tiktokshop",
    marketplace: opts.region,
    imageUrl: images[0] ?? null,
    otherImagesUrl: images.slice(1),
    videoUrl,
    categoryPath: getPathString(product, ["category", "name"]),
    brand: null,
    fetchAt: opts.fetchAt,
    aplus: aplus.images,
    qa: null,
    review: getPathArray(product, ["reviews", "review_items"]).map(toUnifiedReview),
    bullets: aplus.bullets,
    product_information: productInformation,
    description: aplus.bullets.join("\n\n"),
    price: stripCurrency(getPathValue(product, ["pricing", "sale_price"])),
    currency: getPathString(product, ["pricing", "currency"]),
    rating: valueToString(getPathValue(product, ["reviews", "product_rating"])),
    reviewCount: valueToString(getPathValue(product, ["reviews", "review_count"])),
    bsr: null,
    totalPrice: null,
    deliveryLeadTime: null,
    refusePercent: null,
    availableInventory: null,
    warehouseRent: null,
    extra: {
      soldCount: toNullableNumber(getPathValue(product, ["sales", "sold_count"])),
      stock: toNullableNumber(getPathValue(product, ["inventory", "total_stock"])),
      originalPrice: stripCurrency(getPathValue(product, ["pricing", "original_price"])),
      discount: getPathString(product, ["pricing", "discount"]),
      sellerId: getPathString(product, ["seller", "seller_id"]),
      sellerName: getPathString(product, ["seller", "name"]),
      sellerRating: toReviewRating(getPathValue(product, ["seller", "rating"])),
      sellerLocation: getPathString(product, ["seller", "location"]),
      categoryId: getPathString(product, ["category", "id"]),
      skus: getPathArray(product, ["inventory", "skus"]).map(toUnifiedSku),
      salePropNames: getPathArray(product, ["inventory", "sale_props"])
        .map(item => getString(asRecord(item), "prop_name"))
        .filter((name): name is string => !!name),
      aplusImageCount: aplus.images.length,
    },
  }
}

function parseTikTokShopAplus(product: UnknownRecord): { bullets: string[]; images: string[] } {
  const blocks = getPathArray(product, [
    "additional",
    "raw_product",
    "product_base",
    "desc_detailv3",
    "ec_rich_blocks",
  ])
  const bullets: string[] = []
  const images: string[] = []

  for (const blockValue of blocks) {
    const block = asRecord(blockValue)
    if (!block) continue

    const rich = asRecord(block.xl_ec_rich_text) ?? asRecord(block.ec_rich_text)
    for (const textValue of getArray(rich, "ec_rich_texts")) {
      const text = extractRichText(textValue)
      if (text) bullets.push(text)
    }

    const image = firstString(getPathArray(block, ["image", "url_list"]))
    if (image) images.push(image)
  }

  return { bullets, images }
}

function extractRichText(value: unknown): string {
  const item = asRecord(value)
  const args = asRecord(item?.arguments)
  if (!args) return ""
  return Object.values(args)
    .map(arg => getPathString(asRecord(arg), ["text_attribute", "text"]) ?? "")
    .join("")
    .trim()
}

function extractTikTokShopVideoUrls(product: UnknownRecord): string[] {
  const productBase = getPathRecord(product, ["additional", "raw_product", "product_base"])
  const urls: string[] = []
  for (const value of [productBase?.desc_video, productBase?.header_video]) {
    const video = asRecord(value)
    const url =
      firstString(getPathArray(video, ["play_addr", "url_list"])) ?? getString(video, "play_url")
    if (url && !urls.includes(url)) urls.push(url)
  }
  return urls
}

function toUnifiedReview(item: unknown): UnifiedReview {
  const row = asRecord(item)
  const review = asRecord(row?.review) ?? row
  return {
    rating: toReviewRating(review?.rating),
    text: getString(review, "display_text") ?? getString(review, "text") ?? "",
    author: getString(review, "user_name") ?? getString(review, "author"),
    date: valueToString(review?.create_time) ?? getString(review, "date"),
  }
}

function toUnifiedSku(item: unknown): UnifiedSku {
  const sku = asRecord(item)
  return {
    skuId: getString(sku, "sku_id"),
    price: stripCurrency(getPathValue(sku, ["price", "real_price"]) ?? sku?.price),
    stock: toNullableNumber(sku?.stock),
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function getArray(record: UnknownRecord | null, key: string): unknown[] {
  if (!record) return []
  const value = record[key]
  return Array.isArray(value) ? value : []
}

function getString(record: UnknownRecord | null, key: string): string | null {
  if (!record) return null
  return valueToString(record[key])
}

function getPathValue(record: UnknownRecord | null, path: string[]): unknown {
  let current: unknown = record
  for (const key of path) {
    const currentRecord = asRecord(current)
    if (!currentRecord) return undefined
    current = currentRecord[key]
  }
  return current
}

function getPathRecord(record: UnknownRecord | null, path: string[]): UnknownRecord | null {
  return asRecord(getPathValue(record, path))
}

function getPathArray(record: UnknownRecord | null, path: string[]): unknown[] {
  const value = getPathValue(record, path)
  return Array.isArray(value) ? value : []
}

function getPathString(record: UnknownRecord | null, path: string[]): string | null {
  return valueToString(getPathValue(record, path))
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    const text = valueToString(value)
    if (text) return text
  }
  return null
}

function toStringArrayItem(value: unknown): string[] {
  const text = valueToString(value)
  return text ? [text] : []
}

function valueToString(value: unknown): string | null {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  return null
}

function stringOrEmpty(value: unknown): string {
  return valueToString(value) ?? ""
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return null
  const number = Number(value.replace(/,/g, ""))
  return Number.isFinite(number) ? number : null
}

function toReviewRating(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  return valueToString(value)
}

function stripCurrency(value: unknown): string | null {
  const text = valueToString(value)
  const match = text?.match(/[\d.,]+/)
  return match ? match[0].replace(/,/g, "") : null
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function isTikTokShopProductId(value: string): boolean {
  return /^\d{19}$/.test(value)
}

function toInt(val: unknown): number {
  if (val == null) return 0
  const n = Number(val)
  return Number.isFinite(n) ? Math.round(n) : 0
}

function toFloat(val: unknown): number | undefined {
  if (val == null) return undefined
  const n = Number(val)
  return Number.isFinite(n) ? n : undefined
}

function preview(data: unknown): string {
  if (data == null) return ""
  if (typeof data === "string") return data.slice(0, 500)
  if (typeof data === "number" || typeof data === "boolean" || typeof data === "bigint") {
    return data.toString().slice(0, 500)
  }
  try {
    return JSON.stringify(data).slice(0, 500)
  } catch {
    return "[unserializable response body]"
  }
}

function parseRetryAfterMs(value: unknown): number | null {
  const raw: unknown = Array.isArray(value) ? (value as unknown[])[0] : value
  if (typeof raw !== "string") return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(raw)
  if (!Number.isFinite(dateMs)) return null
  return Math.max(0, dateMs - Date.now())
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
