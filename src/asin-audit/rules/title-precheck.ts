/**
 * A1 品牌词机械预检（确定性字符串检查，v2.2）：
 * 「品牌词是否出现在标题中」不交给模型自由判断——服务端预检后
 * 注入 prompt（禁止推翻）并作为 deduction 事实护栏（误判扣分返还）。
 * 品牌词来源：A 卡 brand（爬虫详情）→ P 卡 Brand/品牌 属性兜底；两处都无 → 不预检（返回 null）。
 */

import type { ListingEvidence, ProductParamsEvidence } from "../types/audit.types"

export interface TitleBrandPrecheck {
  brand: string
  /** 品牌词（大小写不敏感）是否出现在标题中 */
  inTitle: boolean
  /** 首个命中词的 1-based 词序号；未命中为 null */
  position: number | null
}

export function resolveListingBrand(A: ListingEvidence, P?: ProductParamsEvidence): string | null {
  const fromA = A.brand?.trim()
  if (fromA) return fromA
  for (const group of P?.groups ?? []) {
    for (const field of group.fields) {
      if (/brand|品牌/i.test(field.k) && field.v.trim()) return field.v.trim()
    }
  }
  return null
}

export function precheckBrandInTitle(
  A: ListingEvidence,
  P?: ProductParamsEvidence
): TitleBrandPrecheck | null {
  const brand = resolveListingBrand(A, P)
  const title = A.title?.trim()
  if (!brand || !title) return null

  const needle = brand.toLowerCase()
  const words = title.split(/\s+/)
  const position = words.findIndex(w => w.toLowerCase().includes(needle))
  return {
    brand,
    inTitle: position >= 0,
    position: position >= 0 ? position + 1 : null,
  }
}
