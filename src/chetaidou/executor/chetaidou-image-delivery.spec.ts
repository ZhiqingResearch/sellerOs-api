import sharp from "sharp"
import * as normalize from "../../image-generation/providers/gateway-size-normalize"
import { planChetaidouImage } from "../chetaidou-image-options.service"
import { prepareChetaidouImage } from "./chetaidou-image-delivery"
const imageModelFixture = {
  publicId: "gpt-image-2.5-sunburst",
  gatewayConfig: {
    requestSchema: { version: 1, request_schema: { type: "object", properties: {} } },
  },
}

const image = (width: number, height: number, alpha = false) =>
  sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: { r: 12, g: 90, b: 20, alpha: 0.8 },
    },
  })
    .png()
    .toBuffer()
const snapshot = (ratio: string, tier = "1K", model = "other-image") =>
  ({
    models: { image: { publicId: model } },
    generation: planChetaidouImage(
      { ...imageModelFixture, publicId: model },
      { aspectRatio: ratio, resolutionTier: tier },
      1
    ),
  }) as any

describe("车泰斗复用通用生图裁剪", () => {
  const env = { ...process.env }
  beforeEach(() => {
    delete process.env.IMAGE_GATEWAY_SIZE_NORMALIZE
    delete process.env.IMAGE_GATEWAY_SIZE_NORMALIZE_SKIP
    delete process.env.IMAGE_GATEWAY_NORMALIZE_MAX_PIXELS
  })
  afterEach(() => {
    process.env = { ...env }
  })

  it("局部重绘使用成品像素目标，不按历史 1K 档位缩小", async () => {
    const frozen = snapshot("3:4")
    Object.assign(frozen.generation, { targetWidth: 1536, targetHeight: 2048 })
    const delivered = await prepareChetaidouImage(await image(1536, 2048), frozen)
    expect([delivered.width, delivered.height]).toEqual([1536, 2048])
  })
  it("Sunburst 降档后只裁比例，不补回 4K", async () => {
    const result = await prepareChetaidouImage(
      await image(1536, 2048),
      snapshot("2:3", "4K", imageModelFixture.publicId)
    )
    expect(result.height).toBe(2048)
    expect(result.width).toBe(1365)
    expect(result.generationMeta.adaptation).toBe("CROP_ONLY")
    expect(result.generationMeta.normalized?.ops.some(op => op.startsWith("upscale"))).toBe(false)
  })

  it("透明产物继续保存 PNG", async () => {
    const result = await prepareChetaidouImage(await image(400, 800, true), snapshot("1:1"))
    expect(result).toMatchObject({ mime: "image/png", extension: "png" })
    expect((await sharp(result.bytes).metadata()).hasAlpha).toBe(true)
  })
  it("自定义比例按比例归一，不把比例数字当像素", async () => {
    const result = await prepareChetaidouImage(await image(1024, 1024), snapshot("83:91"))
    expect(result.width / result.height).toBeCloseTo(83 / 91, 2)
    expect(result.height).toBe(1024)
  })
  it("快路径保持原始字节，记录 UNCHANGED", async () => {
    const bytes = await image(1024, 1024)
    const result = await prepareChetaidouImage(bytes, snapshot("1:1"))
    expect(result.bytes.equals(bytes)).toBe(true)
    expect(result.generationMeta).toMatchObject({
      adaptation: "UNCHANGED",
      normalized: null,
      warnings: [],
    })
  })

  it("历史无比例快照保持原交付；不可读产物抛错供 DELIVERY_PENDING 恢复", async () => {
    const bytes = await image(600, 800)
    expect(
      (
        await prepareChetaidouImage(bytes, { generation: { resolution: "1k" } } as any)
      ).bytes.equals(bytes)
    ).toBe(true)
    await expect(prepareChetaidouImage(Buffer.from("invalid"), snapshot("1:1"))).rejects.toThrow()
  })
  it("裁剪函数返回 null 但尺寸不符时记录保原图告警，不能误标 UNCHANGED", async () => {
    const spy = jest.spyOn(normalize, "normalizeGatewayImage").mockResolvedValueOnce(null)
    try {
      const bytes = await image(600, 800)
      const result = await prepareChetaidouImage(bytes, snapshot("16:9"))
      expect(result.bytes.equals(bytes)).toBe(true)
      expect(result.generationMeta.adaptation).toBe("KEPT_ORIGINAL")
      expect(result.generationMeta.warnings).toContainEqual(expect.stringContaining("未完成"))
    } finally {
      spy.mockRestore()
    }
  })
})

describe("车泰斗全部产物按实际比例检查", () => {
  it.each(["NONE", "TARGET_SIZE", "CROP_ONLY"])("旧 %s 标记也不跳过实际比例检查", async normalizationMode => {
    const task = snapshot("16:9", "4K")
    task.generation.normalizationMode = normalizationMode
    const result = await prepareChetaidouImage(await image(160, 120), task)
    expect(result).toMatchObject({ width: 160, height: 90, generationMeta: { adaptation: "CROP_ONLY" } })
  })
  it("相同比例不按历史档位或重绘像素尺寸缩放", async () => {
    const bytes = await image(160, 90)
    const task = snapshot("16:9", "4K")
    Object.assign(task.generation, { targetWidth: 1920, targetHeight: 1080 })
    const result = await prepareChetaidouImage(bytes, task)
    expect(result.bytes.equals(bytes)).toBe(true)
    expect(result).toMatchObject({ width: 160, height: 90, generationMeta: { adaptation: "UNCHANGED" } })
  })
})
