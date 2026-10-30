import Core from "@alicloud/pop-core"
import { ConfigService } from "@nestjs/config"
import { AliyunContentModerationProvider } from "./aliyun-content-moderation.provider"

jest.mock("@alicloud/pop-core", () => jest.fn())

describe("AliyunContentModerationProvider", () => {
  const request = jest.fn()
  const setup = (extra: Record<string, string> = {}) => {
    ;(Core as unknown as jest.Mock).mockImplementation(() => ({ request }))
    return new AliyunContentModerationProvider(
      new ConfigService({
        ZQ_ACCESS_KEY_ID: "test-id",
        ZQ_ACCESS_KEY_SECRET: "test-secret",
        SPACES_BASE_URL: "https://assets.example.com",
        ...extra,
      })
    )
  }

  beforeEach(() => jest.clearAllMocks())

  it("文本使用增强版PLUS，保留原始等级和开放标签，不回传风险原文", async () => {
    request.mockResolvedValue({
      Code: 200,
      Data: {
        RiskLevel: "high",
        Result: [
          {
            Label: "new_content_label",
            Description: "新风险类型",
            RiskWords: "private-sample",
            CustomizedHit: [{ KeyWords: "private-sample" }],
          },
        ],
        SensitiveData: ["private-sample"],
      },
    })
    const provider = setup()
    const result = await provider.check({ key: "prompt", type: "TEXT", content: "示例" })
    expect(result).toMatchObject({ suggestion: null, riskLevel: "high" })
    expect(result.dimensions[0]).toEqual({
      type: null,
      level: "high",
      suggestion: null,
      labels: [{ code: "new_content_label", name: "新风险类型" }],
    })
    expect(JSON.stringify(result)).not.toContain("private-sample")
    expect(provider.decide(result, provider.service("TEXT"))).toBe("REJECTED")
    expect(request).toHaveBeenCalledWith(
      "TextModerationPlus",
      {
        Service: "ugc_moderation_byllm",
        ServiceParameters: JSON.stringify({ content: "示例" }),
      },
      expect.objectContaining({ method: "POST", formatParams: false })
    )
  })

  it("图片使用单个imageUrl，none放行且不伪造处置建议", async () => {
    request.mockResolvedValue({
      Code: 200,
      Data: { RiskLevel: "none", Result: [{ Label: "nonLabel", Description: "未检测出风险" }] },
    })
    const provider = setup()
    const result = await provider.check({
      key: "image",
      type: "IMAGE",
      url: "https://assets.example.com/a.jpg",
    })
    expect(result).toMatchObject({ suggestion: null, riskLevel: "none" })
    expect(result.dimensions[0].labels).toEqual([])
    expect(provider.decide(result, provider.service("IMAGE"))).toBe("PASSED")
    expect(request).toHaveBeenCalledWith(
      "ImageModeration",
      {
        Service: "postImageCheckByVL",
        ServiceParameters: JSON.stringify({ imageUrl: "https://assets.example.com/a.jpg" }),
      },
      expect.any(Object)
    )
  })

  it("文本空标签none可放行，已有视频配置不覆盖文本图片默认策略", async () => {
    request.mockResolvedValue({ Code: 200, Data: { RiskLevel: "none", Result: [] } })
    const provider = setup({ CONTENT_MODERATION_PASS_RISK_LEVELS: '{"videoDetection":["none"]}' })
    const result = await provider.check({ key: "text", type: "TEXT", content: "普通商品介绍" })
    expect(provider.decide(result, provider.service("TEXT"))).toBe("PASSED")
    expect(
      provider.decide({ ...result, riskLevel: "future_level" }, provider.service("TEXT"))
    ).toBe("UNDETERMINED")
  })

  it("图片分项风险不能被总体none覆盖，缺失等级或非法标签结构均失败", async () => {
    const provider = setup()
    request.mockResolvedValueOnce({
      Code: 200,
      Data: {
        RiskLevel: "none",
        Result: [{ Label: "new_label", RiskLevel: "high" }],
      },
    })
    const result = await provider.check({
      key: "image",
      type: "IMAGE",
      url: "https://assets.example.com/a.jpg",
    })
    expect(provider.decide(result, provider.service("IMAGE"))).toBe("UNDETERMINED")
    for (const data of [
      { Result: [] },
      { RiskLevel: "none", Result: {} },
      { RiskLevel: "none", Result: [null] },
      { RiskLevel: "none", Result: [{ Label: 123 }] },
      { RiskLevel: "none", Result: [{ Label: "nonLabel", RiskLevel: 123 }] },
    ]) {
      request.mockResolvedValueOnce({ Code: 200, Data: data })
      await expect(
        provider.check({ key: "text", type: "TEXT", content: "测试" })
      ).rejects.toMatchObject({ response: { code: "MODERATION_INVALID_RESPONSE" } })
    }
  })

  it("视频原生建议缺失时不伪造pass，只按默认none放行业务", async () => {
    request.mockResolvedValue({ Code: 200, Data: { RiskLevel: "none" } })
    const provider = setup()
    const result = await provider.poll("VIDEO", {
      taskId: "vendor-1",
      requestId: null,
      region: "cn-shanghai",
      service: "videoDetection",
    })
    expect(result).toMatchObject({ suggestion: null, riskLevel: "none" })
    expect(provider.decide(result!, "videoDetection")).toBe("PASSED")
    expect(
      provider.decide({ ...result!, riskLevel: "high", dimensions: [] }, "videoDetection")
    ).toBe("REJECTED")
    expect(provider.decide({ ...result!, riskLevel: "new-level" }, "videoDetection")).toBe(
      "UNDETERMINED"
    )
  })

  it("不把未知处置建议或只有维度pass当作总体通过", () => {
    const provider = setup()
    expect(
      provider.decide({ suggestion: "new-action", riskLevel: null, dimensions: [] }, "x")
    ).toBe("UNDETERMINED")
    expect(
      provider.decide(
        {
          suggestion: null,
          riskLevel: null,
          dimensions: [
            { type: "contentModeration", level: "none", suggestion: "pass", labels: [] },
          ],
        },
        "x"
      )
    ).toBe("UNDETERMINED")
  })

  it("放行策略必须为JSON对象，非法配置不能退回默认放行", () => {
    for (const value of ["[]", "null", '"none"', "invalid-json"]) {
      const provider = setup({ CONTENT_MODERATION_PASS_RISK_LEVELS: value })
      expect(() =>
        provider.decide(
          { suggestion: null, riskLevel: "none", dimensions: [] },
          provider.service("TEXT")
        )
      ).toThrow("审核放行配置格式不正确")
    }
  })

  it("查询使用受理时地域和Service，处理中不形成结果", async () => {
    request.mockResolvedValue({ Code: 280 })
    const provider = setup({ CONTENT_MODERATION_REGION: "cn-hangzhou" })
    await expect(
      provider.poll("DOCUMENT", {
        taskId: "vendor-1",
        region: "cn-shanghai",
        service: "document_detection_01",
        requestId: null,
      })
    ).resolves.toBeNull()
    expect(Core).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://green-cip.cn-shanghai.aliyuncs.com",
      })
    )
    expect(request).toHaveBeenCalledWith(
      "DescribeFileModerationResult",
      {
        Service: "document_detection_01",
        ServiceParameters: JSON.stringify({ taskId: "vendor-1" }),
      },
      expect.any(Object)
    )
  })

  it("支持任意公网HTTPS域名，旧域名名单不再限制；拒绝不安全URL", () => {
    const provider = setup({
      SPACES_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
      SPACES_BUCKET: "test",
      CONTENT_MODERATION_ALLOWED_ORIGINS: "https://assets.example.com",
    })
    expect(() =>
      provider.validate({
        key: "image",
        type: "IMAGE",
        url: "https://test.nyc3.digitaloceanspaces.com/a.jpg?signature=test",
      })
    ).not.toThrow()
    expect(() =>
      provider.validate({
        key: "image",
        type: "IMAGE",
        url: "https://m.media-amazon.com/images/a.jpg",
      })
    ).not.toThrow()
    for (const url of [
      "http://assets.example.com/a.jpg",
      "https://user:secret@assets.example.com/a.jpg",
      "https://127.0.0.1/a.jpg",
      "https://localhost/a.jpg",
      "https://assets.example.com:8443/a.jpg",
    ]) {
      expect(() => provider.validate({ key: "image", type: "IMAGE", url })).toThrow()
    }
    expect(request).not.toHaveBeenCalled()
  })

  it("缺配置、超长文本和非法响应均不默认通过", async () => {
    const provider = setup()
    await expect(
      provider.check({ key: "prompt", type: "TEXT", content: "字".repeat(2001) })
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "MODERATION_INVALID_INPUT" }),
    })
    expect(request).not.toHaveBeenCalled()
    request.mockResolvedValue({ Code: 200, Data: {} })
    await expect(
      provider.check({ key: "prompt", type: "TEXT", content: "示例" })
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "MODERATION_INVALID_RESPONSE" }),
    })
    const missing = new AliyunContentModerationProvider(new ConfigService({}))
    await expect(
      missing.check({ key: "prompt", type: "TEXT", content: "示例" })
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "MODERATION_NOT_CONFIGURED" }),
    })
  })

  it("供应商异常不把URL、密钥或正文带入异常响应", async () => {
    request.mockRejectedValue(new Error("secret raw body https://secret.example"))
    await expect(
      setup().check({ key: "prompt", type: "TEXT", content: "示例" })
    ).rejects.toMatchObject({ message: "内容审核暂不可用，请稍后重试" })
  })

  it("结构矛盾不能因总建议pass而被放行，异步dataId符合供应商字符和长度限制", async () => {
    const provider = setup()
    request.mockResolvedValueOnce({
      Code: 200,
      Data: { Suggestion: "pass", Detail: { Suggestion: "block" } },
    })
    await expect(
      provider.check({ key: "prompt", type: "TEXT", content: "文本" })
    ).rejects.toMatchObject({ response: { code: "MODERATION_INVALID_RESPONSE" } })
    request.mockResolvedValueOnce({ Code: 200, Data: { TaskId: "vendor-1" } })
    await provider.submit(
      { key: "video", type: "VIDEO", url: "https://assets.example.com/a.mp4" },
      "业务:1:" + "x".repeat(256)
    )
    const params = request.mock.calls.at(-1)![1] as { ServiceParameters: string }
    const submitted = JSON.parse(params.ServiceParameters) as { dataId: string }
    expect(submitted.dataId).toMatch(/^[a-f0-9]{64}$/)
  })
})
