import sharp from "sharp"
import { aigcMetadata } from "./aigc-metadata"
import { labelImage, readImageAigc } from "./image-label"

describe("图片文件中的隐式标识", () => {
  it.each(["png", "jpeg", "webp"] as const)("%s 保留元数据标识和尺寸，不添加像素水印", async format => {
    const input = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#4586ac" },
    })
      .toFormat(format)
      .toBuffer()
    const result = await labelImage(input, `image-${format}`)
    const meta = await sharp(result.buffer).metadata()
    expect(meta).toMatchObject({ width: 400, height: 300, format })
    expect(readImageAigc(meta)).toEqual(aigcMetadata(`image-${format}`))
    const before = await sharp(input).removeAlpha().raw().toBuffer()
    const after = await sharp(result.buffer).removeAlpha().raw().toBuffer()
    expect(after.length).toBe(before.length)
    // JPEG/WebP 重新编码允许轻微色差，整幅图片都不应出现水印像素。
    expect(after.every((value, index) => Math.abs(value - before[index]) <= 3)).toBe(true)
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
    const before = await sharp(input).raw().toBuffer()
    const after = await sharp(second.buffer).raw().toBuffer()
    expect(after.equals(before)).toBe(true)
  })

  it("EXIF旋转仍落像素，输出最终显示尺寸", async () => {
    const input = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "white" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const result = await labelImage(input, "rotated")
    expect(await sharp(result.buffer).metadata()).toMatchObject({ width: 300, height: 400 })
  })

  it("损坏文件停止交付", async () => {
    await expect(labelImage(Buffer.from("invalid"))).rejects.toThrow()
  })

  it("小尺寸图片仍能写入元数据标识", async () => {
    const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } })
      .png()
      .toBuffer()
    const result = await labelImage(tiny, "tiny")
    const meta = await sharp(result.buffer).metadata()
    expect(meta).toMatchObject({ width: 1, height: 1 })
    expect(readImageAigc(meta)?.AIGC.PropagateID).toBe("tiny")
  })
})
