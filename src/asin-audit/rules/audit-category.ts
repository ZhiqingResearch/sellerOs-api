/**
 * 审计类目判定（v2.3）：类目冻结清单必须「看页面前定稿」，因此类目判定由系统
 * 基于爬虫返回的类目路径做确定性关键词匹配，不交给模型。
 * 判定来源优先级：dto.categoryHint（前端显式指定）> A 卡 categoryPath（爬虫 nodeLabelPath）。
 * 不命中返回 null → 走通用细则，不追加任何类目覆盖层。
 */

import type { AuditEvidence } from "../types/audit.types"

export type AuditCategory = "computer"

/** 电脑整机类目关键词（对类目路径小写匹配） */
const COMPUTER_KEYWORDS = [
  "laptop",
  "notebook",
  "chromebook",
  "desktop",
  "mini pc",
  "all-in-one",
  "gaming pc",
  "workstation",
  "barebone",
] as const

/**
 * 配件/部件排除词：路径同时命中电脑词与这些词时视为配件/部件，不算整机。
 * 注意不能放 "accessor"——Amazon 电脑部门的根节点本身就是 "Computers & Accessories"。
 */
const ACCESSORY_KEYWORDS = [
  "bag",
  "sleeve",
  "case",
  "cover",
  "charger",
  "adapter",
  "mouse",
  "keyboard",
  "monitor",
  "stand",
  "sticker",
  "skin",
  "cooling pad",
  "cable",
  "hub",
  "dock",
  "battery",
  "power supply",
  "component",
  "part",
  "printer",
  "paper",
  "office",
] as const

export function resolveAuditCategory(
  evidence: Pick<AuditEvidence, "A">,
  hint?: string | null
): AuditCategory | null {
  if (hint === "computer") return "computer"
  const path = evidence.A.categoryPath?.trim().toLowerCase()
  if (!path) return null
  if (ACCESSORY_KEYWORDS.some(k => path.includes(k))) return null
  return COMPUTER_KEYWORDS.some(k => path.includes(k)) ? "computer" : null
}
