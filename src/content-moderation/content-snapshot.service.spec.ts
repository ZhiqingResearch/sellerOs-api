import { lookup } from "node:dns/promises"
import { Readable } from "node:stream"
import { ContentModerationService } from "./content-moderation.service"
import { ContentSnapshotService } from "./content-snapshot.service"
import {
  createModerationScope,
  moderationScope,
  registerModerationUpload,
} from "./moderation-scope"

jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }))

describe("审核和业务共用不可覆盖的私有文件快照", () => {
  beforeEach(() => {
    jest.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never)
  })
  function setup() {
    const provider = { validate: jest.fn() }
    const http = {
      axiosRef: {
        get: jest.fn().mockImplementation(async () => ({
          data: Readable.from([Buffer.from("content")]),
          status: 200,
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

  it("同请求的管道和模型层并发复用快照，不同请求重新读取", async () => {
    const ctx = setup()
    for (let request = 0; request < 2; request++) {
      await moderationScope.run(
        createModerationScope(() => Promise.resolve([])),
        async () => {
          const source = { imageUrl: "https://assets.test/a.png" }
          const [first, second] = await Promise.all([
            ctx.service.freeze(source),
            ctx.service.freeze(source),
          ])
          expect(first.inputs).toEqual(second.inputs)
          expect((await ctx.service.freeze(first.value)).inputs).toEqual(first.inputs)
        }
      )
    }
    expect(ctx.http.axiosRef.get).toHaveBeenCalledTimes(2)
    expect(ctx.spaces.uploadFile).toHaveBeenCalledTimes(2)
  })

  it("上传文件送审后换成业务URL仍复用相同字节的快照，修改后的文件必须重新准备", async () => {
    const ctx = setup()
    const check = jest.fn().mockResolvedValue({ riskLevel: "none", dimensions: [] })
    const provider = { check, decide: () => "PASSED", service: () => "image" }
    const moderation = new ContentModerationService(
      provider as never,
      { ...ctx.spaces, deleteObject: jest.fn() } as never,
      ctx.service
    )
    await moderationScope.run(
      createModerationScope(() => Promise.resolve([])),
      async () => {
        await moderation.assertFile({
          buffer: Buffer.from("file"),
          originalname: "a.png",
          mimetype: "image/png",
        })
        const checked = check.mock.calls[0][0].url
        registerModerationUpload(
          "uploads/a.png",
          "https://assets.test/upload.png",
          Buffer.from("file")
        )
        const reused = await ctx.service.freeze({ imageUrl: "https://assets.test/upload.png" })
        expect(reused.inputs[0].url).toBe(checked)
        expect(ctx.http.axiosRef.get).not.toHaveBeenCalled()
        registerModerationUpload(
          "uploads/b.png",
          "https://assets.test/changed.png",
          Buffer.from("changed")
        )
        const changed = await ctx.service.freeze({ imageUrl: "https://assets.test/changed.png" })
        expect(changed.inputs[0].url).not.toBe(checked)
        expect(ctx.http.axiosRef.get).toHaveBeenCalledTimes(1)
      }
    )
  })

  it("无后缀文件按可信响应的MIME识别，审核和生成引用同一份私有快照，原始输入不被修改", async () => {
    const { service, http, spaces } = setup()
    const original = { references: [{ url: "https://assets.test/opaque" }] }
    const frozen = await service.freeze(original)
    expect(frozen.inputs[0].type).toBe("IMAGE")
    expect((frozen.value as typeof original).references[0].url).toBe(frozen.inputs[0].url)
    expect(original.references[0].url).toBe("https://assets.test/opaque")
    expect(http.axiosRef.get).toHaveBeenCalledWith(
      "https://assets.test/opaque",
      expect.objectContaining({
        maxRedirects: 0,
        responseType: "stream",
        proxy: false,
        adapter: "http",
        httpsAgent: expect.any(Object) as unknown,
      })
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

  it("域名解析到内网或混合地址时拒绝，绝不发出下载或上传请求", async () => {
    const ctx = setup()
    jest.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ] as never)
    await expect(
      ctx.service.freeze({ imageUrl: "https://untrusted.example/a.png" })
    ).rejects.toMatchObject({ response: { code: "MODERATION_INVALID_INPUT" } })
    expect(ctx.http.axiosRef.get).not.toHaveBeenCalled()
    expect(ctx.spaces.uploadFile).not.toHaveBeenCalled()
  })

  it("下载器禁止代理和跳转", async () => {
    const ctx = setup()
    await ctx.service.freeze({ imageUrl: "https://external.example/a.png" })
    const options = (ctx.http.axiosRef.get.mock.calls[0] as unknown[])[1] as {
      validateStatus: (status: number) => boolean
      proxy: boolean
    }
    expect(options.proxy).toBe(false)
    expect(options.validateStatus(200)).toBe(true)
    expect(options.validateStatus(302)).toBe(false)
  })
})
