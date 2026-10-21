import { BadGatewayException } from "@nestjs/common"
import { parseListingJsonObject } from "./listing-result-parser"
import { validateListingScoreOutput } from "./listing-score-validation"

import { isCdqScoreReport } from "./listing-cdq-score"

const AMAZON_LIMITS = [
  { name: /CDQ/i, maxScore: 40, criteria: [12, 10, 8, 6, 2, 2] },
  { name: /关键词/, maxScore: 25, criteria: [7, 7, 5, 4, 2] },
  { name: /COSMO/i, maxScore: 20, criteria: [10, 6, 4] },
  { name: /Alexa/i, maxScore: 15, criteria: [7, 5, 3] },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function fail(): never {
  throw new BadGatewayException("评分报告不完整，原始结果已保存，本次未扣费")
}

/** 核心评分必须已经完整，不能靠修复模型补造分数或扣分依据。 */
export function validateScoreCore(value: Record<string, unknown>, market?: string): void {
  validateListingScoreOutput(JSON.stringify(value))
  if (isCdqScoreReport(value)) return
  const dimensions = value.dimensions as Record<string, unknown>[]
  for (const dimension of dimensions) {
    if (
      typeof dimension.name !== "string" ||
      !dimension.name.trim() ||
      !Number.isFinite(dimension.score) ||
      !Number.isFinite(dimension.maxScore) ||
      Number(dimension.maxScore) <= 0 ||
      Number(dimension.score) < 0 ||
      Number(dimension.score) > Number(dimension.maxScore)
    )
      fail()
    for (const criterion of dimension.criteria as Record<string, unknown>[]) {
      if (typeof criterion.name !== "string" || !criterion.name.trim()) fail()
    }
  }
  if (
    market?.startsWith("amazon_") ||
    dimensions.some(dimension => /CDQ/i.test(String(dimension.name)))
  ) {
    if (dimensions.length !== AMAZON_LIMITS.length) fail()
    dimensions.forEach((dimension, index) => {
      const limit = AMAZON_LIMITS[index]
      const criteria = dimension.criteria as Record<string, unknown>[]
      if (
        !limit.name.test(String(dimension.name)) ||
        dimension.maxScore !== limit.maxScore ||
        criteria.length !== limit.criteria.length ||
        criteria.some(
          (criterion, criterionIndex) => criterion.maxScore !== limit.criteria[criterionIndex]
        )
      )
        fail()
    })
  }
}

export function validateScoreReport(text: string, market?: string): string {
  const result = parseListingJsonObject(text)
  validateScoreCore(result, market)
  if (
    !Array.isArray(result.suggestions) ||
    result.suggestions.some(value => typeof value !== "string") ||
    typeof result.potential !== "string" ||
    !result.potential.trim()
  )
    fail()
  return validateListingScoreOutput(JSON.stringify(result))
}

/** 只截取顶层已经完整结束的字段；绝不补写截断的评分项。 */
export function extractScoreRecoveryCore(text: string, market?: string): Record<string, unknown> {
  try {
    const complete = parseListingJsonObject(text)
    validateScoreCore(complete, market)
    return complete
  } catch {
    /* 继续寻找已完整结束的顶层字段。 */
  }
  const start = text.indexOf("{")
  if (start < 0) return fail()
  const stack: string[] = []
  let isInString = false
  let isEscaped = false
  let boundary = -1
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (isInString) {
      if (isEscaped) isEscaped = false
      else if (char === "\\") isEscaped = true
      else if (char === '"') isInString = false
      continue
    }
    if (char === '"') isInString = true
    else if (char === "{" || char === "[") stack.push(char)
    else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) return fail()
    } else if (char === "," && stack.length === 1) boundary = index
  }
  if (boundary < 0) return fail()
  let core: Record<string, unknown>
  try {
    core = JSON.parse(text.slice(start, boundary) + "}") as Record<string, unknown>
  } catch {
    return fail()
  }
  validateScoreCore(core, market)
  return core
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value)
}

export function validateRecoveredScore(
  text: string,
  core: Record<string, unknown>,
  market?: string
): string {
  const result = parseListingJsonObject(text)
  // 已完成字段原样保留，连模型的文字依据也不允许在修复时重写。
  if (Object.keys(core).some(key => canonical(core[key]) !== canonical(result[key]))) {
    throw new BadGatewayException("评分修复改变了原始评分，结果已保留，本次未扣费")
  }
  if (
    Object.keys(result).some(
      key => !Object.hasOwn(core, key) && !["suggestions", "potential"].includes(key)
    )
  ) {
    throw new BadGatewayException("评分修复新增了未经确认的字段，结果已保留，本次未扣费")
  }
  return validateScoreReport(text, market)
}

/** 修复模型只补缺失尾部；已有核心由服务端合并，避免模型转抄时改写。 */
export function mergeScoreRepair(
  text: string,
  core: Record<string, unknown>,
  market?: string
): string {
  const patch = parseListingJsonObject(text)
  return validateRecoveredScore(JSON.stringify({ ...core, ...patch }), core, market)
}
