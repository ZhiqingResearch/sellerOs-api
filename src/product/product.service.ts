import { BadGatewayException, Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { CrawlOutcome, Prisma, Product } from "@prisma/client"
import crypto from "crypto"
import {
  ApifyProvider,
  TikTokShopRegion,
  TikTokShopUnifiedProduct,
  TIKTOK_SHOP_REGIONS,
} from "../common/providers/apify.provider"
import { CrawlerError, CrawlerProvider, RawProductData } from "../common/providers/crawler.provider"
import { PrismaService } from "../prisma/prisma.service"

@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly crawler: CrawlerProvider,
    private readonly apify: ApifyProvider,
    private readonly config: ConfigService
  ) {}

  /** 按 URL 查产品详情：缓存命中直接返回；过期或 miss 则同步调爬虫、写库、写流水 */
  async findByUrl(userId: number, url: string): Promise<Product> {
    const urlHash = sha256(url)
    const ttlDays = Number(this.config.get<string | number>("PRODUCT_CACHE_TTL_DAYS") ?? 30)
    const ttlMs = ttlDays * 24 * 3600 * 1000

    // 1. 查缓存
    const existing = await this.prisma.product.findUnique({ where: { urlHash } })
    // 旧 Amazon 缓存早于副标题字段接入，不能把“未抓取”当成“商品没有亮点”。
    const hasLegacyHighlightsCache =
      existing?.platform === "amazon" &&
      (!existing.data || !Object.prototype.hasOwnProperty.call(existing.data, "second_title"))
    if (existing && !hasLegacyHighlightsCache && Date.now() - existing.fetchedAt.getTime() < ttlMs) {
      return existing
    }

    // 2. 调爬虫
    const start = Date.now()
    let raw: RawProductData
    try {
      raw = await this.fetchProductDetail(url)
    } catch (e) {
      const isCrawlerErr = e instanceof CrawlerError
      const errorCode = isCrawlerErr ? e.code : "UNEXPECTED"
      const errorMessage = e instanceof Error ? e.message : String(e)
      await this.prisma.crawlLog.create({
        data: {
          userId,
          url,
          outcome: CrawlOutcome.FAILED,
          errorCode,
          errorMessage,
          durationMs: Date.now() - start,
        },
      })
      this.logger.warn(`pdp failed url=${url} code=${errorCode} msg=${errorMessage}`)
      throw new BadGatewayException({ code: errorCode, message: errorMessage })
    }

    // 3. upsert + log
    const platform = detectPlatform(url, raw.platform)
    const name = raw.title ?? ""
    // 显式 null 表示本次爬虫确实未返回副标题，避免无副标题商品反复刷新缓存。
    const productData = platform === "amazon" ? { second_title: null, ...raw } : raw
    const product = await this.prisma.product.upsert({
      where: { urlHash },
      create: {
        url,
        urlHash,
        platform,
        name,
        data: productData as unknown as Prisma.InputJsonValue,
        fetchedAt: new Date(),
      },
      update: {
        platform,
        name,
        data: productData as unknown as Prisma.InputJsonValue,
        fetchedAt: new Date(),
      },
    })
    await this.prisma.crawlLog.create({
      data: {
        userId,
        url,
        outcome: CrawlOutcome.SUCCESS,
        productId: product.id,
        durationMs: Date.now() - start,
      },
    })
    return product
  }

  private async fetchProductDetail(url: string): Promise<RawProductData> {
    if (isTikTokShopUrl(url)) {
      const product = await this.apify.fetchTikTokShopProduct(url, detectTikTokShopRegion(url))
      return toTikTokShopProductData(product)
    }
    return this.crawler.fetchPdp(url)
  }
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

function isTikTokShopUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    return host === "shop.tiktok.com" || host.endsWith(".shop.tiktok.com")
  } catch {
    return false
  }
}

function detectTikTokShopRegion(url: string): TikTokShopRegion {
  try {
    const [, maybeRegion] = new URL(url).pathname.split("/")
    const region = maybeRegion?.toUpperCase()
    if (isTikTokShopRegion(region)) return region
  } catch {
    // ignore: fallback to US
  }
  return "US"
}

function isTikTokShopRegion(value: string | undefined): value is TikTokShopRegion {
  return TIKTOK_SHOP_REGIONS.some(region => region === value)
}

function toTikTokShopProductData(product: TikTokShopUnifiedProduct): RawProductData {
  const title = product.title ?? ""
  const url = product.url ?? ""
  const productId = product.productId ?? ""
  const price = product.price ?? undefined
  const imageUrl = product.imageUrl ?? undefined
  const otherImagesUrl = product.otherImagesUrl
  const brand = product.brand ?? product.extra.sellerName ?? undefined
  return {
    platform: "tiktokshop",
    marketplace: product.marketplace,
    productId,
    url,
    fetchAt: product.fetchAt,
    title,
    brand,
    bullets: product.bullets,
    description: product.description,
    price,
    priceValue: price,
    currency: product.currency ?? undefined,
    rating: product.rating ?? undefined,
    reviewCount: product.reviewCount ?? undefined,
    imageCount: (imageUrl ? 1 : 0) + otherImagesUrl.length,
    imageUrl,
    otherImagesUrl,
    videoUrl: product.videoUrl,
    categoryPath: product.categoryPath ?? undefined,
    aplus: product.aplus,
    review: product.review,
    product_information: product.product_information,
    bsr: product.bsr,
    fulfillment: null,
    extra: product.extra,
  }
}

/**
 * 平台识别：信爬虫返回的 platform（小写归一），URL host 仅作 fallback。
 * 新平台无需改 schema，爬虫返回什么就存什么。
 */
function detectPlatform(url: string, rawPlatform: string | undefined): string {
  const raw = rawPlatform?.trim().toLowerCase()
  if (raw) return raw

  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.includes("amazon.")) return "amazon"
    if (host.includes("walmart.")) return "walmart"
    if (host === "ozon.ru" || host.endsWith(".ozon.ru")) return "ozon"
    if (host === "wildberries.ru" || host.endsWith(".wildberries.ru")) return "wildberries"
    if (
      host === "gigab2b.com" ||
      host.endsWith(".gigab2b.com") ||
      host === "gigacloud.com" ||
      host.endsWith(".gigacloud.com")
    ) {
      return "gigacloud"
    }
  } catch {
    // ignore: URL 解析失败走下面的 throw
  }

  throw new BadGatewayException({
    code: "UNKNOWN_PLATFORM",
    message: `无法识别 platform：url=${url} raw=${rawPlatform ?? "(none)"}`,
  })
}
