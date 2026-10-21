import axios from "axios"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import sharp from "sharp"
import { ListingAiInvocationDto } from "./dto/listing-ai.dto"
import {
  buildListingPreview,
  buildListingImageSystemPrompt,
  prepareListingScoreImages,
  validateListingImageUrl,
} from "./listing-score-images"

const IMAGE_URL = "https://m.media-amazon.com/images/I/test.jpg"
const WRAPPED_IMAGE_PREFIX =
  "https://m.media-amazon.com/images/W/BW_MEDIAX_AVIF_MEASUREMENT_1306696-T1/images"

describe("Listing 实际图片输入", () => {
  afterEach(() => jest.restoreAllMocks())

  it.each([
    "http://m.media-amazon.com/images/I/a.jpg",
    "https://127.0.0.1/images/I/a.jpg",
    "https://m.media-amazon.com.evil.test/images/I/a.jpg",
    "https://user:pass@m.media-amazon.com/images/I/a.jpg",
    "https://m.media-amazon.com:8443/images/I/a.jpg",
    "file:///tmp/a.jpg",
    "https://m.media-amazon.com/private/a.jpg",
    "https://m.media-amazon.com/images/W/experiment/private/a.jpg",
    "https://m.media-amazon.com/images/W/experiment/images/private/a.jpg",
    "https://m.media-amazon.com/images/W/experiment/extra/images/I/a.jpg",
    "https://m.media-amazon.com.evil.test/images/W/experiment/images/I/a.jpg",
    "http://m.media-amazon.com/images/W/experiment/images/I/a.jpg",
  ])("拒绝非可信图片地址 %s", url => {
    expect(() => validateListingImageUrl(url)).toThrow()
  })

  it("支持主图及 A+ CDN 路径", () => {
    expect(validateListingImageUrl(IMAGE_URL)).toBe(IMAGE_URL)
    expect(
      validateListingImageUrl("https://m.media-amazon.com/images/S/aplus-media/a.png")
    ).toContain("aplus-media")
  })

  it.each([
    `${WRAPPED_IMAGE_PREFIX}/I/71Fo+z9rjUL._AC_SY355_.jpg`,
    `${WRAPPED_IMAGE_PREFIX}/S/aplus-media-library-service-media/792c5940-ba3f-4554-84f3-e840cf03472a.__CR0,0,1464,600_PT0_SX1464_V1___.jpg`,
    `${WRAPPED_IMAGE_PREFIX}/G/01/aplus/a.jpg`,
  ])("支持 Amazon W 前缀图片并保留原始地址 %s", url => {
    expect(validateListingImageUrl(url)).toBe(url)
  })

  it("下载真实像素并按角色构造 base64 图片，而不是只把 URL 塞入文字", async () => {
    const data = await sharp({
      create: { width: 1200, height: 1000, channels: 3, background: "white" },
    })
      .png()
      .toBuffer()
    const download = jest.spyOn(axios, "get").mockResolvedValue({ data })
    const content = await prepareListingScoreImages("原始文字", [
      { url: IMAGE_URL, role: "main" },
      { url: IMAGE_URL, role: "aplus" },
    ])
    expect(content?.[0]).toEqual({ type: "text", text: "原始文字" })
    expect(content?.[1]).toMatchObject({
      text: expect.stringContaining("主图；后端读取的原始像素：1200×1000") as unknown,
    })
    expect(content?.[3]).toMatchObject({
      text: expect.stringContaining("页面图片标签：A+1；") as unknown,
    })
    expect(content?.[2]).toMatchObject({
      type: "image_url",
      image_url: {
        url: expect.stringMatching(/^data:image\/jpeg;base64,/) as unknown,
        detail: "high",
      },
    })
    expect(download).toHaveBeenCalledWith(
      IMAGE_URL,
      expect.objectContaining({ maxRedirects: 0, maxContentLength: 8 * 1024 * 1024 })
    )
  })

  it("整批先校验，遇到坏地址不发下载请求", async () => {
    const download = jest.spyOn(axios, "get")
    await expect(
      prepareListingScoreImages("文字", [
        { url: IMAGE_URL, role: "main" },
        { url: "https://localhost/a", role: "aplus" },
      ])
    ).rejects.toThrow()
    expect(download).not.toHaveBeenCalled()
  })

  it("8张主副图加17张A+始终使用页面标签，不出现累计附件编号", async () => {
    const data = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "white" },
    })
      .png()
      .toBuffer()
    jest.spyOn(axios, "get").mockResolvedValue({ data })
    const images = [
      { url: IMAGE_URL, role: "main" as const },
      ...Array.from({ length: 7 }, () => ({ url: IMAGE_URL, role: "secondary" as const })),
      ...Array.from({ length: 17 }, () => ({ url: IMAGE_URL, role: "aplus" as const })),
    ]
    const content = await prepareListingScoreImages("文字", images)
    const labels = [
      "主图",
      ...Array.from({ length: 7 }, (_, i) => `副图${i + 1}`),
      ...Array.from({ length: 17 }, (_, i) => `A+${i + 1}`),
    ]
    labels.forEach((label, index) => {
      expect(content?.[index * 2 + 1]).toMatchObject({
        text: expect.stringContaining(`页面图片标签：${label}；`) as unknown,
      })
      expect(content?.[index * 2 + 1]).toMatchObject({
        text: expect.stringContaining(label.startsWith("A+")
          ? "仅用于独立的 A+ 项；禁止用于主/副图项"
          : "证据归属：用于主/副图项") as unknown,
      })
    })
    expect(JSON.stringify(content)).not.toContain("附件")
    expect(content?.at(-1)).toMatchObject({
      text: expect.stringContaining(
        "主/副图共8张【主图、副图1、副图2、副图3、副图4、副图5、副图6、副图7】；A+共17张"
      ) as unknown,
    })
    expect(content?.at(-1)).toMatchObject({
      text: expect.stringContaining("只出现在 A+4、A+12、A+13 时，不能据此判定主/副图信息不一致") as unknown,
    })
    expect(content?.at(-1)).toMatchObject({
      text: expect.stringContaining("不能自动给满分") as unknown,
    })
    // 校验实际送出的 JPEG 与页面标签绑定，而不只检查旁边的文字。
    for (const [imageIndex, label] of [
      [13, "A+6"],
      [14, "A+7"],
    ] as const) {
      const part = content?.[imageIndex * 2 + 2]
      expect(part?.type).toBe("image_url")
      if (part?.type !== "image_url") throw new Error("缺少图片附件")
      const expected = await buildListingPreview(data, label)
      expect(part.image_url.url).toBe(`data:image/jpeg;base64,${expected.toString("base64")}`)
    }
    const prompt = buildListingImageSystemPrompt("原规则", images)
    expect(prompt).toContain("必须使用图片前标注的页面图片标签")
    expect(prompt).toContain("禁止使用跨分组累计")
    expect(prompt).toContain("不能把相邻图片的文字归到本图")
    expect(prompt).toContain("图片本身未添加识别标记")
  })

  it("标签只放在文本中，预览不添加背景或留白干扰评分", async () => {
    const data = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "white" },
    })
      .png()
      .toBuffer()
    const preview6 = await buildListingPreview(data, "A+6")
    const preview7 = await buildListingPreview(data, "A+7")
    expect(preview6.equals(preview7)).toBe(true)
    expect(await sharp(preview6).metadata()).toMatchObject({ width: 400, height: 300 })
    const body = await sharp(preview6).stats()
    expect(body.channels.every(channel => channel.min >= 250)).toBe(true)
    await expect(buildListingPreview(data, "<script>bad</script>")).rejects.toThrow(
      "标签无效"
    )
  })

  it("非图片数据不作为模型附件传入", async () => {
    jest.spyOn(axios, "get").mockResolvedValue({ data: Buffer.from("<html>not an image</html>") })
    await expect(
      prepareListingScoreImages("文字", [{ url: IMAGE_URL, role: "main" }])
    ).rejects.toThrow("尚未调用评分模型")
  })

  it("无图时完全保留原提示词和文本输入", async () => {
    expect(await prepareListingScoreImages("原文字")).toBeUndefined()
    expect(buildListingImageSystemPrompt("原评分规则")).toBe("原评分规则")
  })

  it("评估实图并按当前CDQ规则区分未获取的图组", () => {
    const prompt = buildListingImageSystemPrompt("原评分规则", [{ url: IMAGE_URL, role: "main" }])
    expect(prompt).toContain("原评分规则")
    expect(prompt).toContain("主/副图1张，A+ 图片0张")
    expect(prompt).toContain("CDQ采用当前提示词标准")
    expect(prompt).toContain("标未获取、得分留空")
    expect(prompt).toContain("字段当前值、规则和修改建议")
  })

  it.each([
    { images: [{ url: IMAGE_URL, role: "aplus" as const }] },
    { images: [{ url: IMAGE_URL, role: "main" as const }, { url: IMAGE_URL, role: "aplus" as const }] },
  ])("A+ 证据只归独立 A+ 项，不影响主副图评分", ({ images }) => {
    const prompt = buildListingImageSystemPrompt("原评分规则", images)
    expect(prompt).toContain("仅评主图和副图，不评判 A+")
    expect(prompt).toContain("不能用 A+ 补足主/副图证据")
    expect(prompt).toContain("不得跨项重复扣分")
    expect(prompt).toContain("CDQ采用当前提示词标准")
  })

  it("DTO 接受截图中的25张图片并拒绝超量及错误角色", async () => {
    const images = Array.from({ length: 25 }, () => ({ url: IMAGE_URL, role: "aplus" }))
    expect(
      await validate(
        plainToInstance(ListingAiInvocationDto, { operation: "score", model: "qwen3.8-max", userPrompt: "文字", images })
      )
    ).toHaveLength(0)
    expect(
      (
        await validate(
          plainToInstance(ListingAiInvocationDto, {
            operation: "score", model: "qwen3.8-max",
            userPrompt: "文字",
            images: Array(41).fill(images[0]),
          })
        )
      ).length
    ).toBeGreaterThan(0)
    expect(
      (
        await validate(
          plainToInstance(ListingAiInvocationDto, {
            operation: "score", model: "qwen3.8-max",
            userPrompt: "文字",
            images: [{ url: IMAGE_URL, role: "other" }],
          })
        )
      ).length
    ).toBeGreaterThan(0)
  })
})
