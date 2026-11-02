import { BadRequestException, ServiceUnavailableException } from "@nestjs/common"
import type { ImageTask } from "@zhiqingresearch/ai-ts-sdk"
import sharp from "sharp"
import { seedLocalRedrawModel } from "../../prisma/seed/local-redraw"
import type { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import type { PrismaService } from "../prisma/prisma.service"
import { gatewayImageDimensions } from "../common/utils/generation-metadata"
import * as storage from "./core/storage"
import { ProviderGenerateInput } from "./core/types"
import { finalizeLocalRedraw, prepareLocalRedraw, sourceImageResolutionTier } from "./local-redraw"
import { LocalRedrawPlan } from "./local-redraw.constants"
import { createGatewayImageProvider } from "./providers/gateway-image.provider"

function model() {
  return {
    publicId: "ZQ-Image-2",
    modality: "IMAGE",
    enabled: true,
    gatewayActive: true,
    displayName: "ZQ-Image-2",
    execMode: "ASYNC",
    priceMultiplier: "3",
    fixedCredits: "10",
    syncedAt: new Date(),
    gatewayConfig: {
      detail: {
        facts: {
          modes: ["edit"],
          max_reference_images: 10,
          size_capability: {
            min_pixels: 1048576,
            max_pixels: 1572864,
            ratio_min: 0.6667,
            ratio_max: 1.5,
          },
        },
      },
    },
  }
}

const image = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: "white" },
  })
    .png()
    .toBuffer()

const plan: LocalRedrawPlan = {
  provider: "ZQ-Image-2",
  sourceWidth: 3000,
  sourceHeight: 2000,
  generationWidth: 1536,
  generationHeight: 1024,
}

describe("共享局部重绘规则", () => {
  const db = () => ({ aiGatewayModel: { findFirst: jest.fn().mockResolvedValue(model()) } })
  const gateway = () => ({ fetchModelSnapshot: jest.fn().mockResolvedValue({
    detail: { modality: "image", facts: {} },
    requestSchema: { request_schema: { type: "object" } },
  }) })
  const prepare = (prisma: ReturnType<typeof db>, refs: Array<Uint8Array | string>) =>
    prepareLocalRedraw(prisma as unknown as PrismaService, refs, gateway() as never, "只修改框1")

  function nativeGateway() {
    const gw = gateway()
    gw.fetchModelSnapshot.mockResolvedValue({
      detail: { modality: "image", facts: {} },
      requestSchema: { request_schema: {
        type: "object",
        required: ["quality"],
        properties: {
          aspect_ratio: { enum: ["16:9", "9:16", "21:9", "3:2"] },
          resolution: { enum: ["1k", "2k", "4k"] },
          quality: { enum: ["standard"], default: "standard" },
        },
      } },
    })
    return gw
  }

  it.each([
    [{ executionSpec: { form: { resolutionTier: "4K" } } }, "4K"],
    [{ deliveryPlan: { requested: { resolutionTier: "4K" } } }, "4K"],
    [{ promptConfig: { resolutionTier: "2K" } }, "2K"],
    [{ promptConfig: { model_params: { resolution: "4k" } } }, "4K"],
    [{ executionSpec: { localRedraw: { resolutionTier: "2K" }, form: { resolutionTier: "4K" } } }, "2K"],
    [{ promptConfig: { localRedraw: { providerApplied: { resolution: "2k" } }, resolutionTier: "4K" } }, "2K"],
    [{ promptConfig: { localRedraw: { generationWidth: 1024 }, resolutionTier: "4K" } }, undefined],
    [{ executionSpec: { form: { resolutionTier: "3K" } } }, undefined],
  ])("读取最近一次生成的档位 %j", (task, tier) => {
    expect(sourceImageResolutionTier(task)).toBe(tier)
  })

  it("没有旧数值尺寸配置时仍可按网关原生能力生成", async () => {
    const prisma = db(), configured = model()
    delete (configured.gatewayConfig.detail.facts as { size_capability?: unknown }).size_capability
    prisma.aiGatewayModel.findFirst.mockResolvedValue(configured)
    const original = await image(1920, 1080)
    expect(await prepareLocalRedraw(prisma as never, [original, original], nativeGateway() as never, "移动文字"))
      .toMatchObject({ providerApplied: { aspect_ratio: "1920:1080", resolution: "2k" } })
  })

  it("按分类读取启用模型，不固定模型名称", async () => {
    const prisma = db(), selected = { ...model(), publicId: "configured-redraw-model" }
    prisma.aiGatewayModel.findFirst.mockResolvedValue(selected)
    const original = await image(1920, 1080), gw = nativeGateway()
    const result = await prepareLocalRedraw(prisma as never, [original, original], gw as never, "改色")
    expect(result.provider).toBe(selected.publicId)
    expect(prisma.aiGatewayModel.findFirst).toHaveBeenCalledWith({
      where: { category: "LOCAL_REDRAW", modality: "IMAGE", enabled: true, gatewayActive: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    })
    expect(gw.fetchModelSnapshot).toHaveBeenCalledWith(selected.publicId, "images.generations")
  })

  it("实时能力读取失败时不按旧配置猜测原生支持", async () => {
    const gw = gateway()
    gw.fetchModelSnapshot.mockRejectedValue(new ServiceUnavailableException("网关不可用"))
    const original = await image(1920, 1080)
    await expect(prepareLocalRedraw(db() as never, [original, original], gw as never, "移动文字"))
      .rejects.toThrow("网关不可用")
  })

  it("校验标注尺寸和参考图数量", async () => {
    await expect(prepare(db(), [await image(1500, 1000), await image(1024, 1024)])).rejects.toThrow(
      "标注图必须与原图宽高一致"
    )
    await expect(prepare(db(), [Buffer.from("bad")])).rejects.toBeInstanceOf(BadRequestException)
    await expect(prepare(db(), Array(11).fill(Buffer.from("bad")))).rejects.toThrow(
      "数量超过模型限制"
    )
  })

  it("处理原图 EXIF 旋转后的真实画布", async () => {
    const original = await sharp(await image(1500, 1000))
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const result = await prepare(db(), [original, await image(1000, 1500)])
    expect(result).toMatchObject({ sourceWidth: 1000, sourceHeight: 1500 })
  })

  it("模型缺失或停用时不回退到前端模型", async () => {
    const prisma = db()
    prisma.aiGatewayModel.findFirst.mockResolvedValue(null)
    await expect(prepare(prisma, [Buffer.from("bad"), Buffer.from("bad")])).rejects.toBeInstanceOf(
      ServiceUnavailableException
    )
  })

  it("按中心取景裁掉两侧，不拉伸完整画面", async () => {
    const center = await sharp({ create: { width: 30, height: 30, channels: 3, background: "blue" } }).png().toBuffer()
    const bytes = await sharp({ create: { width: 90, height: 30, channels: 3, background: "red" } })
      .composite([{ input: center, left: 30, top: 0 }]).png().toBuffer()
    const output = await finalizeLocalRedraw(bytes, { sourceWidth: 30, sourceHeight: 30 })
    const { data, info } = await sharp(output.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(info).toMatchObject({ width: 30, height: 30, channels: 3 })
    for (let offset = 0; offset < data.length; offset += 3)
      expect([...data.subarray(offset, offset + 3)]).toEqual([0, 0, 255])
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 90, height: 30 })
  })

  it("初始化复制目录模型配置和定价，重复初始化不覆盖已有值", async () => {
    const registry = {
      findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(model()),
      upsert: jest.fn(),
    }
    await expect(seedLocalRedrawModel({ aiGatewayModel: registry } as never)).resolves.toEqual({
      created: true,
    })
    expect(registry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
        create: expect.objectContaining({
          publicId: model().publicId,
          category: "LOCAL_REDRAW",
          fixedCredits: "10",
          priceMultiplier: "3",
        }),
      })
    )
    registry.findFirst.mockResolvedValue(model())
    await expect(seedLocalRedrawModel({ aiGatewayModel: registry } as never)).resolves.toEqual({
      created: false,
    })
    expect(registry.upsert).toHaveBeenCalledTimes(1)
  })
})

describe("局部重绘网关请求和交付", () => {
  beforeEach(() => jest.spyOn(storage, "uploadRemoteUrlToSpaces").mockResolvedValue("https://stored.example/original.png"))
  const originalFetch = global.fetch
  const input = (): ProviderGenerateInput => ({
    localRedraw: plan,
    referenceImages: [
      {
        mimeType: "image/png",
        url: "https://cdn.example/source.png",
        dataUrl: "data:image/png;base64,AAAA",
      },
      {
        mimeType: "image/png",
        url: "https://cdn.example/annotated.png",
        dataUrl: "data:image/png;base64,AAAA",
      },
    ],
    prompt: "只修改框1",
    aspectRatio: "1:1",
    resolutionTier: "4K",
    resolution: "4096x4096",
  })
  const gateway = () => ({
    fetchModelSnapshot: jest.fn().mockRejectedValue(new Error("局部重绘不应重新规划网关尺寸")),
    createImageTask: jest.fn().mockResolvedValue({
      id: "gw-redraw",
      status: "succeeded",
      result: { images: [{ url: "https://gateway.example/result.png" }] },
      usage: { currency: "CNY", amount: "0.25" },
    } as unknown as ImageTask),
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
    delete process.env.IMAGE_GATEWAY_SIZE_NORMALIZE
  })

  it("下载失败只重试交付已有结果，不重提模型", async () => {
    const gw = gateway(),
      bytes = await image(1536, 1024)
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("临时网络错误"))
      .mockResolvedValue({ ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer })
    jest.spyOn(storage, "uploadBytesToSpaces").mockResolvedValue("https://cdn.example/final.png")
    await expect(
      createGatewayImageProvider(gw as unknown as AiGatewayProvider, "ZQ-Image-2").generate(input())
    ).resolves.toMatchObject({ url: "https://cdn.example/final.png" })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(gw.createImageTask).toHaveBeenCalledTimes(1)
  })

  it("处理失败不交付未恢复尺寸的网关图，也不重提模型", async () => {
    const gw = gateway()
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => Uint8Array.from(Buffer.from("invalid image")).buffer })
    const upload = jest.spyOn(storage, "uploadBytesToSpaces")
    await expect(createGatewayImageProvider(gw as unknown as AiGatewayProvider, "ZQ-Image-2").generate(input()))
      .rejects.toThrow("局部重绘交付失败")
    expect(gw.createImageTask).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(3)
    expect(upload).not.toHaveBeenCalled()
  })

  it("使用任务冻结的目录模型提交，不限制模型名称", async () => {
    const gw = gateway(), selected = "configured-redraw-model", bytes = await image(1536, 1024)
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer })
    jest.spyOn(storage, "uploadBytesToSpaces").mockResolvedValue("https://cdn.example/final.png")
    await expect(createGatewayImageProvider(gw as unknown as AiGatewayProvider, selected).generate({
      ...input(), localRedraw: { ...plan, provider: selected },
    })).resolves.toMatchObject({ url: "https://cdn.example/final.png" })
    expect(gw.createImageTask).toHaveBeenCalledWith(expect.objectContaining({ model: selected }), expect.any(String))
  })

  it("快照模型不一致时提交前拒绝", async () => {
    const gw = gateway()
    await expect(
      createGatewayImageProvider(gw as unknown as AiGatewayProvider, "ZQ-Image-3").generate(input())
    ).rejects.toThrow("模型配置不一致")
    expect(gw.createImageTask).not.toHaveBeenCalled()
  })
})

describe("局部重绘使用统一意图和比例交付", () => {
  it("继承来源 4K 和原图 4:3，不按模型原生枚举就近改写", async () => {
    const bytes = await image(800, 600)
    const gateway = { fetchModelSnapshot: jest.fn().mockResolvedValue({
      detail: { modality: "image" }, requestSchema: { request_schema: { type: "object", properties: {
        aspect_ratio: { enum: ["1:1"] }, resolution: { enum: ["1k"] },
      } } },
    }) }
    const result = await prepareLocalRedraw({ aiGatewayModel: { findFirst: jest.fn().mockResolvedValue(model()) } } as never,
      [bytes, bytes], gateway as never, "改色", "4K")
    expect(result).toMatchObject({ resolutionTier: "4K", providerApplied: { aspect_ratio: "800:600", resolution: "4k" } })
  })
  it.each([[160, 90, 160, 90], [160, 120, 160, 90]])("出图 %s×%s 仅按原图比例交付", async (w, h, expectedW, expectedH) => {
    const bytes = await image(w, h)
    const result = await finalizeLocalRedraw(bytes, { sourceWidth: 1920, sourceHeight: 1080 })
    expect([result.width, result.height]).toEqual([expectedW, expectedH])
    if (w === expectedW && h === expectedH) expect(result.bytes.equals(bytes)).toBe(true)
    expect(result.ops.some(op => op.includes("scale"))).toBe(false)
  })
  it("提交原图比例和继承清晰度，保存完整产物和成品", async () => {
    const oldFetch = global.fetch
    const bytes = await image(160, 120)
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer })
    const original = jest.spyOn(storage, "uploadRemoteUrlToSpaces").mockResolvedValue("https://cdn.test/original.png")
    const final = jest.spyOn(storage, "uploadBytesToSpaces").mockResolvedValue("https://cdn.test/final.png")
    const gateway = { createImageTask: jest.fn().mockResolvedValue({ id: "g1", status: "succeeded", result: { images: [{ url: "https://gw.test/raw.png" }] } }) }
    try {
      const result = await createGatewayImageProvider(gateway as never, "ZQ-Image-2").generate({
        prompt: "修改标注区域", referenceImages: [{ url: "https://cdn.test/source.png" }, { url: "https://cdn.test/marked.png" }],
        aspectRatio: "1:1", resolutionTier: "4K", resolution: "4096x4096",
        localRedraw: { ...plan, sourceWidth: 1920, sourceHeight: 1080, resolutionTier: "4K" },
      } as any)
      const request = gateway.createImageTask.mock.calls[0][0]
      expect(request).toMatchObject({ operation: "edit", aspect_ratio: "1920:1080", resolution: "4k", strict: false })
      expect(request).not.toHaveProperty("size")
      expect(original).toHaveBeenCalledTimes(1)
      expect(final).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ url: "https://cdn.test/final.png", gatewayImage: { originalUrl: "https://cdn.test/original.png", width: 160, height: 90 } })
    } finally { global.fetch = oldFetch; jest.restoreAllMocks() }
  })
})
