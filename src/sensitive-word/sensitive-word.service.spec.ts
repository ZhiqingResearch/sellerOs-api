import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { Prisma, SensitiveWordRiskLevel, SensitiveWordSource } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { SensitiveWordService } from "./sensitive-word.service"

describe("SensitiveWordService", () => {
  let service: SensitiveWordService
  let prisma: {
    sensitiveWord: {
      create: jest.Mock
      findMany: jest.Mock
      findUnique: jest.Mock
      update: jest.Mock
      delete: jest.Mock
      deleteMany: jest.Mock
      count: jest.Mock
      groupBy: jest.Mock
    }
    user: {
      findMany: jest.Mock
    }
  }

  const baseDto = {
    word: ["FDA approved"],
    platform: "amazon",
    category: ["保健品", "美容"],
    riskLevel: SensitiveWordRiskLevel.HIGH,
    suggestion: "可替代",
  }

  const userInclude = { user: { select: { id: true, username: true } } }

  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    })

  beforeEach(async () => {
    prisma = {
      sensitiveWord: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
        count: jest.fn(),
        groupBy: jest.fn(),
      },
      user: {
        findMany: jest.fn(),
      },
    }

    const module = await Test.createTestingModule({
      providers: [SensitiveWordService, { provide: PrismaService, useValue: prisma }],
    }).compile()

    service = module.get(SensitiveWordService)
  })

  describe("create", () => {
    it("单条创建：word 长度为 1 的数组 → created 1 条, conflicts 空", async () => {
      const created = { id: 1, ...baseDto, source: SensitiveWordSource.MANUAL, userId: 7 }
      prisma.sensitiveWord.create.mockResolvedValue(created)

      const result = await service.create(7, baseDto)

      expect(result).toEqual({ created: [created], conflicts: [] })
      const arg = prisma.sensitiveWord.create.mock.calls[0][0] as {
        data: Record<string, unknown>
        include: Record<string, unknown>
      }
      expect(arg.data).toMatchObject({
        word: "FDA approved",
        platform: "amazon",
        category: ["保健品", "美容"],
        source: SensitiveWordSource.MANUAL,
        userId: 7,
      })
      expect(arg.include).toEqual(userInclude)
    })

    it("DTO 带 source=LISTING_GENERATION → 按 DTO 入库，不再强写 MANUAL", async () => {
      prisma.sensitiveWord.create.mockResolvedValue({
        id: 2,
        ...baseDto,
        source: SensitiveWordSource.LISTING_GENERATION,
        userId: 7,
      })

      await service.create(7, { ...baseDto, source: SensitiveWordSource.LISTING_GENERATION })

      const arg = prisma.sensitiveWord.create.mock.calls[0][0] as {
        data: { source: SensitiveWordSource }
      }
      expect(arg.data.source).toBe(SensitiveWordSource.LISTING_GENERATION)
    })

    it("批量：word=['A','B','C'] → 3 条，全部成功", async () => {
      prisma.sensitiveWord.create
        .mockResolvedValueOnce({ id: 1, word: "A" })
        .mockResolvedValueOnce({ id: 2, word: "B" })
        .mockResolvedValueOnce({ id: 3, word: "C" })

      const result = await service.create(7, { ...baseDto, word: ["A", "B", "C"] })

      expect(result.created).toHaveLength(3)
      expect(result.conflicts).toEqual([])
      expect(prisma.sensitiveWord.create).toHaveBeenCalledTimes(3)
      const calls = prisma.sensitiveWord.create.mock.calls as Array<[{ data: { word: string } }]>
      expect(calls.map(c => c[0].data.word)).toEqual(["A", "B", "C"])
    })

    it("批量：[' A ', 'B', '', 'A', 'C'] → trim/去空/去重，按原顺序", async () => {
      prisma.sensitiveWord.create
        .mockResolvedValueOnce({ id: 1, word: "A" })
        .mockResolvedValueOnce({ id: 2, word: "B" })
        .mockResolvedValueOnce({ id: 3, word: "C" })

      await service.create(7, { ...baseDto, word: [" A ", "B", "", "A", "C"] })

      const calls = prisma.sensitiveWord.create.mock.calls as Array<[{ data: { word: string } }]>
      expect(calls.map(c => c[0].data.word)).toEqual(["A", "B", "C"])
    })

    it("批量部分冲突：B 已存在 → A、C 入库，conflicts=[B]，不抛", async () => {
      prisma.sensitiveWord.create
        .mockResolvedValueOnce({ id: 1, word: "A" })
        .mockRejectedValueOnce(p2002())
        .mockResolvedValueOnce({ id: 3, word: "C" })

      const result = await service.create(7, { ...baseDto, word: ["A", "B", "C"] })

      expect(result.created).toHaveLength(2)
      expect(result.conflicts).toEqual(["B"])
    })

    it("批量全部冲突 → 抛 409 + code + conflicts 列表", async () => {
      prisma.sensitiveWord.create.mockRejectedValue(p2002())

      await expect(service.create(7, { ...baseDto, word: ["A", "B"] })).rejects.toMatchObject({
        status: 409,
        response: { code: "SENSITIVE_WORD_EXISTS", conflicts: ["A", "B"] },
      })
    })

    it("数组里只有空白串（[' ', '']）→ 抛 400", async () => {
      await expect(service.create(7, { ...baseDto, word: [" ", ""] })).rejects.toThrow(
        BadRequestException
      )
    })

    it("非 P2002 错误原样抛出（不进 conflicts）", async () => {
      prisma.sensitiveWord.create.mockRejectedValue(new Error("DB down"))
      await expect(service.create(7, baseDto)).rejects.toThrow("DB down")
    })
  })

  describe("createFromSystem", () => {
    it("source 由调用方传入（如 AI_DETECTION）", async () => {
      prisma.sensitiveWord.create.mockResolvedValue({ id: 9, ...baseDto, userId: 7 })

      await service.createFromSystem(7, baseDto, SensitiveWordSource.AI_DETECTION)

      const arg = prisma.sensitiveWord.create.mock.calls[0][0] as {
        data: { source: SensitiveWordSource }
      }
      expect(arg.data.source).toBe(SensitiveWordSource.AI_DETECTION)
    })

    it("系统来源全部冲突也抛 409（由调用方决定是否吞掉）", async () => {
      prisma.sensitiveWord.create.mockRejectedValue(p2002())
      await expect(
        service.createFromSystem(7, baseDto, SensitiveWordSource.AI_DETECTION)
      ).rejects.toThrow(ConflictException)
    })

    it("userId=null + source=AI_DETECTION → 允许入库（userId 写 null）", async () => {
      prisma.sensitiveWord.create.mockResolvedValue({ id: 99, ...baseDto, userId: null })

      const result = await service.createFromSystem(null, baseDto, SensitiveWordSource.AI_DETECTION)

      expect(result.created).toHaveLength(1)
      const arg = prisma.sensitiveWord.create.mock.calls[0][0] as {
        data: { userId: number | null; source: SensitiveWordSource }
      }
      expect(arg.data.userId).toBeNull()
      expect(arg.data.source).toBe(SensitiveWordSource.AI_DETECTION)
    })

    it("userId=null + source=MANUAL → 抛 400（仅 AI_DETECTION 可无创建人）", async () => {
      await expect(
        service.createFromSystem(null, baseDto, SensitiveWordSource.MANUAL)
      ).rejects.toThrow(BadRequestException)
    })

    it("userId=null + source=LISTING_GENERATION → 抛 400", async () => {
      await expect(
        service.createFromSystem(null, baseDto, SensitiveWordSource.LISTING_GENERATION)
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe("findAll", () => {
    it("五维筛选 + 分页：category 走 array_contains", async () => {
      prisma.sensitiveWord.findMany.mockResolvedValue([])
      prisma.sensitiveWord.count.mockResolvedValue(0)

      await service.findAll({
        page: 2,
        pageSize: 20,
        platform: "amazon",
        category: "保健品",
        word: "FDA",
        source: SensitiveWordSource.MANUAL,
        userId: 7,
      })

      const arg = prisma.sensitiveWord.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>
        skip: number
        take: number
        include: Record<string, unknown>
      }
      expect(arg.where).toMatchObject({
        platform: "amazon",
        category: { array_contains: "保健品" },
        word: { contains: "FDA" },
        source: SensitiveWordSource.MANUAL,
        userId: 7,
      })
      expect(arg.skip).toBe(20)
      expect(arg.take).toBe(20)
      expect(arg.include).toEqual(userInclude)
    })

    it("无筛选 → where 为空对象", async () => {
      prisma.sensitiveWord.findMany.mockResolvedValue([])
      prisma.sensitiveWord.count.mockResolvedValue(0)

      await service.findAll({ page: 1, pageSize: 10 })

      const arg = prisma.sensitiveWord.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>
      }
      expect(arg.where).toEqual({})
    })

    it("totalPages 计算正确", async () => {
      prisma.sensitiveWord.findMany.mockResolvedValue([])
      prisma.sensitiveWord.count.mockResolvedValue(25)

      const result = await service.findAll({ page: 1, pageSize: 10 })
      expect(result.totalPages).toBe(3)
    })
  })

  describe("stats", () => {
    it("一次返回 platforms[{key,count,categories[]}]，平台/分类均按 count 降序", async () => {
      prisma.sensitiveWord.count.mockResolvedValue(5)
      prisma.sensitiveWord.findMany.mockResolvedValueOnce([
        { platform: "amazon", category: ["保健品", "美容"] },
        { platform: "amazon", category: ["保健品"] },
        { platform: "amazon", category: ["母婴", "保健品"] },
        { platform: "walmart", category: ["保健品"] },
        { platform: "walmart", category: ["食品"] },
      ])

      const result = await service.stats()

      expect(result.total).toBe(5)
      // amazon 3 行（保健品 ×3、美容 ×1、母婴 ×1）；walmart 2 行（保健品 ×1、食品 ×1）
      expect(result.platforms).toEqual([
        {
          key: "amazon",
          count: 3,
          categories: [
            { key: "保健品", count: 3 },
            { key: "美容", count: 1 },
            { key: "母婴", count: 1 },
          ],
        },
        {
          key: "walmart",
          count: 2,
          categories: [
            { key: "保健品", count: 1 },
            { key: "食品", count: 1 },
          ],
        },
      ])
      // findMany 必须只 select platform + category（不要拉全字段，省 IO）
      const findManyArg = prisma.sensitiveWord.findMany.mock.calls[0][0] as {
        select: Record<string, true>
        where: object
      }
      expect(findManyArg.select).toEqual({ platform: true, category: true })
      expect(findManyArg.where).toEqual({})
    })

    it("空库：total=0 且 platforms=[]", async () => {
      prisma.sensitiveWord.count.mockResolvedValue(0)
      prisma.sensitiveWord.findMany.mockResolvedValueOnce([])

      const result = await service.stats()
      expect(result).toEqual({ total: 0, platforms: [] })
    })

    it("source 过滤：count + findMany 都注入 where.source", async () => {
      prisma.sensitiveWord.count.mockResolvedValue(0)
      prisma.sensitiveWord.findMany.mockResolvedValueOnce([])

      await service.stats({ source: SensitiveWordSource.AI_DETECTION })

      expect(prisma.sensitiveWord.count).toHaveBeenCalledWith({
        where: { source: SensitiveWordSource.AI_DETECTION },
      })
      const findManyArg = prisma.sensitiveWord.findMany.mock.calls[0][0] as { where: object }
      expect(findManyArg.where).toEqual({ source: SensitiveWordSource.AI_DETECTION })
    })

    it("userId 过滤：count + findMany 都注入 where.userId", async () => {
      prisma.sensitiveWord.count.mockResolvedValue(0)
      prisma.sensitiveWord.findMany.mockResolvedValueOnce([])

      await service.stats({ userId: 7 })

      expect(prisma.sensitiveWord.count).toHaveBeenCalledWith({ where: { userId: 7 } })
      const findManyArg = prisma.sensitiveWord.findMany.mock.calls[0][0] as { where: object }
      expect(findManyArg.where).toEqual({ userId: 7 })
    })
  })

  describe("update", () => {
    it("仅传入字段会被设置（partial）", async () => {
      prisma.sensitiveWord.findUnique.mockResolvedValue({
        id: 1,
        platform: "amazon",
        word: "old",
      })
      const updated = { id: 1, platform: "amazon", word: "old", category: ["新分类"] }
      prisma.sensitiveWord.update.mockResolvedValue(updated)

      const result = await service.update(1, { category: ["新分类"] })

      expect(result).toEqual(updated)
      const arg = prisma.sensitiveWord.update.mock.calls[0][0] as {
        data: Record<string, unknown>
      }
      expect(arg.data).toEqual({ category: ["新分类"] })
    })

    it("id 不存在 → 抛 NotFoundException", async () => {
      prisma.sensitiveWord.findUnique.mockResolvedValue(null)
      await expect(service.update(999, { category: ["x"] })).rejects.toThrow(NotFoundException)
    })

    it("update 撞 DB 已存在 → 抛 409 + code", async () => {
      prisma.sensitiveWord.findUnique.mockResolvedValue({
        id: 1,
        platform: "amazon",
        word: "old",
      })
      prisma.sensitiveWord.update.mockRejectedValue(p2002())

      await expect(service.update(1, { word: "FDA approved" })).rejects.toMatchObject({
        status: 409,
        response: { code: "SENSITIVE_WORD_EXISTS" },
      })
    })

    it("update 非 P2002 错误原样抛出", async () => {
      prisma.sensitiveWord.findUnique.mockResolvedValue({ id: 1, platform: "amazon", word: "old" })
      prisma.sensitiveWord.update.mockRejectedValue(new Error("DB down"))
      await expect(service.update(1, { category: ["x"] })).rejects.toThrow("DB down")
    })
  })

  describe("removeMany (bulk physical delete)", () => {
    it("单条删除：deleted=1, missing=[]", async () => {
      prisma.sensitiveWord.findMany.mockResolvedValue([{ id: 1 }])
      prisma.sensitiveWord.deleteMany = jest.fn().mockResolvedValue({ count: 1 })

      const result = await service.removeMany([1])

      expect(result).toEqual({ deleted: 1, requested: 1, missing: [] })
      expect(prisma.sensitiveWord.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1] } } })
    })

    it("批量删除：3 个都存在 → deleted=3, missing=[]", async () => {
      prisma.sensitiveWord.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }])
      prisma.sensitiveWord.deleteMany = jest.fn().mockResolvedValue({ count: 3 })

      const result = await service.removeMany([1, 2, 3])

      expect(result).toEqual({ deleted: 3, requested: 3, missing: [] })
    })

    it("部分不存在：deleted 不算 missing", async () => {
      prisma.sensitiveWord.findMany.mockResolvedValue([{ id: 1 }, { id: 3 }])
      prisma.sensitiveWord.deleteMany = jest.fn().mockResolvedValue({ count: 2 })

      const result = await service.removeMany([1, 2, 3])

      expect(result).toEqual({ deleted: 2, requested: 3, missing: [2] })
      const arg = prisma.sensitiveWord.deleteMany.mock.calls[0][0] as {
        where: { id: { in: number[] } }
      }
      expect(arg.where.id.in.sort()).toEqual([1, 3])
    })

    it("全部不存在：deleted=0, missing 列出所有 id，不抛异常", async () => {
      prisma.sensitiveWord.findMany.mockResolvedValue([])
      prisma.sensitiveWord.deleteMany = jest.fn()

      const result = await service.removeMany([999, 1000])

      expect(result).toEqual({ deleted: 0, requested: 2, missing: [999, 1000] })
      expect(prisma.sensitiveWord.deleteMany).not.toHaveBeenCalled()
    })
  })

  describe("findUsersWithSensitiveWords", () => {
    it("返回有敏感词的用户列表（仅 id + username，按 username 升序）", async () => {
      const users = [
        { id: 3, username: "李四" },
        { id: 1, username: "张三" },
      ]
      prisma.user.findMany.mockResolvedValue(users)

      const result = await service.findUsersWithSensitiveWords()

      expect(result).toEqual(users)
      const arg = prisma.user.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>
        select: Record<string, unknown>
        orderBy: Record<string, unknown>
      }
      expect(arg.where).toEqual({ sensitiveWords: { some: {} } })
      expect(arg.select).toEqual({ id: true, username: true })
      expect(arg.orderBy).toEqual({ username: "asc" })
    })
  })

  describe("findById", () => {
    it("命中 → 返回记录", async () => {
      const record = { id: 1, ...baseDto, source: SensitiveWordSource.MANUAL, userId: 7 }
      prisma.sensitiveWord.findUnique.mockResolvedValue(record)

      const result = await service.findById(1)
      expect(result).toEqual(record)
    })

    it("未命中 → 抛 NotFoundException", async () => {
      prisma.sensitiveWord.findUnique.mockResolvedValue(null)
      await expect(service.findById(999)).rejects.toThrow(NotFoundException)
    })
  })
})
