import { BadGatewayException, Injectable } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Decimal } from "@prisma/client/runtime/library"
import { jsonrepair } from "jsonrepair"
import {
  AiGatewayProvider,
  type AiGatewayBillingUsage,
  type AiGatewayJsonOptions,
  type AiGatewayJsonResult,
  type AiGatewayStreamOptions,
  type AiGatewayTokenUsage,
} from "../providers/ai-gateway.provider"
import { DomesticBusinessModels } from "./domestic-business-models"
import { ContentModerationService } from "../../content-moderation/content-moderation.service"

/** 模块专用适配器，不替换全局 AiGatewayProvider。 */
@Injectable()
export class DomesticBusinessGateway extends AiGatewayProvider {
  constructor(
    config: ConfigService,
    private readonly models: DomesticBusinessModels,
    moderation: ContentModerationService,
  ) {
    super(config, moderation)
  }

  override async *streamChat(
    systemPrompt: string,
    userPrompt: string,
    options?: AiGatewayStreamOptions
  ) {
    await this.models.assertEnabled(options?.model)
    const isMiniMax = options?.model === "MiniMax-M3"
    const adapted = isMiniMax
      ? { ...options, temperature: 1, maxOutputTokens: undefined, responseFormat: undefined }
      : options
    const format = options?.responseFormat as { type?: string } | undefined
    const prompt =
      isMiniMax && format?.type === "json_object"
        ? `${systemPrompt}\n只输出一个完整 JSON 对象，不要输出 Markdown 或解释。`
        : systemPrompt
    yield* super.streamChat(prompt, userPrompt, adapted)
  }

  override async generateJson<T>(
    systemPrompt: string,
    userPrompt: string,
    options?: AiGatewayJsonOptions<T>
  ): Promise<AiGatewayJsonResult<T>> {
    await this.models.assertEnabled(options?.model)
    if (options?.model !== "MiniMax-M3")
      return super.generateJson(systemPrompt, userPrompt, options)

    // 公共 Provider 的纠错重试强制 temperature=0；MiniMax 所有尝试必须保持 1。
    // 复用流式调用、账单查询，只在此处适配 JSON 解析/重试并累计真实调用成本。
    const tokenUsage: AiGatewayTokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      thinkingTokens: 0,
    }
    const bills: AiGatewayBillingUsage[] = []
    const maxAttempts = options.maxAttempts ?? 2
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let content = ""
      let attemptUsage: AiGatewayTokenUsage | undefined
      const retryPrompt =
        attempt > 1
          ? `\n上次输出格式或字段不完整，请重新生成。${options.retryInstruction ?? ""}`
          : ""
      const prompt = `${systemPrompt}\n只输出一个完整 JSON 对象，不要输出 Markdown 或解释。${retryPrompt}`
      for await (const event of this.streamChat(prompt, userPrompt, options)) {
        if (event.type === "text") content += event.content
        if (event.type === "usage" && event.usage) {
          attemptUsage = event.usage
        }
        if (event.type === "billing" && event.billing) bills.push(event.billing)
      }
      if (attemptUsage) {
        tokenUsage.promptTokens += attemptUsage.promptTokens
        tokenUsage.completionTokens += attemptUsage.completionTokens
        tokenUsage.thinkingTokens += attemptUsage.thinkingTokens
      }
      let data: T
      try {
        data = this._parseDomesticJson<T>(content)
        if (options.isDataValid && !options.isDataValid(data)) {
          throw new BadGatewayException("AI 中转站返回的 JSON 结构不完整")
        }
      } catch (error) {
        if (attempt === maxAttempts) throw error
        continue
      }
      const billing = bills.length ? this._mergeDomesticBilling(bills) : undefined
      return {
        data,
        model: options.model,
        requestId: billing?.requestId ?? null,
        tokenUsage,
        ...(billing ? { billing } : {}),
      }
    }
    throw new BadGatewayException("AI 中转站未返回有效 JSON")
  }

  private _parseDomesticJson<T>(content: string): T {
    const trimmed = content.trim()
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    const candidates = [
      trimmed,
      trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],
      start >= 0 ? trimmed.slice(start, end > start ? end + 1 : undefined) : undefined,
    ]
    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        const value: unknown = JSON.parse(jsonrepair(candidate))
        if (value && typeof value === "object" && !Array.isArray(value)) return value as T
      } catch {
        // 继续尝试 JSON 正文。
      }
    }
    throw new BadGatewayException("AI 中转站返回的分析结果不是有效 JSON")
  }

  private _mergeDomesticBilling(bills: AiGatewayBillingUsage[]): AiGatewayBillingUsage {
    const requestIds = bills.flatMap(bill => bill.requestIds)
    return {
      ...bills[bills.length - 1],
      requestIds: [...new Set(requestIds)],
      costCny: bills.reduce((sum, bill) => sum.plus(bill.costCny), new Decimal(0)).toString(),
    }
  }
}
