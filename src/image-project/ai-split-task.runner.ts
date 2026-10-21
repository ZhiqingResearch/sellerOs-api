import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { Interval } from "@nestjs/schedule"
import { InvokeType, Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import type {
  ChatCompletion,
  ChatCompletionRequest,
  ImageGenerationCount,
  ImageTaskRequest,
} from "@zhiqingresearch/ai-ts-sdk"
import Ajv from "ajv"
import { createHash } from "crypto"
import { readFileSync } from "fs"
import { join } from "path"
import { AiGatewayWebhookService } from "../ai-gateway/ai-gateway-webhook.service"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import {
  FALLBACK_MARKETPLACE_LANGUAGE,
  marketplaceLanguageHead,
  marketplaceLanguageLabel,
  marketplaceLanguageTail,
  resolveMarketplaceLanguage,
  type MarketplaceLanguage,
} from "../common/utils/marketplace-language"
import { PrismaService } from "../prisma/prisma.service"
import { buildCenterCropDirective } from "../common/utils/image-crop-safe-prompt"
import { planPortraitSizing, type PortraitDeliveryPlan } from "./portrait-size-planner"
import { UsageService } from "../usage/usage.service"
import {
  AI_SPLIT_IMAGE_MODEL_CATEGORY,
  AI_SPLIT_STAGES,
  AiSplitProductImageSnapshot,
  AiSplitPromptSnapshot,
  isRecord,
  readAiSplitSnapshot,
} from "./ai-split.types"

const MAX_PARALLEL_DIRECTIONS = 3
export const AI_SPLIT_COMPETITOR_SCHEMA_VERSION = "selleros.competitor_visual_template.v3" as const

// 解析或结构校验失败时使用同一输入自动重试竞品拆解（初次 + 重试各一次）
const AI_SPLIT_ANALYSIS_MAX_ATTEMPTS = 2

// 竞品拆解模型空返回的产品口径文案：通常意味着参考图里没有可识别的产品主体，
// 同输入重试无意义（也不该再烧一次多模态分析费），直接以此文案失败
const NO_USABLE_PRODUCT_MESSAGE = "竞品图没有检测出可用产品，无法进行分析"

// 生图规划模型空返回的产品口径文案
const PLANNING_FAILED_MESSAGE = "生图规划失败，请重试"

/** 多模态模型空返回：内容级失败，不参与「同输入自动重试」 */
class EmptyCompletionError extends BadRequestException {}

const stringObjectSchema = (fields: readonly string[]) => ({
  type: "object",
  additionalProperties: false,
  required: [...fields],
  properties: Object.fromEntries(fields.map(field => [field, { type: "string" }])),
})

const VISUAL_RESTATEMENT_FIELDS = [
  "overall_scene",
  "product_subject",
  "product_owned_elements",
  "creative_carriers",
  "creative_elements",
  "spatial_relationships",
  "composition_camera",
  "foreground",
  "midground",
  "background",
  "color_mood",
  "lighting",
  "material_texture",
  "production_technique",
  "text_layout",
  "brand_layout",
  "marketing_tone",
] as const

const GENERATION_PROMPT_STRING_FIELDS = [
  "product_subject",
  "product_structure",
  "creative_carriers",
  "creative_elements",
  "spatial_interaction",
  "composition_camera",
  "foreground",
  "midground",
  "background",
  "color",
  "lighting",
  "material_texture",
  "production_style",
  "text_layout",
  "brand_area",
  "marketing_tone",
] as const

// PRD「正式竞品拆解提示词」的输出结构：visual_restatement / element_classification /
// variable_bindings / generation_prompt，不得以 props、camera、lighting 等简化结构冒充。
export const COMPETITOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "visual_restatement",
    "element_classification",
    "variable_bindings",
    "generation_prompt",
  ],
  properties: {
    schema_version: { const: AI_SPLIT_COMPETITOR_SCHEMA_VERSION },
    visual_restatement: stringObjectSchema(VISUAL_RESTATEMENT_FIELDS),
    element_classification: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["element", "ownership", "reason", "treatment", "variable_keys"],
        properties: {
          element: { type: "string", minLength: 1 },
          ownership: { enum: ["product_owned", "creative_owned", "hybrid"] },
          reason: { type: "string" },
          treatment: { enum: ["variableize", "preserve", "preserve_structure_replace_values"] },
          variable_keys: { type: "array", items: { type: "string" } },
        },
      },
    },
    variable_bindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key",
          "placeholder",
          "semantic_role",
          "visual_usage",
          "source",
          "required_for_visual",
          "missing_strategy",
        ],
        properties: {
          key: { type: "string", minLength: 1 },
          placeholder: { type: "string", minLength: 1 },
          semantic_role: { type: "string" },
          visual_usage: { type: "string" },
          source: { enum: ["current_product_keys", "system_reserved"] },
          required_for_visual: { type: "boolean" },
          missing_strategy: { type: "string" },
        },
      },
    },
    generation_prompt: {
      type: "object",
      additionalProperties: false,
      required: [...GENERATION_PROMPT_STRING_FIELDS, "constraints"],
      properties: {
        ...Object.fromEntries(
          GENERATION_PROMPT_STRING_FIELDS.map(field => [field, { type: "string" }])
        ),
        constraints: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const

const GENERATION_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "negative_prompt", "render_constraints"],
  properties: {
    prompt: { type: "string", minLength: 1 },
    negative_prompt: { type: "string" },
    render_constraints: {
      type: "object",
      additionalProperties: false,
      required: [
        "preserve_product_identity",
        "do_not_merge_packaging_into_product",
        "preserve_creative_owned",
      ],
      properties: {
        preserve_product_identity: { const: true },
        do_not_merge_packaging_into_product: { const: true },
        preserve_creative_owned: { const: true },
      },
    },
  },
} as const

const ajv = new Ajv({ allErrors: true, strict: false })
const validateCompetitorTemplate = ajv.compile(COMPETITOR_SCHEMA)
const validateGenerationPlan = ajv.compile(GENERATION_PLAN_SCHEMA)

@Injectable()
export class AiSplitTaskRunner implements OnModuleInit {
  private readonly logger = new Logger(AiSplitTaskRunner.name)
  private readonly running = new Set<number>()
  private readonly competitorPrompt = this.loadPrompt("competitor-analysis-v3.txt")
  private readonly productPrompt = this.loadPrompt("product-image-planning-v4.txt")
  // AI 拆图的多模态深度分析生成长（官方拆解模板输出 3-6K token），单独放宽超时；
  // 其他网关调用仍走客户端级默认 60s。AI_SPLIT_TIMEOUT_MS 可覆盖。
  private readonly multimodalTimeoutMs = Number(process.env.AI_SPLIT_TIMEOUT_MS) || 300_000
  private readonly competitorPromptHash = this.hash(this.competitorPrompt)
  private readonly productPromptHash = this.hash(this.productPrompt)

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayProvider,
    private readonly usage: UsageService,
    private readonly webhook: AiGatewayWebhookService
  ) {}

  async onModuleInit() {
    const interrupted = await this.prisma.generationTask.findMany({
      where: {
        generationMode: "AI_SPLIT",
        status: "GENERATING",
        aiSplitStage: {
          in: [AI_SPLIT_STAGES.COMPETITOR_ANALYZING, AI_SPLIT_STAGES.PRODUCT_ANALYZING],
        },
      },
      select: { id: true },
    })
    for (const task of interrupted) {
      await this.failTask(task.id, "多模态调用结果未能确认，请手动重试")
    }
    await this.resumePendingTasks()
  }

  getPromptVersions(): AiSplitPromptSnapshot["promptVersions"] {
    return {
      competitorAnalysis: "v3",
      competitorAnalysisHash: this.competitorPromptHash,
      productImageGeneration: "v4",
      productImageGenerationHash: this.productPromptHash,
    }
  }

  /** 站点 → 图上文案语言。运行期一律按 site 现解析（不信任快照存量值，
   *  旧快照/新站点口径一致），查不到国家回落英文。 */
  private siteLanguage(site: string): MarketplaceLanguage {
    return resolveMarketplaceLanguage(site) ?? FALLBACK_MARKETPLACE_LANGUAGE
  }

  @Interval(10_000)
  async resumePendingTasks() {
    if (!this.gateway.isConfigured()) return
    const capacity = MAX_PARALLEL_DIRECTIONS - this.running.size
    if (capacity <= 0) return
    const tasks = await this.prisma.generationTask.findMany({
      where: {
        generationMode: "AI_SPLIT",
        status: "GENERATING",
        gatewayTaskId: null,
        aiSplitStage: {
          in: [
            AI_SPLIT_STAGES.QUEUED,
            AI_SPLIT_STAGES.COMPETITOR_BILLING,
            AI_SPLIT_STAGES.PRODUCT_PLANNING,
            AI_SPLIT_STAGES.PRODUCT_BILLING,
            AI_SPLIT_STAGES.IMAGE_SUBMITTING,
          ],
        },
      },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: capacity,
    })
    for (const task of tasks) void this.run(task.id)
  }

  async run(taskId: number): Promise<void> {
    if (this.running.has(taskId) || this.running.size >= MAX_PARALLEL_DIRECTIONS) return
    this.running.add(taskId)
    try {
      for (let step = 0; step < 8; step += 1) {
        const task = await this.loadTask(taskId)
        if (!task || task.status !== "GENERATING" || task.generationMode !== "AI_SPLIT") return
        const snapshot = readAiSplitSnapshot(task.promptConfig)

        switch (task.aiSplitStage) {
          case AI_SPLIT_STAGES.QUEUED:
            if (
              !(await this.claimStage(
                task.id,
                AI_SPLIT_STAGES.QUEUED,
                AI_SPLIT_STAGES.COMPETITOR_ANALYZING
              ))
            )
              return
            await this.runCompetitorAnalysis(task.id, snapshot)
            continue
          case AI_SPLIT_STAGES.COMPETITOR_BILLING:
            if (!(await this.settleWorkflow(task, snapshot, 1))) return
            continue
          case AI_SPLIT_STAGES.PRODUCT_PLANNING:
            if (
              !(await this.claimStage(
                task.id,
                AI_SPLIT_STAGES.PRODUCT_PLANNING,
                AI_SPLIT_STAGES.PRODUCT_ANALYZING
              ))
            )
              return
            await this.runProductPlanning(task.id, snapshot)
            continue
          case AI_SPLIT_STAGES.PRODUCT_BILLING:
            if (!(await this.settleWorkflow(task, snapshot, 2))) return
            continue
          case AI_SPLIT_STAGES.IMAGE_SUBMITTING:
            await this.submitImageTask(task, snapshot)
            return
          default:
            return
        }
      }
    } catch (error) {
      const message = this.errorMessage(error)
      const current = await this.prisma.generationTask.findUnique({
        where: { id: taskId },
        select: { aiSplitStage: true },
      })
      if (
        current?.aiSplitStage === AI_SPLIT_STAGES.COMPETITOR_BILLING ||
        current?.aiSplitStage === AI_SPLIT_STAGES.PRODUCT_BILLING
      ) {
        this.logger.warn(`[AI 拆图] 可恢复阶段执行失败 task=${taskId}: ${message}`)
        return
      }
      await this.failTask(taskId, message)
    } finally {
      this.running.delete(taskId)
    }
  }

  private async runCompetitorAnalysis(taskId: number, snapshot: AiSplitPromptSnapshot) {
    if (snapshot.reference.sourceType === "TEMPLATE") {
      throw new BadRequestException("模板复用任务不能执行竞品图拆解")
    }
    const startedAt = Date.now()
    this.stepLog(
      taskId,
      "第1步·竞品拆解",
      "开始｜执行逻辑：把竞品参考图交给多模态分析模型，拆解为与 SKU 值解耦的可复用视觉模板（只提取构图/镜头/背景/光线/色彩/文字区域/道具，不复用竞品品牌与文案），并通过 variable_bindings 把文字区域绑到 SKU 字段"
    )
    this.stepLog(
      taskId,
      "第1步·竞品拆解",
      `输入｜${JSON.stringify({
        分析模型: snapshot.analysisModel.publicId,
        温度: 0.2,
        竞品参考图: {
          sourceType: snapshot.reference.sourceType,
          url: snapshot.reference.url,
        },
        SKU字段键_current_product_keys: snapshot.currentProductKeys,
        输出Schema: AI_SPLIT_COMPETITOR_SCHEMA_VERSION,
      })}`
    )
    this.stepLog(
      taskId,
      "第1步·竞品拆解",
      `输入｜系统提示词全文（版本 ${snapshot.promptVersions.competitorAnalysis}；${
        this.supportsJsonSchema(snapshot)
          ? "本路由支持 response_format，输出 Schema 走独立参数"
          : "本路由不支持 response_format，输出 Schema 会拼在系统提示词末尾"
      }）：\n${this.competitorPrompt}`
    )
    let requestId: string | undefined
    let template: Record<string, unknown> | undefined
    let errorMessage: string | undefined
    try {
      const request: ChatCompletionRequest = {
        model: snapshot.analysisModel.publicId,
        messages: [
          {
            role: "system",
            content: this.structuredSystemPrompt(
              snapshot,
              this.competitorPrompt,
              COMPETITOR_SCHEMA
            ),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  current_product_keys: snapshot.currentProductKeys,
                  prompt_version: "v3",
                }),
              },
              { type: "image_url", image_url: { url: snapshot.reference.url } },
            ],
          },
        ],
        ...this.structuredOutput(snapshot, "competitor_visual_template", COMPETITOR_SCHEMA),
        temperature: 0.2,
        // 正式竞品拆解模板包含 17 字段视觉复述 + 归属分类 + 16 字段生成模板，输出量大
        max_output_tokens: 16000,
      }
      this.stepLog(
        taskId,
        "第1步·竞品拆解",
        `输入｜完整请求（Gateway 实际收到的内容）：${JSON.stringify(request)}`
      )
      for (let attempt = 1; attempt <= AI_SPLIT_ANALYSIS_MAX_ATTEMPTS; attempt += 1) {
        const result = await this.gateway.completeMultimodal(request, {
          timeoutMs: this.multimodalTimeoutMs,
        })
        requestId = result.requestId
        this.stepLog(
          taskId,
          "第1步·竞品拆解",
          `输出｜模型原始返回（第 ${attempt} 次，requestId=${requestId ?? "无"}）：${this.completionRawText(result.completion)}`
        )
        try {
          const parsed = this.parseStructuredCompletion(
            result.completion,
            NO_USABLE_PRODUCT_MESSAGE
          )
          if (!validateCompetitorTemplate(parsed)) {
            throw new BadRequestException(
              `竞品拆解输出结构不符合正式 Schema：${JSON.stringify(validateCompetitorTemplate.errors)}`
            )
          }
          this.stripCreativeElementConstraints(parsed)
          template = parsed
          break
        } catch (error) {
          // 空返回=竞品图没有可分析内容，重试同一输入只会再失败一次，直接失败
          if (error instanceof EmptyCompletionError) throw error
          if (attempt >= AI_SPLIT_ANALYSIS_MAX_ATTEMPTS) throw error
          this.logger.warn(
            `[AI 拆图]【第1步·竞品拆解】task=${taskId}｜第 ${attempt} 次结果校验未通过，使用相同输入自动重试：${this.errorMessage(error)}`
          )
        }
      }
      this.stepLog(
        taskId,
        "第1步·竞品拆解",
        `输出｜校验通过（AJV Schema）的竞品视觉模板：${JSON.stringify(template)}`
      )
      this.stepLog(
        taskId,
        "第1步·竞品拆解",
        `完成｜耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s，模板已存入任务快照，等待计费后进入生图规划`
      )
    } catch (error) {
      errorMessage = this.errorMessage(error)
      this.logger.warn(
        `[AI 拆图] 竞品拆解失败 task=${taskId} requestId=${requestId ?? "无"}: ${errorMessage}`
      )
      if (!requestId) throw error
    }

    snapshot.gatewayCalls.workflow1RequestId = requestId
    snapshot.gatewayCalls.workflow1Error = errorMessage
    if (template) snapshot.competitorTemplate = template
    await this.saveSnapshot(taskId, snapshot, AI_SPLIT_STAGES.COMPETITOR_BILLING)
  }

  private async runProductPlanning(taskId: number, snapshot: AiSplitPromptSnapshot) {
    if (!snapshot.competitorTemplate) {
      await this.failTask(taskId, "竞品视觉拆解结果缺失")
      return
    }

    const startedAt = Date.now()
    const competitorTemplate = snapshot.competitorTemplate
    this.stepLog(
      taskId,
      "第2步·生图规划",
      "开始｜执行逻辑：把商品事实、带用途标注的产品图、第1步的竞品视觉模板、用户生成参数一起交给多模态分析模型，蒸馏出最终生图指令（prompt + negative_prompt + render_constraints）"
    )
    this.stepLog(
      taskId,
      "第2步·生图规划",
      `输入｜${JSON.stringify({
        分析模型: snapshot.analysisModel.publicId,
        温度: 0.2,
        商品事实_current_product: snapshot.currentProduct,
        产品图清单_product_images: snapshot.productImages.map(image => ({
          index: image.index,
          purpose: image.purpose,
          description: image.description,
          url: image.url,
        })),
        竞品视觉模板_competitor_template: {
          来源: "第1步输出，完整内容见第1步日志",
          schema_version: isRecord(competitorTemplate)
            ? competitorTemplate.schema_version
            : competitorTemplate,
          整体画面_overall_scene:
            isRecord(competitorTemplate) &&
            isRecord(competitorTemplate.visual_restatement) &&
            typeof competitorTemplate.visual_restatement.overall_scene === "string"
              ? competitorTemplate.visual_restatement.overall_scene
              : undefined,
          创意元素_creative_owned: this.creativeElementNames(competitorTemplate),
        },
        生成参数_generation_settings: {
          site: snapshot.generationSettings.site,
          locale: snapshot.generationSettings.locale,
          text_amount: snapshot.generationSettings.textAmount,
          生图模型: snapshot.generationSettings.model,
          quantity: snapshot.generationSettings.quantity,
          model_params: snapshot.generationSettings.modelParams,
        },
      })}`
    )
    this.stepLog(
      taskId,
      "第2步·生图规划",
      `输入｜系统提示词全文（版本 ${snapshot.promptVersions.productImageGeneration}；${
        this.supportsJsonSchema(snapshot)
          ? "本路由支持 response_format，输出 Schema 走独立参数"
          : "本路由不支持 response_format，输出 Schema 会拼在系统提示词末尾"
      }）：\n${this.productPrompt}`
    )

    let requestId: string | undefined
    let generationPlan: Record<string, unknown> | undefined
    let errorMessage: string | undefined
    try {
      const productImageMetadata = snapshot.productImages.map(image => ({
        index: image.index,
        purpose: image.purpose,
        description: image.description,
      }))
      const content: unknown[] = [
        {
          type: "text",
          text: JSON.stringify({
            current_product: snapshot.currentProduct,
            product_images: productImageMetadata,
            competitor_template: snapshot.competitorTemplate,
            generation_settings: {
              site: snapshot.generationSettings.site,
              locale: snapshot.generationSettings.locale,
              // 显式语言标签（如 "Spanish (es-MX)"），不让规划 LLM 自己从 locale 推断
              language: marketplaceLanguageLabel(
                this.siteLanguage(snapshot.generationSettings.site)
              ),
              text_amount: snapshot.generationSettings.textAmount,
              model: snapshot.generationSettings.model,
              quantity: snapshot.generationSettings.quantity,
              model_params: snapshot.generationSettings.modelParams,
            },
          }),
        },
      ]
      for (const image of snapshot.productImages) {
        content.push({ type: "text", text: this.productImageRoleText(image) })
        content.push({ type: "image_url", image_url: { url: image.url } })
      }

      const request: ChatCompletionRequest = {
        model: snapshot.analysisModel.publicId,
        messages: [
          {
            role: "system",
            content: this.structuredSystemPrompt(
              snapshot,
              this.productPrompt,
              GENERATION_PLAN_SCHEMA
            ),
          },
          { role: "user", content },
        ],
        ...this.structuredOutput(snapshot, "ai_split_generation_plan", GENERATION_PLAN_SCHEMA),
        temperature: 0.2,
        max_output_tokens: 8000,
      }
      this.stepLog(
        taskId,
        "第2步·生图规划",
        `输入｜完整请求（Gateway 实际收到的内容，含 system 提示词、四类输入 JSON 与逐图用途标注）：${JSON.stringify(request)}`
      )
      const result = await this.gateway.completeMultimodal(request, {
        timeoutMs: this.multimodalTimeoutMs,
      })
      requestId = result.requestId
      this.stepLog(
        taskId,
        "第2步·生图规划",
        `输出｜模型原始返回（requestId=${requestId ?? "无"}）：${this.completionRawText(result.completion)}`
      )
      generationPlan = this.parseStructuredCompletion(result.completion, PLANNING_FAILED_MESSAGE)
      if (!validateGenerationPlan(generationPlan)) {
        this.logger.warn(
          `[AI 拆图] 生图规划结果不符合 Schema task=${taskId}: ${JSON.stringify(
            validateGenerationPlan.errors
          )}`
        )
        throw new BadRequestException("生图指令规划结果不符合结构要求")
      }
      const constraints: unknown = (generationPlan as Record<string, unknown>).render_constraints
      if (
        !isRecord(constraints) ||
        constraints.preserve_product_identity !== true ||
        constraints.do_not_merge_packaging_into_product !== true ||
        constraints.preserve_creative_owned !== true
      ) {
        throw new BadRequestException("生图指令未确认商品身份、包装隔离与创意保留约束")
      }
      const planPromptText = typeof generationPlan.prompt === "string" ? generationPlan.prompt : ""
      const planNegativeText =
        typeof generationPlan.negative_prompt === "string" ? generationPlan.negative_prompt : ""
      // 只拦截排除式表述（"不要出现X/禁止X"）；保留式（"不要移除X/保持X"）属良性，
      // 交给提交阶段的 sanitizeNegativePrompt 统一剔除，避免误杀任务。
      const negativeViolations = this.creativeElementNames(snapshot.competitorTemplate).filter(
        name =>
          planNegativeText
            .split(/[,，;；]/)
            .filter(clause => clause.trim())
            .some(clause => this.mentionsElement(clause, name) && this.isExclusionClause(clause))
      )
      if (negativeViolations.length) {
        throw new BadRequestException(
          `negative_prompt 包含必须保留的创意元素：${negativeViolations.join("、")}`
        )
      }
      const unresolvedPlaceholders = [
        ...new Set([...planPromptText.matchAll(/\{\{product\.[^{}]+\}\}/g)].map(match => match[0])),
      ]
      if (unresolvedPlaceholders.length) {
        throw new BadRequestException(
          `正向 prompt 存在未解析的变量占位符：${unresolvedPlaceholders.join("、")}`
        )
      }
      this.stepLog(
        taskId,
        "第2步·生图规划",
        `输出｜校验通过（AJV Schema + 渲染约束确认）的生图指令：${JSON.stringify(generationPlan)}`
      )
      this.stepLog(
        taskId,
        "第2步·生图规划",
        `完成｜耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s，生图指令已存入任务快照，等待计费后提交生图`
      )
    } catch (error) {
      errorMessage = this.errorMessage(error)
      this.logger.warn(
        `[AI 拆图] 生图规划失败 task=${taskId} requestId=${requestId ?? "无"}: ${errorMessage}`
      )
      if (!requestId) throw error
    }

    snapshot.gatewayCalls.workflow2RequestId = requestId
    snapshot.gatewayCalls.workflow2Error = errorMessage
    if (generationPlan) snapshot.generationPlan = generationPlan
    await this.saveSnapshot(taskId, snapshot, AI_SPLIT_STAGES.PRODUCT_BILLING)
  }

  private async settleWorkflow(
    task: Awaited<ReturnType<AiSplitTaskRunner["loadTask"]>> & {},
    snapshot: AiSplitPromptSnapshot,
    workflow: 1 | 2
  ): Promise<boolean> {
    const requestId =
      workflow === 1
        ? snapshot.gatewayCalls.workflow1RequestId
        : snapshot.gatewayCalls.workflow2RequestId
    if (!requestId) throw new BadRequestException(`Workflow ${workflow} 缺少 Gateway requestId`)

    const stepName = workflow === 1 ? "计费·第1步竞品拆解" : "计费·第2步生图规划"

    // 组合一口价：生图模型 AI_SPLIT 行配置 fixedCredits 时，拆图全程只按
    // 「组合价 × 成功张数」在生图终态一笔扣费（webhook 侧），本步分析调用
    // 不再单独计费；未配置回落现状按量。实时读库，改库即时生效。
    const comboFixedCredits = await this.usage.gatewayFixedImageCredits(
      snapshot.generationSettings.model,
      AI_SPLIT_IMAGE_MODEL_CATEGORY
    )
    if (comboFixedCredits) {
      this.stepLog(
        task.id,
        stepName,
        `跳过计费｜执行逻辑：生图模型 ${snapshot.generationSettings.model} 已配置 AI 拆图组合一口价（${comboFixedCredits.toString()} 积分/张，含本步分析费），生图终态一笔扣费，本步不单独计费`
      )
      if (workflow === 1) snapshot.gatewayCalls.workflow1Billed = true
      else snapshot.gatewayCalls.workflow2Billed = true
      const comboError =
        workflow === 1 ? snapshot.gatewayCalls.workflow1Error : snapshot.gatewayCalls.workflow2Error
      if (comboError) {
        await this.saveSnapshot(task.id, snapshot, AI_SPLIT_STAGES.FAILED)
        await this.failTask(task.id, comboError)
        return false
      }
      await this.saveSnapshot(
        task.id,
        snapshot,
        workflow === 1 ? AI_SPLIT_STAGES.PRODUCT_PLANNING : AI_SPLIT_STAGES.IMAGE_SUBMITTING
      )
      return true
    }

    const usage = await this.gateway.getUsageByRequestId(requestId)
    if (!usage || usage.amount === null) {
      this.logger.debug(
        `[AI 拆图]【${stepName}】task=${task.id}｜用量未就绪，等待下次轮询｜requestId=${requestId}`
      )
      return false
    }

    const chargeable = usage.amount !== "0" && !/^0(?:\.0+)?$/.test(usage.amount)
    // 价格倍率：网关 usage × 倍率后计费（与目录行同源）；meta 留原始金额与倍率供对账
    const priceMultiplier = chargeable
      ? await this.usage.gatewayPriceMultiplier(snapshot.analysisModel.publicId)
      : new Decimal(1)
    if (chargeable) {
      await this.usage.chargeModel(
        task.userId,
        new Decimal(usage.amount).mul(priceMultiplier).toString(),
        {
          source: "aicreative.ai_split",
          invokeType: task.source === "vidflowos" ? InvokeType.API : InvokeType.PLATFORM,
          model: snapshot.analysisModel.publicId,
          meta: {
            taskId: task.id,
            groupId: task.groupId,
            stage: `WORKFLOW_${workflow}`,
            gatewayRequestId: requestId,
            gatewayUsageStatus: usage.status,
            gatewayAmountCny: usage.amount,
            priceMultiplier: priceMultiplier.toString(),
          },
          requestId: this.billingRequestId(requestId),
          allowOverdraft: true,
        }
      )
    }
    this.stepLog(
      task.id,
      stepName,
      `完成｜执行逻辑：按 Gateway 用量对本步多模态调用扣费｜requestId=${requestId} amount=${usage.amount} status=${usage.status} 实际扣费=${chargeable ? "是" : "否（0 元）"} 计费模型=${snapshot.analysisModel.publicId}`
    )

    if (workflow === 1) snapshot.gatewayCalls.workflow1Billed = true
    else snapshot.gatewayCalls.workflow2Billed = true
    const error =
      workflow === 1 ? snapshot.gatewayCalls.workflow1Error : snapshot.gatewayCalls.workflow2Error
    if (error) {
      await this.saveSnapshot(task.id, snapshot, AI_SPLIT_STAGES.FAILED)
      await this.failTask(task.id, error)
      return false
    }

    await this.saveSnapshot(
      task.id,
      snapshot,
      workflow === 1 ? AI_SPLIT_STAGES.PRODUCT_PLANNING : AI_SPLIT_STAGES.IMAGE_SUBMITTING
    )
    return true
  }

  private async submitImageTask(
    task: NonNullable<Awaited<ReturnType<AiSplitTaskRunner["loadTask"]>>>,
    snapshot: AiSplitPromptSnapshot
  ) {
    if (!snapshot.generationPlan) throw new BadRequestException("生图指令缺失")
    const startedAt = Date.now()
    this.stepLog(
      task.id,
      "第3步·提交生图",
      "开始｜执行逻辑：把第2步规划出的生图指令与产品参考图用途清单拼成最终 prompt（负面约束按路由能力走独立字段或拼入 prompt），连同参考图一起提交给生图模型；生成结果由 webhook 异步回传，本步只记录输入"
    )
    const planPrompt = snapshot.generationPlan.prompt
    if (typeof planPrompt !== "string" || !planPrompt.trim()) {
      throw new BadRequestException("生图提示词为空")
    }
    const negative =
      typeof snapshot.generationPlan.negative_prompt === "string"
        ? snapshot.generationPlan.negative_prompt.trim()
        : ""
    // PRD 组装规则：图片模型只接收当前 SKU 的 PRODUCT_MAIN / PRODUCT_DETAIL 图片；
    // PACKAGING / ACCESSORY 不进入 reference_images，也不进入与之一一对应的用途清单。
    const generationRefImages = snapshot.productImages.filter(
      image => image.purpose === "PRODUCT_MAIN" || image.purpose === "PRODUCT_DETAIL"
    )
    let prompt = `${planPrompt.trim()}\n\n${this.productImageRoleList(generationRefImages)}`
    // 站点语言硬指令头尾兜底：即使规划 LLM 产出的文案语言漂移（商品资料为
    // 其他语言时照抄等），最终提交给图片模型的 prompt 仍带语言约束；
    // textAmount=NONE 无文字时跳过（无文字即无语言）。
    if (snapshot.generationSettings.textAmount !== "NONE") {
      const siteLanguage = this.siteLanguage(snapshot.generationSettings.site)
      prompt = `${marketplaceLanguageHead(siteLanguage)}${prompt}${marketplaceLanguageTail(siteLanguage)}`
    }
    const deliveryPlan = task.deliveryPlan as unknown as PortraitDeliveryPlan | null
    const modelParams = snapshot.generationSettings.modelParams
    const effectiveModelParams = deliveryPlan?.requested?.aspectRatio && deliveryPlan.requested.resolutionTier
      ? planPortraitSizing({ target: deliveryPlan.requested, modelParams }).providerModelParams
      : modelParams
    const request: Record<string, unknown> = {
      ...effectiveModelParams,
      model: snapshot.generationSettings.model,
      prompt,
      operation: "edit",
      n: snapshot.generationSettings.quantity as ImageGenerationCount,
      callback: true,
      callback_data: {
        business: "AI_SPLIT",
        taskId: task.id,
        groupId: task.groupId ?? "",
      },
      reference_images: generationRefImages.map(image => ({ url: image.url })),
      response_format: "url",
    }
    if (negative) {
      const safeNegative = this.sanitizeNegativePrompt(negative, snapshot.competitorTemplate)
      if (safeNegative) {
        if (snapshot.generationSettings.supportsNegativePrompt) {
          request.negative_prompt = safeNegative
        } else prompt += `\n\n禁止项：${safeNegative}`
      }
      request.prompt = prompt
    }

    if (deliveryPlan?.cropAnchor === "centre" && !deliveryPlan.nativeSizing) {
      prompt += `\n\n${buildCenterCropDirective(deliveryPlan.requested.aspectRatio)}`
      request.prompt = prompt
    }

    this.stepLog(
      task.id,
      "第3步·提交生图",
      `输入｜${JSON.stringify({
        生图模型: snapshot.generationSettings.model,
        数量_n: snapshot.generationSettings.quantity,
        模型参数_model_params: snapshot.generationSettings.modelParams,
        支持独立负面提示词: snapshot.generationSettings.supportsNegativePrompt,
        负面约束传递方式: !negative
          ? "无"
          : snapshot.generationSettings.supportsNegativePrompt
            ? "negative_prompt 独立字段"
            : "以「禁止项：」拼入 prompt 末尾",
        参考图_reference_images: generationRefImages.map(image => ({
          index: image.index,
          purpose: image.purpose,
          url: image.url,
        })),
        最终prompt构成:
          "第2步规划 prompt + 产品图用途清单" +
          (negative && !snapshot.generationSettings.supportsNegativePrompt ? " + 禁止项" : "") +
          (deliveryPlan?.cropAnchor === "centre" && !deliveryPlan.nativeSizing ? " + 中心裁剪安全构图" : ""),
      })}`
    )
    this.stepLog(
      task.id,
      "第3步·提交生图",
      `输入｜完整请求（Gateway 实际收到的内容）：${JSON.stringify(request)}`
    )
    const remoteTask = await this.gateway.createImageTask(
      request as unknown as ImageTaskRequest,
      `ai-split:image-generation-task:${task.id}`
    )
    const linked = await this.prisma.$transaction(
      async tx => {
        const updated = await tx.generationTask.updateMany({
          where: {
            id: task.id,
            generationMode: "AI_SPLIT",
            status: "GENERATING",
            aiSplitStage: AI_SPLIT_STAGES.IMAGE_SUBMITTING,
            gatewayTaskId: null,
          },
          data: {
            prompt,
            gatewayTaskId: remoteTask.id,
            aiSplitStage: AI_SPLIT_STAGES.IMAGE_GENERATING,
          },
        })
        if (updated.count === 0) return false
        await tx.generatedImage.updateMany({
          where: { taskId: task.id, status: "GENERATING", deletedAt: null },
          data: { providerJobId: remoteTask.id },
        })
        return true
      },
      { timeout: 15_000 }
    )
    if (!linked) return
    this.stepLog(
      task.id,
      "第3步·提交生图",
      `完成｜耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s，已提交 gatewayTask=${remoteTask.id}（状态 ${remoteTask.status}），后续生成结果等 webhook 回传`
    )
    if (remoteTask.status !== "queued" && remoteTask.status !== "running") {
      await this.webhook.applyImageTask(remoteTask)
    }
  }

  private loadTask(taskId: number) {
    return this.prisma.generationTask.findUnique({
      where: { id: taskId },
      include: {
        generatedImages: {
          where: { deletedAt: null },
          orderBy: [{ order: "asc" }, { id: "asc" }],
        },
      },
    })
  }

  private async claimStage(taskId: number, from: string, to: string) {
    const result = await this.prisma.generationTask.updateMany({
      where: {
        id: taskId,
        generationMode: "AI_SPLIT",
        status: "GENERATING",
        aiSplitStage: from,
        gatewayTaskId: null,
      },
      data: { aiSplitStage: to },
    })
    return result.count === 1
  }

  private saveSnapshot(taskId: number, snapshot: AiSplitPromptSnapshot, stage: string) {
    return this.prisma.generationTask.update({
      where: { id: taskId },
      data: {
        promptConfig: snapshot as unknown as Prisma.InputJsonValue,
        aiSplitStage: stage,
      },
    })
  }

  private async failTask(taskId: number, message: string) {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true, generationMode: true },
    })
    if (!task || task.generationMode !== "AI_SPLIT") return
    await this.prisma.$transaction(
      async tx => {
        await tx.generatedImage.updateMany({
          where: { taskId, status: "GENERATING", deletedAt: null },
          data: { status: "FAILED", errorMessage: message },
        })
        await tx.generationTask.updateMany({
          where: { id: taskId, status: "GENERATING", deletedAt: null },
          data: { status: "FAILED", aiSplitStage: AI_SPLIT_STAGES.FAILED, errorMessage: message },
        })
        const [running, success] = await Promise.all([
          tx.generationTask.count({
            where: { projectId: task.projectId, status: "GENERATING", deletedAt: null },
          }),
          tx.generatedImage.count({
            where: {
              status: "SUCCESS",
              deletedAt: null,
              task: { projectId: task.projectId, deletedAt: null },
            },
          }),
        ])
        await tx.imageProject.updateMany({
          where: { id: task.projectId, status: { not: "ARCHIVED" }, deletedAt: null },
          data: { status: running > 0 ? "GENERATING" : success > 0 ? "COMPLETED" : "DRAFT" },
        })
      },
      { timeout: 15_000 }
    )
    this.logger.warn(`[AI 拆图] 任务失败 task=${taskId}: ${message}`)
  }

  private completionRawText(completion: ChatCompletion): string {
    const first = completion.choices?.[0]
    if (!isRecord(first) || !isRecord(first.message)) return ""
    const content = first.message.content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .flatMap(item => (isRecord(item) && typeof item.text === "string" ? [item.text] : []))
        .join("")
    }
    return ""
  }

  private parseStructuredCompletion(
    completion: ChatCompletion,
    emptyMessage = "多模态模型未返回消息内容"
  ): Record<string, unknown> {
    const text = this.completionRawText(completion)
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
    if (!text) throw new EmptyCompletionError(emptyMessage)
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isRecord(parsed)) throw new Error()
      return parsed
    } catch {
      throw new BadRequestException("多模态模型返回的内容不是有效 JSON")
    }
  }

  /**
   * 部分多模态路由虽然接受 response_format 字段，但上游并不支持 JSON 输出。
   * 只有模型目录明确声明 JSON Schema 能力时才发送该参数；否则依靠 Prompt 约束，
   * 并在响应后继续执行同一份 JSON.parse + AJV Schema 校验。
   */
  private structuredOutput(
    snapshot: AiSplitPromptSnapshot,
    name: string,
    schema: Record<string, unknown>
  ): Pick<ChatCompletionRequest, "response_format"> | Record<string, never> {
    if (!this.supportsJsonSchema(snapshot)) return {}
    return {
      response_format: {
        type: "json_schema",
        json_schema: { name, strict: true, schema },
      },
    }
  }

  private structuredSystemPrompt(
    snapshot: AiSplitPromptSnapshot,
    prompt: string,
    schema: Record<string, unknown>
  ) {
    if (this.supportsJsonSchema(snapshot)) return prompt
    return `${prompt}\n\n当前模型路由不支持 response_format。你仍必须严格输出满足以下 JSON Schema 的单个 JSON 对象；不得自行设计其他根字段：\n${JSON.stringify(schema)}`
  }

  private supportsJsonSchema(snapshot: AiSplitPromptSnapshot) {
    const gatewayConfig = isRecord(snapshot.analysisModel.gatewayConfig)
      ? snapshot.analysisModel.gatewayConfig
      : null
    const detail = gatewayConfig && isRecord(gatewayConfig.detail) ? gatewayConfig.detail : null
    const facts = detail && isRecord(detail.facts) ? detail.facts : null
    const supportsJsonSchema =
      facts?.json_schema === true ||
      facts?.supports_json_schema === true ||
      facts?.structured_output === true
    return supportsJsonSchema
  }

  private creativeElementNames(template: Record<string, unknown> | null | undefined): string[] {
    if (!template || !Array.isArray(template.element_classification)) return []
    return template.element_classification
      .filter(
        entry =>
          isRecord(entry) &&
          entry.ownership === "creative_owned" &&
          typeof entry.element === "string"
      )
      .map(entry => (entry as { element: string }).element)
  }

  /**
   * 排除式表述：否定词 + 出现/包含/添加类动词（中），或 no/without/do not include（英）。
   * 只用于第2步 negative_prompt 校验（排除式提及创意元素才拦任务）；第1步模板里
   * 提及创意元素的 constraint 无论何种表述都由 stripCreativeElementConstraints 剔除放行。
   * 采用反向白名单：需显式排除动词才拦，避免枚举良性动词追不上模型措辞多样性。
   */
  private readonly exclusionClausePattern =
    /(不要|不得|不能|不应|不可|切勿|避免|别|禁止|严禁)[^。,，;；]{0,12}(出现|包含|加入|添加|画出|绘制|掺入|混入)|\b(no|none|without|exclude|excluding)\b|do\s*not\s+(include|add|show|feature|draw|place|contain)|never\s+(include|add|show)|avoid\s+(showing|including|adding|any)/i

  private isExclusionClause(clause: string): boolean {
    return this.exclusionClausePattern.test(clause)
  }

  /**
   * 剔除提及 creative_owned 元素的 constraint（不区分保留式/排除式表述）：拆解模型常写
   * "不要移除宇航员""不要复刻原图道具造型"这类保护性指令，也可能写出"不要出现X"的
   * 排除式禁令——元素已声明必须保留，禁止它的条款不可能成立，剔除是唯一自洽解，
   * 留在模板里会被规划模型抄进 negative_prompt 抑制创意元素。每剔一条告警留痕；
   * 最终 negative_prompt 仍有 sanitizeNegativePrompt 二道兜底。
   */
  private stripCreativeElementConstraints(template: Record<string, unknown>) {
    const generationPrompt = isRecord(template.generation_prompt)
      ? template.generation_prompt
      : null
    if (!generationPrompt || !Array.isArray(generationPrompt.constraints)) return
    const creativeNames = this.creativeElementNames(template)
    generationPrompt.constraints = generationPrompt.constraints.filter(item => {
      const clause = String(item)
      const hit = creativeNames.find(name => this.mentionsElement(clause, name))
      if (hit) {
        this.logger.warn(
          `[AI 拆图] 拆解模板 constraint 提及必须保留的创意元素「${hit}」，已剔除防止污染 negative_prompt：${clause}`
        )
        return false
      }
      return true
    })
  }

  /**
   * 判断「元素名是否被文本提及」：优先整短语包含；中文退化（成分词命中或 2 字
   * n-gram 覆盖率 ≥50%），容忍意译改写、只拦截元素被整体丢弃；拉丁文本用主要
   * 词干（≥4 字符、剔除 element/object/figure 等上位词）全部命中。
   */
  private mentionsElement(haystack: string, element: string): boolean {
    const text = haystack.toLowerCase().replace(/\s+/g, " ").trim()
    const name = element.toLowerCase().replace(/\s+/g, " ").trim()
    if (!text || !name) return false
    if (text.includes(name)) return true
    if (/[\u4e00-\u9fa5]/.test(name)) {
      if (this.cjkCoverage(text, name) >= 0.5) return true
      return name
        .split(/[及与和、，,]/)
        .some(part => part.trim().length >= 2 && text.includes(part.trim()))
    }
    const tokens = name
      .split(/[^a-z0-9]+/)
      .filter(
        token =>
          token.length >= 4 &&
          ![
            "element",
            "object",
            "figure",
            "item",
            "graphic",
            "shape",
            "character",
            "some",
          ].includes(token)
      )
    if (!tokens.length) return false
    return tokens.every(token => text.includes(token))
  }

  /** 中文字符串在文本中的 2 字 n-gram 覆盖率（0~1） */
  private cjkCoverage(text: string, name: string): number {
    const trimmed = name.replace(/[^\u4e00-\u9fa5]/g, "")
    const grams = new Set<string>()
    for (let i = 0; i + 2 <= trimmed.length; i += 1) grams.add(trimmed.slice(i, i + 2))
    if (!grams.size) return 0
    let hit = 0
    for (const gram of grams) if (text.includes(gram)) hit += 1
    return hit / grams.size
  }

  /**
   * PRD「图片模型请求组装规则」：追加禁止项前必须确认其中不包含任何 creative_owned
   * 或必须保留的 hybrid 创意主体；命中词条剔除并告警。
   */
  private sanitizeNegativePrompt(
    negative: string,
    competitorTemplate: Record<string, unknown> | null | undefined
  ): string {
    const creativeNames = this.creativeElementNames(competitorTemplate)
    if (!creativeNames.length) return negative.trim()
    const kept = negative
      .split(/[,，;；]/)
      .map(clause => clause.trim())
      .filter(Boolean)
      .filter(clause => {
        const hit = creativeNames.find(name => this.mentionsElement(clause, name))
        if (hit) {
          this.logger.warn(
            `[AI 拆图] 禁止项包含必须保留的创意元素「${hit}」，已剔除该词条：${clause}`
          )
          return false
        }
        return true
      })
    return kept.join(", ")
  }

  private productImageRoleText(image: AiSplitProductImageSnapshot) {
    const warning =
      image.purpose === "PACKAGING"
        ? "这是包装图，包装不是商品主体或商品配件。"
        : image.purpose === "ACCESSORY"
          ? "这是随附配件，不得与商品主体融合。"
          : ""
    return [
      `Image ${image.index}`,
      `用途：${image.purpose}`,
      `说明：${image.description ?? "无"}`,
      warning,
    ]
      .filter(Boolean)
      .join("\n")
  }

  private productImageRoleList(images: AiSplitProductImageSnapshot[]) {
    return [
      "产品参考图用途清单（顺序与 reference_images 完全一致）：",
      ...images.map(image => this.productImageRoleText(image)),
      "商品外观只能以 PRODUCT_MAIN / PRODUCT_DETAIL 参考图为准，不得把包装或配件融合进商品主体。",
    ].join("\n\n")
  }

  private billingRequestId(gatewayRequestId: string) {
    return `ais:${this.hash(gatewayRequestId).slice(0, 40)}`
  }

  private hash(value: string) {
    return createHash("sha256").update(value).digest("hex")
  }

  // 分步详细日志（含提示词全文/完整请求/模型原始返回）默认静默，避免生产日志量过大；
  // 排查时设置 AI_SPLIT_STEP_LOG=1 恢复输出，无需改代码重新发版。
  private stepLog(taskId: number, step: string, message: string) {
    if (process.env.AI_SPLIT_STEP_LOG === "1") {
      this.logger.log(`[AI 拆图]【${step}】task=${taskId}｜${message}`)
    }
  }

  private loadPrompt(fileName: string) {
    return readFileSync(join(__dirname, "prompts", "ai-split", fileName), "utf8").trim()
  }

  private errorMessage(error: unknown) {
    return (error instanceof Error ? error.message : "AI 拆图任务执行失败").slice(0, 2000)
  }
}
