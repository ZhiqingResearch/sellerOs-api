import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Decimal } from "@prisma/client/runtime/library"
import {
  AiGatewayClient,
  GatewayApiError,
  GatewayConnectionError,
  GatewayResponseValidationError,
  GatewayStreamTruncatedError,
  GatewayTimeoutError,
  normalizeBaseURL,
  type ChatCompletionChunk,
  type ChatStreamRequest,
} from "@zhiqingresearch/ai-ts-sdk"
import { jsonrepair } from "jsonrepair"
import { ContentModerationService } from "../../content-moderation/content-moderation.service"

const BILLING_POLL_DELAYS_MS = [0, 100, 250, 500, 1_000]
const DEFAULT_AI_GATEWAY_TIMEOUT_MS = 300_000

export interface AiGatewayTokenUsage {
  promptTokens: number
  completionTokens: number
  thinkingTokens: number
}

export interface AiGatewayJsonResult<T> {
  data: T
  model: string
  requestId: string | null
  tokenUsage: AiGatewayTokenUsage
  billing?: AiGatewayBillingUsage
}

export interface AiGatewayBillingUsage {
  costCny: string
  currency: "CNY"
  model: string
  requestId: string
  requestIds: string[]
}

export interface AiGatewayJsonOptions<T> {
  /** Listing 禁止格式纠错再次请求模型；其他业务保持原默认行为。 */
  maxAttempts?: 1 | 2
  isDataValid?: (data: T) => boolean
  retryInstruction?: string
  /** 仅在业务明确需要时设置；省略则由模型和中转站自行结束。 */
  maxOutputTokens?: number
  /** 后端业务指定的模型环境变量名；禁止直接接收前端模型名。 */
  modelConfigKey?: string
  /** 业务模型未配置时使用的安全默认模型。 */
  defaultModel?: string
  /** 仅允许业务服务在完成白名单校验后传入逻辑模型 ID。 */
  model?: string
  temperature?: number
  operationName?: string
  /** 多模态业务可传 OpenAI-compatible content parts；仅允许后端服务构造。 */
  userContent?: unknown
  /** 成功后按 X-Request-Id 查询中转站最终人民币账单。 */
  resolveBilling?: boolean
}

export interface AiGatewayStreamOptions {
  /** 仅接受后端业务构造并校验过的多模态消息。 */
  userContent?: unknown
  modelConfigKey?: string
  defaultModel?: string
  /** 仅允许业务服务在完成白名单校验后传入逻辑模型 ID。 */
  model?: string
  temperature?: number
  maxOutputTokens?: number
  operationName?: string
  /** 成功后按 X-Request-Id 查询中转站最终人民币账单。 */
  resolveBilling?: boolean
  /** OpenAI 兼容 response_format 透传（如 {type:"json_object"}）；仅支持 JSON mode 的模型传，省略不发。 */
  responseFormat?: unknown
}

export interface AiGatewayStreamEvent {
  type: "thinking" | "text" | "usage" | "billing"
  content: string
  usage?: AiGatewayTokenUsage & { totalTokens: number }
  /** usage 事件附带的网关原始 usage 对象（分模态输入量等扩展字段由业务自行映射，缺省不出现）。 */
  rawUsage?: unknown
  billing?: AiGatewayBillingUsage
}

@Injectable()
export class AiGatewayProvider {
  private readonly logger = new Logger(AiGatewayProvider.name)

  constructor(private readonly config: ConfigService, private readonly moderation: ContentModerationService) {}

  async generateJson<T>(
    systemPrompt: string,
    userPrompt: string,
    options?: AiGatewayJsonOptions<T>
  ): Promise<AiGatewayJsonResult<T>> {
    const moderatedContent = await this.moderation.assertContent(options?.userContent ?? userPrompt, "userContent")
    const apiKey = this.config.get<string>("AI_GATEWAY_API_KEY")?.trim()
    const baseUrl = this.config.get<string>(
      "AI_GATEWAY_BASE_URL",
      "https://ai-gateway-api-dev.zhilingtech.com/v1"
    )
    const model = options?.model?.trim() || options?.defaultModel?.trim() || "ZQ-Think-Flash"
    const isDebugLoggingEnabled =
      this.config.get<string>("AI_GATEWAY_DEBUG_LOGGING", "false").trim().toLowerCase() === "true"

    if (!apiKey) throw new ServiceUnavailableException("AI Gateway 未配置")

    const timeoutMs = DEFAULT_AI_GATEWAY_TIMEOUT_MS
    const requestedMaxOutputTokens = options?.maxOutputTokens
    const maxOutputTokens =
      Number.isSafeInteger(requestedMaxOutputTokens) && Number(requestedMaxOutputTokens) > 0
        ? requestedMaxOutputTokens
        : null
    const temperature =
      typeof options?.temperature === "number" && Number.isFinite(options.temperature)
        ? Math.min(2, Math.max(0, options.temperature))
        : 0.2
    const operationName = options?.operationName?.trim() || "AI JSON 生成"
    const requestBody: ChatStreamRequest = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: moderatedContent },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature,
      ...(maxOutputTokens === null ? {} : { max_output_tokens: maxOutputTokens }),
    }
    const normalizedBaseUrl = normalizeBaseURL(baseUrl)
    const requestUrl = `${normalizedBaseUrl}/chat/completions`
    const requestIds: string[] = []
    const gateway = this._createGateway(
      normalizedBaseUrl,
      apiKey,
      timeoutMs,
      options?.resolveBilling === true ? requestIds : null
    )
    const startedAt = Date.now()

    if (isDebugLoggingEnabled) {
      this.logger.debug(
        `AI Gateway SDK 请求 model=${model}`
      )
    }

    try {
      let tokenUsage: AiGatewayTokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        thinkingTokens: 0,
      }
      const maxAttempts = options?.maxAttempts ?? 2
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let content = ""
        let chunkCount = 0
        let reasoningCharacters = 0
        const finishReasons = new Set<string>()
        let attemptTokenUsage: AiGatewayTokenUsage = {
          promptTokens: 0,
          completionTokens: 0,
          thinkingTokens: 0,
        }
        const attemptRequestBody: ChatStreamRequest =
          attempt === 1
            ? requestBody
            : {
                ...requestBody,
                messages: [
                  {
                    role: "system",
                    content: `${systemPrompt}\n\n这是格式纠错重试：必须只输出一个可由 JSON.parse 直接解析的完整 JSON 对象。不要输出解释、Markdown 代码块、注释或省略号。${options?.retryInstruction ? `\n${options.retryInstruction}` : ""}`,
                  },
                  { role: "user", content: moderatedContent },
                ],
                temperature: 0,
              }

        for await (const chunk of gateway.chat.stream(attemptRequestBody)) {
          chunkCount += 1
          content += this._extractDeltaContent(chunk)
          reasoningCharacters += this._extractReasoningContent(chunk).length
          const finishReason = this._extractFinishReason(chunk)
          if (finishReason) finishReasons.add(finishReason)
          if (chunk.usage) attemptTokenUsage = this._extractTokenUsage(chunk)
        }
        tokenUsage = this._addTokenUsage(tokenUsage, attemptTokenUsage)
        content = content.trim()

        if (isDebugLoggingEnabled) {
          this.logger.debug(
            `AI Gateway SDK 流式响应完成\nurl=${requestUrl}\nattempt=${attempt}\nrequestId=${requestIds.at(-1) ?? "-"}\nbody=${this._formatDebugValue({ content, usage: attemptTokenUsage })}`
          )
        }

        if (!content) {
          this.logger.error(
            `AI Gateway 流式响应正文为空 sdk=true model=${model} attempt=${attempt} chunks=${chunkCount} reasoningCharacters=${reasoningCharacters} finishReasons=${[...finishReasons].join(",") || "-"} promptTokens=${attemptTokenUsage.promptTokens} completionTokens=${attemptTokenUsage.completionTokens} thinkingTokens=${attemptTokenUsage.thinkingTokens}`
          )
          if (attempt < maxAttempts) continue
          throw new BadGatewayException("AI Gateway 未返回分析内容")
        }

        let data: T
        try {
          data = this._parseJson<T>(content)
        } catch (error: unknown) {
          this.logger.warn(
            `AI Gateway JSON 解析失败 sdk=true model=${model} attempt=${attempt} contentCharacters=${content.length} chunks=${chunkCount} reasoningCharacters=${reasoningCharacters} finishReasons=${[...finishReasons].join(",") || "-"}`
          )
          if (attempt === maxAttempts) throw error
          continue
        }

        const isDataValid = options?.isDataValid?.(data) ?? true
        if (!isDataValid) {
          this.logger.warn(
            `AI Gateway JSON 结构校验失败 sdk=true model=${model} attempt=${attempt}`
          )
          if (attempt < maxAttempts) continue
          throw new BadGatewayException("AI 中转站返回的 JSON 结构不完整")
        }
        const billing = options?.resolveBilling
          ? await this._resolveBilling(gateway, requestIds, model)
          : undefined
        const requestId = billing?.requestId ?? requestIds.at(-1) ?? null
        this.logger.log(
          `${operationName}完成 sdk=true model=${model} attempt=${attempt} structureValid=${isDataValid} maxOutputTokens=${maxOutputTokens ?? "unset"} promptTokens=${tokenUsage.promptTokens} completionTokens=${tokenUsage.completionTokens} thinkingTokens=${tokenUsage.thinkingTokens} durationMs=${Date.now() - startedAt} requestId=${requestId ?? "-"}`
        )
        return {
          data,
          model,
          requestId,
          tokenUsage,
          ...(billing ? { billing } : {}),
        }
      }

      throw new BadGatewayException("AI Gateway 返回的分析结果不是有效 JSON")
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error

      if (error instanceof GatewayApiError) {
        this._logSdkError(model, startedAt, error)
        if (isDebugLoggingEnabled) {
          this.logger.debug(
            `AI Gateway SDK 错误响应\nurl=${requestUrl}\nstatus=${error.status}\nrequestId=${error.requestId ?? "-"}\nbody=${this._formatDebugValue(
              {
                error: {
                  message: error.message,
                  type: error.type,
                  code: error.code,
                },
              }
            )}`
          )
        }
        if (error.status === 429) {
          const retryAfterSeconds =
            error.retryAfterMs === null ? null : Math.ceil(error.retryAfterMs / 1000)
          throw new HttpException(
            retryAfterSeconds === null
              ? "AI Gateway 繁忙，请稍后重试"
              : `AI Gateway 繁忙，请在 ${retryAfterSeconds} 秒后重试`,
            429
          )
        }
        if (error.status === 401 || error.status === 403) {
          throw new ServiceUnavailableException("AI Gateway 鉴权失败，请联系管理员")
        }
        if (error.status === 404) throw new ServiceUnavailableException("AI Gateway 模型不可用")
        if (error.status >= 500) {
          throw new BadGatewayException(`AI Gateway 内部异常（HTTP ${error.status}），请稍后重试`)
        }
        throw new BadGatewayException(`AI Gateway 调用失败：${error.message}`)
      }

      if (error instanceof GatewayTimeoutError) {
        this.logger.error(
          `AI Gateway 响应超时 sdk=true model=${model} timeoutMs=${timeoutMs} durationMs=${Date.now() - startedAt}`
        )
        throw new BadGatewayException(`AI Gateway 响应超时（${timeoutMs}ms），请稍后重试`)
      }

      if (error instanceof GatewayStreamTruncatedError) {
        this.logger.error(
          `AI Gateway 流式响应中断 sdk=true model=${model} durationMs=${Date.now() - startedAt} requestId=${error.requestId ?? "-"}`
        )
        throw new BadGatewayException("AI Gateway 响应中断，请稍后重试")
      }

      if (error instanceof GatewayConnectionError) {
        this.logger.error(
          `AI Gateway 连接失败 sdk=true model=${model} durationMs=${Date.now() - startedAt} message=${error.message}`
        )
        throw new BadGatewayException("无法连接 AI Gateway，请稍后重试")
      }

      if (error instanceof GatewayResponseValidationError) {
        this.logger.error(
          `AI Gateway 响应格式异常 sdk=true model=${model} durationMs=${Date.now() - startedAt} message=${error.message}`
        )
        throw new BadGatewayException("AI Gateway 返回内容格式异常")
      }

      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`AI Gateway 调用失败 sdk=true model=${model} message=${message}`)
      throw new BadGatewayException("AI Gateway 调用失败，请稍后重试")
    }
  }

  async *streamChat(
    systemPrompt: string,
    userPrompt: string,
    options?: AiGatewayStreamOptions
  ): AsyncGenerator<AiGatewayStreamEvent> {
    const moderatedContent = await this.moderation.assertContent(options?.userContent ?? userPrompt, "userContent")
    const apiKey = this.config.get<string>("AI_GATEWAY_API_KEY")?.trim()
    const baseUrl = this.config.get<string>(
      "AI_GATEWAY_BASE_URL",
      "https://ai-gateway-api-dev.zhilingtech.com/v1"
    )
    const modelConfigKey = options?.modelConfigKey ?? "AI_GATEWAY_LISTING_MODEL"
    const model =
      options?.model?.trim() ||
      this.config.get<string>(modelConfigKey)?.trim() ||
      options?.defaultModel?.trim() ||
      "ZQ-Think-Flash"
    const timeoutMs = DEFAULT_AI_GATEWAY_TIMEOUT_MS
    const requestedMaxOutputTokens = options?.maxOutputTokens
    const maxOutputTokens =
      Number.isSafeInteger(requestedMaxOutputTokens) && Number(requestedMaxOutputTokens) > 0
        ? requestedMaxOutputTokens
        : null
    const temperature =
      typeof options?.temperature === "number" && Number.isFinite(options.temperature)
        ? Math.min(2, Math.max(0, options.temperature))
        : 0.8

    if (!apiKey) throw new ServiceUnavailableException("AI Gateway 未配置")

    const requestIds: string[] = []
    const gateway = this._createGateway(
      normalizeBaseURL(baseUrl),
      apiKey,
      timeoutMs,
      options?.resolveBilling === true ? requestIds : null
    )
    const requestBody: ChatStreamRequest = {
      model,
      messages: [
        ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
        { role: "user", content: moderatedContent },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature,
      ...(maxOutputTokens === null ? {} : { max_output_tokens: maxOutputTokens }),
      ...(options?.responseFormat === undefined ? {} : { response_format: options.responseFormat }),
    }
    const startedAt = Date.now()

    try {
      for await (const chunk of gateway.chat.stream(requestBody)) {
        const reasoningContent = this._extractReasoningContent(chunk)
        if (reasoningContent) yield { type: "thinking", content: reasoningContent }

        const content = this._extractDeltaContent(chunk)
        if (content) yield { type: "text", content }

        if (chunk.usage) {
          const usage = this._extractTokenUsage(chunk)
          yield {
            type: "usage",
            content: "",
            usage: {
              ...usage,
              totalTokens: usage.promptTokens + usage.completionTokens + usage.thinkingTokens,
            },
            rawUsage: chunk.usage,
          }
        }
      }
      if (options?.resolveBilling) {
        const billing = await this._resolveBilling(gateway, requestIds, model)
        yield { type: "billing", content: "", billing }
      }
      this.logger.log(
        `${options?.operationName?.trim() || "AI 流式生成"}完成 sdk=true model=${model} durationMs=${Date.now() - startedAt}`
      )
    } catch (error: unknown) {
      if (error instanceof GatewayApiError) {
        this._logSdkError(model, startedAt, error)
        if (error.status === 429) throw new HttpException("AI Gateway 繁忙，请稍后重试", 429)
        if (error.status === 401 || error.status === 403) {
          throw new ServiceUnavailableException("AI Gateway 鉴权失败，请联系管理员")
        }
        if (error.status === 404) throw new ServiceUnavailableException("AI Gateway 模型不可用")
        throw new BadGatewayException(`AI Gateway 调用失败（HTTP ${error.status}）`)
      }
      if (error instanceof GatewayTimeoutError) {
        this.logger.error(
          `AI Gateway 流式响应超时 sdk=true model=${model} timeoutMs=${timeoutMs} durationMs=${Date.now() - startedAt}`
        )
        throw new BadGatewayException(`AI Gateway 响应超时（${timeoutMs}ms），请稍后重试`)
      }
      if (error instanceof GatewayStreamTruncatedError) {
        throw new BadGatewayException("AI Gateway 响应中断，请稍后重试")
      }
      if (error instanceof GatewayConnectionError) {
        throw new BadGatewayException("无法连接 AI Gateway，请稍后重试")
      }
      if (error instanceof GatewayResponseValidationError) {
        throw new BadGatewayException("AI Gateway 返回内容格式异常")
      }
      if (error instanceof HttpException) throw error
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`AI Gateway 流式调用失败 sdk=true model=${model} message=${message}`)
      throw new BadGatewayException("AI Gateway 调用失败，请稍后重试")
    }
  }

  private _createGateway(
    baseUrl: string,
    apiKey: string,
    timeoutMs: number,
    requestIds: string[] | null
  ): AiGatewayClient {
    if (!requestIds) return new AiGatewayClient({ baseURL: baseUrl, apiKey, timeoutMs })

    const gatewayFetch: typeof fetch = async (input, init) => {
      const response = await globalThis.fetch(input, init)
      const method = (
        init?.method ??
        (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")
      ).toUpperCase()
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url

      if (method === "POST" && url.endsWith("/chat/completions")) {
        const requestId = response.headers.get("x-request-id")?.trim()
        if (requestId && !requestIds.includes(requestId)) requestIds.push(requestId)
      }
      return response
    }

    return new AiGatewayClient({ baseURL: baseUrl, apiKey, timeoutMs, fetch: gatewayFetch })
  }

  private async _resolveBilling(
    gateway: AiGatewayClient,
    requestIds: string[],
    fallbackModel: string
  ): Promise<AiGatewayBillingUsage> {
    const distinctRequestIds = [...new Set(requestIds)]
    if (distinctRequestIds.length === 0) {
      throw new BadGatewayException("AI Gateway 未返回计费请求标识，无法完成积分结算")
    }

    const records = new Map<string, { amount: Decimal; model: string; currency: string }>()

    for (const delayMs of BILLING_POLL_DELAYS_MS) {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))

      for (const requestId of distinctRequestIds) {
        if (records.has(requestId)) continue
        const page = await gateway.usage.list({ requestId, take: 10 })
        const record = page.data.find(
          item => item.request_id === requestId && item.amount !== null && !item.estimated
        )
        if (!record?.amount) continue
        if (record.currency.toUpperCase() !== "CNY") {
          throw new BadGatewayException(`AI Gateway 计费币种异常：${record.currency || "UNKNOWN"}`)
        }

        let amount: Decimal
        try {
          amount = new Decimal(record.amount)
        } catch {
          throw new BadGatewayException("AI Gateway 返回的计费金额无效")
        }
        if (amount.isNegative()) throw new BadGatewayException("AI Gateway 返回的计费金额无效")
        records.set(requestId, {
          amount,
          model: record.model?.trim() || fallbackModel,
          currency: record.currency,
        })
      }

      if (records.size === distinctRequestIds.length) break
    }

    if (records.size !== distinctRequestIds.length) {
      const unresolved = distinctRequestIds.filter(requestId => !records.has(requestId))
      this.logger.error(`AI Gateway 计费结果未就绪 requestIds=${unresolved.join(",")}`)
      throw new BadGatewayException("AI Gateway 计费结果暂未就绪，无法完成积分结算")
    }

    const costCny = distinctRequestIds.reduce(
      (total, requestId) => total.add(records.get(requestId)?.amount ?? 0),
      new Decimal(0)
    )
    const firstRecord = records.get(distinctRequestIds[0])

    return {
      costCny: costCny.toString(),
      currency: "CNY",
      model: firstRecord?.model ?? fallbackModel,
      requestId: distinctRequestIds[0],
      requestIds: distinctRequestIds,
    }
  }

  private _extractDeltaContent(chunk: ChatCompletionChunk): string {
    const choice = chunk.choices?.[0]
    if (!choice || typeof choice !== "object") return ""
    const delta = (choice as { delta?: unknown }).delta
    if (!delta || typeof delta !== "object") return ""
    const content = (delta as { content?: unknown }).content
    return typeof content === "string" ? content : ""
  }

  private _extractReasoningContent(chunk: ChatCompletionChunk): string {
    const choice = chunk.choices?.[0]
    if (!choice || typeof choice !== "object") return ""
    const delta = (choice as { delta?: unknown }).delta
    if (!delta || typeof delta !== "object") return ""
    const reasoningContent = (delta as { reasoning_content?: unknown }).reasoning_content
    return typeof reasoningContent === "string" ? reasoningContent : ""
  }

  private _extractFinishReason(chunk: ChatCompletionChunk): string | null {
    const choice = chunk.choices?.[0]
    if (!choice || typeof choice !== "object") return null
    const finishReason = (choice as { finish_reason?: unknown }).finish_reason
    return typeof finishReason === "string" && finishReason ? finishReason : null
  }

  private _extractTokenUsage(chunk: ChatCompletionChunk): AiGatewayTokenUsage {
    const usage = chunk.usage
    const completionDetails = this._objectValue(usage?.completion_tokens_details)
    return {
      promptTokens: this._numberValue(usage?.prompt_tokens),
      completionTokens: this._numberValue(usage?.completion_tokens),
      thinkingTokens: this._numberValue(completionDetails?.reasoning_tokens),
    }
  }

  private _parseJson<T>(content: string): T {
    const candidates = this._jsonCandidates(content)
    for (const candidate of candidates) {
      try {
        return this._assertJsonObject<T>(JSON.parse(candidate))
      } catch {
        try {
          return this._assertJsonObject<T>(JSON.parse(jsonrepair(candidate)))
        } catch {
          // 继续尝试下一个候选 JSON 主体。
        }
      }
    }
    throw new BadGatewayException("AI Gateway 返回的分析结果不是有效 JSON")
  }

  private _assertJsonObject<T>(value: unknown): T {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("AI Gateway JSON 顶层必须是对象")
    }
    return value as T
  }

  private _jsonCandidates(content: string): string[] {
    const trimmed = content.trim()
    const withoutOuterFence = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim()
    const fencedBody = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
    const objectStart = withoutOuterFence.indexOf("{")
    const objectEnd = withoutOuterFence.lastIndexOf("}")
    const objectBody =
      objectStart >= 0 && objectEnd > objectStart
        ? withoutOuterFence.slice(objectStart, objectEnd + 1)
        : objectStart >= 0
          ? withoutOuterFence.slice(objectStart)
          : null

    return [...new Set([withoutOuterFence, fencedBody, objectBody].filter(Boolean) as string[])]
  }

  private _addTokenUsage(
    total: AiGatewayTokenUsage,
    current: AiGatewayTokenUsage
  ): AiGatewayTokenUsage {
    return {
      promptTokens: total.promptTokens + current.promptTokens,
      completionTokens: total.completionTokens + current.completionTokens,
      thinkingTokens: total.thinkingTokens + current.thinkingTokens,
    }
  }

  private _logSdkError(model: string, startedAt: number, error: GatewayApiError): void {
    this.logger.error(
      `AI Gateway 调用失败 sdk=true model=${model} status=${error.status} durationMs=${Date.now() - startedAt} requestId=${error.requestId ?? "-"} errorType=${error.type ?? "-"} errorCode=${error.code ?? "-"} message=${error.message}`
    )
  }

  private _objectValue(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null
  }

  private _numberValue(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0
  }

  private _formatDebugValue(value: unknown): string {
    if (value === undefined) return "undefined"
    try {
      return JSON.stringify(value, null, 2)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "未知序列化错误"
      return `[无法序列化调试内容：${message}]`
    }
  }
}
