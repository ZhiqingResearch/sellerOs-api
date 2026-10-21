import { BadGatewayException, BadRequestException, Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { AuditProduct, Prisma } from "@prisma/client"
import crypto from "crypto"
import { ApifyProvider } from "../common/providers/apify.provider"
import { CrawlerError, CrawlerProvider, RawAuditData } from "../common/providers/crawler.provider"
import { PrismaService } from "../prisma/prisma.service"
import { auditDataSource, auditObject, hasAuditContent } from "./audit-data"
import { Country, buildProductUrl, parseAmazonAuditTarget } from "./audit.marketplace"
import { QueryAuditDetailDto } from "./dto/query-audit-detail.dto"

const APIFY_CACHE_TTL_MS = 60 * 60 * 1000

/** ASIN 审计商品详情：与 products/detail 同套缓存+爬虫逻辑，但独立存表、支持 url 或 asin 入参。 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly crawler: CrawlerProvider,
    private readonly config: ConfigService,
    private readonly apify: ApifyProvider
  ) {}

  /**
   * 查审计商品详情：缓存命中且未过期直返；否则调审计爬虫、写库。
   * url 优先；否则按 country 域名把 asin 拼成 URL（爬虫只吃 URL）。
   */
  async findDetail(query: QueryAuditDetailDto): Promise<AuditProduct> {
    const platform = query.platform?.trim().toLowerCase() || "amazon"
    let country = query.country ?? Country.US

    // 1. 解析最终 URL（url 优先；否则拼 ASIN；都没有 → 400）
    let finalUrl: string
    const queryAsin = query.asin?.toUpperCase() ?? null
    if (query.url) {
      finalUrl = query.url
    } else if (queryAsin) {
      finalUrl = buildProductUrl(platform, country, queryAsin)
    } else {
      throw new BadRequestException("需提供 url 或 asin")
    }

    const urlHash = sha256(finalUrl)
    const target = platform === "amazon" ? parseAmazonAuditTarget(finalUrl) : null
    // 按部署环境配置，不依赖 NODE_ENV（UAT 也可能以 production 模式运行）。
    const primarySource =
      target && this.config.get<string>("ASIN_AUDIT_PRIMARY_SOURCE") === "apify"
        ? "apify"
        : "crawler"
    const ttlDays = Number(this.config.get<string | number>("PRODUCT_CACHE_TTL_DAYS") ?? 30)
    const ttlMs = ttlDays * 24 * 3600 * 1000

    // 2. 查缓存
    const existing = await this.prisma.auditProduct.findUnique({ where: { urlHash } })
    if (existing && hasAuditContent(existing.data)) {
      const source = auditDataSource(existing.data)
      const cacheTtl = source === "apify" ? APIFY_CACHE_TTL_MS : ttlMs
      const cachedPrimary =
        auditObject(auditObject(existing.data)._fetchMeta).primarySource === "apify"
          ? "apify"
          : "crawler"
      // 切换顺序后重新抓取；同一顺序下仍复用兜底结果，避免持续故障时反复付费。
      if (cachedPrimary === primarySource && Date.now() - existing.fetchedAt.getTime() < cacheTtl) {
        this.logger.log(
          `audit cache hit source=${source} asin=${existing.asin} country=${existing.country}`
        )
        return existing
      }
    }

    // 3. 按配置顺序抓取，每个来源最多调用一次；数据库异常不触发换源。
    const sources: ("crawler" | "apify")[] = !target
      ? ["crawler"]
      : primarySource === "apify"
        ? ["apify", "crawler"]
        : ["crawler", "apify"]
    let raw: RawAuditData | undefined
    let source: "crawler" | "apify" = "crawler"
    let errorCode = "AUDIT_FETCH_FAILED"
    for (const candidate of sources) {
      const start = Date.now()
      try {
        const result =
          candidate === "apify"
            ? await this.apify.fetchAmazonAuditProduct(target!)
            : await this.crawler.fetchAudit(finalUrl)
        if (!hasAuditContent(result))
          throw new CrawlerError("EMPTY_CONTENT", "商品详情未返回有效内容")
        raw = result
        source = candidate
        if (candidate === "apify") country = target!.country
        this.logger.log(
          `audit fetch ok source=${source} primary=${primarySource} asin=${target?.asin ?? queryAsin} country=${country} ms=${Date.now() - start}`
        )
        break
      } catch (e) {
        errorCode =
          e instanceof CrawlerError && /^[A-Z0-9_]{1,64}$/i.test(e.code) ? e.code : "UPSTREAM_ERROR"
        this.logger.warn(
          `audit fetch failed source=${candidate} primary=${primarySource} asin=${target?.asin ?? queryAsin} code=${errorCode} ms=${Date.now() - start}`
        )
      }
    }
    if (!raw)
      throw new BadGatewayException({
        code: target ? "AUDIT_FETCH_FAILED" : errorCode,
        message: "商品详情暂时无法获取，请稍后重试",
      })

    raw = { ...raw, _fetchMeta: { source, primarySource } }

    // 4. upsert（name/asin 取值：契约确认前先从常见字段兜底）
    const name = pickString(raw, ["title", "name"]) ?? ""
    // asin 列为 VarChar(32)：按优先级取第一个合法 10 位 ASIN（query → 爬虫返回 → URL/dp 段兜底），
    // 全部用正则校验，既保住真实 ASIN，又杜绝超长脏值写库触发 P2000
    const resolvedAsin =
      source === "apify"
        ? target!.asin
        : firstValidAsin([
            queryAsin,
            pickString(raw, ["asin", "productId"]),
            extractAsinFromUrl(finalUrl),
          ])
    return this.prisma.auditProduct.upsert({
      where: { urlHash },
      create: {
        url: finalUrl,
        urlHash,
        platform,
        country,
        asin: resolvedAsin,
        name,
        data: raw as Prisma.InputJsonValue,
        fetchedAt: new Date(),
      },
      update: {
        platform,
        country,
        asin: resolvedAsin,
        name,
        data: raw as Prisma.InputJsonValue,
        fetchedAt: new Date(),
      },
    })
  }
}

/** 合法 ASIN：10 位字母数字。 */
const ASIN_RE = /^[A-Z0-9]{10}$/

/** 从候选值里取第一个合法 ASIN（统一大写后校验），都不合法返回 null。 */
function firstValidAsin(candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    const v = c?.toUpperCase()
    if (v && ASIN_RE.test(v)) return v
  }
  return null
}

/** 从亚马逊 URL 的 /dp/{ASIN} 或 /gp/product/{ASIN} 段提取 ASIN（忽略 query 串）。 */
function extractAsinFromUrl(url: string): string | null {
  const m = url.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)
  return m ? m[1].toUpperCase() : null
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

/** 从审计返回里按候选键取第一个字符串值（契约确认后可收紧）。 */
function pickString(raw: RawAuditData, keys: string[]): string | null {
  for (const k of keys) {
    const v = raw[k]
    if (typeof v === "string" && v.length) return v
  }
  return null
}
