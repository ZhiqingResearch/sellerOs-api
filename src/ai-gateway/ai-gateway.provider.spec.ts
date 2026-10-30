import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Decimal } from "@prisma/client/runtime/library"
import {
  AiGatewayClient,
  GatewayApiError,
  type ChatCompletion,
  type GatewayResponse,
  type ImageTask,
  type PricingEstimate,
  type UsagePage,
  type VideoTask,
} from "@zhiqingresearch/ai-ts-sdk"
import { createServer } from "node:http"
import { AiGatewayProvider } from "./ai-gateway.provider"
import { ModerationPendingException } from "../content-moderation/task-moderation.service"
// eslint-disable-next-line @typescript-eslint/no-require-imports -- 中断测试需替换 CommonJS 的 fetch 导出。
import undici = require("undici")

interface TestableAiGatewayProvider {
  gateway: AiGatewayClient | null
  vidflowosGateway: AiGatewayClient | null
  waitingGateway: AiGatewayClient | null
}

describe("AiGatewayModule AiGatewayProvider", () => {
  const gatewayConfig = {
    AI_GATEWAY_API_KEY: "sk_test",
    AI_GATEWAY_BASE_URL: "https://gateway.example.com/",
  }

  function createProvider(values: Record<string, string> = {}) {
    const config = {
      get: jest.fn((key: string) => values[key]),
    }
    return new AiGatewayProvider(config as unknown as ConfigService,
      { requirePassed: jest.fn(async (_key, params) => params), beforeBusinessSubmission: jest.fn((_key, precheck) => precheck()), billingOwner: jest.fn().mockResolvedValue({ userId: 7, category: "NORMAL" }) } as never,
      { assertContent: jest.fn(async value => value) } as never,
      { resolveFixedVideoTier: jest.fn().mockResolvedValue({ creditsPerSec: new Decimal(1), flat: false }), assertExactCreditsAffordable: jest.fn() } as never)
  }

  function getGateway(provider: AiGatewayProvider): AiGatewayClient {
    const gateway = (provider as unknown as TestableAiGatewayProvider).gateway
    if (!gateway) throw new Error("测试未配置 AI Gateway")
    return gateway
  }

  it("审核未完成时不调用报价或视频生成SDK", async () => {
    const provider = createProvider(gatewayConfig)
    const moderation = (provider as unknown as { moderation: { requirePassed: jest.Mock } }).moderation
    moderation.requirePassed.mockRejectedValueOnce(new ModerationPendingException())
    const submit = jest.spyOn(getGateway(provider).videos.withResponse, "generate")
    const estimate = jest.spyOn(provider, "estimateVideoPrice")
    await expect(provider.createVideoTask({ model: "model", prompt: "内容" }, "video-task:1")).rejects.toBeInstanceOf(ModerationPendingException)
    expect(submit).not.toHaveBeenCalled()
    expect(estimate).not.toHaveBeenCalled()
  })

  it("图片审核拒绝时不调用生成SDK", async () => {
    const provider = createProvider(gatewayConfig)
    const moderation = (provider as unknown as { contentModeration: { assertContent: jest.Mock } }).contentModeration
    moderation.assertContent.mockRejectedValueOnce(new BadRequestException("未通过审核"))
    const submit = jest.spyOn(getGateway(provider).images.withResponse, "generate")
    await expect(provider.createImageTask({ model: "model", prompt: "内容" }, "image-task:1")).rejects.toMatchObject({ status: 400 })
    expect(submit).not.toHaveBeenCalled()
  })

  it("通过 SDK 提交视频任务并传入稳定幂等键", async () => {
    const provider = createProvider(gatewayConfig)
    const task: VideoTask = {
      id: "task_123",
      object: "video.task",
      status: "queued",
      model: "sourcing-storyboard-veo-lite",
      request_id: "req_123",
      created_at: 1,
    }
    const generate = jest
      .spyOn(getGateway(provider).videos.withResponse, "generate")
      .mockResolvedValue({
        data: task,
        response: {
          requestId: "req_123",
          status: 202,
          headers: new Headers(),
        },
      } satisfies GatewayResponse<VideoTask>)

    const params = {
      model: "sourcing-storyboard-veo-lite",
      prompt: "海边日出",
      duration_seconds: 4,
    } as const
    await expect(provider.createVideoTask(params, "storyboard-video:1")).resolves.toEqual(task)
    expect(generate).toHaveBeenCalledWith(params, { idempotencyKey: "storyboard-video:1" })
  })

  it("通过 SDK 提交图片任务并传入稳定幂等键", async () => {
    const provider = createProvider(gatewayConfig)
    const task: ImageTask = {
      id: "image_task_123",
      object: "image.task",
      status: "queued",
      model: "ZQ-Image-1",
      request_id: "req_image_123",
      created_at: 1,
    }
    const createTask = jest
      .spyOn(getGateway(provider).images.withResponse, "createTask")
      .mockResolvedValue({
        data: task,
        response: {
          requestId: "req_image_123",
          status: 202,
          headers: new Headers(),
        },
      } satisfies GatewayResponse<ImageTask>)
    const params = {
      model: "ZQ-Image-1",
      prompt: "职业人像",
      operation: "generate" as const,
      n: 2 as const,
    }

    await expect(provider.createImageTask(params, "portrait-generation-task:31")).resolves.toEqual(
      task
    )
    expect(createTask).toHaveBeenCalledWith({ ...params, aspect_ratio: "1:1", resolution: "1k", strict: false }, {
      idempotencyKey: "portrait-generation-task:31",
    })
  })

  it("合并后 VidFlowOS 专属 Key 图片提交与车泰斗长连接客户端保持独立", async () => {
    const provider = createProvider({ ...gatewayConfig, AI_GATEWAY_VIDFLOWOS_API_KEY: "sk_vidflowos_test" })
    const clients = provider as unknown as TestableAiGatewayProvider
    expect(provider.isVidflowosConfigured()).toBe(true)
    expect(clients.vidflowosGateway).not.toBe(clients.gateway)
    expect(clients.waitingGateway).not.toBe(clients.vidflowosGateway)
    const task: ImageTask = { id: "image_vidflowos", object: "image.task", status: "queued", model: "ZQ-Image-1", request_id: "req_vidflowos", created_at: 1 }
    const submit = jest.spyOn(clients.vidflowosGateway!.images.withResponse, "createTask").mockResolvedValue({
      data: task, response: { requestId: "req_vidflowos", status: 202, headers: new Headers() },
    })
    const platformSubmit = jest.spyOn(getGateway(provider).images.withResponse, "createTask")
    await expect(provider.createImageTask({ model: "ZQ-Image-1", prompt: "test" }, "vidflowos:1", "vidflowos")).resolves.toEqual(task)
    expect(submit).toHaveBeenCalled()
    expect(platformSubmit).not.toHaveBeenCalled()
    const completion: ChatCompletion = { id: "chat_wait", choices: [{ message: { role: "assistant", content: "ok" } }] }
    const complete = jest.spyOn(clients.waitingGateway!.chat.withResponse, "complete").mockResolvedValue({
      data: completion, response: { requestId: "req_wait", status: 200, headers: new Headers() },
    })
    await expect(provider.completeMultimodal({ model: "text", messages: [{ role: "user", content: "test" }] }, undefined, true)).resolves.toEqual({ completion, requestId: "req_wait" })
    expect(complete).toHaveBeenCalled()
  })

  it("调用多模态 Chat 并返回用于结算的 requestId", async () => {
    const provider = createProvider(gatewayConfig)
    const completion: ChatCompletion = {
      id: "chat_1",
      choices: [{ message: { role: "assistant", content: '{"prompt":"ok"}' } }],
    }
    const complete = jest
      .spyOn(getGateway(provider).chat.withResponse, "complete")
      .mockResolvedValue({
        data: completion,
        response: { requestId: "req_chat_1", status: 200, headers: new Headers() },
      })
    const request = {
      model: "ZQ-Multimodal-Gemini-3.1-Pro",
      messages: [{ role: "user" as const, content: "test" }],
    }

    await expect(provider.completeMultimodal(request)).resolves.toEqual({
      completion,
      requestId: "req_chat_1",
    })
    expect(complete).toHaveBeenCalledWith(request, undefined)
  })

  it("长连接客户端能通过真实 HTTP 发送请求并接收原回复", async () => {
    let requests = 0
    const completion = { id: "chat_http", choices: [{ message: { content: "ok" } }] }
    const server = createServer((request, response) => {
      requests++
      request.resume()
      response.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": "req_http",
        connection: "close",
      })
      response.end(JSON.stringify(completion))
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("测试服务未启动")
      const provider = createProvider({
        ...gatewayConfig,
        AI_GATEWAY_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      })
      await expect(
        provider.completeMultimodal(
          { model: "test-model", messages: [{ role: "user", content: "test" }] },
          undefined,
          true
        )
      ).resolves.toEqual({ completion, requestId: "req_http" })
      expect(requests).toBe(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    }
  })

  it("按 requestId 查询多模态实际用量", async () => {
    const provider = createProvider(gatewayConfig)
    const page: UsagePage = {
      object: "usage.list",
      data: [
        {
          id: "usage_1",
          request_id: "req_chat_1",
          model: "ZQ-Multimodal-Gemini-3.1-Pro",
          modality: "text",
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          amount: "0.125",
          currency: "CNY",
          estimated: false,
          status: "succeeded",
          error_code: null,
          created_at: "2026-08-27T00:00:00Z",
        },
      ],
      totals: {
        requests: 1,
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        amount: "0.125",
        currency: "CNY",
      },
      next_cursor: null,
    }
    const list = jest.spyOn(getGateway(provider).usage, "list").mockResolvedValue(page)

    await expect(provider.getUsageByRequestId("req_chat_1")).resolves.toEqual(page.data[0])
    expect(list).toHaveBeenCalledWith({ requestId: "req_chat_1", take: 10 })
  })

  it.each(["响应头", "正文"])("车泰斗等待%s超过五分钟中断，不重发请求", async stage => {
    jest.useFakeTimers()
    const timeout = jest.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms)
      return controller.signal
    })
    let signal: AbortSignal | undefined
    const fetch = jest.spyOn(undici, "fetch").mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined
      if (stage === "响应头") {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal?.reason as Error), { once: true })
        })
      }
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener("abort", () => controller.error(signal?.reason), {
                once: true,
              })
            },
          }),
          { headers: { "content-type": "application/json", "x-request-id": "late-request" } }
        ) as unknown as undici.Response
      )
    })
    try {
      const provider = createProvider(gatewayConfig)
      const result = provider.completeMultimodal(
        { model: "slow-model", messages: [{ role: "user", content: "test" }] },
        undefined,
        true
      )
      const rejected = expect(result).rejects.toBeInstanceOf(GatewayTimeoutException)
      await jest.advanceTimersByTimeAsync(5 * 60_000 - 1)
      expect(signal?.aborted).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      await rejected
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(signal?.aborted).toBe(true)
    } finally {
      fetch.mockRestore()
      timeout.mockRestore()
      jest.clearAllTimers()
      jest.useRealTimers()
    }
  })

  it("未配置 API Key 时不初始化 SDK 请求", async () => {
    const provider = createProvider()

    await expect(
      provider.createVideoTask({ model: "test-model", prompt: "test" }, "task:1")
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect((provider as unknown as TestableAiGatewayProvider).gateway).toBeNull()
  })

  it("查询当前可用的视频模型", async () => {
    const provider = createProvider(gatewayConfig)
    const models = [
      {
        id: "sourcing-storyboard-veo-lite",
        object: "model" as const,
        created: 1,
        owned_by: "zhiqingresearch",
        display_name: "客户分镜 Veo 3.1 Lite",
        modality: "video" as const,
        exec_mode: "async" as const,
        operations: ["videos.generations"],
      },
    ]
    const list = jest.spyOn(getGateway(provider).models.withResponse, "list").mockResolvedValue({
      data: { object: "list", data: models },
      response: { requestId: "req_models", status: 200, headers: new Headers() },
    })

    await expect(provider.listVideoModels()).resolves.toEqual(models)
    expect(list).toHaveBeenCalledWith({ modality: "VIDEO" })
  })

  it("使用完整请求参数调用 Gateway 视频价格预估", async () => {
    const provider = createProvider(gatewayConfig)
    const result: PricingEstimate<"videos.generations"> = {
      object: "pricing.estimate",
      model: "sourcing-veo-fast-i2v",
      operation: "videos.generations",
      currency: "CNY",
      variants: [],
      pricing_version: "price-v1",
      expires_at: 123,
    }
    const estimate = jest
      .spyOn(getGateway(provider).pricing.withResponse, "estimate")
      .mockResolvedValue({
        data: result,
        response: { requestId: "req_price", status: 200, headers: new Headers() },
      })
    const params = {
      model: "sourcing-veo-fast-i2v",
      prompt: "海边日出",
      duration_seconds: 8,
      resolution: "1080p" as const,
    }

    await expect(provider.estimateVideoPrice(params)).resolves.toEqual(result)
    expect(estimate).toHaveBeenCalledWith({
      operation: "videos.generations",
      request: params,
      expand: ["resolution"],
    })
  })

  it("统一解析 Gateway 价格预估的最高金额", () => {
    const provider = createProvider(gatewayConfig)
    const variants = [
      {
        parameters: {},
        estimated_amount: "1.20",
        minimum_amount: "1.00",
        maximum_amount: null,
        exact: false,
        route_dependent: false,
        assumptions: [],
      },
      {
        parameters: {},
        estimated_amount: "1.50",
        minimum_amount: "1.40",
        maximum_amount: "1.80",
        exact: false,
        route_dependent: false,
        assumptions: [],
      },
    ]

    expect(provider.maximumQuoteAmount(variants).toString()).toBe("1.8")
    expect(() => provider.maximumQuoteAmount([])).toThrow(BadGatewayException)
  })

  it("把 SDK 业务错误转换为包含 requestId 的中文异常", async () => {
    const provider = createProvider(gatewayConfig)
    jest.spyOn(getGateway(provider).videos.withResponse, "generate").mockRejectedValue(
      new GatewayApiError({
        message: "duration_seconds 只支持 4 / 6 / 8",
        status: 400,
        type: "invalid_request_error",
        code: "invalid_request_error",
        requestId: "req_failed",
      })
    )

    await expect(
      provider.createVideoTask({ model: "test-model", prompt: "test" }, "task:1")
    ).rejects.toEqual(
      new BadRequestException(
        "AI Gateway 提交视频任务失败：duration_seconds 只支持 4 / 6 / 8 [requestId=req_failed]"
      )
    )
  })
})
