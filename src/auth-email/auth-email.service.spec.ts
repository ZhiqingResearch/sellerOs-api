/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest 匹配器（expect.any/stringMatching/objectContaining）返回 any */
import { BadRequestException, ConflictException } from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { Test } from "@nestjs/testing"
import { CreditBucket, CreditTxnType, Prisma } from "@prisma/client"
import * as argon2 from "argon2"
import { CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"
import { AuthEmailService } from "./auth-email.service"
import { EmailAuthCodeService } from "./email-auth-code.service"

describe("AuthEmailService", () => {
  let service: AuthEmailService
  let prisma: {
    emailAccount: { findUnique: jest.Mock; create: jest.Mock }
    user: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock }
    roleModel: { findFirst: jest.Mock }
    userRole: { create: jest.Mock }
    $transaction: jest.Mock
  }
  let jwtService: { sign: jest.Mock }
  let emailCode: { send: jest.Mock; consume: jest.Mock }
  let credit: { grant: jest.Mock }

  beforeEach(async () => {
    prisma = {
      emailAccount: { findUnique: jest.fn(), create: jest.fn().mockResolvedValue({}) },
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      roleModel: { findFirst: jest.fn().mockResolvedValue({ id: 9, code: "OPS" }) },
      userRole: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    }
    jwtService = { sign: jest.fn().mockReturnValue("test-token") }
    emailCode = { send: jest.fn().mockResolvedValue(undefined), consume: jest.fn() }
    credit = { grant: jest.fn().mockResolvedValue(undefined) }

    const module = await Test.createTestingModule({
      providers: [
        AuthEmailService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
        { provide: EmailAuthCodeService, useValue: emailCode },
        { provide: CreditService, useValue: credit },
      ],
    }).compile()

    service = module.get(AuthEmailService)
  })

  /** 模拟事务回调执行（interactive transaction） */
  const runTx = () => {
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb({
        user: prisma.user,
        emailAccount: prisma.emailAccount,
        roleModel: prisma.roleModel,
        userRole: prisma.userRole,
      })
    )
  }

  describe("sendRegisterCode", () => {
    it("邮箱已注册直接 400，不发码", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue({ id: 1 })

      await expect(service.sendRegisterCode("a@example.com")).rejects.toThrow(BadRequestException)
      expect(emailCode.send).not.toHaveBeenCalled()
    })

    it("未注册则发送 REGISTER 验证码", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue(null)

      await service.sendRegisterCode(" A@Example.COM ")

      expect(emailCode.send).toHaveBeenCalledWith("a@example.com", "REGISTER")
    })
  })

  describe("register", () => {
    const dto = { email: "a@example.com", emailCode: "123456", password: "Passw0rd!" }

    it("邮箱已注册抛 409 且不核销验证码（失败不烧码）", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue({ id: 1 })

      await expect(service.register(dto)).rejects.toThrow(ConflictException)
      expect(emailCode.consume).not.toHaveBeenCalled()
    })

    it("验证码无效抛 400", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue(null)
      emailCode.consume.mockResolvedValue(false)

      await expect(service.register(dto)).rejects.toThrow(BadRequestException)
    })

    it("注册成功：伪手机号 9 开头 11 位、建 EmailAccount、送 200 GIFT、签发 token", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue(null)
      emailCode.consume.mockResolvedValue(true)
      prisma.user.findUnique.mockResolvedValue(null)
      prisma.user.create.mockResolvedValue({ id: 10, phone: "91234567890" })
      runTx()

      const result = await service.register(dto)

      expect(result).toEqual({ access_token: "test-token" })
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          username: "a", // 缺省取邮箱本地部分
          phone: expect.stringMatching(/^9\d{10}$/),
          email: "a@example.com",
          password: expect.any(String),
          balance: 0,
        }),
      })
      expect(prisma.emailAccount.create).toHaveBeenCalledWith({
        data: { email: "a@example.com", userId: 10 },
      })
      expect(prisma.roleModel.findFirst).toHaveBeenCalledWith({
        where: { name: "Ops" },
        select: { id: true, code: true },
      })
      expect(prisma.userRole.create).toHaveBeenCalledWith({
        data: { userId: 10, roleId: 9 },
      })
      expect(credit.grant).toHaveBeenCalledWith(
        10,
        CreditBucket.GIFT,
        200,
        {
          type: CreditTxnType.SIGNUP_BONUS,
          source: "email.signup",
          expiresAt: expect.any(Date),
        },
        expect.anything()
      )
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: 10,
        phone: "91234567890",
        roleCode: "OPS", // 默认「Ops」角色的 code
        currentOrgId: null,
      })
    })

    it("默认角色「Ops」不存在时注册不阻塞：不绑角色、token roleCode 为 null", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue(null)
      emailCode.consume.mockResolvedValue(true)
      prisma.user.findUnique.mockResolvedValue(null)
      prisma.user.create.mockResolvedValue({ id: 10, phone: "91234567890" })
      prisma.roleModel.findFirst.mockResolvedValue(null)
      runTx()

      const result = await service.register(dto)

      expect(result).toEqual({ access_token: "test-token" })
      expect(prisma.userRole.create).not.toHaveBeenCalled()
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: 10,
        phone: "91234567890",
        roleCode: null,
        currentOrgId: null,
      })
    })

    it("显式 username 优先于邮箱本地部分", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue(null)
      emailCode.consume.mockResolvedValue(true)
      prisma.user.findUnique.mockResolvedValue(null)
      prisma.user.create.mockResolvedValue({ id: 10, phone: "91234567890" })
      runTx()

      await service.register({ ...dto, username: "  张三  " })

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ username: "张三" }),
      })
    })

    it("伪手机号快检命中时换号重试", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue(null)
      emailCode.consume.mockResolvedValue(true)
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 99 }) // 第一次生成的伪手机号已被占用
        .mockResolvedValue(null)
      prisma.user.create.mockResolvedValue({ id: 10, phone: "91234567890" })
      runTx()

      const result = await service.register(dto)

      expect(result).toEqual({ access_token: "test-token" })
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
    })

    it("事务内伪手机号撞唯一索引（P2002）时重试", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue(null)
      emailCode.consume.mockResolvedValue(true)
      prisma.user.findUnique.mockResolvedValue(null)
      const phoneViolation = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["phone"] },
      })
      prisma.$transaction
        .mockRejectedValueOnce(phoneViolation)
        .mockImplementationOnce((cb: (tx: unknown) => unknown) =>
          cb({
            user: prisma.user,
            emailAccount: prisma.emailAccount,
            roleModel: prisma.roleModel,
            userRole: prisma.userRole,
          })
        )
      prisma.user.create.mockResolvedValue({ id: 10, phone: "91234567890" })

      const result = await service.register(dto)

      expect(result).toEqual({ access_token: "test-token" })
      expect(prisma.$transaction).toHaveBeenCalledTimes(2)
    })

    it("事务内 email 撞唯一索引（P2002）转 409", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue(null)
      emailCode.consume.mockResolvedValue(true)
      prisma.user.findUnique.mockResolvedValue(null)
      const emailViolation = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["email"] },
      })
      prisma.$transaction.mockRejectedValue(emailViolation)

      await expect(service.register(dto)).rejects.toThrow(ConflictException)
    })
  })

  describe("login", () => {
    const dto = { email: "a@example.com", password: "Passw0rd!" }

    const accountWith = (overrides: Record<string, unknown>) => ({
      userId: 10,
      user: {
        id: 10,
        phone: "91234567890",
        password: "hashed",
        isActive: true,
        roles: [],
        orgs: [],
        ...overrides,
      },
    })

    it("账号不存在抛 400（不暴露存在性）", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue(null)

      await expect(service.login(dto)).rejects.toThrow("邮箱或密码错误")
    })

    it("密码错误抛 400", async () => {
      const hashed = await argon2.hash("correct")
      prisma.emailAccount.findUnique.mockResolvedValue(accountWith({ password: hashed }))

      await expect(service.login({ ...dto, password: "wrong" })).rejects.toThrow("邮箱或密码错误")
    })

    it("账号停用抛 400", async () => {
      const hashed = await argon2.hash("Passw0rd!")
      prisma.emailAccount.findUnique.mockResolvedValue(
        accountWith({ password: hashed, isActive: false })
      )

      await expect(service.login(dto)).rejects.toThrow("账号已停用")
    })

    it("登录成功回写 lastLoginAt 并签发 token（带角色与组织）", async () => {
      const hashed = await argon2.hash("Passw0rd!")
      prisma.emailAccount.findUnique.mockResolvedValue(
        accountWith({
          password: hashed,
          roles: [{ role: { code: "USER" } }],
          orgs: [{ orgId: 5 }],
        })
      )

      const result = await service.login(dto)

      expect(result).toEqual({ access_token: "test-token" })
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { lastLoginAt: expect.any(Date) },
      })
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: 10,
        phone: "91234567890",
        roleCode: "USER",
        currentOrgId: 5,
      })
    })
  })

  describe("forgotPassword", () => {
    it("邮箱注册账号发送 RESET 码", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue({ id: 1 })

      const result = await service.forgotPassword("a@example.com")

      expect(emailCode.send).toHaveBeenCalledWith("a@example.com", "RESET")
      expect(result.message).toContain("验证码已发送")
    })

    it("非邮箱注册账号不发送，但响应话术一致（防枚举）", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue(null)

      const result = await service.forgotPassword("a@example.com")

      expect(emailCode.send).not.toHaveBeenCalled()
      expect(result.message).toContain("验证码已发送")
    })
  })

  describe("resetPassword", () => {
    const dto = { email: "a@example.com", emailCode: "123456", newPassword: "NewPassw0rd!" }

    it("账号不存在与验证码无效同话术，且不核销", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue(null)

      await expect(service.resetPassword(dto)).rejects.toThrow("验证码无效或已过期")
      expect(emailCode.consume).not.toHaveBeenCalled()
    })

    it("验证码错误抛 400", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue({ userId: 10 })
      emailCode.consume.mockResolvedValue(false)

      await expect(service.resetPassword(dto)).rejects.toThrow("验证码无效或已过期")
    })

    it("重置成功写新密码并清除强制改密标记", async () => {
      prisma.emailAccount.findUnique.mockResolvedValue({ userId: 10 })
      emailCode.consume.mockResolvedValue(true)

      const result = await service.resetPassword(dto)

      expect(emailCode.consume).toHaveBeenCalledWith("a@example.com", "123456", "RESET")
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { password: expect.any(String), mustChangePassword: false },
      })
      expect(result.message).toContain("密码已重置")
    })
  })
})
