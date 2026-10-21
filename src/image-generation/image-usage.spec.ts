import { NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { InternalImageGenerationService } from "../image-project/internal-image-generation.service"
import { readImageUsage } from "./image-usage"
import { InternalImageToImageController } from "./internal-image-to-image.controller"

type UsageQuery = {
  where: { userId: number; AND: { OR: Prisma.UsageLogWhereInput[] }[] }
  _sum: { cost: true; credits: true }
}
type UsageTotals = { _sum: { cost: Prisma.Decimal | null; credits: Prisma.Decimal | null } }

function setup() {
  const prisma = {
    usageLog: {
      aggregate: jest.fn<Promise<UsageTotals>, [UsageQuery]>().mockResolvedValue({
        _sum: { cost: new Prisma.Decimal("2.345678"), credits: new Prisma.Decimal("23.4567") },
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ id: 7 }) },
    imageGenJob: { findFirst: jest.fn() },
    aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
    generationTask: { findFirst: jest.fn<Promise<unknown>, [{ where: { source: string } }]>() },
  }
  return prisma
}

describe("图片使用回执只读已有扣费流水", () => {
  it("通过业务任务关联多图扣费，同时限制用户和图片计费来源", async () => {
    const prisma = setup()
    expect(await readImageUsage(prisma as never, 7, { taskId: 4944 })).toEqual({
      costCny: "2.345678",
      creditsCharged: "23.4567",
    })
    expect(prisma.usageLog.aggregate).toHaveBeenCalledWith({
      where: {
        userId: 7,
        AND: [
          {
            OR: [
              { source: { startsWith: "aicreative.image_generate" } },
              { source: "aicreative.ai_split" },
            ],
          },
          {
            OR: [
              { meta: { path: "$.taskId", equals: 4944 } },
              { meta: { path: "$.taskId", equals: "4944" } },
            ],
          },
        ],
      },
      _sum: { cost: true, credits: true },
    })
  })

  it("一次 OR 聚合兼容旧网关流水，避免前缀误匹配及重复累加", async () => {
    const prisma = setup()
    await readImageUsage(prisma as never, 7, { taskId: 12, gatewayTaskId: "task_1" })
    const where = prisma.usageLog.aggregate.mock.calls[0][0].where
    expect(where.AND[1].OR).toContainEqual({ requestId: "gateway:task_1" })
    expect(where.AND[1].OR).toContainEqual({ requestId: { startsWith: "gateway:task_1:" } })
    expect(prisma.usageLog.aggregate).toHaveBeenCalledTimes(1)
  })

  it("批量改图按 jobId 找回归档前的多笔费用", async () => {
    const prisma = setup()
    await readImageUsage(prisma as never, 7, { jobId: "job-1" })
    expect(prisma.usageLog.aggregate.mock.calls[0][0].where.AND[1]).toEqual({
      OR: [{ meta: { path: "$.jobId", equals: "job-1" } }],
    })
  })

  it.each([null, "0"])("保留无记录与零费用的区别：%s", async value => {
    const prisma = setup()
    prisma.usageLog.aggregate.mockResolvedValue({
      _sum: {
        cost: value === null ? null : new Prisma.Decimal(value),
        credits: value === null ? null : new Prisma.Decimal(value),
      },
    })
    expect(await readImageUsage(prisma as never, 7, { taskId: 1 })).toEqual({
      costCny: value,
      creditsCharged: value,
    })
  })

  it("没有业务关联时不扫描或返回用户其他消费", async () => {
    const prisma = setup()
    expect(await readImageUsage(prisma as never, 7, {})).toEqual({
      costCny: null,
      creditsCharged: null,
    })
    expect(prisma.usageLog.aggregate).not.toHaveBeenCalled()
  })

  it("通用任务没有单个 gatewayTaskId 时仍回填；归档行同时用 sourceJobId 关联", async () => {
    const prisma = setup()
    prisma.generationTask.findFirst.mockResolvedValue({
      id: 4944,
      userId: 7,
      status: "SUCCESS",
      sourceJobId: "job-1",
      gatewayTaskId: null,
      generatedImages: [],
      errorMessage: null,
      aiSplitStage: null,
      model: "旧模型别名",
      executionSpec: { modelPublicId: "ZQ-Image-2" },
    })
    prisma.aiGatewayModel.findMany.mockResolvedValue([{ publicId: "ZQ-Image-2", displayName: "图像编辑模型" }])
    const service = new InternalImageGenerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    )
    expect(await service.getImageTask(4944)).toMatchObject({
      displayName: "图像编辑模型",
      costCny: "2.345678",
      creditsCharged: "23.4567",
    })
    expect(prisma.usageLog.aggregate.mock.calls[0][0].where.AND[1].OR).toContainEqual({
      meta: { path: "$.jobId", equals: "job-1" },
    })
    expect(prisma.generationTask.findFirst.mock.calls[0][0].where.source).toBe("vidflowos")
    expect(prisma.aiGatewayModel.findMany).toHaveBeenCalledWith({
      where: { publicId: { in: ["ZQ-Image-2"] } },
      select: { publicId: true, displayName: true }, orderBy: { id: "asc" },
    })
  })

  it("旧改图 Job 使用回执返回展示名，不依赖产物查询有效期", async () => {
    const prisma = setup()
    prisma.imageGenJob.findFirst.mockResolvedValue({
      id: "job-1", model: "ZQ-Image-3", status: "COMPLETED", expiresAt: new Date(0),
      items: [{ status: "SUCCEEDED", url: "https://cdn/result.png" }],
    })
    prisma.aiGatewayModel.findMany.mockResolvedValue([{ publicId: "ZQ-Image-3", displayName: "图像生成模型" }])
    const controller = new InternalImageToImageController(prisma as never, {} as never)
    await expect(controller.getUsage("job-1", "test-phone")).resolves.toMatchObject({ displayName: "图像生成模型" })
  })

  it.each([
    {
      items: [{ status: "SUCCEEDED", url: "https://cdn/result.png" }, { status: "FAILED" }],
      expected: "SUCCESS",
    },
    { items: [{ status: "FAILED", errorMessage: "失败" }], expected: "FAILED" },
    { items: [{ status: "QUEUED" }], expected: "GENERATING" },
  ])("过期 job 仍可取使用回执，状态为 $expected", async ({ items, expected }) => {
    const prisma = setup()
    prisma.imageGenJob.findFirst.mockResolvedValue({
      id: "job-1",
      status: "RUNNING",
      expiresAt: new Date(0),
      items,
    })
    const controller = new InternalImageToImageController(prisma as never, {} as never)
    expect(await controller.getUsage("job-1", "test-phone")).toMatchObject({
      status: expected,
      costCny: "2.345678",
      creditsCharged: "23.4567",
    })
    expect(prisma.imageGenJob.findFirst).toHaveBeenCalledWith({
      where: { id: "job-1", userId: 7, source: "vidflowos", kind: "IMAGE_TO_IMAGE" },
      include: { items: { orderBy: { idx: "asc" } } },
    })
  })

  it("改图回执拒绝不存在、非本人或其他来源 job，不查流水", async () => {
    const prisma = setup()
    prisma.imageGenJob.findFirst.mockResolvedValue(null)
    const controller = new InternalImageToImageController(prisma as never, {} as never)
    await expect(controller.getUsage("other-job", "test-phone")).rejects.toBeInstanceOf(
      NotFoundException
    )
    expect(prisma.usageLog.aggregate).not.toHaveBeenCalled()
  })
})
