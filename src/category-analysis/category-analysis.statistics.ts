import {
  buildGates,
  buildPivots,
  calculateSeason,
  calculateYoy,
  deduplicateParents,
  divide,
  groupedShare,
  median,
  salesGrowth,
  sum,
  summarizeKeepa,
  topShare,
  weightedShare,
} from "./category-analysis.math"
import type {
  CategoryAnalysisInput,
  CategoryEvidence,
  CategorySelection,
  MetricRead,
  MetricTone,
  NullableNumber,
  Rule,
  SampleRow,
} from "./category-analysis.types"

const clamp = (value: number, minimum = 0, maximum = 100) =>
  Math.max(minimum, Math.min(maximum, value))
const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length
const isAmazon = (seller: string | null) =>
  seller === null ? null : /amazon|\bAMZ\b|ATVPDKIKX0DER/i.test(seller)

export function calculateStatistics(
  category: CategorySelection,
  site: string,
  evidence: CategoryEvidence
): CategoryAnalysisInput {
  const rows = deduplicateParents(evidence.rows)
  const months = evidence.months
    .map(month => ({ ...month, rows: deduplicateParents(month.rows) }))
    .sort((a, b) => a.month.localeCompare(b.month))
  const isSample = evidence.source !== "sellersprite"
  const heads = [...rows].sort((a, b) => (b.sales ?? -1) - (a.sales ?? -1)).slice(0, 20)
  const prices = rows
    .map(row => row.price)
    .filter((price): price is number => price !== null && price > 0)
    .sort((a, b) => a - b)
  const priceCeiling = prices[Math.min(prices.length - 1, Math.floor(prices.length * 0.98))]
  const priceEdges = priceCeiling
    ? Array.from({ length: 12 }, (_, index) =>
        Number(((priceCeiling * (index + 1)) / 12).toFixed(2))
      )
    : []
  const currency = ({ US: "$", UK: "£", DE: "€", JP: "¥" } as Record<string, string>)[site] ?? "$"
  const priceLabels = Array.from({ length: 13 }, (_, index) =>
    index === 0
      ? `< ${currency}${priceEdges[0]?.toFixed(2)}`
      : index === 12
        ? `> ${currency}${priceEdges[11]?.toFixed(2)}`
        : `${currency}${priceEdges[index - 1]?.toFixed(2)} – ${currency}${priceEdges[index]?.toFixed(2)}`
  )
  const pivots = {
    price: prices.length ? buildPivots(rows, "price", priceEdges, priceLabels) : [],
    rating: buildPivots(
      rows,
      "rating",
      [4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8],
      [
        "<4.0",
        "4.0–4.1",
        "4.1–4.2",
        "4.2–4.3",
        "4.3–4.4",
        "4.4–4.5",
        "4.5–4.6",
        "4.6–4.7",
        "4.7–4.8",
        "≥4.8",
      ]
    ),
    reviews: buildPivots(rows, "reviews", [10, 50, 100, 200, 400, 800, 1500, 3000, 6000]),
    launch_days: buildPivots(rows, "launchDays", [90, 120, 150, 180, 210, 240, 300, 360, 540, 720]),
  }
  const priceBands = pivots.price
    .filter(pivot => (pivot.mult ?? 0) > 1)
    .sort((a, b) => b.mult! - a.mult!)
    .slice(0, 2)
  const ratingBand = pivots.rating.find(pivot => (pivot.mult ?? 0) > 1)
  const cycleBand = pivots.launch_days.find(pivot => (pivot.mult ?? 0) > 1)
  const newRows = rows.filter(
    row => row.launchDays !== null && row.launchDays <= 360 && row.sales !== null
  )
  const sales = rows
    .map(row => row.sales)
    .filter((value): value is number => value !== null)
    .sort((a, b) => b - a)
  const successThreshold = sales[Math.max(0, Math.round(sales.length * 0.2) - 1)]
  const nesr =
    (isSample && !evidence.newReleaseMerged) || newRows.length < 15
      ? null
      : newRows.filter(row => row.sales! >= successThreshold).length / newRows.length
  const monthlySales = months.map(month => ({
    month: month.month,
    sales: sum(month.rows.map(row => row.sales)),
  }))
  const revenues = months
    .map(month => sum(month.rows.map(row => row.revenue)))
    .filter((value): value is number => value !== null)
  const annualRevenue = revenues.length
    ? mean(revenues) * 12
    : sum(rows.map(row => row.revenue)) === null
      ? null
      : sum(rows.map(row => row.revenue))! * 12
  let growth = isSample ? null : salesGrowth(rows)
  if (monthlySales.length >= 6 && monthlySales.slice(-6).every(month => month.sales !== null)) {
    const ratio = divide(
      mean(monthlySales.slice(-3).map(month => month.sales!)),
      mean(monthlySales.slice(-6, -3).map(month => month.sales!))
    )
    growth = ratio === null ? null : (ratio - 1) * 100
  }
  const topKeywords = [...evidence.keywords]
    .filter(keyword => keyword.search_volume !== null)
    .sort((a, b) => b.search_volume! - a.search_volume!)
    .slice(0, 5)
  // 只有所有入选头部词均有该月数据才计入合计，不能把缺词月份当成需求下降。
  const demandMonths =
    topKeywords[0]?.history
      .map(point => point.month)
      .filter(month =>
        topKeywords.every(keyword => keyword.history.some(point => point.month === month))
      ) ?? []
  const demand = demandMonths.sort().map(month => ({
    month,
    value: topKeywords.reduce(
      (total, keyword) => total + keyword.history.find(point => point.month === month)!.value,
      0
    ),
  }))
  // 与原型一致，以按销量排序的头部 30 品牌判定品牌词；不能把任意尾部品牌当成主导品牌。
  const brandSales = new Map<string, number>()
  for (const row of rows) {
    const brand = row.brand?.toLowerCase()
    if (brand && brand.length >= 3 && brand !== "（无品牌）" && row.sales !== null)
      brandSales.set(brand, (brandSales.get(brand) ?? 0) + row.sales)
  }
  const brands = [...brandSales]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([brand]) => brand)
  const knownKeywords = evidence.keywords.filter(keyword => keyword.search_volume !== null)
  const genericShare = brands.length
    ? divide(
        sum(
          knownKeywords
            .filter(keyword => !brands.some(brand => keyword.keyword.toLowerCase().includes(brand)))
            .map(keyword => keyword.search_volume)
        ) ?? 0,
        sum(knownKeywords.map(keyword => keyword.search_volume))
      )
    : null
  const averagePrice = prices.length ? mean(prices) : null
  const ppc = median(evidence.keywords.map(keyword => keyword.ppc))
  const cvr = median(
    evidence.keywords.map(keyword => keyword.cvr).filter(value => value !== null && value > 0)
  )
  const acos = divide(ppc, cvr !== null && averagePrice !== null ? cvr * averagePrice : null)
  const keepa = summarizeKeepa(evidence.keepa)
  const concentration = months.map(month => ({
    month: month.month,
    link: topShare(month.rows, row => row.sales),
    brand: groupedShare(month.rows, "brand"),
    seller: isSample ? null : groupedShare(month.rows, "seller"),
  }))
  const trend = (key: "link" | "brand" | "seller") => {
    if (concentration.length < 2) return null
    const first = concentration[0][key],
      last = concentration.at(-1)![key]
    return first === null || last === null
      ? null
      : Math.abs(last - first) < 0.01
        ? "稳定"
        : last > first
          ? "升高"
          : "降低"
  }
  // 开发文档 §4.4 指定比较 months[len−7] 与最新月表。
  const priorMonth = months.length >= 7 ? months[months.length - 7] : undefined
  const topTen = (items: SampleRow[]) =>
    [...items]
      .filter(row => row.sales !== null)
      .sort((a, b) => b.sales! - a.sales!)
      .slice(0, 10)
      .map(row => row.parent || row.asin)
  const currentTen = topTen(months.at(-1)?.rows ?? rows),
    previousTen = priorMonth ? topTen(priorMonth.rows) : []
  const brandGroups = new Map<string, SampleRow[]>()
  for (const row of rows)
    if (row.brand) brandGroups.set(row.brand, [...(brandGroups.get(row.brand) ?? []), row])
  const totalSales = sum(rows.map(row => row.sales))
  const brandRows = [...brandGroups.entries()]
    .sort(
      (a, b) => (sum(b[1].map(row => row.sales)) ?? -1) - (sum(a[1].map(row => row.sales)) ?? -1)
    )
    .slice(0, 10)
    .map(([brand, items]) => {
      const previous =
        months.length > 1
          ? sum(months[0].rows.filter(row => row.brand === brand).map(row => row.sales))
          : null
      const brandGrowth =
        previous !== null
          ? divide(
              sum(
                (months.at(-1)?.rows ?? items)
                  .filter(row => row.brand === brand)
                  .map(row => row.sales)
              ),
              previous
            )
          : null
      const fallbackGrowth = salesGrowth(items)
      const validPrices = items
        .map(row => row.price)
        .filter((value): value is number => value !== null)
      return {
        brand,
        sales_share: divide(sum(items.map(row => row.sales)), totalSales),
        links: items.length,
        avg_price: validPrices.length ? mean(validPrices) : null,
        growth:
          brandGrowth !== null
            ? brandGrowth - 1
            : fallbackGrowth !== null
              ? fallbackGrowth / 100
              : null,
        amazon: items.some(row => isAmazon(row.sellerId ?? row.seller) === true),
      }
    })
  const sellerRows = rows.filter(row => row.seller !== null)
  const hasSellers = sellerRows.length >= 6
  const sellerScope = sellerRows.length / Math.max(1, rows.length) >= 0.8 ? "all" : "head"
  const sellerGroups = new Map<string, { name: string; sales: number; count: number }>()
  for (const row of sellerRows) {
    const id = row.sellerId ?? row.seller!
    const item = sellerGroups.get(id) ?? { name: row.seller!, sales: 0, count: 0 }
    item.sales += row.sales ?? 0
    item.count += 1
    sellerGroups.set(id, item)
  }
  const topSeller = [...sellerGroups.values()].sort((a, b) => b.sales - a.sales)[0]
  const headShare = topSeller
    ? divide(topSeller.sales, sum(sellerRows.map(row => row.sales)))
    : null
  const trends = evidence.trends ?? []
  const bsrSwing = median(
    trends.map(item =>
      item.bsrNow !== null && item.bsrAvg90 !== null
        ? Math.abs(item.bsrNow - item.bsrAvg90) / Math.max(item.bsrAvg90, 100)
        : null
    )
  )
  const priceSwing = median(
    trends.map(item =>
      item.priceMin90 !== null && item.priceMax90 !== null
        ? divide(item.priceMax90 - item.priceMin90, item.priceAvg90)
        : null
    )
  )
  const bsShare = divide(
    heads.filter(row => row.bs === true).length,
    heads.filter(row => row.bs !== null).length
  )
  const report: CategoryAnalysisInput = {
    category: {
      path: category.path,
      en: category.name,
      site,
      category_id: evidence.categoryId ?? category.nodeId,
      from: category.from ?? "picked",
      resolved_from: category.resolvedFrom ?? [],
    },
    sample: {
      source: evidence.source,
      listing_count: rows.length,
      months: months.map(month => month.month),
      new_count: newRows.length,
      new_release_merged: evidence.newReleaseMerged ?? 0,
      seller_scope: sellerScope,
    },
    diag: {
      advice: "",
      veto: null,
      score: 0,
      cap_score: 0,
      comp_score: 0,
      entry_score: 0,
      reason: "",
      cross_note: null,
    },
    capacity: {
      annual_revenue: annualRevenue,
      sales_growth_pct: growth,
      monthly_sales: monthlySales.length >= 2 ? monthlySales : [],
      demand_yoy_pct: calculateYoy(demand),
      generic_search_share: genericShare,
      season: calculateSeason(demand),
    },
    competition: {
      product_monopoly: topShare(rows, row => row.sales),
      brand_monopoly: groupedShare(rows, "brand"),
      seller_monopoly:
        hasSellers && sellerScope === "all"
          ? groupedShare(
              sellerRows.map(row => ({ ...row, seller: row.sellerId ?? row.seller })),
              "seller"
            )
          : null,
      head_buybox_conc:
        hasSellers && sellerScope === "head" && topSeller && headShare !== null
          ? {
              share: headShare,
              name: topSeller.name,
              count: topSeller.count,
              scope: sellerRows.length,
            }
          : null,
      amazon_share: hasSellers
        ? weightedShare(sellerRows, row => isAmazon(row.sellerId ?? row.seller))
        : null,
      cn_share: hasSellers
        ? weightedShare(sellerRows, row =>
            row.sellerCountry === null ? null : /^(CN|HK|China|中国)$/i.test(row.sellerCountry)
          )
        : null,
      review_dependency: topShare(rows, row => row.reviews),
      acos,
      top10_churn:
        currentTen.length === 10 && previousTen.length === 10
          ? 1 - previousTen.filter(asin => currentTen.includes(asin)).length / 10
          : null,
      conc_trend: { link: trend("link"), brand: trend("brand"), seller: trend("seller") },
      conc_monthly: concentration.length >= 2 ? concentration : [],
      brands_top10: brandRows,
      rules: [],
    },
    head: {
      seller_med: median(heads.map(row => row.sellerCount)),
      bsr_swing_med: bsrSwing,
      price_swing_med: priceSwing,
      natural_share_med: median(trends.map(item => item.naturalShare)),
      drops90_med: keepa.drops90_med,
      multi_seller_share: weightedShare(rows, row =>
        row.sellerCount === null ? null : row.sellerCount >= 2
      ),
      reviews_new_med: median(heads.map(row => row.reviewsNew)),
      keepa,
      rows: [...rows]
        .sort((a, b) => (b.sales ?? -1) - (a.sales ?? -1))
        .slice(0, 50)
        .map(row => {
          const saved = evidence.keepa.find(item => item.asin === row.asin)
          const item = trends.find(item => item.asin === row.asin) ?? saved
          return {
            asin: row.asin,
            bs: row.bs,
            brand: row.brand,
            price: row.price,
            sales: row.sales,
            growth: row.growth === null ? null : row.growth / 100,
            rating: row.rating,
            reviews: row.reviews,
            reviews_new: row.reviewsNew,
            seller_count: row.sellerCount,
            buybox: row.seller ?? item?.buybox ?? null,
            launch_days: row.launchDays,
            tags: [row.aplus ? "A+" : null, row.bs ? "BS" : null, row.ac ? "AC" : null].filter(
              (tag): tag is string => tag !== null
            ),
            bsr_now: item?.bsrNow ?? null,
            bsr_avg90: item?.bsrAvg90 ?? null,
            drops90: saved?.drops90 ?? null,
            price_min90: item?.priceMin90 ?? null,
            price_max90: item?.priceMax90 ?? null,
          }
        }),
    },
    entry: {
      bs_share_head: bsShare,
      nesr,
      new_product_cycle: nesr !== null && cycleBand ? `${cycleBand.label}天` : null,
      rating_requirement: ratingBand?.label ?? null,
      listing_bar: {
        lqs_med: median(heads.map(row => row.lqs)),
        aplus_share: divide(
          heads.filter(row => row.aplus === true).length,
          heads.filter(row => row.aplus !== null).length
        ),
        bs_share: divide(
          heads.filter(row => row.bs === true).length,
          heads.filter(row => row.bs !== null).length
        ),
      },
      oversize_share: weightedShare(rows, row =>
        row.weightLb === null && row.sizeTier === null
          ? null
          : (row.weightLb ?? 0) >= 20 || /大件|超大|oversize/i.test(row.sizeTier ?? "")
      ),
      price_sensitivity: topShare(rows, row => row.price, true),
      main_price_band: priceBands[0]?.label ?? null,
      pivots,
      recent_winners: rows
        .filter(row => row.launchDays !== null && row.launchDays <= 365 && row.sales !== null)
        .sort((a, b) => b.sales! - a.sales!)
        .slice(0, 8)
        .map(row => ({
          asin: row.asin,
          brand: row.brand,
          price: row.price,
          sales: row.sales,
          launch_days: row.launchDays,
          rating: row.rating,
          reviews: row.reviews,
          reviews_new: row.reviewsNew,
          tags: [row.aplus ? "A+" : null, row.bs ? "BS" : null, row.ac ? "AC" : null].filter(
            (tag): tag is string => tag !== null
          ),
        })),
      keywords: evidence.keywords,
    },
    gate: buildGates(`${category.path} ${category.name}`),
  }
  report.competition.rules = buildRules(report)
  report.diag = calculateAdvice(
    report,
    nesr === null ? null : (cycleBand?.upper ?? (cycleBand ? 721 : null)),
    ratingBand?.upper ?? (ratingBand ? 4.8 : null)
  )
  return report
}

export function calculateAdvice(
  input: CategoryAnalysisInput,
  cycle: NullableNumber,
  rating: NullableNumber
): CategoryAnalysisInput["diag"] {
  const { capacity, competition, head, entry } = input
  const growth = capacity.sales_growth_pct ?? capacity.demand_yoy_pct ?? 0
  const size =
    input.sample.source !== "sellersprite" || capacity.annual_revenue === null
      ? 60
      : clamp(Math.round(38 + 16 * Math.log10(capacity.annual_revenue / 1e6 + 1)), 20, 98)
  const capScore = clamp(
    size +
      (growth < 0 ? Math.max(-18, growth * 0.9) : Math.min(8, growth * 0.35)) +
      (capacity.generic_search_share === null || capacity.generic_search_share >= 0.6
        ? 0
        : -Math.round(((0.6 - capacity.generic_search_share) / 0.35) * 12))
  )
  const concentration = competition.product_monopoly
  const base =
    concentration === null
      ? 60
      : concentration <= 0.35
        ? 90
        : concentration <= 0.45
          ? 90 - ((concentration - 0.35) / 0.1) * 12
          : concentration <= 0.6
            ? 78 - ((concentration - 0.45) / 0.15) * 18
            : concentration <= 0.75
              ? 60 - ((concentration - 0.6) / 0.15) * 20
              : Math.max(12, 40 - ((concentration - 0.75) / 0.1) * 28)
  const penalty = (value: NullableNumber, threshold: number, range: number, max: number) =>
    value === null || value <= threshold ? 0 : Math.min(max, ((value - threshold) / range) * max)
  const compScore = clamp(
    base -
      penalty(competition.brand_monopoly, 0.45, 0.45, 10) -
      penalty(competition.review_dependency, 0.25, 0.4, 10) -
      penalty(competition.acos, 0.35, 0.65, 12) -
      penalty(head.multi_seller_share ?? head.keepa.hijack_share, 0.3, 0.5, 10) -
      penalty(competition.amazon_share, 0.15, 0.35, 12) +
      (competition.top10_churn === null
        ? 0
        : clamp(((competition.top10_churn - 0.15) / 0.35) * 8, -6, 8))
  )
  const peak = capacity.season?.peak_ratio ?? 0
  const entryScore = clamp(
    Math.round(
      (entry.nesr ?? 0.12) * 260 +
        (cycle === null ? 0 : cycle <= 210 ? 10 : cycle <= 360 ? 4 : cycle <= 540 ? -4 : -10) +
        (rating === null ? 0 : rating <= 4.3 ? 4 : rating <= 4.5 ? 0 : -6) -
        (peak >= 2 ? 12 : peak >= 1.5 ? 6 : 0) -
        ((entry.bs_share_head ?? 0) >= 0.5 ? 4 : 0) -
        ((entry.oversize_share ?? 0) >= 0.5 ? 10 : (entry.oversize_share ?? 0) >= 0.2 ? 4 : 0) +
        26
    )
  )
  const score = Math.round(capScore * 0.35 + compScore * 0.35 + entryScore * 0.3)
  const veto =
    input.gate.find(gate => gate.status === "block")?.text ??
    ((competition.product_monopoly ?? 0) > 0.8
      ? "商品垄断度超过 80%"
      : (competition.brand_monopoly ?? 0) > 0.85
        ? "品牌垄断度超过 85%"
        : input.sample.seller_scope !== "head" && (competition.amazon_share ?? 0) > 0.5
          ? "Amazon 占比超过 50%"
          : (competition.acos ?? 0) > 1
            ? "广告压力 ACOS 超过 100%"
            : capacity.generic_search_share !== null && capacity.generic_search_share < 0.3
              ? "通用词搜索占比低于 30%"
              : null)
  const advice = veto
    ? "建议暂缓"
    : score >= 70
      ? "可重点评估"
      : score >= 55
        ? "建议差异化切入"
        : "建议谨慎评估"
  const weaknesses = buildReads(input)
    .filter(read => read.tone === "risk" || read.tone === "weak")
    .slice(0, 5)
    .map(
      read => `${read.label}${read.note.includes("头部口径") ? "（头部口径）" : ""} ${read.value}`
    )
  const reason = veto
    ? `主要问题：${veto}。建议先确认这一点能否解决（如压低采购成本、调整价位或改款），再决定是否进入。`
    : score >= 70
      ? "容量、竞争和入局条件整体较好，建议进一步核实供应链与利润后推进。"
      : score >= 55
        ? `存在机会，建议从细分卖点或高效价带差异化切入${weaknesses.length ? `；需要留意：${weaknesses.join("、")}` : ""}。`
        : "容量 / 竞争 / 入局有几项偏弱，建议先观察，或寻找细分卖点与价位再决定是否投入。"
  const crossNote =
    capacity.sales_growth_pct !== null && capacity.demand_yoy_pct !== null
      ? capacity.sales_growth_pct > 5 && capacity.demand_yoy_pct < 0
        ? "量搜背离：销量增长、需求收缩，增长可能来自降价、促销或广告抢存量。"
        : capacity.sales_growth_pct < 0 && capacity.demand_yoy_pct > 5
          ? "量搜信号：需求在涨而头部没接住，可能存在补位机会。"
          : null
      : null
  return {
    advice,
    veto,
    score: veto ? Math.min(score, 45) : score,
    cap_score: capScore,
    comp_score: compScore,
    entry_score: entryScore,
    reason,
    cross_note: crossNote,
  }
}

function buildRules(input: CategoryAnalysisInput): Rule[] {
  const mono = (value: NullableNumber) =>
    value === null
      ? "需补充"
      : value >= 0.6
        ? "很高"
        : value >= 0.45
          ? "较高"
          : value >= 0.3
            ? "中等"
            : value >= 0.18
              ? "较低"
              : "很低"
  const sensitivity = input.entry.price_sensitivity,
    acos = input.competition.acos
  const prices = input.entry.pivots.price
    .filter(pivot => (pivot.mult ?? 0) > 1)
    .sort((a, b) => b.mult! - a.mult!)
    .slice(0, 2)
    .map(pivot => pivot.label)
  return [
    ...(
      [
        ["product_monopoly", "商品垄断度"],
        ["brand_monopoly", "品牌垄断度"],
        ["review_dependency", "评论依赖性"],
      ] as const
    ).map(([key, label]) => ({
      key,
      label,
      level: mono(input.competition[key]),
      value: input.competition[key],
    })),
    {
      key: "rating_requirement",
      label: "评分值依赖性",
      level: input.entry.rating_requirement
        ? "有最低评分要求"
        : input.entry.pivots.rating.length
          ? "无明显门槛"
          : "需补充",
      value: input.entry.rating_requirement,
    },
    {
      key: "price_sensitivity",
      label: "价格敏感度",
      level:
        sensitivity === null
          ? "需补充"
          : sensitivity >= 0.35
            ? "很高"
            : sensitivity >= 0.25
              ? "较高"
              : sensitivity >= 0.15
                ? "中等"
                : sensitivity >= 0.08
                  ? "较低"
                  : sensitivity >= 0.05
                    ? "很低"
                    : "极低",
      value: sensitivity,
    },
    {
      key: "new_product_cycle",
      label: "新品打造周期",
      level: input.entry.new_product_cycle ? "已识别" : "未识别",
      value: input.entry.new_product_cycle,
    },
    {
      key: "best_price_bands",
      label: "最值得进入的价格带",
      level: prices.length ? "已识别" : "未识别",
      value: prices,
    },
    {
      key: "ad_pressure",
      label: "市场广告压力指数",
      level:
        acos === null
          ? "需补充"
          : acos >= 1
            ? "极高"
            : acos >= 0.65
              ? "较高"
              : acos >= 0.4
                ? "中等"
                : acos >= 0.25
                  ? "较低"
                  : "低",
      value: acos,
    },
  ]
}

export function buildReads(input: CategoryAnalysisInput): MetricRead[] {
  const reads: MetricRead[] = []
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`
  const add = (
    key: string,
    section: MetricRead["section"],
    label: string,
    value: NullableNumber,
    tone: (value: number) => MetricTone,
    format: (value: number) => string = percent,
    note = ""
  ) =>
    reads.push({
      key,
      section,
      label,
      value: value === null ? "需补充" : format(value),
      tone: value === null ? "missing" : tone(value),
      note: value === null ? note || "需补充" : note,
    })
  const low =
    (good: number, neutral: number, weak: number) =>
    (value: number): MetricTone =>
      value <= good ? "good" : value <= neutral ? "neutral" : value <= weak ? "weak" : "risk"
  const high =
    (good: number, weak: number) =>
    (value: number): MetricTone =>
      value >= good ? "good" : value >= weak ? "weak" : "risk"
  const money = (value: number) =>
    `${({ US: "$", UK: "£", DE: "€", JP: "¥" } as Record<string, string>)[input.category.site] ?? ""}${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
  add(
    "annual_revenue",
    "capacity",
    input.sample.source !== "sellersprite" ? "样本内年销售额" : "年销售额",
    input.capacity.annual_revenue,
    value =>
      input.sample.source !== "sellersprite"
        ? "neutral"
        : value >= 8e7
          ? "good"
          : value >= 2e7
            ? "neutral"
            : "weak",
    money,
    input.sample.source !== "sellersprite" ? "仅代表样本内，不用于判断市场容量" : ""
  )
  for (const [key, label] of [
    ["sales_growth_pct", "销量趋势"],
    ["demand_yoy_pct", "需求同比"],
  ] as const)
    add(
      key,
      "capacity",
      label,
      input.capacity[key],
      value => (value >= 6 ? "good" : value >= 0 ? "neutral" : "risk"),
      value => `${value.toFixed(1)}%`
    )
  add(
    "generic_search_share",
    "capacity",
    "通用词搜索占比",
    input.capacity.generic_search_share,
    value => (value >= 0.65 ? "good" : value >= 0.5 ? "neutral" : value >= 0.35 ? "weak" : "risk")
  )
  for (const [key, label, good, neutral, weak] of [
    ["product_monopoly", "商品垄断度", 0.45, 0.6, 0.75],
    ["brand_monopoly", "品牌垄断度", 0.45, 0.6, 0.8],
    ["seller_monopoly", "卖家垄断度", 0.45, 0.6, 0.8],
    ["amazon_share", "Amazon 拿 Buybox", 0.1, 0.1, 0.3],
    ["cn_share", "中国卖家占比", 0.5, 0.75, Infinity],
    ["review_dependency", "评论依赖性", 0.25, 0.45, 0.6],
    ["acos", "广告压力 ACOS", 0.35, 0.6, 0.9],
  ] as const)
    add(
      key,
      "competition",
      label,
      input.competition[key],
      low(good, neutral, weak),
      percent,
      ["amazon_share", "cn_share"].includes(key) && input.sample.seller_scope === "head"
        ? "头部口径"
        : ""
    )
  if (input.sample.seller_scope === "head") {
    const index = reads.findIndex(read => read.key === "seller_monopoly")
    if (index >= 0) reads.splice(index, 1)
    add(
      "head_buybox_conc",
      "competition",
      "头部 BuyBox 集中度",
      input.competition.head_buybox_conc?.share ?? null,
      value => (value <= 0.25 ? "good" : value <= 0.5 ? "neutral" : "weak"),
      percent,
      "头部口径"
    )
  }
  add("top10_churn", "competition", "Top10 换血率", input.competition.top10_churn, high(0.3, 0.15))
  add(
    "multi_seller_share",
    "head",
    "多卖家/跟卖",
    input.head.multi_seller_share,
    low(0.2, 0.2, 0.5)
  )
  add(
    "reviews_new_med",
    "head",
    "头部评论月新增",
    input.head.reviews_new_med,
    () => "neutral",
    value => `${value.toFixed(1)} 条/月`
  )
  add(
    "bsr_swing_med",
    "head",
    "头部 BSR 波动",
    input.sample.source === "sif"
      ? (input.head.bsr_swing_med ?? null)
      : input.head.keepa.bsr_swing_med,
    value => (value >= 0.3 ? "good" : value >= 0.12 ? "neutral" : "weak")
  )
  add(
    "price_swing_med",
    "head",
    "头部价格波动",
    input.sample.source === "sif"
      ? (input.head.price_swing_med ?? null)
      : input.head.keepa.price_swing_med,
    low(0.1, 0.1, 0.25)
  )
  add(
    "nesr",
    "entry",
    "新品推新成功率",
    input.entry.nesr,
    high(0.18, 0.1),
    percent,
    input.sample.new_count < 15
      ? "新品样本不足 15 条"
      : !input.sample.new_release_merged && input.sample.source !== "sellersprite"
        ? "新品补样不足"
        : ""
  )
  const cycle = input.entry.pivots.launch_days.find(pivot => (pivot.mult ?? 0) > 1)
  add(
    "new_product_cycle",
    "entry",
    "新品打造周期",
    input.entry.new_product_cycle && cycle ? (cycle.upper ?? 721) : null,
    low(210, 210, 360),
    () => input.entry.new_product_cycle!,
    input.entry.new_product_cycle ? "" : "新品样本不足或尚未识别有效周期"
  )
  const rating = input.entry.pivots.rating.find(pivot => (pivot.mult ?? 0) > 1)
  add(
    "rating_requirement",
    "entry",
    "最低评分门槛",
    rating ? (rating.upper ?? 4.8) : null,
    low(4.3, 4.5, Infinity),
    () => input.entry.rating_requirement!
  )
  add(
    "bs_share_head",
    "entry",
    "头部标签密度（BS 标）",
    input.entry.bs_share_head ?? input.entry.listing_bar.bs_share,
    value => (value >= 0.5 ? "weak" : "good")
  )
  add(
    "natural_share_med",
    "head",
    "头部自然流量占比",
    input.head.natural_share_med ?? null,
    high(0.6, 0.3)
  )
  add(
    "drops90_med",
    "head",
    "90 天掉榜数",
    input.head.drops90_med ?? input.head.keepa.drops90_med,
    () => "neutral",
    value => value.toFixed(1)
  )
  add("oversize_share", "entry", "大件占比", input.entry.oversize_share, low(0.2, 0.2, 0.5))
  add(
    "price_sensitivity",
    "entry",
    "价格敏感度",
    input.entry.price_sensitivity,
    low(0.15, 0.25, Infinity)
  )
  return reads
}
