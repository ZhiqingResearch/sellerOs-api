/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest 匹配器（expect.any/stringMatching/objectContaining）返回 any */
import { BadRequestException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { MailProvider } from "../common/providers/mail.provider"
import { PrismaService } from "../prisma/prisma.service"
import { EmailAuthCodeService } from "./email-auth-code.service"

describe("EmailAuthCodeService", () => {
  let service: EmailAuthCodeService
  let prisma: {
    emailAuthCode: {
      findFirst: jest.Mock
      updateMany: jest.Mock
      update: jest.Mock
      create: jest.Mock
    }
    $transaction: jest.Mock
  }
  let mail: { sendMail: jest.Mock }

  beforeEach(async () => {
    prisma = {
      emailAuthCode: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    }
    mail = { sendMail: jest.fn().mockResolvedValue(undefined) }

    const module = await Test.createTestingModule({
      providers: [
        EmailAuthCodeService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailProvider, useValue: mail },
      ],
    }).compile()

    service = module.get(EmailAuthCodeService)
  })

  describe("send", () => {
    it("60s 内重发被限频拦截", async () => {
      prisma.emailAuthCode.findFirst.mockResolvedValue({
        createdAt: new Date(Date.now() - 30 * 1000),
      })

      await expect(service.send("a@example.com", "REGISTER")).rejects.toThrow(BadRequestException)
      expect(prisma.emailAuthCode.create).not.toHaveBeenCalled()
    })

    it("发送时作废旧码并落新码（重发仅最新可用）", async () => {
      prisma.emailAuthCode.findFirst.mockResolvedValue({
        createdAt: new Date(Date.now() - 90 * 1000),
      })

      await service.send("a@example.com", "REGISTER")

      expect(prisma.emailAuthCode.updateMany).toHaveBeenCalledWith({
        where: { email: "a@example.com", purpose: "REGISTER", used: false },
        data: { used: true },
      })
      expect(prisma.emailAuthCode.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: "a@example.com",
          purpose: "REGISTER",
          code: expect.stringMatching(/^\d{6}$/),
          expiredAt: expect.any(Date),
        }),
      })
    })

    it("邮箱归一为小写后落库", async () => {
      prisma.emailAuthCode.findFirst.mockResolvedValue(null)

      await service.send("  A@Example.COM ", "RESET")

      expect(prisma.emailAuthCode.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ email: "a@example.com", purpose: "RESET" }),
      })
    })

    it("发信走 MailProvider.sendMail，注册/重置两套文案", async () => {
      prisma.emailAuthCode.findFirst.mockResolvedValue(null)

      await service.send("a@example.com", "REGISTER")
      await new Promise(resolve => setImmediate(resolve)) // 异步发信不阻塞
      expect(mail.sendMail).toHaveBeenCalledWith(
        "a@example.com",
        "[SellerOS] Registration Verification Code",
        expect.stringContaining("registering")
      )

      await service.send("a@example.com", "RESET")
      await new Promise(resolve => setImmediate(resolve))
      expect(mail.sendMail).toHaveBeenCalledWith(
        "a@example.com",
        "[SellerOS] Password Reset Verification Code",
        expect.stringContaining("resetting")
      )
    })
  })

  describe("consume", () => {
    it("无有效码返回 false", async () => {
      prisma.emailAuthCode.findFirst.mockResolvedValue(null)

      await expect(service.consume("a@example.com", "123456", "REGISTER")).resolves.toBe(false)
    })

    it("查询按 purpose 隔离（注册码不能当重置码用）", async () => {
      prisma.emailAuthCode.findFirst.mockResolvedValue(null)

      await service.consume("a@example.com", "123456", "RESET")

      expect(prisma.emailAuthCode.findFirst).toHaveBeenCalledWith({
        where: {
          email: "a@example.com",
          purpose: "RESET",
          used: false,
          expiredAt: { gt: expect.any(Date) },
        },
        orderBy: { createdAt: "desc" },
      })
    })

    it("错码记一次 attempts 并返回 false", async () => {
      prisma.emailAuthCode.findFirst.mockResolvedValue({ id: 1, code: "999999", attempts: 0 })

      await expect(service.consume("a@example.com", "123456", "REGISTER")).resolves.toBe(false)
      expect(prisma.emailAuthCode.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { attempts: 1, used: false },
      })
    })

    it("连续错满 5 次作废当前码", async () => {
      prisma.emailAuthCode.findFirst.mockResolvedValue({ id: 1, code: "999999", attempts: 4 })

      await expect(service.consume("a@example.com", "123456", "REGISTER")).resolves.toBe(false)
      expect(prisma.emailAuthCode.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { attempts: 5, used: true },
      })
    })

    it("对码走条件 updateMany 原子核销", async () => {
      prisma.emailAuthCode.findFirst.mockResolvedValue({ id: 1, code: "123456", attempts: 0 })
      prisma.emailAuthCode.updateMany.mockResolvedValue({ count: 1 })

      await expect(service.consume("a@example.com", "123456", "REGISTER")).resolves.toBe(true)
      expect(prisma.emailAuthCode.updateMany).toHaveBeenCalledWith({
        where: { id: 1, used: false },
        data: { used: true },
      })
    })

    it("并发下条件核销未命中（count=0）返回 false", async () => {
      prisma.emailAuthCode.findFirst.mockResolvedValue({ id: 1, code: "123456", attempts: 0 })
      prisma.emailAuthCode.updateMany.mockResolvedValue({ count: 0 })

      await expect(service.consume("a@example.com", "123456", "REGISTER")).resolves.toBe(false)
    })
  })
})
