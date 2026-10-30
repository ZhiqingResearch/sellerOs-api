import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common"
import type { ImageTaskArtifact } from "@zhiqingresearch/ai-ts-sdk"
import axios from "axios"
import sharp from "sharp"
import { labelImage } from "../aigc/image-label"
import { retryDelivery } from "../aigc/aigc-metadata"
import { objectAigcMetadata } from "../aigc/media-delivery"
import { cropImageToAspectRatio } from "../common/utils/image-aspect-crop"
import type { PortraitDeliveryPlan } from "../image-project/portrait-size-planner"
import { SpacesService } from "../spaces/spaces.service"

export interface ImageArtifactTask {
  id: number
  userId: number
  projectId: number
  generationMode: string
  deliveryPlan: unknown
  /** 生成请求里经模型 facts 校验过的 output_format（promptConfig.model_params），后处理按它编码 */
  outputFormat?: string | null
}

export interface StoredImageArtifact {
  url: string
  originalUrl: string | null
  width: number | null
  height: number | null
  nativeWidth: number | null
  nativeHeight: number | null
  deliveryMeta: Record<string, unknown> | null
  delivery?: {
    strategy: string
    nativeResolution: boolean | null
  }
  warnings: string[]
}

// 裁切幅度超过该值时向任务 plan 透出提示（只影响告警文案，不影响裁切行为）
const HEAVY_CROP_WARNING_RATIO = 0.1

function asPlan(value: unknown): PortraitDeliveryPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const plan = value as PortraitDeliveryPlan
  if (
    !plan.requested ||
    !Number.isInteger(plan.requested.width) ||
    !Number.isInteger(plan.requested.height) ||
    !plan.delivery
  ) {
    return null
  }
  return plan
}

@Injectable()
export class AiGatewayImageArtifactService {
  private readonly logger = new Logger(AiGatewayImageArtifactService.name)

  constructor(private readonly spaces: SpacesService) {}

  private async upload(buffer: Buffer, key: string): Promise<string> {
    const result = await retryDelivery(() => labelImage(buffer, key))
    return this.spaces.uploadBuffer(result.buffer, key, result.mime, "public-read", objectAigcMetadata(result.metadata))
  }

  async store(
    task: ImageArtifactTask,
    imageId: number,
    artifact: ImageTaskArtifact
  ): Promise<StoredImageArtifact> {
    const response = await axios.get<ArrayBuffer>(artifact.url, {
      responseType: "arraybuffer",
      timeout: 120_000,
      maxContentLength: 30 * 1024 * 1024,
    })
    const buffer = Buffer.from(response.data)
    if (!buffer.length) throw new ServiceUnavailableException("模型返回了空图片")

    const header = response.headers["content-type"]
    const sourceMime =
      typeof header === "string" && header.toLowerCase().startsWith("image/")
        ? header.split(";")[0]
        : "image/png"
    const sourceExtension = this.extension(sourceMime)
    const resultPrefix =
      task.generationMode === "AI_SPLIT" ? "ai-split-results" : "portrait-results"
    // 所有有效交付计划统一按实际比例检查和中心裁剪。
    const plan = asPlan(task.deliveryPlan)

    // 所有模式独立留存原始文件；失败时继续既有成品处理。
    const originalKey = `portrait-originals/${task.userId}/${task.projectId}/${task.id}/${imageId}.${sourceExtension}`
    let originalUrl: string | null = null
    try {
      originalUrl = await this.upload(buffer, originalKey)
    } catch {
      this.logger.warn({ event: "image_artifact.original_save_failed", taskId: task.id, imageId })
    }

    if (!plan) {
      const dimensions = await this.imageSize(buffer).catch(() => ({ width: null, height: null }))
      const key = `${resultPrefix}/${task.userId}/${task.projectId}/${task.id}/${imageId}.${sourceExtension}`
      const url = await this.upload(buffer, key)
      return {
        url,
        originalUrl,
        width: dimensions.width,
        height: dimensions.height,
        nativeWidth: dimensions.width,
        nativeHeight: dimensions.height,
        deliveryMeta: null,
        warnings: [],
      }
    }

    try {
      const processed = await this.processPortrait(
        buffer,
        plan,
        task.outputFormat,
        sourceMime
      )
      const outputExtension = this.extension(processed.mimeType)
      const resultKey = `${resultPrefix}/${task.userId}/${task.projectId}/${task.id}/${imageId}.${outputExtension}`
      const url = await this.upload(processed.buffer, resultKey)
      return {
        url,
        originalUrl,
        width: processed.width,
        height: processed.height,
        nativeWidth: processed.nativeWidth,
        nativeHeight: processed.nativeHeight,
        deliveryMeta: {
          strategy: processed.strategy,
          fit: processed.fit,
          nativeResolution: processed.nativeResolution,
          fallbackOriginal: false,
          cropRatio: processed.cropRatio,
          ops: processed.ops,
        },
        delivery: {
          strategy: processed.strategy,
          nativeResolution: processed.nativeResolution,
        },
        warnings: processed.warnings,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知图片处理错误"
      this.logger.error(
        `[AI Gateway] 人像图片后处理失败，已返回模型原图 task=${task.id} image=${imageId}: ${message}`
      )
      const metadata = await this.imageSize(buffer).catch(() => ({
        width: null,
        height: null,
      }))
      const nativeResolution =
        metadata.width !== null && metadata.height !== null
          ? Math.max(metadata.width, metadata.height) >=
            Math.max(plan.requested.width, plan.requested.height)
          : null
      const fallbackUrl = originalUrl ?? await this.upload(buffer, originalKey)
      return {
        url: fallbackUrl,
        originalUrl: fallbackUrl,
        width: metadata.width,
        height: metadata.height,
        nativeWidth: metadata.width,
        nativeHeight: metadata.height,
        deliveryMeta: {
          strategy: "fallback_original",
          nativeResolution,
          fallbackOriginal: true,
          errorMessage: message.slice(0, 500),
        },
        delivery: {
          strategy: "fallback_original",
          nativeResolution,
        },
        warnings: ["图片后处理失败，已返回模型原图"],
      }
    }
  }

  private async processPortrait(
    buffer: Buffer,
    plan: PortraitDeliveryPlan,
    requestedOutputFormat?: string | null,
    sourceMime?: string
  ) {
    await sharp(buffer, { limitInputPixels: 100_000_000 }).metadata()
    const [w, h] = plan.requested.aspectRatio.split(":").map(Number)
    const result = await cropImageToAspectRatio(buffer, w, h, requestedOutputFormat)
    const nativeResolution = Math.max(result.nativeWidth, result.nativeHeight) >= Math.max(plan.requested.width, plan.requested.height)
    const cropRatio = 1 - result.width * result.height / (result.nativeWidth * result.nativeHeight)
    const warnings: string[] = []
    if (cropRatio > HEAVY_CROP_WARNING_RATIO)
      warnings.push(`模型输出比例与目标比例差异较大，已按目标比例中心裁切对齐（约裁切 ${Math.round(cropRatio * 100)}%）`)
    return {
      buffer: result.bytes, mimeType: result.cropped ? result.mimeType : sourceMime ?? result.mimeType,
      width: result.width, height: result.height,
      nativeWidth: result.nativeWidth, nativeHeight: result.nativeHeight,
      strategy: result.cropped ? "crop_to_ratio" : "passthrough",
      fit: result.cropped ? "cover" : "none", cropRatio, nativeResolution, warnings,
      ops: result.cropped ? result.ops : ["passthrough"],
    }
  }

  private async imageSize(
    buffer: Buffer
  ): Promise<{ width: number | null; height: number | null }> {
    const metadata = await sharp(buffer).metadata()
    const rotated = (metadata.orientation ?? 1) >= 5 && (metadata.orientation ?? 1) <= 8
    return { width: (rotated ? metadata.height : metadata.width) ?? null, height: (rotated ? metadata.width : metadata.height) ?? null }
  }

  private extension(mimeType: string) {
    if (mimeType.includes("jpeg")) return "jpg"
    if (mimeType.includes("webp")) return "webp"
    if (mimeType.includes("gif")) return "gif"
    return "png"
  }
}
