import { BadRequestException, PayloadTooLargeException } from "@nestjs/common"
import {
  CreateSmartPricingRecordDto,
  PricingCompetitorContextDto,
  PricingInputDto,
  PricingProductDto,
  PricingResultDto,
} from "./dto/create-smart-pricing-record.dto"
import {
  HEX_COLOR_PATTERN,
  SMART_PRICING_CURRENCIES,
  SMART_PRICING_MARKETPLACES,
  SMART_PRICING_MAX_BYTES,
  SMART_PRICING_MAX_COMPETITORS,
  SMART_PRICING_MAX_FILENAMES,
  SMART_PRICING_SCHEMA_VERSION,
  SMART_PRICING_STAGE_COUNT,
  SmartPricingMarketplaceCode,
  SmartPricingCurrency,
} from "./smart-pricing.constants"

const ASIN_PATTERN = /^[A-Z0-9]{10}$/
const NUMBER_EPSILON = 1e-9
const REPEATED_INPUT_FIELDS = [
  "cost",
  "freight",
  "fba",
  "commR",
  "acosR",
  "retR",
  "vatR",
  "premium",
  "targetM",
] as const

export interface NormalizedPricingProduct {
  name: string
  sourceText?: string
  sourceUrl?: string
  filenames?: string[]
  extractedProductInfo?: string
}

export interface NormalizedPricingCompetitor {
  asin?: string
  title: string
  brand?: string
  price: number
  rating?: number
  ratings?: number
}

export interface NormalizedPricingCompetitorContext {
  sampleSize: number
  priceMin: number
  priceMedian: number
  priceMax: number
  competitors: NormalizedPricingCompetitor[]
}

export interface NormalizedPricingResult {
  name: string
  cost: number
  freight: number
  fba: number
  Cfix: number
  commR: number
  acosR: number
  retR: number
  vatR: number
  premium: number
  targetM: number
  rateSum: number
  P_floor: number
  P_target: number
  P_ceiling: number
  rec: number
  recNet: number
  recMargin: number
  infeasible: boolean
  sHealth: number
  sCompete: number
  sConv: number
  sRisk: number
  composite: number
  verdict: { t: string; c: string }
  competitorRecommendation?: string
  stages: Array<[string, string, string, number]>
  waterfall: Array<[string, number, string]>
}

export interface SmartPricingValidationResult {
  schemaVersion: number
  marketplaceCode: SmartPricingMarketplaceCode
  marketplaceName: string
  currency: SmartPricingCurrency
  category: string
  product: NormalizedPricingProduct
  input: PricingInputDto
  competitorContext: NormalizedPricingCompetitorContext | null
  result: NormalizedPricingResult
  payloadBytes: number
}

export function validateAndNormalizeSmartPricingRecord(
  dto: CreateSmartPricingRecordDto
): SmartPricingValidationResult {
  if (dto.schemaVersion !== SMART_PRICING_SCHEMA_VERSION) {
    throw new BadRequestException({
      code: "UNSUPPORTED_SMART_PRICING_SCHEMA_VERSION",
      message: `当前仅支持 schemaVersion=${SMART_PRICING_SCHEMA_VERSION}`,
    })
  }

  const marketplaceCode = normalizeMarketplaceCode(dto.marketplaceCode)
  const marketplaceName = requiredText(dto.marketplaceName, "marketplaceName", 64)
  if (marketplaceName !== SMART_PRICING_MARKETPLACES[marketplaceCode]) {
    invalidPayload("marketplaceCode 与 marketplaceName 不匹配")
  }

  const currency = normalizeCurrency(dto.currency)

  const category = requiredText(dto.category, "category", 255)
  const product = normalizeProduct(dto.product)
  const input = normalizeInput(dto.input)
  const competitorContext = normalizeCompetitorContext(dto.competitorContext)
  const result = normalizeResult(dto.result, product.name, input)

  const snapshot = {
    schemaVersion: dto.schemaVersion,
    marketplaceCode,
    marketplaceName,
    currency,
    category,
    product,
    input,
    competitorContext,
    result,
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8")
  if (payloadBytes > SMART_PRICING_MAX_BYTES) {
    throw new PayloadTooLargeException({
      code: "SMART_PRICING_RECORD_PAYLOAD_TOO_LARGE",
      message: "智能定价记录超过允许大小",
      details: { maxBytes: SMART_PRICING_MAX_BYTES, actualBytes: payloadBytes },
    })
  }

  return { ...snapshot, payloadBytes }
}

export function normalizeMarketplaceCode(value: string): SmartPricingMarketplaceCode {
  const normalized = value.trim().toUpperCase()
  if (!Object.prototype.hasOwnProperty.call(SMART_PRICING_MARKETPLACES, normalized)) {
    invalidPayload(`不支持的 marketplaceCode: ${normalized || "空值"}`)
  }
  return normalized as SmartPricingMarketplaceCode
}

export function normalizeCurrency(value: string): SmartPricingCurrency {
  const normalized = (value ?? "").trim().toUpperCase()
  if (!SMART_PRICING_CURRENCIES.includes(normalized as SmartPricingCurrency)) {
    invalidPayload(`不支持的 currency: ${normalized || "空值"}，可选 ${SMART_PRICING_CURRENCIES.join("/")}`)
  }
  return normalized as SmartPricingCurrency
}

function normalizeProduct(product: PricingProductDto): NormalizedPricingProduct {
  if (!product || typeof product !== "object") invalidPayload("product 必须是对象")
  const name = requiredText(product.name, "product.name", 500)
  const sourceText = optionalText(product.sourceText, "product.sourceText", 4000)
  const sourceUrl = optionalText(product.sourceUrl, "product.sourceUrl", 2048)
  const extractedProductInfo = optionalText(
    product.extractedProductInfo,
    "product.extractedProductInfo",
    4000
  )

  let filenames: string[] | undefined
  if (product.filenames !== undefined) {
    if (
      !Array.isArray(product.filenames) ||
      product.filenames.length > SMART_PRICING_MAX_FILENAMES
    ) {
      invalidPayload(`product.filenames 不能超过 ${SMART_PRICING_MAX_FILENAMES} 项`)
    }
    filenames = product.filenames.map((filename, index) => {
      const normalized = requiredText(filename, `product.filenames[${index}]`, 255)
      if (/[\\/\0]/.test(normalized)) {
        invalidPayload(`product.filenames[${index}] 只能包含文件名，不能包含路径`)
      }
      return normalized
    })
  }

  return {
    name,
    ...(sourceText && { sourceText: sanitizeSourceText(sourceText) }),
    ...(sourceUrl && { sourceUrl: sanitizeHttpUrl(sourceUrl, "product.sourceUrl") }),
    ...(filenames !== undefined && { filenames }),
    ...(extractedProductInfo && { extractedProductInfo }),
  }
}

function normalizeInput(input: PricingInputDto): PricingInputDto {
  if (!input || typeof input !== "object") invalidPayload("input 必须是对象")
  return {
    cost: finiteNumber(input.cost, "input.cost", 0),
    freight: finiteNumber(input.freight, "input.freight", 0),
    fba: finiteNumber(input.fba, "input.fba", 0),
    commR: finiteNumber(input.commR, "input.commR", 0, 1),
    acosR: finiteNumber(input.acosR, "input.acosR", 0, 1),
    retR: finiteNumber(input.retR, "input.retR", 0, 1),
    vatR: finiteNumber(input.vatR, "input.vatR", 0, 1),
    premium: finiteNumber(input.premium, "input.premium", 0, 1),
    targetM: finiteNumber(input.targetM, "input.targetM", 0, 1),
  }
}

function normalizeCompetitorContext(
  context: PricingCompetitorContextDto | null | undefined
): NormalizedPricingCompetitorContext | null {
  if (context === null || context === undefined) return null
  if (typeof context !== "object" || Array.isArray(context)) {
    invalidPayload("competitorContext 必须是对象或 null")
  }

  const sampleSize = integer(context.sampleSize, "competitorContext.sampleSize", 0)
  const priceMin = finiteNumber(context.priceMin, "competitorContext.priceMin", 0)
  const priceMedian = finiteNumber(context.priceMedian, "competitorContext.priceMedian", 0)
  const priceMax = finiteNumber(context.priceMax, "competitorContext.priceMax", 0)
  if (priceMin > priceMedian || priceMedian > priceMax) {
    invalidPayload("competitorContext 必须满足 priceMin <= priceMedian <= priceMax")
  }
  if (!Array.isArray(context.competitors)) {
    invalidPayload("competitorContext.competitors 必须是数组")
  }
  if (context.competitors.length > SMART_PRICING_MAX_COMPETITORS) {
    invalidPayload(`competitorContext.competitors 不能超过 ${SMART_PRICING_MAX_COMPETITORS} 项`)
  }

  const competitors = context.competitors.map((competitor, index) => {
    if (!competitor || typeof competitor !== "object" || Array.isArray(competitor)) {
      invalidPayload(`competitorContext.competitors[${index}] 必须是对象`)
    }
    const asinText = optionalText(
      competitor.asin,
      `competitorContext.competitors[${index}].asin`,
      32
    )
    const asin = asinText?.toUpperCase()
    if (asin && !ASIN_PATTERN.test(asin)) {
      invalidPayload(`competitorContext.competitors[${index}].asin 需为 10 位字母数字`)
    }
    const brand = optionalText(
      competitor.brand,
      `competitorContext.competitors[${index}].brand`,
      255
    )
    const rating =
      competitor.rating === undefined
        ? undefined
        : finiteNumber(competitor.rating, `competitorContext.competitors[${index}].rating`, 0, 5)
    const ratings =
      competitor.ratings === undefined
        ? undefined
        : integer(competitor.ratings, `competitorContext.competitors[${index}].ratings`, 0)
    return {
      ...(asin && { asin }),
      title: requiredText(competitor.title, `competitorContext.competitors[${index}].title`, 1000),
      ...(brand && { brand }),
      price: finiteNumber(competitor.price, `competitorContext.competitors[${index}].price`, 0),
      ...(rating !== undefined && { rating }),
      ...(ratings !== undefined && { ratings }),
    }
  })

  if (sampleSize < competitors.length) {
    invalidPayload("competitorContext.sampleSize 不能小于 competitors 数量")
  }
  return { sampleSize, priceMin, priceMedian, priceMax, competitors }
}

function normalizeResult(
  result: PricingResultDto,
  productName: string,
  input: PricingInputDto
): NormalizedPricingResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    invalidPayload("result 必须是对象")
  }

  const name = requiredText(result.name, "result.name", 500)
  if (name !== productName) invalidPayload("result.name 必须与 product.name 一致")

  const normalized: Omit<NormalizedPricingResult, "verdict" | "stages" | "waterfall"> = {
    name,
    cost: finiteNumber(result.cost, "result.cost", 0),
    freight: finiteNumber(result.freight, "result.freight", 0),
    fba: finiteNumber(result.fba, "result.fba", 0),
    Cfix: finiteNumber(result.Cfix, "result.Cfix", 0),
    commR: finiteNumber(result.commR, "result.commR", 0, 1),
    acosR: finiteNumber(result.acosR, "result.acosR", 0, 1),
    retR: finiteNumber(result.retR, "result.retR", 0, 1),
    vatR: finiteNumber(result.vatR, "result.vatR", 0, 1),
    premium: finiteNumber(result.premium, "result.premium", 0, 1),
    targetM: finiteNumber(result.targetM, "result.targetM", 0, 1),
    rateSum: finiteNumber(result.rateSum, "result.rateSum", 0),
    P_floor: finiteNumber(result.P_floor, "result.P_floor", 0),
    P_target: finiteNumber(result.P_target, "result.P_target", 0),
    P_ceiling: finiteNumber(result.P_ceiling, "result.P_ceiling", 0),
    rec: finiteNumber(result.rec, "result.rec", 0),
    recNet: finiteNumber(result.recNet, "result.recNet"),
    recMargin: finiteNumber(result.recMargin, "result.recMargin"),
    infeasible: booleanValue(result.infeasible, "result.infeasible"),
    sHealth: finiteNumber(result.sHealth, "result.sHealth", 0, 100),
    sCompete: finiteNumber(result.sCompete, "result.sCompete", 0, 100),
    sConv: finiteNumber(result.sConv, "result.sConv", 0, 100),
    sRisk: finiteNumber(result.sRisk, "result.sRisk", 0, 100),
    composite: finiteNumber(result.composite, "result.composite", 0, 100),
    ...(optionalText(result.competitorRecommendation, "result.competitorRecommendation", 2000) && {
      competitorRecommendation: result.competitorRecommendation!.trim(),
    }),
  }

  for (const field of REPEATED_INPUT_FIELDS) {
    if (!nearlyEqual(normalized[field], input[field])) {
      invalidPayload(`result.${field} 必须与 input.${field} 一致`)
    }
  }

  if (!result.verdict || typeof result.verdict !== "object") {
    invalidPayload("result.verdict 必须是对象")
  }
  const verdictText = requiredText(result.verdict.t, "result.verdict.t", 255)
  const verdictColor = requiredText(result.verdict.c, "result.verdict.c", 7)
  if (!HEX_COLOR_PATTERN.test(verdictColor)) {
    invalidPayload("result.verdict.c 必须是六位 HEX 颜色")
  }

  const stages = normalizeStages(result.stages)
  const waterfall = normalizeWaterfall(result.waterfall, input.vatR)

  return {
    ...normalized,
    verdict: { t: verdictText, c: verdictColor.toLowerCase() },
    stages,
    waterfall,
  }
}

function normalizeStages(value: unknown): Array<[string, string, string, number]> {
  if (!Array.isArray(value) || value.length !== SMART_PRICING_STAGE_COUNT) {
    invalidPayload(`result.stages 必须正好包含 ${SMART_PRICING_STAGE_COUNT} 项`)
  }
  return value.map((stage, index) => {
    if (!Array.isArray(stage) || stage.length !== 4) {
      invalidPayload(`result.stages[${index}] 必须是长度为 4 的数组`)
    }
    return [
      requiredText(stage[0], `result.stages[${index}][0]`, 100),
      requiredText(stage[1], `result.stages[${index}][1]`, 500),
      requiredText(stage[2], `result.stages[${index}][2]`, 2000),
      finiteNumber(stage[3], `result.stages[${index}][3]`, 0),
    ]
  })
}

function normalizeWaterfall(value: unknown, vatRate: number): Array<[string, number, string]> {
  const expectedCount = vatRate > 0 ? 5 : 4
  if (!Array.isArray(value) || value.length !== expectedCount) {
    invalidPayload(`result.waterfall 在 vatR=${vatRate} 时必须包含 ${expectedCount} 项`)
  }
  return value.map((item, index) => {
    if (!Array.isArray(item) || item.length !== 3) {
      invalidPayload(`result.waterfall[${index}] 必须是长度为 3 的数组`)
    }
    const color = requiredText(item[2], `result.waterfall[${index}][2]`, 7)
    if (!HEX_COLOR_PATTERN.test(color)) {
      invalidPayload(`result.waterfall[${index}][2] 必须是六位 HEX 颜色`)
    }
    return [
      requiredText(item[0], `result.waterfall[${index}][0]`, 500),
      finiteNumber(item[1], `result.waterfall[${index}][1]`, 0),
      color.toLowerCase(),
    ]
  })
}

function sanitizeSourceText(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.origin}${url.pathname}`
    }
  } catch {
    // 普通来源文本不是 URL 时原样保存规范化后的内容。
  }
  return value
}

function sanitizeHttpUrl(value: string, field: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalidPayload(`${field} 必须是有效的 HTTP(S) URL`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    invalidPayload(`${field} 必须是有效的 HTTP(S) URL`)
  }
  return `${url.origin}${url.pathname}`
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") invalidPayload(`${field} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    invalidPayload(`${field} 不能为空且不能超过 ${maxLength} 个字符`)
  }
  return normalized
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") invalidPayload(`${field} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > maxLength) invalidPayload(`${field} 不能超过 ${maxLength} 个字符`)
  return normalized
}

function finiteNumber(value: unknown, field: string, min?: number, max?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidPayload(`${field} 必须是有限数字`)
  }
  if (min !== undefined && value < min) invalidPayload(`${field} 不能小于 ${min}`)
  if (max !== undefined && value > max) invalidPayload(`${field} 不能大于 ${max}`)
  return value
}

function integer(value: unknown, field: string, min?: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalidPayload(`${field} 必须是整数`)
  }
  if (min !== undefined && value < min) invalidPayload(`${field} 不能小于 ${min}`)
  return value
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalidPayload(`${field} 必须是布尔值`)
  return value
}

function nearlyEqual(left: number, right: number) {
  return Math.abs(left - right) <= NUMBER_EPSILON * Math.max(1, Math.abs(left), Math.abs(right))
}

function invalidPayload(message: string): never {
  throw new BadRequestException({ code: "INVALID_SMART_PRICING_RECORD", message })
}
