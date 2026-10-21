import type { SifAsinKeywordRow, SifAsinOpTrafficTrendData } from "../types/sif.types"
import { computeBsrTrendPrecompute, computeTrafficPrecompute } from "./traffic-precompute"

function kwRow(partial: Partial<SifAsinKeywordRow> & { keyword: string }): SifAsinKeywordRow {
  return {
    asin: "B07KVV8RFF",
    keyword: partial.keyword,
    totalScore: partial.totalScore ?? 100,
    naturalScore: partial.naturalScore ?? 60,
    adScore: partial.adScore ?? 40,
    searchVolume: partial.searchVolume,
    conversionShared: partial.conversionShared,
    naturalPositionSeq: partial.naturalPositionSeq,
    keywordTags: partial.keywordTags,
  }
}

describe("computeTrafficPrecompute", () => {
  it("scores homepage hits from searches-desc Top10 by page==1", () => {
    const list: SifAsinKeywordRow[] = [
      kwRow({
        keyword: "high vol miss",
        searchVolume: 100_000,
        totalScore: 50,
        naturalPositionSeq: [{ date: "2026-01-01", page: 2, allPageRank: 55 }],
      }),
      kwRow({
        keyword: "high vol hit",
        searchVolume: 90_000,
        totalScore: 200,
        naturalPositionSeq: [{ date: "2026-01-01", page: 1, allPageRank: 12 }],
      }),
      ...Array.from({ length: 5 }, (_, i) =>
        kwRow({
          keyword: `filler hit ${i}`,
          searchVolume: 1000 + i,
          totalScore: 10,
          naturalPositionSeq: [{ date: "2026-01-01", page: 1, allPageRank: 5 }],
        })
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        kwRow({
          keyword: `filler miss ${i}`,
          searchVolume: 500 + i,
          totalScore: 10,
          naturalPositionSeq: [{ date: "2026-01-01", page: 2, allPageRank: 55 }],
        })
      ),
    ]

    const pc = computeTrafficPrecompute(list, [])
    expect(pc.top10Page1Hits).toBe(6)
    expect(pc.homepageHitTier.score).toBe(3)
    expect(pc.homepageHitTier.max).toBe(5)
  })

  it("computes weighted natural pct from score sums", () => {
    const list = [
      kwRow({ keyword: "a", totalScore: 100, naturalScore: 80, adScore: 20 }),
      kwRow({ keyword: "b", totalScore: 100, naturalScore: 40, adScore: 60 }),
    ]
    const pc = computeTrafficPrecompute(list, [])
    expect(pc.weightedNaturalPct).toBeCloseTo(60, 1)
    expect(pc.structure?.adDependencyPct).toBeCloseTo(40, 1)
  })

  it("excludes high adRatio keywords from opportunity list", () => {
    const list = [
      kwRow({
        keyword: "ad heavy",
        searchVolume: 5000,
        totalScore: 100,
        naturalScore: 20,
        adScore: 80,
        naturalPositionSeq: [{ date: "2026-01-01", page: 3, allPageRank: 120 }],
      }),
      kwRow({
        keyword: "opp",
        searchVolume: 5000,
        totalScore: 100,
        naturalScore: 90,
        adScore: 10,
        conversionShared: 3.5,
        naturalPositionSeq: [{ date: "2026-01-01", page: 3, allPageRank: 120 }],
      }),
    ]
    const pc = computeTrafficPrecompute(list, [])
    expect(pc.opportunityCount).toBe(1)
    expect(pc.opportunityList?.[0]?.kw).toBe("opp")
  })

  it("禁词不进评分原料：促销词/竞品品牌词（无兼容前缀）剔除，兼容前缀词保留", () => {
    const list = [
      kwRow({
        keyword: "free shipping case",
        searchVolume: 50_000,
        totalScore: 100,
        naturalPositionSeq: [{ date: "2026-01-01", page: 2, allPageRank: 55 }],
      }),
      kwRow({
        keyword: "samsung galaxy cover",
        searchVolume: 40_000,
        totalScore: 100,
        naturalPositionSeq: [{ date: "2026-01-01", page: 2, allPageRank: 60 }],
      }),
      kwRow({
        keyword: "case for samsung galaxy",
        searchVolume: 5_000,
        totalScore: 100,
        naturalScore: 90,
        adScore: 10,
        conversionShared: 3.5,
        naturalPositionSeq: [{ date: "2026-01-01", page: 3, allPageRank: 120 }],
      }),
      kwRow({
        keyword: "opp",
        searchVolume: 5_000,
        totalScore: 100,
        naturalScore: 90,
        adScore: 10,
        conversionShared: 3.5,
        naturalPositionSeq: [{ date: "2026-01-01", page: 3, allPageRank: 130 }],
      }),
    ]
    const pc = computeTrafficPrecompute(list, [])
    expect(pc.opportunityList?.some(r => r.kw === "free shipping case")).toBe(false)
    expect(pc.opportunityList?.some(r => r.kw === "samsung galaxy cover")).toBe(false)
    expect(pc.positionAllocation?.some(r => r.kw === "samsung galaxy cover")).toBe(false)
    expect(pc.opportunityList?.some(r => r.kw === "case for samsung galaxy")).toBe(true)
    expect(pc.summaryLines.some(l => l.includes("已剔除确定性禁词"))).toBe(true)
  })
})

/** 构造 n 天日级 BSR 序列（从 2026-08-01 起） */
function trendOf(values: Array<number | null>): SifAsinOpTrafficTrendData {
  return {
    dates: values.map((_, i) => {
      const d = new Date(Date.UTC(2026, 7, 1 + i))
      return d.toISOString().slice(0, 10)
    }),
    bsr: values,
  }
}

describe("computeBsrTrendPrecompute（I3 · BSR 口径）", () => {
  it("14 天序列：前 7 天 vs 后 7 天均值保持率，declinedDays 统计尾部连续劣于基线", () => {
    const trend = trendOf([
      ...Array.from({ length: 7 }, () => 100), // 前 7 天基线 100
      90,
      100,
      120,
      150,
      200,
      250,
      300, // 后 7 天均值 1210/7 ≈ 172.86
    ])
    const bt = computeBsrTrendPrecompute(trend)
    expect(bt.available).toBe(true)
    expect(bt.validDays).toBe(14)
    expect(bt.prev7AvgBsr).toBe(100)
    expect(bt.last7AvgBsr).toBeCloseTo(172.86, 1)
    expect(bt.retainedPct).toBeCloseTo(57.9, 0)
    expect(bt.tier.score).toBeCloseTo(4.63, 1)
    expect(bt.tier.max).toBe(8)
    expect(bt.declinedDays).toBe(5) // 300/250/200/150/120 连续 >100，遇 100 停
    expect(bt.series).toHaveLength(14)
    // 近 7 天视图序列 = 14 天窗口尾部 7 天（即「后 7 天」窗口），供前端 7 天 tab 直接渲染
    expect(bt.series7?.map(p => p.bsr)).toEqual([90, 100, 120, 150, 200, 250, 300])
    expect(bt.series7?.[0]?.date).toBe("2026-08-08")
  })

  it("改善封顶：后 7 天均值更优（更小）→ 保持率 100%、不加分也不扣分", () => {
    const trend = trendOf([
      ...Array.from({ length: 7 }, () => 100),
      ...Array.from({ length: 7 }, () => 50),
    ])
    const bt = computeBsrTrendPrecompute(trend)
    expect(bt.available).toBe(true)
    expect(bt.retainedPct).toBe(100)
    expect(bt.tier.score).toBe(8)
    expect(bt.declinedDays).toBe(0)
  })

  it("只取尾部 14 天：更早的数据不参与计算", () => {
    const trend = trendOf([
      ...Array.from({ length: 16 }, () => 99999), // 16 天旧数据
      ...Array.from({ length: 7 }, () => 100),
      ...Array.from({ length: 7 }, () => 50),
    ])
    const bt = computeBsrTrendPrecompute(trend)
    expect(bt.available).toBe(true)
    expect(bt.prev7AvgBsr).toBe(100)
    expect(bt.retainedPct).toBe(100)
    expect(bt.series7?.map(p => p.bsr)).toEqual(Array.from({ length: 7 }, () => 50)) // 只取裁剪后窗口的尾部
  })

  it("序列不足：有效天数 <10 或任一窗口 <4 天 → 待核并说明缺口", () => {
    const sparse = trendOf(Array.from({ length: 14 }, (_, i) => (i % 4 === 0 ? 100 : null))) // 4 个有效点
    const r1 = computeBsrTrendPrecompute(sparse)
    expect(r1.available).toBe(false)
    expect(r1.reason).toMatch(/不足/)

    const halfEmpty = trendOf([
      ...Array.from({ length: 7 }, () => null), // 前 7 天全缺
      ...Array.from({ length: 7 }, () => 100),
    ])
    const r2 = computeBsrTrendPrecompute(halfEmpty)
    expect(r2.available).toBe(false)
    expect(r2.reason).toMatch(/前 7 天 0 天/)
    // 数据不足仍下发逐日序列（含 series7），前端有多少渲染多少
    expect(r1.series).toHaveLength(14)
    expect(r1.series7).toHaveLength(7)
    expect(r1.series7?.filter(p => p.bsr != null)).toHaveLength(2)
  })

  it("无数据：dates/bsr 缺失或全空 → 待核", () => {
    const none = computeBsrTrendPrecompute(undefined)
    expect(none.available).toBe(false)
    expect(none.series).toBeUndefined()
    expect(none.series7).toBeUndefined()
    expect(computeBsrTrendPrecompute({}).available).toBe(false)
    expect(computeBsrTrendPrecompute({ dates: [], bsr: [] }).available).toBe(false)
  })
})
