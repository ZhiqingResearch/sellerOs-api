import { createHash } from "node:crypto"

/**
 * 对 JSON 值生成稳定字符串：对象键排序，数组保持业务顺序。
 * 请求体来自 JSON parser，因此不接受 undefined、BigInt 或非有限数字。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null"

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON 数字必须是有限值")
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(",")}]`
  }

  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  }

  throw new TypeError("值不是合法 JSON")
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
