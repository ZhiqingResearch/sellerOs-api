import sharp from "sharp"
import { aigcMetadata } from "./aigc-metadata"
import { labelImage, readImageAigc, watermarkBadge } from "./image-label"

describe("图片文件中的显式和隐式标识", () => {
  it.each(["png", "jpeg", "webp"] as const)("%s 下载字节包含标识且保留尺寸", async format => {
    const input = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#4586ac" },
    })
      .toFormat(format)
      .toBuffer()
    const result = await labelImage(input, `image-${format}`)
    const meta = await sharp(result.buffer).metadata()
    expect(meta).toMatchObject({ width: 400, height: 300, format })
    expect(readImageAigc(meta)).toEqual(aigcMetadata(`image-${format}`))
    const badge = await watermarkBadge(400, 300)
    expect(badge.textHeight).toBeGreaterThanOrEqual(300 * 0.05)
    const pixel = await sharp(result.buffer)
      .extract({ left: 390, top: 285, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer()
    expect([...pixel]).not.toEqual([69, 134, 172])
    expect(result.buffer).not.toEqual(input)
  })

  it("读取既有生成方，保持一份AIGC扩展并补传播编号；再次处理不堆叠元数据", async () => {
    const input = await sharp({
      create: { width: 300, height: 400, channels: 4, background: "transparent" },
    })
      .png()
      .toBuffer()
    const first = await labelImage(input, "first")
    const second = await labelImage(first.buffer, "second")
    const meta = await sharp(second.buffer).metadata()
    expect(readImageAigc(meta)?.AIGC).toMatchObject({
      ProduceID: "first",
      PropagateID: "second",
      Label: "1",
    })
    expect(meta.comments?.filter(item => item.keyword === "AIGC")).toHaveLength(1)
    expect(meta.hasAlpha).toBe(true)
  })

  it("EXIF旋转先落像素，水印放在最终显示的右下角", async () => {
    const input = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "white" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const result = await labelImage(input, "rotated")
    expect(await sharp(result.buffer).metadata()).toMatchObject({ width: 300, height: 400 })
  })

  it("损坏文件或无法显示水印的尺寸停止交付", async () => {
    await expect(labelImage(Buffer.from("invalid"))).rejects.toThrow()
    const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } })
      .png()
      .toBuffer()
    await expect(labelImage(tiny)).rejects.toThrow()
  })
})
