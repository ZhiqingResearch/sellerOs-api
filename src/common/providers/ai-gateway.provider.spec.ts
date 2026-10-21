import { BadGatewayException, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { AiGatewayProvider, type AiGatewayStreamEvent } from "./ai-gateway.provider"

function createSseResponse(events: Array<Record<string, unknown>>, requestId?: string): Response {
  const frames = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")
  return new Response(`${frames}data: [DONE]\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
  })
}

function createUsageResponse(requestId: string, amount: string, model = "ZQ-Think-Lite"): Response {
  return new Response(
    JSON.stringify({
      object: "usage.list",
      data: [
        {
          id: `usage-${requestId}`,
          request_id: requestId,
          model,
          modality: "TEXT",
          prompt_tokens: 20,
          completion_tokens: 8,
          total_tokens: 28,
          amount,
          currency: "CNY",
          estimated: false,
          status: "succeeded",
          error_code: null,
          created_at: "2026-08-28T00:00:00.000Z",
        },
      ],
      totals: {
        requests: 1,
        prompt_tokens: 20,
        completion_tokens: 8,
        total_tokens: 28,
        amount,
        currency: "CNY",
      },
      next_cursor: null,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )
}

describe("AiGatewayProvider", () => {
  const originalFetch = global.fetch
  const mockedFetch = jest.fn<typeof fetch>()
  const config = {
    get: jest.fn((name: string, fallback?: string) => {
      const values: Record<string, string> = {
        AI_GATEWAY_API_KEY: "test-key",
        AI_GATEWAY_BASE_URL: "https://gateway.example/v1",
        AI_GATEWAY_LISTING_MODEL: "ZQ-Think-Lite",
        AI_GATEWAY_DEBUG_LOGGING: "false",
      }
      return values[name] ?? fallback
    }),
  } as unknown as ConfigService

  const getRequestBody = (index: number): unknown => {
    const calls = mockedFetch.mock.calls as unknown as Array<
      [input: RequestInfo | URL, init?: RequestInit]
    >
    const body = calls[index]?.[1]?.body
    if (typeof body !== "string") throw new TypeError("测试请求体必须是 JSON 字符串")
    return JSON.parse(body) as unknown
  }

  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = mockedFetch
  })

  afterEach(() => {
    jest.restoreAllMocks()
    global.fetch = originalFetch
  })

  it.each(["ZQ-Think-Flash", "ZQ-Think-Pro"])(
    "SDK 请求保留 %s 和图片 content parts",
    async model => {
      mockedFetch.mockResolvedValueOnce(
        createSseResponse([{ choices: [{ delta: { content: "{}" } }] }])
      )
      const userContent = [
        { type: "text", text: "商品文字" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,test", detail: "high" } },
      ]
      const provider = new AiGatewayProvider(config)
      const events: AiGatewayStreamEvent[] = []
      for await (const event of provider.streamChat("system", "user", { model, userContent }))
        events.push(event)
      expect(events).toContainEqual({ type: "text", content: "{}" })
      expect(getRequestBody(0)).toMatchObject({
        model,
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: userContent },
        ],
      })
    }
  )

  it("通过官方 SDK 聚合流式结构化结果和用量", async () => {
    mockedFetch.mockResolvedValueOnce(
      createSseResponse([
        { choices: [{ delta: { content: '{"ok":' } }] },
        { choices: [{ delta: { content: "true}" } }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        },
      ])
    )
    const provider = new AiGatewayProvider(config)

    const result = await provider.generateJson<{ ok: boolean }>("system", "user")

    expect(result).toMatchObject({
      data: { ok: true },
      model: "ZQ-Think-Flash",
      requestId: null,
      tokenUsage: { promptTokens: 120, completionTokens: 30, thinkingTokens: 5 },
    })
    expect(mockedFetch.mock.calls).toHaveLength(1)
    const requestBody = getRequestBody(0) as {
      max_output_tokens?: number
      reasoning_level?: string
      response_format?: { type: string }
    }
    expect(requestBody.max_output_tokens).toBeUndefined()
    expect(requestBody.reasoning_level).toBeUndefined()
    expect(requestBody.response_format).toBeUndefined()
  })

  it("允许单次业务调用覆盖全局输出上限", async () => {
    mockedFetch.mockResolvedValueOnce(
      createSseResponse([{ choices: [{ delta: { content: '{"ok":true}' } }] }])
    )
    const provider = new AiGatewayProvider(config)

    await provider.generateJson<{ ok: boolean }>("system", "user", {
      maxOutputTokens: 3000,
      model: "ZQ-Think-Pro",
    })

    const requestBody = getRequestBody(0) as {
      max_output_tokens: number
      model: string
    }
    expect(requestBody.max_output_tokens).toBe(3000)
    expect(requestBody.model).toBe("ZQ-Think-Pro")
  })

  it("按请求 ID 查询中转站最终人民币花费", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        createSseResponse([{ choices: [{ delta: { content: '{"ok":true}' } }] }], "req-billing-1")
      )
      .mockResolvedValueOnce(createUsageResponse("req-billing-1", "0.0049761"))
    const provider = new AiGatewayProvider(config)

    const result = await provider.generateJson<{ ok: boolean }>("system", "user", {
      resolveBilling: true,
    })

    expect(result).toMatchObject({
      requestId: "req-billing-1",
      billing: {
        costCny: "0.0049761",
        currency: "CNY",
        model: "ZQ-Think-Lite",
        requestId: "req-billing-1",
        requestIds: ["req-billing-1"],
      },
    })
    expect(mockedFetch.mock.calls).toHaveLength(2)
  })

  it.each(["not-json", "", '{"unexpected":true}'])(
    "单次模式不因格式/空正文/结构错误再次请求 AI：%s",
    async content => {
      mockedFetch.mockResolvedValueOnce(createSseResponse([{ choices: [{ delta: { content } }] }]))
      const provider = new AiGatewayProvider(config)
      await expect(
        provider.generateJson("system", "user", {
          maxAttempts: 1,
          isDataValid: (data: { ok?: boolean }) => data.ok === true,
        })
      ).rejects.toThrow()
      expect(mockedFetch).toHaveBeenCalledTimes(1)
    }
  )

  it("格式纠错重试时合并两次网关实际花费", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        createSseResponse([{ choices: [{ delta: { content: "not-json" } }] }], "req-retry-1")
      )
      .mockResolvedValueOnce(
        createSseResponse([{ choices: [{ delta: { content: '{"ok":true}' } }] }], "req-retry-2")
      )
      .mockResolvedValueOnce(createUsageResponse("req-retry-1", "0.01"))
      .mockResolvedValueOnce(createUsageResponse("req-retry-2", "0.02"))
    const provider = new AiGatewayProvider(config)

    const result = await provider.generateJson<{ ok: boolean }>("system", "user", {
      resolveBilling: true,
    })

    expect(result.billing).toMatchObject({
      costCny: "0.03",
      requestId: "req-retry-1",
      requestIds: ["req-retry-1", "req-retry-2"],
    })
  })

  it("优先使用业务层白名单校验后的逻辑模型", async () => {
    mockedFetch.mockResolvedValueOnce(
      createSseResponse([{ choices: [{ delta: { content: '{"ok":true}' } }] }])
    )
    const provider = new AiGatewayProvider(config)

    const result = await provider.generateJson<{ ok: boolean }>("system", "user", {
      model: "ZQ-Think-Pro",
    })

    expect(result.model).toBe("ZQ-Think-Pro")
    expect(getRequestBody(0)).toMatchObject({ model: "ZQ-Think-Pro" })
  })

  it("streamChat 透传 responseFormat，省略时不发该字段", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        createSseResponse([
          { choices: [{ delta: { content: '{"ok":true}' } }] },
          { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } },
        ])
      )
      .mockResolvedValueOnce(createSseResponse([{ choices: [{ delta: { content: "x" } }] }]))
    const provider = new AiGatewayProvider(config)

    const events: AiGatewayStreamEvent[] = []
    for await (const event of provider.streamChat("system", "user", {
      responseFormat: { type: "json_object" },
    })) {
      events.push(event)
    }

    expect(getRequestBody(0)).toMatchObject({ response_format: { type: "json_object" } })
    const usageEvent = events.find(e => e.type === "usage")
    expect(usageEvent?.rawUsage).toMatchObject({ prompt_tokens: 1, completion_tokens: 2 })

    const events2: AiGatewayStreamEvent[] = []
    for await (const event of provider.streamChat("system", "user")) {
      events2.push(event)
    }
    expect(getRequestBody(1)).not.toHaveProperty("response_format")
  })

  it("将中转站流式响应映射为现有 Listing thinking/text/usage 事件", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        createSseResponse(
          [
            { choices: [{ delta: { reasoning_content: "分析商品事实" } }] },
            { choices: [{ delta: { content: '{"title":"Demo"}' } }] },
            {
              choices: [],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 8,
                completion_tokens_details: { reasoning_tokens: 3 },
              },
            },
          ],
          "req-stream-1"
        )
      )
      .mockResolvedValueOnce(createUsageResponse("req-stream-1", "0.02"))
    const provider = new AiGatewayProvider(config)
    const events: AiGatewayStreamEvent[] = []

    for await (const event of provider.streamChat("system", "user", { resolveBilling: true })) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: "thinking", content: "分析商品事实" },
      { type: "text", content: '{"title":"Demo"}' },
      {
        type: "usage",
        content: "",
        usage: {
          promptTokens: 20,
          completionTokens: 8,
          thinkingTokens: 3,
          totalTokens: 31,
        },
        rawUsage: {
          prompt_tokens: 20,
          completion_tokens: 8,
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      },
      {
        type: "billing",
        content: "",
        billing: {
          costCny: "0.02",
          currency: "CNY",
          model: "ZQ-Think-Lite",
          requestId: "req-stream-1",
          requestIds: ["req-stream-1"],
        },
      },
    ])
  })

  it("本地解析失败时使用严格 JSON 提示重试一次并累计用量", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        createSseResponse([
          { choices: [{ delta: { content: "not-json" } }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
        ])
      )
      .mockResolvedValueOnce(
        createSseResponse([
          { choices: [{ delta: { content: '{"ok":true}' } }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
        ])
      )
    const provider = new AiGatewayProvider(config)

    await expect(provider.generateJson<{ ok: boolean }>("system", "user")).resolves.toMatchObject({
      data: { ok: true },
      tokenUsage: { promptTokens: 22, completionTokens: 5, thinkingTokens: 0 },
    })
    expect(mockedFetch.mock.calls).toHaveLength(2)
    const retryBody = getRequestBody(1) as {
      messages: Array<{ content: string }>
      temperature: number
    }
    expect(retryBody.messages[0]?.content).toContain("格式纠错重试")
    expect(retryBody.temperature).toBe(0)
  })

  it("JSON 可解析但业务结构不完整时执行结构纠错重试", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        createSseResponse([{ choices: [{ delta: { content: '{"summary":{}}' } }] }])
      )
      .mockResolvedValueOnce(
        createSseResponse([
          {
            choices: [
              {
                delta: {
                  content: '{"summary":{"insights":[],"rankings":[]}}',
                },
              },
            ],
          },
        ])
      )
    const provider = new AiGatewayProvider(config)

    const result = await provider.generateJson<{ summary: Record<string, unknown> }>(
      "system",
      "user",
      {
        isDataValid: data =>
          Array.isArray(data.summary.insights) && Array.isArray(data.summary.rankings),
        retryInstruction: "summary 必须包含 insights 和 rankings 数组。",
      }
    )

    expect(result.data).toEqual({ summary: { insights: [], rankings: [] } })
    expect(mockedFetch.mock.calls).toHaveLength(2)
    const retryBody = getRequestBody(1) as {
      messages: Array<{ content: string }>
    }
    expect(retryBody.messages[0]?.content).toContain("summary 必须包含 insights 和 rankings 数组")
  })

  it("连续两次 JSON 业务结构都不完整时返回 502", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        createSseResponse([{ choices: [{ delta: { content: '{"summary":{}}' } }] }])
      )
      .mockResolvedValueOnce(
        createSseResponse([{ choices: [{ delta: { content: '{"summary":{}}' } }] }])
      )
    const provider = new AiGatewayProvider(config)

    await expect(
      provider.generateJson<{ summary: Record<string, unknown> }>("system", "user", {
        isDataValid: data => Array.isArray(data.summary.insights),
      })
    ).rejects.toThrow("AI 中转站返回的 JSON 结构不完整")
    expect(mockedFetch.mock.calls).toHaveLength(2)
  })

  it("提取解释文字中的 JSON 主体并修复尾随逗号", async () => {
    mockedFetch.mockResolvedValueOnce(
      createSseResponse([
        {
          choices: [
            {
              delta: {
                content: '分析完成：\n```json\n{"ok": true,}\n```\n请查收。',
              },
            },
          ],
        },
      ])
    )
    const provider = new AiGatewayProvider(config)

    await expect(provider.generateJson<{ ok: boolean }>("system", "user")).resolves.toMatchObject({
      data: { ok: true },
    })
    expect(mockedFetch.mock.calls).toHaveLength(1)
  })

  it("连续两次无法得到 JSON 时返回 502", async () => {
    mockedFetch
      .mockResolvedValueOnce(createSseResponse([{ choices: [{ delta: { content: "not-json" } }] }]))
      .mockResolvedValueOnce(
        createSseResponse([{ choices: [{ delta: { content: "still-not-json" } }] }])
      )
    const provider = new AiGatewayProvider(config)

    await expect(provider.generateJson("system", "user")).rejects.toBeInstanceOf(
      BadGatewayException
    )
    expect(mockedFetch.mock.calls).toHaveLength(2)
  })

  it("使用 SDK 分类错误将中转站 500 映射为上游内部异常", async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Internal server error", type: "api_error", code: null },
        }),
        { status: 500, headers: { "content-type": "application/json" } }
      )
    )
    const provider = new AiGatewayProvider(config)

    await expect(provider.generateJson("system", "user")).rejects.toThrow(
      "AI Gateway 内部异常（HTTP 500），请稍后重试"
    )
    expect(mockedFetch.mock.calls).toHaveLength(1)
  })

  it("开启调试开关后打印完整 SDK 请求和聚合响应但不打印 API Key", async () => {
    const debugLogger = jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined)
    const debugConfig = {
      get: jest.fn((name: string, fallback?: string) => {
        if (name === "AI_GATEWAY_DEBUG_LOGGING") return "true"
        return config.get<string>(name, fallback)
      }),
    } as unknown as ConfigService
    mockedFetch.mockResolvedValueOnce(
      createSseResponse([{ choices: [{ delta: { content: '{"ok":true}' } }] }], "req-debug")
    )
    const provider = new AiGatewayProvider(debugConfig)

    await provider.generateJson("完整系统提示词", "完整用户提示词")

    const debugOutput = debugLogger.mock.calls.map(([message]) => String(message)).join("\n")
    expect(debugOutput).toContain("url=https://gateway.example/v1/chat/completions")
    expect(debugOutput).toContain("完整系统提示词")
    expect(debugOutput).toContain("完整用户提示词")
    expect(debugOutput).toContain('"content": "{\\"ok\\":true}"')
    expect(debugOutput).not.toContain("test-key")
  })
})
