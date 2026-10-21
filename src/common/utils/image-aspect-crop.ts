import sharp from "sharp"

/** 整数像素的单像素舍入视为相同比例。 */
export function sameImageRatio(width: number, height: number, targetWidth: number, targetHeight: number) {
  return Math.abs(width - height * targetWidth / targetHeight) <= Math.max(1, targetWidth / targetHeight)
}

/** 只按实际画布中心裁剪，不按清晰度档位缩放；比例一致时保留原始字节。 */
export async function cropImageToAspectRatio(
  input: Uint8Array,
  targetWidth: number,
  targetHeight: number,
  outputFormat?: string | null,
) {
  if (![targetWidth, targetHeight].every(value => Number.isFinite(value) && value > 0))
    throw new Error("图片目标比例不合法")
  const bytes = Buffer.from(input)
  const metadata = await sharp(bytes).metadata()
  if (!metadata.width || !metadata.height) throw new Error("图片无法解析尺寸")
  const rotated = (metadata.orientation ?? 1) >= 5 && (metadata.orientation ?? 1) <= 8
  const nativeWidth = rotated ? metadata.height : metadata.width
  const nativeHeight = rotated ? metadata.width : metadata.height
  if (sameImageRatio(nativeWidth, nativeHeight, targetWidth, targetHeight)) {
    return {
      bytes, width: nativeWidth, height: nativeHeight, nativeWidth, nativeHeight,
      mimeType: `image/${metadata.format ?? "png"}`, cropped: false, ops: [] as string[],
    }
  }
  const ratio = targetWidth / targetHeight
  const width = Math.max(1, Math.min(nativeWidth, Math.round(nativeHeight * ratio)))
  const height = Math.max(1, Math.min(nativeHeight, Math.round(nativeWidth / ratio)))
  let pipeline = sharp(bytes).rotate().extract({
    left: Math.floor((nativeWidth - width) / 2),
    top: Math.floor((nativeHeight - height) / 2),
    width, height,
  })
  const format = outputFormat === "webp" ? "webp"
    : outputFormat === "png" || (!outputFormat && metadata.hasAlpha) ? "png" : "jpeg"
  pipeline = format === "png" ? pipeline.png()
    : format === "webp" ? pipeline.webp({ quality: 95 })
    : pipeline.jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
  return {
    bytes: await pipeline.toBuffer(), width, height, nativeWidth, nativeHeight,
    mimeType: `image/${format}`, cropped: true, ops: ["crop:centre", `reencode:${format}`],
  }
}
