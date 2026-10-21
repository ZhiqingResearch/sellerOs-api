import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { HistoryService } from "./history.service"

describe("Listing 记录补充与费用汇总", () => {
  it("列表批量关联账单，不逐条查询，且不加载原始模型正文", async () => {
    const updatedAt = new Date()
    const prisma = {
      listingRun: { findMany: jest.fn().mockResolvedValue([]) },
      history: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 1,
            listingRun: { runId: "run-1", updatedAt, steps: [{ id: 11, usageLogId: 101 }] },
          },
          {
            id: 2,
            listingRun: { runId: "run-2", updatedAt, steps: [{ id: 12, usageLogId: 102 }] },
          },
          { id: 3, type: "PRODUCT_SCORING", listingRun: null },
        ]),
        count: jest.fn().mockResolvedValue(3),
      },
      usageLog: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            { id: 101, credits: new Prisma.Decimal(33) },
            { id: 102, credits: new Prisma.Decimal(10) },
          ])
          .mockResolvedValueOnce([]),
      },
    }
    const result = await new HistoryService(prisma as unknown as PrismaService).findByUser(3, {
      page: 1,
      pageSize: 10,
    })
    expect(result.items[0].listingSteps![0].credits).toEqual(new Prisma.Decimal(33))
    expect(result.items[1].listingSteps![0].credits).toEqual(new Prisma.Decimal(10))
    expect(result.items[2]).toEqual({ id: 3, type: "PRODUCT_SCORING" })
    expect(prisma.usageLog.findMany).toHaveBeenCalledTimes(2)
    expect(prisma.usageLog.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: { in: [101, 102] },
        userId: 3,
        source: { in: ["listing.generate", "listing.score"] },
      },
      select: { id: true, credits: true },
    })
    expect(
      prisma.history.findMany.mock.calls[0][0].select.listingRun.include.steps.select
    ).not.toHaveProperty("outputText")
  })

  it("轮询从独立任务读取状态，不加载正文或扫描账单；保留旧接口字段", async () => {
    const updatedAt = new Date()
    const prisma = {
      history: {
        findFirst: jest.fn().mockResolvedValue({
          id: 1,
          data: { plans: [] },
          updatedAt: new Date(0),
          listingRun: {
            runId: "run-1",
            status: "RUNNING",
            stage: "generation",
            error: null,
            attempts: { "0": { attemptId: "a" } },
            updatedAt,
          },
        }),
      },
      usageLog: { findMany: jest.fn() },
    }
    const result = await new HistoryService(prisma as unknown as PrismaService).findByRunId(
      "run-1",
      3
    )
    expect(result).toMatchObject({
      id: 1,
      listingRunId: "run-1",
      listingStatus: "RUNNING",
      listingStage: "generation",
      listingAttempts: { "0": { attemptId: "a" } },
      updatedAt,
    })
    expect(result).not.toHaveProperty("listingRun")
    expect(prisma.history.findFirst).toHaveBeenCalledWith({
      where: { userId: 3, listingRun: { runId: "run-1" } },
      include: { listingRun: true },
    })
    expect(prisma.usageLog.findMany).not.toHaveBeenCalled()
  })

  it("按实际账单补充 MCP 消耗，并限制用户和 runId", async () => {
    const prisma = {
      history: {
        findFirst: jest.fn().mockResolvedValue({
          id: 1,
          listingRun: {
            runId: "run-1",
            status: "COMPLETED",
            updatedAt: new Date(),
            steps: [{ id: 1, usageLogId: 10 }],
          },
        }),
      },
      usageLog: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 10, credits: new Prisma.Decimal(33) }])
          .mockResolvedValueOnce([
            {
              id: 9,
              credits: new Prisma.Decimal(2),
              createdAt: new Date(),
              requestId: null,
              meta: { listingRunId: "run-1" },
            },
          ]),
      },
    }
    const history = new HistoryService(prisma as unknown as PrismaService)
    const record = await history.findById(1, 3)
    expect(record.listingSteps).toHaveLength(2)
    expect(record.listingSteps![0].credits).toEqual(new Prisma.Decimal(33))
    expect(record.listingSteps![1]).toMatchObject({
      id: -9,
      operation: "mcp",
      credits: new Prisma.Decimal(2),
    })
    expect(prisma.usageLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 3,
          source: "listing.generate",
          type: "MCP",
          OR: [{ meta: { path: "$.listingRunId", equals: "run-1" } }],
        },
      })
    )
  })

  it("浏览器仅补充 B 方案评分时不覆盖 A，也不改变生成尝试状态", async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
      history: {
        findFirst: jest.fn().mockResolvedValue({
          id: 1,
          listingRun: { id: 11 },
          data: { plans: [{ result: { title: "A" }, planIndex: 0 }] },
        }),
        update: jest.fn().mockResolvedValue({ id: 1, version: 3 }),
      },
      historyRevision: { count: jest.fn().mockResolvedValue(1), create: jest.fn() },
    }
    const prisma = { $transaction: jest.fn(fn => fn(tx)) }
    await new HistoryService(prisma as unknown as PrismaService).update(1, 3, {
      data: { plans: [{ planIndex: 1, result: { title: "B" }, score: 85 }] },
    })
    const update = tx.history.update.mock.calls[0][0].data
    expect(update.data.plans).toEqual([
      { result: { title: "A" }, planIndex: 0 },
      { planIndex: 1, result: { title: "B" }, score: 85 },
    ])
    expect(update).not.toHaveProperty("listingAttempts")
  })
})
