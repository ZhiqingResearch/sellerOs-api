import { BadRequestException, UnauthorizedException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Decimal } from "@prisma/client/runtime/library"
import type { ImageTask, VideoTask } from "@zhiqingresearch/ai-ts-sdk"
import { createHmac } from "node:crypto"
import { probeMp4DurationSec } from "../common/utils/video-duration-probe"
import { AiGatewayWebhookService } from "./ai-gateway-webhook.service"

jest.mock("../common/utils/video-duration-probe", () => ({
  probeMp4DurationSec: jest.fn(),
}))

describe("AiGatewayWebhookService", () => {
  const secret = "whsec_test"
  const gatewayTask: VideoTask = {
    id: "task_123",
    object: "video.task",
    status: "succeeded",
    model: "sourcing-veo-fast-i2v",
    request_id: "req_123",
    created_at: 1,
    completed_at: 2,
    usage: { amount: "0.75", currency: "CNY" },
    result: {
      videos: [{ url: "https://space.example.com/video.mp4" }],
      duration_seconds: 8,
      resolution: "1080p",
    },
  }

  /** 取 updateMany 首次调用的 data（强类型读取，供字段级断言） */
  function updateDataOf(mockFn: { mock: { calls: unknown[][] } }): Record<string, unknown> {
    return (mockFn.mock.calls[0][0] as { data: Record<string, unknown> }).data
  }

  beforeEach(() => {
    // 默认探测失败（null → 回落本地快照），探测命中的用例单独覆写
    jest.mocked(probeMp4DurationSec).mockReset().mockResolvedValue(null)
  })

  /** 取 chargeModelInTransaction 首次调用第 4 参（扣费 params，强类型读取供字段级断言） */
  function chargeParamsOf(mockFn: { mock: { calls: unknown[][] } }): Record<string, unknown> {
    return mockFn.mock.calls[0][3] as Record<string, unknown>
  }

  function setup(updateCount = 1) {
    const rawResults = { storyboard: [] as unknown[], beauty: [] as unknown[] }
    const config = {
      get: jest.fn((key: string) => (key === "AI_GATEWAY_CALLBACK_SECRET_V1" ? secret : undefined)),
    }
    const tx = {
      videoTask: {
        updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      },
      storyboardVideo: {
        updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      },
      beautyTask: {
        updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      },
    }
    const prisma = {
      videoTask: {
        findFirst: jest.fn().mockResolvedValue({
          id: 10,
          projectId: 3,
          userId: 7,
          mode: "NORMAL",
          model: "sourcing-veo-fast-i2v",
          status: "GENERATING",
          gatewayEventId: null,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      storyboardVideo: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      beautyTask: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      generationTask: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn((strings: TemplateStringsArray) =>
        Promise.resolve(
          strings.join(" ").includes("BeautyTask") ? rawResults.beauty : rawResults.storyboard
        )
      ),
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        Promise.resolve(callback(tx))
      ),
    }
    const gateway = {
      // VideoTask 联合类型的 queued/running 分支无 usage，此处取成功分支的计费快照供 mock 返回
      validateVideoTask: jest.fn().mockReturnValue((gatewayTask as { usage?: unknown }).usage),
      validateImageTask: jest.fn(),
      getTask: jest.fn(),
      getImageTask: jest.fn(),
      createVideoTask: jest.fn(),
    }
    const usage = {
      chargeModelInTransaction: jest.fn().mockResolvedValue(undefined),
      gatewayPriceMultiplier: jest.fn().mockResolvedValue(2),
      gatewayFixedImageCredits: jest.fn().mockResolvedValue(null),
      // 默认未配置视频固定一口价 → 走按量路径；固定价用例单独覆写
      gatewayFixedVideoCreditsPerSec: jest.fn().mockResolvedValue(null),
    }
    const artifacts = {
      store: jest.fn(),
    }
    const imageCallbacks = {
      notify: jest.fn().mockReturnValue(false),
    }
    const chetaidouReceipts = { persistImageTaskReceipt: jest.fn().mockResolvedValue(true) }
    const service = new AiGatewayWebhookService(
      config as unknown as ConfigService,
      prisma as never,
      gateway as never,
      usage as never,
      artifacts as never,
      imageCallbacks as never,
      chetaidouReceipts as never, { refresh: jest.fn(), registerContinuation: jest.fn() } as never
    )
    return { service, tx, prisma, gateway, usage, artifacts, imageCallbacks, chetaidouReceipts, rawResults }
  }

  function setupImage(updateCount = 1) {
    const config = {
      get: jest.fn((key: string) => (key === "AI_GATEWAY_CALLBACK_SECRET_V1" ? secret : undefined)),
    }
    const generatedImages = [
      { id: 101, status: "GENERATING", order: 0 },
      { id: 102, status: "GENERATING", order: 1 },
    ]
    const tx = {
      generationTask: {
        updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
        count: jest.fn().mockResolvedValue(0),
      },
      generatedImage: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(2),
      },
      imageProject: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    }
    const prisma = {
      videoTask: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      generationTask: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          id: 31,
          projectId: 5,
          userId: 7,
          type: "PORTRAIT",
          model: "ZQ-Image-1",
          status: "GENERATING",
          gatewayTaskId: "image_task_1",
          gatewayEventId: null,
          promptConfig: { model_params: { output_format: "png" } },
          generatedImages,
        }),
        // 管线事件审计落库(stampPipelineImageEvent)走非事务客户端
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      generatedImage: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1),
      },
      imageGenItem: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        Promise.resolve(callback(tx))
      ),
    }
    const gateway = {
      validateVideoTask: jest.fn(),
      validateImageTask: jest.fn().mockReturnValue({ amount: "0.40", currency: "CNY" }),
      getTask: jest.fn(),
      getImageTask: jest.fn(),
      createVideoTask: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(true),
    }
    const usage = {
      chargeModelInTransaction: jest.fn().mockResolvedValue(undefined),
      gatewayPriceMultiplier: jest.fn().mockResolvedValue(3), // 图片倍率 3（setup 里的视频场景为 2）
      gatewayFixedImageCredits: jest.fn().mockResolvedValue(null),
    }
    const artifacts = {
      store: jest.fn().mockImplementation((task: { id: number }, imageId: number) =>
        Promise.resolve({
          url: `https://spaces.example.com/portrait-results/7/5/${task.id}/${imageId}.png`,
          originalUrl: null,
          width: null,
          height: null,
          nativeWidth: null,
          nativeHeight: null,
          deliveryMeta: null,
          warnings: [],
        })
      ),
    }
    const imageCallbacks = {
      notify: jest.fn().mockReturnValue(false),
    }
    const chetaidouReceipts = { persistImageTaskReceipt: jest.fn().mockResolvedValue(true) }
    const service = new AiGatewayWebhookService(
      config as unknown as ConfigService,
      prisma as never,
      gateway as never,
      usage as never,
      artifacts as never,
      imageCallbacks as never,
      chetaidouReceipts as never, { refresh: jest.fn(), registerContinuation: jest.fn() } as never
    )
    return { service, tx, prisma, gateway, usage, artifacts, imageCallbacks, chetaidouReceipts }
  }

  it("统一重绘重试的旧网关关联不会被旧人像回填覆盖或二次扣费", async () => {
    const { service, prisma, artifacts, usage, tx } = setupImage()
    prisma.generationTask.findFirst.mockResolvedValueOnce({ id: 31, status: "GENERATING", executionSpec: { localRedraw: { provider: "ZQ-Image-2" } } })
    await expect(service.applyImageTask({ id: "old_task", status: "succeeded", model: "ZQ-Image-2", result: { images: [{ url: "https://gateway.example.com/old.png" }] } } as ImageTask)).resolves.toBe(false)
    expect(artifacts.store).not.toHaveBeenCalled()
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
    expect(tx.generationTask.updateMany).not.toHaveBeenCalled()
  })

  it.each(["vidflowos", "platform"])(
    "图片回调按 %s 来源标记调用方式，保留功能来源及幂等键",
    async source => {
      for (const generationMode of ["STANDARD", "AI_SPLIT"]) {
        for (const fixed of [false, true]) {
          const { service, prisma, usage } = setupImage()
          const localTask = (await prisma.generationTask.findFirst()) as Record<string, unknown>
          prisma.generationTask.findFirst.mockResolvedValue({
            ...localTask,
            source,
            generationMode,
          })
          usage.gatewayFixedImageCredits.mockResolvedValue(fixed ? new Decimal(15) : null)
          const task: ImageTask = {
            id: "image_task_1",
            object: "image.task",
            status: "succeeded",
            model: "ZQ-Image-1",
            request_id: "req_image_1",
            created_at: 1,
            result: {
              images: [
                { url: "https://gateway.example.com/1.png" },
                { url: "https://gateway.example.com/2.png" },
              ],
            },
          }
          await service.applyImageTask(task, "evt_invoke_type")
          expect(usage.chargeModelInTransaction).toHaveBeenCalledTimes(
            generationMode === "AI_SPLIT" ? 2 : 1
          )
          for (let index = 1; index <= usage.chargeModelInTransaction.mock.calls.length; index++) {
            expect(usage.chargeModelInTransaction).toHaveBeenNthCalledWith(
              index,
              expect.anything(),
              7,
              expect.any(String),
              expect.objectContaining({
                invokeType: source === "vidflowos" ? "API" : "PLATFORM",
                source:
                  generationMode === "AI_SPLIT"
                    ? "aicreative.image_generate.ai_split"
                    : "aicreative.image_generate.portrait",
                requestId: expect.stringMatching(/^gateway:image_task_1(?::10[12])?$/) as unknown,
              })
            )
          }
        }
      }
    }
  )

  function signedEvent() {
    const event = {
      id: "evt_123",
      object: "event",
      type: "video.task.succeeded",
      created_at: 1,
      data: { task: gatewayTask },
    }
    const rawBody = Buffer.from(JSON.stringify(event))
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = `v1=${createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest("hex")}`
    return { event, rawBody, timestamp, signature }
  }

  it("验签后写入 Gateway 视频链接并按实际 usage 扣费", async () => {
    const { service, tx, prisma, usage } = setup()
    const { event, rawBody, timestamp, signature } = signedEvent()

    await service.receiveWebhook(rawBody, {
      secretVersion: "1",
      timestamp,
      signature,
      eventId: event.id,
    })

    expect(prisma.videoTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { gatewayTaskId: "task_123", deletedAt: null } })
    )
    expect(tx.videoTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 10,
        status: { in: ["GENERATING", "TIMEOUT"] },
        deletedAt: null,
        gatewayEventId: null,
      },
      data: {
        status: "SUCCESS",
        gatewayEventId: "evt_123",
        deliveryMeta: {
          actualDurationSec: 8,
          actualResolution: "1080p",
          durationSource: "gateway",
        },
        resultUrl: "https://space.example.com/video.mp4",
        errorMessage: null,
        durationSec: 8,
        resolution: "1080p",
      },
    })
    expect(usage.gatewayPriceMultiplier).toHaveBeenCalledWith(gatewayTask.model, "NORMAL")
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "1.5", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction)).toMatchObject({
      source: "video-project.generate",
      model: gatewayTask.model,
      requestId: "gateway:task_123",
      allowOverdraft: true,
    })
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      gatewayTaskId: "task_123",
      taskId: 10,
      status: "SUCCESS",
      gatewayAmountCny: "0.75", // 网关原始金额留档，扣费金额 1.5 = 0.75 × 视频倍率 2
      priceMultiplier: "2",
    })
  })

  it("带货成片（salesWorkflowId 锚定）扣费 source 走 video-project.sales", async () => {
    const { service, tx, prisma, usage } = setup()
    prisma.videoTask.findFirst.mockResolvedValue({
      id: 11,
      projectId: 3,
      userId: 7,
      mode: "REFERENCE",
      model: "sourcing-veo-fast-i2v",
      salesWorkflowId: 55,
      status: "GENERATING",
      gatewayEventId: null,
    })

    await expect(service.applyVideoTask(gatewayTask, "evt_sales")).resolves.toBe(true)

    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "1.5", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction)).toMatchObject({
      source: "video-project.sales",
      requestId: "gateway:task_123",
    })
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      salesWorkflowId: 55,
    })
  })

  it("动作复刻任务（mode=MOTION_CONTROL）扣费 source 走 video-project.motion", async () => {
    const { service, tx, prisma, usage } = setup()
    prisma.videoTask.findFirst.mockResolvedValue({
      id: 12,
      projectId: 3,
      userId: 7,
      mode: "MOTION_CONTROL",
      model: "sourcing-kling-motion",
      salesWorkflowId: null,
      status: "GENERATING",
      gatewayEventId: null,
    })

    await expect(service.applyVideoTask(gatewayTask, "evt_motion")).resolves.toBe(true)

    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "1.5", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction)).toMatchObject({
      source: "video-project.motion",
      requestId: "gateway:task_123",
    })
  })

  it.each(["REFERENCE", "MOTION_CONTROL", "BEAUTY"])(
    "代理任务按保存的 %s 类别结算同模型固定价",
    async category => {
      const { service, prisma, tx, usage } = setup()
      const model = "sourcing-minimax-h3-reference"
      prisma.videoTask.findFirst.mockResolvedValue({
        id: 1033,
        projectId: 61,
        userId: 55,
        mode: category,
        model,
        status: "GENERATING",
        gatewayEventId: null,
        durationSec: 5,
        resolution: "480p",
        generationParams: { model, prompt: "x", mode: "reference_to_video" },
      })
      usage.gatewayFixedVideoCreditsPerSec.mockImplementation((id: string, selected: string) =>
        Promise.resolve(
          id === model && selected === category ? new Map([["|480p", new Decimal(2)]]) : null
        )
      )
      await service.applyVideoTask({
        ...gatewayTask,
        model,
        usage: { amount: "0.1", currency: "CNY" },
        result: { ...gatewayTask.result, duration_seconds: 5, resolution: "480p" },
      })
      expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(
        tx,
        55,
        "1",
        expect.objectContaining({
          exactCredits: "10",
          meta: expect.objectContaining({ mode: category, pricingMode: "fixed" }) as unknown,
        })
      )
      expect(usage.gatewayPriceMultiplier).not.toHaveBeenCalled()
    }
  )

  it("固定一口价命中：SUCCESS 按积分/秒 × 实际时长精确扣费（不乘倍率不打折）", async () => {
    const { service, tx, usage } = setup()
    usage.gatewayFixedVideoCreditsPerSec.mockResolvedValue(new Map([["|1080p", new Decimal(15)]]))

    await expect(service.applyVideoTask(gatewayTask, "evt_fixed")).resolves.toBe(true)

    // 15 积分/秒 × 8 秒 = 120 积分；costCny 记名义售价 12 元，不读 priceMultiplier(2)
    expect(usage.gatewayPriceMultiplier).not.toHaveBeenCalled()
    expect(usage.chargeModelInTransaction).toHaveBeenCalledTimes(1)
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "12", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction)).toMatchObject({
      source: "video-project.generate",
      model: gatewayTask.model,
      exactCredits: "120",
      requestId: "gateway:task_123",
      allowOverdraft: true,
    })
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      pricingMode: "fixed",
      fixedCreditsPerSec: "15",
      durationSec: 8,
      resolution: "1080p",
      gatewayAmountCny: "0.75",
      status: "SUCCESS",
    })
  })

  it("固定一口价按 mode 分价：精确 mode 行优先于通配行", async () => {
    const { service, tx, prisma, usage } = setup()
    usage.gatewayFixedVideoCreditsPerSec.mockResolvedValue(
      new Map([
        ["|1080p", new Decimal(15)],
        ["video_to_video|1080p", new Decimal(25)],
      ])
    )
    prisma.videoTask.findFirst.mockResolvedValue({
      id: 10,
      projectId: 3,
      userId: 7,
      mode: "REFERENCE",
      model: "sourcing-seedance-2-5-reference",
      status: "GENERATING",
      gatewayEventId: null,
      resolution: "1080p",
      durationSec: 8,
      generationParams: {
        model: "sourcing-seedance-2-5-reference",
        prompt: "编辑这段视频",
        mode: "video_to_video",
        callback: true,
        n: 1,
      },
    })

    await expect(service.applyVideoTask(gatewayTask, "evt_fixed_mode")).resolves.toBe(true)

    // 精确 mode 行 25 积分/秒 × 8 秒 = 200 积分（通配行 15 不参与）
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "20", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      pricingMode: "fixed",
      fixedCreditsPerSec: "25",
      durationSec: 8,
      resolution: "1080p",
    })
  })

  it("自适应模型（无分辨率）按 adaptive 保留档固定扣一笔，不乘时长", async () => {
    const { service, tx, prisma, usage } = setup()
    usage.gatewayFixedVideoCreditsPerSec.mockResolvedValue(
      new Map([["|adaptive", new Decimal(150)]])
    )
    prisma.videoTask.findFirst.mockResolvedValue({
      id: 10,
      projectId: 3,
      userId: 7,
      mode: "REFERENCE",
      model: "sourcing-kling-o3-video-edit",
      status: "GENERATING",
      gatewayEventId: null,
      resolution: null,
      durationSec: 0,
      generationParams: {
        model: "sourcing-kling-o3-video-edit",
        prompt: "编辑这段视频",
        callback: true,
        n: 1,
      },
    })
    // 网关终态不回传 resolution；时长 12 秒也不影响一口价
    const adaptiveTask: VideoTask = {
      ...gatewayTask,
      id: "task_adaptive",
      model: "sourcing-kling-o3-video-edit",
      request_id: "req_adaptive",
      usage: { amount: "8.82", currency: "CNY" },
      result: { videos: [{ url: "https://space.example.com/video.mp4" }], duration_seconds: 12 },
    }

    await expect(service.applyVideoTask(adaptiveTask, "evt_adaptive")).resolves.toBe(true)

    // adaptive 按次一口价 150 积分（costCny 名义 15 元），不乘 12 秒
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "15", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      pricingMode: "fixed",
      fixedCreditsPerSec: "150",
      flat: true,
      resolution: "adaptive",
      durationSec: 1,
      // setup 的 validateVideoTask mock 固定返回默认 fixture 的 usage 快照
      gatewayAmountCny: "0.75",
    })
  })

  it("带分辨率未命中精确档时兜底 flat 按次档：动作复刻一条固定扣 100，不乘时长", async () => {
    const { service, tx, prisma, usage } = setup()
    usage.gatewayFixedVideoCreditsPerSec.mockResolvedValue(
      new Map([["motion_control|flat", new Decimal(100)]])
    )
    prisma.videoTask.findFirst.mockResolvedValue({
      id: 11,
      projectId: 3,
      userId: 7,
      mode: "MOTION_CONTROL",
      model: "sourcing-kling-v2-6-motion-control",
      status: "GENERATING",
      gatewayEventId: null,
      resolution: "1080p",
      durationSec: 8,
      generationParams: {
        model: "sourcing-kling-v2-6-motion-control",
        prompt: "动作复刻",
        mode: "motion_control",
        resolution: "1080p",
        callback: true,
        n: 1,
      },
    })
    const motionTask: VideoTask = {
      ...gatewayTask,
      id: "task_motion_flat",
      model: "sourcing-kling-v2-6-motion-control",
      request_id: "req_motion_flat",
      usage: { amount: "5.28", currency: "CNY" },
      result: {
        videos: [{ url: "https://space.example.com/motion.mp4" }],
        duration_seconds: 12,
        resolution: "1080p",
      },
    }

    await expect(service.applyVideoTask(motionTask, "evt_motion_flat")).resolves.toBe(true)

    // flat 按次一口价 100 积分（costCny 名义 10 元），不乘 12 秒
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "10", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      pricingMode: "fixed",
      fixedCreditsPerSec: "100",
      flat: true,
      resolution: "flat",
      durationSec: 1,
    })
  })

  it("固定一口价模型失败任务不扣费（仅成功扣费，即便网关账单有金额）", async () => {
    const { service, tx, usage } = setup()
    usage.gatewayFixedVideoCreditsPerSec.mockResolvedValue(new Map([["|1080p", new Decimal(15)]]))
    const failedTask: VideoTask = {
      id: "task_fixed_failed",
      object: "video.task",
      status: "failed",
      model: "sourcing-veo-fast-i2v",
      request_id: "req_fixed_failed",
      created_at: 1,
      completed_at: 2,
      usage: { amount: "4.2", currency: "CNY" },
      error: { type: "provider_error", code: "upstream_failed", message: "Provider failed" },
    }

    await expect(service.applyVideoTask(failedTask, "evt_fixed_failed")).resolves.toBe(true)

    expect(tx.videoTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    )
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it("固定价模式 SUCCESS 但缺该分辨率档时回落按量计费", async () => {
    const { service, usage } = setup()
    usage.gatewayFixedVideoCreditsPerSec.mockResolvedValue(
      new Map([["|720p", new Decimal(15)]]) // 网关回传 1080p，缺档
    )

    await expect(service.applyVideoTask(gatewayTask, "evt_fallback")).resolves.toBe(true)

    expect(usage.chargeModelInTransaction).toHaveBeenCalledTimes(1)
    const params = chargeParamsOf(usage.chargeModelInTransaction)
    expect(params.exactCredits).toBeUndefined()
    expect(params.meta).toMatchObject({ gatewayAmountCny: "0.75", priceMultiplier: "2" })
  })

  it("分镜视频固定一口价命中：优先网关回传时长/分辨率精确扣费", async () => {
    const { service, tx, prisma, usage, rawResults } = setup()
    usage.gatewayFixedVideoCreditsPerSec.mockResolvedValue(
      new Map([
        ["|720p", new Decimal(10)],
        ["|1080p", new Decimal(10)],
      ])
    )
    prisma.videoTask.findFirst.mockResolvedValue(null)
    rawResults.storyboard = [
      {
        id: 20,
        gatewayTaskId: gatewayTask.id,
        status: "GENERATING",
        generationParams: {
          model: gatewayTask.model,
          prompt: "海边日出",
          resolution: "720p",
          duration_seconds: 5,
          callback: true,
          n: 1,
        },
        gatewayEventId: null,
        storyboardId: 8,
        projectId: 6,
        userId: 7,
      },
    ]

    await expect(service.applyVideoTask(gatewayTask, "evt_storyboard_fixed")).resolves.toBe(true)

    // 网关终态回传 duration_seconds=8 覆盖请求快照 5 秒：10 积分/秒 × 8 秒
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "8", expect.anything())
    const params = chargeParamsOf(usage.chargeModelInTransaction)
    expect(params.exactCredits).toBe("80")
    expect(params.meta).toMatchObject({
      pricingMode: "fixed",
      taskType: "storyboard-video",
      resolution: "1080p",
    })
  })

  it("固定价模式 SUCCESS 但时长为 0/缺失时按 1 秒保底扣费", async () => {
    const { service, tx, usage } = setup()
    usage.gatewayFixedVideoCreditsPerSec.mockResolvedValue(new Map([["|1080p", new Decimal(15)]]))
    const zeroDurationTask: VideoTask = {
      ...gatewayTask,
      result: {
        videos: [{ url: "https://space.example.com/video.mp4" }],
        duration_seconds: 0,
        resolution: "1080p",
      },
    }

    await expect(service.applyVideoTask(zeroDurationTask, "evt_fixed_min1")).resolves.toBe(true)

    // 15 积分/秒 × 1 秒 = 15 积分；不回落按量（不走 usage.amount × 倍率）
    expect(usage.chargeModelInTransaction).toHaveBeenCalledTimes(1)
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "1.5", expect.anything())
    const params = chargeParamsOf(usage.chargeModelInTransaction)
    expect(params.exactCredits).toBe("15")
    expect(params.meta).toMatchObject({ pricingMode: "fixed", durationSec: 1 })
  })

  it("网关回传 0 时长：探测命中仅回填展示列，计费仍按 1 秒保底", async () => {
    const { service, tx, usage } = setup()
    jest.mocked(probeMp4DurationSec).mockResolvedValue(7)
    usage.gatewayFixedVideoCreditsPerSec.mockResolvedValue(new Map([["|1080p", new Decimal(15)]]))
    const zeroDurationTask: VideoTask = {
      ...gatewayTask,
      result: {
        videos: [{ url: "https://space.example.com/video.mp4" }],
        duration_seconds: 0,
        resolution: "1080p",
      },
    }

    await expect(service.applyVideoTask(zeroDurationTask, "evt_probe_hit")).resolves.toBe(true)

    expect(probeMp4DurationSec).toHaveBeenCalledWith("https://space.example.com/video.mp4")
    // 展示列回填探测出的真实秒数
    expect(updateDataOf(tx.videoTask.updateMany)).toMatchObject({ durationSec: 7 })
    // 计费不受探测影响：网关回传 0 → 1 秒保底（15 积分/秒 × 1 秒）
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "1.5", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      pricingMode: "fixed",
      durationSec: 1,
    })
  })

  it("探测命中但本地有请求快照时长：展示列取探测值，计费按请求快照（网关缺失时长时）", async () => {
    const { service, tx, prisma, usage } = setup()
    prisma.videoTask.findFirst.mockResolvedValue({
      id: 10,
      projectId: 3,
      userId: 7,
      mode: "NORMAL",
      model: "sourcing-veo-fast-i2v",
      status: "GENERATING",
      gatewayEventId: null,
      durationSec: 6,
    })
    jest.mocked(probeMp4DurationSec).mockResolvedValue(7)
    usage.gatewayFixedVideoCreditsPerSec.mockResolvedValue(new Map([["|1080p", new Decimal(15)]]))
    // 网关未回传 duration_seconds 字段
    const noDurationTask: VideoTask = {
      ...gatewayTask,
      result: {
        videos: [{ url: "https://space.example.com/video.mp4" }],
        resolution: "1080p",
      },
    }

    await expect(service.applyVideoTask(noDurationTask, "evt_probe_vs_snapshot")).resolves.toBe(
      true
    )

    // 展示列回填探测值
    expect(updateDataOf(tx.videoTask.updateMany)).toMatchObject({ durationSec: 7 })
    // 计费回落本地请求快照 6 秒（15 积分/秒 × 6 秒 = 90 积分），与探测无关
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "9", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      pricingMode: "fixed",
      durationSec: 6,
    })
  })

  it("探测失败：回落本地请求快照时长（正数）回写", async () => {
    const { service, tx, prisma } = setup()
    prisma.videoTask.findFirst.mockResolvedValue({
      id: 10,
      projectId: 3,
      userId: 7,
      mode: "NORMAL",
      model: "sourcing-veo-fast-i2v",
      status: "GENERATING",
      gatewayEventId: null,
      durationSec: 6,
    })
    const zeroDurationTask: VideoTask = {
      ...gatewayTask,
      result: {
        videos: [{ url: "https://space.example.com/video.mp4" }],
        duration_seconds: 0,
        resolution: "1080p",
      },
    }

    await expect(service.applyVideoTask(zeroDurationTask, "evt_probe_miss")).resolves.toBe(true)

    expect(updateDataOf(tx.videoTask.updateMany)).toMatchObject({ durationSec: 6 })
  })

  it("网关回传正数时长时不发起产物探测", async () => {
    const { service } = setup()

    await expect(service.applyVideoTask(gatewayTask, "evt_no_probe")).resolves.toBe(true)

    expect(probeMp4DurationSec).not.toHaveBeenCalled()
  })

  it("美妆任务网关未回传时长：探测命中后回写真实时长", async () => {
    const { service, tx, prisma, rawResults } = setup()
    prisma.videoTask.findFirst.mockResolvedValue(null)
    rawResults.beauty = [
      {
        id: 30,
        status: "GENERATING",
        gatewayEventId: null,
        projectId: 9,
        userId: 7,
        model: gatewayTask.model,
      },
    ]
    jest.mocked(probeMp4DurationSec).mockResolvedValue(9)
    const noDurationTask: VideoTask = {
      ...gatewayTask,
      result: {
        videos: [{ url: "https://space.example.com/video.mp4" }],
        resolution: "1080p",
      },
    }

    await expect(service.applyVideoTask(noDurationTask, "evt_beauty_probe")).resolves.toBe(true)

    expect(updateDataOf(tx.beautyTask.updateMany)).toMatchObject({ durationSec: 9 })
  })

  it("同一任务未抢到终态更新时不重复扣费", async () => {
    const { service, usage } = setup(0)

    await expect(service.applyVideoTask(gatewayTask, "evt_123")).resolves.toBe(false)
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it("启动对账直接拿到终态时写入稳定事件标识", async () => {
    const { service, tx } = setup()

    await expect(service.applyVideoTask(gatewayTask)).resolves.toBe(true)
    expect(tx.videoTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 10,
        status: { in: ["GENERATING", "TIMEOUT"] },
        deletedAt: null,
        gatewayEventId: null,
      },
      data: {
        status: "SUCCESS",
        gatewayEventId: "task:task_123:succeeded",
        deliveryMeta: {
          actualDurationSec: 8,
          actualResolution: "1080p",
          durationSource: "gateway",
        },
        resultUrl: "https://space.example.com/video.mp4",
        errorMessage: null,
        durationSec: 8,
        resolution: "1080p",
      },
    })
  })

  it("迟到的成功回调可以覆盖本地超时并正常扣费", async () => {
    const { service, tx, prisma, usage } = setup()
    prisma.videoTask.findFirst.mockResolvedValue({
      id: 10,
      projectId: 3,
      userId: 7,
      mode: "NORMAL",
      model: "sourcing-veo-fast-i2v",
      status: "TIMEOUT",
      gatewayEventId: null,
    })

    await expect(service.applyVideoTask(gatewayTask, "evt_late")).resolves.toBe(true)
    expect(tx.videoTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["GENERATING", "TIMEOUT"] } }),
        data: expect.objectContaining({ status: "SUCCESS", gatewayEventId: "evt_late" }),
      })
    )
    expect(usage.chargeModelInTransaction).toHaveBeenCalled()
  })

  it("回调找不到关联时使用原幂等键恢复并立即处理", async () => {
    const { service, prisma, gateway, usage } = setup()
    const localTask = {
      id: 10,
      projectId: 3,
      userId: 7,
      mode: "NORMAL",
      model: "sourcing-veo-fast-i2v",
      status: "GENERATING",
      gatewayEventId: null,
    }
    const request = {
      model: "sourcing-veo-fast-i2v",
      prompt: "海边日出",
      callback: true,
      n: 1,
    }
    prisma.videoTask.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(localTask)
    prisma.videoTask.findMany.mockResolvedValue([
      { id: 10, gatewayTaskId: null, generationParams: request },
    ])
    gateway.createVideoTask.mockResolvedValue(gatewayTask)

    await expect(service.applyVideoTask(gatewayTask, "evt_recovered")).resolves.toBe(true)
    expect(gateway.createVideoTask).toHaveBeenCalledWith(request, "video-task:10", "platform")
    expect(prisma.videoTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 10,
        status: { in: ["GENERATING", "TIMEOUT"] },
        gatewayTaskId: null,
        deletedAt: null,
      },
      data: { gatewayTaskId: "task_123" },
    })
    expect(usage.chargeModelInTransaction).toHaveBeenCalled()
  })

  it("分镜视频回调直接保存 Gateway 链接并按实际 usage 扣费", async () => {
    const { service, tx, prisma, usage, rawResults } = setup()
    const request = {
      model: gatewayTask.model,
      prompt: "海边日出",
      callback: true,
      n: 1,
    }
    prisma.videoTask.findFirst.mockResolvedValue(null)
    rawResults.storyboard = [
      {
        id: 20,
        gatewayTaskId: gatewayTask.id,
        status: "TIMEOUT",
        generationParams: request,
        gatewayEventId: null,
        storyboardId: 8,
        projectId: 6,
        userId: 7,
      },
    ]

    await expect(service.applyVideoTask(gatewayTask, "evt_storyboard")).resolves.toBe(true)

    expect(prisma.videoTask.findMany).not.toHaveBeenCalled()
    expect(tx.storyboardVideo.updateMany).toHaveBeenCalledWith({
      where: {
        id: 20,
        status: { in: ["GENERATING", "TIMEOUT"] },
        gatewayEventId: null,
        deletedAt: null,
      },
      data: {
        status: "SUCCESS",
        url: "https://space.example.com/video.mp4",
        errorMessage: null,
        gatewayEventId: "evt_storyboard",
        generationMeta: { actualDurationSec: 8, actualResolution: "1080p" },
      },
    })
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "1.5", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction)).toMatchObject({
      source: "video-project.generate",
      model: gatewayTask.model,
      requestId: "gateway:task_123",
      allowOverdraft: true,
    })
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      projectId: 6,
      storyboardId: 8,
      taskId: 20,
      taskType: "storyboard-video", // 生成记录反查鉴别（与 VideoTask 撞号）
    })
  })

  it("软删除的分镜席位回调不落终态不扣费（删除分镜 = 放弃生成）", async () => {
    const { service, tx, prisma, usage, gateway, rawResults } = setup(0)
    const request = {
      model: gatewayTask.model,
      prompt: "海边日出",
      callback: true,
      n: 1,
    }
    prisma.videoTask.findFirst.mockResolvedValue(null)
    rawResults.storyboard = [
      {
        id: 20,
        gatewayTaskId: gatewayTask.id,
        status: "GENERATING", // 模拟删除路径未及标记 CANCELLED 的存量软删行
        generationParams: request,
        gatewayEventId: null,
        storyboardId: 8,
        projectId: 6,
        userId: 7,
      },
    ]

    await expect(service.applyVideoTask(gatewayTask, "evt_deleted")).resolves.toBe(false)

    // 路由层刻意不过滤软删（避免事件陷进 503 重试），由 CAS 的 deletedAt: null 安静拒绝
    expect(tx.storyboardVideo.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 20, deletedAt: null }),
      })
    )
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
    expect(gateway.getTask).not.toHaveBeenCalled()
  })

  it("指数形态的零金额（0E-8）按零处理：正常落终态且不扣费", async () => {
    const { service, tx, usage, gateway } = setup()
    gateway.validateVideoTask.mockReturnValue({ amount: "0E-8", currency: "CNY" })

    await expect(service.applyVideoTask(gatewayTask, "evt_zero_exp")).resolves.toBe(true)

    expect(tx.videoTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS" }) })
    )
    expect(usage.gatewayPriceMultiplier).not.toHaveBeenCalled()
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it("美妆视频软删除后仍处理回调并按实际 usage 扣费", async () => {
    const { service, tx, prisma, usage, rawResults } = setup()
    prisma.videoTask.findFirst.mockResolvedValue(null)
    rawResults.beauty = [
      {
        id: 30,
        status: "GENERATING",
        gatewayEventId: null,
        projectId: 9,
        userId: 7,
        model: gatewayTask.model,
      },
    ]

    await expect(service.applyVideoTask(gatewayTask, "evt_beauty")).resolves.toBe(true)

    const beautySql = (prisma.$queryRaw.mock.calls as [TemplateStringsArray][])
      .map(call => call[0].join(" "))
      .find(sql => sql.includes("FROM BeautyTask"))
    expect(beautySql).not.toContain("deletedAt")
    expect(tx.beautyTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 30,
        status: { in: ["GENERATING", "TIMEOUT"] },
        gatewayEventId: null,
      },
      data: {
        status: "SUCCESS",
        resultUrl: "https://space.example.com/video.mp4",
        errorMessage: null,
        gatewayEventId: "evt_beauty",
        deliveryMeta: {
          actualDurationSec: 8,
          actualResolution: "1080p",
          durationSource: "gateway",
        },
        finishedAt: expect.any(Date) as Date,
        durationSec: 8,
        resolution: "1080p",
      },
    })
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "1.5", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction)).toMatchObject({
      source: "beauty-workflow.generate",
      model: gatewayTask.model,
      requestId: "gateway:task_123",
      allowOverdraft: true,
    })
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      projectId: 9,
      taskId: 30,
    })
  })

  it("启动时使用原幂等键恢复未关联的 Gateway 任务", async () => {
    const { service, prisma, gateway } = setup()
    const request = {
      model: "sourcing-veo-fast-i2v",
      prompt: "海边日出",
      callback: true,
      n: 1,
    }
    prisma.videoTask.findMany.mockResolvedValue([
      { id: 10, gatewayTaskId: null, generationParams: request },
    ])
    gateway.createVideoTask.mockResolvedValue({ ...gatewayTask, status: "queued" })

    await service.onModuleInit()

    expect(gateway.createVideoTask).toHaveBeenCalledWith(request, "video-task:10", "platform")
    expect(prisma.videoTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 10,
        status: { in: ["GENERATING", "TIMEOUT"] },
        gatewayTaskId: null,
        deletedAt: null,
      },
      data: { gatewayTaskId: "task_123" },
    })
  })

  it("启动对账纳入被墙钟误标的 TIMEOUT 行（与分镜/美妆口径一致）", async () => {
    const { service, prisma } = setup()
    prisma.videoTask.findMany.mockResolvedValue([])

    await service.onModuleInit()

    expect(prisma.videoTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { OR: [{ status: "GENERATING" }, { status: "TIMEOUT", gatewayEventId: null }] },
            {
              OR: [{ gatewayTaskId: { not: null } }, { gatewayTaskId: null, providerJobId: null }],
            },
          ],
        },
      })
    )
  })

  it("启动时使用原幂等键恢复未关联的分镜视频", async () => {
    const { service, prisma, gateway, rawResults } = setup()
    const request = {
      model: "sourcing-storyboard-veo-lite",
      prompt: "海边日出",
      callback: true,
      n: 1,
    }
    prisma.videoTask.findMany.mockResolvedValue([])
    rawResults.storyboard = [{ id: 20, gatewayTaskId: null, generationParams: request }]
    gateway.createVideoTask.mockResolvedValue({
      ...gatewayTask,
      status: "queued",
      model: request.model,
    })

    await service.onModuleInit()

    const sql = prisma.$queryRaw.mock.calls[0][0].join(" ")
    expect(sql).toContain("status = 'TIMEOUT' AND gatewayEventId IS NULL")
    // 软删行不参与恢复：$queryRaw 不走软删除扩展，必须显式过滤
    expect(sql).toContain("deletedAt IS NULL")
    expect(gateway.createVideoTask).toHaveBeenCalledWith(request, "storyboard-video:20")
    expect(prisma.storyboardVideo.updateMany).toHaveBeenCalledWith({
      where: {
        id: 20,
        status: { in: ["GENERATING", "TIMEOUT"] },
        gatewayTaskId: null,
        deletedAt: null,
      },
      data: { gatewayTaskId: "task_123" },
    })
  })

  it("启动时使用原幂等键恢复未关联的美妆视频", async () => {
    const { service, prisma, gateway, rawResults } = setup()
    const request = {
      model: "sourcing-beauty-seedance-mini",
      prompt: "轻微转头展示妆容",
      callback: true,
      n: 1,
    }
    prisma.videoTask.findMany.mockResolvedValue([])
    rawResults.beauty = [
      { id: 30, gatewayTaskId: null, generationParams: request, submittedAt: null },
    ]
    gateway.createVideoTask.mockResolvedValue({
      ...gatewayTask,
      status: "queued",
      model: request.model,
    })

    await service.onModuleInit()

    const sql = (prisma.$queryRaw.mock.calls as [TemplateStringsArray][])
      .map(call => call[0].join(" "))
      .find(query => query.includes("FROM BeautyTask"))
    expect(sql).toContain(
      "status = 'TIMEOUT' AND (providerJobId IS NOT NULL OR submittedAt IS NOT NULL)"
    )
    expect(gateway.createVideoTask).toHaveBeenCalledWith(request, "beauty-task:30")
    expect(prisma.beautyTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 30,
        status: { in: ["GENERATING", "TIMEOUT"] },
        gatewayTaskId: null,
        gatewayEventId: null,
        submittedAt: null,
      },
      data: { submittedAt: expect.any(Date) as Date },
    })
    expect(prisma.beautyTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 30,
        status: { in: ["GENERATING", "TIMEOUT"] },
        gatewayTaskId: null,
        gatewayEventId: null,
      },
      data: { gatewayTaskId: "task_123" },
    })
  })

  it("回调关联恢复不提交从未发起过的超时美妆任务", async () => {
    const { service, prisma } = setup()
    prisma.videoTask.findFirst.mockResolvedValue(null)

    await expect(service.applyVideoTask(gatewayTask, "evt_unlinked")).rejects.toThrow(
      "AI Gateway 回调任务尚未建立关联"
    )

    const sql = (prisma.$queryRaw.mock.calls as [TemplateStringsArray][])
      .map(call => call[0].join(" "))
      .find(query => query.includes("FROM BeautyTask") && query.includes("WHERE model ="))
    expect(sql).toContain("status = 'TIMEOUT' AND submittedAt IS NOT NULL")
  })

  it("分镜启动恢复已关联任务查询失败时保留原状态（瞬态错误不终态化）", async () => {
    const { service, prisma, gateway, rawResults } = setup()
    prisma.videoTask.findMany.mockResolvedValue([])
    rawResults.storyboard = [
      {
        id: 20,
        gatewayTaskId: "task_expired",
        generationParams: { model: "sourcing-storyboard-veo-lite", prompt: "海边日出" },
      },
    ]
    gateway.getTask.mockRejectedValue(new BadRequestException("任务不存在"))

    await service.onModuleInit()

    expect(prisma.storyboardVideo.updateMany).not.toHaveBeenCalled()
  })

  it("启动时跳过动作复刻等非 Gateway 参数", async () => {
    const { service, prisma, gateway } = setup()
    prisma.videoTask.findMany.mockResolvedValue([
      {
        id: 10,
        gatewayTaskId: null,
        generationParams: { mode: "MOTION_CONTROL", tier: "kling-motion" },
      },
    ])

    await service.onModuleInit()

    expect(gateway.createVideoTask).not.toHaveBeenCalled()
  })

  it("启动恢复被 Gateway 明确拒绝时标记任务失败", async () => {
    const { service, prisma, gateway } = setup()
    const request = {
      model: "sourcing-veo-fast-i2v",
      prompt: "海边日出",
      callback: true,
      n: 1,
    }
    prisma.videoTask.findMany.mockResolvedValue([
      { id: 10, gatewayTaskId: null, generationParams: request },
    ])
    gateway.createVideoTask.mockRejectedValue(new BadRequestException("参数错误"))

    await service.onModuleInit()

    expect(prisma.videoTask.updateMany).toHaveBeenCalledWith({
      where: { id: 10, status: { in: ["GENERATING", "TIMEOUT"] }, deletedAt: null },
      data: { status: "FAILED", errorMessage: "AI Gateway 视频任务恢复失败" },
    })
  })

  it("启动恢复已关联任务查询瞬态失败时不标死（真实案例：网关滚动重启期 4xx 错杀即将成功的任务）", async () => {
    const { service, prisma, gateway } = setup()
    prisma.videoTask.findMany.mockResolvedValue([
      { id: 10, gatewayTaskId: "task_running", generationParams: null },
    ])
    gateway.getTask.mockRejectedValue(new BadRequestException("任务不存在"))

    await service.onModuleInit()

    expect(gateway.getTask).toHaveBeenCalledWith("task_running", "platform")
    expect(prisma.videoTask.updateMany).not.toHaveBeenCalled()
  })

  it("启动恢复状态落库/扣费失败时不标死任务", async () => {
    const { service, prisma, gateway, usage } = setup()
    prisma.videoTask.findMany.mockResolvedValue([
      { id: 10, gatewayTaskId: "task_123", generationParams: null },
    ])
    gateway.getTask.mockResolvedValue(gatewayTask)
    usage.chargeModelInTransaction.mockRejectedValue(new BadRequestException("扣费异常"))

    await service.onModuleInit()

    expect(prisma.videoTask.updateMany).not.toHaveBeenCalled()
  })

  it("失败时 errorMessage 直接透出网关原始错误，并另存结构化 gatewayError", async () => {
    const { service, tx, gateway, usage } = setup()
    gateway.validateVideoTask.mockReturnValue(null)
    const failedTask: VideoTask = {
      id: "task_failed",
      object: "video.task",
      status: "failed",
      model: "sourcing-veo-fast-i2v",
      request_id: "req_failed",
      created_at: 1,
      completed_at: 2,
      error: { type: "provider_error", code: "upstream_failed", message: "Provider failed" },
    }

    await service.applyVideoTask(failedTask, "evt_failed")

    expect(tx.videoTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorMessage: "Provider failed",
          gatewayError: {
            code: "upstream_failed",
            type: "provider_error",
            message: "Provider failed",
            requestId: "req_failed",
          },
        }),
      })
    )
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it("失败但网关未带 error 对象时兜底中文文案", async () => {
    const { service, tx, gateway } = setup()
    gateway.validateVideoTask.mockReturnValue(null)
    // SDK 类型要求 failed 携带 error，这里构造罕见的无 error 终态（运行时可能出现的脏数据）
    const failedTask = {
      id: "task_no_error",
      object: "video.task",
      status: "failed",
      model: "sourcing-veo-fast-i2v",
      request_id: "req_no_error",
      created_at: 1,
      completed_at: 2,
    } as unknown as VideoTask

    await service.applyVideoTask(failedTask, "evt_no_error")

    const fallbackData = updateDataOf(tx.videoTask.updateMany)
    expect(fallbackData.errorMessage).toBe("AI Gateway 视频生成失败")
    expect("gatewayError" in fallbackData).toBe(false)
  })

  it("成功任务不落 gatewayError", async () => {
    const { service, tx } = setup()

    await service.applyVideoTask(gatewayTask, "evt_ok")

    const data = updateDataOf(tx.videoTask.updateMany)
    expect("gatewayError" in data).toBe(false)
  })

  describe("reconcileVideoTaskOnRead（读时对账）", () => {
    it("待审视频先查询审核，拒绝后不查生成任务或重新提交", async () => {
      const { service, gateway } = setup()
      const moderation = service["moderation"].refresh as jest.Mock
      moderation.mockResolvedValue({ id: 10, status: "FAILED", gatewayTaskId: null })
      expect(await service.reconcileVideoTaskOnRead({ id: 10, status: "WAITING_MODERATION", gatewayTaskId: null })).toBe(true)
      expect(moderation).toHaveBeenCalledWith("video-task:10")
      expect(gateway.getTask).not.toHaveBeenCalled()
      expect(gateway.createVideoTask).not.toHaveBeenCalled()
    })
    it("对已关联网关任务的 GENERATING 行查询网关并走统一终态处理", async () => {
      const { service, gateway } = setup()
      gateway.getTask.mockResolvedValue(gatewayTask)

      await expect(
        service.reconcileVideoTaskOnRead({
          id: 10,
          status: "GENERATING",
          gatewayTaskId: "task_123",
        })
      ).resolves.toBe(true)

      expect(gateway.getTask).toHaveBeenCalledWith("task_123", "platform")
      expect(gateway.validateVideoTask).toHaveBeenCalledWith(gatewayTask)
    })

    it("非 GENERATING 或未关联网关任务时不查网关", async () => {
      const { service, gateway } = setup()

      await expect(
        service.reconcileVideoTaskOnRead({ id: 10, status: "SUCCESS", gatewayTaskId: "task_123" })
      ).resolves.toBe(false)
      await expect(
        service.reconcileVideoTaskOnRead({ id: 10, status: "GENERATING", gatewayTaskId: null })
      ).resolves.toBe(false)

      expect(gateway.getTask).not.toHaveBeenCalled()
    })

    it("同一任务 2 分钟内节流：直接返回权威结论且不重复查网关", async () => {
      const { service, gateway } = setup()
      gateway.getTask.mockResolvedValue(gatewayTask)

      await service.reconcileVideoTaskOnRead({
        id: 10,
        status: "GENERATING",
        gatewayTaskId: "task_123",
      })
      await expect(
        service.reconcileVideoTaskOnRead({
          id: 10,
          status: "GENERATING",
          gatewayTaskId: "task_123",
        })
      ).resolves.toBe(true)

      expect(gateway.getTask).toHaveBeenCalledTimes(1)
    })

    it("网关查询失败时返回 false 且不节流，下次轮询继续自愈", async () => {
      const { service, gateway } = setup()
      gateway.getTask
        .mockRejectedValueOnce(new Error("gateway down"))
        .mockResolvedValueOnce(gatewayTask)

      await expect(
        service.reconcileVideoTaskOnRead({
          id: 10,
          status: "GENERATING",
          gatewayTaskId: "task_123",
        })
      ).resolves.toBe(false)
      await expect(
        service.reconcileVideoTaskOnRead({
          id: 10,
          status: "GENERATING",
          gatewayTaskId: "task_123",
        })
      ).resolves.toBe(true)

      expect(gateway.getTask).toHaveBeenCalledTimes(2)
    })

    it("分镜席位视频与美妆视频入口同样查网关并走统一终态处理", async () => {
      const { service, gateway } = setup()
      gateway.getTask.mockResolvedValue(gatewayTask)

      await expect(
        service.reconcileStoryboardVideoOnRead({
          id: 20,
          status: "GENERATING",
          gatewayTaskId: "task_story",
        })
      ).resolves.toBe(true)
      await expect(
        service.reconcileBeautyVideoOnRead({
          id: 30,
          status: "GENERATING",
          gatewayTaskId: "task_beauty",
        })
      ).resolves.toBe(true)

      expect(gateway.getTask).toHaveBeenNthCalledWith(1, "task_story", "platform")
      expect(gateway.getTask).toHaveBeenNthCalledWith(2, "task_beauty", "platform")
    })

    it("三类行同 ID 时节流互不串扰（kind 前缀隔离）", async () => {
      const { service, gateway } = setup()
      gateway.getTask.mockResolvedValue(gatewayTask)

      await service.reconcileVideoTaskOnRead({
        id: 10,
        status: "GENERATING",
        gatewayTaskId: "task_a",
      })
      await service.reconcileStoryboardVideoOnRead({
        id: 10,
        status: "GENERATING",
        gatewayTaskId: "task_b",
      })

      expect(gateway.getTask).toHaveBeenNthCalledWith(1, "task_a", "platform")
      expect(gateway.getTask).toHaveBeenNthCalledWith(2, "task_b", "platform")
    })
  })

  it("验签后处理图片成功回调、转存图片并按实际 usage 扣费", async () => {
    const { service, tx, prisma, usage, artifacts } = setupImage()
    const imageTask: ImageTask = {
      id: "image_task_1",
      object: "image.task",
      status: "succeeded",
      model: "ZQ-Image-1",
      request_id: "req_image_1",
      created_at: 1,
      completed_at: 2,
      usage: { amount: "0.40", currency: "CNY" },
      result: {
        images: [
          { url: "https://gateway.example.com/1.png" },
          { url: "https://gateway.example.com/2.png" },
        ],
      },
    }
    const event = {
      id: "evt_image_1",
      object: "event",
      type: "image.task.succeeded",
      created_at: 2,
      data: { task: imageTask },
    }
    const rawBody = Buffer.from(JSON.stringify(event))
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = `v1=${createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest("hex")}`

    await service.receiveWebhook(rawBody, {
      secretVersion: "1",
      timestamp,
      signature,
      eventId: event.id,
    })

    expect(artifacts.store).toHaveBeenCalledTimes(2)
    expect(artifacts.store).toHaveBeenCalledWith(
      expect.objectContaining({ outputFormat: "png" }),
      101,
      expect.objectContaining({ url: "https://gateway.example.com/1.png" })
    )
    expect(prisma.generationTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { gatewayTaskId: "image_task_1", deletedAt: null },
      })
    )
    expect(tx.generationTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 31,
        gatewayTaskId: "image_task_1",
        status: "GENERATING",
        deletedAt: null,
        gatewayEventId: null,
      },
      data: {
        status: "SUCCESS",
        errorMessage: null,
        gatewayEventId: "evt_image_1",
      },
    })
    expect(tx.generatedImage.updateMany).toHaveBeenCalledTimes(2)
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "1.2", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction)).toMatchObject({
      source: "aicreative.image_generate.portrait", // type=PORTRAIT：人像创作子来源
      requestId: "gateway:image_task_1",
      allowOverdraft: true,
    })
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      gatewayTaskId: "image_task_1",
      gatewayEventId: "evt_image_1",
      taskId: 31,
      status: "SUCCESS",
    })
    expect(tx.imageProject.updateMany).toHaveBeenCalledWith({
      where: { id: 5, status: { not: "ARCHIVED" }, deletedAt: null },
      data: { status: "COMPLETED" },
    })
  })

  it("模型配置固定一口价时：人像 SUCCESS 按「单价 × 成功张数」精确扣费，不走按量倍率", async () => {
    const { service, tx, usage } = setupImage()
    usage.gatewayFixedImageCredits.mockResolvedValue(new Decimal(15))
    const imageTask: ImageTask = {
      id: "image_task_1",
      object: "image.task",
      status: "succeeded",
      model: "ZQ-Image-1",
      request_id: "req_image_1",
      created_at: 1,
      completed_at: 2,
      usage: { amount: "0.40", currency: "CNY" },
      result: {
        images: [
          { url: "https://gateway.example.com/1.png" },
          { url: "https://gateway.example.com/2.png" },
        ],
      },
    }

    await service.applyImageTask(imageTask, "evt_image_fixed")

    // 按任务类型读 PORTRAIT 行固定价（实时读库）
    expect(usage.gatewayFixedImageCredits).toHaveBeenCalledWith("ZQ-Image-1", "PORTRAIT")
    expect(usage.gatewayPriceMultiplier).not.toHaveBeenCalled()
    // 15 × 2 张 = 30 积分，名义售价 = 30 / 10 = 3 元
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "3", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction)).toMatchObject({
      source: "aicreative.image_generate.portrait",
      requestId: "gateway:image_task_1",
      exactCredits: "30",
      allowOverdraft: true,
    })
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      pricingMode: "fixed",
      fixedCredits: "15",
      successCount: 2,
      gatewayAmountCny: "0.40",
    })
  })

  it("模型配置固定一口价时：FAILED 回调不扣费（即使网关有已产生金额）", async () => {
    const { service, gateway, usage } = setupImage()
    usage.gatewayFixedImageCredits.mockResolvedValue(new Decimal(15))
    gateway.validateImageTask.mockReturnValue({ amount: "0.10", currency: "CNY" })
    const failedTask: ImageTask = {
      id: "image_task_1",
      object: "image.task",
      status: "failed",
      model: "ZQ-Image-1",
      request_id: "req_image_failed_fixed",
      created_at: 1,
      completed_at: 2,
      error: { type: "provider_error", code: "partial_failed", message: "second failed" },
      partial_result: { images: [{ url: "https://gateway.example.com/partial.png" }] },
    }

    await service.applyImageTask(failedTask, "evt_image_failed_fixed")

    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it.each([true, false])("车泰斗回调仅持久化回执；保存失败时返回错误供网关重试（保存=%s）", async persisted => {
    const { service, prisma, usage, artifacts, chetaidouReceipts } = setupImage()
    chetaidouReceipts.persistImageTaskReceipt.mockResolvedValue(persisted)
    const imageTask: ImageTask = {
      id: "image_task_chetaidou", object: "image.task", status: "succeeded", model: "ZQ-Image-1",
      request_id: "chetaidou:call:11111111-1111-4111-8111-111111111111", created_at: 1,
      result: { images: [{ url: "https://gateway.example.com/chetaidou.png" }] },
    }
    const event = { id: "evt_chetaidou", object: "event", type: "image.task.succeeded", created_at: 2, data: { task: imageTask } }
    const rawBody = Buffer.from(JSON.stringify(event))
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex")}`
    const result = service.receiveWebhook(rawBody, { secretVersion: "1", timestamp, signature, eventId: event.id })
    if (persisted) await expect(result).resolves.toBeUndefined()
    else await expect(result).rejects.toThrow("车泰斗回调回执落库失败")
    expect(chetaidouReceipts.persistImageTaskReceipt).toHaveBeenCalledWith(imageTask, event.id)
    expect(prisma.generationTask.findFirst).not.toHaveBeenCalled()
    expect(artifacts.store).not.toHaveBeenCalled()
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it("image.task 命中通用生图管线 waiter(hub notify=true)时直接分发,不走 GenerationTask 落库路径", async () => {
    const { service, tx, prisma, usage, artifacts, imageCallbacks } = setupImage()
    ;(imageCallbacks.notify as jest.Mock).mockReturnValue(true)
    const imageTask: ImageTask = {
      id: "image_task_pipeline",
      object: "image.task",
      status: "succeeded",
      model: "ZQ-Image-2",
      request_id: "req_pipeline_1",
      created_at: 1,
      completed_at: 2,
      usage: { amount: "0.75", currency: "CNY" },
      result: { images: [{ url: "https://gateway.example.com/pipeline.png" }] },
    }
    const event = {
      id: "evt_image_pipeline",
      object: "event",
      type: "image.task.succeeded",
      created_at: 2,
      data: { task: imageTask },
    }
    const rawBody = Buffer.from(JSON.stringify(event))
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = `v1=${createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest("hex")}`

    await service.receiveWebhook(rawBody, {
      secretVersion: "1",
      timestamp,
      signature,
      eventId: event.id,
    })

    expect(imageCallbacks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ id: "image_task_pipeline", status: "succeeded" })
    )
    // 未命中本管线才走 applyImageTask:此处被 hub 拦下,不触达 GenerationTask
    expect(prisma.generationTask.findFirst).not.toHaveBeenCalled()
    expect(artifacts.store).not.toHaveBeenCalled()
    expect(tx.generationTask.updateMany).not.toHaveBeenCalled()
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it("image.task 无 waiter 但幂等键带管线前缀(request_id=imggen:)→ 安静 204,不查 GenerationTask 不 503", async () => {
    const { service, tx, prisma, usage, artifacts } = setupImage()
    const imageTask: ImageTask = {
      id: "image_task_stray",
      object: "image.task",
      status: "succeeded",
      model: "ZQ-Image-2",
      request_id: "imggen:job-uuid-1:42:2",
      created_at: 1,
      completed_at: 2,
      usage: { amount: "0.75", currency: "CNY" },
      result: { images: [{ url: "https://gateway.example.com/stray.png" }] },
    }
    const event = {
      id: "evt_image_stray",
      object: "event",
      type: "image.task.succeeded",
      created_at: 2,
      data: { task: imageTask },
    }
    const rawBody = Buffer.from(JSON.stringify(event))
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = `v1=${createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest("hex")}`

    // waiter 已不在(重启/多副本/晚到)的管线任务:不得落入 applyImageTask
    // (查不到关联会 503 引发网关重试风暴),应安静返回。
    await expect(
      service.receiveWebhook(rawBody, {
        secretVersion: "1",
        timestamp,
        signature,
        eventId: event.id,
      })
    ).resolves.toBeUndefined()
    expect(prisma.generationTask.findFirst).not.toHaveBeenCalled()
    expect(artifacts.store).not.toHaveBeenCalled()
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
    expect(tx.generationTask.updateMany).not.toHaveBeenCalled()
    // 管线事件审计落库(C2):owner 为 UUID → t2i/i2i item 行盖事件 id,
    // attempt=2 非 0 → 不触碰任务行(即使查到任务也不盖)
    expect(prisma.imageGenItem.updateMany).toHaveBeenCalledWith({
      where: { id: 42, jobId: "job-uuid-1" },
      data: { gatewayEventId: "evt_image_stray" },
    })
    expect(prisma.generatedImage.updateMany).not.toHaveBeenCalled()
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled()
  })

  it("image.task 管线 generate 任务(数字 owner,单席位 attempt=0)→ 图片行+任务行都盖 gatewayEventId", async () => {
    const { service, prisma } = setupImage()
    const imageTask: ImageTask = {
      id: "image_task_gen_pipeline",
      object: "image.task",
      status: "succeeded",
      model: "ZQ-Image-2",
      request_id: "imggen:31:101:0",
      created_at: 1,
      completed_at: 2,
      usage: { amount: "0.75", currency: "CNY" },
      result: { images: [{ url: "https://gateway.example.com/gen.png" }] },
    }
    const event = {
      id: "evt_image_gen_pipeline",
      object: "event",
      type: "image.task.succeeded",
      created_at: 2,
      data: { task: imageTask },
    }
    const rawBody = Buffer.from(JSON.stringify(event))
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = `v1=${createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest("hex")}`

    await expect(
      service.receiveWebhook(rawBody, {
        secretVersion: "1",
        timestamp,
        signature,
        eventId: event.id,
      })
    ).resolves.toBeUndefined()
    expect(prisma.generatedImage.updateMany).toHaveBeenCalledWith({
      where: { id: 101, taskId: 31 },
      data: { gatewayEventId: "evt_image_gen_pipeline" },
    })
    // 单席位(mock count=1)+attempt=0 → 任务行同盖(纯审计,对控制流惰性)
    expect(prisma.generatedImage.count).toHaveBeenCalledWith({ where: { taskId: 31 } })
    expect(prisma.generationTask.updateMany).toHaveBeenCalledWith({
      where: { id: 31 },
      data: { gatewayEventId: "evt_image_gen_pipeline" },
    })
  })

  it("image.task 非终态(queued/running)管线事件 → 审计落库 no-op,不写任何行", async () => {
    const { service, prisma } = setupImage()
    const imageTask: ImageTask = {
      id: "image_task_running",
      object: "image.task",
      status: "running",
      model: "ZQ-Image-2",
      request_id: "imggen:31:101:0",
      created_at: 1,
      completed_at: 2,
      result: undefined,
    } as unknown as ImageTask
    const event = {
      id: "evt_image_running",
      object: "event",
      type: "image.task.running",
      created_at: 2,
      data: { task: imageTask },
    }
    const rawBody = Buffer.from(JSON.stringify(event))
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = `v1=${createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest("hex")}`

    await expect(
      service.receiveWebhook(rawBody, {
        secretVersion: "1",
        timestamp,
        signature,
        eventId: event.id,
      })
    ).resolves.toBeUndefined()
    expect(prisma.generatedImage.updateMany).not.toHaveBeenCalled()
    expect(prisma.imageGenItem.updateMany).not.toHaveBeenCalled()
    expect(prisma.generationTask.updateMany).not.toHaveBeenCalled()
  })

  it("图片回调写入最终尺寸、原图地址和交付降级信息", async () => {
    const { service, tx, prisma, artifacts } = setupImage()
    const deliveryPlan = {
      requested: { aspectRatio: "4:5", resolutionTier: "2K", width: 1638, height: 2048 },
      providerApplied: { aspectRatio: "3:4", size: "2048" },
      delivery: {
        width: 1638,
        height: 2048,
        strategy: "adapter",
        nativeResolution: true,
      },
      warnings: ["模型不支持 4:5，已使用 3:4 生成后适配"],
    }
    prisma.generationTask.findFirst.mockResolvedValue({
      id: 31,
      projectId: 5,
      userId: 7,
      type: "PORTRAIT",
      generationMode: "STANDARD",
      model: "ZQ-Image-1",
      status: "GENERATING",
      gatewayTaskId: "image_task_1",
      gatewayEventId: null,
      deliveryPlan,
      generatedImages: [{ id: 101, status: "GENERATING", order: 0 }],
    })
    artifacts.store.mockResolvedValue({
      url: "https://spaces.example.com/portrait-results/result.jpg",
      originalUrl: "https://spaces.example.com/portrait-originals/original.png",
      width: 1638,
      height: 2048,
      nativeWidth: 1536,
      nativeHeight: 2048,
      deliveryMeta: { strategy: "native_cover", nativeResolution: true },
      delivery: { strategy: "native_cover", nativeResolution: true },
      warnings: ["模型输出比例与目标比例差异较大，已使用留白保护人像完整性"],
    })
    const imageTask: ImageTask = {
      id: "image_task_1",
      object: "image.task",
      status: "succeeded",
      model: "ZQ-Image-1",
      request_id: "req_image_1",
      created_at: 1,
      completed_at: 2,
      usage: { amount: "0.40", currency: "CNY" },
      result: { images: [{ url: "https://gateway.example.com/1.png" }] },
    }

    imageTask.adaptation = {
      requested: { aspect_ratio: "4:5", resolution: "1k" },
      actual: { size: "1536x2048", aspect_ratio: "3:4", resolution: "2k" },
      changes: ["resolution 1k → 2k"],
    }
    await service.applyImageTask(imageTask, "evt_image_delivery")
    const imageWrite = tx.generatedImage.updateMany.mock.calls[0][0].data
    expect(imageWrite.deliveryMeta.gatewayImage).toMatchObject({
      width: 1536,
      height: 2048,
      adaptation: imageTask.adaptation,
    })

    expect(tx.generatedImage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          url: "https://spaces.example.com/portrait-results/result.jpg",
          originalUrl: "https://spaces.example.com/portrait-originals/original.png",
          width: 1638,
          height: 2048,
          nativeWidth: 1536,
          nativeHeight: 2048,
        }),
      })
    )
    expect(tx.generationTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryPlan: {
            ...deliveryPlan,
            providerApplied: {
              size: "1536x2048",
              aspectRatio: "3:4",
              resolutionTier: "2k",
              width: 1536,
              height: 2048,
            },
            delivery: {
              ...deliveryPlan.delivery,
              strategy: "native_cover",
              nativeResolution: true,
            },
            warnings: [
              ...deliveryPlan.warnings,
              "resolution 1k → 2k",
              "模型输出比例与目标比例差异较大，已使用留白保护人像完整性",
            ],
          },
        }),
      })
    )
  })

  it("AI 拆图回调使用独立存储路径、阶段和扣费来源", async () => {
    const { service, tx, prisma, usage, artifacts } = setupImage()
    prisma.generationTask.findFirst.mockResolvedValue({
      id: 31,
      projectId: 5,
      userId: 7,
      type: "ECOMMERCE",
      generationMode: "AI_SPLIT",
      model: "ZQ-Image-3",
      status: "GENERATING",
      gatewayTaskId: "image_task_1",
      gatewayEventId: null,
      generatedImages: [
        { id: 101, status: "GENERATING", order: 0 },
        { id: 102, status: "GENERATING", order: 1 },
      ],
    })
    const imageTask: ImageTask = {
      id: "image_task_1",
      object: "image.task",
      status: "succeeded",
      model: "ZQ-Image-3",
      request_id: "req_image_1",
      created_at: 1,
      completed_at: 2,
      usage: { amount: "0.40", currency: "CNY" },
      result: {
        images: [
          { url: "https://gateway.example.com/1.png" },
          { url: "https://gateway.example.com/2.png" },
        ],
      },
    }

    await service.applyImageTask(imageTask, "evt_ai_split")

    expect(artifacts.store).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ generationMode: "AI_SPLIT" }),
      101,
      expect.objectContaining({ url: "https://gateway.example.com/1.png" })
    )
    expect(tx.generationTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUCCESS", aiSplitStage: "SUCCESS" }),
      })
    )
    expect(usage.chargeModelInTransaction).toHaveBeenCalledTimes(2)
    // 按量也按张拆：0.40 × 倍率 3 = 1.2，÷ 2 张 = 0.6/张；requestId 以图片 id 幂等
    expect(usage.chargeModelInTransaction).toHaveBeenNthCalledWith(
      1,
      tx,
      7,
      "0.6",
      expect.objectContaining({
        source: "aicreative.image_generate.ai_split",
        requestId: "gateway:image_task_1:101",
        allowOverdraft: true,
      })
    )
    expect(usage.chargeModelInTransaction).toHaveBeenNthCalledWith(
      2,
      tx,
      7,
      "0.6",
      expect.objectContaining({
        source: "aicreative.image_generate.ai_split",
        requestId: "gateway:image_task_1:102",
        allowOverdraft: true,
      })
    )
    const first = chargeParamsOf(usage.chargeModelInTransaction)
    expect(first.meta).toMatchObject({
      gatewayTaskId: "image_task_1",
      taskId: 31,
      imageId: 101,
      order: 0,
      gatewayAmountCny: "0.2",
      priceMultiplier: "3",
    })
    const second = usage.chargeModelInTransaction.mock.calls[1][3] as Record<string, unknown>
    expect((second.meta as Record<string, unknown>).imageId).toBe(102)
  })

  it("AI 拆图固定一口价：每张一条扣费记录（单价 exactCredits，不乘张数）", async () => {
    const { service, tx, prisma, usage } = setupImage()
    usage.gatewayFixedImageCredits.mockResolvedValue(new Decimal(15))
    prisma.generationTask.findFirst.mockResolvedValue({
      id: 31,
      projectId: 5,
      userId: 7,
      type: "ECOMMERCE",
      generationMode: "AI_SPLIT",
      model: "ZQ-Image-3",
      status: "GENERATING",
      gatewayTaskId: "image_task_1",
      gatewayEventId: null,
      generatedImages: [
        { id: 101, status: "GENERATING", order: 0 },
        { id: 102, status: "GENERATING", order: 1 },
      ],
    })
    const imageTask: ImageTask = {
      id: "image_task_1",
      object: "image.task",
      status: "succeeded",
      model: "ZQ-Image-3",
      request_id: "req_image_split_fixed",
      created_at: 1,
      completed_at: 2,
      usage: { amount: "0.40", currency: "CNY" },
      result: {
        images: [
          { url: "https://gateway.example.com/1.png" },
          { url: "https://gateway.example.com/2.png" },
        ],
      },
    }

    await service.applyImageTask(imageTask, "evt_split_fixed")

    // 按任务类型读 AI_SPLIT 行固定价（实时读库）
    expect(usage.gatewayFixedImageCredits).toHaveBeenCalledWith("ZQ-Image-3", "AI_SPLIT")
    expect(usage.chargeModelInTransaction).toHaveBeenCalledTimes(2)
    // 每张一条：15 积分/张（名义售价 1.5 元），合计与整笔 30 积分一致
    expect(usage.chargeModelInTransaction).toHaveBeenNthCalledWith(
      1,
      tx,
      7,
      "1.5",
      expect.objectContaining({
        source: "aicreative.image_generate.ai_split",
        exactCredits: "15",
        requestId: "gateway:image_task_1:101",
        allowOverdraft: true,
      })
    )
    expect(usage.chargeModelInTransaction).toHaveBeenNthCalledWith(
      2,
      tx,
      7,
      "1.5",
      expect.objectContaining({
        exactCredits: "15",
        requestId: "gateway:image_task_1:102",
        allowOverdraft: true,
      })
    )
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      pricingMode: "fixed",
      fixedCredits: "15",
      imageId: 101,
      order: 0,
      gatewayAmountCny: "0.2",
    })
  })

  it("AI 拆图一口价部分失败：只收成功落图张数（终态 FAILED 带 1 张也只扣 1 张）", async () => {
    const { service, prisma, usage } = setupImage()
    usage.gatewayFixedImageCredits.mockResolvedValue(new Decimal(15))
    prisma.generationTask.findFirst.mockResolvedValue({
      id: 31,
      projectId: 5,
      userId: 7,
      type: "ECOMMERCE",
      generationMode: "AI_SPLIT",
      model: "ZQ-Image-3",
      status: "GENERATING",
      gatewayTaskId: "image_task_1",
      gatewayEventId: null,
      generatedImages: [
        { id: 101, status: "GENERATING", order: 0 },
        { id: 102, status: "GENERATING", order: 1 },
      ],
    })
    const failedTask: ImageTask = {
      id: "image_task_1",
      object: "image.task",
      status: "failed",
      model: "ZQ-Image-3",
      request_id: "req_image_split_partial",
      created_at: 1,
      completed_at: 2,
      error: { type: "provider_error", code: "partial_failed", message: "second failed" },
      partial_result: { images: [{ url: "https://gateway.example.com/partial.png" }] },
    }

    await service.applyImageTask(failedTask, "evt_split_partial_fixed")

    // 2 席只落 1 张：仅扣 1 张（15 积分，一条记录），失败那张不收
    expect(usage.chargeModelInTransaction).toHaveBeenCalledTimes(1)
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      7,
      "1.5",
      expect.objectContaining({
        source: "aicreative.image_generate.ai_split",
        exactCredits: "15",
        requestId: "gateway:image_task_1:101",
        allowOverdraft: true,
      })
    )
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      imageId: 101,
      order: 0,
      pricingMode: "fixed",
      fixedCredits: "15",
    })
  })

  it("AI 拆图按量部分失败：按成功张数等比折算（2 席落 1 张只收一半）", async () => {
    const { service, prisma, usage } = setupImage()
    prisma.generationTask.findFirst.mockResolvedValue({
      id: 31,
      projectId: 5,
      userId: 7,
      type: "ECOMMERCE",
      generationMode: "AI_SPLIT",
      model: "ZQ-Image-3",
      status: "GENERATING",
      gatewayTaskId: "image_task_1",
      gatewayEventId: null,
      generatedImages: [
        { id: 101, status: "GENERATING", order: 0 },
        { id: 102, status: "GENERATING", order: 1 },
      ],
    })
    const failedTask: ImageTask = {
      id: "image_task_1",
      object: "image.task",
      status: "failed",
      model: "ZQ-Image-3",
      request_id: "req_image_split_partial_usage",
      created_at: 1,
      completed_at: 2,
      error: { type: "provider_error", code: "partial_failed", message: "second failed" },
      partial_result: { images: [{ url: "https://gateway.example.com/partial.png" }] },
    }

    await service.applyImageTask(failedTask, "evt_split_partial_usage")

    // 0.40 × 倍率 3 = 1.2 全额，2 席落 1 张只收一半 = 0.6，一条记录（成功那张的份额）
    expect(usage.chargeModelInTransaction).toHaveBeenCalledTimes(1)
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      7,
      "0.6",
      expect.objectContaining({
        source: "aicreative.image_generate.ai_split",
        requestId: "gateway:image_task_1:101",
        allowOverdraft: true,
      })
    )
    expect(chargeParamsOf(usage.chargeModelInTransaction).meta).toMatchObject({
      imageId: 101,
      order: 0,
      gatewayAmountCny: "0.2",
      priceMultiplier: "3",
    })
  })

  it("通用生图（非人像/非拆图）扣费 source 仍走 aicreative.image_generate", async () => {
    const { service, tx, prisma, usage } = setupImage()
    prisma.generationTask.findFirst.mockResolvedValue({
      id: 32,
      projectId: 6,
      userId: 7,
      type: "GENERAL",
      generationMode: "STANDARD",
      model: "ZQ-Image-1",
      status: "GENERATING",
      gatewayTaskId: "image_task_2",
      gatewayEventId: null,
      promptConfig: { model_params: { output_format: "png" } },
      generatedImages: [{ id: 103, status: "GENERATING", order: 0 }],
    })
    const imageTask: ImageTask = {
      id: "image_task_2",
      object: "image.task",
      status: "succeeded",
      model: "ZQ-Image-1",
      request_id: "req_image_2",
      created_at: 1,
      completed_at: 2,
      usage: { amount: "0.40", currency: "CNY" },
      result: { images: [{ url: "https://gateway.example.com/1.png" }] },
    }

    await service.applyImageTask(imageTask, "evt_image_general")

    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(tx, 7, "1.2", expect.anything())
    expect(chargeParamsOf(usage.chargeModelInTransaction)).toMatchObject({
      source: "aicreative.image_generate",
      requestId: "gateway:image_task_2",
    })
  })

  it("图片失败回调保留部分成功图片并将剩余席位标记失败", async () => {
    const { service, tx, gateway, usage } = setupImage()
    gateway.validateImageTask.mockReturnValue(null)
    const failedTask: ImageTask = {
      id: "image_task_1",
      object: "image.task",
      status: "failed",
      model: "ZQ-Image-1",
      request_id: "req_image_failed",
      created_at: 1,
      completed_at: 2,
      error: { type: "provider_error", code: "partial_failed", message: "second failed" },
      partial_result: { images: [{ url: "https://gateway.example.com/partial.png" }] },
    }

    await service.applyImageTask(failedTask, "evt_image_failed")

    expect(tx.generationTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", gatewayEventId: "evt_image_failed" }),
      })
    )
    expect(tx.generatedImage.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUCCESS" }),
      })
    )
    expect(tx.generatedImage.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorMessage: "AI Gateway 图片生成失败",
        }),
      })
    )
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it("图片回调未抢到终态更新时不重复扣费", async () => {
    const { service, usage } = setupImage(0)
    const imageTask: ImageTask = {
      id: "image_task_1",
      object: "image.task",
      status: "succeeded",
      model: "ZQ-Image-1",
      request_id: "req_image_1",
      created_at: 1,
      completed_at: 2,
      usage: { amount: "0.40", currency: "CNY" },
      result: { images: [{ url: "https://gateway.example.com/1.png" }] },
    }

    await expect(service.applyImageTask(imageTask, "evt_image_1")).resolves.toBe(false)
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  describe("图片任务读时对账与启动恢复", () => {
    const succeededImageTask: ImageTask = {
      id: "image_task_1",
      object: "image.task",
      status: "succeeded",
      model: "ZQ-Image-1",
      request_id: "req_image_1",
      created_at: 1,
      completed_at: 2,
      usage: { amount: "0.40", currency: "CNY" },
      result: { images: [{ url: "https://gateway.example.com/1.png" }] },
    }

    it("读时对账：GENERATING 行查网关并走同一套 applyImageTask 落图扣费", async () => {
      const { service, gateway, artifacts, usage } = setupImage()
      gateway.getImageTask.mockResolvedValue(succeededImageTask)

      await expect(
        service.reconcileImageTaskOnRead({
          id: 31,
          status: "GENERATING",
          gatewayTaskId: "image_task_1",
        })
      ).resolves.toBe(true)

      expect(gateway.getImageTask).toHaveBeenCalledWith("image_task_1", "platform")
      expect(artifacts.store).toHaveBeenCalledTimes(1)
      expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        7,
        "1.2",
        expect.objectContaining({ requestId: "gateway:image_task_1" })
      )
    })

    it("读时对账：非 GENERATING、未关联任务、网关未配置时不查网关", async () => {
      const { service, gateway } = setupImage()

      await expect(
        service.reconcileImageTaskOnRead({
          id: 31,
          status: "SUCCESS",
          gatewayTaskId: "image_task_1",
        })
      ).resolves.toBe(false)
      await expect(
        service.reconcileImageTaskOnRead({ id: 31, status: "GENERATING", gatewayTaskId: null })
      ).resolves.toBe(false)
      gateway.isConfigured.mockReturnValueOnce(false)
      await expect(
        service.reconcileImageTaskOnRead({
          id: 31,
          status: "GENERATING",
          gatewayTaskId: "image_task_1",
        })
      ).resolves.toBe(false)

      expect(gateway.getImageTask).not.toHaveBeenCalled()
    })

    it("读时对账：同一任务 2 分钟内节流，不重复查网关", async () => {
      const { service, gateway } = setupImage()
      gateway.getImageTask.mockResolvedValue(succeededImageTask)

      await service.reconcileImageTaskOnRead({
        id: 31,
        status: "GENERATING",
        gatewayTaskId: "image_task_1",
      })
      await expect(
        service.reconcileImageTaskOnRead({
          id: 31,
          status: "GENERATING",
          gatewayTaskId: "image_task_1",
        })
      ).resolves.toBe(true)

      expect(gateway.getImageTask).toHaveBeenCalledTimes(1)
    })

    it("读时对账：查询失败返回 false 且不节流，下次轮询继续自愈", async () => {
      const { service, gateway } = setupImage()
      gateway.getImageTask
        .mockRejectedValueOnce(new Error("gateway down"))
        .mockResolvedValueOnce(succeededImageTask)

      await expect(
        service.reconcileImageTaskOnRead({
          id: 31,
          status: "GENERATING",
          gatewayTaskId: "image_task_1",
        })
      ).resolves.toBe(false)
      await expect(
        service.reconcileImageTaskOnRead({
          id: 31,
          status: "GENERATING",
          gatewayTaskId: "image_task_1",
        })
      ).resolves.toBe(true)

      expect(gateway.getImageTask).toHaveBeenCalledTimes(2)
    })

    it("启动恢复扫描卡住的图片任务并按网关真实终态落图扣费", async () => {
      const { service, prisma, gateway, artifacts, usage } = setupImage()
      prisma.generationTask.findMany.mockResolvedValue([{ id: 31, gatewayTaskId: "image_task_1" }])
      gateway.getImageTask.mockResolvedValue(succeededImageTask)

      await service.onModuleInit()

      expect(prisma.generationTask.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: "GENERATING", gatewayTaskId: { not: null }, deletedAt: null },
        })
      )
      expect(gateway.getImageTask).toHaveBeenCalledWith("image_task_1", "platform")
      expect(artifacts.store).toHaveBeenCalledTimes(1)
      expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        7,
        "1.2",
        expect.objectContaining({ requestId: "gateway:image_task_1" })
      )
    })

    it("启动恢复查询失败视为瞬态，仅告警不阻断启动", async () => {
      const { service, prisma, gateway } = setupImage()
      prisma.generationTask.findMany.mockResolvedValue([{ id: 31, gatewayTaskId: "image_task_1" }])
      gateway.getImageTask.mockRejectedValue(new Error("gateway rolling restart"))

      await expect(service.onModuleInit()).resolves.toBeUndefined()
      expect(gateway.validateImageTask).not.toHaveBeenCalled()
    })
  })

  it("拒绝无效签名", async () => {
    const { service } = setup()

    await expect(
      service.receiveWebhook(Buffer.from("{}"), {
        secretVersion: "1",
        timestamp: Math.floor(Date.now() / 1000).toString(),
        signature: "v1=invalid",
        eventId: "evt_123",
      })
    ).rejects.toBeInstanceOf(UnauthorizedException)
  })
})
