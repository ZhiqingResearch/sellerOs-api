import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import { UsageService } from "../usage/usage.service"
import { EnhancePromptDto, ToolboxTokenUsage, TranslatePromptDto } from "./dto/llm-toolbox.dto"
import {
  LLM_TOOLBOX_CATEGORY,
  LLM_TOOLBOX_MULTIMODAL_CATEGORY,
  LlmToolboxBilling,
} from "./llm-toolbox.billing"
import { completionRawText, completionTokenUsage } from "./llm-toolbox.completion"
import { splitInferenceReply } from "./llm-toolbox.reply-split"
import { ENHANCE_SYSTEM_PROMPT } from "./prompts/enhance-prompt"
import {
  IMAGE_INFERENCE_FOLLOW_UP_TEXT,
  IMAGE_INFERENCE_SYSTEM_PROMPT,
} from "./prompts/image-inference"
import { resolveTranslateSystemPrompt } from "./prompts/translate-prompt"

/** multipart 上传的图片文件（memoryStorage；字段名 image，≤10MB，controller 层 FileInterceptor） */
export interface UploadedImage {
  buffer: Buffer
  mimetype: string
  size: number
  originalname: string
}

export interface EnhancePromptResponse {
  enhanced: string
  tokenUsage?: ToolboxTokenUsage
  billingHandled: boolean
}

export interface TranslatePromptResponse {
  translated: string
  tokenUsage?: ToolboxTokenUsage
  billingHandled: boolean
}

export interface ImageInferenceResponse {
  visualDescription: string
  structuredPrompt: string
  raw: string
  tokenUsage?: ToolboxTokenUsage
  billingHandled: boolean
}

/**
 * LLM 工具箱三件套编排（P0 契约冻结 §1–§4）：
 * 校验（文案冻结）→ 类目解析模型+一口价（AiGatewayModel 单一启用行，fail-closed）
 * → 一口价预检（按量时跳过）→ 非流式网关调用 → 空回复兜底 → 扣费（失败降级）。
 * 模型与定价不写死代码：换模型/调价只动 AiGatewayModel 行。
 */
@Injectable()
export class LlmToolboxService {
  private readonly logger = new Logger(LlmToolboxService.name)

  constructor(
    private readonly gateway: AiGatewayProvider,
    private readonly usage: UsageService,
    private readonly billing: LlmToolboxBilling
  ) {}

  async enhance(userId: number, dto: EnhancePromptDto): Promise<EnhancePromptResponse> {
    this.assertPrompt(dto.prompt)
    const model = await this.billing.resolveModel(LLM_TOOLBOX_CATEGORY)
    if (model.fixedCredits)
      await this.usage.assertExactCreditsAffordable(userId, model.fixedCredits)

    const { completion, requestId } = await this.gateway.completeMultimodal({
      model: model.publicId,
      messages: [
        { role: "system", content: ENHANCE_SYSTEM_PROMPT },
        { role: "user", content: dto.prompt },
      ],
      temperature: 0.7,
    })

    // 空回复兜底：回显原始 prompt（P0 §2.1）
    const enhanced = completionRawText(completion).trim() || dto.prompt
    const tokenUsage = completionTokenUsage(completion)
    const billed = await this.billing.charge(userId, model, {
      tool: "enhance",
      gatewayRequestId: requestId,
    })
    this.logger.log(
      `[llm-toolbox] enhance 完成 model=${model.publicId} billed=${billed} gatewayRequestId=${requestId}`
    )
    return { enhanced, ...(tokenUsage ? { tokenUsage } : {}), billingHandled: billed }
  }

  async translate(userId: number, dto: TranslatePromptDto): Promise<TranslatePromptResponse> {
    this.assertPrompt(dto.prompt)
    const model = await this.billing.resolveModel(LLM_TOOLBOX_CATEGORY)
    if (model.fixedCredits)
      await this.usage.assertExactCreditsAffordable(userId, model.fixedCredits)

    const { completion, requestId } = await this.gateway.completeMultimodal({
      model: model.publicId,
      messages: [
        { role: "system", content: resolveTranslateSystemPrompt(dto.direction) },
        { role: "user", content: dto.prompt },
      ],
      temperature: 0.1,
    })

    const translated = completionRawText(completion).trim() || dto.prompt
    const tokenUsage = completionTokenUsage(completion)
    const billed = await this.billing.charge(userId, model, {
      tool: "translate",
      gatewayRequestId: requestId,
    })
    this.logger.log(
      `[llm-toolbox] translate 完成 direction=${dto.direction ?? "zh-to-en"} billed=${billed} gatewayRequestId=${requestId}`
    )
    return { translated, ...(tokenUsage ? { tokenUsage } : {}), billingHandled: billed }
  }

  async imageInference(
    userId: number,
    file: UploadedImage | undefined
  ): Promise<ImageInferenceResponse> {
    if (!file) {
      throw new BadRequestException("Reference image (`image`) is required")
    }
    if (!file.buffer?.length) {
      throw new BadRequestException("Failed to read reference image")
    }
    // 无 mime 白名单（P0 §4.1）：缺失回落 image/png，网关侧自行校验
    const mimetype = file.mimetype?.trim() || "image/png"

    const model = await this.billing.resolveModel(LLM_TOOLBOX_MULTIMODAL_CATEGORY)
    if (model.fixedCredits)
      await this.usage.assertExactCreditsAffordable(userId, model.fixedCredits)

    const dataUrl = `data:${mimetype};base64,${file.buffer.toString("base64")}`
    const { completion, requestId } = await this.gateway.completeMultimodal({
      model: model.publicId,
      messages: [
        { role: "system", content: IMAGE_INFERENCE_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: IMAGE_INFERENCE_FOLLOW_UP_TEXT },
          ],
        },
      ],
      temperature: 0.2,
    })

    // 空回复无回显兜底：三字段均为空串（P0 §4.3）
    const raw = completionRawText(completion).trim()
    const { visualDescription, structuredPrompt } = splitInferenceReply(raw)
    const tokenUsage = completionTokenUsage(completion)
    const billed = await this.billing.charge(userId, model, {
      tool: "image-inference",
      gatewayRequestId: requestId,
    })
    this.logger.log(
      `[llm-toolbox] image-inference 完成 model=${model.publicId} billed=${billed} gatewayRequestId=${requestId}`
    )
    return {
      visualDescription,
      structuredPrompt,
      raw,
      ...(tokenUsage ? { tokenUsage } : {}),
      billingHandled: billed,
    }
  }

  /** prompt 必须是非空字符串（trim 后为空 → 400，文案冻结，P0 §2.1） */
  private assertPrompt(prompt: unknown): void {
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new BadRequestException("`prompt` is required")
    }
  }
}
