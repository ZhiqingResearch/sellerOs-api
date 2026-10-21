import { BadRequestException, PayloadTooLargeException } from "@nestjs/common"
import { extractAdScore } from "../../asin-audit/rules/ad-score"
import { isJsonObject } from "../../common/utils/canonical-json"
import {
  ASIN_AUDIT_CREATE_MAX_BYTES,
  ASIN_AUDIT_DIMENSION_COUNT,
  ASIN_AUDIT_EVIDENCE_CARDS,
  ASIN_AUDIT_MAX_JSON_DEPTH,
  ASIN_AUDIT_OPTIMIZATION_MAX_BYTES,
  ASIN_AUDIT_SCHEMA_VERSION,
} from "./asin-audit-record.constants"
import { CreateAsinAuditRecordDto } from "./dto/create-asin-audit-record.dto"
import { UpdateAsinAuditRecordDto } from "./dto/update-asin-audit-record.dto"

export interface AsinAuditScoreSummary {
  overallScore: number
  grade: string
  contentScore: number
  trafficScore: number
  adScore: number | null
}

export interface CreateAsinAuditValidationResult {
  score: AsinAuditScoreSummary
  snapshotPayloadBytes: number
}

export interface OptimizationValidationResult {
  payloadBytes: number
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

export function validateCreateAsinAuditPayload(
  dto: CreateAsinAuditRecordDto
): CreateAsinAuditValidationResult {
  assertSchemaVersion(dto.schemaVersion)
  const requestBytes = jsonBytes(dto)
  assertPayloadSize(requestBytes, ASIN_AUDIT_CREATE_MAX_BYTES, "创建记录")

  for (const card of ASIN_AUDIT_EVIDENCE_CARDS) {
    if (!isJsonObject(dto.evidence[card])) {
      invalidPayload(`evidence.${card} 必须是对象`)
    }
  }
  scanJson(dto.evidence, "evidence")
  validateAplusImages(dto.evidence.A as Record<string, unknown>)

  const score = validateScoreResult(dto.scoreResult, dto.adIncluded)
  scanJson(dto.scoreResult, "scoreResult")

  return {
    score,
    snapshotPayloadBytes: jsonBytes({
      schemaVersion: dto.schemaVersion,
      evidence: dto.evidence,
      scoreResult: dto.scoreResult,
    }),
  }
}

export function validateOptimizationPayload(
  dto: UpdateAsinAuditRecordDto
): OptimizationValidationResult {
  assertSchemaVersion(dto.schemaVersion)
  if (Object.keys(dto.optimizationResult).length === 0) {
    invalidPayload("optimizationResult 不能为空对象")
  }
  const payloadBytes = jsonBytes(dto.optimizationResult)
  assertPayloadSize(payloadBytes, ASIN_AUDIT_OPTIMIZATION_MAX_BYTES, "优化结果")
  scanJson(dto.optimizationResult, "optimizationResult")
  return { payloadBytes }
}

function validateScoreResult(
  scoreResult: Record<string, unknown>,
  adIncluded: boolean
): AsinAuditScoreSummary {
  // v2.0 十板块结果（score 接口现行形状，含 boards）走 v2 分支；旧 v1 形状（dimensions）保持原校验
  if (Array.isArray(scoreResult.boards)) {
    return validateScoreResultV2(scoreResult, adIncluded)
  }

  const overallScore = score(scoreResult.overallScore, "scoreResult.overallScore")
  const contentScore = score(scoreResult.contentScore, "scoreResult.contentScore")
  const trafficScore = score(scoreResult.trafficScore, "scoreResult.trafficScore")

  if (typeof scoreResult.grade !== "string") {
    invalidPayload("scoreResult.grade 必须是字符串")
  }
  const grade = scoreResult.grade.trim()
  if (!grade || grade.length > 16) {
    invalidPayload("scoreResult.grade 不能为空且不能超过 16 个字符")
  }

  let adScore: number | null
  if (!adIncluded) {
    if (scoreResult.adScore !== null) {
      invalidPayload("未包含广告数据时 scoreResult.adScore 必须为 null")
    }
    adScore = null
  } else {
    adScore = score(scoreResult.adScore, "scoreResult.adScore")
  }

  if (!Array.isArray(scoreResult.dimensions)) {
    invalidPayload("scoreResult.dimensions 必须是数组")
  }
  if (scoreResult.dimensions.length !== ASIN_AUDIT_DIMENSION_COUNT) {
    invalidPayload(`scoreResult.dimensions 必须包含 ${ASIN_AUDIT_DIMENSION_COUNT} 个维度`)
  }
  scoreResult.dimensions.forEach((dimension, index) => {
    if (!isJsonObject(dimension)) {
      invalidPayload(`scoreResult.dimensions[${index}] 必须是对象`)
    }
    if (!Array.isArray(dimension.criteria) || dimension.criteria.length === 0) {
      invalidPayload(`scoreResult.dimensions[${index}].criteria 必须是非空数组`)
    }
  })

  if (!isJsonObject(scoreResult.problemTypes)) {
    invalidPayload("scoreResult.problemTypes 必须是对象")
  }
  if (!Array.isArray(scoreResult.recommendations)) {
    invalidPayload("scoreResult.recommendations 必须是数组")
  }

  return { overallScore, grade, contentScore, trafficScore, adScore }
}

/**
 * v2.0 十板块打分结果（score 接口现行输出，前端原样回传归档）：
 * - 结构校验只卡归档必需项：恰好 10 个板块、每板块 items 非空；
 * - 摘要分来自 score 接口服务端附带的兼容字段（overallScore/contentScore/trafficScore），
 *   缺失时从 total / domainScores 兜底（total=null 是合法态：覆盖率不足不出总分）；
 * - 广告分缺失时从 adDiagnostics 确定性提取（与 finalizeScoreResult 同一提取器）。
 */
function validateScoreResultV2(
  scoreResult: Record<string, unknown>,
  adIncluded: boolean
): AsinAuditScoreSummary {
  if (!Array.isArray(scoreResult.boards)) {
    invalidPayload("scoreResult.boards 必须是数组")
  }
  if (scoreResult.boards.length !== ASIN_AUDIT_DIMENSION_COUNT) {
    invalidPayload(`scoreResult.boards 必须包含 ${ASIN_AUDIT_DIMENSION_COUNT} 个板块`)
  }
  scoreResult.boards.forEach((board, index) => {
    if (!isJsonObject(board)) {
      invalidPayload(`scoreResult.boards[${index}] 必须是对象`)
    }
    if (!Array.isArray(board.items) || board.items.length === 0) {
      invalidPayload(`scoreResult.boards[${index}].items 必须是非空数组`)
    }
  })

  const gradeRaw = scoreResult.gradeLabel ?? scoreResult.grade
  if (typeof gradeRaw !== "string") {
    invalidPayload("scoreResult.gradeLabel 必须是字符串")
  }
  const grade = gradeRaw.trim()
  if (!grade || grade.length > 16) {
    invalidPayload("scoreResult.gradeLabel 不能为空且不能超过 16 个字符")
  }

  const scoring = isJsonObject(scoreResult.scoring) ? scoreResult.scoring : {}
  const domains = isJsonObject(scoreResult.domainScores) ? scoreResult.domainScores : {}
  const overallScore = score(
    scoreResult.overallScore ?? scoreResult.total ?? scoring.convertedScore ?? 0,
    "scoreResult.overallScore"
  )
  const contentScore = score(
    scoreResult.contentScore ?? domains.content ?? 0,
    "scoreResult.contentScore"
  )
  const trafficScore = score(
    scoreResult.trafficScore ?? domains.operations ?? 0,
    "scoreResult.trafficScore"
  )

  let adScore: number | null
  if (!adIncluded) {
    if (scoreResult.adScore != null) {
      invalidPayload("未包含广告数据时 scoreResult.adScore 必须为空")
    }
    adScore = null
  } else {
    const rawAdScore = scoreResult.adScore ?? extractAdScore(scoreResult.adDiagnostics)
    if (rawAdScore == null) {
      invalidPayload("已包含广告数据，但 scoreResult.adScore 与 adDiagnostics 均未提供有效广告分")
    }
    adScore = score(rawAdScore, "scoreResult.adScore")
  }

  return { overallScore, grade, contentScore, trafficScore, adScore }
}

function validateAplusImages(cardA: Record<string, unknown>) {
  if (cardA.aplusImages === undefined) return
  if (!Array.isArray(cardA.aplusImages)) {
    invalidPayload("evidence.A.aplusImages 必须是数组")
  }
  if (cardA.aplusImages.length > 200) {
    invalidPayload("evidence.A.aplusImages 不能超过 200 张")
  }
  cardA.aplusImages.forEach((value, index) => {
    if (typeof value !== "string" || value.length > 2048) {
      invalidPayload(`evidence.A.aplusImages[${index}] 必须是有效的 HTTPS URL`)
    }
    let url: URL
    try {
      url = new URL(value)
    } catch {
      invalidPayload(`evidence.A.aplusImages[${index}] 必须是有效的 HTTPS URL`)
    }
    if (url.protocol !== "https:") {
      invalidPayload(`evidence.A.aplusImages[${index}] 必须使用 HTTPS URL`)
    }
  })
}

function scanJson(root: unknown, rootPath: string) {
  // 使用显式栈遍历，避免异常深的用户 JSON 触发递归调用栈溢出。
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value: root, path: rootPath, depth: 0 },
  ]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > ASIN_AUDIT_MAX_JSON_DEPTH) {
      invalidPayload(`${current.path} 的 JSON 嵌套不能超过 ${ASIN_AUDIT_MAX_JSON_DEPTH} 层`)
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

function score(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    invalidPayload(`${field} 必须是 0 到 100 之间的数字`)
  }
  return value
}

function assertSchemaVersion(value: number) {
  if (value !== ASIN_AUDIT_SCHEMA_VERSION) {
    throw new BadRequestException({
      code: "UNSUPPORTED_AUDIT_SCHEMA_VERSION",
      message: `当前仅支持 schemaVersion=${ASIN_AUDIT_SCHEMA_VERSION}`,
    })
  }
}

function assertPayloadSize(actualBytes: number, maxBytes: number, label: string) {
  if (actualBytes <= maxBytes) return
  throw new PayloadTooLargeException({
    code: "AUDIT_RECORD_PAYLOAD_TOO_LARGE",
    message: `${label}超过允许大小`,
    details: { maxBytes, actualBytes },
  })
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function invalidPayload(message: string): never {
  throw new BadRequestException({ code: "INVALID_AUDIT_RECORD_PAYLOAD", message })
}
