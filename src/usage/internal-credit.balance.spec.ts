import { INestApplication, ValidationPipe } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { Decimal } from "@prisma/client/runtime/library"
import request from "supertest"
import { CreditService } from "../membership/credit.service"
import { WalletService } from "../membership/wallet.service"
import { PrismaService } from "../prisma/prisma.service"
import { quotaMonthOf } from "../team/team.constants"
import { InternalCreditController } from "./internal-credit.controller"
import { UsageService } from "./usage.service"

describe("VidFlowOS 钱包额度接口", () => {
  let app: INestApplication
  const originalToken = process.env.INTERNAL_GENERATION_TOKEN
  const prisma = {
    user: { findUnique: jest.fn() },
    teamMember: { findFirst: jest.fn(), count: jest.fn() },
    userOrganization: { findMany: jest.fn() },
    creditLot: { groupBy: jest.fn(), aggregate: jest.fn(), findMany: jest.fn() },
    creditTransaction: { aggregate: jest.fn() },
  }
  const usage = { chargeModel: jest.fn() }
  const credit = { getWallet: jest.fn() }
  const personalWallet = (balance = "123.45") => ({
    level: "NONE",
    total: new Decimal(balance),
    buckets: {
      recharge: new Decimal(balance),
      package: new Decimal(0),
      gift: new Decimal(0),
      rebate: new Decimal(20),
    },
    monthUsed: new Decimal("12.5"),
    totalConsumed: new Decimal("30.5"),
    nextExpireAt: null,
    nextExpireAmount: null,
    discount: new Decimal("0.8"),
    rebateRate: new Decimal(0),
    subscriptionExpiresAt: null,
    inviter: null,
    inviterShareCredits: null,
  })
  const path = "/api/internal/credits/balance"
  const member = (monthlyQuota: number | null = 1000, used = "123.45", status = "ACTIVE") => ({
    role: "MEMBER",
    monthlyQuota,
    quotaUsedThisMonth: new Decimal(used),
    quotaMonth: quotaMonthOf(),
    team: {
      id: 42,
      name: "测试企业",
      status,
      quotaMode: "SHARED",
      overLimitPolicy: "BLOCK",
      discount: new Decimal(1),
      admin: { username: "管理员" },
    },
  })

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [InternalCreditController],
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: credit },
        { provide: UsageService, useValue: usage },
      ],
    }).compile()
    app = module.createNestApplication({ logger: false })
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.listen(0, "127.0.0.1")
  })
  beforeEach(() => {
    jest.clearAllMocks()
    credit.getWallet.mockResolvedValue(personalWallet())
    process.env.INTERNAL_GENERATION_TOKEN = "test-internal-token"
    prisma.user.findUnique.mockResolvedValue({ id: 7, canInvite: false })
    prisma.teamMember.findFirst.mockReset().mockResolvedValue(member())
    prisma.teamMember.count.mockResolvedValue(3)
    prisma.userOrganization.findMany.mockResolvedValue([])
    prisma.creditLot.findMany.mockResolvedValue([])
    prisma.creditLot.groupBy.mockResolvedValue([
      { bucket: "RECHARGE", _sum: { remaining: new Decimal(500) } },
    ])
    prisma.creditLot.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(2000) } })
    prisma.creditTransaction.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(0) } })
  })
  afterAll(async () => {
    if (originalToken === undefined) delete process.env.INTERNAL_GENERATION_TOKEN
    else process.env.INTERNAL_GENERATION_TOKEN = originalToken
    await app.close()
  })

  function query(queryString = "?phone=13800001234") {
    return request(app.getHttpServer())
      .get(path + queryString)
      .set("X-Internal-Token", "test-internal-token")
  }

  it("与 membership/wallet 字段一致，剩余额度受池余额限制，不发起扣费", async () => {
    prisma.creditLot.findMany.mockResolvedValue([
      {
        id: 1,
        bucket: "RECHARGE",
        sourceType: "MANUAL_ADJUST",
        sourceRef: null,
        amount: new Decimal(200),
        remaining: new Decimal("123.45"),
        grantedAt: new Date("2026-09-01T00:00:00.000Z"),
        expiresAt: null,
        status: "ACTIVE",
      },
    ])
    const wallet = await app.get(WalletService).getWallet(7)
    credit.getWallet.mockClear()
    await query("?phone=%2013800001234%20").expect(
      200,
      JSON.parse(
        JSON.stringify({
          ...wallet,
          userId: 7,
          teamId: 42,
          teamStatus: "ACTIVE",
          totalQuota: "1000",
          remainingQuota: "500",
          quotaMode: "SHARED",
          overLimitPolicy: "BLOCK",
        })
      )
    )
    expect(credit.getWallet).toHaveBeenCalledTimes(1)
    expect(wallet.team!.myAvailable).toBe("500")
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { phone: "13800001234" },
      select: { id: true },
    })
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it.each([
    [1000, "123.45", "2000", "1000", "876.55"],
    [null, "123.45", "500", null, "500"],
    [0, "0", "500", "0", "0"],
    [1000, "1200.25", "500", "1000", "0"],
    [1000, "0", "0", "1000", "0"],
  ])("配额=%s，已用=%s，池余额=%s", async (quota, used, pool, totalQuota, remainingQuota) => {
    prisma.teamMember.findFirst.mockResolvedValue(member(quota, used))
    prisma.creditLot.groupBy.mockResolvedValue([
      { bucket: "RECHARGE", _sum: { remaining: new Decimal(pool) } },
    ])
    const response = await query().expect(200)
    expect(response.body).toMatchObject({ totalQuota, remainingQuota })
  })

  it.each(["GRACE", "ARCHIVED"])("沿用钱包的 %s 身份及余额展示", async status => {
    const membership = member(1000, "123.45", status)
    if (status === "ARCHIVED") {
      prisma.teamMember.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(membership)
      prisma.creditLot.groupBy.mockResolvedValue([])
    } else prisma.teamMember.findFirst.mockResolvedValue(membership)
    const response = await query().expect(200)
    expect(response.body).toMatchObject({
      teamStatus: status,
      totalQuota: "1000",
      remainingQuota: status === "GRACE" ? "500" : "0",
    })
  })

  it("北京月初即时重算，直接沿用钱包跨月口径", async () => {
    jest.useFakeTimers({ now: Date.parse("2026-09-30T15:59:59.999Z") })
    try {
      prisma.teamMember.findFirst.mockResolvedValue(member(1000, "900"))
      const wallet = app.get(WalletService)
      await expect(wallet.getWalletWithQuota(7)).resolves.toMatchObject({ remainingQuota: "100" })
      jest.setSystemTime(Date.parse("2026-09-30T16:00:00.000Z"))
      await expect(wallet.getWalletWithQuota(7)).resolves.toMatchObject({ remainingQuota: "500" })
    } finally {
      jest.useRealTimers()
    }
  })

  it.each(["", "?phone=", "?phone=abc", "?phone=13800001234&phone=13900001234"])(
    "手机号无效返回 400：%s",
    async queryString => {
      await query(queryString).expect(400)
      expect(prisma.user.findUnique).not.toHaveBeenCalled()
    }
  )

  it("未注册手机号返回 404 USER_NOT_FOUND", async () => {
    prisma.user.findUnique.mockResolvedValue(null)
    const response = await query().expect(404)
    expect(response.body).toEqual({ code: "USER_NOT_FOUND", message: "该手机号未注册" })
    expect(prisma.teamMember.findFirst).not.toHaveBeenCalled()
  })

  it.each(["123.45", "0", "-3.5"])("个人钱包余额 %s：返回 200 且总额度为 null", async balance => {
    prisma.teamMember.findFirst.mockResolvedValue(null)
    credit.getWallet.mockResolvedValue(personalWallet(balance))
    await query().expect(
      200,
      JSON.parse(
        JSON.stringify({
          ...personalWallet(balance),
          userId: 7,
          identity: "NONE",
          canInvite: false,
          team: null,
          lots: [],
          teamId: null,
          teamStatus: null,
          totalQuota: null,
          remainingQuota: balance,
          quotaMode: null,
          overLimitPolicy: null,
        })
      )
    )
    expect(credit.getWallet).toHaveBeenCalledTimes(1)
    expect(credit.getWallet).toHaveBeenCalledWith(7)
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("缺失、错误令牌及未配置令牌均沿用视频转发的 503，拒绝查库", async () => {
    await request(app.getHttpServer()).get(`${path}?phone=13800001234`).expect(503)
    await query().set("X-Internal-Token", "wrong-token").expect(503)
    delete process.env.INTERNAL_GENERATION_TOKEN
    await query().expect(503)
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
    expect(prisma.teamMember.findFirst).not.toHaveBeenCalled()
  })
})
