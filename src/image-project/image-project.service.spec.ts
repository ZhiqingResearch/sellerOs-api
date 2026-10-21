import { BadRequestException } from "@nestjs/common"
import { ImageProjectService } from "./image-project.service"

describe("ImageProjectService.findAllTasks", () => {
  it.each(["STANDARD", "CROP"])("%s 列表与详情从已存 delivery 元信息补齐空尺寸，已有成品尺寸优先", async generationMode => {
    const deliveryMeta = { gatewayImage: { metadata: { delivery: { final_size: "2048x1365", source_size: "3504x2336" } } } };
    const task = { id: 4922, userId: 2, model: "gpt-image-2.5-flare", generationMode, status: "SUCCESS",
      generatedImages: [{ id: 6347, width: null, height: null, nativeWidth: null, nativeHeight: null, deliveryMeta },
        { id: 6348, width: 1024, height: 683, nativeWidth: 3504, nativeHeight: 2336, deliveryMeta }] };
    const prisma = { aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
      generationTask: { findUnique: jest.fn().mockResolvedValue(task), count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([task]) } };
    const service = new ImageProjectService(prisma as never, { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) } as never);
    const detail = await service.findOneTask(4922, 2);
    const list = await service.findAllTasks({ page: 1, pageSize: 10 }, 2);
    for (const projected of [detail, list.items[0]]) {
      expect(projected.generatedImages[0]).toMatchObject({ width: 2048, height: 1365, nativeWidth: 3504, nativeHeight: 2336 });
      expect(projected.generatedImages[1]).toMatchObject({ width: 1024, height: 683 });
    }
    expect(task.generatedImages[0].width).toBeNull();
  });


  it("包含 AI 拆图任务并按席位合并重试图片", async () => {
    const original = {
      id: 801,
      groupId: "g-1",
      directionIndex: 0,
      generationMode: "AI_SPLIT",
      retryOfTaskId: null,
      status: "FAILED", // 原任务失败，重试成功后按席位推导展示状态
      generatedImages: [
        { id: 901, status: "FAILED", url: null, order: 0 },
        { id: 902, status: "SUCCESS", url: "https://example.com/ok.png", order: 1 },
      ],
      project: { id: 5, name: "Running Board" },
    }
    const retry = {
      id: 802,
      groupId: "g-1",
      directionIndex: 0,
      generationMode: "AI_SPLIT",
      retryOfTaskId: 801,
      status: "SUCCESS",
      generatedImages: [
        { id: 903, status: "SUCCESS", url: "https://example.com/retry.png", order: 0 },
      ],
    }
    let listWhere: Record<string, unknown> | null = null
    const prisma = {
      generationTask: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn((args: { where: Record<string, unknown> }) => {
          // 席位合并的组查询返回该方向全部任务（原任务 + 重试任务）
          if (args.where?.groupId) return Promise.resolve([original, retry])
          listWhere = args.where
          return Promise.resolve([original])
        }),
      },
    }
    const service = new ImageProjectService(
      prisma as never,
      { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) } as never
    )

    const result = await service.findAllTasks({ page: 1, pageSize: 24, projectId: 5 }, 7)

    expect(listWhere).toMatchObject({
      userId: 7,
      generationMode: { in: ["STANDARD", "AI_SPLIT", "CROP"] },
      projectId: 5,
    })
    expect(listWhere?.OR).toEqual([
      { retryOfTaskId: null },
      { retryOfTask: { is: { deletedAt: { not: null } } } },
    ])
    expect(result.items).toHaveLength(1)
    // 席位 0 保留重试成功图、席位 1 保留原任务成功图；展示状态按席位推导为 SUCCESS
    expect(result.items[0].generatedImages.map(image => image.id)).toEqual([903, 902])
    expect(result.items[0].status).toBe("SUCCESS")
  })

  it("无 AI 拆图任务时不额外查组", async () => {
    const prisma = {
      generationTask: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 1, generationMode: "STANDARD", groupId: null, directionIndex: null },
          ]),
      },
    }
    const service = new ImageProjectService(
      prisma as never,
      { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) } as never
    )

    const result = await service.findAllTasks({ page: 1, pageSize: 10 }, 7)

    expect(prisma.generationTask.findMany).toHaveBeenCalledTimes(1)
    expect(result.total).toBe(0)
  })

  it("页内有 GENERATING 网关任务时读时对账，拿到权威结论后重读", async () => {
    const generating = {
      id: 801,
      generationMode: "STANDARD",
      groupId: null,
      directionIndex: null,
      status: "GENERATING",
      gatewayTaskId: "image_task_1",
      generatedImages: [{ id: 901, status: "GENERATING", url: null, order: 0 }],
      project: { id: 5, name: "Running Board" },
    }
    const prisma = {
      generationTask: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([generating]),
      },
    }
    const gatewayWebhook = { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(true) }
    const service = new ImageProjectService(prisma as never, gatewayWebhook as never)

    const result = await service.findAllTasks({ page: 1, pageSize: 10 }, 7)

    expect(gatewayWebhook.reconcileImageTaskOnRead).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 801,
        status: "GENERATING",
        gatewayTaskId: "image_task_1",
      })
    )
    expect(prisma.generationTask.count).toHaveBeenCalledTimes(2)
    expect(prisma.generationTask.findMany).toHaveBeenCalledTimes(2)
    expect(result.items).toHaveLength(1)
  })

  it("页内无 GENERATING 任务时不做对账也不重读", async () => {
    const prisma = {
      generationTask: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 802,
            generationMode: "STANDARD",
            groupId: null,
            directionIndex: null,
            status: "SUCCESS",
            gatewayTaskId: "image_task_2",
            generatedImages: [],
            project: { id: 5, name: "Running Board" },
          },
        ]),
      },
    }
    const gatewayWebhook = { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) }
    const service = new ImageProjectService(prisma as never, gatewayWebhook as never)

    await service.findAllTasks({ page: 1, pageSize: 10 }, 7)

    expect(gatewayWebhook.reconcileImageTaskOnRead).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 802,
        status: "SUCCESS",
        gatewayTaskId: "image_task_2",
      })
    )
    expect(prisma.generationTask.findMany).toHaveBeenCalledTimes(1)
  })
})

describe("ImageProjectService.removeImages", () => {
  function setup(images: Array<{ id: number; taskId: number; status: string }>) {
    const tx = {
      generatedImage: {
        findMany: jest.fn().mockResolvedValue(images),
        updateMany: jest.fn().mockResolvedValue({ count: images.length }),
      },
      generationTask: {
        findMany: jest.fn().mockResolvedValue([{ id: 10 }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const prisma = {
      imageProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7, type: "GENERAL" }) },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        Promise.resolve(callback(tx))
      ),
    }
    return {
      service: new ImageProjectService(
        prisma as never,
        { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) } as never
      ),
      tx,
    }
  }

  it("批量软删除图片并清理空父任务", async () => {
    const { service, tx } = setup([
      { id: 1, taskId: 10, status: "SUCCESS" },
      { id: 2, taskId: 10, status: "FAILED" },
    ])

    await expect(service.removeImages(3, [1, 2], 7)).resolves.toEqual({
      success: true,
      requestedCount: 2,
      removedCount: 2,
      removedEmptyTasks: 1,
    })
    expect(tx.generatedImage.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.generationTask.updateMany).toHaveBeenCalledTimes(1)
  })

  it("混入无效 ID 时整批拒绝", async () => {
    const { service, tx } = setup([{ id: 1, taskId: 10, status: "SUCCESS" }])

    await expect(service.removeImages(3, [1, 2], 7)).rejects.toBeInstanceOf(BadRequestException)
    expect(tx.generatedImage.updateMany).not.toHaveBeenCalled()
  })

  it("包含生成中图片时整批拒绝", async () => {
    const { service, tx } = setup([{ id: 1, taskId: 10, status: "GENERATING" }])

    await expect(service.removeImages(3, [1], 7)).rejects.toThrow("生成中的图片不可移除")
    expect(tx.generatedImage.updateMany).not.toHaveBeenCalled()
  })

  it("移除范围包含 AI 拆图图片", async () => {
    let imageWhere: Record<string, unknown> | null = null
    const tx = {
      generatedImage: {
        findMany: jest.fn((args: { where: Record<string, unknown> }) => {
          imageWhere = args.where
          return Promise.resolve([{ id: 1, taskId: 10, status: "SUCCESS" }])
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      generationTask: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    }
    const prisma = {
      imageProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7, type: "ECOMMERCE" }) },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        Promise.resolve(callback(tx))
      ),
    }
    const service = new ImageProjectService(
      prisma as never,
      { reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false) } as never
    )

    await service.removeImages(3, [1], 7)

    const taskFilter = (imageWhere as { task: { generationMode: unknown } })?.task
    expect(taskFilter?.generationMode).toEqual({ in: ["STANDARD", "AI_SPLIT", "CROP"] })
  })
})
