import { jsonrepair } from "jsonrepair"
const parseLlmJson = <T>(text: string): T => JSON.parse(jsonrepair(text)) as T

/**
 * Listing 专用的本地格式修复。只处理已有且容器闭合的 JSON，
 * 不让 jsonrepair 将被截断的正文补成一个看似成功的报告；不调用模型。
 */
export function parseListingJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{")
  if (start < 0) throw new Error("模型未返回 Listing 结构化内容，原始响应已保留")
  const stack: string[] = []
  let quote: string | null = null
  let isEscaped = false
  let isLineComment = false
  let isBlockComment = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    const next = text[index + 1]
    if (isLineComment) {
      if (char === "\n" || char === "\r") isLineComment = false
      continue
    }
    if (isBlockComment) {
      if (char === "*" && next === "/") {
        isBlockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (isEscaped) isEscaped = false
      else if (char === "\\") isEscaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    } else if (char === "/" && next === "/") {
      isLineComment = true
      index++
    } else if (char === "/" && next === "*") {
      isBlockComment = true
      index++
    } else if (char === "{" || char === "[") {
      stack.push(char)
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) break
      if (stack.length === 0) {
        const parsed = parseLlmJson<unknown>(text.slice(start, index + 1))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Listing 响应不是有效的对象")
        }
        return parsed as Record<string, unknown>
      }
    }
  }
  throw new Error("Listing 响应不完整，未自动补写内容或重新请求 AI，原始响应已保留")
}
