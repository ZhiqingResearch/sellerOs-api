/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest 匹配器（expect.any/stringMatching）返回 any */
import { BadRequestException } from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { Test } from "@nestjs/testing"
import { createHash } from "node:crypto"
import { PrismaService } from "../prisma/prisma.service"
import { AuthSsoService } from "./auth-sso.service"

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex")

describe("AuthSsoService", () => {
  let service: AuthSsoService
  let prisma: {
    authHandoffCode: { updateMany: jest.Mock; create: jest.Mock; findUnique: jest.Mock }
    user: { findUnique: jest.Mock }
    $transaction: jest.Mock
  }
  let jwtService: { sign: jest.Mock }

  beforeEach(async () => {
    prisma = {
      authHandoffCode: {
        updateMany: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
      },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    }
    jwtService = { sign: jest.fn().mockReturnValue("test-token") }

    const module = await Test.createTestingModule({
      providers: [
        AuthSsoService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwtService },
      ],
    }).compile()

    service = module.get(AuthSsoService)
  })

  describe("handoff", () => {
    it("签发 256-bit 高熵 code，库内只落 sha256 哈希，60s 有效", async () => {
      const result = await service.handoff(7)

      expect(result.expiresIn).toBe(60)
      expect(result.handoffCode).toMatch(/^[A-Za-z0-9_-]{43}$/) // base64url(32 bytes)
      expect(prisma.authHandoffCode.create).toHaveBeenCalledWith({
        data: {
          codeHash: sha256Hex(result.handoffCode),
          userId: 7,
          expiresAt: expect.any(Date),
        },
      })
    })

    it("签发前作废该用户旧未用 code（防堆积）", async () => {
      await service.handoff(7)

      expect(prisma.authHandoffCode.updateMany).toHaveBeenCalledWith({
        where: { userId: 7, usedAt: null },
        data: { usedAt: expect.any(Date) },
      })
    })
  })

  describe("exchange", () => {
    const validRecord = {
      id: 1,
      userId: 10,
      usedAt: null,
      expiresAt: new Date(Date.now() + 30 * 1000),
    }
    const validUser = {
      id: 10,
      phone: "91234567890",
      isActive: true,
      roles: [{ role: { code: "USER" } }],
      orgs: [{ orgId: 5 }],
    }

    it("核销成功：原子置 usedAt 并按登录口径签发 token", async () => {
      prisma.authHandoffCode.findUnique.mockResolvedValue(validRecord)
      prisma.user.findUnique.mockResolvedValue(validUser)
      prisma.authHandoffCode.updateMany.mockResolvedValue({ count: 1 })

      const result = await service.exchange("some-code")

      expect(result).toEqual({ access_token: "test-token" })
      expect(prisma.authHandoffCode.findUnique).toHaveBeenCalledWith({
        where: { codeHash: sha256Hex("some-code") },
      })
      expect(prisma.authHandoffCode.updateMany).toHaveBeenCalledWith({
        where: { id: 1, usedAt: null },
        data: { usedAt: expect.any(Date) },
      })
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: 10,
        phone: "91234567890",
        roleCode: "USER",
        currentOrgId: 5,
      })
    })

    it("code 不存在 / 已用 / 已过期统一 400 同话术（防枚举）", async () => {
      prisma.user.findUnique.mockResolvedValue(validUser)
      prisma.authHandoffCode.updateMany.mockResolvedValue({ count: 1 })

      prisma.authHandoffCode.findUnique.mockResolvedValueOnce(null)
      await expect(service.exchange("nope")).rejects.toThrow("登录链接无效或已过期，请重新登录")

      prisma.authHandoffCode.findUnique.mockResolvedValueOnce({
        ...validRecord,
        usedAt: new Date(),
      })
      await expect(service.exchange("used")).rejects.toThrow(BadRequestException)

      prisma.authHandoffCode.findUnique.mockResolvedValueOnce({
        ...validRecord,
        expiresAt: new Date(Date.now() - 1000),
      })
      await expect(service.exchange("expired")).rejects.toThrow(BadRequestException)
    })

    it("用户不存在或已停用不放行", async () => {
      prisma.authHandoffCode.findUnique.mockResolvedValue(validRecord)
      prisma.authHandoffCode.updateMany.mockResolvedValue({ count: 1 })

      prisma.user.findUnique.mockResolvedValueOnce(null)
      await expect(service.exchange("x")).rejects.toThrow(BadRequestException)

      prisma.user.findUnique.mockResolvedValueOnce({ ...validUser, isActive: false })
      await expect(service.exchange("x")).rejects.toThrow(BadRequestException)
    })

    it("并发核销（条件 updateMany 未命中 count=0）失败", async () => {
      prisma.authHandoffCode.findUnique.mockResolvedValue(validRecord)
      prisma.user.findUnique.mockResolvedValue(validUser)
      prisma.authHandoffCode.updateMany.mockResolvedValue({ count: 0 })

      await expect(service.exchange("race")).rejects.toThrow(BadRequestException)
    })
  })
})
