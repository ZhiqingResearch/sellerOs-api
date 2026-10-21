import { Logger } from "@nestjs/common"
import sharp from "sharp"

const logger = new Logger("DeliveredImageDimensions")

/** 只在缺尺寸时读取最终文件；探测失败不能丢掉已生成的图片。 */
export async function resolveDeliveredImageDimensions(
  url: string,
  known: { width?: number; height?: number },
  signal?: AbortSignal
): Promise<{ width?: number; height?: number }> {
  if (known.width && known.width > 0 && known.height && known.height > 0) {
    return known
  }
  try {
    const timeout = AbortSignal.timeout(10_000)
    const response = await fetch(url, {
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const { width, height } = await sharp(bytes).metadata()
    if (!width || !height) throw new Error("无法读取图片宽高")
    return { width, height }
  } catch (error) {
    logger.warn(
      `图片尺寸探测失败，保留生成结果：${error instanceof Error ? error.message : String(error)}`
    )
    return known
  }
}
