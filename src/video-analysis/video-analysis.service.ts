import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import { jsonrepair } from "jsonrepair"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { CreditService } from "../membership/credit.service"
import { CREDIT_PER_CNY } from "../membership/membership.constants"
import { UsageService } from "../usage/usage.service"
import { VideoAnalysisDto } from "./dto/video-analysis.dto"
import { VideoAnalysisRecordService } from "./video-analysis-record.service"
import {
  VIDEO_ANALYSIS_CATEGORY,
  VideoAnalysisModel,
  isVideoPayloadMissing,
  resolveVideoMimeType,
} from "./video-analysis.models"
import { VideoAnalysisResult, normalizeVideoAnalysisResult } from "./video-analysis.normalize"
import {
  VIDEO_ANALYSIS_PROMPT_VERSION,
  buildVideoAnalysisUserPrompt,
  buildVideoContentParts,
} from "./video-analysis.prompts"

/** SSE 事件判别联合（P0 §5.3/§5.4，字段名逐字段冻结） */
export type VideoAnalysisSseEvent =
  | { type: "progress"; stage: "analyzing" | "parsing"; message: string }
  | {
      type: "usage"
      usage: {
        promptTokens: number
        completionTokens: number
        thinkingTokens: number
        totalTokens: number
      }
    }
  | {
      type: "usage_detail"
      videoInputTokens: number
      audioInputTokens: number
      textInputTokens: number
    }
  | {
      type: "charge"
      ok: true
      creditsCharged: string
      balance: string
      costCny: string
      breakdown: { bucket: string; amount: string }[]
      duplicate?: boolean
    }
  | { type: "charge"; ok: false; message: string }
  | { type: "result"; data: VideoAnalysisResult; model: string; recordId: string }

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, thinkingTokens: 0, totalTokens: 0 }

/**
 * 视频分析编排（P0 §5）：预检 → 流式网关调用（事件透传/收集）
 * → usage/usage_detail → 扣费（charge 事件）→ parsing progress → 归一化 result。
 * 模型/一口价/能力开关由 VideoAnalysisModels 从 AiGatewayModel.VIDEO_ANALYSIS 解析后传入
 * （controller 进流前 assertRequest 完成，白名单违规走 HTTP 400）。
 * 扣费失败降级：charge 事件 {ok:false, message}，result 照常下发。
 */
@Injectable()
export class VideoAnalysisService {
  private readonly logger = new Logger(VideoAnalysisService.name)

  constructor(
    private readonly gateway: AiGatewayProvider,
    private readonly usage: UsageService,
    private readonly records: VideoAnalysisRecordService,
    private readonly credit: CreditService
  ) {}

  async *stream(
    dto: VideoAnalysisDto,
    userId: number,
    model: VideoAnalysisModel
  ): AsyncGenerator<VideoAnalysisSseEvent> {
    let replay: Awaited<ReturnType<VideoAnalysisRecordService["findReplay"]>>
    try {
      replay = await this.records.findReplay(userId, dto, model.publicId)
    } catch (error) {
      if (error instanceof HttpException) throw error
      this.logger.error(`视频分析记录读取失败：userId=${userId}`, error)
      throw new ServiceUnavailableException("视频分析记录暂时无法读取，请稍后重试")
    }
    if (replay) {
      // 已保存报告直接重放，不再次调用模型或扣费；余额不足也可恢复首次结果。
      yield { type: "progress", stage: "analyzing", message: "正在读取已保存的分析结果" }
      yield { type: "usage", usage: replay.usage }
      yield { type: "usage_detail", ...replay.usageDetail }
      yield replay.charge.ok ? { ...replay.charge, duplicate: true } : replay.charge
      yield { type: "progress", stage: "parsing", message: "正在读取已保存的分析结果" }
      yield { type: "result", data: replay.result, model: replay.model, recordId: replay.recordId }
      return
    }
    if (model.fixedCredits)
      await this.usage.assertExactCreditsAffordable(userId, model.fixedCredits)

    yield { type: "progress", stage: "analyzing", message: "模型正在理解视频" }

    const mimeType = resolveVideoMimeType(dto.videoUrl, dto.mimeType)
    const userPrompt = buildVideoAnalysisUserPrompt({
      duration: dto.duration,
      focus: dto.focus,
      supportsAudio: model.supportsAudio,
    })
    const content = [
      ...buildVideoContentParts({
        videoUrl: dto.videoUrl,
        mimeType,
        sendsMimeType: model.sendsMimeType,
      }),
      { type: "text", text: userPrompt },
    ]

    let fullText = ""
    let sawDelta = false
    let tokenUsage: typeof ZERO_USAGE | null = null
    let rawUsage: unknown = null
    let gatewayAmount: string | undefined
    for await (const event of this.gateway.streamChat("", userPrompt, {
      model: model.publicId,
      userContent: content,
      temperature: 0.3,
      maxOutputTokens: 16384,
      // 仅支持 JSON mode 的模型发 response_format，不支持还发会 400（P0 §5.5）
      responseFormat: model.supportsJsonMode ? { type: "json_object" } : undefined,
      operationName: "视频分析",
      resolveBilling: true,
    })) {
      if (event.type === "text") {
        if (!sawDelta) {
          sawDelta = true
          // 仅当流式产出过增量才发的第二个 progress（P0 §5.3）
          yield { type: "progress", stage: "analyzing", message: "模型正在生成分析结果" }
        }
        fullText += event.content
      } else if (event.type === "usage") {
        if (event.usage) tokenUsage = event.usage
        rawUsage = event.rawUsage ?? null
      } else if (event.type === "billing") {
        gatewayAmount = event.billing?.costCny ?? gatewayAmount
      }
    }

    // 「模型没收到视频」守卫：仅 promptTokensIncludeVideo 模型启用（P0 §5.5 附）
    const usage = tokenUsage ?? ZERO_USAGE
    if (isVideoPayloadMissing(model, usage.promptTokens, dto.duration)) {
      this.logger.warn(
        `[video-analysis] 守卫触发：模型未接收到视频 model=${model.publicId} promptTokens=${usage.promptTokens} duration=${dto.duration}`
      )
      throw new BadGatewayException("模型未能接收到视频内容，请稍后重试或更换模型")
    }

    // usage 必发（解析失败也发，钱已花，P0 §5.3）；usage_detail 独立事件
    yield { type: "usage", usage }
    const usageDetail = mapUsageDetail(rawUsage)
    yield { type: "usage_detail", ...usageDetail }

    // 扣费：幂等键 = 前端 chargeRequestId（UsageLog.requestId @unique 防重试双扣）；
    // 失败降级 → charge {ok:false, message}，不阻断 result（P0 §5.7）
    let chargeEvent: Extract<VideoAnalysisSseEvent, { type: "charge" }>
    try {
      const fixedCredits = model.fixedCredits
      let costCny: string
      let pricingMeta: Record<string, unknown>
      if (fixedCredits) {
        costCny = fixedCredits.div(CREDIT_PER_CNY).toString()
        pricingMeta = { pricingMode: "fixed", fixedCredits: fixedCredits.toString() }
      } else {
        if (gatewayAmount === undefined)
          throw new Error("AI Gateway 计费结果暂未就绪，无法完成积分结算")
        const amount = new Decimal(gatewayAmount)
        if (!amount.isFinite() || amount.lessThan(0))
          throw new Error("AI Gateway 返回的计费金额无效")
        const multiplier = await this.usage.gatewayPriceMultiplier(
          model.publicId,
          VIDEO_ANALYSIS_CATEGORY
        )
        costCny = amount.mul(multiplier).toString()
        pricingMeta = {
          pricingMode: "metered",
          gatewayAmountCny: amount.toString(),
          priceMultiplier: multiplier.toString(),
        }
      }
      if (new Decimal(costCny).isZero()) {
        chargeEvent = {
          type: "charge",
          ok: true,
          creditsCharged: "0",
          costCny: "0",
          breakdown: [],
          balance: (await this.credit.getConsumableBalanceRouted(userId)).toString(),
        }
      } else {
        const result = await this.usage.chargeModel(userId, costCny, {
          source: "video.analysis",
          model: model.publicId,
          ...(fixedCredits ? { exactCredits: fixedCredits.toString() } : {}),
          requestId: `charge:${dto.chargeRequestId}`,
          allowOverdraft: true,
          meta: {
            ...pricingMeta,
            promptVersion: VIDEO_ANALYSIS_PROMPT_VERSION,
            totalTokens: usage.totalTokens,
            videoUrl: dto.videoUrl,
            ...(gatewayAmount !== undefined ? { gatewayAmount } : {}),
          },
        })
        chargeEvent = {
          type: "charge",
          ok: true,
          creditsCharged: result.creditsCharged.toString(),
          balance: result.balance.toString(),
          costCny: result.costCny.toString(),
          breakdown: result.breakdown.map(item => ({ bucket: item.bucket, amount: item.amount })),
          ...(result.duplicate ? { duplicate: true } : {}),
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "扣费失败，本次未扣费"
      this.logger.error(
        `[video-analysis] 扣费失败（降级放行）：chargeRequestId=${dto.chargeRequestId} message=${message}`
      )
      chargeEvent = { type: "charge", ok: false, message }
    }
    yield chargeEvent

    yield { type: "progress", stage: "parsing", message: "正在整理分析结果" }

    const parsed = parseAnalysisJson(fullText)
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.logger.error(
        `[video-analysis] 结果 JSON 解析失败 model=${model.publicId} textLength=${fullText.length}`
      )
      throw new BadGatewayException("AI 未返回有效的视频分析结果，请稍后重试")
    }
    const data = normalizeVideoAnalysisResult(parsed, dto.duration, model.supportsAudio)

    // 先落库再返回 result，客户端断开仍保存（controller 会继续消费生成器）。
    let record: Awaited<ReturnType<VideoAnalysisRecordService["save"]>>
    try {
      record = await this.records.save(userId, dto, model.publicId, {
        result: data,
        usage,
        usageDetail,
        charge: chargeEvent,
      })
    } catch (error) {
      if (error instanceof HttpException) throw error
      this.logger.error(`视频分析结果保存失败：userId=${userId}`, error)
      throw new ServiceUnavailableException("视频分析结果保存失败，请使用原 chargeRequestId 重试")
    }
    // 并发重试返回首次保存的结果，与历史详情保持一致。
    yield { type: "result", data: record.result, model: record.model, recordId: record.recordId }
  }
}

/** 结果 JSON 解析：直解 → jsonrepair 兜底 */
function parseAnalysisJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    try {
      return JSON.parse(jsonrepair(trimmed))
    } catch {
      return null
    }
  }
}

/**
 * usage_detail 映射：网关 OpenAI 兼容 usage 的分模态输入量（P0 §5.4）。
 * 字段名联调时对一次实际响应校准；取不到一律 0。
 */
function mapUsageDetail(rawUsage: unknown): {
  videoInputTokens: number
  audioInputTokens: number
  textInputTokens: number
} {
  const usage = (rawUsage ?? {}) as Record<string, unknown>
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>
  const pick = (...keys: string[]): number => {
    for (const key of keys) {
      const value = details[key] ?? usage[key]
      if (typeof value === "number" && Number.isFinite(value)) return value
    }
    return 0
  }
  return {
    videoInputTokens: pick("video_tokens", "videoTokens", "video_input_tokens"),
    audioInputTokens: pick("audio_tokens", "audioTokens", "audio_input_tokens"),
    textInputTokens: pick("text_tokens", "textTokens", "text_input_tokens"),
  }
}
