import { BadGatewayException } from "@nestjs/common"
import { auditObject } from "../../audit/audit-data"
import { parseAmazonAuditTarget, type AmazonAuditTarget } from "../../audit/audit.marketplace"
import type { RawAuditData } from "./crawler.provider"

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter(Boolean) : [])
const images = (v: unknown): string[] => strings(v).filter(url => /^https?:\/\//i.test(url))
const scalar = (v: unknown): string =>
  typeof v === "number" || typeof v === "boolean" ? String(v) : text(v)

/** 评论正文独立于商品评分统计；仅接收实际目标 ASIN，保留原文供抽样、分析和下载。 */
export function adaptAmazonReviewResults(items: unknown[], target: AmazonAuditTarget) {
  const seen = new Set<string>()
  return items.map(auditObject).flatMap(item => {
    if (
      "error" in item ||
      text(item.productAsin).toUpperCase() !== target.asin ||
      !text(item.reviewDescription) ||
      (item.variantAsin != null && text(item.variantAsin).toUpperCase() !== target.asin)
    )
      return []
    if (item.input != null) {
      const input = parseAmazonAuditTarget(text(item.input))
      if (!input || input.asin !== target.asin || input.country !== target.country) return []
    }
    const key =
      text(item.reviewId) || JSON.stringify([item.reviewTitle, item.date, item.reviewDescription])
    if (seen.has(key)) return []
    seen.add(key)
    return [
      {
        reviewId: text(item.reviewId),
        date: text(item.date),
        star:
          typeof item.ratingScore === "number" &&
          Number.isFinite(item.ratingScore) &&
          item.ratingScore >= 1 &&
          item.ratingScore <= 5
            ? item.ratingScore
            : null,
        title: text(item.reviewTitle),
        comment: item.reviewDescription as string,
        verified: typeof item.isVerified === "boolean" ? (item.isVerified ? "是" : "否") : "",
        usefulNumber: scalar(item.reviewReaction),
        variant: text(item.variant),
      },
    ]
  })
}

/** 两种已公布的格式：5star:0.86 或 "5 star":86；不猜测不完整分布的单位。 */
export function amazonStarPercent(value: unknown): string[] {
  const breakdown = Object.fromEntries(
    Object.entries(auditObject(value)).map(([k, v]) => [k.replace(/\s/g, ""), v])
  )
  const values = [5, 4, 3, 2, 1].map(star => breakdown[`${star}star`])
  if (
    !values.every(
      (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100
    )
  )
    return []
  const total = values.reduce((sum, v) => sum + v, 0)
  const factor =
    Math.abs(total - 1) <= 0.02 && values.every(v => v <= 1)
      ? 100
      : Math.abs(total - 100) <= 2
        ? 1
        : 0
  return factor ? values.map(v => `${Number((v * factor).toFixed(2))}%`) : []
}

function pairs(value: unknown): string[][] {
  const entries = Array.isArray(value)
    ? value.map(item => {
        const row = auditObject(item)
        return [text(row.key), scalar(row.value)]
      })
    : Object.entries(auditObject(value)).map(([k, v]) => [k.trim(), scalar(v)])
  return entries.filter(([k, v]) => k && v)
}

/** Apify 的 A+ 图片既可能是 URL 字符串，也可能是 { name, url } 对象。 */
function aplusImageUrls(...values: unknown[]): string[] {
  const urls = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value === "string") {
      const url = value.trim()
      if (
        /^https?:\/\//i.test(url) &&
        !/grey-pixel|gray-pixel|transparent-pixel|spacer\.gif/i.test(url)
      )
        urls.add(url)
      return
    }
    const item = auditObject(value)
    for (const key of ["url", "image", "images", "modules", "children", "items"]) {
      if (item[key] != null) visit(item[key])
    }
  }
  values.forEach(visit)
  return [...urls]
}

/** 严格按实际 asin 选择，originalAsin 相同但跳转到其他变体也不接受。 */
export function adaptAmazonAuditResults(items: unknown[], target: AmazonAuditTarget): RawAuditData {
  const product = items.map(auditObject).find(item => {
    if ("error" in item || text(item.asin).toUpperCase() !== target.asin || !text(item.title))
      return false
    if (item.url != null) {
      const returned = parseAmazonAuditTarget(text(item.url))
      if (!returned || returned.asin !== target.asin || returned.country !== target.country)
        return false
    }
    if (item.loadedCountryCode != null) {
      const country = text(item.loadedCountryCode).toUpperCase().replace(/^GB$/, "UK")
      if (country !== String(target.country)) return false
    }
    return true
  })
  if (!product) throw new BadGatewayException("备用数据源未获取到匹配的商品详情")

  const highRes = images(product.highResolutionImages)
  const gallery = [
    ...new Set(
      highRes.length
        ? highRes
        : images([product.thumbnailImage, ...strings(product.galleryThumbnails)])
    ),
  ]
  const groups: Record<string, string[][]> = {}
  const seen = new Set<string>()
  for (const [name, entries] of [
    ["Product Details", [...pairs(product.attributes), ...pairs(product.attributesMapped)]],
    ["Product Overview", pairs(product.productOverview)],
    ["Manufacturer Details", pairs(product.manufacturerAttributes)],
  ] as [string, string[][]][]) {
    const fields = entries.filter(([k]) => {
      const key = k.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (fields.length) groups[name] = fields
  }
  const aplus = auditObject(product.aPlusContent)
  const aplusImages = aplusImageUrls(aplus.rawImages, aplus.modules)
  const modules = (Array.isArray(aplus.modules) ? aplus.modules : []).flatMap(item => {
    const row = auditObject(item)
    // Actor 的 type 是布局代码，不是展示标题；纯图片模块只通过 aplusImages 展示。
    const title = text(row.title) || text(row.name)
    const desc = text(row.desc) || text(row.description) || text(row.text)
    return title || desc ? [{ type: title || "A+", desc }] : []
  })
  const aplusText = text(aplus.rawText)
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !/^(?:product description|previous page|next page)$/i.test(line))
    .join("\n")
  if (!modules.length && aplusText) modules.push({ type: "A+", desc: aplusText })
  const rating =
    typeof product.stars === "number" &&
    Number.isFinite(product.stars) &&
    product.stars >= 0 &&
    product.stars <= 5
      ? product.stars
      : null
  const reviewCount =
    typeof product.reviewsCount === "number" &&
    Number.isInteger(product.reviewsCount) &&
    product.reviewsCount >= 0
      ? product.reviewsCount
      : null
  return {
    platform: "amazon",
    marketplace: target.country,
    productId: target.asin,
    url: target.url,
    title: text(product.title),
    brand: text(product.brand),
    bullets: strings(product.features),
    description: text(product.description),
    nodeLabelPath: text(product.breadCrumbs),
    imageUrl: gallery[0] ?? null,
    otherImagesUrl: gallery.slice(1),
    product_information_hhl: groups,
    aplusImages,
    aplusModules: modules,
    hasAplus: aplusImages.length || modules.length ? true : null,
    hasVideo:
      typeof product.videosCount === "number" &&
      Number.isInteger(product.videosCount) &&
      product.videosCount >= 0
        ? product.videosCount > 0
        : null,
    rating,
    reviewCount,
    review: { star_percent: amazonStarPercent(product.starsBreakdown), comment_list: [] },
    // 摘要、问答数量不能冒充评论正文或 Q&A；未知即留空。
    QA: [],
  }
}
