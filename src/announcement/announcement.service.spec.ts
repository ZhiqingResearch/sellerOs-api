import { BadRequestException, NotFoundException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { PrismaService } from "../prisma/prisma.service"
import { AnnouncementService } from "./announcement.service"

describe("AnnouncementService", () => {
  let service: AnnouncementService
  let prisma: {
    announcement: {
      create: jest.Mock
      findFirst: jest.Mock
      findMany: jest.Mock
      findUnique: jest.Mock
      update: jest.Mock
      count: jest.Mock
    }
  }

  const createdBySelect = { createdBy: { select: { id: true, username: true } } }

  beforeEach(async () => {
    prisma = {
      announcement: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
    }

    const module = await Test.createTestingModule({
      providers: [AnnouncementService, { provide: PrismaService, useValue: prisma }],
    }).compile()

    service = module.get(AnnouncementService)
  })

  describe("create", () => {
    const dto = {
      startAt: "2026-09-18T00:00:00.000Z",
      endAt: "2026-09-20T00:00:00.000Z",
      content: "维护通知",
    }

    // 固定当前时间注入，避免用例依赖真实时钟
    const NOW = new Date("2026-09-15T00:00:00.000Z")

    it("开始时间不早于结束时间 → 400，且不触库", async () => {
      await expect(service.create(7, { ...dto, endAt: dto.startAt })).rejects.toThrow(
        new BadRequestException("开始时间必须早于结束时间")
      )

      expect(prisma.announcement.findFirst).not.toHaveBeenCalled()
      expect(prisma.announcement.create).not.toHaveBeenCalled()
    })

    it("时间格式无效 → 400", async () => {
      await expect(service.create(7, { ...dto, startAt: "not-a-date" })).rejects.toThrow(
        new BadRequestException("时间格式无效")
      )
    })

    it("结束时间早于或等于当前时间 → 400，且不触库", async () => {
      const expired = { startAt: "2026-09-13T00:00:00.000Z", content: "x" }

      await expect(
        service.create(7, { ...expired, endAt: "2026-09-14T00:00:00.000Z" }, NOW)
      ).rejects.toThrow(new BadRequestException("公告结束时间必须晚于当前时间"))
      await expect(
        service.create(7, { ...expired, endAt: NOW.toISOString() }, NOW)
      ).rejects.toThrow(new BadRequestException("公告结束时间必须晚于当前时间"))

      expect(prisma.announcement.findFirst).not.toHaveBeenCalled()
      expect(prisma.announcement.create).not.toHaveBeenCalled()
    })

    it("与已有公告重叠 → 400，消息按东八区展示冲突公告时间段", async () => {
      prisma.announcement.findFirst.mockResolvedValue({
        id: 1,
        startAt: new Date("2026-09-17T00:00:00.000Z"),
        endAt: new Date("2026-09-19T00:00:00.000Z"),
      })

      await expect(service.create(7, dto, NOW)).rejects.toThrow(
        new BadRequestException(
          "公告时间段与已有公告重叠：已有公告时间 2026-09-17 08:00 ～ 2026-09-19 08:00"
        )
      )
      expect(prisma.announcement.create).not.toHaveBeenCalled()
    })

    it("重叠提示跨日正确转换：UTC 20:00 → 东八区次日 04:00", async () => {
      prisma.announcement.findFirst.mockResolvedValue({
        id: 1,
        startAt: new Date("2026-09-17T20:00:00.000Z"),
        endAt: new Date("2026-09-18T02:00:00.000Z"),
      })

      await expect(service.create(7, dto, NOW)).rejects.toThrow(
        new BadRequestException(
          "公告时间段与已有公告重叠：已有公告时间 2026-09-18 04:00 ～ 2026-09-18 10:00"
        )
      )
    })

    it("重叠查询用严格不等且排除已过期公告（边界相接不算重叠）", async () => {
      prisma.announcement.findFirst.mockResolvedValue(null)
      prisma.announcement.create.mockResolvedValue({ id: 1, ...dto, createdById: 7 })

      await service.create(7, dto, NOW)

      const arg = (
        prisma.announcement.findFirst.mock.calls[0] as [
          { where: { AND: Array<Record<string, Record<string, Date>>> } },
        ]
      )[0]
      expect(arg.where).toEqual({
        AND: [
          { startAt: { lt: new Date(dto.endAt) }, endAt: { gt: new Date(dto.startAt) } },
          { endAt: { gt: NOW } },
        ],
      })
    })

    it("与已过期历史公告时间段重叠 → 不拦截，正常发布", async () => {
      // 过期公告被 endAt > now 排除在冲突查询外，findFirst 无命中 → 正常创建
      prisma.announcement.findFirst.mockResolvedValue(null)
      prisma.announcement.create.mockResolvedValue({ id: 1, ...dto, createdById: 7 })

      await expect(service.create(7, dto, NOW)).resolves.toEqual({ id: 1, ...dto, createdById: 7 })
    })

    it("创建成功：写入 Date 实例 + createdById，返回带创建人", async () => {
      const created = { id: 1, ...dto, createdById: 7, createdBy: { id: 7, username: "admin" } }
      prisma.announcement.findFirst.mockResolvedValue(null)
      prisma.announcement.create.mockResolvedValue(created)

      const result = await service.create(7, dto, NOW)

      expect(result).toEqual(created)
      const arg = (
        prisma.announcement.create.mock.calls[0] as [
          { data: Record<string, unknown>; include: Record<string, unknown> },
        ]
      )[0]
      expect(arg.data).toEqual({
        content: dto.content,
        startAt: new Date(dto.startAt),
        endAt: new Date(dto.endAt),
        createdById: 7,
      })
      expect(arg.include).toEqual(createdBySelect)
    })
  })

  describe("findAll", () => {
    it("按 createdAt 倒序分页，返回分页结构", async () => {
      const items = [{ id: 1, content: "x" }]
      prisma.announcement.findMany.mockResolvedValue(items)
      prisma.announcement.count.mockResolvedValue(25)

      const result = await service.findAll({ page: 2, pageSize: 10 })

      expect(result).toEqual({ items, total: 25, page: 2, pageSize: 10, totalPages: 3 })
      expect(prisma.announcement.findMany).toHaveBeenCalledWith({
        include: createdBySelect,
        orderBy: { createdAt: "desc" },
        skip: 10,
        take: 10,
      })
    })
  })

  describe("findActive", () => {
    it("查询闭区间内生效公告，按 createdAt 倒序", async () => {
      const now = new Date("2026-09-18T12:00:00.000Z")
      const items = [{ id: 1, content: "x" }]
      prisma.announcement.findMany.mockResolvedValue(items)

      const result = await service.findActive(now)

      expect(result).toEqual(items)
      expect(prisma.announcement.findMany).toHaveBeenCalledWith({
        where: { startAt: { lte: now }, endAt: { gte: now } },
        include: createdBySelect,
        orderBy: { createdAt: "desc" },
      })
    })
  })

  describe("remove", () => {
    it("公告不存在 → 404", async () => {
      prisma.announcement.findUnique.mockResolvedValue(null)

      await expect(service.remove(1)).rejects.toThrow(new NotFoundException("公告不存在"))
      expect(prisma.announcement.update).not.toHaveBeenCalled()
    })

    it("软删除：写入 deletedAt 并返回 id + deletedAt", async () => {
      prisma.announcement.findUnique.mockResolvedValue({ id: 1 })
      const removed = { id: 1, deletedAt: new Date() }
      prisma.announcement.update.mockResolvedValue(removed)

      const result = await service.remove(1)

      expect(result).toEqual(removed)
      const arg = (
        prisma.announcement.update.mock.calls[0] as [
          {
            where: { id: number }
            data: { deletedAt: Date }
            select: Record<string, boolean>
          },
        ]
      )[0]
      expect(arg.where).toEqual({ id: 1 })
      expect(arg.data.deletedAt).toBeInstanceOf(Date)
      expect(arg.select).toEqual({ id: true, deletedAt: true })
    })
  })
})
