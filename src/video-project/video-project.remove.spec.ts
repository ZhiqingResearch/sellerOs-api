import { BadRequestException } from "@nestjs/common"
import { VideoProjectService } from "./video-project.service"

describe("VideoProjectService.removeVideos", () => {
  function setup(tasks: Array<{ id: number; status: string }>) {
    const videoTask = {
      findMany: jest.fn().mockResolvedValue(tasks),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: tasks.length }),
    }
    const prisma = {
      videoProject: {
        findUnique: jest.fn().mockResolvedValue({ userId: 7 }),
        update: jest.fn().mockResolvedValue({ id: 3 }),
      },
      videoTask: {
        ...videoTask,
      },
      $transaction: jest.fn((operation: unknown) => {
        if (Array.isArray(operation)) return Promise.all(operation)
        return Promise.resolve(
          (operation as (client: { videoTask: typeof videoTask }) => unknown)({ videoTask })
        )
      }),
    }
    const service = new VideoProjectService(prisma as never, {} as never, {} as never, {} as never)
    return { service, videoTask }
  }

  it("批量软删除不同视频业务产生的任务", async () => {
    const { service, videoTask } = setup([
      { id: 1, status: "SUCCESS" },
      { id: 2, status: "FAILED" },
    ])

    await expect(service.removeVideos(3, [1, 2], 7)).resolves.toEqual({
      success: true,
      requestedCount: 2,
      removedCount: 2,
    })
    expect(videoTask.updateMany).toHaveBeenCalledTimes(1)
  })

  it("混入无效 ID 时整批拒绝", async () => {
    const { service, videoTask } = setup([{ id: 1, status: "SUCCESS" }])

    await expect(service.removeVideos(3, [1, 2], 7)).rejects.toBeInstanceOf(BadRequestException)
    expect(videoTask.updateMany).not.toHaveBeenCalled()
  })

  it("包含生成中视频时整批拒绝", async () => {
    const { service, videoTask } = setup([{ id: 1, status: "GENERATING" }])

    await expect(service.removeVideos(3, [1], 7)).rejects.toThrow("生成中的视频不可移除")
    expect(videoTask.updateMany).not.toHaveBeenCalled()
  })

  it("并发删除导致实际数量不一致时整批回滚", async () => {
    const { service, videoTask } = setup([
      { id: 1, status: "SUCCESS" },
      { id: 2, status: "FAILED" },
    ])
    videoTask.updateMany.mockResolvedValue({ count: 1 })

    await expect(service.removeVideos(3, [1, 2], 7)).rejects.toThrow(
      "部分视频已被移除，请刷新后重试"
    )
  })

  it("清理无效任务时返回实际软删除数量", async () => {
    const { service, videoTask } = setup([])
    videoTask.updateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })

    await expect(service.clearInvalidTasks(3, 7)).resolves.toEqual({
      success: true,
      deletedTotal: 4,
      deletedCancelled: 2,
      deletedFailed: 1,
      deletedTimeout: 1,
      deletedExpired: 0,
    })
    for (const [args] of videoTask.updateMany.mock.calls) {
      expect(args.where.deletedAt).toBeNull()
    }
  })

  it("删除项目时不覆盖已软删除任务的删除时间", async () => {
    const { service, videoTask } = setup([])

    await expect(service.deleteProject(3, 7)).resolves.toEqual({ success: true })
    expect(videoTask.updateMany).toHaveBeenCalledWith({
      where: { projectId: 3, source: "platform", project: { source: "platform" }, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    })
  })
})
