import { BadRequestException, PayloadTooLargeException } from "@nestjs/common"
import { hashJson, isJsonObject } from "../common/utils/canonical-json"
import {
  COMPETITOR_ANALYSIS_ASIN_PATTERN,
  COMPETITOR_ANALYSIS_MARKETPLACES,
  COMPETITOR_ANALYSIS_MAX_BYTES,
  COMPETITOR_ANALYSIS_MAX_JSON_DEPTH,
  COMPETITOR_ANALYSIS_MAX_SOURCE_TEXT_LENGTH,
  COMPETITOR_ANALYSIS_MODES,
  COMPETITOR_ANALYSIS_SCHEMA_VERSION,
  CompetitorAnalysisMarketplace,
  CompetitorAnalysisModeValue,
} from "./competitor-analysis.constants"
import {
  CompetitorAnalysisInputDto,
  CreateCompetitorAnalysisRecordDto,
} from "./dto/create-competitor-analysis-record.dto"

const FORBIDDEN_SNAPSHOT_KEYS = new Set([
  "dom",
  "documenthtml",
  "innerhtml",
  "outerhtml",
  "pagehtml",
])

export interface NormalizedCompetitorAnalysisInput {
  mode: CompetitorAnalysisModeValue
  ownAsin: string | null
  competitorAsins: string[]
  keyword: string | null
  sourceText?: string
}

export interface NormalizedCompetitorAnalysisStep {
  stepCode: string
  stepNo: number
  schemaVersion: number
  resultData: Record<string, unknown>
  payloadHash: string
  payloadBytes: number
}

export interface NormalizedCompetitorAnalysisProduct {
  asin: string
  sortOrder: number
  productData: Record<string, unknown>
  steps: NormalizedCompetitorAnalysisStep[]
}

export interface CompetitorAnalysisValidationResult {
  schemaVersion: number
  marketplace: CompetitorAnalysisMarketplace
  input: NormalizedCompetitorAnalysisInput
  analysisResult: Record<string, unknown>
  products: NormalizedCompetitorAnalysisProduct[]
  reportData: Record<string, unknown>
  title: string
  productCount: number
  competitorCount: number
  payloadBytes: number
}

export function validateAndNormalizeCompetitorAnalysisRecord(
  dto: CreateCompetitorAnalysisRecordDto
): CompetitorAnalysisValidationResult {
  if (dto.schemaVersion !== COMPETITOR_ANALYSIS_SCHEMA_VERSION) {
    throw new BadRequestException({
      code: "UNSUPPORTED_COMPETITOR_RECORD_SCHEMA_VERSION",
      message: `当前仅支持 schemaVersion=${COMPETITOR_ANALYSIS_SCHEMA_VERSION}`,
    })
  }

  const marketplace = normalizeCompetitorAnalysisMarketplace(dto.marketplace)
  const input = normalizeInput(dto.input)
  const analysisResult = jsonObject(dto.analysisResult, "analysisResult")
  const products = normalizeProducts(dto.products)
  const reportData = jsonObject(dto.reportData, "reportData")
  const competitorCount = input.competitorAsins.length
  const title = buildTitle(input, competitorCount)

  const snapshot = {
    schemaVersion: dto.schemaVersion,
    marketplace,
    input,
    analysisResult,
    products,
    reportData,
    title,
    productCount: products.length,
    competitorCount,
  }
  scanJson(snapshot)

  const payloadBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8")
  if (payloadBytes > COMPETITOR_ANALYSIS_MAX_BYTES) {
    throw new PayloadTooLargeException({
      code: "COMPETITOR_RECORD_PAYLOAD_TOO_LARGE",
      message: "竞品分析记录超过允许大小",
      details: { maxBytes: COMPETITOR_ANALYSIS_MAX_BYTES, actualBytes: payloadBytes },
    })
  }

  return { ...snapshot, payloadBytes }
}

export function normalizeCompetitorAnalysisMarketplace(
  value: string
): CompetitorAnalysisMarketplace {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : ""
  if (!COMPETITOR_ANALYSIS_MARKETPLACES.includes(normalized as CompetitorAnalysisMarketplace)) {
    invalidPayload(`不支持的 marketplace: ${normalized || "空值"}`)
  }
  return normalized as CompetitorAnalysisMarketplace
}

function normalizeInput(input: CompetitorAnalysisInputDto): NormalizedCompetitorAnalysisInput {
  if (!isJsonObject(input)) invalidPayload("input 必须是对象")

  const modeText = requiredText(input.mode, "input.mode", 16).toUpperCase()
  if (!COMPETITOR_ANALYSIS_MODES.includes(modeText as CompetitorAnalysisModeValue)) {
    invalidPayload("input.mode 必须为 ASIN 或 KEYWORD")
  }
  const mode = modeText as CompetitorAnalysisModeValue
  const ownAsin = optionalAsin(input.ownAsin, "input.ownAsin")

  if (!Array.isArray(input.competitorAsins) || input.competitorAsins.length === 0) {
    invalidPayload("input.competitorAsins 至少需要 1 项")
  }
  if (input.competitorAsins.length > 20) {
    invalidPayload("input.competitorAsins 不能超过 20 项")
  }
  const competitorAsins = input.competitorAsins.map((asin, index) =>
    requiredAsin(asin, `input.competitorAsins[${index}]`)
  )
  ensureUnique(competitorAsins, "input.competitorAsins 不能重复")
  if (ownAsin && competitorAsins.includes(ownAsin)) {
    invalidPayload("input.ownAsin 不能同时出现在 input.competitorAsins 中")
  }

  const keyword = optionalText(input.keyword, "input.keyword", 500) ?? null
  if (mode === "KEYWORD" && !keyword) invalidPayload("KEYWORD 模式必须提供 input.keyword")
  if (mode === "ASIN" && keyword) invalidPayload("ASIN 模式下 input.keyword 必须为空")

  const sourceText = optionalText(
    input.sourceText,
    "input.sourceText",
    COMPETITOR_ANALYSIS_MAX_SOURCE_TEXT_LENGTH
  )

  return {
    mode,
    ownAsin,
    competitorAsins,
    keyword,
    ...(sourceText !== undefined && { sourceText }),
  }
}

function normalizeProducts(
  products: CreateCompetitorAnalysisRecordDto["products"]
): NormalizedCompetitorAnalysisProduct[] {
  if (!Array.isArray(products) || products.length === 0) {
    invalidPayload("products 至少需要 1 项")
  }

  const normalized = products.map((product, productIndex) => {
    if (!isJsonObject(product)) invalidPayload(`products[${productIndex}] 必须是对象`)
    const asin = requiredAsin(product.asin, `products[${productIndex}].asin`)
    const sortOrder = nonNegativeInteger(product.sortOrder, `products[${productIndex}].sortOrder`)
    const productData = jsonObject(product.productData, `products[${productIndex}].productData`)
    if (!Array.isArray(product.steps)) {
      invalidPayload(`products[${productIndex}].steps 必须是数组`)
    }

    const steps = product.steps.map((step, stepIndex) => {
      if (!isJsonObject(step)) {
        invalidPayload(`products[${productIndex}].steps[${stepIndex}] 必须是对象`)
      }
      const stepCode = requiredText(
        step.stepCode,
        `products[${productIndex}].steps[${stepIndex}].stepCode`,
        64
      )
      const stepNo = nonNegativeInteger(
        step.stepNo,
        `products[${productIndex}].steps[${stepIndex}].stepNo`
      )
      if (step.schemaVersion !== COMPETITOR_ANALYSIS_SCHEMA_VERSION) {
        invalidPayload(
          `products[${productIndex}].steps[${stepIndex}].schemaVersion 当前必须为 ${COMPETITOR_ANALYSIS_SCHEMA_VERSION}`
        )
      }
      const resultData = jsonObject(
        step.resultData,
        `products[${productIndex}].steps[${stepIndex}].resultData`
      )
      const payload = { schemaVersion: step.schemaVersion, resultData }
      return {
        stepCode,
        stepNo,
        schemaVersion: step.schemaVersion,
        resultData,
        payloadHash: hashJson(payload),
        payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
      }
    })

    ensureUnique(
      steps.map(step => step.stepCode.toLocaleLowerCase()),
      `products[${productIndex}].steps 的 stepCode 不能重复`
    )
    ensureUnique(
      steps.map(step => step.stepNo),
      `products[${productIndex}].steps 的 stepNo 不能重复`
    )
    return { asin, sortOrder, productData, steps: steps.sort((a, b) => a.stepNo - b.stepNo) }
  })

  ensureUnique(
    normalized.map(product => product.asin),
    "products 的 asin 不能重复"
  )
  ensureUnique(
    normalized.map(product => product.sortOrder),
    "products 的 sortOrder 不能重复"
  )
  return normalized.sort((a, b) => a.sortOrder - b.sortOrder)
}

function buildTitle(input: NormalizedCompetitorAnalysisInput, competitorCount: number) {
  const title = input.ownAsin
    ? `我方 ${input.ownAsin} vs ${competitorCount} 个竞品`
    : `${input.keyword || "竞品分析"} · ${competitorCount} 个竞品`
  return title.length <= 500 ? title : `${title.slice(0, 499)}…`
}

function requiredAsin(value: unknown, field: string) {
  const asin = requiredText(value, field, 32).toUpperCase()
  if (!COMPETITOR_ANALYSIS_ASIN_PATTERN.test(asin)) {
    invalidPayload(`${field} 需为 10 位字母数字`)
  }
  return asin
}

function optionalAsin(value: unknown, field: string) {
  const text = optionalText(value, field, 32)
  return text === undefined ? null : requiredAsin(text, field)
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string") invalidPayload(`${field} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized) invalidPayload(`${field} 不能为空`)
  if (normalized.length > maxLength) invalidPayload(`${field} 不能超过 ${maxLength} 个字符`)
  return normalized
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") invalidPayload(`${field} 必须是字符串或 null`)
  const normalized = value.trim()
  if (normalized.length > maxLength) invalidPayload(`${field} 不能超过 ${maxLength} 个字符`)
  return normalized || undefined
}

function nonNegativeInteger(value: unknown, field: string) {
  if (!Number.isInteger(value) || (value as number) < 0) {
    invalidPayload(`${field} 必须是非负整数`)
  }
  return value as number
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) invalidPayload(`${field} 必须是 JSON 对象，不能传 JSON 字符串`)
  return value
}

function ensureUnique(values: Array<string | number>, message: string) {
  if (new Set(values).size !== values.length) invalidPayload(message)
}

function scanJson(root: unknown) {
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value: root, path: "$", depth: 0 },
  ]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > COMPETITOR_ANALYSIS_MAX_JSON_DEPTH) {
      invalidPayload(`JSON 嵌套不能超过 ${COMPETITOR_ANALYSIS_MAX_JSON_DEPTH} 层`)
    }

    const value = current.value
    if (value === null || typeof value === "boolean") continue
    if (typeof value === "number") {
      if (!Number.isFinite(value)) invalidPayload(`${current.path} 包含非法数字`)
      continue
    }
    if (typeof value === "string") {
      const normalized = value.trimStart().toLowerCase()
      if (normalized.startsWith("blob:") || normalized.startsWith("data:")) {
        invalidPayload(`${current.path} 不能包含 Blob 或 Base64/Data URL`)
      }
      continue
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        stack.push({ value: item, path: `${current.path}[${index}]`, depth: current.depth + 1 })
      )
      continue
    }
    if (!isJsonObject(value)) invalidPayload(`${current.path} 不是合法 JSON 值`)
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.replace(/[-_\s]/g, "").toLowerCase()
      if (FORBIDDEN_SNAPSHOT_KEYS.has(normalizedKey)) {
        invalidPayload(`${current.path}.${key} 不允许保存 DOM/HTML 页面快照`)
      }
      stack.push({ value: item, path: `${current.path}.${key}`, depth: current.depth + 1 })
    }
  }
}

function invalidPayload(message: string): never {
  throw new BadRequestException({
    code: "INVALID_COMPETITOR_RECORD_PAYLOAD",
    message,
  })
}
