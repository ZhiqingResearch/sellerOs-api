jest.mock("../generation-record/generation-record-success", () => ({ recordGenerationSuccess: jest.fn().mockResolvedValue(undefined) }))
import { Logger } from "@nestjs/common"
import { ImageProjectService } from "../image-project/image-project.service"
import { ImageGenItemRunnerService } from "./executor/image-gen-item-runner.service"
import { ReconciliationService } from "./executor/reconciliation.service"

function setup() {
  const job = {
    id: "job-1", userId: 7, source: "platform", kind: "IMAGE_TO_IMAGE", businessType: "IMAGE_CREATIVE",
    taskId: null as number | null, status: "RUNNING",
    // 即使轮询快照已过期，对账仍能保存已有成品。
    expiresAt: new Date(0), createdAt: new Date(),
    request: { kind: "IMAGE_TO_IMAGE", projectId: 41, mode: "batch", provider: "ZQ-Image-2",
      prompt: "替换背景", aspectRatio: "16:9", resolutionTier: "4K" },
    items: [
      { id: 11, idx: 0, status: "SUCCEEDED", deletedAt: null, url: "https://cdn.example.com/a.png",
        width: 4096, height: 2304, providerJobId: "gateway-1",
        gatewayImage: { originalUrl: "https://vendor.example.com/a.png", width: 4096, height: 2304 } },
      { id: 12, idx: 1, status: "FAILED", deletedAt: null, url: null,
        width: null, height: null, providerJobId: null, gatewayImage: null },
    ],
  }
  let saved: any = null
  let transactions = Promise.resolve<unknown>(undefined)
  const prisma = {
    aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
    imageProject: {
      findUnique: jest.fn().mockResolvedValue({ userId: 7, type: "GENERAL" }),
      findFirst: jest.fn().mockResolvedValue({ id: 41 }),
    },
    imageGenJob: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.id !== job.id || where.userId && where.userId !== job.userId || where.source !== job.source) return null
        if (where.kind && where.kind !== job.kind || where.businessType && where.businessType !== job.businessType) return null
        if (where.taskId === null && job.taskId !== null) return null
        if (where.request && !job.request.projectId) return null
        return { ...job }
      }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(async ({ data }: any) => {
        if (data.taskId !== undefined) job.taskId = data.taskId
        if (data.status) job.status = data.status
        return { count: 1 }
      }),
    },
    imageGenItem: {
      findMany: jest.fn(async () => job.items),
      updateMany: jest.fn(),
    },
    generatedImage: { findMany: jest.fn().mockResolvedValue([]) },
    generationTask: {
      create: jest.fn(async ({ data }: any) => {
        saved = { id: 91, ...data, generatedImages: data.generatedImages.create }
        return saved
      }),
      findFirst: jest.fn(async ({ where }: any) => saved && saved.id === where.id && saved.projectId === where.projectId ? saved : null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn((callback: (tx: any) => unknown): Promise<any> => {
      // 模拟数据库行锁串行提交，两个归档调用必须复用首次结果。
      const result = transactions.then(() => callback(prisma))
      transactions = result.catch(() => undefined)
      return result
    }),
  }
  const projects = new ImageProjectService(prisma as never, {} as never)
  const providerFactory = jest.fn()
  const usage = { chargeModel: jest.fn(), chargeTokens: jest.fn() }
  const runner = new ImageGenItemRunnerService(prisma as never, providerFactory, usage as never, {} as never, projects)
  return { job, prisma, projects, runner, providerFactory, usage }
}

describe("Seller 改图项目自动入库", () => {
  beforeEach(() => jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined))
  afterEach(() => jest.restoreAllMocks())

  it("没有页面轮询时，终态聚合仍保存成功图、来源、档位和原图信息", async () => {
    const { runner, prisma, job, providerFactory, usage } = setup()
    await runner.aggregateJob(job.id)
    expect(job.taskId).toBe(91)
    expect(prisma.generationTask.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      projectId: 41, userId: 7, source: "platform", type: "GENERAL", presetCategory: "批量改图",
      sourceJobId: "job-1", status: "SUCCESS", n: 1,
      executionSpec: expect.objectContaining({ kind: "ARCHIVED_IMAGEGEN", form: {
        mode: "batch", resolutionTier: "4K", aspectRatio: "16:9",
      } }),
      generatedImages: { create: [expect.objectContaining({ url: "https://cdn.example.com/a.png", status: "SUCCESS",
        originalUrl: "https://vendor.example.com/a.png", providerJobId: "gateway-1", width: 4096, height: 2304 })] },
    }) }))
    expect(providerFactory).not.toHaveBeenCalled()
    expect(usage.chargeModel).not.toHaveBeenCalled()
    expect(usage.chargeTokens).not.toHaveBeenCalled()
  })

  it("后台补偿、终态回调与旧前端归档并发时只入库一次，并固定目标项目和来源", async () => {
    const { runner, projects, prisma, job } = setup()
    await Promise.all([
      runner.archiveJob(job.id), runner.archiveJob(job.id),
      projects.createTask(41, { sourceJobId: job.id, presetCategory: "场景", model: "ZQ-Image-2", prompt: "替换背景",
        generatedImages: [{ url: job.items[0].url!, status: "SUCCESS" }],
      }, 7),
    ])
    expect(prisma.generationTask.create).toHaveBeenCalledTimes(1)
    expect(prisma.imageGenJob.updateMany).toHaveBeenCalledTimes(1)
    expect(prisma.generationTask.create.mock.calls[0][0].data.presetCategory).toBe("批量改图")
    expect(prisma.$queryRaw).toHaveBeenCalled()
    await expect(projects.createTask(42, { sourceJobId: job.id, presetCategory: "批量改图", model: "ZQ-Image-2", prompt: "改图" }, 7))
      .rejects.toThrow("已绑定其他项目")
  })

  it.each(["QUEUED", "RUNNING"])("仍有 %s 图片时不提前归档遗漏成品", async status => {
    const { runner, prisma, job } = setup()
    job.items[1].status = status
    await runner.archiveJob(job.id)
    expect(prisma.generationTask.create).not.toHaveBeenCalled()
  })

  it("全部失败时不创建空的成功任务", async () => {
    const { runner, prisma, job } = setup()
    job.items[0].status = "FAILED"
    await runner.archiveJob(job.id)
    expect(prisma.generationTask.create).not.toHaveBeenCalled()
  })

  it.each(["vidflowos", "CHETAIDOU", "TEXT_TO_IMAGE", "no-project"])("不自动归档非 Seller 选项目请求：%s", async kind => {
    const { runner, prisma, job } = setup()
    if (kind === "vidflowos") job.source = kind
    else if (kind === "CHETAIDOU") job.businessType = kind
    else if (kind === "TEXT_TO_IMAGE") job.kind = kind
    else delete (job.request as { projectId?: number }).projectId
    await runner.archiveJob(job.id)
    expect(prisma.generationTask.create).not.toHaveBeenCalled()
  })

  it("已删除的目标项目不被重建，也不会改存到别的项目", async () => {
    const { runner, prisma, job } = setup()
    prisma.imageProject.findFirst.mockResolvedValue(null as never)
    await runner.archiveJob(job.id)
    expect(prisma.generationTask.create).not.toHaveBeenCalled()
    expect(job.taskId).toBeNull()
  })

  it("一次入库失败后可直接补偿保存，既不重新生图也不重复扣费", async () => {
    const { runner, projects, prisma, job, providerFactory, usage } = setup()
    jest.spyOn(projects, "createTask").mockRejectedValueOnce(new Error("数据库暂时不可用"))
    await runner.archiveJob(job.id)
    expect(job.taskId).toBeNull()
    await runner.archiveJob(job.id)
    expect(job.taskId).toBe(91)
    expect(prisma.generationTask.create).toHaveBeenCalledTimes(1)
    expect(providerFactory).not.toHaveBeenCalled()
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("启动/每分钟对账恢复漏入库的终态图片，不依赖快照保留期", async () => {
    const { runner, prisma, job } = setup()
    prisma.imageGenItem.findMany.mockResolvedValueOnce([])
    prisma.imageGenJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: job.id }] as never)
    const reconciliation = new ReconciliationService(prisma as never, {} as never, runner, {} as never)
    await reconciliation.reconcile()
    expect(job.taskId).toBe(91)
    expect(prisma.imageGenJob.findMany).toHaveBeenNthCalledWith(2, {
      where: expect.objectContaining({ source: "platform", kind: "IMAGE_TO_IMAGE", businessType: "IMAGE_CREATIVE", taskId: null,
        request: { path: "$.projectId", gt: 0 },
        items: { some: { status: "SUCCEEDED", deletedAt: null }, none: { status: { notIn: ["SUCCEEDED", "FAILED"] } } },
      }),
      select: { id: true },
    })
  })
})
