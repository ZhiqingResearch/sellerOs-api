import { calculateAdvice, calculateStatistics } from "./category-analysis.statistics"
import type { CategoryEvidence } from "./category-analysis.types"
import {
  focusEvidence,
  keywordConsistency,
  parseHeadTrend,
  parseSalesHistory,
} from "./category-enrichment"
import { parseSifSample } from "./category-evidence.provider"
const category = { nodeId: "123", nodeIdPath: "123", name: "Storage", path: "收纳" }
const rowsOf = (count = 100) =>
  parseSifSample(
    Array.from({ length: count }, (_, i) => ({
      asin: `B${String(i).padStart(9, "0")}`,
      title: i < 40 ? "spice rack" : "storage bin",
      brand: `brand${i}`,
      price: 20,
      score: 4.5,
      firstAvailableDay: "2026-08-01",
      boughtInPastMonth: 100,
      bsrList: [{ rank: 1 }],
    }))
  )
const evidenceOf = (): CategoryEvidence => ({
  source: "sif",
  categoryId: "123",
  rows: rowsOf(),
  months: [],
  keepa: [],
  keywords: [],
  notices: [],
  newReleaseMerged: 30,
})
it("月销只保留完整月正销量，增长口径近3比前3，历史不复制卖家", () => {
  const rows = rowsOf(30)
  const sales = Object.fromEntries(
    rows.map(row => [
      row.asin,
      {
        "2026-01": 10,
        "2026-02": 10,
        "2026-03": 10,
        "2026-04": 20,
        "2026-05": 20,
        "2026-06": 20,
        "2026-07": 0,
        "2026-09": 30,
      },
    ])
  )
  rows[0].seller = "Store"
  const months = parseSalesHistory(sales, rows, new Date("2026-09-18"))
  expect(months.map(month => month.month)).toEqual([
    "2026-01",
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
  ])
  expect(months[0].rows[0].seller).toBeNull()
  expect(rows[0].growth).toBe(100)
  const report = calculateStatistics(category, "US", { ...evidenceOf(), rows, months })
  expect(report.head.rows[0].growth).toBe(1)
})
it("交集同步过滤月历史、趋势和卖家样本；不足30回落并返回真实条数", () => {
  const evidence = evidenceOf()
  evidence.months = [{ month: "2026-01", rows: evidence.rows }]
  const focused = focusEvidence(evidence, ["spice rack"])
  expect(focused.count).toBe(40)
  expect(focused.evidence.months[0].rows).toHaveLength(40)
  expect(focusEvidence(evidence, ["spice new rack"]).count).toBe(40)
  evidence.rows = evidence.rows.slice(0, 20)
  expect(focusEvidence(evidence, ["spice rack"])).toMatchObject({ isFallback: true, count: 20 })
})
it("一致性支持父子类目的20%ASIN重合，不只比较ID", () => {
  const evidence = evidenceOf()
  const result = keywordConsistency(evidence, {
    candidates: [
      { categoryId: "999", categoryName: "Other", kws: ["rack"], hits: 1, best: 0, sales: 10 },
    ],
    topAsins: [evidence.rows[0].asin, "X1", "X2", "X3", "X4"],
    notices: [],
  })
  expect(result).toEqual({ consistent: true, overlap: 0.2 })
})
it("卖家不足6条全部缺失，头部Amazon超过50%不触发整类目硬性问题", () => {
  const evidence = evidenceOf()
  for (const row of evidence.rows.slice(0, 5)) {
    row.seller = "Amazon"
    row.sellerId = "ATVPDKIKX0DER"
    row.sellerCountry = "US"
  }
  let report = calculateStatistics(category, "US", evidence)
  expect(report.competition.amazon_share).toBeNull()
  expect(report.competition.cn_share).toBeNull()
  evidence.rows[5].seller = "Amazon"
  evidence.rows[5].sellerCountry = "US"
  report = calculateStatistics(category, "US", evidence)
  expect(report.sample.seller_scope).toBe("head")
  expect(report.competition.amazon_share).toBe(1)
  expect(report.competition.seller_monopoly).toBeNull()
  expect(report.competition.head_buybox_conc?.scope).toBe(6)
  expect(calculateAdvice(report, null, null).veto).toBeNull()
})
it("卖家覆盖80%后才计算垄断度；新品补样足够后可计算新品成功率和周期", () => {
  const evidence = evidenceOf()
  evidence.rows.forEach((row, i) => {
    if (i < 80) row.seller = `Store${i}`
    row.isNewRelease = i < 30
  })
  const report = calculateStatistics(category, "US", evidence)
  expect(report.sample.seller_scope).toBe("all")
  expect(report.competition.seller_monopoly).not.toBeNull()
  expect(report.entry.nesr).not.toBeNull()
  expect(report.entry.bs_share_head).toBe(1)
  expect(report.entry.recent_winners).toHaveLength(8)
})
it("日趋势按实际时间计算评论月新增，不足10天不外推，BSR取中位数", () => {
  const trend = parseHeadTrend("B000000001", {
    dates: ["2026-08-01", "2026-08-16", "2026-08-31"],
    review: [10, 30, 40],
    bsr: [100, 200, 9999],
    seller: [-1, 2, 4],
    buyboxPrice: [10, 20, 30],
    nfScoreRatios: [0.3, 0.4, 0.5],
  })!
  expect(trend.reviewsNew).toBe(30)
  expect(trend.bsrAvg90).toBe(200)
  expect(trend.sellerCount).toBe(4)
  expect(trend.naturalShare).toBe(0.5)
  expect(
    parseHeadTrend("A", { dates: ["2026-08-01", "2026-08-02"], review: [10, 30] })?.reviewsNew
  ).toBeNull()
})
