import type {
  BsrTrendPrecompute,
  OpportunityKeyword,
  PositionAllocationRow,
  TrafficPrecompute,
  TrafficStructure,
  TrafficTierBuckets,
} from "../types/de.types"
import type {
  SifAsinKeywordRow,
  SifAsinOpTrafficTrendData,
  SifKeywordOverviewRow,
} from "../types/sif.types"
import { filterForbiddenKeywords } from "./forbidden-words"

/** 卖家精灵字段 → Sif 按月反查字段的逐词折算（口径见 docs/references/ASIN审计-需求更新-Sif字段映射.md）。 */
interface KwDerived {
  kw: string
  searches: number // searchVolume / estSearchesNum
  totalScore: number
  naturalRatio: number | null // naturalScore / totalScore
  adRatio: number | null // adScore / totalScore
  trafficPct: number // totalScore / Σ totalScore × 100
  page: number | null // naturalPositionSeq[last].page
  allPageRank: number | null // naturalPositionSeq[last].allPageRank
  hasNatural: boolean
  purchaseRate: number | null // conversionShared / 100（无值=未知）
}

function lastNatural(row: SifAsinKeywordRow): { page: number | null; allPageRank: number | null } {
  const seq = row.naturalPositionSeq
  if (!seq?.length) return { page: null, allPageRank: null }
  const last = seq[seq.length - 1]
  const allPageRank = last.allPageRank ?? null
  const page =
    last.page ??
    (allPageRank != null ? (allPageRank <= 48 ? 1 : Math.ceil(allPageRank / 48)) : null)
  return { page, allPageRank }
}

function deriveRows(
  list: SifAsinKeywordRow[],
  ov: Record<string, SifKeywordOverviewRow>
): { rows: KwDerived[]; totalScoreSum: number } {
  const totalScoreSum = list.reduce((s, k) => s + (k.totalScore ?? 0), 0) || 1
  const rows: KwDerived[] = list.map(k => {
    const totalScore = k.totalScore ?? 0
    const { page, allPageRank } = lastNatural(k)
    const conv = k.conversionShared
    return {
      kw: k.keyword,
      searches: ov[k.keyword]?.estSearchesNum ?? k.searchVolume ?? 0,
      totalScore,
      naturalRatio: totalScore > 0 ? (k.naturalScore ?? 0) / totalScore : null,
      adRatio: totalScore > 0 ? (k.adScore ?? 0) / totalScore : null,
      trafficPct: (totalScore / totalScoreSum) * 100,
      page,
      allPageRank,
      hasNatural: (k.naturalPositionSeq ?? []).length > 0,
      purchaseRate: conv != null ? conv / 100 : null,
    }
  })
  return { rows, totalScoreSum }
}

function homepageHitScore(hits: number): { score: number; max: number; label: string } {
  if (hits >= 7) return { score: 5, max: 5, label: "7~10 个首页命中" }
  if (hits >= 4) return { score: 3, max: 5, label: "4~6 个首页命中" }
  if (hits >= 1) return { score: 1, max: 5, label: "1~3 个首页命中" }
  return { score: 0, max: 5, label: "0 个首页命中" }
}

function naturalHealthScore(pct: number | null): { score: number; max: number; label: string } {
  if (pct == null) return { score: 0, max: 4, label: "自然占比数据不足" }
  if (pct >= 70) return { score: 4, max: 4, label: `加权自然占比 ${pct.toFixed(0)}%（≥70%）` }
  if (pct >= 50) return { score: 2, max: 4, label: `加权自然占比 ${pct.toFixed(0)}%（50~70%）` }
  if (pct >= 30) return { score: 1, max: 4, label: `加权自然占比 ${pct.toFixed(0)}%（30~50%）` }
  return { score: 0, max: 4, label: `加权自然占比 ${pct.toFixed(0)}%（<30%）` }
}

function concentrationScore(pct: number): { score: number; max: number; label: string } {
  if (pct < 20) return { score: 3, max: 3, label: `Top1 贡献 ${pct.toFixed(0)}%（<20%）` }
  if (pct < 35) return { score: 2, max: 3, label: `Top1 贡献 ${pct.toFixed(0)}%（20~35%）` }
  if (pct <= 50) return { score: 1, max: 3, label: `Top1 贡献 ${pct.toFixed(0)}%（35~50%）` }
  return { score: 0, max: 3, label: `Top1 贡献 ${pct.toFixed(0)}%（>50%）` }
}

function fmtVol(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(Math.round(n))
}

function currentRankLabel(r: KwDerived): string {
  if (!r.hasNatural || r.allPageRank == null) return "无排名"
  const page = r.page ?? Math.max(1, Math.ceil(r.allPageRank / 48))
  return `P${page}-pos.${r.allPageRank}`
}

/** 子维度1 位置分配规则：高搜索量 → 标题；中搜索量 → Bullet；低/无排名 → Search Term。 */
function suggestPosition(searches: number): string {
  if (searches >= 30_000) return "Title 前 40 字符"
  if (searches >= 10_000) return "Bullet 1 开头"
  return "Search Term"
}

/** 机会词识别：searches≥1000 + 自然排名非首页 + purchaseRate≥1.5%（无值不排除）+ adRatio<30%（无值不排除）。 */
function isOpportunity(r: KwDerived): boolean {
  if (r.searches < 1000) return false
  const offFirstPage =
    !r.hasNatural ||
    (r.page != null && r.page >= 2) ||
    (r.allPageRank != null && r.allPageRank > 48)
  if (!offFirstPage) return false
  if (r.purchaseRate != null && r.purchaseRate < 0.015) return false
  if (r.adRatio != null && r.adRatio >= 0.3) return false
  return true
}

/**
 * 从 Sif 按月反查词表计算第⑧维「关键词与流量承接诊断」预计算块，
 * 同时产出优化阶段所需的位置分配 / 机会词 / 集中度原料，注入 LLM prompt。
 * 入口先过滤确定性禁词（促销词 / 商标符 / 静态竞品品牌词，无兼容前缀）：
 * 禁词不是关键词覆盖义务（未使用不扣分），不得进入 G1/G3 覆盖分母与评分原料。
 */
export function computeTrafficPrecompute(
  list: SifAsinKeywordRow[],
  overviewList: SifKeywordOverviewRow[]
): TrafficPrecompute {
  const { kept: keptKeywords, dropped } = filterForbiddenKeywords(list.map(k => k.keyword))
  const keptSet = new Set(keptKeywords)
  const cleanList = list.filter(k => keptSet.has(k.keyword))

  const ov: Record<string, SifKeywordOverviewRow> = {}
  for (const o of overviewList) ov[o.keyword] = o

  const { rows, totalScoreSum } = deriveRows(cleanList, ov)

  // —— 子维度1：核心词首页命中（按 searches 降序取 Top10）——
  const bySearches = [...rows].sort((a, b) => b.searches - a.searches)
  const top10 = bySearches.slice(0, 10)
  const top10Page1Hits = top10.filter(r => r.page === 1).length
  const homepageHitTier = homepageHitScore(top10Page1Hits)

  // —— 子维度2：自然流量健康度（加权平均自然占比 = Σ naturalScore / Σ totalScore）——
  const naturalScoreSum = cleanList.reduce((s, k) => s + (k.naturalScore ?? 0), 0)
  const weightedNaturalPct = totalScoreSum > 0 ? (naturalScoreSum / totalScoreSum) * 100 : null
  const naturalHealthTier = naturalHealthScore(weightedNaturalPct)

  // —— 子维度4：流量集中度风险（trafficPct 最高的单词）——
  const byScore = [...rows].sort((a, b) => b.totalScore - a.totalScore)
  const top1ConcentrationPct = byScore[0]?.trafficPct ?? 0
  const concentrationTier = concentrationScore(top1ConcentrationPct)

  // —— 机会词识别（候选，最终是否未覆盖由 LLM 结合 A 卡交叉比对）——
  const opportunities = rows.filter(isOpportunity)
  const opportunityCount = opportunities.length
  const opportunityList: OpportunityKeyword[] = opportunities
    .map(r => ({
      kw: r.kw,
      searches: r.searches,
      searchVolLabel: fmtVol(r.searches),
      purchaseRatePct: r.purchaseRate != null ? +(r.purchaseRate * 100).toFixed(2) : null,
      naturalRatioPct: r.naturalRatio != null ? +(r.naturalRatio * 100).toFixed(1) : null,
      page: r.page,
      allPageRank: r.allPageRank,
      value: +(r.searches * (r.purchaseRate ?? 0.02)).toFixed(0),
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12)

  // —— 流量层级打标 ——
  const tierBuckets: TrafficTierBuckets = {
    core: 0,
    waist: 0,
    longtail: 0,
    opportunity: opportunityCount,
  }
  for (const r of rows) {
    if (r.searches > 50_000 && r.trafficPct > 5) tierBuckets.core += 1
    else if (r.searches >= 10_000) tierBuckets.waist += 1
    else tierBuckets.longtail += 1
  }

  // —— 流量结构分析 ——
  const adScoreSum = cleanList.reduce((s, k) => s + (k.adScore ?? 0), 0)
  const top5ScoreSum = byScore.slice(0, 5).reduce((s, r) => s + r.totalScore, 0)
  const homepageHits = rows.filter(r => r.page === 1).length
  const structure: TrafficStructure = {
    naturalPct: weightedNaturalPct != null ? +weightedNaturalPct.toFixed(1) : null,
    adDependencyPct: totalScoreSum > 0 ? +((adScoreSum / totalScoreSum) * 100).toFixed(1) : null,
    top5ConcentrationPct:
      totalScoreSum > 0 ? +((top5ScoreSum / totalScoreSum) * 100).toFixed(1) : 0,
    homepageHitRate: rows.length ? +((homepageHits / rows.length) * 100).toFixed(1) : 0,
    homepageHits,
    totalKw: rows.length,
  }

  // —— 子维度1 优化原料：Top10 中未进首页的词 → 位置分配表 ——
  const positionAllocation: PositionAllocationRow[] = top10
    .filter(r => r.page !== 1)
    .map(r => ({
      kw: r.kw,
      searches: r.searches,
      searchVolLabel: fmtVol(r.searches),
      currentRank: currentRankLabel(r),
      suggestPosition: suggestPosition(r.searches),
    }))

  // —— 子维度4 优化原料：头部词 + 可分散的腰部词候选 ——
  const headKeyword = byScore[0]
    ? {
        kw: byScore[0].kw,
        searches: byScore[0].searches,
        searchVolLabel: fmtVol(byScore[0].searches),
        trafficPct: +byScore[0].trafficPct.toFixed(1),
      }
    : null
  const waistCandidates = rows
    .filter(r => r.searches >= 10_000 && r.searches <= 50_000)
    .sort((a, b) => b.searches - a.searches)
    .slice(0, 5)
    .map(r => ({ kw: r.kw, searchVolLabel: fmtVol(r.searches) }))

  const summaryLines = [
    ...(dropped.length
      ? [
          `已剔除确定性禁词 ${dropped.length} 个（${dropped
            .slice(0, 5)
            .map(d => `${d.kw}：${d.reason}`)
            .join(
              "；"
            )}${dropped.length > 5 ? " 等" : ""}）——禁词与竞品在用词不是覆盖义务，listing 未使用不扣分`,
        ]
      : []),
    `按 searches 降序 Top10 自然排名首页(page==1)命中：${top10Page1Hits} 个 → 建议得分 ${homepageHitTier.score}/${homepageHitTier.max}`,
    naturalHealthTier.label + ` → 建议得分 ${naturalHealthTier.score}/${naturalHealthTier.max}`,
    `机会词候选（searches≥1000 + 自然排名非首页 + purchaseRate≥1.5% + adRatio<30%）约 ${opportunityCount} 个；覆盖率请结合 A 卡文案交叉比对（≥60%或机会词为0=4 / 40~60%=2 / 20~40%=1 / <20%=0）`,
    concentrationTier.label + ` → 建议得分 ${concentrationTier.score}/${concentrationTier.max}`,
  ]

  return {
    top10Page1Hits,
    homepageHitTier,
    weightedNaturalPct,
    naturalHealthTier,
    opportunityCount,
    top1ConcentrationPct,
    concentrationTier,
    summaryLines,
    tierBuckets,
    structure,
    opportunityList,
    positionAllocation,
    concentration: { headKeyword, waistCandidates },
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function mean(values: number[]): number | null {
  if (!values.length) return null
  return values.reduce((s, v) => s + v, 0) / values.length
}

/**
 * I3 排名趋势预计算（BSR 口径）：取 SIF asinOpTrafficTrend 尾部 14 天日级 BSR，
 * 前 7 天 vs 后 7 天。保持率 = min(1, 前7天均 ÷ 后7天均)（改善封顶不加分），
 * 建议得分 = 8 × 保持率。有效天数 <10 或任一窗口有效 <4 天 → 待核（available=false）。
 */
export function computeBsrTrendPrecompute(
  trend: SifAsinOpTrafficTrendData | null | undefined
): BsrTrendPrecompute {
  const windowDays = 14
  const empty: BsrTrendPrecompute = {
    available: false,
    reason: "SIF 运营趋势未返回 BSR 序列",
    windowDays,
    validDays: 0,
    prev7AvgBsr: null,
    last7AvgBsr: null,
    retainedPct: null,
    declinedDays: 0,
    tier: { score: 0, max: 8, label: "数据不足" },
  }
  if (!trend?.dates?.length || !trend.bsr?.length) return empty

  const start = Math.max(0, trend.dates.length - windowDays)
  const series: Array<{ date: string; bsr: number | null }> = []
  for (let i = start; i < trend.dates.length; i++) {
    const bsr = trend.bsr[i]
    series.push({
      date: trend.dates[i],
      bsr: typeof bsr === "number" && Number.isFinite(bsr) ? bsr : null,
    })
  }
  if (!series.length) return empty
  // 近 7 天视图序列：14 天窗口尾部 7 天（窗口本身不足 7 天时随之少于 7 条）
  const series7 = series.slice(-7)

  const half = Math.floor(series.length / 2)
  const prevHalf = series.slice(0, half)
  const lastHalf = series.slice(half)
  const prevValid = prevHalf.filter(p => p.bsr != null).map(p => p.bsr as number)
  const lastValid = lastHalf.filter(p => p.bsr != null).map(p => p.bsr as number)
  const validDays = prevValid.length + lastValid.length

  const prev7AvgBsr = mean(prevValid)
  const last7AvgBsr = mean(lastValid)
  const insufficient =
    validDays < 10 ||
    prevValid.length < 4 ||
    lastValid.length < 4 ||
    prev7AvgBsr == null ||
    last7AvgBsr == null
  if (insufficient) {
    return {
      available: false,
      reason: `近 14 天 BSR 日级序列不足（有效 ${validDays}/${series.length} 天，前 7 天 ${prevValid.length} 天、后 7 天 ${lastValid.length} 天）`,
      windowDays,
      validDays,
      prev7AvgBsr: round2(prev7AvgBsr ?? 0) || null,
      last7AvgBsr: round2(last7AvgBsr ?? 0) || null,
      retainedPct: null,
      declinedDays: 0,
      tier: { score: 0, max: 8, label: "数据不足" },
      series,
      series7,
    }
  }

  // 改善封顶：后 7 天均值更优（更小）或持平 → 保持率 100%
  const retainedRatio = Math.min(1, (prev7AvgBsr ?? 0) / (last7AvgBsr || 1))
  const retainedPct = +(retainedRatio * 100).toFixed(1)
  const score = round2(8 * retainedRatio)

  // 尾部连续劣于前 7 天基线（bsr 严格大于基线）的天数，遇 null 或转好即停
  const baseline = prev7AvgBsr
  let declinedDays = 0
  for (let i = series.length - 1; i >= 0; i--) {
    const bsr = series[i].bsr
    if (bsr == null || bsr <= baseline) break
    declinedDays++
  }

  return {
    available: true,
    windowDays,
    validDays,
    prev7AvgBsr: round2(prev7AvgBsr ?? 0),
    last7AvgBsr: round2(last7AvgBsr ?? 0),
    retainedPct,
    declinedDays,
    tier: {
      score,
      max: 8,
      label: `前 7 天均 BSR ${round2(prev7AvgBsr ?? 0)} vs 后 7 天均 ${round2(last7AvgBsr ?? 0)}，保持率 ${retainedPct}%`,
    },
    series,
    series7,
  }
}
