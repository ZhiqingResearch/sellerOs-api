import { ConfigService } from "@nestjs/config"
import { AtlasProvider, type AtlasVideoParams } from "./atlas.provider"

describe("AtlasProvider Seedance 2.5", () => {
  const provider = new AtlasProvider({ get: jest.fn() } as unknown as ConfigService)
  const testable = provider as unknown as {
    buildBody(params: AtlasVideoParams): Record<string, unknown>
  }

  it("按模式解析两个准确的 Model ID", () => {
    expect(provider.resolveModelId("NORMAL", "video-seedance-2-5")).toBe(
      "bytedance/seedance-2.5/image-to-video"
    )
    expect(provider.resolveModelId("REFERENCE", "video-seedance-2-5")).toBe(
      "bytedance/seedance-2.5/reference-to-video"
    )
  })

  it("图生视频请求使用 Seedance 2.5 字段", () => {
    const body = testable.buildBody({
      mode: "NORMAL",
      tier: "video-seedance-2-5",
      prompt: "test",
      firstFrameUrl: "first.png",
      lastFrameUrl: "last.png",
      durationSec: 8,
      resolution: "720p",
      aspectRatio: "adaptive",
      generateAudio: true,
      watermark: false,
      outputFormat: "mp4",
    } satisfies AtlasVideoParams)

    expect(body).toEqual({
      prompt: "test",
      image: "first.png",
      last_image: "last.png",
      duration: 8,
      resolution: "720p",
      ratio: "adaptive",
      generate_audio: true,
      watermark: false,
      return_last_frame: false,
      output_format: "mp4",
    })
  })

  it("参考视频编辑请求向 Atlas 发送 duration=-1", () => {
    const body = testable.buildBody({
      mode: "REFERENCE",
      tier: "video-seedance-2-5",
      prompt: "edit @Video1",
      refVideoUrls: ["source.mp4"],
      durationSec: -1,
      resolution: "720p",
      aspectRatio: "adaptive",
      generateAudio: true,
      outputFormat: "mp4",
    } satisfies AtlasVideoParams)

    expect(body).toMatchObject({
      reference_videos: ["source.mp4"],
      duration: -1,
      ratio: "adaptive",
    })
  })
})

describe("AtlasProvider Seedance 2.0 Fast", () => {
  const provider = new AtlasProvider({ get: jest.fn() } as unknown as ConfigService)
  const testable = provider as unknown as {
    buildBody(params: AtlasVideoParams): Record<string, unknown>
  }

  it("将两个业务档位映射到 Atlas Fast Model ID", () => {
    expect(provider.resolveModelId("NORMAL", "video-ultra")).toBe(
      "bytedance/seedance-2.0-fast/image-to-video"
    )
    expect(provider.resolveModelId("REFERENCE", "video-ultra-reference")).toBe(
      "bytedance/seedance-2.0-fast/reference-to-video"
    )
  })

  it("常规模式使用 Atlas image-to-video 字段", () => {
    expect(
      testable.buildBody({
        mode: "NORMAL",
        tier: "video-ultra",
        prompt: "自然运动",
        firstFrameUrl: "first.png",
        lastFrameUrl: "last.png",
        durationSec: 5,
        resolution: "480p",
        aspectRatio: "16:9",
        generateAudio: false,
      })
    ).toEqual({
      prompt: "自然运动",
      image: "first.png",
      last_image: "last.png",
      duration: 5,
      resolution: "480p",
      ratio: "16:9",
      generate_audio: false,
    })
  })

  it("全能参考使用 Atlas reference-to-video 字段", () => {
    expect(
      testable.buildBody({
        mode: "REFERENCE",
        tier: "video-ultra-reference",
        prompt: "保持人物一致",
        refImageUrls: ["one.png", "two.jpg"],
        durationSec: 5,
        resolution: "720p",
        aspectRatio: "16:9",
        generateAudio: false,
      })
    ).toEqual({
      prompt: "保持人物一致",
      reference_images: ["one.png", "two.jpg"],
      duration: 5,
      resolution: "720p",
      ratio: "16:9",
      generate_audio: false,
    })
  })
})
