import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { Test } from "@nestjs/testing"
import * as argon2 from "argon2"
import { PrismaService } from "../prisma/prisma.service"
import { SmsService } from "../sms/sms.service"
import { AuthService } from "./auth.service"

describe("AuthService", () => {
  let authService: AuthService
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock }
    inviteApplication: { findFirst: jest.Mock }
    userOrganization: { findUnique: jest.Mock }
    permissionGroup: { findMany: jest.Mock }
  }
  let jwtService: { sign: jest.Mock }
  let smsService: { verifyCode: jest.Mock }

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      inviteApplication: { findFirst: jest.fn().mockResolvedValue(null) },
      userOrganization: { findUnique: jest.fn() },
      permissionGroup: { findMany: jest.fn().mockResolvedValue([]) },
    }
    jwtService = { sign: jest.fn().mockReturnValue("test-token") }
    smsService = { verifyCode: jest.fn() }

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
        { provide: SmsService, useValue: smsService },
      ],
    }).compile()

    authService = module.get(AuthService)
  })

  describe("login", () => {
    it("should return access_token on valid credentials", async () => {
      const hashedPassword = await argon2.hash("123456")
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        phone: "18280027092",
        password: hashedPassword,
        isActive: true,
        roles: [{ role: { code: "ADMIN" } }],
        orgs: [{ orgId: 5 }],
      })

      const result = await authService.login({ phone: "18280027092", password: "123456" })

      expect(result).toEqual({ access_token: "test-token" })
      expect(prisma.inviteApplication.findFirst).not.toHaveBeenCalled()
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: 1,
        phone: "18280027092",
        roleCode: "ADMIN",
        currentOrgId: 5,
      })
    })

    it("无角色时 roleCode 为 null", async () => {
      const hashedPassword = await argon2.hash("123456")
      prisma.user.findUnique.mockResolvedValue({
        id: 3,
        phone: "18280027094",
        password: hashedPassword,
        isActive: true,
        roles: [],
        orgs: [],
      })

      await authService.login({ phone: "18280027094", password: "123456" })

      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: 3,
        phone: "18280027094",
        roleCode: null,
        currentOrgId: null,
      })
    })

    it("登录成功后回写 lastLoginAt", async () => {
      const hashedPassword = await argon2.hash("123456")
      prisma.user.findUnique.mockResolvedValue({
        id: 2,
        phone: "18280027093",
        password: hashedPassword,
        isActive: true,
        roles: [{ role: { code: "ADMIN" } }],
        orgs: [],
      })

      await authService.login({ phone: "18280027093", password: "123456" })

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 2 },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: { lastLoginAt: expect.any(Date) },
      })
    })

    it("should throw on wrong phone", async () => {
      prisma.user.findUnique.mockResolvedValue(null)

      await expect(authService.login({ phone: "10000000000", password: "123456" })).rejects.toThrow(
        "手机号或密码错误"
      )
    })

    it("待审核申请密码正确时提示联系平台顾问，不签发 token", async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      prisma.inviteApplication.findFirst.mockResolvedValue({
        passwordHash: await argon2.hash("123456"),
      })

      await expect(authService.login({ phone: "18280027092", password: "123456" })).rejects.toThrow(
        "审核中，请联系平台顾问"
      )
      expect(prisma.inviteApplication.findFirst).toHaveBeenCalledWith({
        where: { phone: "18280027092", status: "PENDING" },
        select: { passwordHash: true },
      })
      expect(jwtService.sign).not.toHaveBeenCalled()
      expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it("待审核申请密码错误时仍提示手机号或密码错误", async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      prisma.inviteApplication.findFirst.mockResolvedValue({
        passwordHash: await argon2.hash("correct"),
      })

      await expect(authService.login({ phone: "18280027092", password: "wrong" })).rejects.toThrow(
        "手机号或密码错误"
      )
      expect(jwtService.sign).not.toHaveBeenCalled()
    })

    it("should throw on wrong password", async () => {
      const hashedPassword = await argon2.hash("correct")
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        phone: "18280027092",
        password: hashedPassword,
        isActive: true,
        roleRef: { code: "ADMIN" },
      })

      await expect(authService.login({ phone: "18280027092", password: "wrong" })).rejects.toThrow(
        BadRequestException
      )
    })

    it("应拒绝已停用账号（密码正确）", async () => {
      const hashedPassword = await argon2.hash("123456")
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        phone: "18280027092",
        password: hashedPassword,
        isActive: false,
        roleRef: { code: "ADMIN" },
      })

      await expect(authService.login({ phone: "18280027092", password: "123456" })).rejects.toThrow(
        /已停用/
      )
      expect(jwtService.sign).not.toHaveBeenCalled()
    })
  })

  describe("loginBySms", () => {
    it("should return access_token on valid code", async () => {
      smsService.verifyCode.mockResolvedValue(true)
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        phone: "18280027092",
        isActive: true,
        roles: [{ role: { code: "ADMIN" } }],
        orgs: [],
      })

      const result = await authService.loginBySms({ phone: "18280027092", code: "123456" })

      expect(result).toEqual({ access_token: "test-token" })
    })

    it("should throw on invalid code", async () => {
      smsService.verifyCode.mockResolvedValue(false)

      await expect(
        authService.loginBySms({ phone: "18280027092", code: "000000" })
      ).rejects.toThrow(BadRequestException)
      expect(prisma.user.findUnique).not.toHaveBeenCalled()
      expect(prisma.inviteApplication.findFirst).not.toHaveBeenCalled()
    })

    it("短信验证通过的待审申请提示联系平台顾问", async () => {
      smsService.verifyCode.mockResolvedValue(true)
      prisma.user.findUnique.mockResolvedValue(null)
      prisma.inviteApplication.findFirst.mockResolvedValue({ id: 1 })

      await expect(
        authService.loginBySms({ phone: "15884033673", code: "123456" })
      ).rejects.toThrow("审核中，请联系平台顾问")
      expect(prisma.inviteApplication.findFirst).toHaveBeenCalledWith({
        where: { phone: "15884033673", status: "PENDING" },
        select: { id: true },
      })
      expect(jwtService.sign).not.toHaveBeenCalled()
    })

    it("短信验证通过但未注册时不创建用户或签发 token", async () => {
      smsService.verifyCode.mockResolvedValue(true)
      prisma.user.findUnique.mockResolvedValue(null)

      await expect(
        authService.loginBySms({ phone: "15884033673", code: "123456" })
      ).rejects.toThrow("用户不存在")
      expect(jwtService.sign).not.toHaveBeenCalled()
    })

    it("应拒绝已停用账号（短信码正确）", async () => {
      smsService.verifyCode.mockResolvedValue(true)
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        phone: "18280027092",
        isActive: false,
        roleRef: { code: "ADMIN" },
      })

      await expect(
        authService.loginBySms({ phone: "18280027092", code: "123456" })
      ).rejects.toThrow(/已停用/)
      expect(jwtService.sign).not.toHaveBeenCalled()
    })
  })

  describe("switchOrg", () => {
    it("属于目标组织时重签 token，currentOrgId 写入", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        phone: "18280027092",
        roles: [{ role: { code: "ADMIN" } }],
        orgs: [{ orgId: 5 }],
      })
      prisma.userOrganization.findUnique.mockResolvedValue({ userId: 1 })

      const result = await authService.switchOrg(1, 9)

      expect(result).toEqual({ access_token: "test-token" })
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: 1,
        phone: "18280027092",
        roleCode: "ADMIN",
        currentOrgId: 9,
      })
    })

    it("不属于目标组织时抛 ForbiddenException", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        phone: "18280027092",
        roles: [{ role: { code: "ADMIN" } }],
        orgs: [],
      })
      prisma.userOrganization.findUnique.mockResolvedValue(null)

      await expect(authService.switchOrg(1, 99)).rejects.toThrow(ForbiddenException)
      expect(jwtService.sign).not.toHaveBeenCalled()
    })

    it("orgId 传 null 时清空当前组织，无需成员校验", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        phone: "18280027092",
        roles: [{ role: { code: "ADMIN" } }],
        orgs: [{ orgId: 5 }],
      })

      await authService.switchOrg(1, null)

      expect(prisma.userOrganization.findUnique).not.toHaveBeenCalled()
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: 1,
        phone: "18280027092",
        roleCode: "ADMIN",
        currentOrgId: null,
      })
    })
  })

  describe("getMe", () => {
    const baseUser = {
      id: 1,
      username: "test4",
      phone: "18280027092",
      modelUnlocked: false,
      mustChangePassword: false,
      createdAt: new Date("2026-04-20T06:12:00.000Z"),
      roles: [{ role: { code: "TEST", name: "测试", color: null, permissions: [] } }],
      orgs: [],
    }

    it("邮箱注册用户返回注册邮箱与 registerType=EMAIL", async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        phone: "9123456789",
        emailAccounts: [{ email: "foo@bar.com" }],
      })

      const result = await authService.getMe(1)

      expect(result.user.email).toBe("foo@bar.com")
      expect(result.user.registerType).toBe("EMAIL")
      expect(result.user.phone).toBe("9123456789")
    })

    it("手机号注册用户 email 为 null、registerType=PHONE", async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        emailAccounts: [],
      })

      const result = await authService.getMe(1)

      expect(result.user.email).toBeNull()
      expect(result.user.registerType).toBe("PHONE")
    })

    it("用户不存在时抛 NotFoundException", async () => {
      prisma.user.findUnique.mockResolvedValue(null)

      await expect(authService.getMe(99)).rejects.toThrow(NotFoundException)
    })
  })

  describe("getPermissions", () => {
    const permission = (key: string, groupCode: string, sortOrder: number) => ({
      key,
      label: key,
      groupCode,
      parentKey: null,
      route: null,
      subRoutes: null,
      sortOrder,
    })

    it("返回权限并集 + 用户拥有的分组，分组按权限中出现的 groupCode 查询", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        roles: [
          {
            role: {
              code: "OPERATOR",
              name: "运营",
              color: null,
              permissions: [
                { permission: permission("tool.listing_generate", "tools", 1) },
                { permission: permission("customer.view", "management", 2) },
              ],
            },
          },
        ],
      })
      prisma.permissionGroup.findMany.mockResolvedValue([
        { code: "tools", label: "工具", sortOrder: 1 },
        { code: "management", label: "管理", sortOrder: 2 },
      ])

      const result = await authService.getPermissions(1)

      expect(result.permissions.map(p => p.key)).toEqual(["tool.listing_generate", "customer.view"])
      expect(result.groups).toEqual([
        { code: "tools", label: "工具", sortOrder: 1 },
        { code: "management", label: "管理", sortOrder: 2 },
      ])
      expect(prisma.permissionGroup.findMany).toHaveBeenCalledWith({
        where: { code: { in: ["tools", "management"] } },
        orderBy: { sortOrder: "asc" },
        select: { code: true, label: true, sortOrder: true },
      })
    })

    it("多角色权限去重后 groupCode 不重复传给分组查询", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        roles: [
          {
            role: {
              code: "A",
              name: "a",
              color: null,
              permissions: [{ permission: permission("tool.a", "tools", 1) }],
            },
          },
          {
            role: {
              code: "B",
              name: "b",
              color: null,
              permissions: [{ permission: permission("tool.b", "tools", 2) }],
            },
          },
        ],
      })
      prisma.permissionGroup.findMany.mockResolvedValue([
        { code: "tools", label: "工具", sortOrder: 1 },
      ])

      const result = await authService.getPermissions(1)

      expect(prisma.permissionGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { code: { in: ["tools"] } } })
      )
      expect(result.groups).toHaveLength(1)
    })

    it("无任何权限时不查分组，groups 为空数组", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        roles: [{ role: { code: "EMPTY", name: "空", color: null, permissions: [] } }],
      })

      const result = await authService.getPermissions(1)

      expect(prisma.permissionGroup.findMany).not.toHaveBeenCalled()
      expect(result).toEqual({ permissions: [], groups: [] })
    })

    it("用户不存在时抛 NotFoundException", async () => {
      prisma.user.findUnique.mockResolvedValue(null)

      await expect(authService.getPermissions(99)).rejects.toThrow(NotFoundException)
    })
  })
})
