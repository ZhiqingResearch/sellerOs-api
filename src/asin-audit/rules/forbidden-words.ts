/**
 * 禁词红线机械层（v2.4，打分 + 优化共用）：
 * 查询出的关键词（D 卡反查词 / C 卡竞品词等）属分析数据——不得进入优化后的 listing，
 * 也不得作为打分的关键词覆盖义务（未使用不扣分）。
 * 本模块只兜「确定性禁词」：高置信促销词 / 商标符 / 静态竞品品牌·型号词；
 * 长尾他人品牌·型号词机械不可判定，交提示词红线层判断（见 prompts/asin-audit-optimize.md / asin-audit-score.md）。
 * 兼容表述例外：「for / compatible with / fits / für + 他人品牌型号」允许保留（仅表达适配关系）。
 */

export const TRADEMARK_CHARS_RE = /[™®©]/

/**
 * 静态竞品品牌 / 型号词（与 prompts/references/sensitive-words.md 同源，非穷尽）。
 * 命中且无兼容前缀 → 弃；有兼容前缀 → 保留。
 */
export const STATIC_COMPETITOR_BRANDS: string[] = [
  "microsoft",
  "samsung",
  "nvidia",
  "lenovo",
  "inspiron",
]

/** 兼容表述前缀（出现在品牌词之前才算兼容表达，如 "case for microsoft surface"）。 */
const COMPAT_PREFIX_RE = /\b(?:for|compatible with|fits?\b|für|fuer|适配|适用于)/i

/** 高置信促销词（打分侧标题归零门 cdq-policy 的超集；语义边缘词如 cheap/gift 交提示词层）。 */
export const PROMO_WORD_PATTERNS: RegExp[] = [
  /\bfree shipping\b/i,
  /\bfree returns?\b/i,
  /\bfast delivery\b/i,
  /\bbest ?sellers?\b/i,
  /\btop[- ]?rated\b/i,
  /\bnumber\s*one\b/i,
  /#\s*1\b/,
  /\b100%\s*(guarantee|guaranteed|satisfaction)\b/i,
  /\bmoney[- ]?back\b/i,
  /\bon sale\b/i,
  /\bhot sale\b/i,
  /\bwholesale\b/i,
  /包邮|特价|秒杀/,
]

export interface ForbiddenHit {
  kw: string
  reason: string
}

export interface ForbiddenFilterResult {
  kept: string[]
  dropped: ForbiddenHit[]
}

/**
 * 判定单个关键词是否命中确定性禁词。命中返回原因，未命中返回 null。
 * 静态品牌词带兼容前缀（兼容词出现在品牌词之前）不算命中。
 */
export function isForbiddenKeyword(term: string): string | null {
  const kw = term?.trim()
  if (!kw) return null
  for (const re of PROMO_WORD_PATTERNS) {
    const m = kw.match(re)
    if (m) return `促销词「${m[0]}」`
  }
  const tm = kw.match(TRADEMARK_CHARS_RE)
  if (tm) return `商标符「${tm[0]}」`
  const lower = kw.toLowerCase()
  for (const brand of STATIC_COMPETITOR_BRANDS) {
    const idx = lower.indexOf(brand)
    if (idx < 0) continue
    if (COMPAT_PREFIX_RE.test(kw.slice(0, idx))) continue
    return `竞品品牌/型号词「${brand}」（无兼容前缀）`
  }
  return null
}

/** 批量过滤确定性禁词。kept 保持原顺序；dropped 带命中原因供日志与提示。 */
export function filterForbiddenKeywords(terms: string[]): ForbiddenFilterResult {
  const kept: string[] = []
  const dropped: ForbiddenHit[] = []
  for (const term of terms ?? []) {
    const reason = isForbiddenKeyword(term)
    if (reason) dropped.push({ kw: term, reason })
    else if (term?.trim()) kept.push(term)
  }
  return { kept, dropped }
}
