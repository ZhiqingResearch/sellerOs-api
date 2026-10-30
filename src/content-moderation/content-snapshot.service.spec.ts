import { Readable } from "node:stream"
import { ContentSnapshotService } from "./content-snapshot.service"

describe("审核和业务共用不可覆盖的私有文件快照", () => {
  function setup() {
    const provider = { validate: jest.fn() }
    const http = {
      axiosRef: {
        get: jest.fn().mockImplementation(async () => ({
          data: Readable.from([Buffer.from("content")]),
          headers: { "content-type": "image/png" },
        })),
      },
    }
    const spaces = {
      uploadFile: jest.fn(),
      uploadBuffer: jest.fn(),
      generateSignedDownloadUrl: jest.fn(
        async key => `https://private.test/${key}?signature=opaque`
      ),
      pruneExpiredObjects: jest.fn().mockResolvedValue(0),
    }
    const service = new ContentSnapshotService(provider as never, http as never, spaces as never)
    return { provider, http, spaces, service }
  }

  it("无后缀文件按可信响应的MIME识别，审核和生成引用同一份私有快照，原始输入不被修改", async () => {
    const { service, http, spaces } = setup()
    const original = { references: [{ url: "https://assets.test/opaque" }] }
    const frozen = await service.freeze(original)
    expect(frozen.inputs[0].type).toBe("IMAGE")
    expect((frozen.value as typeof original).references[0].url).toBe(frozen.inputs[0].url)
    expect(original.references[0].url).toBe("https://assets.test/opaque")
    expect(http.axiosRef.get).toHaveBeenCalledWith(
      "https://assets.test/opaque",
      expect.objectContaining({ maxRedirects: 0, responseType: "stream" })
    )
    expect(spaces.uploadFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("content-moderation/snapshots/"),
      "image/png",
      "private"
    )
    expect(spaces.generateSignedDownloadUrl).toHaveBeenCalledWith(expect.any(String), 86400)
  })

  it("可信地址校验失败时不进行下载；存储和HTTP原始异常不泄露到调用方", async () => {
    const ctx = setup()
    ctx.provider.validate.mockImplementationOnce(() => {
      throw new Error("invalid-url")
    })
    await expect(ctx.service.freeze({ imageUrl: "http://127.0.0.1/a.png" })).rejects.toThrow(
      "invalid-url"
    )
    expect(ctx.http.axiosRef.get).not.toHaveBeenCalled()
    ctx.http.axiosRef.get.mockRejectedValueOnce(new Error("secret-url-signature"))
    await expect(
      ctx.service.freeze({ imageUrl: "https://assets.test/a.png" })
    ).rejects.toMatchObject({ response: { code: "MODERATION_SNAPSHOT_FAILED" } })
  })

  it("支持已有模型入口的base64图片，不将base64误送成自由文本", async () => {
    const { service, http, spaces } = setup()
    const frozen = await service.freeze([
      { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
    ])
    expect(http.axiosRef.get).not.toHaveBeenCalled()
    expect(spaces.uploadBuffer).toHaveBeenCalledWith(
      Buffer.from("abc"),
      expect.any(String),
      "image/png",
      "private"
    )
    expect(frozen.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "IMAGE",
          url: expect.stringContaining("https://private.test/"),
        }),
      ])
    )
  })

  it("清理参数以天计，避免错误地保留快照数百万天", async () => {
    const { service, spaces } = setup()
    await service.cleanup()
    expect(spaces.pruneExpiredObjects).toHaveBeenCalledWith("content-moderation/temporary/", 1)
    expect(spaces.pruneExpiredObjects).toHaveBeenCalledWith("content-moderation/snapshots/", 2)
  })
})
