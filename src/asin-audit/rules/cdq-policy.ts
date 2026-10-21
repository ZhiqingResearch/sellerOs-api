/**
 * 标题政策违规归零兜底（从 Web lib/cdq-score.ts 等价迁移的 ASIN 审计所需部分；
 * 其余 Listing 评分逻辑不迁）。命中促销词或装饰性特殊字符 → 强制 D 级、total=0。
 * 对应官方 PPT p9「标题违规 → 评分直接归零」。
 */

import type { ScoutScoreResult } from "../types/scout.types"

const TITLE_PROMO_PATTERNS: RegExp[] = [
  /\bfree shipping\b/i,
  /\bbest ?sellers?\b/i,
  /\bbestsellers?\b/i,
  /\btop[- ]?rated\b/i,
  /\bnumber\s*one\b/i,
  /#\s*1\b/,
  /\b100%\s*(guarantee|guaranteed)\b/i,
  /\bmoney[- ]?back\b/i,
  /\bon sale\b/i,
]
// 亚马逊标题禁止的装饰性特殊字符（允许 & - , . : ( ) ' / 等常规标点）。
const TITLE_FORBIDDEN_CHARS = /[!$?_~*^¬€¥]/

/**
 * 标题政策违规归零兜底。命中促销词或装饰性特殊字符 → 强制 D 级、total=0，
 * 并把命中信息塞进 severeDefects 与 suggestions[0]。无命中则原样返回。
 * 仅用于 Amazon（Walmart 不走 CDQ 归零）。
 */
export function enforceTitlePolicyGate(result: ScoutScoreResult, title: string): ScoutScoreResult {
  const defects: string[] = []
  for (const re of TITLE_PROMO_PATTERNS) {
    const m = title.match(re)
    if (m) {
      defects.push(`标题含违禁促销用语「${m[0]}」（U 级政策违规，评分归零）`)
      break
    }
  }
  const charMatch = title.match(TITLE_FORBIDDEN_CHARS)
  if (charMatch) {
    defects.push(`标题含违禁特殊字符「${charMatch[0]}」（U 级政策违规，评分归零）`)
  }
  if (defects.length === 0) return result

  return {
    ...result,
    total: 0,
    potential: "D级 · 必须重新生成",
    severeDefects: [...(result.severeDefects ?? []), ...defects],
    suggestions: [
      `${defects.join("；")}。请先删除标题中的违禁内容再重新评分——此类问题会导致 Listing 评分直接归零。`,
      ...result.suggestions,
    ],
  }
}
