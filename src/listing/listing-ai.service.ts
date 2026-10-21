import { parseListingJsonObject } from "./listing-result-parser"
import { listingGenerationChargeId } from "../usage/fixed-module-credits"
import { BadGatewayException, BadRequestException, Injectable } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import {
  AiGatewayProvider,
  type AiGatewayBillingUsage,
  type AiGatewayStreamEvent,
  type AiGatewayTokenUsage,
} from "../common/providers/ai-gateway.provider"
import { UsageService } from "../usage/usage.service"
import { ListingAiInvocationDto, type ListingAiOperation } from "./dto/listing-ai.dto"
import { ListingRunService } from "./listing-run.service"
import { prepareListingScoreDelivery } from "./listing-score-delivery"
import { parseListingScoreSource } from "./listing-score-evidence"
import { buildListingImageSystemPrompt, prepareListingScoreImages } from "./listing-score-images"
import { buildListingScoreSystemPrompt } from "./listing-score-prompt"

const MODEL_CONFIG_KEYS: Record<ListingAiOperation, string> = {
  generation: "AI_GATEWAY_LISTING_MODEL",
  optimization: "AI_GATEWAY_LISTING_MODEL",
  long_title: "AI_GATEWAY_LISTING_ASSISTANT_MODEL",
  qa_rewrite: "AI_GATEWAY_LISTING_ASSISTANT_MODEL",
  score: "AI_GATEWAY_LISTING_SCORE_MODEL",
  category_match: "AI_GATEWAY_LISTING_ASSISTANT_MODEL",
  attribute_analysis: "AI_GATEWAY_LISTING_ASSISTANT_MODEL",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isValidAttributeAnalysisResponse(data: unknown): boolean {
  if (!isRecord(data) || !Array.isArray(data.questions) || data.questions.length === 0) {
    return false
  }

  return data.questions.every(question => {
    if (
      !isRecord(question) ||
      !isNonEmptyString(question.id) ||
      !isNonEmptyString(question.title) ||
      !isNonEmptyString(question.hint) ||
      question.multiSelect !== true ||
      !Array.isArray(question.options) ||
      question.options.length === 0
    ) {
      return false
    }

    return question.options.every(
      option =>
        isRecord(option) &&
        isNonEmptyString(option.emoji) &&
        isNonEmptyString(option.label) &&
        isNonEmptyString(option.value)
    )
  })
}

@Injectable()
export class ListingAiService {
  constructor(
    private readonly aiGatewayProvider: AiGatewayProvider,
    private readonly usageService: UsageService,
    private readonly listingRunService: ListingRunService
  ) {}

  async complete(userId: number, dto: ListingAiInvocationDto) {
    if (dto.responseFormat === "json_object") {
      await this.assertAffordable(userId, dto.operation)
      const step = await this.listingRunService.beginStep(userId, dto)
      try {
        const userContent = await this._prepareImages(dto)
        const isDataValid =
          dto.operation === "attribute_analysis" ? isValidAttributeAnalysisResponse : isRecord
        const result = await this.aiGatewayProvider.generateJson<Record<string, unknown>>(
          buildListingImageSystemPrompt(dto.operation === "score" ? buildListingScoreSystemPrompt(dto.systemPrompt, dto.userPrompt) : dto.systemPrompt ?? "", dto.images),
          dto.userPrompt,
          {
            model: dto.model,
            userContent,
            modelConfigKey: MODEL_CONFIG_KEYS[dto.operation],
            operationName: `Listing ${dto.operation}`,
            temperature: dto.temperature,
            maxOutputTokens: dto.maxOutputTokens,
            resolveBilling: true,
            maxAttempts: 1,
            isDataValid,
            retryInstruction:
              dto.operation === "attribute_analysis"
                ? "顶层对象必须包含 questions 数组；每项必须包含非空 id、title、hint、multiSelect=true，以及非空 options 数组。"
                : undefined,
          }
        )
        const resultText = dto.operation === "score"
          ? this._prepareScoreOutput(JSON.stringify(result.data), dto)
          : JSON.stringify(result.data)
        this._validateListingOutput(dto.operation, resultText, dto.listingMarket)
        const charge = (tx?: Prisma.TransactionClient) =>
          result.billing && (dto.operation !== "score" || typeof JSON.parse(resultText).total === "number")
            ? this.chargeSavedOutput(
                userId,
                dto.operation,
                result.billing,
                result.tokenUsage,
                tx,
                step?.historyId,
                step?.id,
                step?.runId
              )
            : Promise.resolve(null)
        if (step)
          await this.listingRunService.completeStep(
            step.id,
            resultText,
            result.billing?.requestId,
            result.billing?.model,
            charge
          )
        else await charge()
        return { text: resultText }
      } catch (error: unknown) {
        if (step) await this.listingRunService.failStep(step.id, error)
        throw error
      }
    }

    let text = ""

    for await (const event of this.stream(userId, dto)) {
      if (event.type === "text") text += event.content
    }

    return { text }
  }

  async *stream(userId: number, dto: ListingAiInvocationDto): AsyncGenerator<AiGatewayStreamEvent> {
    await this.assertAffordable(userId, dto.operation)
    const step = await this.listingRunService.beginStep(userId, dto)
    try {
      let outputText = ""
      let billing: AiGatewayBillingUsage | undefined
      const userContent = await this._prepareImages(dto)
      let tokenUsage: AiGatewayTokenUsage | undefined
      const gatewayStream = this.aiGatewayProvider.streamChat(
        buildListingImageSystemPrompt(dto.operation === "score" ? buildListingScoreSystemPrompt(dto.systemPrompt, dto.userPrompt) : dto.systemPrompt ?? "", dto.images),
        dto.userPrompt,
        {
          model: dto.model,
          userContent,
          modelConfigKey: MODEL_CONFIG_KEYS[dto.operation],
          operationName: `Listing ${dto.operation}`,
          temperature: dto.temperature,
          maxOutputTokens: dto.maxOutputTokens,
          resolveBilling: true,
        }
      )

      for await (const event of gatewayStream) {
        if (event.type === "usage" && event.usage) {
          tokenUsage = event.usage
          continue
        }
        if (event.type === "billing" && event.billing) {
          billing = event.billing
          continue
        }
        if (event.type === "text") outputText += event.content
        if (dto.operation === "score" && event.type === "text") continue
        yield event
      }
      if (!outputText.trim()) throw new BadGatewayException("模型未返回正文，本步骤未扣费，请重试")
      if (dto.operation === "score") outputText = this._prepareScoreOutput(outputText, dto)
      this._validateListingOutput(dto.operation, outputText, dto.listingMarket)
      const charge = (tx?: Prisma.TransactionClient) =>
        billing && (dto.operation !== "score" || typeof JSON.parse(outputText).total === "number")
          ? this.chargeSavedOutput(
              userId,
              dto.operation,
              billing,
              tokenUsage,
              tx,
              step?.historyId,
              step?.id,
              step?.runId
            )
          : Promise.resolve(null)
      if (step)
        await this.listingRunService.completeStep(
          step.id,
          outputText,
          billing?.requestId,
          billing?.model,
          charge
        )
      else await charge()
      if (dto.operation === "score") yield { type: "text", content: outputText }
    } catch (error: unknown) {
      if (step) await this.listingRunService.failStep(step.id, error)
      throw error
    }
  }

  private _prepareScoreOutput(text: string, dto: ListingAiInvocationDto): string {
    const deliveryText = prepareListingScoreDelivery(text, dto.scoreMarket ?? dto.listingMarket ?? "amazon_us", {
      sourceFacts: parseListingScoreSource(dto.userPrompt),
      ...(dto.images?.some(image => image.role === "main")
        ? { confirmedSecondaryCount: dto.images.filter(image => image.role === "secondary").length } : {}),
    })
    if (!deliveryText) throw new BadGatewayException("AI 未返回评分内容，本次评分未扣费")
    return deliveryText
  }

  private _validateListingOutput(operation: ListingAiOperation, text: string, market?: string) {
    if (operation !== "generation" && operation !== "optimization") return
    let result: Record<string, unknown>
    try { result = parseListingJsonObject(text) }
    catch { throw new BadGatewayException("生成结果不完整，本次未扣积分") }
    const hasDescription = isNonEmptyString(result.description) || isNonEmptyString(result.shortDescription) ||
      (isRecord(result.descriptionSections) && Object.values(result.descriptionSections).some(value =>
        Array.isArray(value) && value.some(item => isNonEmptyString(item) ||
          (isRecord(item) && isNonEmptyString(item.name) && isNonEmptyString(item.value))))) ||
      (Array.isArray(result.modules) && result.modules.length > 0)
    if (!isNonEmptyString(result.title) || !hasDescription)
      throw new BadGatewayException("生成结果缺少标题或描述，本次未扣积分")
    if (market) {
      const fields = market.startsWith("amazon_") ? ["bullets"]
        : market === "walmart_us" ? ["keyFeatures", "productAttributes"]
        : market === "ebay_us" ? ["itemSpecifics"]
        : market === "ozon_ru" ? ["highlights", "characteristics", "hashtags"]
        : market === "wildberries_ru" ? ["highlights", "characteristics"]
        : market.startsWith("tiktok_") ? ["productHighlights", "modules"] : []
      if (!fields.length || fields.some(field => !Array.isArray(result[field]) || !(result[field] as unknown[]).length))
        throw new BadGatewayException("生成结果缺少平台必需内容，本次未扣积分")
      if (market === "ebay_us" && (!isRecord(result.keywords) ||
        !Object.values(result.keywords).some(value => Array.isArray(value) && value.some(isNonEmptyString))))
        throw new BadGatewayException("生成结果缺少关键词，本次未扣积分")
    }
  }

  async assertAffordable(userId: number, operation: ListingAiOperation, generationBillingId?: string) {
    // 长标题和问答是已预检业务的附属步骤，不按生成售价再次拦截优化用户。
    if (operation === "long_title" || operation === "qa_rewrite") return
    return this.usageService.assertFixedModuleAffordable(
      userId, operation === "score" ? "listing.score" : "listing.generate", operation, generationBillingId
    )
  }

  private async _prepareImages(dto: ListingAiInvocationDto) {
    if (dto.images?.length && dto.operation !== "score") {
      throw new BadRequestException("图片输入仅用于 Listing 评分")
    }
    if (dto.images?.length && dto.model === "ZQ-Think-Lite") {
      throw new BadRequestException("ZQ-Think-Lite 不支持图片评分，请选择 Flash 或 Pro")
    }
    return prepareListingScoreImages(dto.userPrompt, dto.images)
  }

  async chargeSavedOutput(
    userId: number,
    operation: ListingAiOperation,
    billing: AiGatewayBillingUsage,
    tokenUsage?: AiGatewayTokenUsage,
    tx?: Prisma.TransactionClient,
    historyId?: number,
    stepId?: number,
    businessEventId?: string,
    generationBillingId?: string
  ): Promise<number | null> {
    // 准备步骤包含在生成售价中；后台自动评分不调用此独立结算入口。
    if (!["generation", "optimization", "score"].includes(operation))
      return null
    const source = operation === "score" ? "listing.score" : "listing.generate"
    const params = {
      model: billing.model,
      requestId: operation === "generation" && generationBillingId
        ? listingGenerationChargeId(userId, generationBillingId)
        : billing.requestId,
      meta: {
        operation,
        ...(businessEventId ? { businessEventId } : {}),
        ...(historyId ? { listingHistoryId: historyId, listingStepId: stepId } : {}),
        actualCostCny: billing.costCny,
        gatewayRequestIds: billing.requestIds,
        ...(tokenUsage ? { tokenUsage } : {}),
      },
    }
    const result = await this.usageService.chargeFixedModule(userId, source, params, tx)
    // 不修改公共计费内核；在同一事务里关联刚写入的台账，避免费用双份存储。
    // 幂等命中的账单已归属首次调用，本次步骤不重复计入消费。
    if (result.duplicate || !tx || !stepId) return null
    const log = await tx.usageLog.findFirst({
      where: {
        userId,
        requestId: params.requestId,
        source,
        meta: { path: "$.listingStepId", equals: stepId },
      },
      select: { id: true },
    })
    if (!log) throw new BadGatewayException("扣费记录关联失败，本步骤事务已回滚")
    return log.id
  }
}
