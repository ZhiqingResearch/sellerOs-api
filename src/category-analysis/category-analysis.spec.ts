import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import {
  calculateYoy,
  classifyKeyword,
  deduplicateParents,
  weightedShare,
} from "./category-analysis.math"
import { validateReportMarkdown } from "./category-analysis.service"
import { buildReads, calculateAdvice, calculateStatistics } from "./category-analysis.statistics"
import type { CategoryEvidence, CategoryKeyword, SampleRow } from "./category-analysis.types"
import {
  parseKeepaProducts,
  parseKeywords,
  parseSifSample,
  selectCategory,
} from "./category-evidence.provider"
import { parseCubicFeet, parseExportNumber, parseSampleTable } from "./category-sample.parser"
import { CreateCategoryAnalysisDto } from "./dto/create-category-analysis.dto"

const category = {
  nodeId: "123",
  nodeIdPath: "1:123",
  name: "Kitchen Storage",
  path: "家居厨房 > 厨房收纳",
}
function sample(index: number, overrides: Partial<SampleRow> = {}): SampleRow {
  return {
    asin: `B${String(index).padStart(9, "0")}`,
    parent: null,
    brand: `brand${index}`,
    price: 20,
    sales: 100,
    revenue: 2000,
    growth: null,
    rating: 4.5,
    reviews: 20,
    reviewsNew: null,
    seller: null,
    sellerCountry: null,
    sellerCount: null,
    launchDays: 100,
    weightLb: null,
    sizeTier: null,
    lqs: null,
    aplus: null,
    bs: null,
    ac: null,
    ...overrides,
  }
}
function evidence(overrides: Partial<CategoryEvidence> = {}): CategoryEvidence {
  return {
    source: "sif_sample",
    rows: Array.from({ length: 30 }, (_, index) => sample(index)),
    months: [],
    keywords: [],
    keepa: [],
    notices: [],
    ...overrides,
  }
}
const keyword: CategoryKeyword = {
  keyword: "storage",
  search_volume: 1000,
  aba_rank: null,
  competitors: 250,
  supply_demand: 4,
  yoy_pct: 0,
  top3_concentration: 45,
  natural_share: null,
  ppc: null,
  cvr: null,
  acos: 0.6,
  history: [],
  verdict: "",
  reason: "",
}

describe("类目分析统计与真实性", () => {
  it("同父 ASIN 共享销量不重复相加", () => {
    const rows = deduplicateParents([
      sample(1, { parent: "P1", sales: 200 }),
      sample(2, { parent: "P1", sales: 200 }),
      sample(3, { sales: 100 }),
    ])
    expect(rows).toHaveLength(2)
    expect(rows.reduce((total, row) => total + row.sales!, 0)).toBe(300)
  })
  it("销量加权的分母只包含已知值，未知不是零", () => {
    const rows = [
      sample(1, { sellerCount: null, sales: 900 }),
      sample(2, { sellerCount: 1, sales: 50 }),
      sample(3, { sellerCount: 2, sales: 50 }),
    ]
    expect(
      weightedShare(rows, row => (row.sellerCount === null ? null : row.sellerCount > 1))
    ).toBe(0.5)
    expect(weightedShare([sample(1)], row => (row.sellerCount === null ? null : false))).toBeNull()
  })
  it("SIF 样本不产生新品指标、卖家占比或假月度数据", () => {
    const input = calculateStatistics(category, "US", evidence())
    expect(input.entry.nesr).toBeNull()
    expect(input.entry.new_product_cycle).toBeNull()
    expect(input.entry.recent_winners.length).toBeLessThanOrEqual(8)
    expect(input.competition.seller_monopoly).toBeNull()
    expect(input.capacity.monthly_sales).toEqual([])
    expect(buildReads(input).find(read => read.key === "annual_revenue")?.tone).toBe("neutral")
    expect(
      input.gate
        .filter(gate => gate.label === "专利风险" || gate.label === "供应链成熟度")
        .every(gate => gate.status === "warn" && gate.text.includes("需人工确认"))
    ).toBe(true)
  })
  it("新品不足 15 个置空，15 个时按全样本前 20% 门槛计算", () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      sample(index, { sales: 100 - index, launchDays: index < 14 ? 100 : 500 })
    )
    expect(
      calculateStatistics(category, "US", evidence({ source: "sellersprite", rows })).entry.nesr
    ).toBeNull()
    rows[14].launchDays = 100
    expect(
      calculateStatistics(category, "US", evidence({ source: "sellersprite", rows })).entry.nesr
    ).toBe(1)
  })
  it("同比仅取最后 24 个月；13 个月时按前段均值而非总和比较", () => {
    const points = Array.from({ length: 73 }, (_, index) => ({
      month: `${2020 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`,
      value: index >= 61 ? 120 : index >= 49 ? 100 : 1,
    }))
    expect(calculateYoy(points)).toBeCloseTo(20)
    expect(calculateYoy(points.slice(-13))).toBeCloseTo(20)
    expect(calculateYoy(points.slice(-12))).toBeNull()
  })
  it("月度 Top10 换血率按文档的 months[len−7] 与最新月表比较", () => {
    const rows = Array.from({ length: 30 }, (_, index) => sample(index, { sales: 100 - index }))
    const months = [
      { month: "2026-01", rows },
      { month: "2026-08", rows },
    ]
    expect(
      calculateStatistics(category, "US", evidence({ source: "sellersprite", rows, months }))
        .competition.top10_churn
    ).toBeNull()
    months.splice(
      1,
      0,
      ...["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].map(month => ({ month, rows }))
    )
    expect(
      calculateStatistics(category, "US", evidence({ source: "sellersprite", rows, months }))
        .competition.top10_churn
    ).toBe(0)
  })
  it("所有硬性问题按文档先后顺序，严格大于而不是大于等于", () => {
    const input = calculateStatistics(category, "US", evidence())
    input.competition.product_monopoly = 0.8
    input.competition.brand_monopoly = 0.85
    input.competition.amazon_share = 0.5
    input.competition.acos = 1
    input.capacity.generic_search_share = 0.3
    expect(calculateAdvice(input, null, null).veto).toBeNull()
    input.competition.product_monopoly = 0.8001
    input.competition.brand_monopoly = 0.9
    expect(calculateAdvice(input, null, null).veto).toBe("商品垄断度超过 80%")
  })
  it("缺少广告与趋势不产生虚构的利好，缺失项不进机会或风险", () => {
    const reads = buildReads(calculateStatistics(category, "US", evidence()))
    for (const key of ["acos", "sales_growth_pct", "demand_yoy_pct", "nesr", "top10_churn"]) {
      expect(reads.find(read => read.key === key)?.tone).toBe("missing")
    }
  })
  it("价格第十三档从 P98 开始，硬性问题内部分封顶 45", () => {
    const input = calculateStatistics(category, "US", evidence())
    expect(input.entry.pivots.price).toHaveLength(13)
    expect(input.entry.pivots.price[11].upper).toBe(20)
    expect(input.entry.pivots.price[12].label).toBe("> $20.00")
    input.competition.brand_monopoly = 0.86
    input.entry.nesr = 0.9
    const advice = calculateAdvice(input, 100, 4)
    expect(advice.advice).toBe("建议暂缓")
    expect(advice.score).toBeLessThanOrEqual(45)
  })
  it("品牌词判定使用原型的销量头部30品牌，新品明细保留评分和标签", () => {
    const rows = Array.from({ length: 31 }, (_, index) =>
      sample(index, {
        brand: `Brand ${String(index).padStart(2, "0")}`,
        sales: 100 - index,
        reviewsNew: 5,
        aplus: true,
      })
    )
    const input = calculateStatistics(
      category,
      "US",
      evidence({
        source: "sellersprite",
        rows,
        keywords: [{ ...keyword, keyword: "brand 30 storage" }],
      })
    )
    expect(input.capacity.generic_search_share).toBe(1)
    expect(input.entry.recent_winners[0]).toMatchObject({
      rating: 4.5,
      reviews: 20,
      reviews_new: 5,
      tags: ["A+"],
    })
  })
})
describe("关键词阈值", () => {
  it.each([
    [{ search_volume: 999 }, "暂不建议"],
    [{ supply_demand: 0.99 }, "暂不建议"],
    [{ yoy_pct: -15 }, "暂不建议"],
    [{ acos: 1.001 }, "暂不建议"],
    [{}, "建议主攻"],
    [{ top3_concentration: 45.01 }, "可做长尾"],
    [{ acos: null }, "建议主攻"],
    [{ search_volume: null }, "需补充"],
  ])("边界 %j → %s", (values, expected) =>
    expect(classifyKeyword({ ...keyword, ...values }).verdict).toBe(expected)
  )
  it("缺失 ACOS 明确注明未纳入", () =>
    expect(classifyKeyword({ ...keyword, acos: null }).reason).toContain("ACOS 未纳入"))
  it("供需比使用 totalAsinNum，不使用 saleNum；自然流量的真实 0 保留", () => {
    const result = parseKeywords(
      ["storage"],
      [
        [{ keyword: "storage", estSearchesNum: 1000, saleNum: 100000 }],
        null,
        { list: [{ keyword: "storage", totalAsinNum: 250, startDate: "2026-08" }] },
        null,
        {
          list: [
            {
              keyword: "storage",
              totalScoreRatio: 0.3,
              keywordAllNaturalScore: 0,
              keywordNaturalScore: 99,
              keywordTotalScore: 100,
            },
          ],
        },
      ]
    )[0]
    expect(result.supply_demand).toBe(4)
    expect(result.natural_share).toBe(0)
    expect(result.yoy_pct).toBeNull()
  })
})
describe("源数据解析", () => {
  it.each([
    ["200+", 200],
    ["$90K+", 90000],
    ["1.2万", 12000],
    ["↑17.60%", 17.6],
    ["↓-18%", -18],
  ])("解析 %s", (raw, expected) => expect(parseExportNumber(raw)).toBe(expected))
  it("识别前 15 行表头、卖家数、父体重复、重量、日期", () => {
    const result = parseSampleTable(
      [
        ["报表"],
        [
          "ASIN",
          "父ASIN",
          "品牌",
          "价格",
          "销量(父)",
          "卖家",
          "BuyBox卖家",
          "包装重量",
          "上架时间",
          "增长率",
        ],
        [
          "B000000001",
          "B000000099",
          "X",
          "$20",
          100,
          "2",
          "Amazon ( AMZ)",
          "12 ounces",
          "3年 2个月",
          "↓-18%",
        ],
        [
          "B000000002",
          "B000000099",
          "X",
          "$20",
          100,
          "2",
          "Amazon",
          "54.56 pounds",
          100,
          "↑17.60%",
        ],
      ],
      "选品202608.csv"
    )
    expect(result.month).toBe("2026-08")
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      sellerCount: 2,
      seller: "Amazon ( AMZ)",
      weightLb: 0.75,
      launchDays: 1155,
      growth: -0.18,
    })
  })
  it("空父体占位符不会合并不同商品，未知标签不会当作真实否值", () => {
    const result = parseSampleTable(
      [
        ["ASIN", "父ASIN", "价格", "A+"],
        ["B000000001", "--", 20, "N/A"],
        ["B000000002", "--", 30, "否"],
      ],
      "sample202608.csv"
    )
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({ parent: null, aplus: null })
    expect(result.rows[1].aplus).toBe(false)
  })
  it("保留 FBA 费用并将包装尺寸换算为立方英尺，未知单位不猜测", () => {
    const result = parseSampleTable(
      [
        ["ASIN", "价格", "销量", "FBA", "包装尺寸"],
        ["B000000001", 20, 100, "$5.25", "35 x 26.5 x 20 inches"],
      ],
      "sample202608.csv"
    )
    expect(result.rows[0].fbaFee).toBe(5.25)
    expect(result.rows[0].cuft).toBeCloseTo((35 * 26.5 * 20) / 1728)
    expect(parseCubicFeet("30.48 x 30.48 x 30.48 cm")).toBeCloseTo(1)
    expect(parseCubicFeet("12 x 12 x 12")).toBeNull()
  })
  it("无价格 ASIN 不入样本，未提供的销量/评分/上架日期不补零", () => {
    const rows = parseSifSample({
      list: [
        { asin: "B000000001", price: 20 },
        { asin: "B000000002", price: 0 },
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sales: null, rating: null, launchDays: null, revenue: null })
  })
  it("类目检索避免误选儿童和配件，无重合不匹配", () => {
    expect(
      selectCategory(
        [
          { categoryName: "Kids Storage", categoryId: 1 },
          { categoryName: "Kitchen Storage", categoryId: 2 },
        ],
        "kitchen storage",
        "kitchen storage"
      )?.categoryId
    ).toBe(2)
    expect(
      selectCategory([{ categoryName: "Dog Toys", categoryId: 1 }], "kitchen", "kitchen")
    ).toBeNull()
  })
  it("Keepa 保留窗口前价格基线、负占位符为空、评论差值除3", () => {
    const now = Date.UTC(2026, 8, 16),
      minute = (date: number) => date / 60000 - 21564000
    const csv: unknown[] = []
    csv[1] = [minute(now - 100 * 86400000), 1999]
    csv[17] = [minute(now - 100 * 86400000), 100, minute(now), 160]
    const current: number[] = []
    current[3] = 12
    current[11] = -1
    const rows = parseKeepaProducts(
      { products: [{ asin: "B000000001", stats: { current, buyBoxSellerId: "-1" }, csv }] },
      now
    )
    expect(rows[0]).toMatchObject({
      priceMin90: 19.99,
      priceMax90: 19.99,
      reviewVelocity: 20,
      buybox: null,
      offers: null,
    })
  })
})
describe("请求与报告约束", () => {
  it("拒绝超过5类目、重复节点和非法站点", async () => {
    const dto = plainToInstance(CreateCategoryAnalysisDto, {
      requestId: "c2c9fd25-f647-4bcb-86e1-1f5a6a35fd1a",
      marketplace: "CN",
      categories: Array.from({ length: 6 }, () => category),
    })
    const errors = await validate(dto)
    expect(errors.map(error => error.property)).toEqual(
      expect.arrayContaining(["marketplace", "categories"])
    )
  })
  it("强制六节顺序并拦截供应商名与旧版结论", () => {
    const report = `# 类目 【建议谨慎评估】\n${["核心结论", "准入风险", "市场容量", "竞争格局", "头部动态", "切入机会"].map(title => `## ${title}\n需补充相关指标后再评估。`).join("\n")}\n### 数据核对\n需补充。`
    expect(validateReportMarkdown(report, "建议谨慎评估")).toBe(true)
    expect(validateReportMarkdown(report + "\nSIF", "建议谨慎评估")).toBe(false)
    expect(validateReportMarkdown(report + "\nABA 接口", "建议谨慎评估")).toBe(false)
    expect(validateReportMarkdown(report + "\n红线", "建议谨慎评估")).toBe(false)
  })
})
