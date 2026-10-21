import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { PermissionCacheService } from "../auth/services/permission-cache.service"
import { PrismaService } from "../prisma/prisma.service"
import { RoleService } from "./role.service"

describe("RoleService", () => {
  let service: RoleService
  let prisma: {
    roleModel: {
      findMany: jest.Mock
      findFirst: jest.Mock
      findUnique: jest.Mock
      create: jest.Mock
      update: jest.Mock
      delete: jest.Mock
    }
    permission: { findMany: jest.Mock }
    rolePermission: { deleteMany: jest.Mock; createMany: jest.Mock }
    userRole: { findMany: jest.Mock }
    $transaction: jest.Mock
  }
  let permissionCache: { invalidate: jest.Mock }

  beforeEach(async () => {
    prisma = {
      roleModel: {
        findMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      permission: { findMany: jest.fn() },
      rolePermission: { deleteMany: jest.fn(), createMany: jest.fn() },
      userRole: { findMany: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    }
    permissionCache = { invalidate: jest.fn() }

    const module = await Test.createTestingModule({
      providers: [
        RoleService,
        { provide: PrismaService, useValue: prisma },
        { provide: PermissionCacheService, useValue: permissionCache },
      ],
    }).compile()

    service = module.get(RoleService)
  })

  const roleRow = (over: Record<string, unknown> = {}) => ({
    id: 1,
    code: "OPS",
    name: "运营",
    description: null,
    color: null,
    isSystem: false,
    _count: { users: 0 },
    permissions: [{ permission: { key: "tool.listing_generate" } }],
    ...over,
  })

  describe("createRole", () => {
    it("生成 code、绑定权限并返回详情", async () => {
      prisma.roleModel.findUnique
        .mockResolvedValueOnce(null) // resolveCode 查重
        .mockResolvedValueOnce(roleRow({ id: 7, code: "ad_optimizer" })) // getRole
      prisma.roleModel.create.mockResolvedValue({ id: 7 })
      prisma.permission.findMany.mockResolvedValue([{ id: 11 }])

      const result = await service.createRole({
        name: "ad optimizer",
        permissionKeys: ["tool.listing_generate"],
      })

      const createCalls = prisma.roleModel.create.mock.calls as Array<
        [{ data: { code: string; isSystem: boolean } }]
      >
      expect(createCalls[0][0].data.code).toBe("ad_optimizer")
      expect(createCalls[0][0].data.isSystem).toBe(false)
      expect(prisma.$transaction).toHaveBeenCalled()
      expect(result.id).toBe(7)
    })

    it("按名称自动生成唯一 code（全中文名兜底为 role）", async () => {
      prisma.roleModel.findUnique
        .mockResolvedValueOnce(null) // generateUniqueCode 查重
        .mockResolvedValueOnce(roleRow({ id: 8, code: "role" })) // getRole
      prisma.roleModel.create.mockResolvedValue({ id: 8 })
      prisma.permission.findMany.mockResolvedValue([])

      await service.createRole({ name: "运营主管", permissionKeys: [] })

      const createCalls = prisma.roleModel.create.mock.calls as Array<[{ data: { code: string } }]>
      expect(createCalls[0][0].data.code).toBe("role")
    })

    it("角色名已存在抛 ConflictException", async () => {
      prisma.roleModel.findFirst.mockResolvedValue({ id: 3 })
      await expect(service.createRole({ name: "运营主管", permissionKeys: [] })).rejects.toThrow(
        ConflictException
      )
      expect(prisma.roleModel.create).not.toHaveBeenCalled()
    })
  })

  describe("updateRole", () => {
    it("改权限后触发 permissionCache.invalidate", async () => {
      prisma.roleModel.findUnique
        .mockResolvedValueOnce({ id: 1, code: "OPS" }) // 前置存在性查询
        .mockResolvedValueOnce(roleRow()) // getRole
      prisma.permission.findMany.mockResolvedValue([{ id: 11 }])

      await service.updateRole(1, { permissionKeys: ["tool.listing_generate"] })

      expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 1 } })
      expect(permissionCache.invalidate).toHaveBeenCalledWith(1)
    })

    it("内置超级管理员不可修改（BadRequest）", async () => {
      prisma.roleModel.findUnique.mockResolvedValue({ id: 1, code: "ADMIN", isSystem: true })
      await expect(service.updateRole(1, { permissionKeys: ["x"] })).rejects.toThrow(
        BadRequestException
      )
      await expect(service.updateRole(1, { name: "改名" })).rejects.toThrow(BadRequestException)
      expect(permissionCache.invalidate).not.toHaveBeenCalled()
    })

    it("角色不存在抛 NotFoundException", async () => {
      prisma.roleModel.findUnique.mockResolvedValue(null)
      await expect(service.updateRole(99, { name: "x" })).rejects.toThrow(NotFoundException)
    })
  })

  describe("deleteRole", () => {
    it("内置角色不可删（Conflict）", async () => {
      prisma.roleModel.findUnique.mockResolvedValue({
        id: 1,
        code: "ADMIN",
        isSystem: true,
        _count: { users: 0 },
      })
      await expect(service.deleteRole(1)).rejects.toThrow(ConflictException)
      expect(prisma.roleModel.delete).not.toHaveBeenCalled()
    })

    it("角色下有用户不可删（Conflict）", async () => {
      prisma.roleModel.findUnique.mockResolvedValue({
        id: 2,
        code: "OPS",
        isSystem: false,
        _count: { users: 3 },
      })
      await expect(service.deleteRole(2)).rejects.toThrow(ConflictException)
      expect(prisma.roleModel.delete).not.toHaveBeenCalled()
    })

    it("可删时删除并使缓存失效", async () => {
      prisma.roleModel.findUnique.mockResolvedValue({
        id: 2,
        code: "OPS",
        isSystem: false,
        _count: { users: 0 },
      })
      prisma.roleModel.delete.mockResolvedValue({ id: 2 })

      const result = await service.deleteRole(2)

      expect(prisma.roleModel.delete).toHaveBeenCalledWith({ where: { id: 2 } })
      expect(permissionCache.invalidate).toHaveBeenCalledWith(2)
      expect(result).toEqual({ id: 2 })
    })
  })
})
