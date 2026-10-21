import { BadRequestException, NotFoundException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { HistoryType } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { HistoryService } from "./history.service"

describe("HistoryService", () => {
  let historyService: HistoryService
  let prisma: {
    listingRun: { findMany: jest.Mock }
    usageLog: { findMany: jest.Mock }
    history: {
      findMany: jest.Mock
      findFirst: jest.Mock
      count: jest.Mock
      create: jest.Mock
      update: jest.Mock
    }
    historyRevision: {
      count: jest.Mock
      create: jest.Mock
    }
    $transaction: jest.Mock
    $queryRaw: jest.Mock
  }

  beforeEach(async () => {
    prisma = {
      listingRun: { findMany: jest.fn().mockResolvedValue([]) },
      usageLog: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
      history: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      historyRevision: {
        count: jest.fn(),
        create: jest.fn(),
      },
      // 事务回调直接复用同一个 prisma mock 作为 tx
      $transaction: jest.fn((cb: (tx: typeof prisma) => unknown) => cb(prisma)),
    }

    const module = await Test.createTestingModule({
      providers: [HistoryService, { provide: PrismaService, useValue: prisma }],
    }).compile()

    historyService = module.get(HistoryService)
  })

  describe("findByUser", () => {
    it("hides empty failed/interrupted Listing tasks before pagination and count", async () => {
      prisma.listingRun.findMany.mockResolvedValue([
        { runId: "failed", historyId: 342, history: { data: { plans: [] } } },
        { runId: "interrupted", historyId: 347, history: { data: { plans: [] } } },
      ])
      prisma.history.findMany.mockResolvedValue([])
      prisma.history.count.mockResolvedValue(0)

      const result = await historyService.findByUser(3, { page: 1, pageSize: 10 })

      const where = { userId: 3, id: { notIn: [342, 347] } }
      expect(prisma.history.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 0, take: 10 }))
      expect(prisma.history.count).toHaveBeenCalledWith({ where })
      expect(result.total).toBe(0)
      expect(prisma.listingRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          history: { userId: 3, type: "LISTING_GENERATION", score: null },
          steps: { none: {
            operation: { in: ["generation", "optimization"] },
            outputText: { not: null },
            NOT: { outputText: "" },
          } },
        },
      }))
    })

    it("preserves saved reports and MCP charges linked with either workflow key", async () => {
      prisma.listingRun.findMany.mockResolvedValue([
        { runId: "old-mcp", historyId: 1, history: { data: { plans: [] } } },
        { runId: "new-mcp", historyId: 2, history: { data: { plans: [] } } },
        { runId: "saved-plan", historyId: 3, history: { data: { plans: [null, { result: { title: "Saved" } }] } } },
        { runId: "saved-result", historyId: 4, history: { data: { result: { title: "Saved" } } } },
        { runId: "empty", historyId: 5, history: { data: { plans: [null] } } },
      ])
      prisma.usageLog.findMany.mockResolvedValue([
        { meta: { listingRunId: "old-mcp" } },
        { meta: { businessEventId: "new-mcp" } },
      ])
      prisma.history.findMany.mockResolvedValue([])
      prisma.history.count.mockResolvedValue(4)

      await historyService.findByUser(3, { page: 1, pageSize: 10 })

      expect(prisma.history.count).toHaveBeenCalledWith({ where: { userId: 3, id: { notIn: [5] } } })
      expect(prisma.usageLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 3 }) }))
    })

    it("隐藏无扣费的准备记录，保留实际扣费及可恢复的生成内容", async () => {
      prisma.listingRun.findMany.mockResolvedValue([
        { runId: "attributes", historyId: 1, history: { data: { plans: [] } }, steps: [{ usageLogId: 101 }] },
        { runId: "category", historyId: 2, history: { data: { plans: [] } }, steps: [] },
        { runId: "charged", historyId: 3, history: { data: { plans: [] } }, steps: [{ usageLogId: 103 }] },
        { runId: "partial", historyId: 4, history: { data: { plans: [{ partialText: "可恢复的正文" }] } }, steps: [] },
        { runId: "blank", historyId: 5, history: { data: { plans: [{ partialText: "  " }] } }, steps: [] },
      ])
      // 数据库只返回 credits > 0 的实际消费；零积分日志 101 不属于扣费。
      prisma.usageLog.findMany.mockResolvedValue([{ id: 103, meta: null }])
      prisma.history.findMany.mockResolvedValue([])
      prisma.history.count.mockResolvedValue(2)

      const result = await historyService.findByUser(3, { page: 1, pageSize: 10 })

      const where = { userId: 3, id: { notIn: [1, 2, 5] } }
      expect(prisma.history.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }))
      expect(prisma.history.count).toHaveBeenCalledWith({ where })
      expect(result.total).toBe(2)
      expect(prisma.usageLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          userId: 3,
          credits: { gt: 0 },
          OR: expect.arrayContaining([{ id: { in: [101, 103] } }]),
        }),
      }))
    })

    it("should return paginated results", async () => {
      const mockItems = [
        {
          id: 1,
          type: "PRODUCT_SCORING",
          title: "test",
          score: 88.5,
          version: 1,
          createdAt: new Date(),
        },
      ]
      prisma.history.findMany.mockResolvedValue(mockItems)
      prisma.history.count.mockResolvedValue(1)

      const result = await historyService.findByUser(1, { page: 1, pageSize: 10 })

      expect(result).toEqual({
        items: mockItems,
        total: 1,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      })
      expect(prisma.history.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 10 })
      )
    })

    it("should calculate skip correctly for page 2", async () => {
      prisma.history.findMany.mockResolvedValue([])
      prisma.history.count.mockResolvedValue(15)

      const result = await historyService.findByUser(1, { page: 2, pageSize: 10 })

      expect(result.totalPages).toBe(2)
      expect(prisma.history.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 })
      )
    })
  })

  describe("findById", () => {
    it("should return record when found", async () => {
      const mockRecord = { id: 1, title: "test", type: "PRODUCT_SCORING", data: {}, userId: 1 }
      prisma.history.findFirst.mockResolvedValue(mockRecord)

      const result = await historyService.findById(1, 1)

      expect(result).toEqual(mockRecord)
    })

    it("should throw NotFoundException when not found", async () => {
      prisma.history.findFirst.mockResolvedValue(null)

      await expect(historyService.findById(999, 1)).rejects.toThrow(NotFoundException)
    })

    it("should not return other user's record", async () => {
      prisma.history.findFirst.mockResolvedValue(null)

      await expect(historyService.findById(1, 999)).rejects.toThrow(NotFoundException)
      expect(prisma.history.findFirst).toHaveBeenCalledWith({
        where: { id: 1, userId: 999 },
        include: { listingRun: { include: { steps: { orderBy: { id: "asc" } } } } },
      })
    })
  })

  describe("create", () => {
    it("should create a history record with first revision (v1)", async () => {
      const dto = {
        title: "测试",
        type: HistoryType.PRODUCT_SCORING,
        score: 85,
        data: { query: "test" },
      }
      const mockRecord = { id: 1, ...dto, version: 1, userId: 1 }
      prisma.history.create.mockResolvedValue(mockRecord)

      const result = await historyService.create(1, dto)

      expect(result).toEqual(mockRecord)
      expect(prisma.history.create).toHaveBeenCalledWith({
        data: {
          title: "测试",
          type: HistoryType.PRODUCT_SCORING,
          score: 85,
          data: { query: "test" },
          userId: 1,
          version: 1,
          revisions: { create: { version: 1, data: { query: "test" } } },
        },
      })
    })
  })

  describe("update", () => {
    it("按合并后的A/B方案同步列表最高分，忽略前端局部快照的低分", async () => {
      prisma.history.findFirst.mockResolvedValue({
        id: 1, userId: 1, type: "LISTING_GENERATION", version: 3, listingRun: { id: 11 },
        data: { plans: [{ result: { title: "A" }, scoreResult: { total: 95 }, planIndex: 0 }] },
      })
      prisma.historyRevision.count.mockResolvedValue(1)
      prisma.history.update.mockResolvedValue({ id: 1, version: 4 })
      await historyService.update(1, 1, { score: 80, data: { plans: [
        { result: { title: "B" }, scoreResult: { total: 80 }, planIndex: 1 },
      ] } })
      expect(prisma.history.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ score: 95 }),
      }))
    })

    it("旧记录仅补充评分报告也同步列表分数，暂未评分时清空旧分", async () => {
      prisma.history.findFirst.mockResolvedValue({
        id: 1, userId: 1, type: "LISTING_GENERATION", score: null, version: 1, data: {},
      })
      prisma.historyRevision.count.mockResolvedValue(1)
      prisma.history.update.mockResolvedValue({ id: 1, version: 2 })
      for (const total of [94.5, null]) {
        await historyService.update(1, 1, { data: { plans: [{ result: {}, score: 94.5, scoreResult: { total } }] } })
        expect(prisma.history.update).toHaveBeenLastCalledWith(expect.objectContaining({
          data: expect.objectContaining({ score: total }),
        }))
      }
    })

    it("should throw BadRequest when no field provided", async () => {
      await expect(historyService.update(1, 1, {})).rejects.toThrow(BadRequestException)
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it("should throw NotFound when record not owned", async () => {
      prisma.history.findFirst.mockResolvedValue(null)

      await expect(historyService.update(1, 999, { title: "x" })).rejects.toThrow(NotFoundException)
    })

    it("should NOT create a revision when only title changes", async () => {
      prisma.history.findFirst.mockResolvedValue({ id: 1, userId: 1, data: { a: 1 }, version: 1 })
      prisma.history.update.mockResolvedValue({ id: 1, title: "改名", version: 1 })

      await historyService.update(1, 1, { title: "改名" })

      expect(prisma.historyRevision.create).not.toHaveBeenCalled()
      expect(prisma.$queryRaw).not.toHaveBeenCalled()
      expect(prisma.history.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { title: "改名" },
      })
    })

    it("should create a new revision when data is provided", async () => {
      prisma.history.findFirst.mockResolvedValue({ id: 1, userId: 1, data: { a: 1 }, version: 1 })
      prisma.historyRevision.count.mockResolvedValue(1) // 已有 v1
      prisma.history.update.mockResolvedValue({ id: 1, version: 2, data: { a: 2 } })

      await historyService.update(1, 1, { data: { a: 2 } })

      expect(prisma.history.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { version: { increment: 1 }, data: { a: 2 } },
      })
      expect(prisma.historyRevision.create).toHaveBeenCalledWith({
        data: { historyId: 1, version: 2, data: { a: 2 } },
      })
    })

    it("should lazily backfill v1 for legacy records on first data edit", async () => {
      prisma.history.findFirst.mockResolvedValue({
        id: 1,
        userId: 1,
        data: { old: true },
        version: 1,
      })
      prisma.historyRevision.count.mockResolvedValue(0) // 遗留记录，从未留档
      prisma.history.update.mockResolvedValue({ id: 1, version: 2, data: { new: true } })

      await historyService.update(1, 1, { data: { new: true } })

      // 先补 v1（旧数据），再写 v2（新数据）
      expect(prisma.historyRevision.create).toHaveBeenNthCalledWith(1, {
        data: { historyId: 1, version: 1, data: { old: true } },
      })
      expect(prisma.historyRevision.create).toHaveBeenNthCalledWith(2, {
        data: { historyId: 1, version: 2, data: { new: true } },
      })
    })

    it("should NOT create a revision when data is null", async () => {
      prisma.history.findFirst.mockResolvedValue({ id: 1, userId: 1, data: { a: 1 }, version: 1 })
      prisma.history.update.mockResolvedValue({ id: 1, score: 90, version: 1 })

      await historyService.update(1, 1, { score: 90, data: null } as never)

      expect(prisma.historyRevision.create).not.toHaveBeenCalled()
    })
  })
})
