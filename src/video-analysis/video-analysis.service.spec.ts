import { ConflictException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import type { Response } from "express"
import type { AiGatewayStreamEvent } from "../common/providers/ai-gateway.provider"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { VideoAnalysisDto } from "./dto/video-analysis.dto"
import { VideoAnalysisRecordService } from "./video-analysis-record.service"
import { VideoAnalysisController } from "./video-analysis.controller"
import {
  VIDEO_ANALYSIS_CATEGORY,
  VideoAnalysisModel,
  VideoAnalysisModels,
  resolveVideoMimeType,
} from "./video-analysis.models"
import { normalizeVideoAnalysisResult } from "./video-analysis.normalize"
import { buildVideoAnalysisUserPrompt } from "./video-analysis.prompts"
import { VideoAnalysisService, VideoAnalysisSseEvent } from "./video-analysis.service"

const CREDITS = new Decimal(5)

const GEMINI_LITE_CAPS = {
  supportsAudio: true,
  sendsMimeType: true,
  supportsJsonMode: true,
  promptTokensIncludeVideo: true,
}
const GEMINI_37_CAPS = {
  supportsAudio: true,
  sendsMimeType: true,
  supportsJsonMode: false,
  promptTokensIncludeVideo: false,
}
const QWEN_CAPS = {
  supportsAudio: false,
  sendsMimeType: false,
  supportsJsonMode: true,
  promptTokensIncludeVideo: true,
}

function videoModel(
  publicId = "ZQ-Multimodal-Gemini-3.5-Flash-Lite",
  caps: Record<string, boolean> = GEMINI_LITE_CAPS,
  fixedCredits: Decimal | null = CREDITS
): VideoAnalysisModel {
  return { publicId, fixedCredits, ...caps } as VideoAnalysisModel
}

/** AiGatewayModel.VIDEO_ANALYSIS 启用行（DB 形状） */
function dbRow(
  publicId: string,
  caps: Record<string, boolean>,
  sortOrder: number,
  fixedCredits: Decimal | null = CREDITS
) {
  return { publicId, fixedCredits, sortOrder, gatewayConfig: { videoAnalysis: caps } }
}

const DEFAULT_ROWS = [
  dbRow("ZQ-Multimodal-Gemini-3.5-Flash-Lite", GEMINI_LITE_CAPS, 1),
  dbRow("ZQ-Multimodal-Gemini-3.7-Flash", GEMINI_37_CAPS, 2),
  dbRow("ZQ-Multimodal-Qwen-3.7-Plus", QWEN_CAPS, 3),
]

function baseDto(overrides: Partial<VideoAnalysisDto> = {}): VideoAnalysisDto {
  return {
    videoUrl: "https://cdn.example.com/video.mp4",
    duration: 30,
    chargeRequestId: "video-analysis-0f1e2d3c-4b5a-6789-abcd-ef0123456789",
    ...overrides,
  }
}

function textEvent(content: string): AiGatewayStreamEvent {
  return { type: "text", content }
}

function usageEvent(promptTokens: number, rawUsage?: unknown): AiGatewayStreamEvent {
  return {
    type: "usage",
    content: "",
    usage: {
      promptTokens,
      completionTokens: 100,
      thinkingTokens: 0,
      totalTokens: promptTokens + 100,
    },
    ...(rawUsage !== undefined ? { rawUsage } : {}),
  }
}

const VALID_RESULT_JSON = JSON.stringify({
  title: "开箱视频",
  overview: "概览",
  category: "开箱",
  language: "中文",
  keywords: ["开箱"],
  people: [],
  objects: ["耳机"],
  notes: [],
  hook: {
    hasHook: true,
    effectiveness: "强",
    timeWindow: "开场 0 至 3 秒",
    type: "视觉冲击",
    evidence: "特写",
    suggestion: "保持",
  },
  audio: { summary: "背景音乐", transcript: "无可辨认对白", events: [], music: "轻快" },
  scenes: [{ start: 0, end: 5, title: "开场", description: "特写", prompt: "提示词" }],
  shots: [{ timestamp: 2, title: "截图", reason: "清晰", caption: "说明", prompt: "提示词" }],
})

describe("VideoAnalysisModels（白名单/默认模型/能力开关走 AiGatewayModel）", () => {
  let aiGatewayModel: { findMany: jest.Mock }
  let models: VideoAnalysisModels

  beforeEach(() => {
    aiGatewayModel = { findMany: jest.fn().mockResolvedValue(DEFAULT_ROWS) }
    models = new VideoAnalysisModels({ aiGatewayModel } as unknown as PrismaService)
  })

  it("缺省 model → sortOrder 最小的启用行（默认模型）；解析出能力开关与一口价", async () => {
    const model = await models.assertRequest(baseDto())

    expect(aiGatewayModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { category: VIDEO_ANALYSIS_CATEGORY, enabled: true, gatewayActive: true },
      })
    )
    expect(model).toEqual(videoModel())
  })

  it.each([null, new Decimal(0), new Decimal(-1)])(
    "一口价 %s → 允许按量计费",
    async fixedCredits => {
      aiGatewayModel.findMany.mockResolvedValue([dbRow("M1", GEMINI_LITE_CAPS, 1, fixedCredits)])
      expect((await models.assertRequest(baseDto())).fixedCredits).toBeNull()
    }
  )

  it("指定 model → 命中白名单行", async () => {
    const model = await models.assertRequest(baseDto({ model: "ZQ-Multimodal-Qwen-3.7-Plus" }))

    expect(model.publicId).toBe("ZQ-Multimodal-Qwen-3.7-Plus")
    expect(model.supportsAudio).toBe(false)
  })

  it("白名单外模型 → 400 冻结文案（可选列表来自 DB 行）", async () => {
    await expect(models.assertRequest(baseDto({ model: "gpt-4o" }))).rejects.toThrow(
      "不支持的模型：gpt-4o。可选：ZQ-Multimodal-Gemini-3.5-Flash-Lite / ZQ-Multimodal-Gemini-3.7-Flash / ZQ-Multimodal-Qwen-3.7-Plus"
    )
  })

  it("videoUrl 非 https / duration 非法 / 超 600 / chargeRequestId 缺失 → 冻结文案", async () => {
    await expect(models.assertRequest(baseDto({ videoUrl: "http://x" }))).rejects.toThrow(
      "videoUrl 必填，且必须是公网可访问的 https 地址"
    )
    await expect(models.assertRequest(baseDto({ duration: 0 }))).rejects.toThrow(
      "duration 必填且必须大于 0"
    )
    await expect(models.assertRequest(baseDto({ duration: 601 }))).rejects.toThrow(
      "单条视频时长不能超过 10 分钟"
    )
    await expect(models.assertRequest(baseDto({ chargeRequestId: "" }))).rejects.toThrow(
      /chargeRequestId/
    )
  })

  it("无启用行 / 缺能力开关 → 503 fail-closed", async () => {
    aiGatewayModel.findMany.mockResolvedValue([])
    await expect(models.assertRequest(baseDto())).rejects.toThrow(/无启用模型行/)

    aiGatewayModel.findMany.mockResolvedValue([
      { publicId: "M1", fixedCredits: CREDITS, sortOrder: 1, gatewayConfig: {} },
    ])
    await expect(models.assertRequest(baseDto())).rejects.toThrow(/缺少能力开关配置/)
  })
})

describe("VideoAnalysisService", () => {
  let gateway: { streamChat: jest.Mock }
  let usage: {
    assertExactCreditsAffordable: jest.Mock
    chargeModel: jest.Mock
    gatewayPriceMultiplier: jest.Mock
  }
  let service: VideoAnalysisService
  let records: { findReplay: jest.Mock; save: jest.Mock }

  beforeEach(() => {
    gateway = { streamChat: jest.fn() }
    usage = {
      assertExactCreditsAffordable: jest.fn().mockResolvedValue(undefined),
      gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal(3)),
      chargeModel: jest.fn().mockResolvedValue({
        costCny: new Decimal("0.5"),
        creditsCharged: CREDITS,
        balance: new Decimal(120),
        breakdown: [{ bucket: "RECHARGE", amount: "5" }],
        duplicate: false,
      }),
    }
    records = {
      findReplay: jest.fn().mockResolvedValue(null),
      save: jest
        .fn()
        .mockImplementation(
          (_userId: number, _dto: VideoAnalysisDto, model: string, snapshot: { result: unknown }) =>
            Promise.resolve({
              recordId: "48efab82-71c1-4d4e-a626-5bc0ac351e53",
              model,
              ...snapshot,
            })
        ),
    }
    service = new VideoAnalysisService(
      gateway as unknown as AiGatewayProvider,
      usage as unknown as UsageService,
      records as unknown as VideoAnalysisRecordService,
      {
        getConsumableBalanceRouted: jest.fn().mockResolvedValue(new Decimal(120)),
      } as unknown as CreditService
    )
  })

  const mockStream = (events: AiGatewayStreamEvent[]) => {
    gateway.streamChat.mockImplementationOnce(async function* () {
      for (const event of events) {
        await Promise.resolve()
        yield event
      }
    })
  }

  /** streamChat 第 index 次调用的 (systemPrompt, userPrompt, options)，收窄避免 any 访问 */
  const streamCall = (
    index = 0
  ): [
    string,
    string,
    {
      userContent: { type: string; [key: string]: unknown }[]
      maxOutputTokens?: number
      responseFormat?: unknown
    },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  ] => gateway.streamChat.mock.calls[index]

  /** chargeModel 第 index 次调用的 (userId, costCny, params)，收窄避免 any 访问 */
  const chargeCall = (
    index = 0
  ): [
    number,
    string,
    {
      source: string
      model: string
      exactCredits: string
      requestId?: string
      allowOverdraft?: boolean
      meta: Record<string, unknown>
    },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  ] => usage.chargeModel.mock.calls[index]

  const collect = async (
    dto: VideoAnalysisDto,
    model = videoModel()
  ): Promise<VideoAnalysisSseEvent[]> => {
    const events: VideoAnalysisSseEvent[] = []
    for await (const event of service.stream(dto, 9, model)) events.push(event)
    return events
  }

  it("happy path：事件序 progress→progress→usage→usage_detail→charge→progress(parsing)→result", async () => {
    mockStream([
      textEvent("{"),
      textEvent('"title":"开箱视频"}'),
      usageEvent(4000, {
        prompt_tokens_details: { video_tokens: 3000, audio_tokens: 500, text_tokens: 500 },
      }),
      {
        type: "billing",
        content: "",
        billing: {
          costCny: "0.21",
          currency: "CNY",
          model: "m",
          requestId: "r",
          requestIds: ["r"],
        },
      },
    ])

    const events = await collect(baseDto())

    expect(events.map(e => e.type)).toEqual([
      "progress",
      "progress",
      "usage",
      "usage_detail",
      "charge",
      "progress",
      "result",
    ])
    const usageDetail = events[3] as {
      type: string
      videoInputTokens: number
      audioInputTokens: number
      textInputTokens: number
    }
    expect(usageDetail).toEqual({
      type: "usage_detail",
      videoInputTokens: 3000,
      audioInputTokens: 500,
      textInputTokens: 500,
    })
    const charge = events[4] as Record<string, unknown>
    expect(charge).toEqual({
      type: "charge",
      ok: true,
      creditsCharged: "5",
      balance: "120",
      costCny: "0.5",
      breakdown: [{ bucket: "RECHARGE", amount: "5" }],
    })
    const result = events[6] as { data: { title: string }; model: string }
    expect(result.data.title).toBe("开箱视频")
    expect(result.model).toBe("ZQ-Multimodal-Gemini-3.5-Flash-Lite")
    expect(events[6]).toHaveProperty("recordId", "48efab82-71c1-4d4e-a626-5bc0ac351e53")
    expect(records.save).toHaveBeenCalledWith(9, baseDto(), videoModel().publicId, {
      result: expect.objectContaining({ title: "开箱视频" }) as unknown,
      usage: expect.objectContaining({ totalTokens: 4100 }) as unknown,
      usageDetail: { videoInputTokens: 3000, audioInputTokens: 500, textInputTokens: 500 },
      charge,
    })

    const [chargeUserId, costCny, chargeParams] = chargeCall()
    expect(chargeUserId).toBe(9)
    expect(costCny).toBe("0.5")
    expect(chargeParams).toMatchObject({
      source: "video.analysis",
      model: "ZQ-Multimodal-Gemini-3.5-Flash-Lite",
      exactCredits: "5",
      requestId: "charge:video-analysis-0f1e2d3c-4b5a-6789-abcd-ef0123456789",
      allowOverdraft: true,
    })
    expect(chargeParams.meta).toMatchObject({
      totalTokens: 4100,
      videoUrl: "https://cdn.example.com/video.mp4",
      gatewayAmount: "0.21",
    })
  })

  it("网关请求形状：无 system、video_url 部件（含 mime_type/fps=2）在前文本在后、json mode 模型发 response_format", async () => {
    mockStream([textEvent(VALID_RESULT_JSON), usageEvent(4000)])

    await collect(baseDto())

    const [systemPrompt, , options] = streamCall()
    expect(systemPrompt).toBe("")
    expect(options.userContent[0]).toEqual({
      type: "video_url",
      video_url: { url: "https://cdn.example.com/video.mp4" },
      mime_type: "video/mp4",
      fps: 2,
    })
    expect(options.userContent[1].type).toBe("text")
    expect(options.maxOutputTokens).toBe(16384)
    expect(options.responseFormat).toEqual({ type: "json_object" })
  })

  it("3.7 Flash（不支持 JSON mode）不发 response_format；Qwen 不发 mime_type", async () => {
    mockStream([textEvent(VALID_RESULT_JSON), usageEvent(4000)])
    mockStream([textEvent(VALID_RESULT_JSON), usageEvent(4000)])

    await collect(baseDto(), videoModel("ZQ-Multimodal-Gemini-3.7-Flash", GEMINI_37_CAPS))
    expect(streamCall(0)[2].responseFormat).toBeUndefined()

    await collect(baseDto(), videoModel("ZQ-Multimodal-Qwen-3.7-Plus", QWEN_CAPS))
    expect(streamCall(1)[2].userContent[0]).not.toHaveProperty("mime_type")
  })

  it("无流式增量 → 不发第二个 progress（结果解析失败抛错，但 progress 序列证明无增量事件）", async () => {
    mockStream([usageEvent(4000)])

    const events: { type: string; message?: string }[] = []
    await expect(
      (async () => {
        for await (const event of service.stream(baseDto(), 9, videoModel())) events.push(event)
      })()
    ).rejects.toThrow("AI 未返回有效的视频分析结果")

    expect(events.filter(e => e.type === "progress").map(e => e.message)).toEqual([
      "模型正在理解视频",
      "正在整理分析结果",
    ])
  })

  it("预检不足 → 生成器抛错，网关未调用", async () => {
    usage.assertExactCreditsAffordable.mockRejectedValue(new Error("积分余额不足，本次需 5 积分"))

    await expect(collect(baseDto())).rejects.toThrow("积分余额不足")
    expect(gateway.streamChat).not.toHaveBeenCalled()
    expect(usage.chargeModel).not.toHaveBeenCalled()
    expect(records.save).not.toHaveBeenCalled()
  })

  it("网关调用抛错 → 生成器抛错且未扣费", async () => {
    gateway.streamChat.mockImplementationOnce(async function* () {
      await Promise.resolve()
      yield textEvent("部分")
      throw new Error("AI Gateway 调用失败（HTTP 502）")
    })

    await expect(collect(baseDto())).rejects.toThrow("AI Gateway 调用失败")
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("守卫触发（promptTokens < 50/秒）→ 抛错，无 usage/charge/result", async () => {
    mockStream([textEvent(VALID_RESULT_JSON), usageEvent(200)])

    const events: { type: string }[] = []
    await expect(
      (async () => {
        for await (const event of service.stream(baseDto(), 9, videoModel())) events.push(event)
      })()
    ).rejects.toThrow("模型未能接收到视频内容")
    expect(events.map(e => e.type)).toEqual(["progress", "progress"])
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("守卫对 promptTokensIncludeVideo=false 的模型（3.7 Flash）不启用", async () => {
    mockStream([textEvent(VALID_RESULT_JSON), usageEvent(200)])

    const events = await collect(
      baseDto(),
      videoModel("ZQ-Multimodal-Gemini-3.7-Flash", GEMINI_37_CAPS)
    )

    expect(events.map(e => e.type)).toContain("result")
  })

  it("扣费失败 → charge {ok:false, message}，result 照常下发", async () => {
    mockStream([textEvent(VALID_RESULT_JSON), usageEvent(4000)])
    usage.chargeModel.mockRejectedValue(new Error("积分余额不足，请充值"))

    const events = await collect(baseDto())

    const charge = events.find(e => e.type === "charge") as Record<string, unknown>
    expect(charge).toEqual({ type: "charge", ok: false, message: "积分余额不足，请充值" })
    expect(events[events.length - 1].type).toBe("result")
    expect(records.save).toHaveBeenCalledWith(
      9,
      baseDto(),
      videoModel().publicId,
      expect.objectContaining({ charge }) as unknown
    )
  })

  it("结果不是合法 JSON → 扣费后抛错，无 result", async () => {
    mockStream([textEvent("这不是 JSON"), usageEvent(4000)])

    const events: { type: string }[] = []
    await expect(
      (async () => {
        for await (const event of service.stream(baseDto(), 9, videoModel())) events.push(event)
      })()
    ).rejects.toThrow("AI 未返回有效的视频分析结果")
    expect(events.some(e => e.type === "charge")).toBe(true)
    expect(events.some(e => e.type === "result")).toBe(false)
    expect(records.save).not.toHaveBeenCalled()
  })

  it("落库失败 → 中文错误且无 result，不返回未保存的报告", async () => {
    mockStream([textEvent(VALID_RESULT_JSON), usageEvent(4000)])
    records.save.mockRejectedValue(new Error("database unavailable"))
    const events: VideoAnalysisSseEvent[] = []
    await expect(
      (async () => {
        for await (const event of service.stream(baseDto(), 9, videoModel())) events.push(event)
      })()
    ).rejects.toThrow("视频分析结果保存失败，请使用原 chargeRequestId 重试")
    expect(events.some(event => event.type === "result")).toBe(false)
    expect(usage.chargeModel).toHaveBeenCalledTimes(1)
  })

  it("已落库请求直接重放首次结果，不预检余额、不再次调用网关或扣费", async () => {
    const replay = {
      recordId: "48efab82-71c1-4d4e-a626-5bc0ac351e53",
      model: videoModel().publicId,
      result: normalizeVideoAnalysisResult(JSON.parse(VALID_RESULT_JSON), 30, true),
      usage: { promptTokens: 4000, completionTokens: 100, thinkingTokens: 0, totalTokens: 4100 },
      usageDetail: { videoInputTokens: 3000, audioInputTokens: 500, textInputTokens: 500 },
      charge: {
        type: "charge",
        ok: true,
        creditsCharged: "5",
        balance: "120",
        costCny: "0.5",
        breakdown: [],
      },
    }
    records.findReplay.mockResolvedValue(replay)
    const events = await collect(baseDto())
    expect(events.find(event => event.type === "charge")).toEqual({
      ...replay.charge,
      duplicate: true,
    })
    expect(events.at(-1)).toEqual({
      type: "result",
      data: replay.result,
      model: replay.model,
      recordId: replay.recordId,
    })
    expect(usage.assertExactCreditsAffordable).not.toHaveBeenCalled()
    expect(usage.chargeModel).not.toHaveBeenCalled()
    expect(gateway.streamChat).not.toHaveBeenCalled()
    expect(records.save).not.toHaveBeenCalled()
  })

  it("已删除或同键不同参数的重试被阻止，不调用网关、不扣费", async () => {
    records.findReplay.mockRejectedValue(
      new ConflictException("chargeRequestId 已用于其他视频分析请求")
    )
    await expect(collect(baseDto())).rejects.toThrow("chargeRequestId")
    expect(gateway.streamChat).not.toHaveBeenCalled()
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("客户端断开后仍跑完分析、扣费和结果保存", async () => {
    mockStream([textEvent(VALID_RESULT_JSON), usageEvent(4000)])
    const response = {
      destroyed: true,
      writableEnded: false,
      status: jest.fn(),
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    }
    const controller = new VideoAnalysisController(
      {
        assertRequest: jest.fn().mockResolvedValue(videoModel()),
      } as unknown as VideoAnalysisModels,
      service
    )
    await controller.analyze({ user: { id: 9 } }, baseDto(), response as unknown as Response)
    expect(records.save).toHaveBeenCalledTimes(1)
    expect(usage.chargeModel).toHaveBeenCalledTimes(1)
    expect(response.write).not.toHaveBeenCalled()
    expect(response.end).toHaveBeenCalledTimes(1)
  })

  it.each(["0.21", "0"])("无一口价 → 实际账单 %s 乘类目倍率，零金额不扣费", async costCny => {
    mockStream([
      textEvent(VALID_RESULT_JSON),
      usageEvent(4000),
      {
        type: "billing",
        content: "",
        billing: {
          costCny,
          currency: "CNY",
          model: videoModel().publicId,
          requestId: "r",
          requestIds: ["r"],
        },
      },
    ])
    const events = await collect(baseDto(), videoModel(undefined, undefined, null))
    expect(usage.assertExactCreditsAffordable).not.toHaveBeenCalled()
    expect(events.find(e => e.type === "charge")).toMatchObject({ ok: true })
    expect(events.at(-1)?.type).toBe("result")
    if (costCny === "0") {
      expect(usage.chargeModel).not.toHaveBeenCalled()
      expect(events.find(e => e.type === "charge")).toMatchObject({
        creditsCharged: "0",
        costCny: "0",
        balance: "120",
      })
    } else {
      expect(usage.gatewayPriceMultiplier).toHaveBeenCalledWith(
        videoModel().publicId,
        VIDEO_ANALYSIS_CATEGORY
      )
      expect(chargeCall()[1]).toBe("0.63")
      expect(chargeCall()[2]).not.toHaveProperty("exactCredits")
      expect(chargeCall()[2]).toMatchObject({
        requestId: `charge:${baseDto().chargeRequestId}`,
        allowOverdraft: true,
      })
      expect(chargeCall()[2].meta).toMatchObject({
        pricingMode: "metered",
        gatewayAmountCny: "0.21",
        priceMultiplier: "3",
      })
    }
  })

  it("无一口价且账单缺失 → charge 失败，保留结果且不估算扣费", async () => {
    mockStream([textEvent(VALID_RESULT_JSON), usageEvent(4000)])
    const events = await collect(baseDto(), videoModel(undefined, undefined, null))
    expect(events.find(e => e.type === "charge")).toMatchObject({ ok: false })
    expect(usage.chargeModel).not.toHaveBeenCalled()
    expect(events.at(-1)?.type).toBe("result")
  })

  it("一口价从解析出的模型行取值（DB 改价即生效）", async () => {
    mockStream([textEvent(VALID_RESULT_JSON), usageEvent(4000)])

    await collect(baseDto(), videoModel("ZQ-Multimodal-Qwen-3.7-Plus", QWEN_CAPS, new Decimal(10)))

    expect(chargeCall()[1]).toBe("1")
    expect(chargeCall()[2].exactCredits).toBe("10")
    expect(usage.gatewayPriceMultiplier).not.toHaveBeenCalled()
  })
})

describe("mimeType 推导", () => {
  it("mimeType 缺省按扩展名推导，未知扩展回落 video/mp4", () => {
    expect(resolveVideoMimeType("https://x/a.webm")).toBe("video/webm")
    expect(resolveVideoMimeType("https://x/a")).toBe("video/mp4")
  })
})

describe("userPrompt 构造（P0 §5.5 逐行等价）", () => {
  it("focus 为空 → 固定句；duration 保留两位小数", () => {
    const prompt = buildVideoAnalysisUserPrompt({ duration: 30, focus: "  ", supportsAudio: false })
    expect(prompt).toContain("本条视频时长约 30.00 秒，所有时间戳必须落在 0 至 30.00 秒之间。")
    expect(prompt).toContain("用户没有提供额外关注点。")
    expect(prompt).toContain("本次**没有**音频能力")
  })

  it("有音频能力 → 如实分析音频行", () => {
    const prompt = buildVideoAnalysisUserPrompt({
      duration: 8.5,
      focus: "开场钩子",
      supportsAudio: true,
    })
    expect(prompt).toContain("用户特别关注：开场钩子")
    expect(prompt).toContain("本次可以分析音频")
    expect(prompt).toContain("8.50 秒")
  })
})

describe("结果归一化（P0 §5.4 约束）", () => {
  it("每字段必存在（缺字段补默认）、时间戳 clamp、shots 不足从 scenes 派生补齐", () => {
    const scenes = Array.from({ length: 25 }, (_, i) => ({
      start: i * 2,
      end: i * 2 + 2,
      title: `场景${i}`,
      description: `描述${i}`,
      prompt: `提示${i}`,
    }))
    const result = normalizeVideoAnalysisResult(
      {
        title: "T",
        scenes,
        shots: [{ timestamp: 999, title: "s", reason: "r", caption: "c", prompt: "p" }],
      },
      30,
      true
    )

    expect(result.scenes).toHaveLength(20)
    expect(result.shots.length).toBeGreaterThanOrEqual(6)
    expect(result.shots.length).toBeLessThanOrEqual(8)
    expect(result.shots[0].timestamp).toBe(30) // clamp 到 duration
    expect(result.hook.hasHook).toBeNull()
    expect(result.audio.supported).toBe(true)
  })

  it("无音频能力模型 → audio 四字段占位文案", () => {
    const result = normalizeVideoAnalysisResult({ audio: { summary: "编造的音频" } }, 30, false)
    expect(result.audio).toEqual({
      supported: false,
      summary: "当前模型不支持音频理解",
      transcript: "当前模型不支持音频理解",
      events: ["当前模型不支持音频理解"],
      music: "当前模型不支持音频理解",
    })
  })
})
