import { BadRequestException, PayloadTooLargeException } from "@nestjs/common"
import { isJsonObject } from "../common/utils/canonical-json"
import {
  ASIN_EVIDENCE_EVIDENCE_CARDS,
  ASIN_EVIDENCE_MAX_BYTES,
  ASIN_EVIDENCE_MAX_JSON_DEPTH,
} from "./asin-evidence-record.constants"
import { CreateAsinEvidenceRecordDto } from "./dto/create-asin-evidence-record.dto"

export interface AsinEvidenceValidationResult {
  /** evidence 的 UTF-8 JSON 字节数 */
  evidenceBytes: number
  /** dto.productTitle 缺省时从取证结果 A 卡提取的摘要，取不到为 null */
  productTitle: string | null
}

// 仅拦截完整页面或 DOM 快照字段，不误伤 Listing 描述中合法的 HTML 片段字段。
const DOM_SNAPSHOT_KEYS = new Set([
  "dom",
  "domhtml",
  "documenthtml",
  "innerhtml",
  "outerhtml",
  "pagedom",
  "pagehtml",
  "rawdom",
])

export function validateAsinEvidencePayload(
  dto: CreateAsinEvidenceRecordDto
): AsinEvidenceValidationResult {
  for (const card of ASIN_EVIDENCE_EVIDENCE_CARDS) {
    if (!isJsonObject(dto.evidence[card])) {
      invalidPayload(`evidence.${card} 必须是对象`)
    }
  }

  const evidenceBytes = jsonBytes(dto.evidence)
  if (evidenceBytes > ASIN_EVIDENCE_MAX_BYTES) {
    throw new PayloadTooLargeException({
      code: "ASIN_EVIDENCE_PAYLOAD_TOO_LARGE",
      message: "取证结果超过允许大小",
      details: { maxBytes: ASIN_EVIDENCE_MAX_BYTES, actualBytes: evidenceBytes },
    })
  }
  scanJson(dto.evidence, "evidence")

  return { evidenceBytes, productTitle: resolveProductTitle(dto) }
}

function resolveProductTitle(dto: CreateAsinEvidenceRecordDto): string | null {
  const provided = dto.productTitle?.trim()
  if (provided) return provided

  const cardA = dto.evidence.A
  if (!isJsonObject(cardA)) return null
  const title = cardA.title
  if (typeof title !== "string") return null
  const normalized = title.trim()
  if (!normalized) return null
  return normalized.slice(0, 1000)
}

function scanJson(root: unknown, rootPath: string) {
  // 使用显式栈遍历，避免异常深的用户 JSON 触发递归调用栈溢出。
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value: root, path: rootPath, depth: 0 },
  ]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > ASIN_EVIDENCE_MAX_JSON_DEPTH) {
      invalidPayload(`${current.path} 的 JSON 嵌套不能超过 ${ASIN_EVIDENCE_MAX_JSON_DEPTH} 层`)
    }
    if (typeof current.value === "string") {
      const normalized = current.value.trimStart().toLowerCase()
      if (normalized.startsWith("blob:") || normalized.startsWith("data:image/")) {
        invalidPayload(`${current.path} 不能保存 blob: 或 Base64 图片`)
      }
      continue
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((value, index) => {
        stack.push({ value, path: `${current.path}[${index}]`, depth: current.depth + 1 })
      })
      continue
    }
    if (!isJsonObject(current.value)) continue

    for (const [key, value] of Object.entries(current.value)) {
      if (DOM_SNAPSHOT_KEYS.has(key.toLowerCase())) {
        invalidPayload(`${current.path}.${key} 不能保存 DOM HTML 快照`)
      }
      stack.push({ value, path: `${current.path}.${key}`, depth: current.depth + 1 })
    }
  }
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function invalidPayload(message: string): never {
  throw new BadRequestException({ code: "INVALID_ASIN_EVIDENCE_PAYLOAD", message })
}
