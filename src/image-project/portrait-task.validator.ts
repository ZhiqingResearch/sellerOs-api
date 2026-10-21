import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common"
import { AiModelModality } from "@prisma/client"
import Ajv, { type ErrorObject } from "ajv"
import addFormats from "ajv-formats"
import { gatewayImageSizingSchema } from "../ai-gateway/gateway-image-sizing"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import {
  CreatePortraitTaskDto,
  PORTRAIT_CREATION_TYPES,
  PortraitCreationType,
  PortraitDeliveryTargetDto,
} from "./portrait-creation.dto"
import {
  buildPortraitImageTaskRequest,
  PORTRAIT_PROTECTED_MODEL_PARAM_KEYS,
  PortraitReferenceImage,
} from "./portrait-image-generator"
import {
  planPortraitSizingWithGateway,
  PORTRAIT_RESOLUTION_TIERS,
  PortraitDeliveryPlan,
  ratioTierFromDimensions,
  type PortraitDeliveryTarget,
  type PortraitResolutionTier,
} from "./portrait-size-planner"

interface ReferenceSnapshot extends PortraitReferenceImage {
  source_type: "POOL" | "UPLOAD"
  pool_image_id?: number
}

export interface ValidatedPortraitConfig {
  creationType: PortraitCreationType
  references: PortraitReferenceImage[]
}

export interface ValidatedPortraitTaskConfig extends ValidatedPortraitConfig {
  modelParams: Record<string, unknown>
  deliveryPlan?: PortraitDeliveryPlan
}

const MAX_SNAPSHOT_BYTES = 100 * 1024
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)

@Injectable()
export class PortraitTaskValidator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayProvider
  ) {}

  async validateTask(
    dto: CreatePortraitTaskDto,
    userId: number
  ): Promise<ValidatedPortraitTaskConfig> {
    const validated = await this.validate(dto.promptConfig, dto.viewConfig, userId)
    const deliveryTarget = dto.deliveryTarget ?? undefined
    const modelParams = await this.validateModelParams(
      dto.model,
      dto.prompt,
      dto.quantity ?? 1,
      validated.references,
      dto.promptConfig.model_params,
      dto.aspectRatio,
      deliveryTarget
    )
    this.assertSnapshotSize({ ...dto.promptConfig, model_params: modelParams }, "提示词配置")
    const { modelParams: effectiveModelParams, ...delivery } = modelParams
    return { ...validated, ...delivery, modelParams: effectiveModelParams }
  }

  async validate(
    promptConfig: Record<string, unknown>,
    viewConfig: Record<string, unknown>,
    userId: number
  ): Promise<ValidatedPortraitConfig> {
    this.assertSnapshotSize(promptConfig, "提示词配置")
    this.assertSnapshotSize(viewConfig, "视角配置")

    const schemaVersion = promptConfig.schema_version
    if (schemaVersion !== 1) throw new BadRequestException("promptConfig.schema_version 仅支持 1")

    const creationType = promptConfig.creation_type
    if (
      typeof creationType !== "string" ||
      !PORTRAIT_CREATION_TYPES.includes(creationType as PortraitCreationType)
    ) {
      throw new BadRequestException("promptConfig.creation_type 不合法")
    }

    if (!this.isPlainObject(promptConfig.modules)) {
      throw new BadRequestException("promptConfig.modules 必须为对象")
    }

    this.validateViews(creationType as PortraitCreationType, viewConfig)
    const references = await this.validateReferences(promptConfig.references, userId)
    return { creationType: creationType as PortraitCreationType, references }
  }

  private validateViews(creationType: PortraitCreationType, viewConfig: Record<string, unknown>) {
    if (creationType === "SINGLE_PORTRAIT") {
      const description = viewConfig.description
      if (
        description !== undefined &&
        (typeof description !== "string" || description.length > 500)
      ) {
        throw new BadRequestException("单角度视角描述不能超过 500 字")
      }
      return
    }

    const views = viewConfig.views
    if (!Array.isArray(views) || views.length !== 4) {
      throw new BadRequestException("多角度角色卡必须填写正好 4 个视角")
    }

    const indexes = new Set<number>()
    for (const view of views) {
      if (!this.isPlainObject(view)) throw new BadRequestException("视角配置格式不合法")
      const index = view.index
      const content = view.content
      if (!Number.isInteger(index) || (index as number) < 1 || (index as number) > 4) {
        throw new BadRequestException("四个视角的 index 必须为 1～4")
      }
      if (indexes.has(index as number)) throw new BadRequestException("四个视角的 index 不能重复")
      indexes.add(index as number)
      if (typeof content !== "string" || !content.trim()) {
        throw new BadRequestException(`请补全第 ${index as number} 个视角`)
      }
      if (content.length > 500) throw new BadRequestException("单个视角描述不能超过 500 字")
    }
  }

  private async validateModelParams(
    publicId: string,
    prompt: string,
    quantity: number,
    references: PortraitReferenceImage[],
    rawModelParams: unknown,
    legacyAspectRatio?: string,
    deliveryTarget?: PortraitDeliveryTargetDto
  ): Promise<{
    modelParams: Record<string, unknown>
    deliveryPlan?: PortraitDeliveryPlan
  }> {
    const model = await this.prisma.aiGatewayModel.findFirst({
      where: {
        publicId,
        category: "PORTRAIT",
        modality: AiModelModality.IMAGE,
        enabled: true,
        gatewayActive: true,
      },
      select: { publicId: true, displayName: true, gatewayConfig: true },
    })
    if (!model) throw new BadRequestException("所选人像模型不存在或未启用")

    if (rawModelParams !== undefined && !this.isPlainObject(rawModelParams)) {
      throw new BadRequestException("promptConfig.model_params 必须为对象")
    }
    const modelParams = { ...(rawModelParams ?? {}) } as Record<string, unknown>
    const protectedKey = Object.keys(modelParams).find(key =>
      PORTRAIT_PROTECTED_MODEL_PARAM_KEYS.has(key)
    )
    if (protectedKey) {
      throw new BadRequestException(
        `promptConfig.model_params.${protectedKey} 由后端控制，不能传入`
      )
    }

    if (deliveryTarget && legacyAspectRatio) {
      deliveryTarget.aspectRatio ??= legacyAspectRatio
    }

    if (!deliveryTarget && legacyAspectRatio && modelParams.aspect_ratio !== undefined && modelParams.aspect_ratio !== legacyAspectRatio)
      throw new BadRequestException("aspectRatio 与 promptConfig.model_params.aspect_ratio 冲突")
    const effectiveTarget = deliveryTarget ?? this.synthesizeDeliveryTarget(modelParams) ?? {
      aspectRatio: legacyAspectRatio ?? (typeof modelParams.aspect_ratio === "string" ? modelParams.aspect_ratio : "1:1"),
      resolutionTier: "1K" as const,
    }
    const sizePlan = await planPortraitSizingWithGateway(
      {
        target: effectiveTarget,
        modelParams,
        modelId: model.publicId,
        request: buildPortraitImageTaskRequest({
          nativeSizing: true,
          prompt, model: publicId, quantity, referenceImages: references, modelParams,
        }),
      },
      this.gateway
    )
    const effectiveModelParams = sizePlan.providerModelParams

    const config = this.asObject(sizePlan?.gatewayConfig ?? model.gatewayConfig)
    const detail = this.asObject(config?.detail)
    const facts = this.asObject(detail?.facts) ?? {}
    const requestSchemaConfig = this.asObject(config?.requestSchema)
    const requestSchema = this.asObject(requestSchemaConfig?.request_schema)
    if (!requestSchema) {
      throw new ServiceUnavailableException(`模型 ${model.displayName} 缺少请求参数配置`)
    }

    if (effectiveModelParams.output_format === undefined) {
      const formats = this.stringArray(facts.output_formats)
      if (formats.includes("png")) effectiveModelParams.output_format = "png"
      else if (formats.length > 0) effectiveModelParams.output_format = formats[0]
    }

    this.validateFactOption(
      model.displayName,
      effectiveModelParams,
      "quality",
      facts,
      "qualities",
      "质量"
    )
    this.validateFactOption(
      model.displayName,
      effectiveModelParams,
      "output_format",
      facts,
      "output_formats",
      "输出格式"
    )

    const operation = references.length > 0 ? "edit" : "generate"
    const modes = this.stringArray(facts.modes)
    if (modes.length > 0 && !modes.includes(operation)) {
      throw new BadRequestException(`模型 ${model.displayName} 不支持 ${operation} 操作`)
    }
    const maxReferenceImages = facts.max_reference_images
    if (typeof maxReferenceImages === "number" && references.length > maxReferenceImages) {
      throw new BadRequestException(
        `模型 ${model.displayName} 最多支持 ${maxReferenceImages} 张参考图`
      )
    }
    const maxImages = facts.max_images_per_request
    if (typeof maxImages === "number" && quantity > maxImages) {
      throw new BadRequestException(`模型 ${model.displayName} 单次最多生成 ${maxImages} 张图片`)
    }

    const request = buildPortraitImageTaskRequest({
      nativeSizing: sizePlan?.deliveryPlan.nativeSizing,
      prompt,
      model: publicId,
      quantity,
      referenceImages: references,
      modelParams: effectiveModelParams,
    })
    let validateSchema: ReturnType<typeof ajv.compile>
    try {
      // 实时 Schema 可能沿用同一 $id，每次独立编译，避免旧版本缓存冲突。
      const compiler = addFormats(new Ajv({ allErrors: true, strict: false }))
      validateSchema = compiler.compile(gatewayImageSizingSchema(requestSchema))
    } catch {
      throw new ServiceUnavailableException(`模型 ${model.displayName} 的请求参数配置无效`)
    }
    if (!validateSchema(request)) {
      throw new BadRequestException(
        `模型参数不符合 ${model.displayName} 配置：${this.formatSchemaErrors(validateSchema.errors)}`
      )
    }
    return { modelParams: effectiveModelParams, deliveryPlan: sizePlan.deliveryPlan }
  }

  private validateFactOption(
    modelName: string,
    params: Record<string, unknown>,
    paramKey: string,
    facts: Record<string, unknown>,
    factsKey: string,
    label: string
  ) {
    if (params[paramKey] === undefined) return
    const options = this.stringArray(facts[factsKey])
    if (options.length === 0) {
      throw new BadRequestException(`模型 ${modelName} 不支持${label}参数 ${paramKey}`)
    }
    if (typeof params[paramKey] !== "string" || !options.includes(params[paramKey])) {
      throw new BadRequestException(`模型 ${modelName} 的${label}仅支持：${options.join("、")}`)
    }
  }

  private static readonly SYNTHESIZED_DIMENSION_KEYS = [
    "size",
    "resolution",
    "width",
    "height",
    "resolution_tier",
  ]

  /**
   * 旧前端不传 deliveryTarget 时，从 model_params 携带的尺寸参数反推交付目标并强制走
   * intent 尺寸规划（planPortraitSizing），避免原始尺寸参数原样透传被网关准入拒绝。
   * 仅携带 aspect_ratio、或只有无法构成交付目标的档位时返回 null，维持原样提交。
   */
  private synthesizeDeliveryTarget(
    modelParams: Record<string, unknown>
  ): PortraitDeliveryTarget | null {
    const hasDimensionParam = PortraitTaskValidator.SYNTHESIZED_DIMENSION_KEYS.some(
      key => modelParams[key] !== undefined
    )
    if (!hasDimensionParam) return null

    const rawSize = [modelParams.resolution, modelParams.size].find(
      (value): value is string => typeof value === "string" && value.trim() !== ""
    )
    const aspectRatio =
      typeof modelParams.aspect_ratio === "string" && modelParams.aspect_ratio.trim() !== ""
        ? modelParams.aspect_ratio.trim()
        : null

    const sizeText = rawSize?.trim()
    if (sizeText) {
      const tier = sizeText.toUpperCase()
      if ((PORTRAIT_RESOLUTION_TIERS as readonly string[]).includes(tier)) {
        // 旧请求仅传档位时补齐默认方图比例。
        if (!aspectRatio) return { aspectRatio: "1:1", resolutionTier: tier as PortraitResolutionTier }
        return {
          aspectRatio,
          resolutionTier: tier as PortraitResolutionTier,
        }
      }
      const dimensions = sizeText.match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i)
      if (dimensions) {
        // 旧像素口径统一归一为 ratio 目标：保留原始宽高 + 就近档位
        const normalized = ratioTierFromDimensions(Number(dimensions[1]), Number(dimensions[2]))
        return {
          aspectRatio: normalized.aspectRatio,
          resolutionTier: this.readTierParam(modelParams) ?? normalized.resolutionTier,
        }
      }
      throw new BadRequestException(
        "promptConfig.model_params.size/resolution 格式应为 宽x高 像素或 1K～4K 档位"
      )
    }

    const width = modelParams.width
    const height = modelParams.height
    if (typeof width === "number" && typeof height === "number") {
      const normalized = ratioTierFromDimensions(width, height)
      return {
        aspectRatio: normalized.aspectRatio,
        resolutionTier: this.readTierParam(modelParams) ?? normalized.resolutionTier,
      }
    }
    if (width !== undefined || height !== undefined) {
      throw new BadRequestException("promptConfig.model_params.width/height 必须为成对的数字像素值")
    }
    return null
  }

  private readTierParam(modelParams: Record<string, unknown>): PortraitResolutionTier | null {
    const value = modelParams.resolution_tier
    if (value === undefined || value === null) return null
    if (typeof value !== "string") {
      throw new BadRequestException("promptConfig.model_params.resolution_tier 仅支持 1K～4K")
    }
    const tier = value.trim().toUpperCase()
    if (!(PORTRAIT_RESOLUTION_TIERS as readonly string[]).includes(tier)) {
      throw new BadRequestException("promptConfig.model_params.resolution_tier 仅支持 1K～4K")
    }
    return tier as PortraitResolutionTier
  }

  private formatSchemaErrors(errors: ErrorObject[] | null | undefined) {
    if (!errors?.length) return "未知参数错误"
    return errors
      .slice(0, 5)
      .map(error => {
        const missing =
          "missingProperty" in error.params ? String(error.params.missingProperty) : ""
        const path = error.instancePath || (missing ? `/${missing}` : "/")
        return `${path} ${error.message ?? "不合法"}`
      })
      .join("；")
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    return this.isPlainObject(value) ? value : null
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : []
  }

  private async validateReferences(value: unknown, userId: number): Promise<ReferenceSnapshot[]> {
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new BadRequestException("promptConfig.references 必须为数组")
    // 数量上限由所选模型的 facts.max_reference_images 决定（validateModelParams 内校验）

    const references: ReferenceSnapshot[] = value.map((raw, index) => {
      if (!this.isPlainObject(raw))
        throw new BadRequestException(`第 ${index + 1} 张参考图格式不合法`)
      const sourceType = raw.source_type
      const url = raw.url
      const purpose = raw.purpose
      if (sourceType !== "POOL" && sourceType !== "UPLOAD") {
        throw new BadRequestException(`第 ${index + 1} 张参考图来源不合法`)
      }
      if (typeof url !== "string" || !this.isHttpUrl(url) || url.length > 1000) {
        throw new BadRequestException(`第 ${index + 1} 张参考图 URL 不合法`)
      }
      if (typeof purpose !== "string" || !purpose.trim()) {
        throw new BadRequestException(`请填写第 ${index + 1} 张参考图的参考用途`)
      }
      if (purpose.length > 500) throw new BadRequestException("参考图用途不能超过 500 字")

      const poolImageId = raw.pool_image_id
      if (
        sourceType === "POOL" &&
        (!Number.isInteger(poolImageId) || (poolImageId as number) < 1)
      ) {
        throw new BadRequestException(`第 ${index + 1} 张素材池参考图缺少 pool_image_id`)
      }
      return {
        source_type: sourceType,
        url,
        purpose,
        ...(sourceType === "POOL" ? { pool_image_id: poolImageId as number } : {}),
      }
    })

    if (new Set(references.map(item => item.url)).size !== references.length) {
      throw new BadRequestException("参考图不能重复")
    }

    const poolReferences = references.filter(
      (item): item is ReferenceSnapshot & { pool_image_id: number } => item.source_type === "POOL"
    )
    if (poolReferences.length > 0) {
      const rows = await this.prisma.poolImage.findMany({
        where: { id: { in: poolReferences.map(item => item.pool_image_id) }, userId },
        select: { id: true, url: true },
      })
      const byId = new Map(rows.map(row => [row.id, row]))
      for (const item of poolReferences) {
        const row = byId.get(item.pool_image_id)
        if (!row) throw new BadRequestException(`素材池图片 ${item.pool_image_id} 不存在或无权访问`)
        if (!row.url || row.url !== item.url) {
          throw new BadRequestException(`素材池图片 ${item.pool_image_id} 的 URL 与当前记录不一致`)
        }
      }
    }

    return references
  }

  private assertSnapshotSize(value: Record<string, unknown>, label: string) {
    let bytes: number
    try {
      bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
    } catch {
      throw new BadRequestException(`${label}不是有效的 JSON`)
    }
    if (bytes > MAX_SNAPSHOT_BYTES) throw new BadRequestException(`${label}不能超过 100KB`)
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  private isHttpUrl(value: string) {
    try {
      const url = new URL(value)
      return url.protocol === "http:" || url.protocol === "https:"
    } catch {
      return false
    }
  }
}
