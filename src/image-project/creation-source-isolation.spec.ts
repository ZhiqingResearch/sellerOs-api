import { BadRequestException, NotFoundException } from "@nestjs/common"
import type { CreationSource } from "../common/types/creation-source"
import { ImageToImageService } from "../image-generation/image-to-image.service"
import { InternalImageToImageController } from "../image-generation/internal-image-to-image.controller"
import { AiSplitService } from "./ai-split.service"
import { ImageProjectService } from "./image-project.service"
import { InternalImageGenerationService } from "./internal-image-generation.service"
import { PortraitCreationService } from "./portrait-creation.service"

describe("图片创作来源隔离", () => {
  it("项目、任务列表及总数使用相同来源条件，任务还校验所属项目", async () => {
    const prisma = {
      imageProject: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn<Promise<unknown[]>, [{ where: unknown }]>().mockResolvedValue([]),
      },
      generationTask: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn<Promise<unknown[]>, [{ where: unknown }]>().mockResolvedValue([]),
      },
    }
    const service = new ImageProjectService(prisma as never, {} as never)
    await service.findAllProjects({ name: "VidFlowOS", page: 2 }, 7)
    await service.findAllTasks({ projectId: 31 }, 7)
    const projectWhere = prisma.imageProject.findMany.mock.calls[0][0].where
    const taskWhere = prisma.generationTask.findMany.mock.calls[0][0].where
    expect(projectWhere).toMatchObject({ userId: 7, source: "platform" })
    expect(taskWhere).toMatchObject({
      userId: 7,
      source: "platform",
      project: { source: "platform" },
    })
    expect(prisma.imageProject.count).toHaveBeenCalledWith({ where: projectWhere })
    expect(prisma.generationTask.count).toHaveBeenCalledWith({ where: taskWhere })
  })

  it("同一用户直接使用 VidFlow 项目 ID 不能读取、修改、删除或创建任务", async () => {
    const prisma = {
      imageProject: {
        findUnique: jest.fn(({ where }: { where: { source?: string } }) =>
          Promise.resolve(
            where.source === "vidflowos" ? { id: 31, userId: 7, type: "GENERAL" } : null
          )
        ),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    }
    const service = new ImageProjectService(prisma as never, {} as never)
    await expect(service.findOneProject(31, 7)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.updateProject(31, { name: "修改" }, 7)).rejects.toBeInstanceOf(
      NotFoundException
    )
    await expect(service.deleteProject(31, 7)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.createTask(31, {} as never, 7)).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.imageProject.update).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("任务和图片 ID 入口同时限定任务及项目来源", async () => {
    const prisma = {
      generationTask: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
      generatedImage: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
    }
    const service = new ImageProjectService(prisma as never, {} as never)
    await expect(service.findOneTask(90, 7)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.deleteTask(90, 7)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.deleteGeneratedImage(100, 7)).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.generationTask.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 90, source: "platform", project: { source: "platform" } },
      })
    )
    expect(prisma.generatedImage.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 100,
          source: "platform",
          task: { source: "platform", project: { source: "platform" } },
        },
      })
    )
    expect(prisma.generationTask.update).not.toHaveBeenCalled()
    expect(prisma.generatedImage.update).not.toHaveBeenCalled()
  })

  it.each<CreationSource>(["platform", "vidflowos"])(
    "归档任务和图片在事务内一次写入 %s 来源",
    async source => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        generationTask: { create: jest.fn().mockResolvedValue({ id: 90 }) },
        imageGenJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue({ id: "job-1", taskId: null, request: {}, items: [{ id: 1, url: "https://example.com/1.png", status: "SUCCEEDED" }] }) },
      }
      const prisma = {
        imageProject: { findUnique: jest.fn().mockResolvedValue({ userId: 7, type: "GENERAL" }) },
        imageGenJob: { findFirst: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      }
      const service = new ImageProjectService(prisma as never, {} as never)
      await service.createTask(
        31,
        {
          sourceJobId: "job-1",
          generatedImages: [{ url: "https://example.com/1.png", status: "SUCCESS" }],
        } as never,
        7,
        source
      )
      expect(tx.generationTask.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            source,
            generatedImages: { create: [expect.objectContaining({ source }) as unknown] },
          }) as unknown,
        })
      )
      expect(prisma.imageProject.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 31, source } })
      )
      expect(tx.imageGenJob.updateMany).toHaveBeenCalledWith({
        where: { id: "job-1", userId: 7, source },
        data: { taskId: 90 },
      })
      tx.imageGenJob.updateMany.mockResolvedValue({ count: 0 })
      await expect(
        service.createTask(31, { sourceJobId: "other-channel" } as never, 7, source)
      ).rejects.toBeInstanceOf(BadRequestException)
    }
  )

  it("VidFlow 人像任务在启动 runner 前已写好任务和图片来源", async () => {
    const create = jest
      .fn<Promise<{ id: number }>, [{ data: unknown }]>()
      .mockResolvedValue({ id: 90 })
    const runner = {
      run: jest.fn(() => {
        expect(create.mock.calls[0][0].data).toMatchObject({
          source: "vidflowos",
          generatedImages: { create: [{ source: "vidflowos", order: 0 }] },
        })
        return Promise.resolve()
      }),
    }
    const tx = { generationTask: { create }, imageProject: { update: jest.fn() } }
    const prisma = {
      imageProject: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 31, userId: 7, type: "PORTRAIT", status: "DRAFT" }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    }
    const service = new PortraitCreationService(
      prisma as never,
      { validateTask: jest.fn().mockResolvedValue({ modelParams: {}, references: [] }) } as never,
      runner as never,
      { gatewayFixedImageCredits: jest.fn().mockResolvedValue(null) } as never,
      { isAvailable: () => true } as never
    )
    await service.createTask(
      31,
      { prompt: "人像", model: "model", promptConfig: {}, viewConfig: {} } as never,
      7,
      "vidflowos"
    )
    expect(runner.run).toHaveBeenCalledWith(90)
    expect(prisma.imageProject.findUnique).toHaveBeenCalledWith({
      where: { id: 31, source: "vidflowos" },
    })
  })

  it("人像图片回填和拆图任务组不能跨来源查询", async () => {
    const prisma = {
      generatedImage: { findUnique: jest.fn().mockResolvedValue(null) },
      generationTask: { findMany: jest.fn().mockResolvedValue([]) },
    }
    const portrait = new PortraitCreationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    )
    await expect(portrait.findImageContext(100, 7)).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.generatedImage.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 100,
          source: "platform",
          task: { source: "platform", project: { source: "platform" } },
        },
      })
    )
    const split = new AiSplitService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    )
    for (const source of ["platform", "vidflowos"] as const) {
      await expect(split.getTaskGroup({ groupId: "group-1" }, 7, source)).rejects.toBeInstanceOf(
        NotFoundException
      )
      expect(prisma.generationTask.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            groupId: "group-1",
            userId: 7,
            generationMode: "AI_SPLIT",
            source,
            project: { source },
          },
        })
      )
    }
  })

  it("同手机号的改图 Job 按公开/内部来源隔离，内部控制器明确传来源", async () => {
    const job = {
      id: "job-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      items: [],
      request: {},
    }
    const prisma = {
      imageGenJob: {
        findFirst: jest.fn(({ where }: { where: { source?: string } }) =>
          Promise.resolve(where.source === "vidflowos" ? job : null)
        ),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 7 }) },
    }
    const i2i = new ImageToImageService(prisma as never, {} as never, {} as never, {} as never, {} as never)
    expect(await i2i.getSnapshot("job-1", 7)).toBeNull()
    expect(await i2i.getSnapshot("job-1", 7, "vidflowos")).not.toBeNull()
    const controller = new InternalImageToImageController(prisma as never, i2i)
    await expect(controller.get("job-1", "13800000000")).resolves.not.toBeNull()
    expect(prisma.imageGenJob.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: "job-1", userId: 7, source: "vidflowos", kind: "IMAGE_TO_IMAGE" },
      })
    )
  })

  it("内部通用生图和人像明确传来源，已归档 Job 重试保持幂等", async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 7 }) },
      imageProject: { findFirst: jest.fn().mockResolvedValue({ id: 31 }) },
      imageGenJob: { findFirst: jest.fn().mockResolvedValue({ taskId: 90 }) },
      generationTask: { findFirst: jest.fn().mockResolvedValue({ id: 90 }) },
    }
    const generate = { create: jest.fn().mockResolvedValue({ ok: true, taskId: 90 }) }
    const portrait = { createTask: jest.fn().mockResolvedValue({ id: 90 }) }
    const imageProject = { createTask: jest.fn() }
    const service = new InternalImageGenerationService(
      prisma as never,
      { get: () => generate } as never,
      {} as never,
      imageProject as never,
      portrait as never,
      {} as never
    )
    await service.createGeneralTask({ phone: "13800000000", request: {} })
    await service.createPortraitTask({ phone: "13800000000", request: {} })
    expect(generate.create).toHaveBeenCalledWith(
      { form: JSON.stringify({ projectId: "31" }) },
      7,
      "vidflowos"
    )
    expect(portrait.createTask).toHaveBeenCalledWith(31, {}, 7, "vidflowos")
    await expect(
      service.archiveI2I({ phone: "13800000000", request: { sourceJobId: "job-1" } })
    ).resolves.toEqual({ taskId: 90, duplicate: true, resolutionTier: null })
    expect(imageProject.createTask).not.toHaveBeenCalled()
    expect(prisma.imageGenJob.findFirst).toHaveBeenCalledWith({
      where: { id: "job-1", userId: 7, source: "vidflowos" },
      select: { taskId: true, request: true },
    })
    const localRedraw = { provider: "ZQ-Image-2", sourceWidth: 3000, sourceHeight: 2000, generationWidth: 1536, generationHeight: 1024 }
    prisma.imageGenJob.findFirst.mockResolvedValue({ taskId: null, request: { localRedraw } })
    imageProject.createTask.mockResolvedValue({ id: 91 })
    await expect(service.archiveI2I({ phone: "13800000000", request: { sourceJobId: "local-job", model: "ZQ-Image-3" } }))
      .resolves.toEqual({ taskId: 91, duplicate: false, resolutionTier: null, localRedraw })
    expect(imageProject.createTask).toHaveBeenCalledWith(31, expect.objectContaining({ model: "ZQ-Image-2", aspectRatio: "1536:1024" }), 7, "vidflowos")
    prisma.imageGenJob.findFirst.mockResolvedValue(null)
    await expect(
      service.archiveI2I({ phone: "13800000000", request: { sourceJobId: "platform-job" } })
    ).rejects.toBeInstanceOf(NotFoundException)
  })
  it.each([false, true])("普通改图归档从源 Job 返回请求档位，重复=%s", async duplicate => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 7 }) },
      imageProject: { findFirst: jest.fn().mockResolvedValue({ id: 31 }) },
      imageGenJob: { findFirst: jest.fn().mockResolvedValue({
        taskId: duplicate ? 90 : null, request: { resolutionTier: "4K" },
      }) },
      generationTask: { findFirst: jest.fn().mockResolvedValue({ id: 90 }) },
    }
    const imageProject = { createTask: jest.fn().mockResolvedValue({ id: 90 }) }
    const service = new InternalImageGenerationService(
      prisma as never, {} as never, {} as never, imageProject as never, {} as never, {} as never
    )
    await expect(service.archiveI2I({ phone: "13800000000", request: {
      sourceJobId: "job-1", resolutionTier: "1K",
    } })).resolves.toMatchObject({ taskId: 90, duplicate, resolutionTier: "4K" })
    expect(imageProject.createTask).toHaveBeenCalledTimes(duplicate ? 0 : 1)
  })
})
