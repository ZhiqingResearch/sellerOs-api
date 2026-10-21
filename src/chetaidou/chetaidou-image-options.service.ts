import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import Ajv from "ajv"
import addFormats from "ajv-formats"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import {
  gatewayImageSizingSchema,
  resolveGatewaySizingIntentDetailed,
  type GatewaySizingIntent,
  type GatewaySizingPlanResult,
} from "../ai-gateway/gateway-image-sizing"
import { PrismaService } from "../prisma/prisma.service"
import { stableHash } from "./chetaidou-storage.service"
import { CHETAIDOU_IMAGE_CATEGORY, CHETAIDOU_IMAGE_QUALITIES } from "./chetaidou.constants"

export const CHETAIDOU_IMAGE_RATIOS = [
  "1:1",
  "3:4",
  "4:3",
  "16:9",
  "21:9",
  "9:16",
  "3:2",
  "2:3",
  "5:4",
  "4:5",
]
export const CHETAIDOU_IMAGE_TIERS = ["1K", "2K", "4K"] as const
export type ImageTier = (typeof CHETAIDOU_IMAGE_TIERS)[number]
export interface ImageSelection {
  aspectRatio?: string
  customAspectW?: number
  customAspectH?: number
  resolutionTier?: string
  quality?: string
}
export interface ImageGenerationPlan {
  count: number
  quality?: string
  resolution: string
  resolutionTier: ImageTier
  requestedAspectRatio: string
  aspectRatio: string
  customAspectW?: number
  customAspectH?: number
  schemaVersion: number | string | null
  providerApplied: GatewaySizingIntent
  providerDefaults?: Record<string, unknown>
  warnings: string[]
  sizingAdjustments: string[]
  normalizationMode: "NONE" | "TARGET_SIZE" | "CROP_ONLY"
  plannerVersion: string
  generationPromptVersion: string
  targetWidth?: number
  targetHeight?: number
}

function invalid(message: string): never {
  throw new BadRequestException({ code: "IMAGE_GENERATION_PARAM_INVALID", message })
}
export function reduceImageRatio(w: number, h: number): string {
  if (![w, h].every(n => Number.isSafeInteger(n) && n > 0)) invalid("比例宽高必须为正安全整数")
  let a = w,
    b = h
  while (b) {
    const next = a % b
    a = b
    b = next
  }
  return `${w / a}:${h / a}`
}

function normalizeImageSelection(input: ImageSelection): ImageSelection {
  const result: ImageSelection = {}
  if (input.aspectRatio !== undefined) {
    if (typeof input.aspectRatio !== "string") invalid("aspectRatio 必须为比例字符串")
    const value = input.aspectRatio.trim()
    if (value === "custom") result.aspectRatio = value
    else {
      if (!/^[1-9]\d*:[1-9]\d*$/.test(value)) invalid("aspectRatio 应为正整数宽:高，或 custom")
      const [w, h] = value.split(":").map(Number)
      if (![w, h].every(n => Number.isSafeInteger(n) && n > 0)) invalid("比例宽高必须为正安全整数")
      result.aspectRatio = value
    }
  }
  for (const key of ["customAspectW", "customAspectH"] as const) {
    if (input[key] !== undefined) {
      if (!Number.isSafeInteger(input[key]) || input[key] <= 0)
        invalid("自定义比例宽高必须为正安全整数")
      result[key] = input[key]
    }
  }
  if (input.resolutionTier !== undefined) {
    if (typeof input.resolutionTier !== "string") invalid("resolutionTier 必须为尺寸档位字符串")
    const value = input.resolutionTier.trim().toUpperCase()
    if (!["1K", "2K", "3K", "4K"].includes(value)) invalid("尺寸档位仅支持 1K、2K、4K")
    result.resolutionTier = value
  }
  if (input.quality !== undefined) {
    if (typeof input.quality !== "string") invalid("图片质量必须为字符串")
    const value = input.quality.trim().toLowerCase()
    if (!(CHETAIDOU_IMAGE_QUALITIES as readonly string[]).includes(value))
      invalid("图片质量仅支持 standard（标准）或 hd（高清）")
    result.quality = value
  }
  return result
}

/** 哈希沿用旧约分规则，仅用于请求幂等，不作为生图或展示参数。 */
export function imageSelectionHashFields(input: ImageSelection): ImageSelection {
  const result = normalizeImageSelection(input)
  if (result.aspectRatio && result.aspectRatio !== "custom") {
    const [w, h] = result.aspectRatio.split(":").map(Number)
    result.aspectRatio = reduceImageRatio(w, h)
  }
  return result
}

export function resolveImageSelection(input: ImageSelection) {
  const normalized = normalizeImageSelection(input)
  if (!normalized.aspectRatio) invalid("新 GENERATE 请求必须由前端传入 aspectRatio")
  let ratio = normalized.aspectRatio
  if (ratio === "custom") {
    if (normalized.customAspectW === undefined || normalized.customAspectH === undefined)
      invalid("自定义比例必须传入宽高")
    ratio = `${normalized.customAspectW}:${normalized.customAspectH}`
  } else if (normalized.customAspectW !== undefined || normalized.customAspectH !== undefined)
    invalid("仅 aspectRatio=custom 时可传自定义比例宽高")
  const warnings = normalized.resolutionTier === "3K" ? ["3K 档位已下线，兼容转换为 2K"] : []
  const tier = (
    normalized.resolutionTier === "3K" ? "2K" : (normalized.resolutionTier ?? "1K")
  ) as ImageTier
  return { normalized, ratio, tier, warnings }
}

export function generationCanvasPrompt(prompt: string, ratio: string, crop = true): string {
  const canvas = `${prompt}\n\n[Generation canvas instruction]\nUse a final canvas aspect ratio of ${ratio}. This instruction overrides earlier instructions to keep the source canvas aspect ratio only. Preserve product identity, geometry, camera direction, text decisions, people decisions and all other approved edits. Compose the subject safely within the target canvas; avoid clipping important product details.`
  if (!crop) return canvas
  return `${canvas}

中心裁剪安全构图：
生成完成后，画面会从中心出发向外最大程度裁剪为${ratio}比例的图像画面。
将完整商品和所有重要视觉信息（如文字、 icon，小元素等）限制在画面中央的横向安全区域内。商品整体必须清楚完整，全部外轮廓均可见。
缩小商品在画面中的占比，并将其放在接近画面正中心的位置。商品上下左右均保留充足的、允许被裁掉的背景空间。
后续裁剪只能移除背景，不得裁掉商品、人物、文字或其他重要信息。不得将任何关键信息放在画面边缘。`
}

export function imageModelFingerprint(model: { publicId: string; gatewayConfig: unknown }): string {
  return stableHash({ publicId: model.publicId, gatewayConfig: model.gatewayConfig })
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item: unknown): item is string => typeof item === "string")
    : []
}

/** 普通生图与局部重绘统一提交比例/档位，并保留非尺寸参数校验。 */
export function planChetaidouImage(
  model: { publicId: string; gatewayConfig: unknown },
  input: ImageSelection,
  count: number,
  prompt = "Edit the referenced product image.",
  edit?: { width: number; height: number; referenceCount: number }
): ImageGenerationPlan {
  const { normalized, ratio, tier, warnings } = resolveImageSelection(input)
  const config = object(model.gatewayConfig)
  const schemaConfig = object(config?.requestSchema)
  const rawSchema = object(schemaConfig?.request_schema)
  if (
    !rawSchema ||
    typeof rawSchema !== "object" ||
    Array.isArray(rawSchema) ||
    !(rawSchema.properties || rawSchema.$ref || rawSchema.allOf || rawSchema.anyOf)
  )
    throw new ServiceUnavailableException({
      code: "MODEL_NOT_READY",
      message: "生图模型缺少有效请求参数配置，请联系管理员同步模型",
    })
  let schema: Record<string, unknown>
  try {
    schema = gatewayImageSizingSchema(rawSchema)
  } catch {
    throw new ServiceUnavailableException({
      code: "MODEL_NOT_READY",
      message: "生图模型请求参数引用无效，请联系管理员同步模型",
    })
  }
  const facts = object(object(config?.detail)?.facts)
  const modes = facts?.modes
  if (Array.isArray(modes) && !strings(modes).includes("edit"))
    throw new ServiceUnavailableException("当前生图模型不支持参考图编辑")
  let sizing: GatewaySizingPlanResult
  const request: Record<string, unknown> = {
    model: model.publicId,
    prompt,
    operation: "edit",
    n: 1,
    response_format: "url",
    callback: true,
    reference_images: Array.from({ length: edit?.referenceCount ?? 1 }, (_, i) => ({
      url: `https://example.com/chetaidou-reference-${i}.png`,
    })),
  }
  // 显式选择优先；旧客户端省略质量时保留模型默认行为。
  const providerDefaults: Record<string, unknown> = {}
  const qualityDefault = object(object(schema.properties)?.quality)?.default
  if (normalized.quality !== undefined) {
    request.quality = normalized.quality
  } else if (strings(schema.required).includes("quality") && qualityDefault !== undefined) {
    providerDefaults.quality = qualityDefault
    request.quality = providerDefaults.quality
  }
  try {
    const ajv = new Ajv({ strict: false, allErrors: true })
    addFormats(ajv)
    sizing = resolveGatewaySizingIntentDetailed({ aspectRatio: ratio, resolutionTier: tier })
    Object.assign(request, sizing.sizing, { strict: false })
    const validate = ajv.compile(gatewayImageSizingSchema(schema))
    if (!validate(request)) {
      if (
        normalized.quality !== undefined &&
        validate.errors?.some(
          error =>
            error.instancePath === "/quality" ||
            (error.keyword === "additionalProperties" &&
              error.params.additionalProperty === "quality")
        )
      )
        invalid("当前生图模型不支持所选图片质量，请选择其他质量")
      throw new ServiceUnavailableException({
        code: "MODEL_NOT_READY",
        message: "生图参数与当前模型配置不兼容，请联系管理员同步模型",
      })
    }
  } catch (error) {
    if (error instanceof ServiceUnavailableException || error instanceof BadRequestException)
      throw error
    throw new ServiceUnavailableException({
      code: "MODEL_NOT_READY",
      message: "生图模型请求参数配置无效，请联系管理员同步模型",
    })
  }
  return {
    count,
    ...(normalized.quality !== undefined ? { quality: normalized.quality } : {}),
    resolution: tier.toLowerCase(),
    resolutionTier: tier,
    requestedAspectRatio: normalized.aspectRatio!,
    aspectRatio: ratio,
    ...(normalized.aspectRatio === "custom"
      ? { customAspectW: normalized.customAspectW, customAspectH: normalized.customAspectH }
      : {}),
    schemaVersion:
      typeof schemaConfig?.version === "number" || typeof schemaConfig?.version === "string"
        ? schemaConfig.version
        : null,
    providerApplied: sizing.sizing,
    providerDefaults,
    warnings: [...warnings, ...sizing.adjustments],
    sizingAdjustments: sizing.adjustments,
    normalizationMode: "CROP_ONLY",
    plannerVersion: "chetaidou-image-v2",
    generationPromptVersion: edit ? "inpaint-v1" : "canvas-v2",
    ...(edit ? { targetWidth: edit.width, targetHeight: edit.height } : {}),
  }
}

@Injectable()
export class ChetaidouImageOptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayProvider
  ) {}

  async fetchCapabilities(publicId: string) {
    let snapshot: Awaited<ReturnType<AiGatewayProvider["fetchModelSnapshot"]>>
    try {
      snapshot = await this.gateway.fetchModelSnapshot(publicId, "images.generations")
    } catch {
      throw new ServiceUnavailableException("生图模型能力查询失败，请稍后重试")
    }
    if (!snapshot || snapshot.detail.modality !== "image")
      throw new ServiceUnavailableException("生图模型未就绪，请选择其他模型或稍后重试")
    return snapshot
  }

  async resolveModel(
    db: Pick<Prisma.TransactionClient, "aiGatewayModel"> = this.prisma,
    publicId?: string
  ) {
    const rows = await db.aiGatewayModel.findMany({
      where: {
        ...(publicId ? { publicId } : {}),
        category: CHETAIDOU_IMAGE_CATEGORY,
        modality: "IMAGE",
        enabled: true,
        gatewayActive: true,
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      take: 1,
    })
    if (rows.length === 0)
      throw new ServiceUnavailableException({
        code: "MODEL_NOT_READY",
        message: "车泰斗生图模型未就绪，请联系管理员配置可用模型",
      })
    return rows[0]
  }

  async assertUnchanged(tx: Prisma.TransactionClient, fingerprint: string, publicId?: string) {
    await tx.$queryRaw`SELECT id FROM AiGatewayModel WHERE modality = 'IMAGE' AND category = ${CHETAIDOU_IMAGE_CATEGORY} FOR UPDATE`
    const current = await this.resolveModel(tx, publicId)
    if (imageModelFingerprint(current) !== fingerprint)
      throw new ConflictException({
        code: "MODEL_CONFIG_CHANGED",
        message: "生图模型配置已更新，请重新提交生成任务",
      })
  }

  async assertRetryModel(
    tx: Prisma.TransactionClient,
    model: { publicId: string; category: string }
  ) {
    await tx.$queryRaw`SELECT id FROM AiGatewayModel WHERE modality = 'IMAGE' AND category = ${model.category} FOR UPDATE`
    const rows = await tx.aiGatewayModel.findMany({
      where: {
        category: model.category,
        publicId: model.publicId,
        modality: "IMAGE",
        enabled: true,
        gatewayActive: true,
      },
      take: 2,
    })
    if (rows.length !== 1)
      throw new BadRequestException({
        code: "MODEL_NOT_READY",
        message: "该任务原生图模型已停用或不可用，请使用当前配置重新生成",
      })
  }
}
