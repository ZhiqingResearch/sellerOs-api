import type { ChatCompletion } from "@zhiqingresearch/ai-ts-sdk"
import type { ToolboxTokenUsage } from "./dto/llm-toolbox.dto"

/**
 * 从非流式 completion 提取首个回复文本（等价前端 candidates[0].content.parts 全部 text 拼接）。
 * SDK 把 choices 类型化为 unknown[]，这里按 OpenAI 兼容形状防御式读取。
 */
export function completionRawText(completion: ChatCompletion): string {
  const choice = completion.choices?.[0] as { message?: { content?: unknown } } | undefined
  const content = choice?.message?.content
  return typeof content === "string" ? content : ""
}

/**
 * 提取 tokenUsage（P0 §1.2 四计数；usage 整体缺失时返回 null——调用方据此省略响应字段，
 * 不是回零值对象）。thinkingTokens 网关 OpenAI 兼容形状下取
 * completion_tokens_details.reasoning_tokens，字段不存在按 0。
 */
export function completionTokenUsage(completion: ChatCompletion): ToolboxTokenUsage | null {
  const usage = completion.usage
  if (!usage) return null
  const promptTokens = usage.prompt_tokens ?? 0
  const completionTokens = usage.completion_tokens ?? 0
  const details = (usage as { completion_tokens_details?: { reasoning_tokens?: number } })
    .completion_tokens_details
  const thinkingTokens = details?.reasoning_tokens ?? 0
  return {
    promptTokens,
    completionTokens,
    thinkingTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens + thinkingTokens,
  }
}
