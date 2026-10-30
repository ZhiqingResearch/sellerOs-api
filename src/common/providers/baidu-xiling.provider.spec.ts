import { ConfigService } from "@nestjs/config"
import axios from "axios"
import { BadRequestException } from "@nestjs/common"
import { Readable } from "node:stream"
import { BaiduXilingProvider } from "./baidu-xiling.provider"

jest.mock("axios")

const mockedAxios = axios as jest.Mocked<typeof axios>

describe("BaiduXilingProvider.queryAvatar", () => {
  let provider: BaiduXilingProvider

  beforeEach(() => {
    jest.clearAllMocks()
    provider = new BaiduXilingProvider({
      get: jest.fn((_key: string, defaultValue?: string) => defaultValue ?? "test-value"),
    } as unknown as ConfigService, { assertContent: jest.fn(async value => value) } as never)
  })

  it("仅fileId不能跳过训练视频审核，合成台词被拒绝时不发起合成", async () => {
    await expect(provider.createAvatar({ fileId: "unreviewed", name: "形象", gender: "FEMALE", callbackUrl: "https://api.test/callback" })).rejects.toMatchObject({ status: 400 })
    expect(mockedAxios.post).not.toHaveBeenCalled()
    const moderation = (provider as unknown as { moderation: { assertContent: jest.Mock } }).moderation
    moderation.assertContent.mockRejectedValueOnce(new BadRequestException("内容未通过审核"))
    await expect(provider.createVideoTask({ figureId: "figure", perId: "voice", text: "台词", width: 720, height: 1280, callbackUrl: "https://api.test/callback" })).rejects.toMatchObject({ status: 400 })
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it("音色克隆内部调用也必须过审核，拒绝时不上传音频", async () => {
    const moderation = provider["moderation"] as unknown as { assertFile: jest.Mock }
    moderation.assertFile = jest.fn().mockRejectedValue(new BadRequestException("独立音频暂不支持审核"))
    await expect(provider.createVoiceClone({ audioBuffer: Buffer.from("fixture"), audioFileName: "misleading.mp4", name: "音色", gender: "FEMALE", exampleText: "示例", callbackUrl: "https://api.test/callback" })).rejects.toMatchObject({ status: 400 })
    expect(moderation.assertFile).toHaveBeenCalledWith(expect.objectContaining({ originalname: "voice.wav" }))
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it("重新上传审核过的训练快照，不使用客户端提供的另一个fileId", async () => {
    const moderation = (provider as unknown as { moderation: { assertContent: jest.Mock } }).moderation
    moderation.assertContent.mockResolvedValueOnce({ trainingVideoUrl: "https://private.test/snapshot.mp4" })
    mockedAxios.get.mockResolvedValueOnce({ data: Readable.from([Buffer.from("abc")]), headers: { "content-length": "3" } })
    mockedAxios.post.mockResolvedValueOnce({ data: { code: 0, result: { fileId: "reviewed-file" } } })
      .mockResolvedValueOnce({ data: { code: 0, result: { figureId: "figure" } } })
    await expect(provider.createAvatar({ fileId: "unreviewed-file", trainingUrl: "https://assets.test/original.mp4", name: "形象", gender: "FEMALE", callbackUrl: "https://api.test/callback" })).resolves.toBe("figure")
    expect(mockedAxios.get).toHaveBeenCalledWith("https://private.test/snapshot.mp4", expect.objectContaining({ responseType: "stream", maxRedirects: 0 }))
    expect(mockedAxios.post.mock.calls[1][1]).toMatchObject({ templateVideoId: "reviewed-file" })
  })

  it("keeps cloned avatars on the lite2d query endpoint", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        code: 0,
        message: { global: "success" },
        result: {
          result: [
            {
              figureId: "cloned-1",
              status: "SUCCESS",
              templateImg: "https://example.com/cloned.png",
              resolutionWidth: 1080,
              resolutionHeight: 1920,
            },
          ],
        },
      },
    })

    const result = await provider.queryAvatar("cloned-1")

    expect(result.figureId).toBe("cloned-1")
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("/figure/lite2d/query"),
      expect.objectContaining({
        params: { figureId: "cloned-1" },
      })
    )
  })

  it("uses the public figure query endpoint for system avatars", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        code: 0,
        message: { global: "success" },
        result: {
          result: [
            {
              figureId: "public-1",
              systemFigure: true,
              templateImg: "https://example.com/public.png",
              resolutionWidth: 1080,
              resolutionHeight: 1920,
            },
          ],
        },
      },
    })

    const result = await provider.queryAvatar("public-1", {
      systemFigure: true,
      item: "VIDEO-DH_2D_LITE",
    })

    expect(result.figureId).toBe("public-1")
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("/figure/query"),
      expect.objectContaining({
        params: {
          systemFigure: true,
          item: "VIDEO-DH_2D_LITE",
          pageNo: 1,
          pageSize: 1000,
        },
      })
    )
  })
})
