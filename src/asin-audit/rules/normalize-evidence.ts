import type { DeEvidenceResult } from "../types/audit.types"
import type { Market } from "../types/scout.types"
import { parseListingPasteLoose } from "./parse-listing"

export type {
  AsinPerformanceEvidence,
  AsinPriceBsrSnapshot,
  AuditEvidence,
  AuditEvidenceCard,
  AuditGrade,
  AuditScoreResult,
  CompetitorEvidence,
  DeEvidenceResult,
  KeywordTrafficEvidence,
  KeywordTrafficTopRow,
  ListingEvidence,
  ProductParamsEvidence,
  ReviewEvidence,
  TrafficPrecompute,
} from "../types/audit.types"

import type {
  AuditEvidence,
  CompetitorEvidence,
  ListingEvidence,
  ProductParamsEvidence,
  ReviewEvidence,
} from "../types/audit.types"

export interface AbpcData {
  A?: ListingEvidence
  B?: ReviewEvidence
  P?: ProductParamsEvidence
  C?: CompetitorEvidence
}

function emptyListing(): ListingEvidence {
  return { filled: false }
}

function emptyP(): ProductParamsEvidence {
  return { filled: false, missingReason: "一期未接入 Product Information 抓取" }
}

function emptyB(): ReviewEvidence {
  return { filled: false, missingReason: "一期未接入评论痛点服务" }
}

function emptyC(): CompetitorEvidence {
  return { filled: false, missingReason: "一期未接入 SIF 竞品词卡" }
}

/**
 * 将 D/E 取证结果 + 用户粘贴文本 + ABPC 商品详情 组装为完整 AuditEvidence。
 * 兼容直接传六卡 AuditEvidence（合成版 evidence 接口的 done.result 整包入参）：
 * 传入对象自带 filled 的 A/P/B/C 卡时优先采用（等效于 abpc 展开）。
 */
export function normalizeAuditEvidence(
  de: DeEvidenceResult,
  market: Market,
  pastedContent?: string,
  abpc?: AbpcData
): AuditEvidence {
  const paste = pastedContent?.trim() ?? ""
  // 六卡形状（AuditEvidence）直接透传：A/P/B/C 已 filled 时视作 abpc 展开
  const mergedAbpc: AbpcData = {
    A: abpc?.A?.filled
      ? abpc.A
      : (de as unknown as AbpcData).A?.filled
        ? (de as unknown as AbpcData).A
        : undefined,
    P: abpc?.P?.filled
      ? abpc.P
      : (de as unknown as AbpcData).P?.filled
        ? (de as unknown as AbpcData).P
        : undefined,
    B: abpc?.B?.filled
      ? abpc.B
      : (de as unknown as AbpcData).B?.filled
        ? (de as unknown as AbpcData).B
        : undefined,
    C: abpc?.C?.filled
      ? abpc.C
      : (de as unknown as AbpcData).C?.filled
        ? (de as unknown as AbpcData).C
        : undefined,
  }

  let A: ListingEvidence = mergedAbpc.A?.filled ? mergedAbpc.A : emptyListing()

  if (paste && !A.filled) {
    const parsed = parseListingPasteLoose(paste)
    const hasContent =
      !!parsed.title || parsed.bullets.length > 0 || !!parsed.description || !!parsed.searchTerms
    if (hasContent) {
      A = {
        filled: true,
        title: parsed.title || undefined,
        bullets: parsed.bullets.length ? parsed.bullets : undefined,
        description: parsed.description || undefined,
        searchTerms: parsed.searchTerms
          ? parsed.searchTerms.split(/[\s,，]+/).filter(Boolean)
          : undefined,
        rawPaste: paste,
      }
    }
  }

  const P: ProductParamsEvidence = mergedAbpc.P?.filled ? mergedAbpc.P : emptyP()
  const B: ReviewEvidence = mergedAbpc.B?.filled ? mergedAbpc.B : emptyB()
  const C: CompetitorEvidence = mergedAbpc.C?.filled ? mergedAbpc.C : emptyC()

  // 六卡取证传入的 Apify 来源需保留，显式 abpc 覆盖仍按既有 ERP 来源。
  const productSource = (card: "A" | "P" | "B"): "erp" | "apify" => {
    const sources = (de as unknown as AuditEvidence).meta?.sources?.[card]
    return !abpc?.[card]?.filled && Array.isArray(sources) && sources.includes("apify")
      ? "apify"
      : "erp"
  }

  return {
    asin: de.asin,
    country: de.country,
    market,
    A,
    P,
    B,
    C,
    D: de.D,
    E: de.E,
    meta: {
      sources: {
        ...(A.filled ? { A: [mergedAbpc.A ? productSource("A") : ("paste" as const)] } : {}),
        ...(P.filled ? { P: [productSource("P")] } : {}),
        ...(B.filled ? { B: [productSource("B")] } : {}),
        ...(C.filled ? { C: ["erp" as const] } : {}),
        D: de.meta.sources.D,
        E: de.E.adCleaning ? ["sif" as const, "upload" as const] : de.meta.sources.E,
      },
      sifDataReady: de.meta.sifDataReady,
      sifWarnings: de.meta.sifWarnings,
      fetchedAt: de.meta.fetchedAt,
      estimatedPoints: de.meta.estimatedPoints,
    },
  }
}

export function collectMissingEvidence(evidence: AuditEvidence): string[] {
  const missing: string[] = []
  if (!evidence.A.filled) missing.push("A.listing")
  if (!evidence.P.filled) missing.push("P.params")
  if (!evidence.B.filled) missing.push("B.reviews")
  if (!evidence.C.filled) missing.push("C.competitors")
  if (!evidence.D.filled) missing.push("D.traffic")
  if (!evidence.E.filled) missing.push("E.performance")
  return missing
}
