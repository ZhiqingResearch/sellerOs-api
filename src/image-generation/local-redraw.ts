import { BadRequestException, ServiceUnavailableException } from "@nestjs/common"
import sharp from "sharp"
import { cropImageToAspectRatio } from "../common/utils/image-aspect-crop"
import type { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import { resolveGatewayImageSizing } from "../ai-gateway/gateway-native-image-sizing"
import { PrismaService } from "../prisma/prisma.service"
import { imageMetadata } from "../common/utils/generation-metadata"
import {
  LOCAL_REDRAW_CATEGORY,
  LOCAL_REDRAW_MODEL,
  LocalRedrawPlan,
} from "./local-redraw.constants"

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function imageSize(bytes: Uint8Array) {
  const meta = await sharp(bytes).metadata()
  if (!meta.width || !meta.height) throw new Error("图片无法解析尺寸")
  const rotated = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8
  return rotated
    ? { width: meta.height, height: meta.width }
    : { width: meta.width, height: meta.height }
}

/** 优先最近一次生成的快照；旧重绘缺档位时不冒用其继承的祖先配置。 */
export function sourceImageResolutionTier(task: Parameters<typeof imageMetadata>[0]) {
  const spec = object(task.executionSpec), config = object(task.promptConfig)
  const redraw = object(spec.localRedraw ?? config.localRedraw)
  const value = Object.keys(redraw).length
    ? redraw.resolutionTier ?? object(redraw.providerApplied).resolution
    : imageMetadata(task).resolutionTier ?? config.resolutionTier ??
      object(config.deliveryTarget).resolutionTier ?? object(config.model_params).resolution
  const tier = typeof value === "string" ? value.toUpperCase() : undefined
  return tier === "1K" || tier === "2K" || tier === "4K" ? tier : undefined
}

export async function prepareLocalRedraw(
  prisma: Pick<PrismaService, "aiGatewayModel">,
  references: Array<string | Uint8Array>,
  gateway: Pick<AiGatewayProvider, "fetchModelSnapshot">,
  prompt: string,
  sourceTier?: LocalRedrawPlan["resolutionTier"]
): Promise<LocalRedrawPlan> {
  if (references.length < 2) throw new BadRequestException("局部重绘必须提供原图和标注图")
  const model = await prisma.aiGatewayModel.findUnique({
    where: { publicId_category: { publicId: LOCAL_REDRAW_MODEL, category: LOCAL_REDRAW_CATEGORY } },
  })
  if (!model?.enabled || !model.gatewayActive || model.modality !== "IMAGE") {
    throw new ServiceUnavailableException("局部重绘模型未就绪，请初始化 LOCAL_REDRAW 模型配置")
  }
  const facts = object(object(object(model.gatewayConfig).detail).facts)
  if (!Array.isArray(facts.modes) || !facts.modes.includes("edit")) {
    throw new ServiceUnavailableException("局部重绘模型不支持参考图编辑，请同步模型配置")
  }
  if (
    typeof facts.max_reference_images !== "number" ||
    references.length > facts.max_reference_images
  ) {
    throw new BadRequestException("局部重绘参考图数量超过模型限制")
  }
  let source: { width: number; height: number }, marked: typeof source
  try {
    const bytes = await Promise.all(
      references.slice(0, 2).map(async reference => {
        if (typeof reference !== "string") return reference
        const response = await fetch(reference, { signal: AbortSignal.timeout(30_000) })
        if (!response.ok) throw new Error("图片读取失败")
        return new Uint8Array(await response.arrayBuffer())
      })
    )
    ;[source, marked] = await Promise.all(bytes.map(imageSize))
  } catch {
    throw new BadRequestException("局部重绘原图或标注图读取失败")
  }
  if (source.width !== marked.width || source.height !== marked.height) {
    throw new BadRequestException("标注图必须与原图宽高一致，请按原图尺寸导出标注图")
  }
  const longSide = Math.max(source.width, source.height)
  const tier = sourceTier ?? (longSide <= 1024 ? "1K" : longSide <= 2048 ? "2K" : "4K")
  const snapshot = await gateway.fetchModelSnapshot(model.publicId, "images.generations")
  if (!snapshot || snapshot.detail.modality !== "image")
    throw new ServiceUnavailableException("局部重绘模型未就绪，请同步模型配置")
  let sizing: ReturnType<typeof resolveGatewayImageSizing>
  try {
    sizing = resolveGatewayImageSizing(snapshot, `${source.width}:${source.height}`, tier, {
      model: model.publicId, prompt, operation: "edit", n: 1,
      response_format: "url", callback: true, strict: false,
      reference_images: references.map((reference, index) => ({
        url: typeof reference === "string" ? reference : `https://example.com/reference-${index}.png`,
      })),
    })
  } catch (error) {
    if (error instanceof BadRequestException) throw error
    throw new ServiceUnavailableException("局部重绘模型参数配置无效，请同步模型配置")
  }
  if (!sizing?.aspect_ratio || !sizing.resolution)
    throw new ServiceUnavailableException("局部重绘参数与模型配置不兼容，请同步模型配置")
  const edge = Number(tier[0]) * 1024
  const ratio = source.width / source.height
  return {
    provider: model.publicId, sourceWidth: source.width, sourceHeight: source.height,
    generationWidth: ratio >= 1 ? edge : Math.round(edge * ratio),
    generationHeight: ratio >= 1 ? Math.round(edge / ratio) : edge,
    resolutionTier: tier,
    providerApplied: { ...sizing, aspect_ratio: sizing.aspect_ratio, resolution: sizing.resolution },
  }
}

export async function finalizeLocalRedraw(
  bytes: Uint8Array,
  target: Pick<LocalRedrawPlan, "sourceWidth" | "sourceHeight">
) {
  const result = await cropImageToAspectRatio(bytes, target.sourceWidth, target.sourceHeight, "png")
  return {
    ...result,
    native: { width: result.nativeWidth, height: result.nativeHeight },
  }
}
