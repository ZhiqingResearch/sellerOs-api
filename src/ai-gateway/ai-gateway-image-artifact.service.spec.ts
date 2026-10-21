import type { ImageTaskArtifact } from "@zhiqingresearch/ai-ts-sdk"
import axios from "axios"
import sharp from "sharp"
import { AiGatewayImageArtifactService } from "./ai-gateway-image-artifact.service"

jest.mock("axios")

const mockedAxios = axios as jest.Mocked<typeof axios>

describe("AiGatewayImageArtifactService", () => {
  const artifact: ImageTaskArtifact = { url: "https://gateway.example.com/image.png" }

  function plan(width: number, height: number) {
    return {
      requested: {
        aspectRatio: "4:5",
        resolutionTier: null,
        width,
        height,
      },
      providerApplied: {},
      delivery: {
        width,
        height,
        strategy: "adapter",
        nativeResolution: null,
      },
      warnings: [],
    }
  }

  function setupUpload() {
    const uploadBuffer = jest.fn((_buffer: Buffer, key: string) =>
      Promise.resolve(`https://cdn.test/${key}`)
    )
    const spaces = { uploadBuffer }
    const service = new AiGatewayImageArtifactService(spaces as never)
    mockedAxios.get.mockResolvedValue({
      data: Buffer.from("image"),
      headers: { "content-type": "image/png" },
    })
    return { spaces, service }
  }

  async function source(width: number, height: number) {
    const buffer = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 120, g: 140, b: 180 },
      },
    })
      .png()
      .toBuffer()
    mockedAxios.get.mockResolvedValue({
      data: buffer,
      headers: { "content-type": "image/png" },
    })
    return buffer
  }

  it("无交付计划时保留 UAT 的实际尺寸读取", async () => {
    const { service } = setupUpload()
    await source(300, 400)
    const result = await service.store({ id: 31, userId: 7, projectId: 5, generationMode: "AI_SPLIT", deliveryPlan: null }, 101, artifact)
    expect(result).toMatchObject({ width: 300, height: 400, nativeWidth: 300, nativeHeight: 400 })
  })

  it("旧 gateway 计划同样检查比例并保留原图", async () => {
    const { spaces, service } = setupUpload()
    const bytes = await source(300, 400)
    const deliveryPlan = plan(819, 1024)
    const result = await service.store({
      id: 31, userId: 7, projectId: 5, generationMode: "STANDARD",
      deliveryPlan: { ...deliveryPlan, delivery: { ...deliveryPlan.delivery, strategy: "gateway" } },
    }, 101, artifact)
    expect(result).toMatchObject({ width: 300, height: 375, nativeWidth: 300, nativeHeight: 400 })
    expect(spaces.uploadBuffer.mock.calls[0][0]).toEqual(bytes)
    expect(result.originalUrl).not.toBe(result.url)
    expect(spaces.uploadBuffer).toHaveBeenCalledTimes(2)
  })

  it("实测尺寸命中目标容忍带时免二次编码直传", async () => {
    const { spaces, service } = setupUpload()
    await source(500, 625)

    const result = await service.store(
      {
        id: 31,
        userId: 7,
        projectId: 5,
        generationMode: "STANDARD",
        deliveryPlan: plan(500, 625),
      },
      101,
      artifact
    )

    expect(result.width).toBe(500)
    expect(result.height).toBe(625)
    expect(result.deliveryMeta).toEqual(
      expect.objectContaining({ strategy: "passthrough", nativeResolution: true })
    )
    expect(result.deliveryMeta?.ops).toEqual(["passthrough"])
    expect(result.warnings).toEqual([])
  })

  it("后处理失败时返回已保存的模型原图", async () => {
    const { spaces, service } = setupUpload()
    await source(400, 500)
    spaces.uploadBuffer.mockImplementationOnce(() =>
      Promise.resolve("https://cdn.test/original.png")
    )
    spaces.uploadBuffer.mockImplementationOnce(() => {
      throw new Error("upload failed")
    })

    const result = await service.store(
      {
        id: 31,
        userId: 7,
        projectId: 5,
        generationMode: "STANDARD",
        deliveryPlan: plan(500, 625),
      },
      101,
      artifact
    )

    expect(result.url).toBe("https://cdn.test/original.png")
    expect(result.originalUrl).toBe("https://cdn.test/original.png")
    expect(result.width).toBe(400)
    expect(result.height).toBe(500)
    expect(result.deliveryMeta).toEqual(
      expect.objectContaining({ strategy: "fallback_original", fallbackOriginal: true })
    )
    expect(result.warnings).toEqual(["图片后处理失败，已返回模型原图"])
  })

  it("无 deliveryPlan 的任务保留成品路径，并额外保存原始文件", async () => {
    const { spaces, service } = setupUpload()
    await source(100, 100)

    const result = await service.store(
      {
        id: 31,
        userId: 7,
        projectId: 5,
        generationMode: "AI_SPLIT",
        deliveryPlan: null,
      },
      101,
      artifact
    )

    expect(spaces.uploadBuffer).toHaveBeenCalledTimes(2)
    expect(spaces.uploadBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "ai-split-results/7/5/31/101.png",
      "image/png"
    )
    expect(result.url).toBe("https://cdn.test/ai-split-results/7/5/31/101.png")
    expect(result.originalUrl).toBe("https://cdn.test/portrait-originals/7/5/31/101.png")
  })

})

describe("人像与拆图统一交付并保留双文件", () => {
  it.each([
    ["STANDARD", 160, 90, false], ["AI_SPLIT", 160, 90, false],
    ["STANDARD", 160, 120, true], ["AI_SPLIT", 160, 120, true],
  ])("%s 实际 %s×%s 按用户 16:9 交付", async (generationMode, width, height, cropped) => {
    const bytes = await sharp({ create: { width: width as number, height: height as number, channels: 3, background: "white" } }).png().toBuffer()
    mockedAxios.get.mockResolvedValue({ data: bytes, headers: { "content-type": "image/png" } })
    const uploadBuffer = jest.fn(async (_: Buffer, key: string) => `https://cdn.test/${key}`)
    const result = await new AiGatewayImageArtifactService({ uploadBuffer } as never).store({
      id: 31, userId: 7, projectId: 5, generationMode: generationMode as string,
      deliveryPlan: { nativeSizing: true, requested: { aspectRatio: "16:9", width: 4096, height: 2304, resolutionTier: "4K" }, delivery: { width: 4096, height: 2304 } },
    }, 101, { url: "https://gw.test/raw.png" })
    expect(uploadBuffer).toHaveBeenCalledTimes(2)
    expect(uploadBuffer.mock.calls[0]).toEqual([bytes, "portrait-originals/7/5/31/101.png", "image/png"])
    expect(result).toMatchObject({ width: 160, height: 90, nativeWidth: width, nativeHeight: height,
      delivery: { strategy: cropped ? "crop_to_ratio" : "passthrough" } })
    expect(result.originalUrl).toBe("https://cdn.test/portrait-originals/7/5/31/101.png")
    expect(result.url).toContain(generationMode === "AI_SPLIT" ? "ai-split-results/" : "portrait-results/")
    const saved = uploadBuffer.mock.calls[1][0]
    expect(saved.equals(bytes)).toBe(!cropped)
    expect(await sharp(saved).metadata()).toMatchObject({ width: 160, height: 90 })
    expect(result.url).not.toBe(result.originalUrl)
  })
  it("原图上传失败仍保存成品", async () => {
    const bytes = await sharp({ create: { width: 160, height: 90, channels: 3, background: "white" } }).png().toBuffer()
    mockedAxios.get.mockResolvedValue({ data: bytes, headers: { "content-type": "image/png" } })
    const uploadBuffer = jest.fn().mockRejectedValueOnce(new Error("original failed")).mockResolvedValueOnce("https://cdn.test/final.png")
    const result = await new AiGatewayImageArtifactService({ uploadBuffer } as never).store({
      id: 31, userId: 7, projectId: 5, generationMode: "STANDARD",
      deliveryPlan: { requested: { aspectRatio: "16:9", width: 1920, height: 1080 }, delivery: {} },
    }, 101, { url: "https://gw.test/raw.png" })
    expect(result).toMatchObject({ originalUrl: null, url: "https://cdn.test/final.png", width: 160, height: 90 })
  })
})
