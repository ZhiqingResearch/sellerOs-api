import { BadRequestException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { CreditBucket, CreditLotStatus, CreditTxnType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { CreditService } from "../membership/credit.service"
import { DAY_MS, PACKAGE_EXPIRE_DAYS } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { TeamPoolService } from "./team-pool.service"

type TxnCreate = {
  data: {
    userId: number
    direction: string
    bucket: string
    type: string
    amount: number
    balanceAfter: Decimal
    source: string
    teamId: number
  }
}

/** jest.Mock 的 calls 为 any；提取第 n 次调用实参并显式收窄类型后断言 */
const callArgs = <T extends unknown[]>(mock: jest.Mock, call: number): T => {
  const calls = mock.mock.calls as unknown[][]
  return calls[call] as T
}

describe("TeamPoolService", () => {
  let service: TeamPoolService
  let prisma: {
    creditLot: { groupBy: jest.Mock; aggregate: jest.Mock; create: jest.Mock; update: jest.Mock }
    creditTransaction: { create: jest.Mock }
    $queryRaw: jest.Mock
    $transaction: jest.Mock
  }
  let credit: { recordRecharge: jest.Mock; teamPoolBalance: jest.Mock }

  beforeEach(async () => {
    prisma = {
      creditLot: {
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      creditTransaction: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
    }
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma))
    credit = {
      recordRecharge: jest.fn().mockResolvedValue(undefined),
      teamPoolBalance: jest.fn().mockResolvedValue(new Decimal(1000)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        TeamPoolService,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: credit },
      ],
    }).compile()
    service = moduleRef.get(TeamPoolService)
  })

  describe("grantPool", () => {
    it("三类积分组合为一条 TEAM_RECHARGE 入账，teamId 透传 CreditService", async () => {
      const exp = new Date("2026-09-19T00:00:00.000Z")

      await service.grantPool(1, {
        ownerUserId: 100,
        packageCredits: 5000,
        giftCredits: 200,
        rechargeCredits: 2000,
        packageExpiresAt: exp,
        source: "order.123",
        sourceRef: "ref-1",
        meta: { orderId: 123 },
      })

      expect(credit.recordRecharge).toHaveBeenCalledWith(
        100,
        {
          type: CreditTxnType.TEAM_RECHARGE,
          source: "order.123",
          sourceRef: "ref-1",
          lots: [
            { bucket: CreditBucket.PACKAGE, amount: 5000, expiresAt: exp },
            { bucket: CreditBucket.GIFT, amount: 200, expiresAt: exp },
            { bucket: CreditBucket.RECHARGE, amount: 2000, expiresAt: null },
          ],
          meta: { orderId: 123 },
          teamId: 1,
        },
        undefined
      )
    })

    it("未指定过期时点：套餐/赠送批次默认约 30 天后过期", async () => {
      const before = Date.now()
      await service.grantPool(1, { ownerUserId: 100, packageCredits: 5000, source: "s" })
      const after = Date.now()

      const [, opts] = callArgs<[number, { lots: { expiresAt: Date }[] }]>(credit.recordRecharge, 0)
      expect(opts.lots[0].expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + PACKAGE_EXPIRE_DAYS * DAY_MS
      )
      expect(opts.lots[0].expiresAt.getTime()).toBeLessThanOrEqual(
        after + PACKAGE_EXPIRE_DAYS * DAY_MS
      )
    })

    it("自定义流水类型与 tx 透传", async () => {
      const tx = { tag: "tx" }
      await service.grantPool(
        1,
        { ownerUserId: 100, rechargeCredits: 500, source: "s", type: CreditTxnType.MANUAL_ADJUST },
        tx as never
      )

      const [userId, opts, txArg] = callArgs<
        [
          number,
          { type: string; lots: { bucket: string; amount: number; expiresAt: null }[] },
          unknown,
        ]
      >(credit.recordRecharge, 0)
      expect(userId).toBe(100)
      expect(opts.type).toBe(CreditTxnType.MANUAL_ADJUST)
      expect(opts.lots).toEqual([{ bucket: CreditBucket.RECHARGE, amount: 500, expiresAt: null }])
      expect(txArg).toBe(tx)
    })

    it("无有效积分（全为 0/未传）直接返回，不入账", async () => {
      await service.grantPool(1, { ownerUserId: 100, source: "s" })
      await service.grantPool(1, {
        ownerUserId: 100,
        packageCredits: 0,
        giftCredits: 0,
        rechargeCredits: 0,
        source: "s",
      })
      expect(credit.recordRecharge).not.toHaveBeenCalled()
    })
  })

  describe("池余额查询", () => {
    it("poolBalance 委托 credit.teamPoolBalance 并透传 tx", async () => {
      credit.teamPoolBalance.mockResolvedValue(new Decimal(123))
      const tx = { tag: "tx" }

      const res = await service.poolBalance(1, tx as never)

      expect(credit.teamPoolBalance).toHaveBeenCalledWith(1, tx)
      expect(res.toString()).toBe("123")
    })

    it("poolBuckets 按桶聚合，缺桶补 0，total 为三桶合计", async () => {
      prisma.creditLot.groupBy.mockResolvedValue([
        { bucket: CreditBucket.PACKAGE, _sum: { remaining: new Decimal(10) } },
        { bucket: CreditBucket.RECHARGE, _sum: { remaining: new Decimal(5) } },
      ])

      const res = await service.poolBuckets(1)

      const [groupByArg] = callArgs<[{ where: { teamId: number; status: string } }]>(
        prisma.creditLot.groupBy,
        0
      )
      expect(groupByArg.where).toMatchObject({ teamId: 1, status: CreditLotStatus.ACTIVE })
      expect(res.package.toString()).toBe("10")
      expect(res.gift.toString()).toBe("0")
      expect(res.recharge.toString()).toBe("5")
      expect(res.total.toString()).toBe("15")
    })

    it("poolBuckets 传 tx 时走 tx 而非全局 prisma", async () => {
      const tx = { creditLot: { groupBy: jest.fn().mockResolvedValue([]) } }

      const res = await service.poolBuckets(1, tx as never)

      expect(tx.creditLot.groupBy).toHaveBeenCalled()
      expect(prisma.creditLot.groupBy).not.toHaveBeenCalled()
      expect(res.total.toString()).toBe("0")
    })

    it("poolBuckets includeFrozen（GRACE 展示口径）：不按到期日过滤；默认仍过滤", async () => {
      prisma.creditLot.groupBy.mockResolvedValue([])

      await service.poolBuckets(1, undefined, { includeFrozen: true })
      const frozen = callArgs<[{ where: { OR?: unknown } }]>(prisma.creditLot.groupBy, 0)[0]
      expect(frozen.where.OR).toBeUndefined()

      await service.poolBuckets(1)
      const normal = callArgs<[{ where: { OR?: unknown } }]>(prisma.creditLot.groupBy, 1)[0]
      expect(normal.where.OR).toBeDefined()
    })

    it("poolGrantedTotal 聚合全部批次 amount；无批次为 0", async () => {
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(7000) } })
      const total = await service.poolGrantedTotal(1)
      expect(total.toString()).toBe("7000")

      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { amount: null } })
      const empty = await service.poolGrantedTotal(1)
      expect(empty.toString()).toBe("0")
    })
  })

  describe("adjustPoolRecharge", () => {
    it("调整积分必须为非零整数", async () => {
      await expect(service.adjustPoolRecharge(1, 100, 0)).rejects.toThrow("调整积分必须为非零整数")
      await expect(service.adjustPoolRecharge(1, 100, 1.5)).rejects.toThrow(BadRequestException)
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it("正向调整：追加 RECHARGE 批次（永不过期）+ CREDIT 流水", async () => {
      await service.adjustPoolRecharge(1, 100, 5000, { source: "admin.team.adjust" })

      expect(prisma.creditLot.create).toHaveBeenCalledWith({
        data: {
          userId: 100,
          bucket: CreditBucket.RECHARGE,
          amount: 5000,
          remaining: 5000,
          expiresAt: null,
          sourceType: CreditTxnType.MANUAL_ADJUST,
          status: CreditLotStatus.ACTIVE,
          teamId: 1,
        },
      })
      expect(credit.teamPoolBalance).toHaveBeenCalledWith(1, prisma)
      const [txn] = callArgs<[TxnCreate]>(prisma.creditTransaction.create, 0)
      expect(txn.data).toMatchObject({
        userId: 100,
        direction: "CREDIT",
        bucket: CreditBucket.RECHARGE,
        type: CreditTxnType.MANUAL_ADJUST,
        amount: 5000,
        balanceAfter: new Decimal(1000),
        source: "admin.team.adjust",
        teamId: 1,
      })
    })

    it("负向调整：FIFO 扣减——先扣完旧批次置 EXHAUSTED，再扣下一批次", async () => {
      prisma.$queryRaw.mockResolvedValue([
        { id: 1, remaining: new Decimal(20) },
        { id: 2, remaining: new Decimal(20) },
      ])

      await service.adjustPoolRecharge(1, 100, -30)

      expect(prisma.creditLot.update).toHaveBeenCalledTimes(2)
      expect(prisma.creditLot.update).toHaveBeenNthCalledWith(1, {
        where: { id: 1 },
        data: { remaining: new Decimal(0), status: CreditLotStatus.EXHAUSTED },
      })
      expect(prisma.creditLot.update).toHaveBeenNthCalledWith(2, {
        where: { id: 2 },
        data: { remaining: new Decimal(10), status: CreditLotStatus.ACTIVE },
      })
      const [txn] = callArgs<[TxnCreate]>(prisma.creditTransaction.create, 0)
      expect(txn.data).toMatchObject({ direction: "DEBIT", amount: 30 })
    })

    it("负向调整：欠账负批次跳过但仍计入可用净额", async () => {
      prisma.$queryRaw.mockResolvedValue([
        { id: 1, remaining: new Decimal(-5) },
        { id: 2, remaining: new Decimal(20) },
      ])

      await service.adjustPoolRecharge(1, 100, -10)

      // 可用净额 = -5 + 20 = 15 ≥ 10；负批次不扣，只扣 id=2
      expect(prisma.creditLot.update).toHaveBeenCalledTimes(1)
      expect(prisma.creditLot.update).toHaveBeenCalledWith({
        where: { id: 2 },
        data: { remaining: new Decimal(10), status: CreditLotStatus.ACTIVE },
      })
    })

    it("余额不足拦截：减少量超过池充值剩余 → 400（报文带当前可扣减余额），不落任何台账", async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 1, remaining: new Decimal(20) }])

      await expect(service.adjustPoolRecharge(1, 100, -30)).rejects.toThrow(
        "池充值积分剩余不足（当前可扣减 20），减少量不得超过剩余"
      )
      expect(prisma.creditLot.update).not.toHaveBeenCalled()
      expect(prisma.creditTransaction.create).not.toHaveBeenCalled()
    })

    it("传入 tx 时直接复用，不再开新事务", async () => {
      const tx = {
        creditLot: { create: jest.fn().mockResolvedValue({}), update: jest.fn() },
        creditTransaction: { create: jest.fn().mockResolvedValue({}) },
        $queryRaw: jest.fn(),
      }

      await service.adjustPoolRecharge(1, 100, 500, { source: "s" }, tx as never)

      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(tx.creditLot.create).toHaveBeenCalled()
      expect(tx.creditTransaction.create).toHaveBeenCalled()
    })
  })
})
