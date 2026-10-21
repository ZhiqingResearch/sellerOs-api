import { ConflictException, NotFoundException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { PrismaService } from "../prisma/prisma.service"
import { OrgsService } from "./orgs.service"

describe("OrgsService", () => {
  let service: OrgsService
  let prisma: {
    organization: {
      findMany: jest.Mock
      findUnique: jest.Mock
      create: jest.Mock
      update: jest.Mock
      delete: jest.Mock
    }
  }

  const orgRow = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: "深圳总部",
    note: null,
    createdAt: new Date("2025-08-12T10:24:00.000Z"),
    _count: { users: 0 },
    ...over,
  })

  beforeEach(async () => {
    prisma = {
      organization: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    }

    const module = await Test.createTestingModule({
      providers: [OrgsService, { provide: PrismaService, useValue: prisma }],
    }).compile()

    service = module.get(OrgsService)
  })

  describe("createOrg", () => {
    it("名称可用时创建并返回 usersCount=0", async () => {
      prisma.organization.findUnique.mockResolvedValue(null)
      prisma.organization.create.mockResolvedValue(orgRow({ id: 5, name: "欧洲运营中心" }))

      const result = await service.createOrg({ name: "欧洲运营中心" })

      expect(result).toEqual({
        id: 5,
        name: "欧洲运营中心",
        note: null,
        usersCount: 0,
        createdAt: "2025-08-12T10:24:00.000Z",
      })
    })

    it("名称已存在抛 ConflictException", async () => {
      prisma.organization.findUnique.mockResolvedValue({ id: 1 })
      await expect(service.createOrg({ name: "深圳总部" })).rejects.toThrow(ConflictException)
      expect(prisma.organization.create).not.toHaveBeenCalled()
    })
  })

  describe("updateOrg", () => {
    it("改名时与新名称查重", async () => {
      prisma.organization.findUnique
        .mockResolvedValueOnce({ name: "深圳总部" }) // 当前
        .mockResolvedValueOnce({ id: 9 }) // 新名称已被占用
      await expect(service.updateOrg(1, { name: "香港分公司" })).rejects.toThrow(ConflictException)
    })

    it("组织不存在抛 NotFoundException", async () => {
      prisma.organization.findUnique.mockResolvedValue(null)
      await expect(service.updateOrg(99, { note: "x" })).rejects.toThrow(NotFoundException)
    })
  })

  describe("deleteOrg", () => {
    it("其下有用户不可删（Conflict）", async () => {
      prisma.organization.findUnique.mockResolvedValue(orgRow({ _count: { users: 3 } }))
      await expect(service.deleteOrg(1)).rejects.toThrow(ConflictException)
      expect(prisma.organization.delete).not.toHaveBeenCalled()
    })

    it("空组织可删", async () => {
      prisma.organization.findUnique.mockResolvedValue(orgRow({ id: 2, _count: { users: 0 } }))
      prisma.organization.delete.mockResolvedValue({ id: 2 })

      const result = await service.deleteOrg(2)

      expect(prisma.organization.delete).toHaveBeenCalledWith({ where: { id: 2 } })
      expect(result).toEqual({ id: 2 })
    })
  })
})
