import { BadRequestException } from "@nestjs/common"
import { IsIn, IsString } from "class-validator"
import "reflect-metadata"
import { contentInputs } from "./content-inputs"
import { ContentModerationPipe } from "./content-moderation.pipe"
import { ContentModerationService } from "./content-moderation.service"
import { publicModeration } from "./moderation-response.interceptor"

class ContentDto {
  @IsString() prompt: string
  @IsString() password: string
  @IsIn(["technical-category"]) category: string
}

describe("全局业务内容审核边界", () => {
  it("提示词链接仍作为文本，用户传入的系统提示词和对话正文均合并，普通content字段不送审", () => {
    const inputs = contentInputs({
      prompt: "https://example.com/a.jpg",
      systemPrompt: "用户自定义系统提示词",
      messages: [
        { role: "user", content: "用户消息" },
        { role: "assistant", content: "客户端传入的历史消息" },
      ],
      content: "普通业务内容",
      model: "model",
      size: "2K",
    })
    expect(inputs).toEqual([
      {
        key: "input.prompt.0",
        type: "TEXT",
        content:
          "https://example.com/a.jpg\n\n用户自定义系统提示词\n\n用户消息\n\n客户端传入的历史消息",
      },
    ])
  })
  it("身份接口的联系方式、凭证和展示名均不作为提示词送审", async () => {
    const received: unknown[] = []
    const moderation = {
      assertContent: jest.fn((value: unknown, root: string, technical: string[]) => {
        received.push(...contentInputs(value, root, technical))
      }),
    }
    const pipe = new ContentModerationPipe(
      { path: "/api/auth/email/register", method: "POST" } as never,
      moderation as never
    )
    await pipe.transform(
      { email: "private@example.com", password: "secret", username: "展示名" },
      { type: "body", metatype: Object }
    )
    expect(received).toEqual([])
  })

  it("识别嵌套的四类内容，仅提示词作为文本送审", () => {
    const dto = Object.assign(new ContentDto(), {
      prompt: "商品说明",
      password: "private-password",
      category: "technical-category",
    })
    const inputs = contentInputs({
      dto,
      token: "private-token",
      refresh_token: "private-refresh",
      api_key: "private-api-key",
      signature: "private-signature",
      userId: "123",
      page: "1",
      items: [
        { imageUrl: "https://assets.test/image" },
        { type: "video", url: "https://assets.test/video" },
        { documentUrl: "https://assets.test/manual.pdf" },
        { source: "自由填写的业务来源" },
      ],
    })
    expect(inputs.filter(input => input.type !== "TEXT").map(input => input.type)).toEqual([
      "IMAGE",
      "VIDEO",
      "DOCUMENT",
    ])
    const serialized = JSON.stringify(inputs)
    expect(serialized).not.toContain("private-")
    expect(serialized).not.toContain("technical-category")
    expect(inputs.filter(input => input.type === "TEXT")).toEqual([
      { key: "input.prompt.0", type: "TEXT", content: "商品说明" },
    ])
  })

  it("合并提示词后按Unicode字符分片，保留重叠且不遗漏尾部", () => {
    const text = "字".repeat(1799) + "😀敏感内容" + "尾".repeat(2200)
    const inputs = contentInputs({ prompt: text })
    expect(inputs).toHaveLength(3)
    expect(inputs.every(input => Array.from(input.content!).length <= 2000)).toBe(true)
    expect(inputs[0].content).toContain("😀敏感内容")
    expect(inputs.at(-1)!.content!.endsWith("尾")).toBe(true)
    expect(Array.from(inputs[0].content!).slice(1800).join("")).toBe(
      Array.from(inputs[1].content!).slice(0, 200).join("")
    )
  })

  it("支持Express无原型查询对象，并只读取真实Multer上传的磁盘文件", async () => {
    const query = Object.assign(Object.create(null) as Record<string, string>, { prompt: "商品" })
    expect(contentInputs(query)[0].content).toBe("商品")
    const file = {
      path: "/tmp/server-upload-file",
      originalname: "sample.xlsx",
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }
    const moderation = { assertFile: jest.fn().mockResolvedValue(undefined) }
    const pipe = new ContentModerationPipe(
      { path: "/api/ad-cleaning/tasks", method: "POST", file } as never,
      moderation as never
    )
    await pipe.transform(file, { type: "custom", metatype: Object })
    expect(moderation.assertFile).toHaveBeenCalledWith(file)
    moderation.assertFile.mockClear()
    await pipe.transform({ ...file, path: "/etc/passwd" }, { type: "custom", metatype: Object })
    expect(moderation.assertFile).not.toHaveBeenCalled()
  })

  it("无法审核的仅素材ID引用和独立音频不允许悄悄漏审", () => {
    expect(() => contentInputs({ reference_images: [{ object_key: "uploads/unknown" }] })).toThrow(
      BadRequestException
    )
    expect(() => contentInputs({ reference_images: [{ asset_id: "asset_1" }] })).toThrow(
      BadRequestException
    )
    expect(() =>
      contentInputs({ reference_audios: [{ url: "https://assets.test/a.mp3" }] })
    ).toThrow(BadRequestException)
    expect(() =>
      contentInputs({ payload: JSON.stringify({ reference_images: [{ asset_id: "asset_1" }] }) })
    ).toThrow(BadRequestException)
    expect(
      contentInputs({
        videoRequest: { reference_images: [{ url: "https://assets.test/opaque" }] },
      })[0].type
    ).toBe("IMAGE")
  })

  it("DTO校验和whitelist先于审核，非法参数和额外字段不送审", async () => {
    const moderation = { assertContent: jest.fn(async value => value) }
    const pipe = new ContentModerationPipe(
      { path: "/api/demo", method: "POST" } as never,
      moderation as never
    )
    await expect(
      pipe.transform({ prompt: 123 }, { type: "body", metatype: ContentDto })
    ).rejects.toMatchObject({ status: 400 })
    expect(moderation.assertContent).not.toHaveBeenCalled()
    const validated = await pipe.transform(
      {
        prompt: "示例",
        password: "secret",
        category: "technical-category",
        unrecognized: "未校验内容",
      },
      { type: "body", metatype: ContentDto }
    )
    expect(validated).not.toHaveProperty("unrecognized")
    expect(moderation.assertContent).toHaveBeenCalledWith(validated, "body")
  })

  it("供应商回调不送审；业务绑定接口拒绝客户端通过标记", async () => {
    const moderation = { assertContent: jest.fn() }
    const callback = new ContentModerationPipe(
      { path: "/api/webhooks/ai-gateway", method: "POST" } as never,
      moderation as never
    )
    await callback.transform(
      { signature: "signed", content: "供应商回执" },
      { type: "body", metatype: Object }
    )
    expect(moderation.assertContent).not.toHaveBeenCalled()
    const normal = new ContentModerationPipe(
      { path: "/api/content-moderation/check", method: "POST" } as never,
      moderation as never
    )
    await expect(
      normal.transform(
        { businessType: "VIDEO_TASK", businessTaskId: "1", passed: true },
        { type: "body", metatype: Object }
      )
    ).rejects.toMatchObject({ status: 400 })
  })

  it("音色克隆的无后缀音频也不能作为文字审核后继续执行", async () => {
    const moderation = { assertContent: jest.fn() }
    const pipe = new ContentModerationPipe(
      { path: "/api/customer/1/voice", method: "POST" } as never,
      moderation as never
    )
    await expect(
      pipe.transform(
        { trainingUrl: "https://assets.test/opaque" },
        { type: "body", metatype: Object }
      )
    ).rejects.toMatchObject({ response: { code: "MODERATION_UNSUPPORTED_MEDIA" } })
    expect(moderation.assertContent).not.toHaveBeenCalled()
  })

  it("待审视频的展示名称不送审，文件交给业务任务；multipart文件实际审核", async () => {
    const moderation = { assertContent: jest.fn(), assertInputs: jest.fn(), assertFile: jest.fn() }
    const deferred = new ContentModerationPipe(
      { path: "/api/video-project/1/motion-control/batch", method: "POST" } as never,
      moderation as never
    )
    await deferred.transform(
      { prompt: "复刻", actionVideos: [{ name: "动作名称", url: "https://assets.test/v.mp4" }] },
      { type: "body", metatype: Object }
    )
    expect(moderation.assertInputs).not.toHaveBeenCalled()
    const normal = new ContentModerationPipe(
      { path: "/api/import", method: "POST" } as never,
      moderation as never
    )
    const files = [{ buffer: Buffer.from("a"), mimetype: "application/pdf", originalname: "a.pdf" }]
    await normal.transform(files, { type: "custom", metatype: Object })
    expect(moderation.assertFile).toHaveBeenCalledWith(files[0])
    await normal.transform({ references: files }, { type: "custom", metatype: Object })
    expect(moderation.assertFile).toHaveBeenCalledTimes(2)
  })

  it("普通接口视频/文档超时不放行业务；拒绝和未知建议均抛出错误", async () => {
    jest.useFakeTimers()
    try {
      const provider = {
        submit: jest.fn().mockResolvedValue({ taskId: "vendor" }),
        poll: jest.fn().mockResolvedValue(null),
        check: jest.fn().mockResolvedValue({ suggestion: "unknown" }),
        decide: jest.fn().mockReturnValue("UNDETERMINED"),
        service: jest.fn().mockReturnValue("service"),
      }
      const service = new ContentModerationService(provider as never, {} as never, {} as never)
      const pending = expect(
        service.assertInputs([{ key: "video", type: "VIDEO", url: "https://assets.test/v.mp4" }])
      ).rejects.toMatchObject({ status: 408 })
      await jest.advanceTimersByTimeAsync(91_000)
      await pending
      expect(provider.submit).toHaveBeenCalledTimes(1)
      await expect(
        service.assertInputs([{ key: "prompt", type: "TEXT", content: "文本" }])
      ).rejects.toMatchObject({ status: 503 })
      provider.decide.mockReturnValue("REJECTED")
      await expect(
        service.assertInputs([{ key: "prompt", type: "TEXT", content: "文本" }])
      ).rejects.toMatchObject({ status: 400 })
    } finally {
      jest.useRealTimers()
    }
  })

  it("仅返回审核摘要，递归移除持久化输入、供应商ID和并发占用字段", () => {
    const body = publicModeration({
      tasks: [
        {
          moderationStatus: "PROCESSING",
          moderationClaimUntil: new Date(),
          moderationNextCheckAt: new Date(),
          moderation: {
            revision: 1,
            items: [
              {
                status: "PROCESSING",
                input: { key: "prompt", type: "TEXT", content: "private-content" },
                receipt: { taskId: "vendor-secret" },
              },
            ],
          },
        },
      ],
    })
    const serialized = JSON.stringify(body)
    expect(serialized).toContain("contentModeration")
    expect(serialized).not.toContain("private-content")
    expect(serialized).not.toContain("vendor-secret")
    expect(serialized).not.toContain("moderationClaimUntil")
  })

  it("公共审核接口已返回的摘要不被追加空结果，也不删除普通业务同名字段", () => {
    const snapshot = {
      moderationStatus: "PROCESSING",
      results: [{ itemKey: "video", status: "PROCESSING" }],
    }
    expect(publicModeration(snapshot)).toEqual(snapshot)
    expect(publicModeration({ metadata: { moderation: "业务内容" } })).toEqual({
      metadata: { moderation: "业务内容" },
    })
  })
})
