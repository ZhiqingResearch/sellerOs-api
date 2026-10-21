import type { Response } from "express"
import { ListingAiInvocationDto } from "./dto/listing-ai.dto"
import { ListingController } from "./listing.controller"

describe("独立评分入口路由", () => {
  const request = { user: { id: 3 } }
  const dto: ListingAiInvocationDto = { operation: "score", userPrompt: "待评分 Listing" }

  function setup() {
    const legacy = {
      complete: jest.fn().mockResolvedValue({ text: "生成流程内评分" }),
      stream: jest.fn(async function* () {
        yield { type: "text", content: "生成流程内评分" }
      }),
    }
    const score = {
      complete: jest.fn().mockResolvedValue({ text: "独立评分" }),
      stream: jest.fn(async function* () {
        yield { type: "text", content: "独立评分" }
      }),
      read: jest.fn().mockResolvedValue({ status: "COMPLETED" }),
    }
    const controller = new ListingController(
      legacy as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      score as never
    )
    return { controller, legacy, score }
  }

  it("非流式独立评分进入持久化服务，生成工作流内评分保留原路由", async () => {
    const { controller, legacy, score } = setup()
    await expect(controller.completeAi(request, dto)).resolves.toEqual({ text: "独立评分" })
    expect(score.complete).toHaveBeenCalledWith(3, dto)
    expect(legacy.complete).not.toHaveBeenCalled()
    await controller.completeAi(request, { ...dto, runId: "generation-run" })
    expect(legacy.complete).toHaveBeenCalledTimes(1)
    expect(score.complete).toHaveBeenCalledTimes(1)
  })

  it("流式独立评分也进入持久化服务并返回完成标记", async () => {
    const { controller, legacy, score } = setup()
    const response = {
      status: jest.fn(),
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      writableEnded: false,
      destroyed: false,
    }
    await controller.streamAi(request, dto, response as unknown as Response)
    expect(score.stream).toHaveBeenCalledWith(3, dto)
    expect(legacy.stream).not.toHaveBeenCalled()
    expect(response.write).toHaveBeenCalledWith("data: [DONE]\n\n")
    expect(response.end).toHaveBeenCalledTimes(1)
  })

  it("结果读取始终传递当前登录用户，不能按请求号跨用户查询", async () => {
    const { controller, score } = setup()
    await controller.readScore(request, "score-request")
    expect(score.read).toHaveBeenCalledWith(3, "score-request")
  })
})
