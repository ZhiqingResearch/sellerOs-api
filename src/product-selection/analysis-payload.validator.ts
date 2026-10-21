import { BadRequestException, PayloadTooLargeException } from "@nestjs/common"
import { isJsonObject } from "./canonical-json"
import {
  MAX_ASIN_COUNT,
  MAX_KEYWORD_COUNT,
  MAX_PICK_COUNT,
  MAX_RESULT_COUNT,
  STEP_PAYLOAD_MAX_BYTES,
} from "./product-selection.constants"

export interface StepPayloadValidationResult {
  payloadBytes: number
  pickCount: number
}

export function validateProductPayload(
  payload: Record<string, unknown>
): StepPayloadValidationResult {
  const payloadBytes = validatePayloadSize(payload)
  assertHttpUrl(payload.pdfUrl, "pdfUrl")
  assertNonEmptyObject(payload.productData, "productData")
  return { payloadBytes, pickCount: 1 }
}

export function validateStepPayload(
  stepNo: number,
  payload: Record<string, unknown>,
  requestedPickCount?: number
): StepPayloadValidationResult {
  const payloadBytes = validatePayloadSize(payload)

  let pickCount = 0
  switch (stepNo) {
    case 1:
      assertObjectArray(payload.diagnosis, "diagnosis")
      break
    case 2:
      assertObjectArray(payload.oppResults, "oppResults")
      assertUniqueStrings(payload.selectedKeywords, "selectedKeywords", MAX_KEYWORD_COUNT, 500)
      break
    case 3:
      assertObjectArray(payload.compResults, "compResults")
      assertAsinMap(payload.selectedAsinsByKeyword)
      break
    case 4:
      assertNonEmptyObject(payload.anaResult, "anaResult")
      break
    case 5:
      assertNonEmptyObject(payload.reportData, "reportData")
      if (requestedPickCount === undefined) {
        invalidPayload("第5步必须提供 pickCount")
      }
      if (!Number.isInteger(requestedPickCount) || requestedPickCount < 0) {
        invalidPayload("pickCount 必须是非负整数")
      }
      if (requestedPickCount > MAX_PICK_COUNT) {
        invalidPayload(`pickCount 不能超过 ${MAX_PICK_COUNT}`)
      }
      validateRecognizedReportCount(payload.reportData, requestedPickCount)
      pickCount = requestedPickCount
      break
    default:
      invalidPayload("步骤编号无效")
  }

  return { payloadBytes, pickCount }
}

function validatePayloadSize(payload: Record<string, unknown>) {
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8")
  if (payloadBytes > STEP_PAYLOAD_MAX_BYTES) {
    throw new PayloadTooLargeException({
      code: "ANALYSIS_PAYLOAD_TOO_LARGE",
      message: "当前步骤数据超过 4 MiB，请减少关键词或竞品数量",
      details: { maxBytes: STEP_PAYLOAD_MAX_BYTES, actualBytes: payloadBytes },
    })
  }
  return payloadBytes
}

function assertHttpUrl(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    invalidPayload(`${field} 必须是有效的 HTTP(S) URL`)
  }
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      invalidPayload(`${field} 必须是有效的 HTTP(S) URL`)
    }
  } catch {
    invalidPayload(`${field} 必须是有效的 HTTP(S) URL`)
  }
}

function assertObjectArray(value: unknown, field: string) {
  if (!Array.isArray(value)) invalidPayload(`${field} 必须是数组`)
  if (value.length > MAX_RESULT_COUNT) {
    invalidPayload(`${field} 不能超过 ${MAX_RESULT_COUNT} 条`)
  }
  if (value.some(item => !isJsonObject(item))) {
    invalidPayload(`${field} 的每一项都必须是对象`)
  }
}

function assertUniqueStrings(value: unknown, field: string, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) invalidPayload(`${field} 必须是数组`)
  if (value.length > maxItems) invalidPayload(`${field} 不能超过 ${maxItems} 项`)

  const normalized = value.map(item => {
    if (typeof item !== "string") invalidPayload(`${field} 的每一项都必须是字符串`)
    const result = item.trim()
    if (!result || result.length > maxLength) {
      invalidPayload(`${field} 包含空值或长度超过 ${maxLength} 的字符串`)
    }
    return result.toLocaleLowerCase()
  })
  if (new Set(normalized).size !== normalized.length) invalidPayload(`${field} 不能包含重复项`)
}

function assertAsinMap(value: unknown) {
  if (!isJsonObject(value)) invalidPayload("selectedAsinsByKeyword 必须是对象")

  const entries = Object.entries(value)
  if (entries.length > MAX_KEYWORD_COUNT) {
    invalidPayload(`selectedAsinsByKeyword 不能超过 ${MAX_KEYWORD_COUNT} 个关键词`)
  }

  let asinCount = 0
  for (const [keyword, asins] of entries) {
    if (!keyword.trim() || keyword.length > 500) {
      invalidPayload("selectedAsinsByKeyword 包含无效关键词")
    }
    if (!Array.isArray(asins)) invalidPayload(`关键词 ${keyword} 的 ASIN 必须是数组`)
    const normalized = asins.map(asin => {
      if (typeof asin !== "string" || !/^[A-Z0-9]{10}$/i.test(asin.trim())) {
        invalidPayload(`关键词 ${keyword} 包含无效 ASIN`)
      }
      return asin.trim().toUpperCase()
    })
    if (new Set(normalized).size !== normalized.length) {
      invalidPayload(`关键词 ${keyword} 包含重复 ASIN`)
    }
    asinCount += normalized.length
  }
  if (asinCount > MAX_ASIN_COUNT) {
    invalidPayload(`selectedAsinsByKeyword 的 ASIN 总数不能超过 ${MAX_ASIN_COUNT}`)
  }
}

function assertNonEmptyObject(value: unknown, field: string) {
  if (!isJsonObject(value) || Object.keys(value).length === 0) {
    invalidPayload(`${field} 必须是非空对象`)
  }
}

/**
 * 前端 SelectionReportData 尚未在本仓库共享类型。若命中约定数组字段则交叉校验；
 * 未命中时仍以经过范围校验的 pickCount 为摘要，避免臆测业务结构。
 */
function validateRecognizedReportCount(reportData: unknown, pickCount: number) {
  if (!isJsonObject(reportData)) return
  const candidates = ["items", "products", "selectedProducts", "productList"]
  const matched = candidates.find(key => Array.isArray(reportData[key]))
  if (matched && (reportData[matched] as unknown[]).length !== pickCount) {
    invalidPayload(`pickCount 与 reportData.${matched} 数量不一致`)
  }
}

function invalidPayload(message: string): never {
  throw new BadRequestException({ code: "INVALID_STEP_PAYLOAD", message })
}
