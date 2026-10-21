import type {
  CategoryKeyword,
  Gate,
  KeepaItem,
  NullableNumber,
  Pivot,
  SampleRow,
  SearchPoint,
} from "./category-analysis.types"

export function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : ""
}

export function numberOrNull(value: unknown): NullableNumber {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim()) ||
    typeof value === "boolean"
  )
    return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
export function median(values: NullableNumber[]): NullableNumber {
  const sorted = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
export function sum(values: NullableNumber[]): NullableNumber {
  const numbers = values.filter(
    (value): value is number => value !== null && Number.isFinite(value)
  )
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) : null
}
export function divide(numerator: NullableNumber, denominator: NullableNumber): NullableNumber {
  return numerator !== null && denominator !== null && denominator > 0
    ? numerator / denominator
    : null
}
export function deduplicateParents(rows: SampleRow[]): SampleRow[] {
  const parents = new Map<string, SampleRow>()
  for (const row of rows) {
    const key = row.parent || row.asin
    const previous = parents.get(key)
    // 同父体销量是共享值，取完整且销量最大的代表行，绝不相加。
    if (!previous || (row.sales ?? -1) > (previous.sales ?? -1)) parents.set(key, row)
  }
  return [...parents.values()]
}
export function weightedShare(
  rows: SampleRow[],
  predicate: (row: SampleRow) => boolean | null
): NullableNumber {
  const known = rows.filter(row => predicate(row) !== null && row.sales !== null)
  return divide(
    sum(known.filter(row => predicate(row)).map(row => row.sales)) ?? (known.length ? 0 : null),
    sum(known.map(row => row.sales))
  )
}
export function topShare(
  rows: SampleRow[],
  value: (row: SampleRow) => NullableNumber,
  ascending = false
): NullableNumber {
  const known = rows
    .filter(row => value(row) !== null && row.sales !== null)
    .sort((a, b) => ((value(b) ?? 0) - (value(a) ?? 0)) * (ascending ? -1 : 1))
  return divide(
    sum(known.slice(0, Math.max(1, Math.round(known.length * 0.1))).map(row => row.sales)),
    sum(known.map(row => row.sales))
  )
}
export function groupedShare(rows: SampleRow[], key: "brand" | "seller"): NullableNumber {
  const groups = new Map<string, number>()
  for (const row of rows)
    if (row[key] && row.sales !== null)
      groups.set(row[key], (groups.get(row[key]) ?? 0) + row.sales)
  const sales = [...groups.values()].sort((a, b) => b - a)
  return divide(sum(sales.slice(0, Math.max(1, Math.round(sales.length * 0.1)))), sum(sales))
}
export function salesGrowth(rows: SampleRow[]): NullableNumber {
  const known = rows.filter(row => row.sales !== null && row.growth !== null && row.growth > -1)
  const ratio = divide(
    sum(known.map(row => row.sales)),
    sum(known.map(row => row.sales! / (1 + row.growth!)))
  )
  return ratio === null ? null : (ratio - 1) * 100
}
export function buildPivots(
  rows: SampleRow[],
  key: "price" | "rating" | "reviews" | "launchDays",
  edges: number[],
  labels?: string[]
): Pivot[] {
  const known = rows.filter(row => row[key] !== null)
  if (!known.length) return []
  const totalSales = sum(known.map(row => row.sales))
  return Array.from({ length: edges.length + 1 }, (_, index) => {
    const lower = index ? edges[index - 1] : 0
    const upper = edges[index] ?? Infinity
    const matches = known.filter(row => row[key]! >= lower && row[key]! < upper)
    const listingShare = matches.length / known.length
    const salesShare = divide(
      sum(matches.map(row => row.sales)) ?? (matches.length ? null : 0),
      totalSales
    )
    const label =
      labels?.[index] ??
      (index === 0 ? `< ${upper}` : upper === Infinity ? `≥ ${lower}` : `${lower}–${upper}`)
    return {
      label,
      upper: Number.isFinite(upper) ? upper : null,
      listing_share: listingShare,
      sales_share: salesShare,
      mult: divide(salesShare, listingShare),
    }
  })
}
export function calculateYoy(series: SearchPoint[]): NullableNumber {
  const ordered = [...series].sort((a, b) => a.month.localeCompare(b.month))
  if (ordered.length < 13) return null
  const recent = ordered.slice(-12)
  const previous = ordered.slice(-24, -12)
  const ratio = divide(
    sum(recent.map(point => point.value))! / recent.length,
    sum(previous.map(point => point.value))! / previous.length
  )
  return ratio === null ? null : (ratio - 1) * 100
}
export function calculateSeason(series: SearchPoint[]) {
  if (series.length < 13) return null
  const monthly = Array.from({ length: 12 }, () => [] as number[])
  for (const point of [...series].sort((a, b) => a.month.localeCompare(b.month)).slice(-24)) {
    const index = Number(point.month.slice(5, 7)) - 1
    if (index >= 0 && index < 12) monthly[index].push(point.value)
  }
  if (monthly.some(values => !values.length)) return null
  const averages = monthly.map(values => values.reduce((a, b) => a + b, 0) / values.length)
  const minimum = Math.min(...averages)
  const maximum = Math.max(...averages)
  if (maximum <= 0 || minimum <= 0) return null
  const peakRatio = maximum / minimum
  const peakIndex = averages.indexOf(maximum)
  const peaks = averages
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value)
    .slice(0, peakRatio >= 1.5 ? 2 : 1)
    .sort((a, b) => a.index - b.index)
  return {
    peak_ratio: peakRatio,
    is_seasonal: peakRatio >= 1.5,
    peak_label: peaks.map(peak => `${peak.index + 1}月`).join("–"),
    last_order: peakRatio >= 1.5 ? `${((peakIndex + 9) % 12) + 1}月` : null,
    curve: averages.map((value, index) => ({ month: `${index + 1}月`, value })),
  }
}
export function classifyKeyword(keyword: Omit<CategoryKeyword, "verdict" | "reason">): {
  verdict: string
  reason: string
} {
  const {
    search_volume: volume,
    supply_demand: ratio,
    yoy_pct: growth,
    top3_concentration: concentration,
    acos,
  } = keyword
  if (volume === null) return { verdict: "需补充", reason: "月搜需补充" }
  if (volume < 1000) return { verdict: "暂不建议", reason: "月搜不足 1,000" }
  if (ratio !== null && ratio < 1) return { verdict: "暂不建议", reason: "供需比低于 1，供给过剩" }
  if (growth !== null && growth <= -15)
    return { verdict: "暂不建议", reason: "需求同比下降至少 15%" }
  if (acos !== null && acos > 1)
    return { verdict: "暂不建议", reason: "ACOS 超过 100%，广告成本过高" }
  const weaknesses: string[] = []
  if (concentration !== null && concentration > 45)
    weaknesses.push(
      `集中度 ${concentration.toFixed(1)}%${concentration > 60 ? "（头部把持）" : ""}`
    )
  if (ratio !== null && ratio < 4) weaknesses.push(`供需比 ${ratio.toFixed(1)}`)
  if (growth !== null && growth < 0) weaknesses.push(`同比 ${growth.toFixed(1)}%`)
  if (acos !== null && acos > 0.6) weaknesses.push(`ACOS ${(acos * 100).toFixed(1)}%`)
  const omitted = [
    concentration === null ? "集中度" : null,
    ratio === null ? "供需比" : null,
    growth === null ? "同比" : null,
    acos === null ? "ACOS" : null,
  ].filter(Boolean)
  return {
    verdict: weaknesses.length ? "可做长尾" : "建议主攻",
    reason: `${weaknesses.length ? weaknesses.join("、") : "已知指标符合主攻阈值"}${omitted.length ? `（${omitted.join("、")} 未纳入）` : ""}`,
  }
}
export function buildGates(name: string): Gate[] {
  const text = name.toLowerCase()
  const firstMatch = (rules: [RegExp, string][], fallback: string) =>
    rules.find(([pattern]) => pattern.test(text))?.[1] ?? fallback
  const review =
    /grocery|food|beverage|health|supplement|automotive|watch|jewel|medical|食品|保健|汽车|手表|珠宝|医疗/.test(
      text
    )
  const certification = firstMatch(
    [
      [/toy|baby|kid|玩具|婴|童/, "CPC + CPSIA"],
      [/food|kitchen contact|食品/, "FDA"],
      [/electronic|light|charger|电器|灯/, "UL/ETL + FCC"],
      [/beauty|skin|美妆|护肤/, "成分表 + MoCRA"],
    ],
    ""
  )
  const hazardous = firstMatch(
    [
      [/battery|charger|电池/, "UN38.3 + MSDS"],
      [/aerosol|liquid|oil|candle|液体/, "危险品审核"],
      [/magnet|knife|磁|刀具/, "磁检或利器声明"],
    ],
    ""
  )
  const hasIpRisk = /phone case|cartoon|print|sticker|手机壳|卡通|图案|贴纸|配件/.test(text)
  return [
    {
      label: "类目审核",
      status: review ? "warn" : "pass",
      text: review ? "需开放 / 资质审核" : "未命中类目审核规则，发布前核实站点要求",
    },
    {
      label: "强制认证",
      status: certification ? "warn" : "pass",
      text: certification || "未命中认证规则，按实际材质与用途核实",
    },
    {
      label: "危险品/带电",
      status: hazardous ? "warn" : "pass",
      text: hazardous || "未命中危险品规则",
    },
    {
      label: "专利风险",
      status: "warn",
      text: "需人工确认：USPTO / Google Patents 做 FTO 检索，重点查头部 Top20 的结构专利",
    },
    {
      label: "IP 侵权风险",
      status: hasIpRisk ? "warn" : "pass",
      text: hasIpRisk ? "IP 投诉高发，核实商标与图案授权" : "未命中 IP 高风险规则，仍需核查授权",
    },
    {
      label: "供应链成熟度",
      status: "warn",
      text: "需人工确认：到 1688 / 产业带询盘，确认模具、起订量、打样周期",
    },
  ]
}
export function summarizeKeepa(items: KeepaItem[]) {
  const offers = items.filter(item => item.offers !== null)
  const buyboxes = items.filter(item => item.buybox !== null)
  return {
    n: items.length,
    hijack_share: divide(offers.filter(item => item.offers! > 1).length, offers.length),
    amazon_buybox_share: divide(
      buyboxes.filter(item => item.buybox === "ATVPDKIKX0DER").length,
      buyboxes.length
    ),
    bsr_swing_med: median(
      items.map(item =>
        item.bsrNow !== null && item.bsrAvg90 !== null
          ? Math.abs(item.bsrNow - item.bsrAvg90) / Math.max(item.bsrAvg90, 100)
          : null
      )
    ),
    price_swing_med: median(
      items.map(item =>
        item.priceMax90 !== null && item.priceMin90 !== null
          ? divide(item.priceMax90 - item.priceMin90, item.priceAvg90)
          : null
      )
    ),
    review_velocity_med: median(items.map(item => item.reviewVelocity)),
    drops90_med: median(items.map(item => item.drops90)),
  }
}
