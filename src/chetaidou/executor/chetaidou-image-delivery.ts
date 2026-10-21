import sharp from "sharp"
import {
  DEFAULT_NORMALIZE_MAX_PIXELS,
  normalizeGatewayImage,
} from "../../image-generation/providers/gateway-size-normalize"
import { sameImageRatio } from "../../common/utils/image-aspect-crop"
import { TaskSnapshot } from "../chetaidou-context.service"

/** 复用通用生图的实际裁剪器；读图/转存失败仍由 runner 的 DELIVERY_PENDING 处理。 */
export async function prepareChetaidouImage(bytes: Buffer, snapshot: TaskSnapshot) {
  const native = await sharp(bytes, { limitInputPixels: false }).metadata()
  if (!native.width || !native.height) throw new Error("产物无法解析尺寸")
  const generation = snapshot.generation
  const warnings = [...(generation?.warnings ?? [])]
  if ((native.orientation ?? 1) >= 5 && (native.orientation ?? 1) <= 8)
    [native.width, native.height] = [native.height, native.width]
  let adaptation = "LEGACY_ORIGINAL"
  let normalized: { from: string; to: string; ops: string[] } | null = null
  let output = bytes
  if (generation?.aspectRatio) {
    try {
      const [w, h] = generation.aspectRatio.split(":").map(Number)
      const limit = Number(process.env.IMAGE_GATEWAY_NORMALIZE_MAX_PIXELS)
      const maxPixels = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_NORMALIZE_MAX_PIXELS
      if (native.width * native.height > maxPixels) {
        adaptation = "SKIPPED_MAX_PIXELS"
        warnings.push("产物超过尺寸归一化处理像素范围，交付原始产物")
      } else {
        const result = await normalizeGatewayImage({
          bytes,
          targetWidth: w,
          targetHeight: h,
          maxPixels,
          cropPosition: "centre",
        })
        if (result) {
          output = Buffer.from(result.dataUrl.slice(result.dataUrl.indexOf(",") + 1), "base64")
          normalized = { from: result.from, to: result.to, ops: result.ops }
          adaptation = "CROP_ONLY"
        } else {
          adaptation = sameImageRatio(native.width, native.height, w, h) ? "UNCHANGED" : "KEPT_ORIGINAL"
          if (adaptation === "KEPT_ORIGINAL")
            warnings.push("尺寸归一化未完成，交付原始产物；请以实际宽高为准")
        }
      }
    } catch {
      adaptation = "KEPT_ORIGINAL"
      warnings.push("尺寸归一化失败，交付原始产物；请以实际宽高为准")
    }
  }
  const actual = await sharp(output, { limitInputPixels: false }).metadata()
  if ((actual.orientation ?? 1) >= 5 && (actual.orientation ?? 1) <= 8)
    [actual.width, actual.height] = [actual.height, actual.width]
  const format = actual.format ?? "png"
  return {
    bytes: output,
    width: actual.width,
    height: actual.height,
    mime: `image/${format}`,
    extension: format === "jpeg" ? "jpg" : format,
    generationMeta: {
      nativeWidth: native.width,
      nativeHeight: native.height,
      actual: { width: actual.width, height: actual.height, format },
      providerApplied: { ...generation?.providerApplied },
      normalized,
      sizingAdjusted: generation?.sizingAdjustments ?? [],
      adaptation,
      warnings,
    },
  }
}
