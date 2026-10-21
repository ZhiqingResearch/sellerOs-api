import sharp from "sharp"
import { cropImageToAspectRatio } from "./image-aspect-crop"

const image = (width: number, height: number, color = "white") =>
  sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()

describe("中心最大裁剪", () => {
  it.each([[1600, 900], [4096, 2304], [2048, 1152], [1024, 576]])("%s×%s 符合 16:9 时字节保持不变", async (w, h) => {
    const bytes = await image(w, h)
    const result = await cropImageToAspectRatio(bytes, 16, 9)
    expect(result.cropped).toBe(false)
    expect(result.bytes.equals(bytes)).toBe(true)
    expect([result.width, result.height]).toEqual([w, h])
  })
  it("中心裁剪保留中央像素，不缩放或拉伸", async () => {
    const bytes = await sharp(await image(120, 120, "blue")).composite([{ input: await image(120, 60, "red"), top: 30, left: 0 }]).png().toBuffer()
    const result = await cropImageToAspectRatio(bytes, 2, 1, "png")
    expect([result.width, result.height]).toEqual([120, 60])
    const pixel = await sharp(result.bytes).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer()
    expect([...pixel].slice(0, 3)).toEqual([255, 0, 0])
  })
  it("按 EXIF 展示方向裁剪并报告实际宽高", async () => {
    const bytes = await sharp(await image(120, 80)).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const result = await cropImageToAspectRatio(bytes, 1, 1, "png")
    expect(result).toMatchObject({ nativeWidth: 80, nativeHeight: 120, width: 80, height: 80, cropped: true })
    expect(await sharp(result.bytes).metadata()).toMatchObject({ width: 80, height: 80 })
  })
})
