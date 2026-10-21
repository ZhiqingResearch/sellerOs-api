/**
 * 竞品配件/周边过滤（C 卡）：MCP asin_competitor 按目标 ASIN 返回的同款竞品里，
 * 再兜一层确定性剔除。判定相对目标：
 * - 候选命中配件词、而目标没命中其中任何一个 → 剔除（打印纸/支架等非同品类）；
 * - 目标本身就是配件（如笔记本包）时，候选与其共享任一配件词即放行，不误杀同配件竞品；
 * - 目标参照缺失时不过滤（调用方自行降级）。确定性规则不交给模型，与 audit-category.ts 同思路。
 */

/** 配件/周边词（对候选的「类目路径+标题」小写匹配，词首边界、词尾开放以命中复数/派生）。
 * 注意与 audit-category.ts 的 ACCESSORY_KEYWORDS（类目路径专用）不同：这里会匹配标题，
 * 不收 "office"/"part"/"component" 这类在标题里高频误伤的词（笔记本标题常见 Office 365）。 */
const COMPETITOR_ACCESSORY_KEYWORDS = [
  "printer",
  "paper",
  "ink",
  "toner",
  "cartridge",
  "case",
  "cover",
  "sleeve",
  "bag",
  "skin",
  "sticker",
  "decal",
  "charger",
  "adapter",
  "cable",
  "cord",
  "hub",
  "dock",
  "mouse",
  "keyboard",
  "monitor",
  "stand",
  "mount",
  "riser",
  "holder",
  "battery",
  "power supply",
  "cooling pad",
  "headset",
  "headphone",
  "earbud",
  "stylus",
  "screen protector",
] as const

function keywordHit(text: string, keyword: string): boolean {
  return new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text)
}

function hitAccessoryWords(text: string): string[] {
  return COMPETITOR_ACCESSORY_KEYWORDS.filter(k => keywordHit(text, k))
}

export interface CompetitorCandidate {
  asin: string
  title?: string
  brand?: string
  nodeLabelPath?: string
}

export interface CompetitorDrop {
  asin: string
  reason: string
}

export interface CompetitorFilterResult {
  kept: CompetitorCandidate[]
  dropped: CompetitorDrop[]
}

/**
 * 按配件/周边词过滤竞品候选，保持源顺序，kept 截前 limit 个。
 * target.title 与 target.brand 均为空（参照缺失）时原样放行，交由调用方告警降级。
 */
export function filterCompetitorCandidates(
  candidates: CompetitorCandidate[],
  target: { title?: string | null; brand?: string | null },
  limit = 3
): CompetitorFilterResult {
  const targetText = `${target.title ?? ""} ${target.brand ?? ""}`.toLowerCase()
  const useFilter = targetText.trim().length > 0

  const kept: CompetitorCandidate[] = []
  const dropped: CompetitorDrop[] = []
  for (const c of candidates) {
    const haystack = `${c.nodeLabelPath ?? ""} ${c.title ?? ""}`.toLowerCase()
    if (!haystack.trim()) {
      dropped.push({ asin: c.asin, reason: "无标题与类目信息，无法判定品类" })
      continue
    }
    const candidateHits = useFilter ? hitAccessoryWords(haystack) : []
    const sharesAccessoryWithTarget =
      candidateHits.length > 0 && candidateHits.some(k => keywordHit(targetText, k))
    // 候选是配件向、且与目标没有任何共同配件词 → 非同品类
    if (candidateHits.length > 0 && !sharesAccessoryWithTarget) {
      dropped.push({ asin: c.asin, reason: `配件/周边词「${candidateHits[0]}」与目标品类不符` })
      continue
    }
    kept.push(c)
  }
  return { kept: kept.slice(0, limit), dropped }
}
