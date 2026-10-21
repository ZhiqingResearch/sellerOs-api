import { ConfigService } from "@nestjs/config"
import axios from "axios"
import { BaiduXilingProvider } from "./baidu-xiling.provider"

jest.mock("axios")

const mockedAxios = axios as jest.Mocked<typeof axios>

describe("BaiduXilingProvider.queryAvatar", () => {
  let provider: BaiduXilingProvider

  beforeEach(() => {
    jest.clearAllMocks()
    provider = new BaiduXilingProvider({
      get: jest.fn((_key: string, defaultValue?: string) => defaultValue ?? "test-value"),
    } as unknown as ConfigService)
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
