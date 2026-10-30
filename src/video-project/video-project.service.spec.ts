import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { AiModelExecMode, AiModelModality } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { VideoProjectService } from "./video-project.service"

describe("VideoProjectService AI Gateway 视频任务", () => {
  function setup() {
    const task = {
      id: 10,
      projectId: 3,
      userId: 7,
      mode: "NORMAL",
      model: "sourcing-veo-fast-i2v",
      modelName: "Veo Fast",
      prompt: "海边日出",
      status: "GENERATING",
      gatewayTaskId: null,
      resultUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const prisma = {
      videoProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7 }) },
      aiGatewayModel: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          publicId: "sourcing-veo-fast-i2v",
          displayName: "Veo Fast",
        }),
      },
      videoTask: {
        create: jest.fn().mockResolvedValue(task),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...task, ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
    }
    const gatewayTask = {
      id: "gateway_task_1",
      object: "video.task",
      status: "queued",
      model: "sourcing-veo-fast-i2v",
      request_id: "req_1",
      created_at: 1,
    }
    const gateway = {
      estimateVideoPrice: jest.fn().mockResolvedValue({
        currency: "CNY",
        variants: [
          {
            parameters: {},
            estimated_amount: "1.20",
            minimum_amount: "1.00",
            maximum_amount: "1.50",
            exact: false,
            route_dependent: true,
            assumptions: [],
          },
        ],
      }),
      maximumQuoteAmount: jest.fn(
        (variants: Array<{ maximum_amount: string | null; estimated_amount: string }>) =>
          new Decimal(variants[0].maximum_amount ?? variants[0].estimated_amount)
      ),
      createVideoTask: jest.fn().mockResolvedValue(gatewayTask),
      cancelVideoTask: jest.fn(),
    }
    const gatewayWebhook = {
      applyVideoTask: jest.fn().mockResolvedValue(false),
      reconcileVideoTaskOnRead: jest.fn().mockResolvedValue(false),
    }
    const usage = {
      assertGatewayAffordable: jest.fn().mockResolvedValue(undefined),
      assertExactCreditsAffordable: jest.fn().mockResolvedValue(undefined),
      // 默认未配置固定一口价 → 预检回落网关估价；固定价用例单独覆写
      resolveFixedVideoTier: jest.fn().mockResolvedValue(null),
    }
    const service = new VideoProjectService(
      prisma as never,
      gateway as never,
      gatewayWebhook as never,
      usage as never, { refresh: jest.fn() } as never
    )
    return { service, prisma, gateway, gatewayWebhook, usage, task, gatewayTask }
  }

  it("固定一口价命中：预检免调网关估价，按 积分/秒 × 时长 精确校验", async () => {
    const { service, gateway, usage } = setup()
    usage.resolveFixedVideoTier.mockResolvedValue({ creditsPerSec: new Decimal(15), flat: false })

    await service.createTask(
      3,
      {
        category: "NORMAL",
        publicId: "sourcing-veo-fast-i2v",
        params: { prompt: "海边日出", duration_seconds: 8, resolution: "1080p" },
      },
      7
    )

    expect(usage.resolveFixedVideoTier).toHaveBeenCalledWith(
      "sourcing-veo-fast-i2v",
      "NORMAL",
      "1080p",
      undefined
    )
    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    expect(usage.assertGatewayAffordable).not.toHaveBeenCalled()
    // 15 积分/秒 × 8 秒 = 120 积分（不打折口径）
    expect(usage.assertExactCreditsAffordable).toHaveBeenCalledWith(7, new Decimal("120"))
  })

  it("固定一口价按 mode 分价：预检透传请求 mode 匹配对应档位", async () => {
    const { service, gateway, usage } = setup()
    usage.resolveFixedVideoTier.mockResolvedValue({ creditsPerSec: new Decimal(25), flat: false })

    await service.createTask(
      3,
      {
        category: "REFERENCE",
        publicId: "sourcing-seedance-2-5-reference",
        params: {
          prompt: "编辑这段视频",
          mode: "video_to_video",
          duration_seconds: 8,
          resolution: "720p",
        },
      },
      7
    )

    // 模型行由 findFirst mock 固定返回 veo fixture，这里断言 mode 透传参与分价匹配
    expect(usage.resolveFixedVideoTier).toHaveBeenCalledWith(
      "sourcing-veo-fast-i2v",
      "REFERENCE",
      "720p",
      "video_to_video"
    )
    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    // 25 积分/秒 × 8 秒 = 200 积分（编辑价）
    expect(usage.assertExactCreditsAffordable).toHaveBeenCalledWith(7, new Decimal("200"))
  })

  it("自适应模型（无分辨率）预检按 adaptive 保留档一口价校验，不乘时长", async () => {
    const { service, gateway, usage } = setup()
    usage.resolveFixedVideoTier.mockResolvedValue({ creditsPerSec: new Decimal(150), flat: true })

    await service.createTask(
      3,
      {
        category: "REFERENCE",
        publicId: "sourcing-kling-o3-video-edit",
        params: { prompt: "编辑这段视频" },
      },
      7
    )

    expect(usage.resolveFixedVideoTier).toHaveBeenCalledWith(
      "sourcing-veo-fast-i2v",
      "REFERENCE",
      undefined,
      undefined
    )
    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    // 按次一口价 150 积分，与请求时长无关
    expect(usage.assertExactCreditsAffordable).toHaveBeenCalledWith(7, new Decimal("150"))
  })

  it("固定价预检：请求未带时长（自动档）按 1 秒保底计", async () => {
    const { service, gateway, usage } = setup()
    usage.resolveFixedVideoTier.mockResolvedValue({ creditsPerSec: new Decimal(15), flat: false })

    await service.createTask(
      3,
      {
        category: "NORMAL",
        publicId: "sourcing-veo-fast-i2v",
        params: { prompt: "海边日出", resolution: "1080p" },
      },
      7
    )

    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    expect(usage.assertExactCreditsAffordable).toHaveBeenCalledWith(7, new Decimal("15"))
  })

  it("使用 publicId 覆盖前端 model，并强制单视频和回调", async () => {
    const { service, prisma, gateway, gatewayWebhook, usage, gatewayTask } = setup()
    const result = await service.createTask(
      3,
      {
        category: "NORMAL",
        publicId: "sourcing-veo-fast-i2v",
        params: {
          model: "forged-model",
          callback: false,
          n: 4,
          prompt: "海边日出",
          duration_seconds: 8,
          first_frame: { url: "https://example.com/first.png" },
        },
      },
      7
    )

    const request = expect.objectContaining({
      model: "sourcing-veo-fast-i2v",
      callback: true,
      n: 1,
      prompt: "海边日出",
    })
    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    expect(usage.assertGatewayAffordable).not.toHaveBeenCalled()
    expect(gateway.createVideoTask).toHaveBeenCalledWith(request, "video-task:10")
    expect(prisma.videoTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        mode: "NORMAL",
        model: "sourcing-veo-fast-i2v",
        modelName: "Veo Fast",
        firstFrameUrl: "https://example.com/first.png",
      }),
    })
    expect(gatewayWebhook.applyVideoTask).toHaveBeenCalledWith(gatewayTask)
    expect(result.gatewayTaskId).toBe("gateway_task_1")
    expect(result.publicId).toBe("sourcing-veo-fast-i2v")
    expect(result.displayName).toBe("Veo Fast")
    expect(result).not.toHaveProperty("model")
    expect(result).not.toHaveProperty("modelName")
  })

  it("拒绝未启用的分类模型", async () => {
    const { service, prisma, gateway } = setup()
    prisma.aiGatewayModel.findFirst.mockResolvedValue(null)

    await expect(
      service.createTask(
        3,
        { category: "NORMAL", publicId: "disabled", params: { prompt: "测试" } },
        7
      )
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
  })

  it("Gateway 提交结果不确定时保留本地任务等待启动恢复", async () => {
    const { service, prisma, gateway } = setup()
    gateway.createVideoTask.mockRejectedValue(new BadGatewayException("提交失败"))

    await expect(
      service.createTask(
        3,
        {
          category: "NORMAL",
          publicId: "sourcing-veo-fast-i2v",
          params: { prompt: "测试" },
        },
        7
      )
    ).resolves.toMatchObject({ id: 10, status: "GENERATING", gatewayTaskId: null })
    expect(prisma.videoTask.updateMany).not.toHaveBeenCalled()
  })

  it("限流（429）/授权抖动（503）视为瞬态：保留 GENERATING 不标死", async () => {
    const { service, prisma, gateway } = setup()
    const dto = {
      category: "NORMAL",
      publicId: "sourcing-veo-fast-i2v",
      params: { prompt: "测试" },
    }

    gateway.createVideoTask.mockRejectedValue(
      new HttpException("AI Gateway 请求过于频繁", HttpStatus.TOO_MANY_REQUESTS)
    )
    await expect(service.createTask(3, dto, 7)).resolves.toMatchObject({
      id: 10,
      status: "GENERATING",
      gatewayTaskId: null,
    })

    gateway.createVideoTask.mockRejectedValue(
      new ServiceUnavailableException("AI Gateway 配置或模型授权异常")
    )
    await expect(service.createTask(3, dto, 7)).resolves.toMatchObject({
      id: 10,
      status: "GENERATING",
      gatewayTaskId: null,
    })

    expect(prisma.videoTask.updateMany).not.toHaveBeenCalled()
  })

  it("Gateway 明确拒绝请求时标记本地任务失败", async () => {
    const { service, prisma, gateway } = setup()
    gateway.createVideoTask.mockRejectedValue(new BadRequestException("参数错误"))

    await expect(
      service.createTask(
        3,
        {
          category: "NORMAL",
          publicId: "sourcing-veo-fast-i2v",
          params: { prompt: "测试" },
        },
        7
      )
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.videoTask.updateMany).toHaveBeenCalledWith({
      where: { id: 10, status: { in: ["GENERATING", "WAITING_MODERATION"] }, deletedAt: null },
      data: { status: "FAILED", errorMessage: "AI Gateway 视频任务提交失败" },
    })
  })

  it("取消 Gateway 任务后复用统一终态处理", async () => {
    const { service, prisma, gateway, gatewayWebhook, task, gatewayTask } = setup()
    prisma.videoTask.findUnique
      .mockResolvedValueOnce({ userId: 7, status: "GENERATING", gatewayTaskId: "gateway_task_1" })
      .mockResolvedValueOnce({ ...task, gatewayTaskId: "gateway_task_1" })
    gateway.cancelVideoTask.mockResolvedValue(gatewayTask)

    const result = await service.cancelTask(10, 7)

    expect(gateway.cancelVideoTask).toHaveBeenCalledWith("gateway_task_1", "platform")
    expect(gatewayWebhook.applyVideoTask).toHaveBeenCalledWith(gatewayTask)
    expect(result.publicId).toBe("sourcing-veo-fast-i2v")
    expect(result.displayName).toBe("Veo Fast")
  })

  it("Gateway 任务尚未关联时拒绝本地取消", async () => {
    const { service, prisma, gateway } = setup()
    prisma.videoTask.findUnique.mockResolvedValue({
      userId: 7,
      status: "GENERATING",
      gatewayTaskId: null,
    })

    await expect(service.cancelTask(10, 7)).rejects.toThrow("任务正在提交，请稍后取消")
    expect(gateway.cancelVideoTask).not.toHaveBeenCalled()
  })

  it("轮询超过 30 分钟的生成中任务时标记超时", async () => {
    const { service, prisma, task } = setup()
    const staleTask = {
      ...task,
      createdAt: new Date(Date.now() - 31 * 60 * 1000),
    }
    prisma.videoTask.findUnique
      .mockResolvedValueOnce(staleTask)
      .mockResolvedValueOnce({ ...staleTask, status: "TIMEOUT", errorMessage: "视频生成超时" })

    await expect(service.findOneTask(10, 7)).resolves.toMatchObject({
      id: 10,
      status: "TIMEOUT",
      errorMessage: "视频生成超时",
    })
    expect(prisma.videoTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 10,
        status: "GENERATING",
        OR: [
          { moderationPassedAt: { lte: expect.any(Date) } },
          { moderationPassedAt: null, createdAt: { lte: expect.any(Date) } },
        ],
        deletedAt: null,
      },
      data: { status: "TIMEOUT", errorMessage: "视频生成超时" },
    })
  })

  it("审核结束与取消竞争时，未成功认领取消不能返回取消成功", async () => {
    const { service, prisma, gateway, task } = setup()
    prisma.videoTask.findUnique.mockResolvedValue({ ...task, status: "WAITING_MODERATION" })
    prisma.videoTask.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(service.cancelTask(10, 7)).rejects.toThrow("任务已进入提交")
    expect(gateway.cancelVideoTask).not.toHaveBeenCalled()
  })

  it("审核等待不计入生成超时", async () => {
    const { service, prisma, task } = setup()
    prisma.videoTask.findUnique.mockResolvedValue({ ...task, createdAt: new Date(Date.now() - 40 * 60_000),
      moderationStatus: "PASSED", moderationPassedAt: new Date(), project: { id: 3, name: "项目" } })
    await expect(service.findOneTask(10, 7)).resolves.toMatchObject({ status: "GENERATING" })
    expect(prisma.videoTask.updateMany).not.toHaveBeenCalled()
  })

  it("轮询时读时对账拿到网关终态并返回最新状态", async () => {
    const { service, prisma, gatewayWebhook, task } = setup()
    const running = { ...task, gatewayTaskId: "gateway_task_1" }
    prisma.videoTask.findUnique
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce({ ...running, status: "SUCCESS", resultUrl: "https://x/v.mp4" })
    gatewayWebhook.reconcileVideoTaskOnRead.mockResolvedValue(true)

    await expect(service.findOneTask(10, 7)).resolves.toMatchObject({
      id: 10,
      status: "SUCCESS",
      resultUrl: "https://x/v.mp4",
    })
    expect(gatewayWebhook.reconcileVideoTaskOnRead).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10, gatewayTaskId: "gateway_task_1" })
    )
    expect(prisma.videoTask.updateMany).not.toHaveBeenCalled()
  })

  it("网关确认任务仍在运行时跳过本地墙钟超时", async () => {
    const { service, prisma, gatewayWebhook, task } = setup()
    const staleRunning = {
      ...task,
      gatewayTaskId: "gateway_task_1",
      createdAt: new Date(Date.now() - 31 * 60 * 1000),
    }
    prisma.videoTask.findUnique
      .mockResolvedValueOnce(staleRunning)
      .mockResolvedValueOnce(staleRunning)
    gatewayWebhook.reconcileVideoTaskOnRead.mockResolvedValue(true)

    await expect(service.findOneTask(10, 7)).resolves.toMatchObject({
      id: 10,
      status: "GENERATING",
    })
    expect(prisma.videoTask.updateMany).not.toHaveBeenCalled()
  })

  it("任务中心列表对 GENERATING 行读时对账并重读最新状态", async () => {
    const { service, prisma, gatewayWebhook, task } = setup()
    const generating = { ...task, gatewayTaskId: "gateway_task_1" }
    prisma.videoTask.count = jest.fn().mockResolvedValue(2)
    prisma.videoTask.findMany = jest
      .fn()
      .mockResolvedValueOnce([generating, { ...task, id: 11, status: "FAILED" }])
      .mockResolvedValueOnce([{ ...generating, status: "SUCCESS" }])
    gatewayWebhook.reconcileVideoTaskOnRead.mockResolvedValue(true)

    const result = await service.findAllTasks({ page: 1, pageSize: 10 }, 7)

    expect(gatewayWebhook.reconcileVideoTaskOnRead).toHaveBeenCalledTimes(1)
    expect(gatewayWebhook.reconcileVideoTaskOnRead).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10, gatewayTaskId: "gateway_task_1" })
    )
    expect(prisma.videoTask.findMany).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ total: 2 })
    expect(result.items.find(item => item.id === 10)).toMatchObject({ status: "SUCCESS" })
    expect(result.items.find(item => item.id === 11)).toMatchObject({ status: "FAILED" })
  })

  it("入口不在素材审核之前进行外部报价", async () => {
    const { service, gateway, usage } = setup()
    gateway.estimateVideoPrice.mockResolvedValue({
      currency: "CNY",
      variants: [
        {
          parameters: {},
          estimated_amount: "1.20",
          minimum_amount: "1.00",
          maximum_amount: null,
          exact: false,
          route_dependent: true,
          assumptions: [],
        },
      ],
    })

    await service.createTask(
      3,
      {
        category: "NORMAL",
        publicId: "sourcing-veo-fast-i2v",
        params: { prompt: "测试" },
      },
      7
    )

    expect(usage.assertGatewayAffordable).not.toHaveBeenCalled()
  })
})

describe("VideoProjectService 动作复刻 Gateway 迁移", () => {
  function setup() {
    const task = {
      id: 10,
      projectId: 3,
      userId: 7,
      mode: "MOTION_CONTROL",
      model: "sourcing-kling-v2-6-motion-control",
      modelName: "Kling 2.6 动作复刻",
      prompt: "动作复刻",
      status: "GENERATING",
      gatewayTaskId: null,
      resultUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const prisma = {
      videoProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7 }) },
      aiGatewayModel: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          publicId: "sourcing-kling-v2-6-motion-control",
          displayName: "Kling 2.6 动作复刻",
        }),
      },
      videoTask: {
        create: jest.fn().mockResolvedValue(task),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...task, ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn(),
      },
    }
    const gatewayTask = {
      id: "gateway_motion_1",
      object: "video.task",
      status: "queued",
      model: "sourcing-kling-v2-6-motion-control",
      request_id: "req_m1",
      created_at: 1,
    }
    const gateway = {
      estimateVideoPrice: jest.fn().mockResolvedValue({
        currency: "CNY",
        variants: [
          {
            parameters: {},
            estimated_amount: "1.80",
            minimum_amount: "1.80",
            maximum_amount: "1.80",
            exact: false,
            route_dependent: false,
            assumptions: [],
          },
        ],
      }),
      maximumQuoteAmount: jest.fn(
        (variants: Array<{ maximum_amount: string | null; estimated_amount: string }>) =>
          new Decimal(variants[0].maximum_amount ?? variants[0].estimated_amount)
      ),
      createVideoTask: jest.fn().mockResolvedValue(gatewayTask),
    }
    const gatewayWebhook = {
      applyVideoTask: jest.fn().mockResolvedValue(false),
      reconcileVideoTaskOnRead: jest.fn().mockResolvedValue(false),
    }
    const usage = {
      assertGatewayAffordable: jest.fn().mockResolvedValue(undefined),
      assertExactCreditsAffordable: jest.fn().mockResolvedValue(undefined),
      resolveFixedVideoTier: jest.fn().mockResolvedValue(null),
    }
    const service = new VideoProjectService(
      prisma as never,
      gateway as never,
      gatewayWebhook as never,
      usage as never, { refresh: jest.fn() } as never
    )
    const batchDto = {
      prompt: "   ",
      resolution: "720p",
      actionVideos: [{ url: "https://example.com/action.mp4", name: "动作1", durationSec: 8 }],
      targetImages: [
        { url: "https://example.com/a.png", name: "目标1" },
        { url: "https://example.com/b.png", name: "目标2" },
      ],
    }
    return { service, prisma, gateway, gatewayWebhook, usage, task, gatewayTask, batchDto }
  }

  it("批量按 motion_control 提交 Gateway，prompt 空时兜底，外部报价由审核后的提交入口处理", async () => {
    const { service, prisma, gateway, gatewayWebhook, usage, batchDto } = setup()

    const result = await service.createMotionControlBatch(3, batchDto, 7)

    // 模型不写死 publicId，只按类别取唯一启用的 MOTION_CONTROL 行
    expect(prisma.aiGatewayModel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          category: "MOTION_CONTROL",
          modality: AiModelModality.VIDEO,
          execMode: AiModelExecMode.ASYNC,
          enabled: true,
          gatewayActive: true,
        },
      })
    )
    expect(result.total).toBe(2)
    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    expect(usage.assertGatewayAffordable).not.toHaveBeenCalled()
    expect(gateway.createVideoTask).toHaveBeenCalledTimes(2)
    expect(gateway.createVideoTask).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "sourcing-kling-v2-6-motion-control",
        mode: "motion_control",
      }),
      "video-task:10"
    )
    expect(prisma.videoTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        mode: "MOTION_CONTROL",
        model: "sourcing-kling-v2-6-motion-control",
        modelName: "Kling 2.6 动作复刻",
        prompt: "动作复刻",
        resolution: "720p",
        durationSec: 8,
        generationParams: expect.objectContaining({ callback: true }),
      }),
    })
    expect(gatewayWebhook.applyVideoTask).toHaveBeenCalledTimes(2)
  })

  it("动作复刻模型未启用时拒绝批量", async () => {
    const { service, prisma, gateway, batchDto } = setup()
    prisma.aiGatewayModel.findFirst.mockResolvedValue(null)

    await expect(service.createMotionControlBatch(3, batchDto, 7)).rejects.toBeInstanceOf(
      NotFoundException
    )
    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
  })

  it("image 朝向时动作视频超 10 秒直接 400，不提交网关", async () => {
    const { service, gateway, batchDto } = setup()

    await expect(
      service.createMotionControlBatch(
        3,
        {
          ...batchDto,
          characterOrientation: "image",
          actionVideos: [{ url: "https://example.com/action.mp4", name: "动作1", durationSec: 12 }],
        },
        7
      )
    ).rejects.toThrow("以目标图朝向为主时动作视频最长 10 秒")
    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    expect(gateway.createVideoTask).not.toHaveBeenCalled()
  })

  it("显式传 image 朝向且时长合规时按 character_orientation=image 提交", async () => {
    const { service, gateway, batchDto } = setup()
    const dto = {
      ...batchDto,
      characterOrientation: "image",
      actionVideos: [{ url: "https://example.com/action.mp4", name: "动作1", durationSec: 8 }],
    }

    await service.createMotionControlBatch(3, dto, 7)

    expect(gateway.createVideoTask).toHaveBeenCalledWith(
      expect.objectContaining({ character_orientation: "image" }),
      "video-task:10"
    )
  })

  it("单条被网关明确拒绝时仅该条失败，批次其余任务继续提交", async () => {
    const { service, gateway, gatewayTask, batchDto } = setup()
    gateway.createVideoTask
      .mockRejectedValueOnce(new BadRequestException("参数错误"))
      .mockResolvedValue(gatewayTask)

    const result = await service.createMotionControlBatch(3, batchDto, 7)

    expect(gateway.createVideoTask).toHaveBeenCalledTimes(2)
    expect(result.tasks).toHaveLength(2)
    expect(result.tasks[0]).toMatchObject({
      status: "FAILED",
      errorMessage: "AI Gateway 视频任务提交失败",
    })
    expect(result.tasks[1]).toMatchObject({
      status: "GENERATING",
      gatewayTaskId: "gateway_motion_1",
    })
  })

  it("启动时收口 TokenLab 时代的在途动作复刻任务", async () => {
    const { service, prisma } = setup()
    prisma.videoTask.updateMany.mockResolvedValue({ count: 2 })

    await service.onModuleInit()

    expect(prisma.videoTask.updateMany).toHaveBeenCalledWith({
      where: { status: "GENERATING", model: "kling-motion" },
      data: { status: "FAILED", errorMessage: "动作复刻链路已升级，历史任务已中断" },
    })
  })
})
