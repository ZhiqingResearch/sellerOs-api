import { BadRequestException } from "@nestjs/common"

/** 站点（先含亚马逊三国，按需扩展）。 */
export enum Country {
  US = "US",
  UK = "UK",
  DE = "DE",
}

/**
 * 平台 + 站点 → 商品站域名。未来加平台/国家只往这张表加条目（预留多平台）。
 */
const MARKETPLACE_DOMAINS: Record<string, Partial<Record<Country, string>>> = {
  amazon: {
    [Country.US]: "www.amazon.com",
    [Country.UK]: "www.amazon.co.uk",
    [Country.DE]: "www.amazon.de",
  },
}

/** 按 platform + country 把 ASIN 拼成商品详情页 URL（爬虫只吃 URL）。 */
export function buildProductUrl(platform: string, country: Country, asin: string): string {
  const host = MARKETPLACE_DOMAINS[platform]?.[country]
  if (!host) {
    throw new BadRequestException(`暂不支持的站点：platform=${platform} country=${country}`)
  }
  return `https://${host}/dp/${asin}`
}

export interface AmazonAuditTarget {
  url: string
  asin: string
  country: Country
}

/** 只识别受支持的 Amazon 商品页，避免兜底 Actor 扩散抓取搜索/类目页。 */
export function parseAmazonAuditTarget(input: string): AmazonAuditTarget | null {
  try {
    const url = new URL(input)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
      return null
    }
    const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "")
    const country = {
      "amazon.com": Country.US,
      "amazon.co.uk": Country.UK,
      "amazon.de": Country.DE,
    }[host]
    const match = url.pathname.match(
      /\/(?:dp|gp\/(?:aw\/)?d|gp\/product|gp\/offer-listing|product)\/([a-z0-9]{10})(?:\/|$)/i
    )
    if (!country || !match) return null
    const asin = match[1].toUpperCase()
    return { asin, country, url: buildProductUrl("amazon", country, asin) }
  } catch {
    return null
  }
}
