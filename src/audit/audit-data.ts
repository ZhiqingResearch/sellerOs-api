/** 缓存与上游成功响应共用轻量内容校验，不要求商品具备每一个可选字段。 */
export function auditObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function auditDataSource(value: unknown): "crawler" | "apify" {
  return auditObject(auditObject(value)._fetchMeta).source === "apify" ? "apify" : "crawler"
}

export function hasAuditContent(value: unknown): boolean {
  const data = auditObject(value)
  const text = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0
  const texts = (v: unknown): boolean => text(v) || (Array.isArray(v) && v.some(text))
  if ([data.title, data.name, data.description, data.bullets, data.keyFeatures].some(texts))
    return true
  const image = (v: unknown): boolean => {
    const item = auditObject(v)
    return [v, item.url, item.imageUrl, item.src, item.hiRes, item.large].some(
      url => typeof url === "string" && /^https?:\/\//i.test(url)
    )
  }
  const extra = auditObject(data.extra)
  if (
    [data, extra].some(row =>
      [
        "imageUrl",
        "mainImageUrl",
        "mainImage",
        "images",
        "imageUrls",
        "otherImagesUrl",
        "otherImageUrls",
        "gallery",
        "pictures",
        "productImages",
        "aplusImages",
      ].some(key => (Array.isArray(row[key]) ? row[key].some(image) : image(row[key])))
    )
  )
    return true
  const review = auditObject(data.review ?? data.reviews)
  const number = (v: unknown): number => (typeof v === "number" ? v : text(v) ? Number(v) : NaN)
  const rating = number(data.rating ?? review.rating)
  const count = number(data.reviewCount ?? review.reviewCount)
  if (Number.isFinite(rating) && rating >= 0 && rating <= 5) return true
  if (Number.isInteger(count) && count >= 0) return true
  const params = auditObject(
    data.product_information_hhl ??
      data.product_information ??
      data.productInformation ??
      data.params
  )
  if (
    Object.values(params).some(
      group =>
        Array.isArray(group) &&
        group.some(
          pair =>
            Array.isArray(pair) && text(pair[0]) && (text(pair[1]) || typeof pair[1] === "number")
        )
    )
  )
    return true
  return Object.entries(auditObject(data.overviews ?? extra.overviews)).some(
    ([key, v]) => text(key) && (text(v) || typeof v === "number")
  )
}
