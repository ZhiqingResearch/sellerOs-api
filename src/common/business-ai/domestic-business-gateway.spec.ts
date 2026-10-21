import { BadRequestException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { AiGatewayProvider, type AiGatewayStreamOptions } from "../providers/ai-gateway.provider"
import { DomesticBusinessGateway } from "./domestic-business-gateway"
import { DomesticBusinessModels } from "./domestic-business-models"

describe("业务专用国产模型网关（不改变公共 Provider）", () => {
  const assertEnabled = jest.fn()
  const gateway = new DomesticBusinessGateway(new ConfigService(), {
    assertEnabled,
  } as unknown as DomesticBusinessModels)
  afterEach(() => jest.restoreAllMocks())
  beforeEach(() => {
    assertEnabled.mockReset().mockResolvedValue(undefined)
  })

  it.each(["qwen3.8-max", "MiniMax-M3"])("流式保持前端选择 %s 并适配参数", async model => {
    const stream = jest
      .spyOn(AiGatewayProvider.prototype, "streamChat")
      .mockImplementation(async function* () {
        yield await Promise.resolve({ type: "text" as const, content: "{}" })
      })
    const options = {
      model,
      temperature: 0.2,
      maxOutputTokens: 4000,
      responseFormat: { type: "json_object" },
    }
    for await (const event of gateway.streamChat("系统", "资料", options))
      expect(event.content).toBe("{}")
    expect(assertEnabled).toHaveBeenCalledWith(model)
    expect(stream.mock.calls[0][2]).toEqual(
      model === "MiniMax-M3"
        ? { ...options, temperature: 1, maxOutputTokens: undefined, responseFormat: undefined }
        : options
    )
    expect(options.temperature).toBe(0.2)
  })
  it("禁用的模型不调用网关，不走默认模型", async () => {
    assertEnabled.mockRejectedValue(new BadRequestException("模型停用"))
    const stream = jest.spyOn(AiGatewayProvider.prototype, "streamChat")
    await expect(gateway.generateJson("", "", { model: "qwen3.8-max" })).rejects.toThrow("模型停用")
    await expect(
      (async () => {
        for await (const event of gateway.streamChat("", "")) {
          expect(event).toBeUndefined()
        }
      })()
    ).rejects.toThrow("模型停用")
    expect(stream).not.toHaveBeenCalled()
  })
  it("Qwen JSON 继续复用原实现和验证选项", async () => {
    const json = jest.spyOn(AiGatewayProvider.prototype, "generateJson").mockResolvedValue({
      data: {},
      model: "qwen3.8-max",
      requestId: null,
      tokenUsage: { promptTokens: 0, completionTokens: 0, thinkingTokens: 0 },
    })
    const options = { model: "qwen3.8-max", maxAttempts: 1 as const, maxOutputTokens: 3000 }
    await gateway.generateJson("系统", "资料", options)
    expect(json).toHaveBeenCalledWith("系统", "资料", options)
  })
  it("MiniMax JSON 纠错保留原模型和温度，累计两次账单与 token", async () => {
    let attempt = 0
    const stream = jest
      .spyOn(AiGatewayProvider.prototype, "streamChat")
      .mockImplementation(async function* (_system, _user, options?: AiGatewayStreamOptions) {
        const index = await Promise.resolve(++attempt)
        expect(options).toMatchObject({
          model: "MiniMax-M3",
          temperature: 1,
          maxOutputTokens: undefined,
        })
        yield {
          type: "text",
          content: index === 1 ? '{"wrong":true}' : '```json\n{"ok":true}\n```',
        }
        yield {
          type: "usage",
          content: "",
          usage: { promptTokens: 10, completionTokens: 3, thinkingTokens: 2, totalTokens: 15 },
        }
        yield {
          type: "billing",
          content: "",
          billing: {
            model: "MiniMax-M3",
            costCny: "0.1",
            currency: "CNY",
            requestId: `req-${index}`,
            requestIds: [`req-${index}`],
          },
        }
      })
    const result = await gateway.generateJson<{ ok: boolean }>("系统", "资料", {
      model: "MiniMax-M3",
      maxOutputTokens: 4000,
      resolveBilling: true,
      isDataValid: data => data.ok === true,
    })
    expect(result).toMatchObject({
      data: { ok: true },
      model: "MiniMax-M3",
      requestId: "req-2",
      tokenUsage: { promptTokens: 20, completionTokens: 6, thinkingTokens: 4 },
      billing: { costCny: "0.2", requestIds: ["req-1", "req-2"] },
    })
    expect(stream).toHaveBeenCalledTimes(2)
  })
  it("Listing 的 maxAttempts=1 禁止自动再生成", async () => {
    const stream = jest
      .spyOn(AiGatewayProvider.prototype, "streamChat")
      .mockImplementation(async function* () {
        yield await Promise.resolve({ type: "text" as const, content: "无效正文" })
      })
    await expect(
      gateway.generateJson("", "", { model: "MiniMax-M3", maxAttempts: 1 })
    ).rejects.toThrow("不是有效 JSON")
    expect(stream).toHaveBeenCalledTimes(1)
  })
  it("连接异常不自动重发或切换模型", async () => {
    const stream = jest
      .spyOn(AiGatewayProvider.prototype, "streamChat")
      .mockImplementation(async function* () {
        yield await Promise.reject(new Error("连接中断"))
      })
    await expect(gateway.generateJson("", "", { model: "MiniMax-M3" })).rejects.toThrow("连接中断")
    expect(stream).toHaveBeenCalledTimes(1)
  })
})
