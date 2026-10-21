export function extractJson(text: string): string | null {
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      if (inString) escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
import { jsonrepair } from "jsonrepair"

/**
 * 解析模型生成的 JSON，并容忍常见的格式瑕疵（未转义引号、换行、尾逗号等）。
 * 修复仍失败时保留原始 JSON.parse 异常，便于定位模型输出中的准确位置。
 */
export function parseLlmJson<T>(json: string): T {
  try {
    return JSON.parse(json) as T
  } catch (originalError) {
    try {
      return JSON.parse(jsonrepair(json)) as T
    } catch {
      throw originalError
    }
  }
}
