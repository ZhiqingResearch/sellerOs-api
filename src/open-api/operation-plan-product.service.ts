import { BadGatewayException, BadRequestException, Injectable } from "@nestjs/common"
import { exportDateFormatter } from "../common/utils/datetime"
import { assembleCompetitorAnalysis } from "../competitor-analysis/competitor-analysis.assembler"
import { CompetitorEvidenceProvider } from "../competitor-analysis/competitor-evidence.provider"
import { OPERATION_PLAN_CURRENCIES } from "./operation-plan-result"
import { OperationPlanInput } from "./operation-plan.types"

const AMAZON_MARKETS: Record<string, { country: string; market: string }> = {
  "amazon.com": { country: "US", market: "amazon_us" },
  "amazon.co.uk": { country: "UK", market: "amazon_uk" },
  "amazon.de": { country: "DE", market: "amazon_de" },
  "amazon.ca": { country: "CA", market: "amazon_ca" },
  "amazon.co.jp": { country: "JP", market: "amazon_jp" },
  "amazon.fr": { country: "FR", market: "amazon_fr" },
  "amazon.es": { country: "ES", market: "amazon_es" },
  "amazon.it": { country: "IT", market: "amazon_it" },
  "amazon.com.mx": { country: "MX", market: "amazon_mx" },
  "amazon.com.au": { country: "AU", market: "amazon_au" },
  "amazon.ae": { country: "AE", market: "amazon_ae" },
  "amazon.com.br": { country: "BR", market: "amazon_br" },
  "amazon.sa": { country: "SA", market: "amazon_sa" },
}

export function parseOperationProductUrl(raw: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BadRequestException("请提供有效的商品链接")
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
  const market = AMAZON_MARKETS[host]
  if (
    !market ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new BadRequestException("当前仅支持 Amazon 各站点的完整商品详情链接")
  }
  const asin = /\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?:\/|$)/i
    .exec(url.pathname)?.[1]
    ?.toUpperCase()
  if (!asin)
    throw new BadRequestException("链接中未找到有效 ASIN，请使用包含 /dp/ASIN 的完整商品链接")
  // 从白名单域名只取国家和 ASIN，绝不向调用方提供的 URL 发起网络请求。
  return { ...market, asin, url: `https://www.${host}/dp/${asin}` }
}

@Injectable()
export class OperationPlanProductService {
  constructor(private readonly evidence: CompetitorEvidenceProvider) {}

  async resolve(
    link: ReturnType<typeof parseOperationProductUrl>,
    requestId: string
  ): Promise<OperationPlanInput> {
    const evidence = await this.evidence.collectModuleEvidence(link.country, [link.asin], "profile")
    const profile = assembleCompetitorAnalysis(evidence).profiles[0]
    if (!profile?.found || typeof profile.title !== "string" || !profile.title.trim()) {
      throw new BadGatewayException({
        code: "OPEN_PLAN_PRODUCT_UNAVAILABLE",
        message: "未能获取该链接的有效商品资料，本次不扣积分",
      })
    }
    const price =
      typeof profile.price === "number" && Number.isFinite(profile.price) && profile.price > 0
        ? profile.price
        : null
    const category =
      profile.mainBsr && typeof profile.mainBsr === "object"
        ? (profile.mainBsr as { name?: unknown }).name
        : null
    return {
      requestId,
      productText: JSON.stringify({
        title: profile.title,
        brand: profile.brand,
        bullets: profile.bullets,
        specs: profile.specs,
      }).slice(0, 10000),
      market: link.market,
      category: typeof category === "string" && category ? category : "未提供类目",
      operationMode: "jingpin",
      currentPrice: price,
      startDate: exportDateFormatter()(new Date()),
      competitors: [],
      sourceProduct: {
        url: link.url,
        asin: link.asin,
        title: profile.title,
        price,
        currency: OPERATION_PLAN_CURRENCIES[link.market],
        collectedAt: evidence.collectedAt,
      },
    }
  }
}
