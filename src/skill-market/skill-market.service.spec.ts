import { ConflictException, GoneException, NotFoundException } from "@nestjs/common"
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { RegisterDownloadDto } from "./dto/register-download.dto"
import { SkillMarketService } from "./skill-market.service"

function p2002(): PrismaClientKnownRequestError {
  return new PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  })
}

describe("SkillMarketService", () => {
  const userId = 42
  const skillId = "listing-opt"
  const dto: RegisterDownloadDto = { clientRequestId: "d7d829c4-b226-4be5-bbcb-cdbe14fb18f8" }
  const now = new Date("2026-08-31T02:35:00.000Z")

  interface ModelMocks {
    skillMarketSkill: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock }
    skillMarketUserSkill: {
      findUnique: jest.Mock
      findMany: jest.Mock
      create: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
    }
    skillMarketDownloadEvent: { findUnique: jest.Mock; create: jest.Mock }
  }

  const buildModels = (): ModelMocks => ({
    skillMarketSkill: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    skillMarketUserSkill: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    skillMarketDownloadEvent: { findUnique: jest.fn(), create: jest.fn() },
  })

  let prisma: ModelMocks & { $transaction: jest.Mock }
  let tx: ModelMocks
  let service: SkillMarketService

  const skillRow = {
    id: 1,
    skillId,
    name: "Listing 生成与八维体检",
    status: "ACTIVE",
    fileUrl: "https://erp-pro.nyc3.digitaloceanspaces.com/skill-market/skills/listing-opt.md",
    downloadCount: BigInt(128),
    downloadEventCount: BigInt(176),
  }

  beforeEach(() => {
    prisma = { ...buildModels(), $transaction: jest.fn() }
    tx = buildModels()
    prisma.$transaction.mockImplementation(async (fn: (t: ModelMocks) => Promise<unknown>) =>
      fn(tx)
    )
    service = new SkillMarketService(prisma as unknown as PrismaService)
  })

  const stubSkill = (overrides: Record<string, unknown> = {}) => {
    const row = { ...skillRow, ...overrides }
    tx.skillMarketSkill.findUnique.mockResolvedValue(row)
    prisma.skillMarketSkill.findUnique.mockResolvedValue(row)
    return row
  }

  const stubRelation = (overrides: Record<string, unknown> = {}) => {
    const row = {
      userId,
      skillId,
      firstDownloadedAt: now,
      lastDownloadedAt: now,
      downloadTimes: 1,
      removedAt: null,
      ...overrides,
    }
    prisma.skillMarketUserSkill.findUnique.mockResolvedValue(row)
    return row
  }

  describe("listSkills", () => {
    it("合并技能统计与用户关系，downloaded 按 removedAt 判定，数值字段是 number", async () => {
      prisma.skillMarketSkill.findMany.mockResolvedValue([
        skillRow,
        {
          ...skillRow,
          id: 2,
          skillId: "neg-kw",
          downloadCount: BigInt(86),
          downloadEventCount: BigInt(103),
        },
      ])
      prisma.skillMarketUserSkill.findMany.mockResolvedValue([
        // neg-kw 已移出：downloaded=false 但 downloadTimes 保留
        {
          userId,
          skillId: "neg-kw",
          firstDownloadedAt: now,
          lastDownloadedAt: now,
          downloadTimes: 3,
          removedAt: now,
        },
      ])

      const result = await service.listSkills(userId)

      expect(result.items).toHaveLength(2)
      const listing = result.items.find(i => i.skillId === skillId)!
      expect(listing.downloaded).toBe(false)
      expect(listing.downloadTimes).toBe(0)
      expect(listing.downloadCount).toBe(128)
      expect(typeof listing.downloadCount).toBe("number")
      const negKw = result.items.find(i => i.skillId === "neg-kw")!
      expect(negKw.downloaded).toBe(false)
      expect(negKw.downloadTimes).toBe(3)
      expect(result.summary).toEqual({ availableSkillCount: 2, myDownloadedSkillCount: 0 })
      expect(typeof result.serverTime).toBe("string")
    })

    it("在列表中的已保留关系计入 myDownloadedSkillCount", async () => {
      prisma.skillMarketSkill.findMany.mockResolvedValue([skillRow])
      prisma.skillMarketUserSkill.findMany.mockResolvedValue([
        {
          userId,
          skillId,
          firstDownloadedAt: now,
          lastDownloadedAt: now,
          downloadTimes: 2,
          removedAt: null,
        },
      ])

      const result = await service.listSkills(userId)

      expect(result.items[0].downloaded).toBe(true)
      expect(result.summary.myDownloadedSkillCount).toBe(1)
    })
  })

  describe("registerDownload 首次下载", () => {
    it("事件与关系都 create，downloadCount/downloadEventCount 同时 +1，返回 201 语义字段", async () => {
      prisma.skillMarketDownloadEvent.findUnique.mockResolvedValue(null)
      stubSkill()
      tx.skillMarketDownloadEvent.create.mockResolvedValue({})
      tx.skillMarketUserSkill.create.mockResolvedValue({})
      stubRelation()

      const result = await service.registerDownload(userId, skillId, dto, {
        ip: "1.2.3.4",
        userAgent: "ua",
      })

      expect(result.firstDownload).toBe(true)
      expect(result.idempotentReplay).toBe(false)
      expect(result.downloaded).toBe(true)
      // 公开直链直接来自 DB 的 fileUrl，expiresAt 恒为 null
      expect(result.downloadUrl).toBe(skillRow.fileUrl)
      expect(result.expiresAt).toBeNull()
      // 事件落 ipHash / userAgent
      expect(tx.skillMarketDownloadEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientRequestId: dto.clientRequestId,
          userId,
          skillId,
          ipHash: expect.any(String) as string,
        }) as Record<string, unknown>,
      })
      // 计数走单条原子 increment
      expect(tx.skillMarketSkill.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { downloadEventCount: { increment: 1 }, downloadCount: { increment: 1 } },
      })
      expect(tx.skillMarketUserSkill.update).not.toHaveBeenCalled()
    })

    it("fileUrl 为空（正文未上传）时直接返回 null，前端兜底本地生成", async () => {
      prisma.skillMarketDownloadEvent.findUnique.mockResolvedValue(null)
      stubSkill({ fileUrl: null })
      tx.skillMarketDownloadEvent.create.mockResolvedValue({})
      tx.skillMarketUserSkill.create.mockResolvedValue({})
      stubRelation()

      const result = await service.registerDownload(userId, skillId, dto, {})

      expect(result.downloadUrl).toBeNull()
      expect(result.expiresAt).toBeNull()
    })
  })

  describe("registerDownload 重复下载", () => {
    it("关系 create 撞唯一索引后降级 updateMany：downloadTimes+1、removedAt 清空、downloadCount 不增", async () => {
      prisma.skillMarketDownloadEvent.findUnique.mockResolvedValue(null)
      stubSkill()
      tx.skillMarketDownloadEvent.create.mockResolvedValue({})
      tx.skillMarketUserSkill.create.mockRejectedValue(p2002())
      tx.skillMarketUserSkill.updateMany.mockResolvedValue({ count: 1 })
      stubRelation({ downloadTimes: 2 })

      const result = await service.registerDownload(userId, skillId, dto, {})

      expect(result.firstDownload).toBe(false)
      expect(result.downloadTimes).toBe(2)
      expect(tx.skillMarketUserSkill.updateMany).toHaveBeenCalledWith({
        where: { userId, skillId },
        data: {
          lastDownloadedAt: expect.any(Date) as Date,
          downloadTimes: { increment: 1 },
          removedAt: null,
        },
      })
      // 去重计数不增加：只 increment downloadEventCount
      expect(tx.skillMarketSkill.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { downloadEventCount: { increment: 1 } },
      })
    })

    it("并发回滚窗口：create P2002 且 updateMany 命中 0 行时重试 create 收敛为首次下载", async () => {
      prisma.skillMarketDownloadEvent.findUnique.mockResolvedValue(null)
      stubSkill()
      tx.skillMarketDownloadEvent.create.mockResolvedValue({})
      // 第一次 create 撞唯一索引，但行瞬时不可见（并发事务未提交/回滚卷走）
      tx.skillMarketUserSkill.create.mockRejectedValueOnce(p2002()).mockResolvedValueOnce({})
      tx.skillMarketUserSkill.updateMany.mockResolvedValueOnce({ count: 0 })
      stubRelation({ downloadTimes: 1 })

      const result = await service.registerDownload(userId, skillId, dto, {})

      expect(result.firstDownload).toBe(true)
      expect(tx.skillMarketUserSkill.create).toHaveBeenCalledTimes(2)
      // 收敛为首次下载：两个计数同时 +1
      expect(tx.skillMarketSkill.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { downloadEventCount: { increment: 1 }, downloadCount: { increment: 1 } },
      })
    })
  })

  describe("registerDownload 幂等", () => {
    it("事务外快速路径：相同 clientRequestId 重放返回原事件时间，零写入", async () => {
      prisma.skillMarketDownloadEvent.findUnique.mockResolvedValue({
        clientRequestId: dto.clientRequestId,
        userId,
        skillId,
        createdAt: now,
      })
      stubSkill()
      stubRelation({ downloadTimes: 2 })

      const result = await service.registerDownload(userId, skillId, dto, {})

      expect(result.idempotentReplay).toBe(true)
      expect(result.downloadedAt).toBe(now.toISOString())
      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(result.downloadUrl).toBe(skillRow.fileUrl)
    })

    it("同一幂等键被其他技能使用返回 409", async () => {
      prisma.skillMarketDownloadEvent.findUnique.mockResolvedValue({
        clientRequestId: dto.clientRequestId,
        userId,
        skillId: "trending",
        createdAt: now,
      })

      await expect(service.registerDownload(userId, skillId, dto, {})).rejects.toThrow(
        ConflictException
      )
    })

    it("同一幂等键被其他用户使用返回 409", async () => {
      prisma.skillMarketDownloadEvent.findUnique.mockResolvedValue({
        clientRequestId: dto.clientRequestId,
        userId: 999,
        skillId,
        createdAt: now,
      })

      await expect(service.registerDownload(userId, skillId, dto, {})).rejects.toThrow(
        ConflictException
      )
    })

    it("事务内事件撞唯一索引（并发同键）：零写入提交后重查，按重放返回且不碰关系表", async () => {
      prisma.skillMarketDownloadEvent.findUnique
        .mockResolvedValueOnce(null) // 快速路径未命中
        .mockResolvedValueOnce({
          clientRequestId: dto.clientRequestId,
          userId,
          skillId,
          createdAt: now,
        }) // 事务后重查
      stubSkill()
      tx.skillMarketDownloadEvent.create.mockRejectedValue(p2002())
      stubRelation({ downloadTimes: 2 })

      const result = await service.registerDownload(userId, skillId, dto, {})

      expect(result.idempotentReplay).toBe(true)
      // 事件插入失败后事务内不得再做任何写入
      expect(tx.skillMarketUserSkill.create).not.toHaveBeenCalled()
      expect(tx.skillMarketUserSkill.update).not.toHaveBeenCalled()
      expect(tx.skillMarketSkill.update).not.toHaveBeenCalled()
    })
  })

  describe("registerDownload 技能校验", () => {
    it("技能不存在返回 404", async () => {
      prisma.skillMarketDownloadEvent.findUnique.mockResolvedValue(null)
      tx.skillMarketSkill.findUnique.mockResolvedValue(null)

      await expect(service.registerDownload(userId, "nope", dto, {})).rejects.toThrow(
        NotFoundException
      )
    })

    it("下架技能返回 410", async () => {
      prisma.skillMarketDownloadEvent.findUnique.mockResolvedValue(null)
      tx.skillMarketSkill.findUnique.mockResolvedValue({ ...skillRow, status: "DISABLED" })

      await expect(service.registerDownload(userId, skillId, dto, {})).rejects.toThrow(
        GoneException
      )
    })
  })

  describe("removeFromLibrary", () => {
    it("有未移出的关系：置 removedAt，不动计数不删行", async () => {
      prisma.skillMarketSkill.findUnique.mockResolvedValue(skillRow)
      prisma.skillMarketUserSkill.findUnique.mockResolvedValue({
        userId,
        skillId,
        firstDownloadedAt: now,
        lastDownloadedAt: now,
        downloadTimes: 2,
        removedAt: null,
      })
      prisma.skillMarketUserSkill.update.mockResolvedValue({
        userId,
        skillId,
        removedAt: now,
      })

      const result = await service.removeFromLibrary(userId, skillId)

      expect(result.downloaded).toBe(false)
      expect(result.downloadCount).toBe(128)
      expect(result.removedAt).toBe(now.toISOString())
      expect(prisma.skillMarketUserSkill.update).toHaveBeenCalledWith({
        where: { userId_skillId: { userId, skillId } },
        data: { removedAt: expect.any(Date) as Date },
      })
    })

    it("从未下载过：幂等返回成功，removedAt 为 null", async () => {
      prisma.skillMarketSkill.findUnique.mockResolvedValue(skillRow)
      prisma.skillMarketUserSkill.findUnique.mockResolvedValue(null)

      const result = await service.removeFromLibrary(userId, skillId)

      expect(result).toEqual({ skillId, downloaded: false, downloadCount: 128, removedAt: null })
      expect(prisma.skillMarketUserSkill.update).not.toHaveBeenCalled()
    })

    it("已移出再删：幂等返回原 removedAt", async () => {
      prisma.skillMarketSkill.findUnique.mockResolvedValue(skillRow)
      prisma.skillMarketUserSkill.findUnique.mockResolvedValue({
        userId,
        skillId,
        removedAt: now,
      })

      const result = await service.removeFromLibrary(userId, skillId)

      expect(result.removedAt).toBe(now.toISOString())
      expect(prisma.skillMarketUserSkill.update).not.toHaveBeenCalled()
    })

    it("技能不存在返回 404", async () => {
      prisma.skillMarketSkill.findUnique.mockResolvedValue(null)

      await expect(service.removeFromLibrary(userId, "nope")).rejects.toThrow(NotFoundException)
    })
  })
})
