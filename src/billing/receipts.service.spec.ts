import { ConfigService } from "@nestjs/config"
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest 匹配器（expect.any/stringMatching/objectContaining）返回 any */
import { BadRequestException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { CreditDirection, MembershipLevel, PaymentChannel } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { BillingMailService } from "./billing-mail.service"
import { ReceiptPdfService } from "./receipt-pdf.service"
import { ReceiptsService } from "./receipts.service"

/** 收据接收邮箱：下单指定 > 账号邮箱；重发可改发新邮箱；补开可指定。 */
describe("ReceiptsService（收据邮箱）", () => {
  let service: ReceiptsService
  let prisma: {
    billingOrder: { findUnique: jest.Mock }
    creditTransaction: { findUnique: jest.Mock }
    user: { findUnique: jest.Mock; update: jest.Mock }
    emailAccount: { findUnique: jest.Mock }
    receipt: {
      create: jest.Mock
      findFirst: jest.Mock
      findUnique: jest.Mock
      update: jest.Mock
    }
  }
  let billingMail: { sendReceiptMail: jest.Mock }
  let createdReceipt: {
    id: number
    receiptNo: string
    userId?: number
    email: string
    snapshot: unknown
  } | null

  const miniSnapshot = {
    receiptNo: "SR9",
    orderNo: null,
    issuedAt: "2026-08-22T10:00:00.000Z",
    paidAt: "2026-08-22T10:00:00.000Z",
    payer: {
      username: "张明",
      level: "普通用户",
      account: "13800000000",
      title: "张明（个人）",
      email: "",
    },
    payee: "SellerOS 跨境卖家运营平台",
    channelLabel: "微信支付",
    items: [],
    totalCny: 199,
    amountUsdCents: null,
    fxRate: null,
    totalCredits: 1990,
    amountUpper: "壹佰玖拾玖元整",
    note: "",
  }

  const baseOrder = {
    id: 1,
    orderNo: "SR20260822001",
    userId: 7,
    type: "PACK",
    channel: PaymentChannel.WECHAT,
    amountCny: new Decimal("199"),
    fxRate: null,
    amountUsdCents: null,
    creditsTotal: 1990,
    paidAt: new Date("2026-08-22T10:00:00Z"),
    settledAt: new Date("2026-08-22T10:00:05Z"),
    receiptEmail: null as string | null,
    items: [{ name: "充值包", detail: null, qty: 1, amountCny: new Decimal("199"), credits: 1990 }],
    user: {
      username: "张明",
      email: "zhang@x.com",
      receiptEmail: null as string | null,
      phone: "13800000000",
      membershipLevel: MembershipLevel.NONE,
    },
    receipt: null,
  }

  beforeEach(async () => {
    createdReceipt = null
    prisma = {
      billingOrder: { findUnique: jest.fn().mockResolvedValue(baseOrder) },
      creditTransaction: { findUnique: jest.fn() },
      user: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      // 邮箱注册判定（收据邮件语言）：默认无 EmailAccount 行 = 非邮箱注册 → 中文邮件
      emailAccount: { findUnique: jest.fn().mockResolvedValue(null) },
      receipt: {
        create: jest
          .fn()
          .mockImplementation(
            ({
              data,
            }: {
              data: { receiptNo: string; email: string; userId: number; snapshot: unknown }
            }) => {
              createdReceipt = {
                id: 9,
                receiptNo: data.receiptNo,
                userId: data.userId,
                email: data.email,
                snapshot: data.snapshot,
              }
              return Promise.resolve(createdReceipt)
            }
          ),
        findFirst: jest.fn().mockResolvedValue(null),
        // sendReceiptEmail 内部按 id 重查；resend 按 receiptNo 查
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: { where: { id?: number; receiptNo?: string } }) => {
            if (where.id && createdReceipt) return Promise.resolve(createdReceipt)
            if (where.receiptNo && createdReceipt) return Promise.resolve(createdReceipt)
            return Promise.resolve(null)
          }),
        update: jest.fn().mockImplementation(({ data }: { data: { email?: string } }) => {
          if (createdReceipt && typeof data.email === "string") createdReceipt.email = data.email
          return Promise.resolve(createdReceipt)
        }),
      },
    }
    billingMail = { sendReceiptMail: jest.fn().mockResolvedValue({}) }
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReceiptsService,
        { provide: ConfigService, useValue: { get: () => "测试收款公司" } },
        { provide: PrismaService, useValue: prisma },
        { provide: ReceiptPdfService, useValue: { available: false } },
        { provide: BillingMailService, useValue: billingMail },
      ],
    }).compile()
    service = moduleRef.get(ReceiptsService)
  })

  const createEmails = () =>
    (prisma.receipt.create.mock.calls as unknown as Array<[{ data: { email: string } }]>).map(
      c => c[0].data.email
    )
  const mailTos = () =>
    (billingMail.sendReceiptMail.mock.calls as unknown as Array<[{ to: string }]>).map(c => c[0].to)
  const emailUpdates = () =>
    (prisma.receipt.update.mock.calls as unknown as Array<[{ data: { email?: string } }]>).filter(
      c => typeof c[0].data.email === "string"
    )

  it("开票：下单指定 receiptEmail 优先于账号邮箱", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue({
      ...baseOrder,
      receiptEmail: "finance@x.com",
    })
    await service.issueForOrder(1)
    expect(createEmails()).toEqual(["finance@x.com"])
    expect(mailTos()).toEqual(["finance@x.com"])
  })

  it("开票：未指定 receiptEmail 回落账号邮箱", async () => {
    await service.issueForOrder(1)
    expect(createEmails()).toEqual(["zhang@x.com"])
  })

  it("开票：团队类订单（席位升级）付款方等级固定「企业管理员」，抬头为「企业」", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue({
      ...baseOrder,
      type: "TEAM_SEAT_UPGRADE",
    })
    await service.issueForOrder(1)
    const snap = createdReceipt?.snapshot as { payer: { level: string; title: string } }
    expect(snap.payer.level).toBe("企业管理员")
    expect(snap.payer.title).toBe("张明（企业）")
  })

  it("开票：个人订单仍按 membershipLevel 映射等级", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue({
      ...baseOrder,
      user: { ...baseOrder.user, membershipLevel: MembershipLevel.LV2 },
    })
    await service.issueForOrder(1)
    const snap = createdReceipt?.snapshot as { payer: { level: string } }
    expect(snap.payer.level).toBe("Lv.2 Plus")
  })

  it("开票：0 元单（个人转企业免支付、无渠道）支付方式展示「——」；合计积分取订单 creditsTotal（含返还）", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue({
      ...baseOrder,
      type: "PERSONAL_TO_TEAM",
      channel: null, // 免支付直接结算，从未发起 Stripe 支付
      amountCny: new Decimal("0"),
      creditsTotal: 26970, // 19000 池积分 + 7970 超额返还（算价层已含返还）
    })
    await service.issueForOrder(1)
    const snap = createdReceipt?.snapshot as { channelLabel: string; totalCredits: number }
    expect(snap.channelLabel).toBe("——")
    expect(snap.totalCredits).toBe(26970)
  })

  it("开票：回落链中段——用户设了默认收据邮箱时优先于账号邮箱", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue({
      ...baseOrder,
      user: { ...baseOrder.user, receiptEmail: "receipts@x.com" },
    })
    await service.issueForOrder(1)
    expect(createEmails()).toEqual(["receipts@x.com"])
  })

  it("默认邮箱：读=设置值→账号邮箱→空串；写=保存/清除", async () => {
    prisma.user.findUnique.mockResolvedValue({ email: "acct@x.com", receiptEmail: null })
    await expect(service.getDefaultEmail(7)).resolves.toEqual({ email: "acct@x.com" })

    prisma.user.findUnique.mockResolvedValue({ email: "acct@x.com", receiptEmail: "r@x.com" })
    await expect(service.getDefaultEmail(7)).resolves.toEqual({ email: "r@x.com" })

    prisma.user.findUnique.mockResolvedValue({ email: null, receiptEmail: null })
    await expect(service.getDefaultEmail(7)).resolves.toEqual({ email: "" })

    await service.setDefaultEmail(7, "  finance@x.com ")
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { receiptEmail: "finance@x.com" },
    })
    await service.setDefaultEmail(7, "") // 空串清除
    expect(prisma.user.update).toHaveBeenLastCalledWith({
      where: { id: 7 },
      data: { receiptEmail: null },
    })
  })

  it("开票：非邮箱注册用户 → 中文收据邮件（主题/正文）", async () => {
    await service.issueForOrder(1)
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { userId: 7 },
      select: { id: true },
    })
    expect(billingMail.sendReceiptMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringMatching(/^【SellerOS】充值收据 SR/),
        html: expect.stringContaining("会员充值收据"),
      })
    )
  })

  it("开票：邮箱注册用户（有 EmailAccount 行）→ 英文收据邮件（主题/正文）", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({ id: 1 })
    await service.issueForOrder(1)
    expect(billingMail.sendReceiptMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringMatching(/^\[SellerOS\] Payment Receipt SR/),
        html: expect.stringContaining("Membership Recharge Receipt"),
      })
    )
  })

  it("开票：两处都无邮箱 → 落库空串且不邮寄", async () => {
    prisma.billingOrder.findUnique.mockResolvedValue({
      ...baseOrder,
      user: { ...baseOrder.user, email: null },
    })
    await service.issueForOrder(1)
    expect(createEmails()).toEqual([""])
    expect(billingMail.sendReceiptMail).not.toHaveBeenCalled()
  })

  it("重发：传 email 改发新邮箱并回写收据接收邮箱", async () => {
    createdReceipt = {
      id: 9,
      receiptNo: "SR9",
      userId: 7,
      email: "old@x.com",
      snapshot: miniSnapshot,
    }
    await service.resend(7, "SR9", "new@x.com")
    expect(emailUpdates().map(c => c[0].data.email)).toEqual(["new@x.com"])
    expect(mailTos()).toEqual(["new@x.com"])
  })

  it("重发：不传 email 发往收据原邮箱（回归：手工填邮箱的收据可直接重发）", async () => {
    createdReceipt = {
      id: 9,
      receiptNo: "SR9",
      userId: 7,
      email: "old@x.com",
      snapshot: miniSnapshot,
    }
    await service.resend(7, "SR9")
    expect(emailUpdates()).toEqual([])
    expect(mailTos()).toEqual(["old@x.com"])
  })

  it("重发：收据无邮箱且未传 email → 400", async () => {
    createdReceipt = { id: 9, receiptNo: "SR9", userId: 7, email: "", snapshot: miniSnapshot }
    await expect(service.resend(7, "SR9")).rejects.toBeInstanceOf(BadRequestException)
  })

  it("补开：email 参数优先于账号邮箱", async () => {
    prisma.creditTransaction.findUnique.mockResolvedValue({
      id: 5,
      userId: 7,
      direction: CreditDirection.CREDIT,
      type: "RECHARGE_CUSTOM",
      source: "admin.recharge.custom",
      amount: new Decimal("1000"),
      meta: { priceCny: 100 },
      createdAt: new Date("2026-08-20T00:00:00Z"),
    })
    prisma.user.findUnique.mockResolvedValue({
      username: "张明",
      email: null,
      phone: "13800000000",
      membershipLevel: MembershipLevel.NONE,
    })
    await service.claimFromTransaction(7, 5, "boss@x.com")
    expect(createEmails()).toEqual(["boss@x.com"])
    expect(mailTos()).toEqual(["boss@x.com"])
  })

  it("补开：手动调整（admin.recharge.manual）拒绝——无付款事实不可开收据", async () => {
    prisma.creditTransaction.findUnique.mockResolvedValue({
      id: 6,
      userId: 7,
      direction: CreditDirection.CREDIT,
      type: "MANUAL_ADJUST",
      source: "admin.recharge.manual",
      amount: new Decimal("1"),
      meta: {},
      createdAt: new Date(),
    })
    await expect(service.claimFromTransaction(7, 6)).rejects.toThrow(
      "手动调整不属于付款交易，不可开收据"
    )
  })

  it("补开：非收款类入账（注册赠送/返利等）拒绝", async () => {
    prisma.creditTransaction.findUnique.mockResolvedValue({
      id: 7,
      userId: 7,
      direction: CreditDirection.CREDIT,
      type: "SIGNUP_BONUS",
      source: "signup",
      amount: new Decimal("200"),
      meta: {},
      createdAt: new Date(),
    })
    await expect(service.claimFromTransaction(7, 7)).rejects.toThrow("该流水不可开收据")
  })
})

/** CSV 导出：8 列固定表头 + 开具时间按 tz 时区格式化 + 是否发送。 */
describe("ReceiptsService（CSV 导出）", () => {
  let service: ReceiptsService
  let prisma: { receipt: { findMany: jest.Mock } }

  const row = (over: Record<string, unknown> = {}) => ({
    receiptNo: "SR20260822001",
    createdAt: new Date("2026-08-22T10:00:00.000Z"), // UTC
    amountCny: new Decimal("199"),
    email: "a@x.com",
    emailedAt: new Date("2026-08-22T10:01:00.000Z"),
    snapshot: {
      orderNo: "BO20260822001",
      items: [{ name: "充值包 ¥199" }],
      channelLabel: "微信支付",
    },
    ...over,
  })

  beforeEach(async () => {
    prisma = { receipt: { findMany: jest.fn() } }
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReceiptsService,
        { provide: ConfigService, useValue: { get: () => "测试收款公司" } },
        { provide: PrismaService, useValue: prisma },
        { provide: ReceiptPdfService, useValue: { available: false } },
        { provide: BillingMailService, useValue: {} },
      ],
    }).compile()
    service = moduleRef.get(ReceiptsService)
  })

  it("表头 8 列且带 BOM；开具时间按 tz=Asia/Shanghai 格式化（UTC+8）", async () => {
    prisma.receipt.findMany.mockResolvedValue([row()])
    const csv = await service.exportCsv(7, "Asia/Shanghai")
    const lines = csv.split("\n")
    expect(lines[0]).toBe("﻿收据编号,订单号,开具时间,项目,支付方式,金额,接收邮箱,是否发送")
    expect(lines[1]).toBe(
      "SR20260822001,BO20260822001,2026-08-22 18:00:00,充值包 ¥199,微信支付,199.00,a@x.com,已发送"
    )
  })

  it("tz=America/New_York 时开具时间随之时区偏移（8 月 EDT=UTC-4）", async () => {
    prisma.receipt.findMany.mockResolvedValue([row()])
    const csv = await service.exportCsv(7, "America/New_York")
    expect(csv.split("\n")[1]).toContain("2026-08-22 06:00:00")
  })

  it("tz 缺省/非法均回落 Asia/Shanghai；emailedAt 为空 = 未发送", async () => {
    prisma.receipt.findMany.mockResolvedValue([row({ emailedAt: null })])
    const noTz = await service.exportCsv(7)
    expect(noTz.split("\n")[1]).toContain("2026-08-22 18:00:00")
    expect(noTz.split("\n")[1]).toContain("未发送")

    const badTz = await service.exportCsv(7, "Mars/Olympus")
    expect(badTz.split("\n")[1]).toContain("2026-08-22 18:00:00")
  })

  it("项目名含逗号时按 CSV 规则加引号转义", async () => {
    prisma.receipt.findMany.mockResolvedValue([
      row({
        snapshot: { orderNo: null, items: [{ name: "套餐,含赠送" }], channelLabel: "银行卡" },
      }),
    ])
    const csv = await service.exportCsv(7, "Asia/Shanghai")
    expect(csv.split("\n")[1]).toBe(
      'SR20260822001,,2026-08-22 18:00:00,"套餐,含赠送",银行卡,199.00,a@x.com,已发送'
    )
  })
})
