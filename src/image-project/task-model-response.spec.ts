import { ImageProjectService } from "./image-project.service"
import { PortraitCreationService } from "./portrait-creation.service"

describe("图片任务创建响应的模型名称", () => {
  function setup(displayName: string | null, archived = false) {
    let committed = false
    const task = {
      id: 71,
      userId: 7,
      model: archived ? "legacy-model" : "ZQ-Image-2",
      generationMode: "STANDARD",
      status: "SUCCESS",
      generatedImages: [],
      ...(archived ? { executionSpec: { modelPublicId: "ZQ-Image-2" } } : {}),
    }
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      generationTask: { create: jest.fn().mockResolvedValue(task) },
      imageGenJob: {
        findFirst: jest.fn().mockResolvedValue({
          id: "job-1",
          taskId: null,
          model: "ZQ-Image-2",
          request: { modelPublicId: "ZQ-Image-2" },
          items: [{ id: 1, status: "SUCCEEDED", url: "https://example.com/result.png", gatewayImage: { originalUrl: "https://stored.example/original.png" } }],
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const prisma = {
      imageProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7, type: "GENERAL" }) },
      generationTask: {
        findUnique: jest.fn().mockResolvedValue(task),
        findMany: jest.fn().mockResolvedValue([task]),
        count: jest.fn().mockResolvedValue(1),
      },
      imageGenJob: { findFirst: jest.fn().mockResolvedValue(null) },
      aiGatewayModel: {
        findMany: jest.fn().mockImplementation(() => {
          expect(committed).toBe(true)
          return Promise.resolve(
            displayName === null
              ? []
              : [
                  {
                    publicId: "ZQ-Image-2",
                    displayName,
                  },
                ]
          )
        }),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => {
        const result = await callback(tx)
        committed = true
        return result
      }),
    }
    const service = new ImageProjectService(
      prisma as never,
      {
        reconcileImageTaskOnRead: jest.fn().mockResolvedValue(false),
      } as never
    )
    return { service, prisma, task, tx }
  }

  it.each([false, true])("创建／归档后和列表、详情的展示名称一致，归档=%s", async archived => {
    const { service, prisma, task, tx } = setup("智擎图片 2", archived)
    const result = await service.createTask(
      31,
      {
        model: task.model,
        ...(archived
          ? {
              sourceJobId: "job-1",
              generatedImages: [{ status: "SUCCESS", url: "https://example.com/result.png" }],
            }
          : {}),
      } as never,
      7
    )
    expect(result).toMatchObject({
      id: 71,
      model: task.model,
      modelPublicId: "ZQ-Image-2",
      displayName: "智擎图片 2",
    })
    expect(result).toEqual(await service.findOneTask(71, 7))
    if (archived) expect(tx.generationTask.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ generatedImages: { create: [expect.objectContaining({ originalUrl: "https://stored.example/original.png" })] } }),
    }))
    expect(result).toEqual((await service.findAllTasks({}, 7)).items[0])
    expect(prisma.aiGatewayModel.findMany).toHaveBeenCalledWith({
      where: { publicId: { in: ["ZQ-Image-2"] } },
      select: { publicId: true, displayName: true },
      orderBy: { id: "asc" },
    })
  })

  it.each([null, "", "   "])("目录缺失或名称为空时保留原模型名称：%j", async displayName => {
    const { service } = setup(displayName)
    await expect(
      service.createTask(31, { model: "ZQ-Image-2" } as never, 7)
    ).resolves.toMatchObject({ modelPublicId: "ZQ-Image-2", displayName: "ZQ-Image-2" })
  })

  it("人像创建响应也使用模型目录名称，保留已创建席位并正常启动执行", async () => {
    const task = { id: 72, model: "ZQ-Image-3", generatedImages: [{ id: 101 }] }
    const tx = {
      generationTask: { create: jest.fn().mockResolvedValue(task) },
      imageProject: { update: jest.fn() },
    }
    const prisma = {
      imageProject: {
        findUnique: jest.fn().mockResolvedValue({ userId: 7, type: "PORTRAIT", status: "DRAFT" }),
      },
      aiGatewayModel: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ publicId: "ZQ-Image-3", displayName: "智擎图片 3" }]),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        Promise.resolve(callback(tx))
      ),
    }
    const runner = { run: jest.fn().mockResolvedValue(undefined) }
    const service = new PortraitCreationService(
      prisma as never,
      {
        validateTask: jest
          .fn()
          .mockResolvedValue({ creationType: "SINGLE_PORTRAIT", modelParams: {}, references: [] }),
      } as never,
      runner as never,
      {
        gatewayFixedImageCredits: jest.fn().mockResolvedValue(null),
      } as never,
      { isAvailable: () => true } as never
    )
    await expect(
      service.createTask(
        31,
        {
          model: "ZQ-Image-3",
          prompt: "人像",
          promptConfig: {},
          viewConfig: {},
        } as never,
        7
      )
    ).resolves.toMatchObject({
      ...task,
      modelPublicId: "ZQ-Image-3",
      displayName: "智擎图片 3",
    })
    expect(runner.run).toHaveBeenCalledWith(72)
  })
})
