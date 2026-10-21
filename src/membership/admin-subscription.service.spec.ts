import { NotFoundException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { CreditBucket, CreditLotStatus, CreditTxnType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { AdminSubscriptionService } from "./admin-subscription.service"
import { CreditService } from "./credit.service"
import { DAY_MS } from "./membership.constants"

/** jest.Mock 的 calls 为 any；提取第 n 次调用实参并显式收窄类型后断言 */
const callArgs = <T extends unknown[]>(mock: jest.Mock, call: number): T => {
  const calls = mock.mock.calls as unknown[][]
  return calls[call] as T
}

describe("AdminSubscriptionService", () => {
  let service: AdminSubscriptionService
  let prisma: {
    $transaction: jest.Mock
    $queryRaw: jest.Mock
    user: {
      findMany: jest.Mock
      count: jest.Mock
      groupBy: jest.Mock
      findUnique: jest.Mock
      update: jest.Mock
    }
    membershipPlan: { findMany: jest.Mock }
    creditLot: { update: jest.Mock; groupBy: jest.Mock }
    creditTransaction: { create: jest.Mock }
  }
  let credit: { grant: jest.Mock; consumableBalance: jest.Mock }

  const futureRow = (id: number, daysFromNow: number) => ({
    id,
    username: `u${id}`,
    phone: "13800000000",
    email: `u${id}@x.com`,
    subscriptionTier: 1,
    subscriptionExpiresAt: new Date(Date.now() + daysFromNow * DAY_MS),
  })

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
      $queryRaw: jest.fn(),
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      membershipPlan: { findMany: jest.fn().mockResolvedValue([]) },
      creditLot: { update: jest.fn(), groupBy: jest.fn().mockResolvedValue([]) },
      creditTransaction: { create: jest.fn() },
    }
    credit = {
      grant: jest.fn(),
      consumableBalance: jest.fn().mockResolvedValue(new Decimal(850)),
      extendPlanLotExpiryInTx: jest.fn(), // 调整到期日同步顺延套餐批次（bug22）
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminSubscriptionService,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: credit },
      ],
    }).compile()
    service = moduleRef.get(AdminSubscriptionService)
  })

  describe("list", () => {
    it("默认查 Lv.1-3，到期升序（null 排最后）；行含状态推导/剩余天数/手机号脱敏", async () => {
      prisma.user.findMany.mockResolvedValue([
        futureRow(1, 10), // ACTIVE
        futureRow(2, 3), // EXPIRING
        futureRow(3, -2), // EXPIRED
        { ...futureRow(4, 0), subscriptionExpiresAt: null }, // 异常数据归 EXPIRED
      ])
      prisma.user.count.mockResolvedValue(4)

      const res = await service.list({ page: 1, pageSize: 10 })

      const [findArgs] = callArgs<[{ where: { subscriptionTier: unknown }; orderBy: unknown[] }]>(
        prisma.user.findMany,
        0
      )
      expect(findArgs.where.subscriptionTier).toEqual({ in: [1, 2, 3] })
      expect(findArgs.orderBy).toEqual([
        { subscriptionExpiresAt: { sort: "asc", nulls: "last" } },
        { id: "asc" },
      ])

      expect(res.total).toBe(4)
      expect(res.items.map(i => [i.userId, i.status, i.daysLeft])).toEqual([
        [1, "ACTIVE", 10],
        [2, "EXPIRING", 3],
        [3, "EXPIRED", -2],
        [4, "EXPIRED", null],
      ])
      expect(res.items[0].phone).toBe("138****0000")
    })

    it("行带剩余积分 points（充值+套餐+赠送批次合计，字符串；无批次为 0）", async () => {
      prisma.user.findMany.mockResolvedValue([futureRow(1, 10), futureRow(2, 3)])
      prisma.user.count.mockResolvedValue(2)
      prisma.creditLot.groupBy.mockResolvedValue([
        { userId: 1, _sum: { remaining: new Decimal(1250) } },
      ])

      const res = await service.list({ page: 1, pageSize: 10 })

      expect(res.items[0].points).toBe("1250")
      expect(res.items[1].points).toBe("0") // 无批次 → 0
      const [args] = callArgs<[{ where: { bucket: unknown; userId: unknown } }]>(
        prisma.creditLot.groupBy,
        0
      )
      expect(args.where.userId).toEqual({ in: [1, 2] })
      expect(args.where.bucket).toEqual({ in: ["RECHARGE", "PACKAGE", "GIFT"] })
    })

    it("status=EXPIRING 的 where 窗口 = (now, now+7d]", async () => {
      await service.list({ page: 1, pageSize: 10, status: "EXPIRING" })
      const [findArgs] = callArgs<
        [{ where: { AND: Array<{ subscriptionExpiresAt?: { gt: Date; lte: Date } }> } }]
      >(prisma.user.findMany, 0)
      const { gt, lte } = findArgs.where.AND[0].subscriptionExpiresAt!
      expect(lte.getTime() - gt.getTime()).toBe(7 * DAY_MS)
    })

    it("status=ACTIVE 的 where = 全部未过期（gt now 且无 lte 上界，含临期，与企业管理口径一致）", async () => {
      await service.list({ page: 1, pageSize: 10, status: "ACTIVE" })
      const [findArgs] = callArgs<
        [{ where: { AND: Array<{ subscriptionExpiresAt?: { gt?: Date; lte?: Date } }> } }]
      >(prisma.user.findMany, 0)
      const cond = findArgs.where.AND[0].subscriptionExpiresAt!
      expect(cond.gt).toBeInstanceOf(Date)
      expect(cond.lte).toBeUndefined() // 在期含临期：不带 7 天上界
    })

    it("status=EXPIRED 命中 已过期 或 expiresAt 为 null", async () => {
      await service.list({ page: 1, pageSize: 10, status: "EXPIRED" })
      const [findArgs] = callArgs<[{ where: { AND: Array<{ OR?: unknown[] }> } }]>(
        prisma.user.findMany,
        0
      )
      expect(findArgs.where.AND[0].OR).toEqual([
        { subscriptionExpiresAt: { lte: expect.any(Date) as Date } },
        { subscriptionExpiresAt: null },
      ])
    })

    it("expiresStart/expiresEnd 到期日区间：与状态筛选 AND 组合（含端点）", async () => {
      await service.list({
        page: 1,
        pageSize: 10,
        status: "ACTIVE",
        expiresStart: "2026-09-01T00:00:00.000Z",
        expiresEnd: "2026-09-30T23:59:59.999Z",
      })
      const [findArgs] = callArgs<
        [
          {
            where: {
              AND: Array<{ subscriptionExpiresAt?: { gte?: Date; lte?: Date; gt?: Date } }>
            }
          },
        ]
      >(prisma.user.findMany, 0)
      // AND[0]=状态窗口（ACTIVE: gt now，含临期），AND[1]=到期日区间
      expect(findArgs.where.AND).toHaveLength(2)
      expect(findArgs.where.AND[1].subscriptionExpiresAt?.gte).toEqual(
        new Date("2026-09-01T00:00:00.000Z")
      )
      expect(findArgs.where.AND[1].subscriptionExpiresAt?.lte).toEqual(
        new Date("2026-09-30T23:59:59.999Z")
      )
    })

    it("MRR 汇总 = Σ 各档在期人数 × 档月价（元）；未定价档（priceCny=null）按 0 计且价格回传 null", async () => {
      prisma.membershipPlan.findMany.mockResolvedValue([
        { tier: 1, name: "Explorer", priceCny: 199 },
        { tier: 2, name: "Plus", priceCny: 399 },
        { tier: 3, name: "Ultra", priceCny: null },
      ])
      prisma.user.groupBy
        .mockResolvedValueOnce([
          { subscriptionTier: 1, _count: { _all: 5 } },
          { subscriptionTier: 2, _count: { _all: 2 } },
          { subscriptionTier: 3, _count: { _all: 4 } },
        ]) // total
        .mockResolvedValueOnce([
          { subscriptionTier: 1, _count: { _all: 3 } },
          { subscriptionTier: 2, _count: { _all: 1 } },
          { subscriptionTier: 3, _count: { _all: 2 } },
        ]) // active（未过期）
        .mockResolvedValueOnce([{ subscriptionTier: 1, _count: { _all: 2 } }]) // expiring

      const res = await service.list({ page: 1, pageSize: 10 })
      const s = res.summary
      expect(s.currency).toBe("CNY")
      expect(s.mrrCny).toBe(3 * 199 + 1 * 399) // Ultra 未定价不计
      expect(s.activeSubscribers).toBe(6)
      expect(s.expiringSoon).toBe(2)
      expect(s.byTier).toEqual([
        {
          tier: 1,
          planName: "Explorer",
          priceCny: 199,
          total: 5,
          active: 3,
          expiring: 2,
          expired: 2,
          mrrCny: 597,
        },
        {
          tier: 2,
          planName: "Plus",
          priceCny: 399,
          total: 2,
          active: 1,
          expiring: 0,
          expired: 1,
          mrrCny: 399,
        },
        {
          tier: 3,
          planName: "Ultra",
          priceCny: null,
          total: 4,
          active: 2,
          expiring: 0,
          expired: 2,
          mrrCny: 0,
        },
      ])
    })
  })

  describe("exportCsv（订阅名单导出）", () => {
    it("与列表同筛选（到期日区间进 where）；CSV 带 BOM、表头固定、手机号脱敏、到期时间按 tz 格式化", async () => {
      prisma.membershipPlan.findMany.mockResolvedValue([
        { tier: 1, name: "Explorer", priceCny: 199 },
      ])
      // 10 天后到期 → 在期（>7 天临期窗口；相对当前时间，用例不随日期失效——曾用固定 2026-09-10，进入窗口期后误翻临期）
      const expiresAt = new Date(Date.now() + 10 * DAY_MS)
      prisma.user.findMany.mockResolvedValue([
        {
          ...futureRow(1, 10),
          username: "张,三", // 含逗号 → 转义
          subscriptionExpiresAt: expiresAt,
        },
      ])

      const csv = await service.exportCsv(
        {
          page: 1,
          pageSize: 10,
          expiresStart: "2026-09-01T00:00:00.000Z",
          expiresEnd: "2026-09-30T23:59:59.999Z",
        },
        "Asia/Shanghai"
      )

      // 筛选与列表同源（AND 含到期日区间）
      const [findArgs] = callArgs<[{ where: { AND?: unknown[] } }]>(prisma.user.findMany, 0)
      expect(findArgs.where.AND).toHaveLength(1)

      const lines = csv.split("\n")
      expect(lines[0]).toBe("﻿用户名,手机号,会员等级,状态,到期时间,剩余天数")
      const daysLeft = Math.ceil((expiresAt.getTime() - Date.now()) / DAY_MS)
      const expectedDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(expiresAt)
      expect(lines[1]).toBe(`"张,三",138****0000,Lv.1 Explorer,在期,${expectedDate},${daysLeft}`) // 到期时间纯日期
    })

    it("临期行：状态仅「临期」（不带括号说明）；到期时间纯日期 YYYY-MM-DD", async () => {
      prisma.membershipPlan.findMany.mockResolvedValue([{ tier: 1, name: "Explorer" }])
      const expiresAt = new Date(Date.now() + 3 * DAY_MS) // 3 天后到期 → 临期（相对当前时间，用例不随日期失效）
      prisma.user.findMany.mockResolvedValue([
        { ...futureRow(4, 3), subscriptionTier: 1, subscriptionExpiresAt: expiresAt },
      ])

      const csv = await service.exportCsv({ page: 1, pageSize: 10 }, "Asia/Shanghai")
      const line = csv.split("\n")[1]
      expect(line).toContain(",临期,")
      expect(line).not.toContain("（")
      const expectedDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(expiresAt)
      expect(line).toContain(`,${expectedDate},`) // 纯日期
      expect(line).not.toMatch(/\d{2}:\d{2}/) // 不带时分
    })

    it("已过期行：状态=已过期、剩余天数为负；无到期时刻的异常行留空", async () => {
      prisma.membershipPlan.findMany.mockResolvedValue([])
      prisma.user.findMany.mockResolvedValue([
        { ...futureRow(2, -2), subscriptionTier: 2 },
        { ...futureRow(3, 0), subscriptionExpiresAt: null },
      ])

      const csv = await service.exportCsv({ page: 1, pageSize: 10 }, "Asia/Shanghai")
      const lines = csv.split("\n")
      expect(lines[1]).toContain("Lv.2")
      expect(lines[1]).toContain("已过期")
      expect(lines[1].endsWith(",-2")).toBe(true) // 剩余天数为负
      expect(lines[2].endsWith(",,")).toBe(true) // 无到期时刻：到期时间/剩余天数留空
    })
  })

  describe("adjust", () => {
    const mockUser = (expiresAt: Date | null = new Date(Date.now() + 10 * DAY_MS)) => {
      prisma.user.findUnique.mockResolvedValue({ id: 7, subscriptionExpiresAt: expiresAt })
    }

    it("两项都不传 → 400；giftCredits=0 → 400", async () => {
      await expect(service.adjust(7, 99, {})).rejects.toThrow("没有需要调整的内容")
      await expect(service.adjust(7, 99, { giftCredits: 0 })).rejects.toThrow("调整积分不能为 0")
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it("用户不存在 → 404", async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      await expect(service.adjust(7, 99, { giftCredits: 100 })).rejects.toThrow(NotFoundException)
    })

    it("正赠送：走 credit.grant（GIFT 桶 / MANUAL_ADJUST / 客服补偿赠送 / 30 天过期 / meta.compensation）", async () => {
      mockUser()
      const res = await service.adjust(7, 99, { giftCredits: 500, reason: "投诉补偿" })

      const [userId, bucket, amount, opts, tx] = callArgs<
        [
          number,
          CreditBucket,
          number,
          {
            type: CreditTxnType
            source: string
            expiresAt: Date
            meta: Record<string, unknown>
          },
          unknown,
        ]
      >(credit.grant, 0)
      expect([userId, bucket, amount]).toEqual([7, CreditBucket.GIFT, 500])
      expect(opts.type).toBe(CreditTxnType.MANUAL_ADJUST)
      expect(opts.source).toBe("客服补偿赠送")
      // 30 天过期（允许秒级误差）
      expect(Math.abs(opts.expiresAt.getTime() - (Date.now() + 30 * DAY_MS))).toBeLessThan(60_000)
      expect(opts.meta).toMatchObject({
        compensation: true,
        reason: "投诉补偿",
        giftCredits: 500,
        operatorId: 99,
      })
      expect(tx).toBe(prisma) // 复用外层事务
      expect(res).toEqual({
        userId: 7,
        giftCredits: 500,
        extendDays: null,
        subscriptionExpiresAt: null,
      })
    })

    it("负赠送：FOR UPDATE 锁读 PACKAGE+GIFT 批次，FIFO 扣减并写 DEBIT 流水（bucket=null）", async () => {
      mockUser()
      prisma.$queryRaw.mockResolvedValue([
        { id: 1, remaining: new Decimal(100) },
        { id: 2, remaining: new Decimal(200) },
      ])

      await service.adjust(7, 99, { giftCredits: -150 })

      // lot1 扣空 → EXHAUSTED；lot2 扣 50 → ACTIVE
      const upd1 = callArgs<
        [{ where: { id: number }; data: { remaining: Decimal; status: CreditLotStatus } }]
      >(prisma.creditLot.update, 0)[0]
      const upd2 = callArgs<
        [{ where: { id: number }; data: { remaining: Decimal; status: CreditLotStatus } }]
      >(prisma.creditLot.update, 1)[0]
      expect(upd1.where.id).toBe(1)
      expect(upd1.data.remaining.toString()).toBe("0")
      expect(upd1.data.status).toBe(CreditLotStatus.EXHAUSTED)
      expect(upd2.where.id).toBe(2)
      expect(upd2.data.remaining.toString()).toBe("150")
      expect(upd2.data.status).toBe(CreditLotStatus.ACTIVE)

      const [txnData] = callArgs<[{ data: Record<string, unknown> }]>(
        prisma.creditTransaction.create,
        0
      )
      expect(txnData.data).toMatchObject({
        userId: 7,
        direction: "DEBIT",
        bucket: null,
        type: CreditTxnType.MANUAL_ADJUST,
        source: "客服补偿赠送",
      })
      expect((txnData.data.amount as Decimal).toString()).toBe("150")
      expect((txnData.data.meta as Record<string, unknown>).compensation).toBe(true)
    })

    it("负赠送超过赠送余额 → 400 且不扣", async () => {
      mockUser()
      prisma.$queryRaw.mockResolvedValue([{ id: 1, remaining: new Decimal(100) }])
      await expect(service.adjust(7, 99, { giftCredits: -150 })).rejects.toThrow("赠送积分余额不足")
      expect(prisma.creditLot.update).not.toHaveBeenCalled()
    })

    it("延长有效期：在当前到期时刻顺延；纯延长写一条 0 积分流水", async () => {
      const base = new Date(Date.now() + 10 * DAY_MS)
      mockUser(base)

      const res = await service.adjust(7, 99, { extendDays: 30 })

      const [updateArgs] = callArgs<[{ data: { subscriptionExpiresAt: Date } }]>(
        prisma.user.update,
        0
      )
      expect(updateArgs.data.subscriptionExpiresAt.getTime()).toBe(base.getTime() + 30 * DAY_MS)
      const [txnData] = callArgs<[{ data: Record<string, unknown> }]>(
        prisma.creditTransaction.create,
        0
      )
      expect(txnData.data).toMatchObject({
        type: CreditTxnType.MANUAL_ADJUST,
        source: "客服补偿赠送",
        direction: "CREDIT",
      })
      expect((txnData.data.amount as number).toString()).toBe("0")
      expect(res.subscriptionExpiresAt).toBe(new Date(base.getTime() + 30 * DAY_MS).toISOString())
      // bug22（2026-09-02）：调整到期日同步顺延套餐批次（RECHARGE_PLAN 来源 PACKAGE/GIFT，只延不缩）
      expect(credit.extendPlanLotExpiryInTx).toHaveBeenCalledWith(
        expect.anything(),
        7,
        new Date(base.getTime() + 30 * DAY_MS)
      )
    })

    it("从未订阅过（expiresAt=null）延长：以现在为基准", async () => {
      mockUser(null)
      const before = Date.now()
      await service.adjust(7, 99, { extendDays: 30 })
      const [updateArgs] = callArgs<[{ data: { subscriptionExpiresAt: Date } }]>(
        prisma.user.update,
        0
      )
      const t = updateArgs.data.subscriptionExpiresAt.getTime()
      expect(t).toBeGreaterThanOrEqual(before + 30 * DAY_MS)
      expect(t).toBeLessThan(Date.now() + 30 * DAY_MS + 60_000)
    })

    it("赠送 + 延长同时传：只由 grant 写一条流水，service 不再补第二条", async () => {
      mockUser()
      await service.adjust(7, 99, { giftCredits: 100, extendDays: 15 })
      expect(credit.grant).toHaveBeenCalledTimes(1)
      expect(prisma.user.update).toHaveBeenCalledTimes(1)
      expect(prisma.creditTransaction.create).not.toHaveBeenCalled()
    })
  })
})
