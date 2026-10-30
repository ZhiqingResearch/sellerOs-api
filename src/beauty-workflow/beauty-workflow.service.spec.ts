import { BadRequestException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import type { CreateBeautyTaskBatchDto } from "./beauty-workflow.dto"
import { BeautyWorkflowService } from "./beauty-workflow.service"

describe("BeautyWorkflowService.removeVideos", () => {
  function setup(tasks: Array<{ id: number; status: string }>) {
    const tx = {
      beautyTask: {
        findMany: jest.fn().mockResolvedValue(tasks),
        updateMany: jest.fn().mockResolvedValue({ count: tasks.length }),
      },
    }
    const prisma = {
      beautyProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7 }) },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        Promise.resolve(callback(tx))
      ),
    }
    const service = new BeautyWorkflowService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never
    )
    return { service, tx }
  }

  it("批量软删除 Beauty 视频", async () => {
    const { service, tx } = setup([
      { id: 1, status: "SUCCESS" },
      { id: 2, status: "FAILED" },
    ])

    await expect(service.removeVideos(3, [1, 2], 7)).resolves.toEqual({
      success: true,
      requestedCount: 2,
      removedCount: 2,
    })
    expect(tx.beautyTask.updateMany).toHaveBeenCalledTimes(1)
  })

  it("混入无效 ID 时整批拒绝", async () => {
    const { service, tx } = setup([{ id: 1, status: "SUCCESS" }])

    await expect(service.removeVideos(3, [1, 2], 7)).rejects.toBeInstanceOf(BadRequestException)
    expect(tx.beautyTask.updateMany).not.toHaveBeenCalled()
  })

  it("包含生成中视频时整批拒绝", async () => {
    const { service, tx } = setup([{ id: 1, status: "GENERATING" }])

    await expect(service.removeVideos(3, [1], 7)).rejects.toThrow("生成中的 Beauty 视频不可移除")
    expect(tx.beautyTask.updateMany).not.toHaveBeenCalled()
  })
})

describe("BeautyWorkflowService.createTaskBatch", () => {
  it("使用 BEAUTY 分类模型报价、建任务并提交 Gateway", async () => {
    const createdTask = {
      id: 30,
      status: "GENERATING",
      model: "sourcing-beauty-seedance-mini",
      generationParams: { mode: "reference_to_video", duration_seconds: 4, resolution: "720p" },
      deliveryMeta: null,
      digitalHumanSnapshot: { name: "模特", persona: { private: true } },
    }
    const prisma = {
      beautyProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7 }) },
      digitalHuman: {
        findFirst: jest.fn().mockResolvedValue({
          id: 8,
          name: "模特",
          portraits: [],
          videos: [],
          voiceDesc: null,
          voiceAudio: null,
          persona: null,
          purposes: [],
          tags: [],
          roleCard: null,
        }),
      },
      aiGatewayModel: {
        findFirst: jest.fn().mockResolvedValue({ publicId: "sourcing-beauty-seedance-mini" }),
        findMany: jest.fn().mockResolvedValue([
          { publicId: "sourcing-beauty-seedance-mini", displayName: "美妆视频模型" },
        ]),
      },
      beautyTask: {
        create: jest.fn().mockResolvedValue(createdTask),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    }
    const gateway = {
      estimateVideoPrice: jest.fn().mockResolvedValue({
        variants: [{ maximum_amount: "1.20" }],
      }),
      maximumQuoteAmount: jest.fn().mockReturnValue(new Decimal("1.20")),
      createVideoTask: jest.fn().mockResolvedValue({
        id: "task_beauty",
        object: "video.task",
        status: "queued",
        model: "sourcing-beauty-seedance-mini",
      }),
    }
    const webhook = { applyVideoTask: jest.fn().mockResolvedValue(false) }
    const usage = {
      assertGatewayAffordable: jest.fn().mockResolvedValue(undefined),
      // 默认未配置固定一口价 → 预检回落网关估价
      resolveFixedVideoTier: jest.fn().mockResolvedValue(null),
    }
    const service = new BeautyWorkflowService(
      prisma as never,
      gateway as never,
      webhook as never,
      usage as never
    )
    const dto: CreateBeautyTaskBatchDto = {
      digitalHumanId: 8,
      beautyInput: { style: "清透妆" },
      tasks: [
        {
          groupIndex: 0,
          segmentType: "BASE_MAKEUP",
          segmentIndex: 1,
          prompt: "  模特轻微转头，展示底妆  ",
          durationSec: 4,
          referenceImageUrls: ["https://space.example.com/reference.jpg"],
        },
      ],
    }

    const result = await service.createTaskBatch(3, dto, 7)
    expect(result.tasks).toEqual([
      expect.objectContaining({
        id: 30,
        model: "sourcing-beauty-seedance-mini",
        publicId: "sourcing-beauty-seedance-mini",
        displayName: "美妆视频模型",
        digitalHumanSnapshot: { name: "模特" },
      }),
    ])
    await new Promise(resolve => setImmediate(resolve))

    const request = {
      model: "sourcing-beauty-seedance-mini",
      prompt: "模特轻微转头，展示底妆",
      mode: "reference_to_video",
      duration_seconds: 4,
      aspect_ratio: "9:16",
      resolution: "720p",
      reference_images: [{ url: "https://space.example.com/reference.jpg" }],
      generate_audio: false,
      n: 1,
      callback: true,
    }
    expect(gateway.estimateVideoPrice).not.toHaveBeenCalled()
    expect(usage.assertGatewayAffordable).not.toHaveBeenCalled()
    expect(prisma.beautyTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        model: "sourcing-beauty-seedance-mini",
        generationParams: request,
      }) as Record<string, unknown>,
    })
    expect(gateway.createVideoTask).toHaveBeenCalledWith(request, "beauty-task:30")
    expect(prisma.beautyTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { gatewayTaskId: "task_beauty" } })
    )
  })
})

describe("BeautyWorkflowService.getTaskStats", () => {
  it("统计前先收口超过 30 分钟的任务", async () => {
    const prisma = {
      beautyTask: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    }
    const service = new BeautyWorkflowService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never
    )

    await service.getTaskStats({}, 7)

    expect(prisma.beautyTask.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: 7,
        status: "GENERATING",
        AND: expect.arrayContaining([expect.objectContaining({ OR: [
          { moderationPassedAt: { lte: expect.any(Date) } },
          { moderationPassedAt: null, createdAt: { lte: expect.any(Date) } },
        ] })]),
        deletedAt: null,
      }) as Record<string, unknown>,
      data: {
        status: "TIMEOUT",
        errorMessage: "视频生成超时",
        finishedAt: expect.any(Date) as Date,
      },
    })
  })
})

describe("BeautyWorkflowService 读时对账", () => {
  function setup() {
    const prisma = {
      beautyProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7, id: 3 }) },
      beautyTask: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    }
    const gatewayWebhook = { reconcileBeautyVideoOnRead: jest.fn().mockResolvedValue(false) }
    const service = new BeautyWorkflowService(
      prisma as never,
      {} as never,
      gatewayWebhook as never,
      {} as never
    )
    return { service, prisma, gatewayWebhook }
  }

  const generatingRow = { id: 30, status: "GENERATING", gatewayTaskId: "task_beauty" }

  it("统计时网关确认仍在跑的行不进墙钟超时", async () => {
    const { service, prisma, gatewayWebhook } = setup()
    prisma.beautyTask.findMany.mockResolvedValue([generatingRow])
    gatewayWebhook.reconcileBeautyVideoOnRead.mockResolvedValue(true)

    await service.getTaskStats({}, 7)

    expect(gatewayWebhook.reconcileBeautyVideoOnRead).toHaveBeenCalledWith(generatingRow)
    expect(prisma.beautyTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { notIn: [30] } }),
      })
    )
  })

  it("任务详情轮询时对账拿到权威结论则跳过墙钟超时并重读", async () => {
    const { service, prisma, gatewayWebhook } = setup()
    prisma.beautyTask.findUnique
      .mockResolvedValueOnce({ ...generatingRow, userId: 7 })
      .mockResolvedValueOnce({ ...generatingRow, userId: 7, status: "SUCCESS" })
    gatewayWebhook.reconcileBeautyVideoOnRead.mockResolvedValue(true)

    await expect(service.findOneTask(30, 7)).resolves.toMatchObject({ status: "SUCCESS" })
    expect(prisma.beautyTask.updateMany).not.toHaveBeenCalled()
  })

  it("任务详情对账拿不到权威结论时退回本地墙钟超时", async () => {
    const { service, prisma } = setup()
    const stale = {
      ...generatingRow,
      userId: 7,
      createdAt: new Date(Date.now() - 31 * 60 * 1000),
    }
    prisma.beautyTask.findUnique
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({ ...stale, status: "TIMEOUT" })
    prisma.beautyTask.updateMany.mockResolvedValue({ count: 1 })

    await expect(service.findOneTask(30, 7)).resolves.toMatchObject({ status: "TIMEOUT" })
    expect(prisma.beautyTask.updateMany).toHaveBeenCalledTimes(1)
  })
})
