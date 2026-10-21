import type {
  AuditDetailResponse,
  CompetitorEvidence,
  ListingEvidence,
  ProductParamGroup,
  ProductParamsEvidence,
  QaItem,
  ReviewDistItem,
  ReviewEvidence,
  ReviewPainPoint,
  ReviewSample,
} from "../types/audit.types"

function str(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v.trim()
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ")
  return Object.prototype.toString.call(v)
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === "string")
    .map(s => s.trim())
    .filter(Boolean)
}

/** 详情页噪音整行（如服装类页面混进描述的 "This is a modal window." 弹窗占位） */
const NOISE_LINE_RE = /^\s*this is a modal window\.?\s*$/i

function normalizeDescription(v: unknown): string {
  const text =
    typeof v === "string"
      ? v
      : Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === "string")
            .map(s => s.trim())
            .filter(Boolean)
            .join("\n")
        : ""
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !NOISE_LINE_RE.test(line))
    .join("\n")
}

function normalizeBullets(d: Record<string, unknown>): string[] {
  const bullets = strArr(d.bullets)
  if (bullets.length > 0) return bullets
  return strArr(d.keyFeatures)
}

function normalizeQa(v: unknown): QaItem[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map(item => ({
      q: str(item.q) || str(item.question),
      a: str(item.a) || str(item.answer),
      votes:
        typeof item.votes === "number"
          ? item.votes
          : typeof item.helpfulCount === "number"
            ? item.helpfulCount
            : undefined,
    }))
    .filter(q => q.q || q.a)
}

function normalizeAplusImages(...values: unknown[]): string[] {
  const images: string[] = []
  const seen = new Set<string>()
  const push = (value: unknown) => {
    if (typeof value !== "string") return
    const url = value.trim()
    if (!/^(?:https?:\/\/|data:image\/)/i.test(url)) return
    if (/grey-pixel|gray-pixel|transparent-pixel|spacer\.gif/i.test(url)) return
    if (seen.has(url)) return
    seen.add(url)
    images.push(url)
  }
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== "object") {
      push(value)
      return
    }
    const item = value as Record<string, unknown>
    for (const key of ["imageUrl", "imageURL", "image", "src", "url"]) {
      push(item[key])
    }
    for (const key of ["images", "imageUrls", "content", "modules", "children"]) {
      visit(item[key])
    }
  }
  values.forEach(visit)
  return images
}

function normalizeAplusModules(...values: unknown[]): { type: string; desc: string }[] {
  for (const value of values) {
    if (!Array.isArray(value)) continue
    const modules = value
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
      .map(item => ({
        type: str(item.type) || str(item.name) || str(item.title),
        desc: str(item.desc) || str(item.description) || str(item.text),
      }))
      .filter(item => item.type || item.desc)
    if (modules.length) return modules
  }
  return []
}

function normalizeProductImages(
  d: Record<string, unknown>,
  extra: Record<string, unknown>
): { url: string; role: "main" | "secondary" }[] {
  const images: { url: string; role: "main" | "secondary" }[] = []
  const seen = new Set<string>()
  const urlFrom = (value: unknown): string => {
    if (typeof value === "string") return value.trim()
    if (!value || typeof value !== "object" || Array.isArray(value)) return ""
    const item = value as Record<string, unknown>
    for (const key of ["hiRes", "large", "l", "imageUrl", "url", "src"]) {
      if (typeof item[key] === "string" && item[key].trim()) {
        const raw = item[key].trim()
        return /^https?:\/\//i.test(raw)
          ? raw
          : `https://m.media-amazon.com/images/I/${raw.replace(/^\/+/, "")}`
      }
    }
    return ""
  }
  const push = (value: unknown, role: "main" | "secondary") => {
    const url = urlFrom(value)
    if (!/^(?:https?:\/\/|data:image\/)/i.test(url)) return
    if (/grey-pixel|gray-pixel|transparent-pixel|spacer\.gif/i.test(url)) return
    if (seen.has(url)) return
    seen.add(url)
    images.push({ url, role })
  }
  const pushMany = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(item => push(item, "secondary"))
    else push(value, "secondary")
  }

  for (const value of [
    d.imageUrl,
    d.mainImageUrl,
    d.mainImage,
    extra.imageUrl,
    extra.mainImageUrl,
    extra.mainImage,
  ]) {
    push(value, "main")
    if (images.some(image => image.role === "main")) break
  }
  for (const key of [
    "otherImagesUrl",
    "otherImageUrls",
    "imageUrls",
    "images",
    "gallery",
    "pictures",
    "productImages",
  ]) {
    pushMany(d[key])
    pushMany(extra[key])
  }
  if (images.length > 0 && !images.some(image => image.role === "main")) {
    images[0] = { ...images[0], role: "main" }
  }
  return images
}

function normalizeParamGroups(v: unknown): ProductParamGroup[] {
  if (!v || typeof v !== "object") return []
  if (Array.isArray(v)) return []

  const obj = v as Record<string, unknown>
  return Object.entries(obj)
    .filter(([, val]) => Array.isArray(val))
    .map(([name, val]) => {
      const fields = (val as unknown[][])
        .filter(pair => Array.isArray(pair) && pair.length >= 2)
        .map(pair => ({ k: str(pair[0]), v: str(pair[1]) }))
        .filter(f => f.k)
      return { name, fields }
    })
    .filter(g => g.fields.length > 0)
}

/**
 * overviews 键值对（服装类等新版详情版式：Fabric type / Care instructions / Origin…）→ P 卡「Product Details」参数组。
 * 这类页面没有 product_information 参数表，真实属性全在 overviews 里；与参数表重名（大小写不敏感）的键跳过。
 */
function normalizeOverviewGroups(
  overviews: unknown,
  existingGroups: ProductParamGroup[]
): ProductParamGroup[] {
  if (!overviews || typeof overviews !== "object" || Array.isArray(overviews)) return []

  const seen = new Set(existingGroups.flatMap(g => g.fields.map(f => f.k.trim().toLowerCase())))
  const fields = Object.entries(overviews as Record<string, unknown>)
    .map(([k, v]) => ({ k: str(k), v: str(v) }))
    .filter(f => f.k && f.v && !seen.has(f.k.trim().toLowerCase()))
  return fields.length ? [{ name: "Product Details", fields }] : []
}

function normalizePainPoints(v: unknown): ReviewPainPoint[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((p): p is Record<string, unknown> | string => !!p)
    .map(p => {
      if (typeof p === "string") return { text: p }
      return {
        text: str(p.text) || str(p.content),
        freq: typeof p.freq === "number" ? p.freq : undefined,
      }
    })
    .filter(p => p.text)
}

export interface AdaptedAuditEvidence {
  A: ListingEvidence
  B: ReviewEvidence
  P: ProductParamsEvidence
  C: CompetitorEvidence
}

function scalarStr(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim()
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return undefined
}

export interface RawReviewComments {
  commentList: { name?: string; comment?: string }[]
  starPercent: string[]
  reviewCount?: number | string
}

/** 评论原文抽样条数上限（沿爬虫顺序截前 N 条，原样透传；N 每次请求在 1~上限间随机） */
export const REVIEW_SAMPLES_LIMIT = 10

/** 抽样条数：1~REVIEW_SAMPLES_LIMIT 的随机整数（上限与随机共享同一常量，N=random ∈ [1, LIMIT]） */
export function randomReviewSampleCount(): number {
  return 1 + Math.floor(Math.random() * REVIEW_SAMPLES_LIMIT)
}

function rawCommentList(reviewData: Record<string, unknown>): unknown[] {
  return Array.isArray(reviewData.comment_list)
    ? reviewData.comment_list
    : Array.isArray(reviewData.commentList)
      ? reviewData.commentList
      : []
}

/**
 * 从商品详情接口响应中提取 B 卡评论痛点分析所需的原始评论。
 * 数据源：`data.review.comment_list`（每条 `{ customer, comment }`；2026-09 爬虫字段 name → customer，兼容旧缓存的 name）。
 */
export function extractReviewComments(resp: AuditDetailResponse): RawReviewComments {
  const d = resp.data ?? {}
  const reviewData = (d.review ?? d.reviews ?? {}) as Record<string, unknown>

  const commentList = rawCommentList(reviewData)
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map(c => ({
      name:
        typeof c.customer === "string"
          ? c.customer
          : typeof c.name === "string"
            ? c.name
            : undefined,
      comment:
        typeof c.comment === "string" ? c.comment : typeof c.content === "string" ? c.content : "",
    }))
    .filter(c => c.comment.trim())

  const rawSp = reviewData.star_percent ?? reviewData.starPercent ?? d.star_percent ?? d.starPercent
  const starPercent = Array.isArray(rawSp) ? rawSp.map(v => str(v)) : []

  const reviewCount =
    typeof d.reviewCount === "number" || typeof d.reviewCount === "string"
      ? d.reviewCount
      : typeof reviewData.reviewCount === "number" || typeof reviewData.reviewCount === "string"
        ? reviewData.reviewCount
        : undefined

  return { commentList, starPercent, reviewCount }
}

/** 下载原始评论的 8 列定义：表头 ↔ comment_list 条目 key（comment 保留 content 兼容；买家 2026-09 起爬虫改字段 name → customer，保留 name 兼容旧缓存）。 */
export const REVIEW_DOWNLOAD_COLUMNS: { header: string; keys: readonly [string, ...string[]] }[] = [
  { header: "买家", keys: ["customer", "name"] },
  { header: "日期", keys: ["date"] },
  { header: "星级", keys: ["star"] },
  { header: "标题", keys: ["title"] },
  { header: "评论正文", keys: ["comment", "content"] },
  { header: "已验证购买", keys: ["verified"] },
  { header: "有用数", keys: ["usefulNumber"] },
  { header: "变体", keys: ["variant"] },
]

/**
 * 下载原始评论的 8 列行数据（表头顺序同 REVIEW_DOWNLOAD_COLUMNS）。
 * 爬虫未下发的字段输出空串（列头保留），字段就位后零改动自动出值。
 */
export function extractReviewRows(resp: AuditDetailResponse): string[][] {
  const d = resp.data ?? {}
  const reviewData = (d.review ?? d.reviews ?? {}) as Record<string, unknown>

  return rawCommentList(reviewData)
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map(c => REVIEW_DOWNLOAD_COLUMNS.map(col => col.keys.map(k => str(c[k])).find(Boolean) ?? ""))
    .filter(row => row.some(cell => cell !== ""))
}

/**
 * 评论原文抽样：`comment_list` 原样透传（非 AI 产出），沿爬虫顺序截前 N 条有效样本；
 * N 为 1~REVIEW_SAMPLES_LIMIT 的随机整数（每次请求条数随机，条目仍沿爬虫顺序）。
 * date/rating/title 取爬虫给的常见键名，未给即缺省；text 缺失的条目跳过。
 */
export function extractReviewSamples(resp: AuditDetailResponse): ReviewSample[] {
  const d = resp.data ?? {}
  const reviewData = (d.review ?? d.reviews ?? {}) as Record<string, unknown>

  return rawCommentList(reviewData)
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map(c => {
      const text =
        typeof c.comment === "string" ? c.comment : typeof c.content === "string" ? c.content : ""
      if (!text.trim()) return undefined

      const date = scalarStr(c.date) ?? scalarStr(c.reviewDate) ?? scalarStr(c.createdAt)
      const ratingRaw = c.star ?? c.rating ?? c.score
      const rating = typeof ratingRaw === "number" ? ratingRaw : scalarStr(ratingRaw)
      const title = scalarStr(c.title) ?? scalarStr(c.summary)

      return {
        ...(date ? { date } : {}),
        ...(rating !== undefined ? { rating } : {}),
        ...(title ? { title } : {}),
        text,
      }
    })
    .filter((s): s is ReviewSample => !!s)
    .slice(0, randomReviewSampleCount())
}

export function adaptAuditDetail(resp: AuditDetailResponse): AdaptedAuditEvidence {
  const d = resp.data ?? {}
  const extra = (d.extra && typeof d.extra === "object" ? d.extra : {}) as Record<string, unknown>

  const title = str(d.title)
  const secondTitle = str(d.second_title) || str(extra.second_title)
  const brand = str(d.brand) || str(extra.brand)
  const categoryPath = str(d.nodeLabelPath) || str(extra.nodeLabelPath)
  const bullets = normalizeBullets(d)
  const description = normalizeDescription(d.description)
  const qa = normalizeQa(d.QA)

  const backendKw = strArr(d.searchTerms).length
    ? strArr(d.searchTerms)
    : strArr(d.backendKeywords).length
      ? strArr(d.backendKeywords)
      : strArr(extra.backendKeywords)

  const aplusModules = normalizeAplusModules(
    d.aplusModules,
    d.aplus_modules,
    d.aplus,
    extra.aplusModules,
    extra.aplus_modules
  )
  const aplusImages = normalizeAplusImages(
    d.aplusImages,
    d.aplus_images,
    d.aplus,
    d.aplusContent,
    d.aplusModules,
    d.aplus_modules,
    extra.aplusImages,
    extra.aplus_images,
    extra.aplus,
    extra.aplusContent,
    extra.aplusModules,
    extra.aplus_modules
  )
  const productImages = normalizeProductImages(d, extra)

  const imgCount =
    typeof d.imageCount === "number"
      ? d.imageCount
      : typeof extra.imageCount === "number"
        ? extra.imageCount
        : productImages.length || null

  const A: ListingEvidence = {
    filled: !!(
      title ||
      bullets.length ||
      description ||
      productImages.length ||
      aplusImages.length ||
      aplusModules.length
    ),
    title: title || undefined,
    // 键恒在：爬虫没给/为空时下发 null（2026-09-14 与前端约定）
    secondTitle: secondTitle || null,
    brand: brand || undefined,
    categoryPath: categoryPath || undefined,
    bullets: bullets.length ? bullets : undefined,
    description: description || undefined,
    searchTerms: backendKw.length ? backendKw : undefined,
    imageCount: imgCount,
    hasVideo: typeof d.hasVideo === "boolean" ? d.hasVideo : null,
    qa: qa.length ? qa : undefined,
    qaCount: qa.length || null,
    hasAplus:
      aplusImages.length > 0 || aplusModules.length > 0
        ? true
        : typeof d.hasAplus === "boolean"
          ? d.hasAplus
          : null,
    aplusImages: aplusImages.length ? aplusImages : undefined,
    aplusModules: aplusModules.length ? aplusModules : undefined,
    productImages: productImages.length ? productImages : undefined,
  }

  const reviewData = (d.review ?? d.reviews ?? {}) as Record<string, unknown>
  const rating =
    typeof d.rating === "number"
      ? d.rating
      : typeof reviewData.rating === "number"
        ? reviewData.rating
        : typeof d.rating === "string"
          ? parseFloat(d.rating) || null
          : null
  const reviewCount =
    typeof d.reviewCount === "number"
      ? d.reviewCount
      : typeof reviewData.reviewCount === "number"
        ? reviewData.reviewCount
        : typeof d.reviewCount === "string"
          ? parseInt(d.reviewCount, 10) || null
          : null

  const starLabels = ["5★", "4★", "3★", "2★", "1★"]
  const rawSp = d.star_percent ?? d.starPercent ?? reviewData.star_percent ?? reviewData.starPercent
  const starPercent = Array.isArray(rawSp) ? rawSp : []
  const dist: ReviewDistItem[] = starPercent.slice(0, 5).map((pct: unknown, i: number) => ({
    label: starLabels[i],
    pct: str(pct),
    bad: i >= 3,
  }))

  const reviewSamples = extractReviewSamples(resp)

  const B: ReviewEvidence = {
    filled: rating != null || reviewCount != null,
    rating,
    reviewCount,
    stars: rating ?? undefined,
    dist,
    richPainPoints: normalizePainPoints(reviewData.painPoints ?? reviewData.topNegative),
    ...(reviewSamples.length ? { reviewSamples } : {}),
  }

  const paramGroups = normalizeParamGroups(
    d.product_information_hhl ?? d.product_information ?? d.productInformation ?? d.params
  )
  // 服装类等新版详情页没有参数表，真实属性在 overviews 键值对里（top-level 优先、extra 兜底），并入 P 卡
  const overviewGroups = normalizeOverviewGroups(d.overviews ?? extra.overviews, paramGroups)
  const allParamGroups = [...paramGroups, ...overviewGroups]
  const P: ProductParamsEvidence = {
    filled: allParamGroups.length > 0,
    groups: allParamGroups.length ? allParamGroups : undefined,
  }

  const C: CompetitorEvidence = {
    filled: false,
    missingReason: "竞品关键词需 SIF 接口，暂未从商品详情接口获取",
  }

  return { A, B, P, C }
}
