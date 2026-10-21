export interface OperationPlanCompetitor {
  productId: string
  platform: string
  currency: string
  sourceUrl?: string
  title?: string
  price?: number
  rating?: number
  reviewCount?: number
  bullets?: string[]
}

/** 后端从链接解析，调用方不传此结构。 */
export interface OperationPlanInput {
  schemaVersion?: number
  requestId: string
  productText: string
  market: string
  category: string
  operationMode: "jingpin" | "puhuo"
  currentPrice: number | null
  startDate: string
  competitors: OperationPlanCompetitor[]
  sourceProduct?: {
    url: string
    asin: string
    title: string
    price: number | null
    currency: string
    collectedAt: string
  }
}
