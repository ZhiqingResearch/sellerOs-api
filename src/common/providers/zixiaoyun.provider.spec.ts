/* eslint-disable @typescript-eslint/unbound-method */
import { BadGatewayException, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import { ZixiaoyunProvider } from "./zixiaoyun.provider"

jest.mock("axios")
const mockedAxios = jest.mocked(axios)

describe("ZixiaoyunProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  function createProvider(values: Record<string, string> = {}) {
    const config = {
      get: jest.fn((key: string) => values[key]),
    }
    return new ZixiaoyunProvider(config as unknown as ConfigService)
  }

  it("未配置接口时返回 503 且不发请求", async () => {
    const provider = createProvider()

    await expect(provider.washImageUrl("https://example.com/a.jpg")).rejects.toBeInstanceOf(
      ServiceUnavailableException
    )
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it("解析第三方成功响应", async () => {
    const provider = createProvider({
      ZIXIAOYUN_API_URL: "https://vip.example.com/api/upload/",
      ZIXIAOYUN_API_TOKEN: "secret",
    })
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: {
        status: "success",
        statusCode: "200",
        url: "https://washed.example.com/a.jpg",
      },
    })

    await expect(provider.washImageUrl("https://example.com/a.jpg")).resolves.toEqual({
      url: "https://washed.example.com/a.jpg",
    })
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://vip.example.com/api/upload/",
      expect.anything(),
      expect.objectContaining({ timeout: 60_000 })
    )
  })

  it("第三方业务失败时返回 502 中文错误", async () => {
    const provider = createProvider({
      ZIXIAOYUN_API_URL: "https://vip.example.com/api/upload/",
      ZIXIAOYUN_API_TOKEN: "secret",
    })
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: {
        status: "failed",
        statusCode: "701",
        resultData: "下载文件发生未知错误",
      },
    })

    await expect(provider.washImageUrl("https://example.com/a.jpg")).rejects.toEqual(
      new BadGatewayException("图片洗链接失败：下载文件发生未知错误")
    )
  })
})
