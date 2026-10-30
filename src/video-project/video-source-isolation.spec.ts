import { NotFoundException } from "@nestjs/common"
import { InternalGenerationService } from "./internal-generation.service"
import { VideoProjectService } from "./video-project.service"

type TaskWhere = { id?: number; source?: string; project?: { source?: string } }

function setup(source: string, projectSource: string) {
  const task = {
    id: 90,
    userId: 7,
    source,
    projectId: 31,
    project: { id: 31, name: "视频项目", source: projectSource },
    model: "model",
    modelName: "视频模型",
    status: "SUCCESS",
    resultUrl: "https://example.com/video.mp4",
    gatewayTaskId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  const matches = (where: TaskWhere) =>
    (!where.source || where.source === task.source) &&
    (!where.project?.source || where.project.source === task.project.source)
  const prisma = {
    aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
    videoProject: {
      findUnique: jest.fn(({ where }: { where: { source?: string } }) =>
        Promise.resolve(
          !where.source || where.source === projectSource ? { id: 31, userId: 7 } : null
        )
      ),
      update: jest.fn(),
    },
    videoTask: {
      findUnique: jest.fn(({ where }: { where: TaskWhere }) =>
        Promise.resolve(matches(where) ? task : null)
      ),
      findFirst: jest.fn(({ where }: { where: TaskWhere }) =>
        Promise.resolve(matches(where) ? task : null)
      ),
      findMany: jest.fn(({ where }: { where: TaskWhere }) =>
        Promise.resolve(matches(where) ? [task] : [])
      ),
      count: jest.fn(({ where }: { where: TaskWhere }) => Promise.resolve(matches(where) ? 1 : 0)),
      groupBy: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  }
  const gateway = { cancelVideoTask: jest.fn() }
  const webhook = { reconcileVideoTaskOnRead: jest.fn().mockResolvedValue(false) }
  const service = new VideoProjectService(
    prisma as never,
    gateway as never,
    webhook as never,
    {} as never, { refresh: jest.fn() } as never
  )
  return { prisma, gateway, webhook, service }
}

describe("视频创作来源隔离", () => {
  it.each([
    ["vidflowos", "vidflowos"],
    ["platform", "vidflowos"],
  ])("任务来源 %s / 项目来源 %s 不出现在 SellerOS", async (source, projectSource) => {
    const { service, prisma, gateway, webhook } = setup(source, projectSource)
    await expect(service.findAllTasks({}, 7)).resolves.toMatchObject({ total: 0, items: [] })
    await expect(service.findOneTask(90, 7)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.deleteTask(90, 7)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.cancelTask(90, 7)).rejects.toBeInstanceOf(NotFoundException)
    await service.getTaskStats({}, 7)
    expect(prisma.videoTask.groupBy).toHaveBeenCalledWith({
      by: ["status"],
      where: {
        userId: 7,
        projectId: undefined,
        source: "platform",
        project: { source: "platform" },
      },
      _count: { _all: true },
    })
    expect(prisma.videoTask.update).not.toHaveBeenCalled()
    expect(gateway.cancelVideoTask).not.toHaveBeenCalled()
    expect(webhook.reconcileVideoTaskOnRead).not.toHaveBeenCalled()
  })

  it("不能通过 VidFlow 项目 ID 重命名、删除、清理、移除或生成任务", async () => {
    const { service, prisma } = setup("vidflowos", "vidflowos")
    await expect(service.updateProject(31, { name: "修改" }, 7)).rejects.toBeInstanceOf(
      NotFoundException
    )
    await expect(service.deleteProject(31, 7)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.clearInvalidTasks(31, 7)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.removeVideos(31, [90], 7)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.createTask(31, {} as never, 7)).rejects.toBeInstanceOf(NotFoundException)
    expect(prisma.videoProject.update).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("平台自己的视频可读取；VidFlow 内部查询仍能读取自己的视频", async () => {
    const platform = setup("platform", "platform")
    await expect(platform.service.findOneTask(90, 7)).resolves.toMatchObject({
      id: 90,
      publicId: "model",
    })
    const internal = setup("vidflowos", "vidflowos")
    const service = new InternalGenerationService(
      internal.prisma as never,
      {} as never,
      internal.webhook as never,
      {} as never, { refresh: jest.fn() } as never
    )
    await expect(service.getVideoTask(90)).resolves.toMatchObject({
      status: "SUCCESS",
      resultUrl: "https://example.com/video.mp4",
    })
  })
})
