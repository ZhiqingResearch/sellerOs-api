/** 2026-09-18 标准化提示词的输入协议；snake_case 仅用于与文档一致的 JSON 字段。 */
export type NullableNumber = number | null
export interface CategorySelection {
  nodeId: string
  nodeIdPath: string
  name: string
  path: string
  seedKeyword?: string
  parentName?: string
  categoryId?: string
  from?: "picked" | "keyword"
  resolvedFrom?: string[]
}
export interface SampleRow {
  asin: string
  title?: string
  isNewRelease?: boolean
  sellerId?: string | null
  parent: string | null
  brand: string | null
  price: NullableNumber
  sales: NullableNumber
  revenue: NullableNumber
  growth: NullableNumber
  rating: NullableNumber
  reviews: NullableNumber
  reviewsNew: NullableNumber
  seller: string | null
  sellerCountry: string | null
  sellerCount: NullableNumber
  launchDays: NullableNumber
  weightLb: NullableNumber
  fbaFee?: NullableNumber
  cuft?: NullableNumber
  sizeTier: string | null
  lqs: NullableNumber
  aplus: boolean | null
  bs: boolean | null
  ac: boolean | null
}
export interface MonthSample {
  month: string
  rows: SampleRow[]
}
export interface SearchPoint {
  month: string
  value: number
}
export interface CategoryKeyword {
  is_user?: boolean
  keyword: string
  search_volume: NullableNumber
  aba_rank: NullableNumber
  competitors: NullableNumber
  supply_demand: NullableNumber
  yoy_pct: NullableNumber
  top3_concentration: NullableNumber
  natural_share: NullableNumber
  ppc: NullableNumber
  cvr: NullableNumber
  acos: NullableNumber
  verdict: string
  reason: string
  history: SearchPoint[]
}
export interface KeepaItem {
  asin: string
  bsrNow: NullableNumber
  bsrAvg90: NullableNumber
  drops90: NullableNumber
  offers: NullableNumber
  buybox: string | null
  priceMin90: NullableNumber
  priceMax90: NullableNumber
  priceAvg90: NullableNumber
  reviewVelocity: NullableNumber
}
export interface HeadTrend extends KeepaItem {
  sellerCount: NullableNumber
  reviewsNew: NullableNumber
  naturalShare: NullableNumber
}
export type AnalysisPlan = "cat" | "kw" | "mix"
export interface CategoryCandidate {
  categoryId: string
  categoryName: string
  hits: number
  sales: number
  kws: string[]
  best: number
}
export interface KeywordResolution {
  candidates: CategoryCandidate[]
  topAsins: string[]
  notices: string[]
  confirmedIds?: string[]
}
export interface CategoryEvidence {
  categoryId?: string
  trends?: HeadTrend[]
  newReleaseMerged?: number
  source: "sellersprite" | "sif_sample" | "sif"
  months: MonthSample[]
  rows: SampleRow[]
  keywords: CategoryKeyword[]
  keepa: KeepaItem[]
  notices: string[]
}
export interface Pivot {
  label: string
  listing_share: number
  sales_share: NullableNumber
  mult: NullableNumber
  upper: number | null
}
export interface Gate {
  label: string
  status: "pass" | "warn" | "block"
  text: string
}
export interface Rule {
  key: string
  label: string
  level: string
  value: string | number | string[] | null
}
export type MetricTone = "good" | "neutral" | "weak" | "risk" | "missing"
export interface MetricRead {
  key: string
  section: "capacity" | "competition" | "head" | "entry"
  label: string
  value: string
  tone: MetricTone
  note: string
}
export interface CategoryAnalysisInput {
  category: {
    path: string
    en: string
    site: string
    category_id?: string
    from?: "picked" | "keyword"
    resolved_from?: string[]
  }
  user_keywords?: {
    list: string[]
    plan: AnalysisPlan
    consistent: boolean | null
    asin_overlap: NullableNumber
    top_category: string | null
    focus_rows: NullableNumber
  }
  sample: {
    source: "sellersprite" | "sif_sample" | "sif"
    listing_count: number
    months: string[]
    new_count: number
    new_release_merged?: number
    seller_scope?: "head" | "all"
  }
  diag: {
    advice: string
    veto: string | null
    score: number
    cap_score: number
    comp_score: number
    entry_score: number
    reason: string
    cross_note: string | null
  }
  capacity: {
    annual_revenue: NullableNumber
    sales_growth_pct: NullableNumber
    monthly_sales: { month: string; sales: NullableNumber }[]
    demand_yoy_pct: NullableNumber
    generic_search_share: NullableNumber
    season: {
      peak_ratio: number
      is_seasonal: boolean
      peak_label: string
      last_order: string | null
      curve: SearchPoint[]
    } | null
  }
  competition: {
    product_monopoly: NullableNumber
    brand_monopoly: NullableNumber
    seller_monopoly: NullableNumber
    head_buybox_conc?: { share: number; name: string; count: number; scope: number } | null
    amazon_share: NullableNumber
    cn_share: NullableNumber
    review_dependency: NullableNumber
    acos: NullableNumber
    top10_churn: NullableNumber
    conc_trend: { link: string | null; brand: string | null; seller: string | null }
    conc_monthly: {
      month: string
      link: NullableNumber
      brand: NullableNumber
      seller: NullableNumber
    }[]
    brands_top10: {
      brand: string
      sales_share: NullableNumber
      links: number
      avg_price: NullableNumber
      growth: NullableNumber
      amazon: boolean
    }[]
    rules: Rule[]
  }
  head: {
    seller_med?: NullableNumber
    bsr_swing_med?: NullableNumber
    price_swing_med?: NullableNumber
    natural_share_med?: NullableNumber
    drops90_med?: NullableNumber
    multi_seller_share: NullableNumber
    reviews_new_med: NullableNumber
    keepa: {
      n: number
      hijack_share: NullableNumber
      amazon_buybox_share: NullableNumber
      bsr_swing_med: NullableNumber
      price_swing_med: NullableNumber
      review_velocity_med: NullableNumber
      drops90_med: NullableNumber
    }
    rows: {
      bs?: boolean | null
      asin: string
      brand: string | null
      price: NullableNumber
      sales: NullableNumber
      growth: NullableNumber
      rating: NullableNumber
      reviews: NullableNumber
      reviews_new: NullableNumber
      seller_count: NullableNumber
      buybox: string | null
      launch_days: NullableNumber
      tags: string[]
      bsr_now: NullableNumber
      bsr_avg90: NullableNumber
      drops90: NullableNumber
      price_min90: NullableNumber
      price_max90: NullableNumber
    }[]
  }
  entry: {
    bs_share_head?: NullableNumber
    nesr: NullableNumber
    new_product_cycle: string | null
    rating_requirement: string | null
    listing_bar: { lqs_med: NullableNumber; aplus_share: NullableNumber; bs_share: NullableNumber }
    oversize_share: NullableNumber
    price_sensitivity: NullableNumber
    main_price_band: string | null
    pivots: { price: Pivot[]; rating: Pivot[]; reviews: Pivot[]; launch_days: Pivot[] }
    recent_winners: {
      asin: string
      brand: string | null
      price: NullableNumber
      sales: NullableNumber
      launch_days: NullableNumber
      rating?: NullableNumber
      reviews?: NullableNumber
      reviews_new?: NullableNumber
      tags?: string[]
    }[]
    keywords: CategoryKeyword[]
  }
  gate: Gate[]
}
export interface CategoryReport {
  categoryId: string
  input: CategoryAnalysisInput
  reads: MetricRead[]
  markdown: string
  notices: string[]
}
