import { BadRequestException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { CreditBucket, CreditDirection, CreditLotStatus, CreditTxnType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { CreditService } from "./credit.service"

/** 从 jest.Mock 的调用记录里取每次调用的第一个实参，并断言其形状（避免 any 不安全访问） */
function firstArgs<T>(fn: jest.Mock): T[] {
  return (fn.mock.calls as unknown[][]).map(c => c[0] as T)
}

interface LotCreateArg {
  data: {
    bucket: CreditBucket
    userId: number
    amount: Decimal
    remaining: Decimal
    expiresAt?: Date | null
    sourceType?: CreditTxnType
  }
}
interface LotUpdateArg {
  where: { id: number }
  data: { status: CreditLotStatus; remaining: Decimal }
}
interface TxnCreateArg {
  data: {
    type: CreditTxnType
    userId: number
    relatedUserId?: number
    amount: Decimal
    bucket?: CreditBucket
  }
}

describe("CreditService", () => {
  let service: CreditService
  let prisma: {
    $transaction: jest.Mock
    $queryRaw: jest.Mock
    user: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock }
    creditLot: {
      create: jest.Mock
      findMany: jest.Mock
      findUnique: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
      aggregate: jest.Mock
    }
    creditTransaction: { create: jest.Mock; aggregate: jest.Mock; groupBy: jest.Mock }
    rebateRule: { findFirst: jest.Mock }
    team: { findUnique: jest.Mock }
    teamMember: { findFirst: jest.Mock }
    scheduledPlan: {
      findFirst: jest.Mock
      findMany: jest.Mock
      create: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
    }
  }

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([]),
      user: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      creditLot: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        // 默认余额充足（trueBalance 守卫用）；余额不足用例单独覆盖为 0
        aggregate: jest.fn().mockResolvedValue({ _sum: { remaining: new Decimal("1000000000") } }),
      },
      creditTransaction: {
        create: jest.fn().mockResolvedValue({}),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal(0) } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      // 默认无返利规则行 → 内核走默认（maxLayers=2 / 无封顶 / corpCounts=true）
      rebateRule: { findFirst: jest.fn().mockResolvedValue(null) },
      team: { findUnique: jest.fn().mockResolvedValue(null) },
      // 默认非企业成员（getConsumableBalanceRouted 用）
      teamMember: { findFirst: jest.fn().mockResolvedValue(null) },
      // 默认无待生效续费套餐：activateDuePlans 走零开销快路径（findFirst→null 直接收工）
      scheduledPlan: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }), // 默认抢占成功
      },
    }
    // $transaction：直接执行回调，传入 prisma 本身作为 tx
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma))

    const moduleRef = await Test.createTestingModule({
      providers: [CreditService, { provide: PrismaService, useValue: prisma }],
    }).compile()
    service = moduleRef.get(CreditService)
  })

  describe("grant", () => {
    it("建批次 + 入账流水", async () => {
      prisma.creditLot.create.mockResolvedValue({ id: 7 })
      await service.grant(1, CreditBucket.RECHARGE, 100, { type: CreditTxnType.RECHARGE_PACK })

      const lot = firstArgs<LotCreateArg>(prisma.creditLot.create)[0]
      expect(lot.data.userId).toBe(1)
      expect(lot.data.bucket).toBe(CreditBucket.RECHARGE)
      expect(lot.data.amount.toString()).toBe("100")
      expect(lot.data.remaining.toString()).toBe("100")

      const txn = firstArgs<{
        data: { direction: CreditDirection; type: CreditTxnType; lotId: number }
      }>(prisma.creditTransaction.create)[0]
      expect(txn.data.direction).toBe(CreditDirection.CREDIT)
      expect(txn.data.type).toBe(CreditTxnType.RECHARGE_PACK)
      expect(txn.data.lotId).toBe(7)
    })

    it("发放额 <= 0 抛 BadRequest", async () => {
      await expect(
        service.grant(1, CreditBucket.RECHARGE, 0, { type: CreditTxnType.MANUAL_ADJUST })
      ).rejects.toBeInstanceOf(BadRequestException)
    })
  })

  describe("adjust（手动调额）", () => {
    it("正数：新建 RECHARGE 永不过期批次 + CREDIT 流水，不扣已有批次", async () => {
      await service.adjust(1, 500, { source: "admin.recharge.manual" })

      const lot = firstArgs<LotCreateArg>(prisma.creditLot.create)[0]
      expect(lot.data.bucket).toBe(CreditBucket.RECHARGE)
      expect(lot.data.amount.toString()).toBe("500")
      expect(lot.data.expiresAt).toBeNull()
      expect(prisma.creditLot.update).not.toHaveBeenCalled()

      const txn = firstArgs<{ data: { direction: CreditDirection; amount: Decimal } }>(
        prisma.creditTransaction.create
      )[0]
      expect(txn.data.direction).toBe(CreditDirection.CREDIT)
      expect(txn.data.amount.toString()).toBe("500")
    })

    it("负数：只从 RECHARGE 桶按 FIFO 扣已有批次 + DEBIT 流水，不新建批次", async () => {
      prisma.$queryRaw.mockResolvedValue([
        { id: 5, remaining: new Decimal(300) },
        { id: 6, remaining: new Decimal(200) },
      ])

      await service.adjust(1, -250, { source: "admin.recharge.manual" })

      // 先扣最早的 id=5：300 → 扣 250 → 余 50 ACTIVE；id=6 不动
      const updates = firstArgs<LotUpdateArg>(prisma.creditLot.update)
      expect(updates.find(u => u.where.id === 5)?.data.remaining.toString()).toBe("50")
      expect(updates.find(u => u.where.id === 5)?.data.status).toBe(CreditLotStatus.ACTIVE)
      expect(updates.find(u => u.where.id === 6)).toBeUndefined()
      expect(prisma.creditLot.create).not.toHaveBeenCalled()

      const txn = firstArgs<{ data: { direction: CreditDirection; amount: Decimal } }>(
        prisma.creditTransaction.create
      )[0]
      expect(txn.data.direction).toBe(CreditDirection.DEBIT)
      expect(txn.data.amount.toString()).toBe("250")
    })

    it("负数且可用充值积分不足：抛 BadRequest、不扣成负", async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 5, remaining: new Decimal(100) }])
      await expect(service.adjust(1, -250)).rejects.toThrow("可用充值积分不足")
      expect(prisma.creditLot.update).not.toHaveBeenCalled()
      expect(prisma.creditTransaction.create).not.toHaveBeenCalled()
    })

    it("调整额为 0 抛 BadRequest", async () => {
      await expect(service.adjust(1, 0)).rejects.toBeInstanceOf(BadRequestException)
    })
  })

  describe("consume", () => {
    const noInviteUser = {
      id: 1,
      canInvite: false,
      invitedById: null,
      subscriptionTier: null,
      discount: new Decimal(1),
    }

    it("余额不足抛 BadRequest", async () => {
      prisma.user.findUnique.mockResolvedValue(noInviteUser)
      prisma.creditLot.findMany.mockResolvedValue([])
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(0) } })
      await expect(service.consume(1, 5)).rejects.toThrow("积分余额不足，请充值")
    })

    it("无 tx 时用 READ COMMITTED 事务（配合行锁防并发扣费丢失更新）", async () => {
      prisma.user.findUnique.mockResolvedValue(noInviteUser)
      prisma.creditLot.findMany.mockResolvedValue([
        {
          id: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])
      await service.consume(1, 1)
      // consume 自身事务带 isolationLevel=ReadCommitted（activateDuePlans 的事务无此选项）
      const calls = prisma.$transaction.mock.calls as unknown as Array<
        [unknown, { isolationLevel?: string } | undefined]
      >
      expect(calls.some(c => c[1]?.isolationLevel === "ReadCommitted")).toBe(true)
    })

    it("allowOverdraft：余额不足不报错，正向批次扣尽后在 RECHARGE 记负批次（欠账）", async () => {
      prisma.user.findUnique.mockResolvedValue(noInviteUser) // NONE
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(20) } })
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(20),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      // cost 5 → charge 50；正向只有 20，缺口 30 记为 RECHARGE 负批次
      const res = await service.consume(1, 5, { allowOverdraft: true })

      expect(res.creditsCharged.toString()).toBe("50")
      const debtLot = firstArgs<LotCreateArg>(prisma.creditLot.create).find(
        c => c.data.bucket === CreditBucket.RECHARGE && c.data.amount.toString() === "-30"
      )
      expect(debtLot).toBeDefined()
      expect(debtLot?.data.remaining.toString()).toBe("-30")
    })

    it("按桶优先级 + FIFO 跨桶扣减，每桶一条 CONSUME 流水", async () => {
      prisma.user.findUnique.mockResolvedValue(noInviteUser) // 无 PACKAGE 时：GIFT 先于 RECHARGE
      const now = new Date()
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 10,
          userId: 1,
          bucket: CreditBucket.GIFT,
          remaining: new Decimal(30),
          expiresAt: null,
          grantedAt: now,
        },
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: now,
        },
      ])

      // cost 5 元 × 10 × 折扣 1 = 50 积分；GIFT 扣 30、RECHARGE 扣 20
      const res = await service.consume(1, 5, { source: "listing.generate" })

      expect(res.creditsCharged.toString()).toBe("50")
      expect(res.breakdown).toEqual([
        { bucket: CreditBucket.GIFT, amount: "30" },
        { bucket: CreditBucket.RECHARGE, amount: "20" },
      ])

      // GIFT 批次扣空 → EXHAUSTED；RECHARGE 批次余 80 → ACTIVE
      const updates = firstArgs<LotUpdateArg>(prisma.creditLot.update)
      const giftUpdate = updates.find(u => u.where.id === 10)
      const rechargeUpdate = updates.find(u => u.where.id === 11)
      expect(giftUpdate?.data.status).toBe(CreditLotStatus.EXHAUSTED)
      expect(rechargeUpdate?.data.status).toBe(CreditLotStatus.ACTIVE)
      expect(rechargeUpdate?.data.remaining.toString()).toBe("80")

      const consumeTxns = firstArgs<TxnCreateArg>(prisma.creditTransaction.create).filter(
        t => t.data.type === CreditTxnType.CONSUME
      )
      expect(consumeTxns).toHaveLength(2)
    })

    it("赠送积分(PACKAGE)优先于充值积分(RECHARGE)扣减，会过期的先扣（与等级无关）", async () => {
      prisma.user.findUnique.mockResolvedValue(noInviteUser) // NONE 同样先扣 PACKAGE
      const now = new Date()
      const soon = new Date(now.getTime() + 5 * 24 * 3600 * 1000) // PACKAGE 5 天后过期
      // 故意把 RECHARGE 排在 findMany 首位：验证顺序由桶优先级决定、与查询返回顺序无关
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 20,
          userId: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: now,
        },
        {
          id: 21,
          userId: 1,
          bucket: CreditBucket.GIFT,
          remaining: new Decimal(40),
          expiresAt: null,
          grantedAt: now,
        },
        {
          id: 22,
          userId: 1,
          bucket: CreditBucket.PACKAGE,
          remaining: new Decimal(30),
          expiresAt: soon,
          grantedAt: now,
        },
      ])

      // cost 9 元 × 10 × 折扣 1 = 90 积分；先扣 PACKAGE 30 → 再 GIFT 40 → 最后 RECHARGE 20
      const res = await service.consume(1, 9)

      expect(res.creditsCharged.toString()).toBe("90")
      expect(res.breakdown).toEqual([
        { bucket: CreditBucket.PACKAGE, amount: "30" },
        { bucket: CreditBucket.GIFT, amount: "40" },
        { bucket: CreditBucket.RECHARGE, amount: "20" },
      ])

      // 永不过期的 RECHARGE 最后扣、剩 80
      const updates = firstArgs<LotUpdateArg>(prisma.creditLot.update)
      const rechargeUpdate = updates.find(u => u.where.id === 20)
      expect(rechargeUpdate?.data.remaining.toString()).toBe("80")
      expect(rechargeUpdate?.data.status).toBe(CreditLotStatus.ACTIVE)
    })

    it("赠送层 PACKAGE+GIFT 跨桶按过期排序：更早过期的 GIFT 先于更晚过期的 PACKAGE 扣", async () => {
      prisma.user.findUnique.mockResolvedValue(noInviteUser)
      const now = new Date()
      const giftExp = new Date(now.getTime() + 5 * 24 * 3600 * 1000) // GIFT 5 天后过期（更早）
      const pkgExp = new Date(now.getTime() + 20 * 24 * 3600 * 1000) // PACKAGE 20 天后过期（更晚）
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 30,
          userId: 1,
          bucket: CreditBucket.PACKAGE,
          remaining: new Decimal(50),
          expiresAt: pkgExp,
          grantedAt: now,
        },
        {
          id: 31,
          userId: 1,
          bucket: CreditBucket.GIFT,
          remaining: new Decimal(40),
          expiresAt: giftExp,
          grantedAt: now,
        },
        {
          id: 32,
          userId: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: now,
        },
      ])

      // cost 6 元 × 10 = 60；先扣更早过期的 GIFT 40 → 再扣 PACKAGE 20，RECHARGE 不动
      const res = await service.consume(1, 6)

      expect(res.creditsCharged.toString()).toBe("60")
      const byBucket = Object.fromEntries(res.breakdown.map(b => [b.bucket, b.amount]))
      expect(byBucket[CreditBucket.GIFT]).toBe("40") // GIFT 全扣（更早过期，先扣）
      expect(byBucket[CreditBucket.PACKAGE]).toBe("20") // PACKAGE 仅扣 20
      expect(byBucket[CreditBucket.RECHARGE]).toBeUndefined() // 充值未动

      const updates = firstArgs<LotUpdateArg>(prisma.creditLot.update)
      expect(updates.find(u => u.where.id === 31)?.data.status).toBe(CreditLotStatus.EXHAUSTED)
      expect(updates.find(u => u.where.id === 30)?.data.remaining.toString()).toBe("30")
      expect(updates.find(u => u.where.id === 32)).toBeUndefined()
    })

    it("折扣 + 向上取整", async () => {
      prisma.user.findUnique.mockResolvedValue({ ...noInviteUser, discount: new Decimal("0.8") })
      prisma.creditLot.findMany.mockResolvedValue([
        {
          id: 11,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])
      // 4.6 × 10 × 0.8 = 36.8 → ceil 37
      const res = await service.consume(1, "4.6")
      expect(res.creditsCharged.toString()).toBe("37")
    })

    it("生效折扣：被邀请人没开「允许邀请注册」→ 跟随邀请人折扣（不看自己的字段值）", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) => {
        if (id === 1) {
          return Promise.resolve({
            id: 1,
            canInvite: false,
            invitedById: 2,
            subscriptionTier: null,
            discount: new Decimal(1), // 本人字段是 1，但不应生效
          })
        }
        if (id === 2) {
          return Promise.resolve({
            id: 2,
            invitedById: null,
            discount: new Decimal("0.7"), // 邀请人（开过邀请注册）的折扣
            rebateRate: new Decimal("0.3"),
            level2RebateRate: null,
            rebateEnabled: true,
            isActive: true,
            canInvite: true,
            invitedBy: null,
            shareCreditsWithInvitees: false,
          })
        }
        return Promise.resolve(null)
      })
      prisma.creditLot.findMany.mockResolvedValue([
        {
          id: 11,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      // 5 × 10 × 0.7 = 35（若按本人字段 1 则是 50）
      const res = await service.consume(1, 5)
      expect(res.creditsCharged.toString()).toBe("35")
    })

    it("生效折扣：链式跟随——邀请人也没开 → 继续上溯到开过开关的上级", async () => {
      const chainNode = (id: number, canInvite: boolean, discount: string, invitedById: number | null) => ({
        id,
        canInvite,
        invitedById,
        subscriptionTier: null,
        discount: new Decimal(discount),
        rebateRate: new Decimal("0.3"),
        level2RebateRate: null,
        rebateEnabled: true,
        isActive: true,
        invitedBy: null,
        shareCreditsWithInvitees: false,
      })
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) =>
        Promise.resolve(
          id === 1
            ? chainNode(1, false, "1", 2) // 本人没开
            : id === 2
              ? chainNode(2, false, "1", 3) // 邀请人也没开（自身字段 1 不生效）
              : id === 3
                ? chainNode(3, true, "0.6", null) // 上上级开过 → 0.6
                : null
        )
      )
      prisma.creditLot.findMany.mockResolvedValue([
        {
          id: 11,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      // 5 × 10 × 0.6 = 30（若按本人或一级字段 1 则是 50）
      const res = await service.consume(1, 5)
      expect(res.creditsCharged.toString()).toBe("30")
    })

    it("生效折扣：被邀请人自己开过「允许邀请注册」→ 用本人折扣（不跟随邀请人）", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) =>
        Promise.resolve(
          id === 1
            ? {
                id: 1,
                canInvite: true, // 本人开过 → 自己的 0.9 生效
                invitedById: 2,
                subscriptionTier: null,
                discount: new Decimal("0.9"),
              }
            : id === 2
              ? {
                  id: 2,
                  invitedById: null,
                  discount: new Decimal("0.7"), // 邀请人折扣不影响已开开关的本人
                  rebateRate: new Decimal("0.3"),
                  level2RebateRate: null,
                  rebateEnabled: true,
                  isActive: true,
                  canInvite: true,
                  invitedBy: null,
                  shareCreditsWithInvitees: false,
                }
              : null
        )
      )
      prisma.creditLot.findMany.mockResolvedValue([
        {
          id: 11,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      // 5 × 10 × 0.9 = 45
      const res = await service.consume(1, 5)
      expect(res.creditsCharged.toString()).toBe("45")
    })

    it("consumeCredits 保留精确小数积分且不再应用会员折扣", async () => {
      prisma.user.findUnique.mockResolvedValue({ ...noInviteUser, discount: new Decimal("0.8") })
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      const res = await service.consumeCredits(1, "9.6", "0.96")

      expect(res.creditsCharged.toString()).toBe("9.6")
      expect(res.costCny.toString()).toBe("0.96")
      expect(res.breakdown).toEqual([{ bucket: CreditBucket.RECHARGE, amount: "9.6" }])
      const update = firstArgs<LotUpdateArg>(prisma.creditLot.update)[0]
      expect(update.data.remaining.toString()).toBe("90.4")
    })

    it("返利金额不抹零（2026-08-31 起，4 位小数）：1×0.3=0.3 入账；3×0.3=0.9 入账", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) => {
        if (id === 1) {
          return Promise.resolve({
            id: 1,
            canInvite: false,
            invitedById: 2,
            subscriptionTier: null,
            discount: new Decimal(1),
          })
        }
        if (id === 2) {
          return Promise.resolve({
            id: 2,
            invitedById: null,
            rebateRate: new Decimal("0.3"),
            level2RebateRate: null,
            rebateEnabled: true,
            isActive: true,
            canInvite: true,
            invitedBy: null,
            shareCreditsWithInvitees: false,
          })
        }
        return Promise.resolve(null)
      })
      prisma.creditLot.findMany.mockResolvedValue([
        {
          id: 11,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      await service.consume(1, "0.1") // charge 1 → 返利 1×0.3=0.3 → 不抹零，入账 0.3
      let rebateLot = firstArgs<LotCreateArg>(prisma.creditLot.create).find(
        c => c.data.bucket === CreditBucket.REBATE
      )
      expect(rebateLot?.data.amount.toString()).toBe("0.3")

      await service.consume(1, "0.3") // charge 3 → 返利 3×0.3=0.9 入账（取整时代先抹 0 后进 1，微额口径已废）
      rebateLot = firstArgs<LotCreateArg>(prisma.creditLot.create).find(
        c => c.data.bucket === CreditBucket.REBATE && c.data.amount.toString() === "0.9"
      )
      expect(rebateLot).toBeDefined()
      const rebateTxns = firstArgs<TxnCreateArg>(prisma.creditTransaction.create).filter(
        c => c.data.type === CreditTxnType.REBATE_IN
      )
      expect(rebateTxns.map(t => t.data.amount.toString())).toEqual(["0.3", "0.9"])
    })

    it("消费触发邀请人返利入账（一级，按邀请人 rebateRate）", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) => {
        if (id === 1) {
          return Promise.resolve({
            id: 1,
            canInvite: false,
            invitedById: 2,
            subscriptionTier: null,
            discount: new Decimal(1),
          })
        }
        if (id === 2) {
          return Promise.resolve({
            id: 2,
            invitedById: null,
            rebateRate: new Decimal("0.3"),
            level2RebateRate: null,
            rebateEnabled: true,
            isActive: true,
            canInvite: true,
            invitedBy: null,
            shareCreditsWithInvitees: false,
          })
        }
        return Promise.resolve(null)
      })
      prisma.creditLot.findMany.mockResolvedValue([
        {
          id: 11,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      await service.consume(1, 5) // charge 50 → 返利 50×0.3=15

      const rebateLot = firstArgs<LotCreateArg>(prisma.creditLot.create).find(
        c => c.data.bucket === CreditBucket.REBATE
      )
      expect(rebateLot?.data.userId).toBe(2)
      expect(rebateLot?.data.amount.toString()).toBe("15")

      const rebateTxn = firstArgs<TxnCreateArg>(prisma.creditTransaction.create).find(
        t => t.data.type === CreditTxnType.REBATE_IN
      )
      expect(rebateTxn?.data.userId).toBe(2)
      expect(rebateTxn?.data.relatedUserId).toBe(1)
      expect((rebateTxn?.data.meta as { layer: number }).layer).toBe(1)
    })

    // ── 共享额度（被邀请人 LV4 动用邀请人 LV5 额度） ──────────────────────────
    const founder = {
      id: 1,
      canInvite: false,
      invitedById: 2,
      subscriptionTier: null,
      discount: new Decimal(1),
    }

    it("邀请人已关闭邀请权（canInvite=false）：共享开关残留也失效，只扣本人、不足即 400（bug28）", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) =>
        Promise.resolve(
          id === 1
            ? founder
            : id === 2
              ? {
                  id: 2,
                  canInvite: false, // 已关闭返利邀请——共享开关虽残留 true，也不得再被下级消耗
                  invitedById: null,
                  discount: new Decimal(1),
                  rebateRate: new Decimal("0.3"),
                  shareCreditsWithInvitees: true,
                }
              : null
        )
      )
      // 本人仅 20，邀请人 100：不共享 → 50 扣不动 → 400
      prisma.creditLot.aggregate.mockImplementation((arg: { where?: { userId?: number } }) =>
        Promise.resolve({
          _sum: { remaining: arg.where?.userId === 1 ? new Decimal(20) : new Decimal(100) },
        })
      )
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(20),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      await expect(service.consume(1, 5)).rejects.toThrow("积分余额不足，请充值")
      // 邀请人批次一行都没被锁/扣（锁批次 SQL 的 ownerIds 只含本人）
      expect(prisma.creditLot.update).not.toHaveBeenCalled()
    })

    it("共享开启：自己额度扣尽后续扣邀请人额度，消费记在邀请人账上(relatedUserId=被邀请人)", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) =>
        Promise.resolve(
          id === 1
            ? founder
            : id === 2
              ? {
                  id: 2,
                  canInvite: true,
                  invitedById: null,
                  discount: new Decimal(1),
                  rebateRate: new Decimal("0.3"),
                  shareCreditsWithInvitees: true,
                }
              : null
        )
      )
      // 自己 RECHARGE 20（userId 1）+ 邀请人 RECHARGE 100（userId 2）
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(20),
          expiresAt: null,
          grantedAt: new Date(),
        },
        {
          id: 21,
          userId: 2,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      // cost 5 → charge 50；先扣自己 20，再扣邀请人 30
      const res = await service.consume(1, 5, { source: "listing.generate" })

      expect(res.breakdown).toEqual([
        { bucket: CreditBucket.RECHARGE, amount: "20" }, // 自己
        { bucket: CreditBucket.RECHARGE, amount: "30" }, // 邀请人
      ])
      const consumes = firstArgs<TxnCreateArg>(prisma.creditTransaction.create).filter(
        t => t.data.type === CreditTxnType.CONSUME
      )
      const own = consumes.find(t => t.data.userId === 1)
      const fromInviter = consumes.find(t => t.data.userId === 2)
      expect(own?.data.amount.toString()).toBe("20")
      expect(own?.data.relatedUserId ?? null).toBeNull() // 自己池：relatedUserId 空
      expect(fromInviter?.data.amount.toString()).toBe("30")
      expect(fromInviter?.data.relatedUserId).toBe(1) // 邀请人池：relatedUserId=被邀请人

      // 锁住了邀请人(id 2)的批次（动用其额度）
      const lockedInviterLot = firstArgs<LotUpdateArg>(prisma.creditLot.update).find(
        u => u.where.id === 21
      )
      expect(lockedInviterLot?.data.remaining.toString()).toBe("70")
    })

    it("部分返利：只对扣自被邀请人自己额度的部分返利（动用邀请人额度的部分不返利）", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) => {
        if (id === 1) return Promise.resolve(founder)
        if (id === 2) {
          return Promise.resolve({
            id: 2,
            invitedById: null,
            rebateRate: new Decimal("0.3"),
            level2RebateRate: null,
            rebateEnabled: true,
            isActive: true,
            canInvite: true,
            invitedBy: null,
            shareCreditsWithInvitees: true,
          })
        }
        return Promise.resolve(null)
      })
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(20),
          expiresAt: null,
          grantedAt: new Date(),
        },
        {
          id: 21,
          userId: 2,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      // charge 50：自己扣 20、邀请人扣 30 → 返利只算 20 × 0.3 = 6（而非 50×0.3=15）
      await service.consume(1, 5)

      const rebateLot = firstArgs<LotCreateArg>(prisma.creditLot.create).find(
        c => c.data.bucket === CreditBucket.REBATE
      )
      expect(rebateLot?.data.userId).toBe(2)
      expect(rebateLot?.data.amount.toString()).toBe("6")
    })

    it("共享关闭：自己额度不足即 400（不动邀请人额度，行为同旧）", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) =>
        Promise.resolve(
          id === 1
            ? founder
            : id === 2
              ? {
                  id: 2,
                  canInvite: true,
                  invitedById: null,
                  discount: new Decimal(1),
                  rebateRate: new Decimal("0.3"),
                  shareCreditsWithInvitees: false,
                }
              : null
        )
      )
      // 自己可消费余额为 0
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(0) } })
      prisma.$queryRaw.mockResolvedValue([])

      await expect(service.consume(1, 5)).rejects.toThrow("积分余额不足，请充值")
    })

    it("按净额封顶：本人净额仅 1（正批次更多），只扣这 1、其余落邀请人额度", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) =>
        Promise.resolve(
          id === 1
            ? founder
            : id === 2
              ? {
                  id: 2,
                  canInvite: true,
                  invitedById: null,
                  discount: new Decimal(1),
                  rebateRate: new Decimal("0.3"),
                  shareCreditsWithInvitees: true,
                }
              : null
        )
      )
      // 本人净额=1（如充 500 手动扣 499），但仍有一条 remaining=500 的正批次；邀请人净额=1000
      prisma.creditLot.aggregate.mockImplementation((arg: { where?: { userId?: number } }) =>
        Promise.resolve({
          _sum: { remaining: arg.where?.userId === 1 ? new Decimal(1) : new Decimal(1000) },
        })
      )
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(500),
          expiresAt: null,
          grantedAt: new Date(),
        },
        {
          id: 21,
          userId: 2,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(1000),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      // cost 5 → charge 50；本人净额仅 1 → 只扣 1，余 49 扣邀请人（绝不把那条 500 正批次超净额扣空）
      const res = await service.consume(1, 5, { source: "listing.generate" })

      expect(res.breakdown).toEqual([
        { bucket: CreditBucket.RECHARGE, amount: "1" }, // 本人：封顶到净额 1
        { bucket: CreditBucket.RECHARGE, amount: "49" }, // 邀请人
      ])
      const consumes = firstArgs<TxnCreateArg>(prisma.creditTransaction.create).filter(
        t => t.data.type === CreditTxnType.CONSUME
      )
      expect(consumes.find(t => t.data.userId === 1)?.data.amount.toString()).toBe("1")
      expect(consumes.find(t => t.data.userId === 2)?.data.amount.toString()).toBe("49")
      // 本人正批次只被扣 1（500→499），没被超净额扣空
      const ownLot = firstArgs<LotUpdateArg>(prisma.creditLot.update).find(u => u.where.id === 11)
      expect(ownLot?.data.remaining.toString()).toBe("499")
    })

    it("净额≤0（有欠账负批次）：本人一分扣不动，整笔落邀请人额度、正批次不碰", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) =>
        Promise.resolve(
          id === 1
            ? founder
            : id === 2
              ? {
                  id: 2,
                  canInvite: true,
                  invitedById: null,
                  discount: new Decimal(1),
                  rebateRate: new Decimal("0.3"),
                  shareCreditsWithInvitees: true,
                }
              : null
        )
      )
      // 本人净额 = -3（正批次 100 但欠账 -103 → 净 -3）；邀请人净额 1000
      prisma.creditLot.aggregate.mockImplementation((arg: { where?: { userId?: number } }) =>
        Promise.resolve({
          _sum: { remaining: arg.where?.userId === 1 ? new Decimal(-3) : new Decimal(1000) },
        })
      )
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
        {
          id: 21,
          userId: 2,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(1000),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      // cost 0.3 → charge 3；本人净额 -3 ≤ 0 → 一分不扣，3 全扣邀请人
      const res = await service.consume(1, "0.3", { source: "listing.score" })

      expect(res.breakdown).toEqual([{ bucket: CreditBucket.RECHARGE, amount: "3" }]) // 仅邀请人
      const consumes = firstArgs<TxnCreateArg>(prisma.creditTransaction.create).filter(
        t => t.data.type === CreditTxnType.CONSUME
      )
      expect(consumes.find(t => t.data.userId === 1)).toBeUndefined() // 本人没有扣费流水
      expect(consumes.find(t => t.data.userId === 2)?.data.amount.toString()).toBe("3")
      expect(consumes.find(t => t.data.userId === 2)?.data.relatedUserId).toBe(1)
      // 本人那条 100 正批次没被碰
      expect(
        firstArgs<LotUpdateArg>(prisma.creditLot.update).find(u => u.where.id === 11)
      ).toBeUndefined()
    })

    it("本人欠账大于邀请人余额时：欠账不抵消共享额度，邀请人正净额仍可足额扣减", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) =>
        Promise.resolve(
          id === 1
            ? founder
            : id === 2
              ? {
                  id: 2,
                  canInvite: true,
                  invitedById: null,
                  discount: new Decimal(1),
                  rebateRate: new Decimal("0.3"),
                  shareCreditsWithInvitees: true,
                }
              : null
        )
      )
      prisma.creditLot.aggregate.mockImplementation((arg: { where?: { userId?: number } }) =>
        Promise.resolve({
          _sum: { remaining: arg.where?.userId === 1 ? new Decimal(-100) : new Decimal(50) },
        })
      )
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 21,
          userId: 2,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(50),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      const res = await service.consume(1, 5)

      expect(res.breakdown).toEqual([{ bucket: CreditBucket.RECHARGE, amount: "50" }])
      expect(firstArgs<LotUpdateArg>(prisma.creditLot.update)[0]?.where.id).toBe(21)
      expect(firstArgs<LotUpdateArg>(prisma.creditLot.update)[0]?.data.remaining.toString()).toBe(
        "0"
      )
    })

    it("透支消费照常返利：消费即返、不论是否透支（返利基数 = charge − inviterDrawn）", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) => {
        if (id === 1) return Promise.resolve(founder)
        if (id === 2) {
          return Promise.resolve({
            id: 2,
            invitedById: null,
            rebateRate: new Decimal("0.3"),
            level2RebateRate: null,
            rebateEnabled: true,
            isActive: true,
            canInvite: true,
            invitedBy: null,
            shareCreditsWithInvitees: false, // 不共享 → 自己池扣尽后透支自己
          })
        }
        return Promise.resolve(null)
      })
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(20) } }) // 自己净额 20
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(20),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      // charge 50：自己扣 20、透支 30。规则：消费即返 → 返利基数=50 → 50×0.3=15（透支部分照返）
      await service.consume(1, 5, { allowOverdraft: true, source: "video.generate" })

      const rebateLot = firstArgs<LotCreateArg>(prisma.creditLot.create).find(
        c => c.data.bucket === CreditBucket.REBATE
      )
      expect(rebateLot?.data.userId).toBe(2)
      expect(rebateLot?.data.amount.toString()).toBe("15")
    })

    // ── 多级返利内核（2026-08-20 新口径） ──────────────────────────
    const chainMock = (users: Record<number, Record<string, unknown>>) => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) =>
        Promise.resolve(users[id] ?? null)
      )
    }
    const chainUser = (over: Record<string, unknown> = {}) => ({
      discount: new Decimal(1),
      invitedById: null,
      rebateRate: new Decimal("0.3"),
      level2RebateRate: null,
      rebateEnabled: true,
      isActive: true, // 计酬闸门：停用账号跳层（2026-08-31）
      canInvite: true, // 计酬闸门：有效邀请权（关闭分销代理跳层）
      invitedBy: null, // deriveCanInvite 用（一级分销 invitedBy 为空即可）
      shareCreditsWithInvitees: false,
      ...over,
    })
    const rebateLots = () =>
      firstArgs<LotCreateArg>(prisma.creditLot.create).filter(
        c => c.data.bucket === CreditBucket.REBATE
      )

    it("二级返利：一级按 rebateRate、二级按 level2RebateRate（消费 50 → 15 + 10）", async () => {
      chainMock({
        1: chainUser({ id: 1, invitedById: 2 }),
        2: chainUser({ id: 2, invitedById: 3, rebateRate: new Decimal("0.3") }),
        3: chainUser({ id: 3, level2RebateRate: new Decimal("0.2") }),
      })

      await service.consume(1, 5) // charge 50

      const lots = rebateLots()
      expect(lots).toHaveLength(2)
      expect(lots.find(l => l.data.userId === 2)?.data.amount.toString()).toBe("15")
      expect(lots.find(l => l.data.userId === 3)?.data.amount.toString()).toBe("10")
      const layer2Txn = firstArgs<TxnCreateArg>(prisma.creditTransaction.create).find(
        t => t.data.type === CreditTxnType.REBATE_IN && t.data.userId === 3
      )
      expect((layer2Txn?.data.meta as { layer: number }).layer).toBe(2)
    })

    it("level2RebateRate 为 null 时用全局默认 0.10；rebateEnabled=false 跳过该层链不断", async () => {
      chainMock({
        1: chainUser({ id: 1, invitedById: 2 }),
        2: chainUser({ id: 2, invitedById: 3, rebateEnabled: false }), // 跳过一级
        3: chainUser({ id: 3, level2RebateRate: null }), // 默认 0.10
      })

      await service.consume(1, 5) // charge 50 → 仅二级 50×0.1=5

      const lots = rebateLots()
      expect(lots).toHaveLength(1)
      expect(lots[0].data.userId).toBe(3)
      expect(lots[0].data.amount.toString()).toBe("5")
    })

    it("perConsumeCapPct：各层合计超 base×pct 时等比缩减", async () => {
      prisma.rebateRule.findFirst.mockResolvedValue({
        id: 1,
        corpCounts: true,
        maxLayers: 2,
        perInviterCap: null,
        perConsumeCapPct: new Decimal("0.4"),
      })
      chainMock({
        1: chainUser({ id: 1, invitedById: 2 }),
        2: chainUser({ id: 2, invitedById: 3, rebateRate: new Decimal("0.3") }),
        3: chainUser({ id: 3, level2RebateRate: new Decimal("0.2") }),
      })

      // 应返 15+10=25，上限 50×0.4=20 → 等比 ×0.8 → 12 + 8
      await service.consume(1, 5)

      const lots = rebateLots()
      expect(lots.find(l => l.data.userId === 2)?.data.amount.toString()).toBe("12")
      expect(lots.find(l => l.data.userId === 3)?.data.amount.toString()).toBe("8")
    })

    it("perConsumeCapPct：缩减后等比缩放（4dp 不抹零），合计绝不超封顶（QA 2026-08-31）", async () => {
      prisma.rebateRule.findFirst.mockResolvedValue({
        id: 1,
        corpCounts: true,
        maxLayers: 2,
        perInviterCap: null,
        perConsumeCapPct: new Decimal("0.1"), // 单笔封顶 10%
      })
      chainMock({
        1: chainUser({ id: 1, invitedById: 2 }),
        2: chainUser({ id: 2, invitedById: 3, rebateRate: new Decimal("0.3") }),
        3: chainUser({ id: 3, level2RebateRate: new Decimal("0.3") }),
      })

      // base=10：应返 3+3=6 > 封顶 1 → 等比 ×1/6 → 各 0.5；不抹零口径两层各得 0.5，合计 1 = 封顶
      await service.consume(1, 1)

      const lots = rebateLots()
      const total = lots.reduce((s, l) => s.plus(l.data.amount), new Decimal(0))
      expect(total.toString()).toBe("1") // 合计 = 封顶 10×0.1=1，不超
      expect(lots.find(l => l.data.userId === 2)?.data.amount.toString()).toBe("0.5")
      expect(lots.find(l => l.data.userId === 3)?.data.amount.toString()).toBe("0.5")
    })

    it("maxLayers=null：不限层级，沿邀请链上溯到底（2026-09-01 bug15）", async () => {
      prisma.rebateRule.findFirst.mockResolvedValue({
        id: 1,
        corpCounts: true,
        maxLayers: null, // 不限层级
        perInviterCap: null,
        perConsumeCapPct: null,
      })
      chainMock({
        1: chainUser({ id: 1, invitedById: 2 }),
        2: chainUser({ id: 2, invitedById: 3, rebateRate: new Decimal("0.3") }),
        3: chainUser({ id: 3, invitedById: 4, level2RebateRate: new Decimal("0.2") }),
        4: chainUser({ id: 4, level2RebateRate: new Decimal("0.1") }),
      })

      await service.consume(1, 5) // charge 50 → 15 + 10 + 5（第三层也计酬）

      const lots = rebateLots()
      expect(lots).toHaveLength(3)
      expect(lots.find(l => l.data.userId === 2)?.data.amount.toString()).toBe("15")
      expect(lots.find(l => l.data.userId === 3)?.data.amount.toString()).toBe("10")
      expect(lots.find(l => l.data.userId === 4)?.data.amount.toString()).toBe("5")
    })

    it("perInviterCap：邀请人自然月 REBATE_IN 累计封顶（当月已返抵扣）", async () => {
      prisma.rebateRule.findFirst.mockResolvedValue({
        id: 1,
        corpCounts: true,
        maxLayers: 2,
        perInviterCap: 12,
        perConsumeCapPct: null,
      })
      // 邀请人 2 当月已返 5 → 剩余 7；邀请人 3 已返 0 → 剩余 12
      prisma.creditTransaction.groupBy.mockResolvedValue([
        { userId: 2, _sum: { amount: new Decimal(5) } },
      ])
      chainMock({
        1: chainUser({ id: 1, invitedById: 2 }),
        2: chainUser({ id: 2, invitedById: 3, rebateRate: new Decimal("0.3") }),
        3: chainUser({ id: 3, level2RebateRate: new Decimal("0.2") }),
      })

      await service.consume(1, 5) // 应返 15/10 → 实际 min(15,7)=7 / min(10,12)=10

      const lots = rebateLots()
      expect(lots.find(l => l.data.userId === 2)?.data.amount.toString()).toBe("7")
      expect(lots.find(l => l.data.userId === 3)?.data.amount.toString()).toBe("10")
    })

    // ── 计酬闸门（2026-08-31 QA B17/B18）：关闭分销代理 / 停用账号立即停酬，跳层链不断 ──
    it("B17：邀请人已关闭分销代理（canInvite=false）→ 该层跳计，上级照常（链不断）", async () => {
      chainMock({
        1: chainUser({ id: 1, invitedById: 2 }),
        2: chainUser({ id: 2, invitedById: 3, canInvite: false }), // 已关闭：跳层（关系保留）
        3: chainUser({ id: 3, level2RebateRate: new Decimal("0.2") }),
      })
      prisma.creditLot.findMany.mockResolvedValue([
        {
          id: 11,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      await service.consume(1, 5) // charge 50 → #2 不返；#3 按二级 50×0.2=10

      const lots = rebateLots()
      expect(lots.find(l => l.data.userId === 2)).toBeUndefined()
      expect(lots.find(l => l.data.userId === 3)?.data.amount.toString()).toBe("10")
    })

    it("B18：邀请人已停用（isActive=false）→ 该层跳计，上级照常", async () => {
      chainMock({
        1: chainUser({ id: 1, invitedById: 2 }),
        2: chainUser({ id: 2, invitedById: 3, isActive: false }), // 已停用：跳层（启用后恢复）
        3: chainUser({ id: 3, level2RebateRate: new Decimal("0.2") }),
      })
      prisma.creditLot.findMany.mockResolvedValue([
        {
          id: 11,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      await service.consume(1, 5)

      const lots = rebateLots()
      expect(lots.find(l => l.data.userId === 2)).toBeUndefined()
      expect(lots.find(l => l.data.userId === 3)?.data.amount.toString()).toBe("10")
    })
  })

  describe("consumeTeamCredits（企业池消费返利归属，QA B16）", () => {
    const poolLot = {
      id: 21,
      bucket: CreditBucket.RECHARGE,
      remaining: new Decimal(1000),
      expiresAt: null,
      grantedAt: new Date(),
    }
    const rebateLots = () =>
      firstArgs<LotCreateArg>(prisma.creditLot.create).filter(
        c => c.data.bucket === CreditBucket.REBATE
      )
    // 链上邀请人：计酬闸门三字段（rebateEnabled/isActive/canInvite）默认放行
    const distUser = (over: Record<string, unknown> = {}) => ({
      invitedById: null,
      rebateRate: new Decimal("0.3"),
      level2RebateRate: null,
      rebateEnabled: true,
      isActive: true,
      canInvite: true,
      invitedBy: null,
      ...over,
    })
    const teamChainMock = (
      team: Record<string, unknown>,
      users: Record<number, Record<string, unknown>>
    ) => {
      prisma.team.findUnique.mockResolvedValue(team)
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) =>
        Promise.resolve(users[id] ?? null)
      )
    }

    it("企业池段沿「企业邀请人快照」结算（Team.invitedById），不串成员个人邀请链", async () => {
      prisma.$queryRaw.mockResolvedValue([poolLot]) // 池批次加锁当前读
      teamChainMock(
        { invitedById: 123, admin: { invitedById: 123, corpPassUp: null } }, // 快照 + A 仍在任
        {
          123: distUser({ id: 123 }), // 企业邀请人
          132: distUser({ id: 132, rebateRate: new Decimal("0.5") }), // 成员个人邀请人（不应出现）
        }
      )

      // 成员 #133 企业池消费 20 积分
      await service.consumeTeamCredits(7, 133, 20, 2, { source: "llm.generic" })

      const lots = rebateLots()
      expect(lots).toHaveLength(1)
      expect(lots[0].data.userId).toBe(123) // 返利归企业邀请人
      expect(lots[0].data.amount.toString()).toBe("6") // 20×0.3
      const txn = firstArgs<TxnCreateArg>(prisma.creditTransaction.create).find(
        t => t.data.type === CreditTxnType.REBATE_IN
      )
      expect(txn?.data.relatedUserId).toBe(133) // 消费者仍记成员本人（树内对账按人归集）
      expect((txn?.data as { teamId?: number }).teamId).toBe(7) // 池段返利行落 teamId（2026-09-01，树卷起归属用）
    })

    it("快照在但 A 已不再是企业管理员（当前管理员邀请关系≠快照）→ 企业段不返（2026-08-31 新口径）", async () => {
      prisma.$queryRaw.mockResolvedValue([poolLot])
      teamChainMock(
        { invitedById: 123, admin: { invitedById: 999, corpPassUp: null } }, // 管理员已换
        { 123: distUser({ id: 123 }) }
      )

      await service.consumeTeamCredits(7, 133, 20, 2, { source: "llm.generic" })

      expect(rebateLots()).toHaveLength(0)
    })

    it("存量团队无快照（invitedById=null）→ 回落当前管理员邀请关系", async () => {
      prisma.$queryRaw.mockResolvedValue([poolLot])
      teamChainMock(
        { invitedById: null, admin: { invitedById: 124, corpPassUp: null } },
        { 124: distUser({ id: 124 }) }
      )

      await service.consumeTeamCredits(7, 133, 20, 2, { source: "llm.generic" })

      const lots = rebateLots()
      expect(lots).toHaveLength(1)
      expect(lots[0].data.userId).toBe(124)
    })

    it("企业无邀请人（快照与管理员邀请关系均空）→ 企业段不计佣", async () => {
      prisma.$queryRaw.mockResolvedValue([poolLot])
      teamChainMock({ invitedById: null, admin: { invitedById: null, corpPassUp: null } }, {})

      await service.consumeTeamCredits(7, 133, 20, 2, { source: "llm.generic" })

      expect(rebateLots()).toHaveLength(0)
    })

    it("corpCounts=false 且管理员未单独设定（corpPassUp=null）→ 企业段不计佣", async () => {
      prisma.rebateRule.findFirst.mockResolvedValue({
        id: 1,
        corpCounts: false,
        maxLayers: 2,
        perInviterCap: null,
        perConsumeCapPct: null,
      })
      prisma.$queryRaw.mockResolvedValue([poolLot])
      teamChainMock(
        { invitedById: 123, admin: { invitedById: 123, corpPassUp: null } },
        { 123: distUser({ id: 123 }) }
      )

      await service.consumeTeamCredits(7, 133, 20, 2, { source: "llm.generic" })

      expect(rebateLots()).toHaveLength(0)
    })

    it("管理员单独开「进企业后仍计返利」（corpPassUp=true）→ 全局 corpCounts=false 也照返（逐人设定优先于全局）", async () => {
      prisma.rebateRule.findFirst.mockResolvedValue({
        id: 1,
        corpCounts: false,
        maxLayers: 2,
        perInviterCap: null,
        perConsumeCapPct: null,
      })
      prisma.$queryRaw.mockResolvedValue([poolLot])
      teamChainMock(
        { invitedById: 123, admin: { invitedById: 123, corpPassUp: true } },
        { 123: distUser({ id: 123 }) }
      )

      await service.consumeTeamCredits(7, 133, 20, 2, { source: "llm.generic" })

      const lots = rebateLots()
      expect(lots).toHaveLength(1)
      expect(lots[0].data.userId).toBe(123)
      expect(lots[0].data.amount.toString()).toBe("6")
    })

    it("管理员单独关（corpPassUp=false）→ 全局 corpCounts=true 也不返", async () => {
      prisma.$queryRaw.mockResolvedValue([poolLot])
      teamChainMock(
        { invitedById: 123, admin: { invitedById: 123, corpPassUp: false } },
        { 123: distUser({ id: 123 }) }
      )

      await service.consumeTeamCredits(7, 133, 20, 2, { source: "llm.generic" })

      expect(rebateLots()).toHaveLength(0)
    })
  })

  describe("consumeCredits 桶域与共享开关（bucketScope/skipInviterShare，混合扣费分段用）", () => {
    const scopedUser = {
      id: 1,
      invitedById: 2,
      discount: new Decimal(1),
    }

    it("bucketScope=[PACKAGE,GIFT]：只扣赠送层批次，balanceAfter 仍按全量净额展示", async () => {
      prisma.user.findUnique.mockResolvedValue(scopedUser)
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.PACKAGE,
          remaining: new Decimal(30),
          expiresAt: new Date(Date.now() + 86400_000),
          grantedAt: new Date(),
        },
        {
          id: 12,
          userId: 1,
          bucket: CreditBucket.GIFT,
          remaining: new Decimal(20),
          expiresAt: new Date(Date.now() + 2 * 86400_000),
          grantedAt: new Date(),
        },
      ])
      // 聚合调用序：①展示全量净额 ②域内预算（PACKAGE+GIFT=50）③结尾 balanceAfter 全量
      prisma.creditLot.aggregate
        .mockResolvedValueOnce({ _sum: { remaining: new Decimal(500) } })
        .mockResolvedValueOnce({ _sum: { remaining: new Decimal(50) } })
        .mockResolvedValue({ _sum: { remaining: new Decimal(460) } })

      const res = await service.consumeCredits(1, 40, 4, {
        bucketScope: [CreditBucket.PACKAGE, CreditBucket.GIFT],
        skipInviterShare: true,
      })

      // 赠送层合池 FIFO：PACKAGE(30) 先过期先扣 → GIFT 补 10
      const txns = firstArgs<{
        data: { bucket?: CreditBucket; amount: Decimal; balanceAfter: Decimal }
      }>(prisma.creditTransaction.create)
      const consumeRows = txns.filter(
        t => t.data.bucket === CreditBucket.PACKAGE || t.data.bucket === CreditBucket.GIFT
      )
      expect(consumeRows.map(t => t.data.bucket)).toEqual([CreditBucket.PACKAGE, CreditBucket.GIFT])
      expect(consumeRows[0].data.amount.toString()).toBe("30")
      expect(consumeRows[1].data.amount.toString()).toBe("10")
      // balanceAfter 用全量净额逐行递减（500 → 470 → 460），不是域内净额
      expect(consumeRows[0].data.balanceAfter.toString()).toBe("470")
      expect(consumeRows[1].data.balanceAfter.toString()).toBe("460")
      expect(res.creditsCharged.toString()).toBe("40")
    })

    it("bucketScope 域内余额不足（域外 RECHARGE 充足也不动）→ 抛「积分余额不足」", async () => {
      prisma.user.findUnique.mockResolvedValue(scopedUser)
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.PACKAGE,
          remaining: new Decimal(30),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])
      // ①全量 10000（含 RECHARGE）②域内只有 30 < 40
      prisma.creditLot.aggregate
        .mockResolvedValueOnce({ _sum: { remaining: new Decimal(10000) } })
        .mockResolvedValueOnce({ _sum: { remaining: new Decimal(30) } })

      await expect(
        service.consumeCredits(1, 40, 4, {
          bucketScope: [CreditBucket.PACKAGE, CreditBucket.GIFT],
          skipInviterShare: true,
        })
      ).rejects.toThrow("积分余额不足，请充值")
      expect(prisma.creditLot.update).not.toHaveBeenCalled()
    })

    it("skipInviterShare：邀请人开了共享也不拉取其额度（不查邀请人、不写邀请人行）", async () => {
      prisma.user.findUnique.mockImplementation(({ where: { id } }: { where: { id: number } }) => {
        if (id === 1) return Promise.resolve(scopedUser)
        return Promise.resolve({ id: 2, rebateRate: null, shareCreditsWithInvitees: true })
      })
      // 只锁到本人 1 个批次（正常内核会把邀请人批次也 IN 进来；此处验证根本不会去查邀请人）
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.RECHARGE,
          remaining: new Decimal(100),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])

      await service.consumeCredits(1, 50, 5, { skipInviterShare: true })

      // 不拉取邀请人共享额度：没有任何一次 user.findUnique 查 shareCreditsWithInvitees
      // （返利链 settleRebatesInTx 仍会正常查邀请人，但 select 不含该字段）
      const userCalls = prisma.user.findUnique.mock.calls as unknown as Array<
        [{ where: { id: number }; select?: Record<string, unknown> }]
      >
      expect(userCalls.some(c => c[0].select?.shareCreditsWithInvitees === true)).toBe(false)
      // 流水全部记在本人（relatedUserId 均为 null）
      const txns = firstArgs<{ data: { relatedUserId?: number | null } }>(
        prisma.creditTransaction.create
      )
      expect(txns.every(t => t.data.relatedUserId == null)).toBe(true)
    })

    it("桶域不含 RECHARGE 且 allowOverdraft 仍有缺口 → 抛错而非落域外欠账批次", async () => {
      prisma.user.findUnique.mockResolvedValue(scopedUser)
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 11,
          userId: 1,
          bucket: CreditBucket.PACKAGE,
          remaining: new Decimal(20),
          expiresAt: null,
          grantedAt: new Date(),
        },
      ])
      prisma.creditLot.aggregate
        .mockResolvedValueOnce({ _sum: { remaining: new Decimal(500) } }) // 展示全量
        .mockResolvedValueOnce({ _sum: { remaining: new Decimal(20) } }) // 域内 20
        .mockResolvedValue({ _sum: { remaining: new Decimal(480) } })

      await expect(
        service.consumeCredits(1, 50, 5, {
          allowOverdraft: true,
          bucketScope: [CreditBucket.PACKAGE, CreditBucket.GIFT],
          skipInviterShare: true,
        })
      ).rejects.toThrow("积分余额不足，请充值")
    })
  })

  describe("混合扣费预读（lockPersonalBalancesInTx / lockTeamPoolBalanceInTx）", () => {
    it("lockPersonalBalancesInTx：锁本人批次后返回分层净额（赠送层/充值层/合计）", async () => {
      prisma.creditLot.aggregate
        .mockResolvedValueOnce({ _sum: { remaining: new Decimal(50) } }) // 赠送层
        .mockResolvedValueOnce({ _sum: { remaining: new Decimal(300) } }) // 充值层

      const res = await service.lockPersonalBalancesInTx(
        prisma as unknown as Prisma.TransactionClient,
        1
      )

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1) // FOR UPDATE 锁
      expect(res.giftLayer.toString()).toBe("50")
      expect(res.recharge.toString()).toBe("300")
      expect(res.total.toString()).toBe("350")
    })

    it("lockTeamPoolBalanceInTx：锁企业池批次后返回池净额（含负批次）", async () => {
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(800) } })

      const res = await service.lockTeamPoolBalanceInTx(
        prisma as unknown as Prisma.TransactionClient,
        7
      )

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(res.toString()).toBe("800")
    })
  })

  describe("getConsumableBalanceRouted（2026-09-01，开放接口 balance 预检口径）", () => {
    it("非企业成员 → 仅个人三桶", async () => {
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(100) } })
      const res = await service.getConsumableBalanceRouted(1)
      expect(res.toString()).toBe("100")
      expect(prisma.creditLot.aggregate).toHaveBeenCalledTimes(1)
    })

    it("占用中企业成员 → 个人 + 企业池合计（与 consumeRouted 扣费能力一致）", async () => {
      prisma.teamMember.findFirst.mockResolvedValue({ teamId: 42 })
      prisma.creditLot.aggregate
        .mockResolvedValueOnce({ _sum: { remaining: new Decimal(100) } }) // 个人
        .mockResolvedValueOnce({ _sum: { remaining: new Decimal(19000) } }) // 池
      const res = await service.getConsumableBalanceRouted(1)
      expect(res.toString()).toBe("19100")
    })
  })

  describe("assertAffordable", () => {
    it("普通用户只按本人余额预检，并使用消费者自己的折扣", async () => {
      prisma.user.findUnique.mockResolvedValue({
        discount: new Decimal("0.8"),
        invitedBy: null,
      })
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(40) } })

      await expect(service.assertAffordable(1, 5)).resolves.toBeUndefined()
      expect(prisma.creditLot.aggregate).toHaveBeenCalledTimes(1)
      const query = firstArgs<{
        where: { userId: number; bucket: { in: CreditBucket[] } }
      }>(prisma.creditLot.aggregate)[0]
      expect(query.where.userId).toBe(1)
      expect(query.where.bucket.in).toEqual([
        CreditBucket.RECHARGE,
        CreditBucket.PACKAGE,
        CreditBucket.GIFT,
      ])
    })

    it("邀请人开启共享：本人和邀请人可消费正净额合并参与预检", async () => {
      prisma.user.findUnique.mockResolvedValue({
        discount: new Decimal(1),
        invitedBy: { id: 2, shareCreditsWithInvitees: true, canInvite: true },
      })
      prisma.creditLot.aggregate.mockImplementation((arg: { where?: { userId?: number } }) =>
        Promise.resolve({
          _sum: { remaining: arg.where?.userId === 1 ? new Decimal(20) : new Decimal(30) },
        })
      )

      await expect(service.assertAffordable(1, 5)).resolves.toBeUndefined()
      const queriedUserIds = firstArgs<{ where: { userId: number } }>(
        prisma.creditLot.aggregate
      ).map(arg => arg.where.userId)
      expect(queriedUserIds).toEqual([1, 2])
    })

    it("邀请人关闭共享：即使邀请人余额充足也只校验本人余额", async () => {
      prisma.user.findUnique.mockResolvedValue({
        discount: new Decimal(1),
        invitedBy: { id: 2, shareCreditsWithInvitees: false },
      })
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(20) } })

      await expect(service.assertAffordable(1, 5)).rejects.toThrow(
        "积分余额不足，无法生成（预计需 50 积分）"
      )
      expect(prisma.creditLot.aggregate).toHaveBeenCalledTimes(1)
    })

    it("本人为负余额：不抵消邀请人的共享正净额", async () => {
      prisma.user.findUnique.mockResolvedValue({
        discount: new Decimal(1),
        invitedBy: { id: 2, shareCreditsWithInvitees: true, canInvite: true },
      })
      prisma.creditLot.aggregate.mockImplementation((arg: { where?: { userId?: number } }) =>
        Promise.resolve({
          _sum: { remaining: arg.where?.userId === 1 ? new Decimal(-100) : new Decimal(50) },
        })
      )

      await expect(service.assertAffordable(1, 5)).resolves.toBeUndefined()
    })

    it("共享后的正净额合计仍不足时拒绝提交", async () => {
      prisma.user.findUnique.mockResolvedValue({
        discount: new Decimal(1),
        invitedBy: { id: 2, shareCreditsWithInvitees: true, canInvite: true },
      })
      prisma.creditLot.aggregate.mockImplementation((arg: { where?: { userId?: number } }) =>
        Promise.resolve({
          _sum: { remaining: arg.where?.userId === 1 ? new Decimal(20) : new Decimal(29) },
        })
      )

      await expect(service.assertAffordable(1, 5)).rejects.toThrow(
        "积分余额不足，无法生成（预计需 50 积分）"
      )
    })

    it("用户不存在时抛出 NotFound，且不查询积分余额", async () => {
      prisma.user.findUnique.mockResolvedValue(null)

      await expect(service.assertAffordable(999, 5)).rejects.toThrow("用户不存在")
      expect(prisma.creditLot.aggregate).not.toHaveBeenCalled()
    })
  })

  describe("expireLots", () => {
    it("过期 PACKAGE 批次置 EXPIRED + 写 EXPIRE 流水", async () => {
      prisma.creditLot.findMany.mockResolvedValue([
        { id: 20, userId: 1, bucket: CreditBucket.PACKAGE },
      ])
      prisma.creditLot.findUnique.mockResolvedValue({
        remaining: new Decimal(40),
        status: CreditLotStatus.ACTIVE,
      })

      const res = await service.expireLots(new Date())

      expect(res.expired).toBe(1)
      expect(prisma.creditLot.update).toHaveBeenCalledWith({
        where: { id: 20 },
        data: { remaining: 0, status: CreditLotStatus.EXPIRED },
      })
      const expireTxn = firstArgs<TxnCreateArg & { data: { source?: string } }>(
        prisma.creditTransaction.create
      ).find(t => t.data.type === CreditTxnType.EXPIRE)
      expect(expireTxn?.data.bucket).toBe(CreditBucket.PACKAGE)
      expect(expireTxn?.data.amount.toString()).toBe("40")
      expect(expireTxn?.data.source).toBe("system.expire") // 每日到期清零（系统回收）
    })

    it("过期 GIFT(注册赠送)批次同样置 EXPIRED + 写 EXPIRE 流水", async () => {
      prisma.creditLot.findMany.mockResolvedValue([
        { id: 21, userId: 1, bucket: CreditBucket.GIFT },
      ])
      prisma.creditLot.findUnique.mockResolvedValue({
        remaining: new Decimal(200),
        status: CreditLotStatus.ACTIVE,
      })

      const res = await service.expireLots(new Date())

      expect(res.expired).toBe(1)
      const expireTxn = firstArgs<TxnCreateArg>(prisma.creditTransaction.create).find(
        t => t.data.type === CreditTxnType.EXPIRE
      )
      expect(expireTxn?.data.bucket).toBe(CreditBucket.GIFT)
      expect(expireTxn?.data.amount.toString()).toBe("200")
    })

    it("批次已被并发扣空则跳过、不重复留痕", async () => {
      prisma.creditLot.findMany.mockResolvedValue([{ id: 20, userId: 1 }])
      prisma.creditLot.findUnique.mockResolvedValue({
        remaining: new Decimal(0),
        status: CreditLotStatus.EXHAUSTED,
      })
      const res = await service.expireLots(new Date())
      expect(res.expired).toBe(0)
      expect(prisma.creditTransaction.create).not.toHaveBeenCalled()
    })

    it("只清个人批次：查询排除团队批次（teamId=null；团队批次宽限期保留、归档统一清）", async () => {
      prisma.creditLot.findMany.mockResolvedValue([])

      await service.expireLots(new Date())

      const where = (
        prisma.creditLot.findMany.mock.calls as unknown as [{ where: unknown }][]
      )[0][0].where as Record<string, unknown>
      expect(where.teamId).toBeNull()
    })
  })

  describe("getWallet", () => {
    it("汇总各桶余额 + 等级 + 本月/累计消耗", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        canInvite: false,
        invitedById: null,
        subscriptionTier: 2,
        subscriptionExpiresAt: new Date(Date.now() + 10 * 86400000), // 在期
        discount: new Decimal(1),
        rebateRate: new Decimal("0.3"),
      })
      const future = new Date(Date.now() + 86400000)
      prisma.creditLot.findMany.mockResolvedValue([
        { bucket: CreditBucket.RECHARGE, remaining: new Decimal(50), expiresAt: null },
        { bucket: CreditBucket.PACKAGE, remaining: new Decimal(30), expiresAt: future },
      ])
      prisma.creditTransaction.aggregate
        .mockResolvedValueOnce({ _sum: { amount: new Decimal(10) } }) // 本月
        .mockResolvedValueOnce({ _sum: { amount: new Decimal(200) } }) // 累计

      const w = await service.getWallet(1)

      expect(w.level).toBe("LV2")
      expect(w.buckets.recharge.toString()).toBe("50")
      expect(w.buckets.package.toString()).toBe("30")
      expect(w.total.toString()).toBe("80")
      expect(w.monthUsed.toString()).toBe("10")
      expect(w.totalConsumed.toString()).toBe("200")
      expect(w.nextExpireAt).toEqual(future)
    })

    it("已过期订阅：等级读时按有效期推导为 NONE（不等每日降级任务）", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        canInvite: false,
        invitedById: null,
        subscriptionTier: 2, // 库中 tier 尚未被每日任务置空
        subscriptionExpiresAt: new Date(Date.now() - 86400000), // 已过期
        discount: new Decimal(1),
        rebateRate: new Decimal("0.3"),
      })
      prisma.creditLot.findMany.mockResolvedValue([])
      prisma.creditTransaction.aggregate
        .mockResolvedValueOnce({ _sum: { amount: null } })
        .mockResolvedValueOnce({ _sum: { amount: null } })

      const w = await service.getWallet(1)
      expect(w.level).toBe("NONE")
    })

    it("到期降级任务：把到期未续费用户 tier 置空 + 等级回写 NONE", async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 3 })
      const res = await service.downgradeExpiredSubscriptions(new Date("2026-08-25T00:00:00Z"))
      expect(res.downgraded).toBe(3)
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: {
          subscriptionTier: { not: null },
          subscriptionExpiresAt: { not: null, lte: new Date("2026-08-25T00:00:00Z") },
        },
        data: { subscriptionTier: null, membershipLevel: "NONE" },
      })
    })

    it("被邀请人(LV4)：inviterShareCredits 回显邀请人是否开启共享额度", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 7,
        canInvite: false,
        invitedById: 2,
        subscriptionTier: 1,
        subscriptionExpiresAt: null,
        discount: new Decimal(1),
        rebateRate: new Decimal("0.3"),
        invitedBy: { id: 2, username: "王老板", shareCreditsWithInvitees: true, canInvite: true },
      })
      prisma.creditLot.findMany.mockResolvedValue([])
      prisma.creditTransaction.aggregate
        .mockResolvedValueOnce({ _sum: { amount: null } })
        .mockResolvedValueOnce({ _sum: { amount: null } })

      const w = await service.getWallet(7)

      expect(w.inviter).toEqual({ id: 2, username: "王老板" })
      expect(w.inviterShareCredits).toBe(true)
    })

    it("无邀请人：inviter 为 null、inviterShareCredits 为 null", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        canInvite: false,
        invitedById: null,
        subscriptionTier: 1,
        subscriptionExpiresAt: null,
        discount: new Decimal(1),
        rebateRate: new Decimal("0.3"),
      })
      prisma.creditLot.findMany.mockResolvedValue([])
      prisma.creditTransaction.aggregate
        .mockResolvedValueOnce({ _sum: { amount: null } })
        .mockResolvedValueOnce({ _sum: { amount: null } })

      const w = await service.getWallet(1)

      expect(w.inviter).toBeNull()
      expect(w.inviterShareCredits).toBeNull()
    })

    it("已消耗/本月已用 纳入「动用邀请人额度」的消费（userId=自己 ∪ relatedUserId=自己）", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 7,
        canInvite: false,
        invitedById: 2,
        subscriptionTier: 1,
        subscriptionExpiresAt: null,
        discount: new Decimal(1),
        rebateRate: new Decimal("0.3"),
        invitedBy: { id: 2, username: "王老板", shareCreditsWithInvitees: true, canInvite: true },
      })
      prisma.creditLot.findMany.mockResolvedValue([])
      prisma.creditTransaction.aggregate
        .mockResolvedValueOnce({ _sum: { amount: new Decimal(8) } }) // 本月
        .mockResolvedValueOnce({ _sum: { amount: new Decimal(20) } }) // 累计

      const w = await service.getWallet(7)

      expect(w.monthUsed.toString()).toBe("8")
      expect(w.totalConsumed.toString()).toBe("20")
      // 两个聚合都按「自己池 ∪ 动用邀请人额度」统计
      const calls = prisma.creditTransaction.aggregate.mock.calls as unknown as Array<
        [{ where: { OR?: unknown } }]
      >
      expect(calls[0][0].where.OR).toEqual([{ userId: 7 }, { relatedUserId: 7 }])
      expect(calls[1][0].where.OR).toEqual([{ userId: 7 }, { relatedUserId: 7 }])
    })
  })

  describe("activateDuePlans（续费排队激活）", () => {
    const pendingPlan = {
      id: 7,
      userId: 1,
      tier: 2,
      planName: "Plus",
      priceCny: new Decimal(399),
      packageCredits: 4000,
      giftCredits: 600,
      periodDays: 30,
      activateAt: new Date("2026-06-30T00:00:00.000Z"),
    }

    it("到期且当前订阅已结束 → 建 PACKAGE+GIFT 两批次、切订阅/等级、标 ACTIVATED，且不写充值流水", async () => {
      prisma.scheduledPlan.findFirst.mockResolvedValueOnce(pendingPlan) // 第二轮默认 null 终止
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        canInvite: false,
        invitedById: null,
        subscriptionExpiresAt: null, // 当前无有效订阅
      })

      const res = await service.activateDuePlans(1, new Date("2026-06-30T12:00:00.000Z"))

      expect(res.activated).toBe(1)
      // 激活只建批次：套餐本体 PACKAGE 4000 + 赠送 GIFT 600，过期都 = activateAt + 30d
      const lots = firstArgs<LotCreateArg>(prisma.creditLot.create)
      expect(lots).toHaveLength(2)
      expect(lots[0].data.bucket).toBe(CreditBucket.PACKAGE)
      expect(new Decimal(lots[0].data.amount).toString()).toBe("4000")
      expect(lots[0].data.expiresAt).toEqual(new Date("2026-07-30T00:00:00.000Z"))
      expect(lots[1].data.bucket).toBe(CreditBucket.GIFT)
      expect(new Decimal(lots[1].data.amount).toString()).toBe("600")
      expect(lots[1].data.expiresAt).toEqual(new Date("2026-07-30T00:00:00.000Z"))
      // 切订阅 + 等级 LV2，新到期 = activateAt + 30d
      const upd = (
        prisma.user.update.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>
      )[0][0]
      expect(upd.data.subscriptionTier).toBe(2)
      expect(upd.data.membershipLevel).toBe("LV2")
      expect(upd.data.subscriptionExpiresAt).toEqual(new Date("2026-07-30T00:00:00.000Z"))
      // 抢占式标 ACTIVATED（条件 updateMany：id + status=PENDING）
      const spUpd = firstArgs<{ where: { id: number; status: string }; data: { status: string } }>(
        prisma.scheduledPlan.updateMany
      )[0]
      expect(spUpd.where.id).toBe(7)
      expect(spUpd.where.status).toBe("PENDING")
      expect(spUpd.data.status).toBe("ACTIVATED")
      // 激活时不再写充值流水（已在下单时记过）
      expect(prisma.creditTransaction.create).not.toHaveBeenCalled()
    })

    it("并发抢占失败（updateMany count=0）→ 不发积分、不切档、不计数", async () => {
      prisma.scheduledPlan.findFirst
        .mockResolvedValueOnce(pendingPlan) // 第一轮拿到 plan
        .mockResolvedValueOnce(null) // 第二轮无 plan → 停
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        canInvite: false,
        invitedById: null,
        subscriptionExpiresAt: null,
      })
      prisma.scheduledPlan.updateMany.mockResolvedValue({ count: 0 }) // 被并发抢走

      const res = await service.activateDuePlans(1, new Date("2026-06-30T12:00:00.000Z"))

      expect(res.activated).toBe(0)
      expect(prisma.creditLot.create).not.toHaveBeenCalled()
      expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it("当前订阅仍在有效期 → 不激活（待生效套餐继续排队）", async () => {
      prisma.scheduledPlan.findFirst.mockResolvedValueOnce(pendingPlan)
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        canInvite: false,
        invitedById: null,
        subscriptionExpiresAt: new Date("2026-12-31T00:00:00.000Z"), // 仍有效
      })

      const res = await service.activateDuePlans(1, new Date("2026-06-30T12:00:00.000Z"))

      expect(res.activated).toBe(0)
      expect(prisma.creditLot.create).not.toHaveBeenCalled()
      expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it("无到期待生效套餐 → 无操作、不加载用户", async () => {
      prisma.scheduledPlan.findFirst.mockResolvedValue(null)
      const res = await service.activateDuePlans(1)
      expect(res.activated).toBe(0)
      expect(prisma.user.findUnique).not.toHaveBeenCalled()
    })
  })

  describe("scheduleRenewal（续费排队下单）", () => {
    const snapshot = {
      tier: 2,
      planName: "Plus",
      priceCny: new Decimal(399),
      packageCredits: 4000,
      giftCredits: 600,
      periodDays: 30,
    }

    it("当前订阅有效 → 排到当前到期日之后，写充值流水(待生效)但不发批次", async () => {
      prisma.scheduledPlan.findFirst.mockResolvedValue(null) // 无到期可激活
      const expiry = new Date("2026-06-30T00:00:00.000Z")
      prisma.user.findUnique.mockResolvedValue({ subscriptionExpiresAt: expiry })
      prisma.scheduledPlan.findMany.mockResolvedValue([]) // 无已排队
      prisma.scheduledPlan.create.mockResolvedValue({ id: 9, activateAt: expiry })

      await service.scheduleRenewal(1, snapshot, new Date("2026-06-23T00:00:00.000Z"))

      // 排队记录：activateAt = 当前订阅到期日
      const created = (
        prisma.scheduledPlan.create.mock.calls as unknown as Array<
          [{ data: { activateAt: Date; tier: number; status: string } }]
        >
      )[0][0]
      expect(created.data.activateAt).toEqual(expiry)
      expect(created.data.tier).toBe(2)
      expect(created.data.status).toBe("PENDING")
      // 付款即记一条充值流水（RECHARGE_PLAN / CREDIT / 待生效），balanceAfter=null，不发批次
      const txn = firstArgs<TxnCreateArg>(prisma.creditTransaction.create)[0]
      expect(txn.data.type).toBe(CreditTxnType.RECHARGE_PLAN)
      expect(txn.data.amount.toString()).toBe("4600")
      expect(prisma.creditLot.create).not.toHaveBeenCalled() // 积分尚未到账
    })

    it("当前无有效订阅 → activateAt=now 并立即激活（建批次）", async () => {
      const now = new Date("2026-06-23T00:00:00.000Z")
      // findFirst：①下单前 flush=null ②下单后激活返回新套餐 ③再查 null 终止
      prisma.scheduledPlan.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 9,
          userId: 1,
          tier: 2,
          planName: "Plus",
          priceCny: new Decimal(399),
          packageCredits: 4000,
          giftCredits: 600,
          periodDays: 30,
          activateAt: now,
        })
        .mockResolvedValue(null)
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        canInvite: false,
        invitedById: null,
        subscriptionExpiresAt: null,
      })
      prisma.scheduledPlan.findMany.mockResolvedValue([])
      prisma.scheduledPlan.create.mockResolvedValue({ id: 9, activateAt: now })

      await service.scheduleRenewal(1, snapshot, now)

      // 立即激活：建了 PACKAGE 4000 + GIFT 600 两批次
      const lots = firstArgs<LotCreateArg>(prisma.creditLot.create)
      expect(lots.map(l => [l.data.bucket, new Decimal(l.data.amount).toString()])).toEqual([
        [CreditBucket.PACKAGE, "4000"],
        [CreditBucket.GIFT, "600"],
      ])
      // 且付款充值流水也记了
      expect(
        firstArgs<TxnCreateArg>(prisma.creditTransaction.create).some(
          t => t.data.type === CreditTxnType.RECHARGE_PLAN
        )
      ).toBe(true)
    })
  })

  describe("renewImmediateInTx（续费立即生效，2026-08-25 起废排队制）", () => {
    const snapshot = {
      tier: 2,
      planName: "Plus",
      priceCny: new Decimal(399),
      packageCredits: 4000,
      giftCredits: 600,
      periodDays: 30,
    }

    it("在期同档续费：有效期在原到期日上顺延 + 积分立即到账（两批次）+ 一条充值流水（无待生效标记）", async () => {
      const expiry = new Date("2026-06-30T00:00:00.000Z")
      const start = new Date("2026-06-01T00:00:00.000Z")
      prisma.user.findUnique.mockResolvedValue({
        subscriptionTier: 2,
        subscriptionStart: start,
        subscriptionExpiresAt: expiry,
      })
      const now = new Date("2026-06-23T00:00:00.000Z")

      const res = await service.renewImmediateInTx(prisma, 1, snapshot, now)

      const newExpiry = new Date("2026-07-30T00:00:00.000Z") // 原到期 + 30 天
      expect(res.expiresAt).toEqual(newExpiry)
      // 两批次立即到账，到期日 = 新有效期
      const lots = firstArgs<LotCreateArg>(prisma.creditLot.create)
      expect(lots.map(l => [l.data.bucket, new Decimal(l.data.amount).toString()])).toEqual([
        [CreditBucket.PACKAGE, "4000"],
        [CreditBucket.GIFT, "600"],
      ])
      expect(lots[0].data.expiresAt).toEqual(newExpiry)
      // 一条合并充值流水（recordRecharge：bucket=null、amount=合计、balanceAfter 非 null、无 scheduled）
      const txns = firstArgs<TxnCreateArg>(prisma.creditTransaction.create)
      expect(txns).toHaveLength(1)
      expect(txns[0].data.type).toBe(CreditTxnType.RECHARGE_PLAN)
      expect(txns[0].data.amount.toString()).toBe("4600")
      // 切档 + 有效期顺延；subscriptionStart 保留原值
      const upd = (
        prisma.user.update.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>
      )[0][0]
      expect(upd.data.subscriptionTier).toBe(2)
      expect(upd.data.membershipLevel).toBe("LV2")
      expect(upd.data.subscriptionExpiresAt).toEqual(newExpiry)
      expect(upd.data.subscriptionStart).toEqual(start)
    })

    it("存量套餐批次顺延：续费前未过期的 RECHARGE_PLAN PACKAGE/GIFT 批次统一延长到新有效期", async () => {
      const expiry = new Date("2026-06-30T00:00:00.000Z")
      prisma.user.findUnique.mockResolvedValue({
        subscriptionTier: 2,
        subscriptionStart: new Date("2026-06-01T00:00:00.000Z"),
        subscriptionExpiresAt: expiry,
      })
      const now = new Date("2026-06-23T00:00:00.000Z")

      await service.renewImmediateInTx(prisma, 1, snapshot, now)

      const newExpiry = new Date("2026-07-30T00:00:00.000Z")
      const [args] = firstArgs<{ where: Record<string, unknown>; data: { expiresAt: Date } }>(
        prisma.creditLot.updateMany
      )
      expect(args.data.expiresAt).toEqual(newExpiry)
      expect(args.where).toEqual({
        userId: 1,
        teamId: null,
        sourceType: CreditTxnType.RECHARGE_PLAN, // 只顺延套餐来源；注册赠送/充值包赠送/客服补偿不动
        bucket: { in: [CreditBucket.PACKAGE, CreditBucket.GIFT] },
        status: CreditLotStatus.ACTIVE,
        remaining: { gt: 0 },
        expiresAt: { gt: now, lt: newExpiry }, // 已过期的不复活、新批次（=newExpiry）不重复动
      })
    })

    it("已过期续费：以 now 为基准新起一期（subscriptionStart=now）", async () => {
      prisma.user.findUnique.mockResolvedValue({
        subscriptionTier: 2,
        subscriptionStart: new Date("2026-04-01T00:00:00.000Z"),
        subscriptionExpiresAt: new Date("2026-05-01T00:00:00.000Z"), // 已过期
      })
      const now = new Date("2026-06-23T00:00:00.000Z")

      const res = await service.renewImmediateInTx(prisma, 1, snapshot, now)

      expect(res.expiresAt).toEqual(new Date("2026-07-23T00:00:00.000Z")) // now + 30 天
      const upd = (
        prisma.user.update.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>
      )[0][0]
      expect(upd.data.subscriptionStart).toEqual(now)
    })

    it("在期高等级续费低等级 → 400，不写任何数据", async () => {
      prisma.user.findUnique.mockResolvedValue({
        subscriptionTier: 3,
        subscriptionStart: new Date("2026-06-01T00:00:00.000Z"),
        subscriptionExpiresAt: new Date("2026-06-30T00:00:00.000Z"), // 在期
      })

      await expect(
        service.renewImmediateInTx(prisma, 1, snapshot, new Date("2026-06-23T00:00:00.000Z"))
      ).rejects.toThrow("高等级套餐不能续费低等级套餐")
      expect(prisma.creditLot.create).not.toHaveBeenCalled()
      expect(prisma.creditTransaction.create).not.toHaveBeenCalled()
      expect(prisma.user.update).not.toHaveBeenCalled()
    })
  })

  describe("recordRecharge（多批次合并 1 条流水）", () => {
    it("建本金+赠送两批次，只写一条合并流水（amount=合计），跳过 0 批次", async () => {
      await service.recordRecharge(1, {
        type: CreditTxnType.RECHARGE_PACK,
        source: "admin.recharge.pack",
        sourceRef: "pack:2",
        lots: [
          { bucket: CreditBucket.RECHARGE, amount: 1000, expiresAt: null },
          {
            bucket: CreditBucket.PACKAGE,
            amount: 100,
            expiresAt: new Date("2026-07-30T00:00:00.000Z"),
          },
          { bucket: CreditBucket.PACKAGE, amount: 0 }, // 0 批次跳过
        ],
        meta: { packId: 2, priceCny: 100 },
      })

      const lots = firstArgs<LotCreateArg>(prisma.creditLot.create)
      expect(lots).toHaveLength(2)
      expect(lots.map(l => l.data.bucket)).toEqual([CreditBucket.RECHARGE, CreditBucket.PACKAGE])

      const txns = firstArgs<TxnCreateArg>(prisma.creditTransaction.create)
      expect(txns).toHaveLength(1)
      expect(txns[0].data.type).toBe(CreditTxnType.RECHARGE_PACK)
      expect(txns[0].data.amount.toString()).toBe("1100") // 1000 + 100 合计
    })

    it("全部批次为 0 → 不建批次、不写流水", async () => {
      await service.recordRecharge(1, {
        type: CreditTxnType.RECHARGE_CUSTOM,
        source: "admin.recharge.custom",
        lots: [{ bucket: CreditBucket.RECHARGE, amount: 0 }],
      })
      expect(prisma.creditLot.create).not.toHaveBeenCalled()
      expect(prisma.creditTransaction.create).not.toHaveBeenCalled()
    })

    it("teamId 有值（企业池入账）时 balanceAfter 取池余额，而非个人可消费合计", async () => {
      prisma.creditLot.aggregate.mockImplementation((arg: { where?: { teamId?: number } }) =>
        Promise.resolve({
          _sum: { remaining: new Decimal(arg.where?.teamId === 11 ? "58101" : "3101") },
        })
      )
      await service.recordRecharge(7, {
        type: CreditTxnType.TEAM_RECHARGE,
        source: "billing.order",
        lots: [{ bucket: CreditBucket.RECHARGE, amount: 3101, expiresAt: null }],
        teamId: 11,
      })
      const txns = firstArgs<TxnCreateArg & { data: { teamId?: number; balanceAfter?: Decimal } }>(
        prisma.creditTransaction.create
      )
      expect(txns).toHaveLength(1)
      expect(txns[0].data.teamId).toBe(11)
      expect(txns[0].data.balanceAfter?.toString()).toBe("58101") // 池余额，不是个人的 3101
    })
  })

  describe("transferGiftLotsToTeam（成员赠送积分转入企业）", () => {
    it("只锁定个人有效 GIFT，按剩余数转入并保留各批次到期时间", async () => {
      const expiresAt = [new Date("2026-10-20T00:00:00Z"), new Date("2026-11-01T00:00:00Z"), null]
      const lots = expiresAt.map((expiry, i) => ({
        id: i + 1,
        remaining: new Decimal(["100.125", "50", "20"][i]),
        expiresAt: expiry,
      }))
      prisma.$queryRaw.mockResolvedValue(lots)
      jest.spyOn(service, "consumableBalance").mockResolvedValue(new Decimal(300))
      jest.spyOn(service, "teamPoolBalance").mockResolvedValue(new Decimal("1170.125"))

      const total = await service.transferGiftLotsToTeam(7, 11, prisma as never)

      expect(total.toString()).toBe("170.125")
      const [sql, ...params] = prisma.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ]
      expect(sql.join("?")).toMatch(/teamId IS NULL/)
      expect(sql.join("?")).toMatch(/remaining > 0/)
      expect(sql.join("?")).toMatch(/expiresAt IS NULL OR expiresAt > NOW\(\)/)
      expect(sql.join("?")).toMatch(/ORDER BY id\s+FOR UPDATE/)
      expect(params).toEqual([7, CreditBucket.GIFT, CreditLotStatus.ACTIVE])
      expect(prisma.creditLot.update).toHaveBeenCalledTimes(3)
      const createdLots = firstArgs<{ data: Record<string, unknown> }>(prisma.creditLot.create)
      expect(createdLots).toHaveLength(3)
      for (const [i, lot] of lots.entries()) {
        expect(prisma.creditLot.update).toHaveBeenCalledWith({
          where: { id: lot.id },
          data: { remaining: 0, status: CreditLotStatus.EXHAUSTED },
        })
        expect(createdLots[i]).toMatchObject({
          data: {
            userId: 7,
            teamId: 11,
            bucket: CreditBucket.GIFT,
            amount: lot.remaining,
            remaining: lot.remaining,
            expiresAt: lot.expiresAt,
            // 不能保留原 RECHARGE_PLAN，否则企业续费/恢复会延长这些赠送。
            sourceType: CreditTxnType.TEAM_RECHARGE,
          },
        })
      }
      expect(prisma.creditTransaction.create).toHaveBeenCalledTimes(2)
      const txns = firstArgs<{ data: { direction: CreditDirection; teamId?: number | null } }>(
        prisma.creditTransaction.create
      )
      expect(txns.find(t => t.data.direction === CreditDirection.DEBIT)).toMatchObject({
        data: {
          userId: 7,
          direction: CreditDirection.DEBIT,
          bucket: CreditBucket.GIFT,
          type: CreditTxnType.MANUAL_ADJUST,
          amount: new Decimal("170.125"),
          balanceAfter: new Decimal(300),
          source: "team.member.gift.transfer",
          meta: { injectToTeamId: 11, fromLotIds: [1, 2, 3] },
        },
      })
      expect(
        txns.find(t => t.data.direction === CreditDirection.DEBIT)?.data.teamId ?? null
      ).toBeNull()
      expect(txns.find(t => t.data.direction === CreditDirection.CREDIT)).toMatchObject({
        data: {
          userId: 7,
          teamId: 11,
          direction: CreditDirection.CREDIT,
          type: CreditTxnType.TEAM_RECHARGE,
          amount: new Decimal("170.125"),
          balanceAfter: new Decimal("1170.125"),
          source: "team.member.gift.transfer",
        },
      })
      // 必须复用入队事务，不另起事务。
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it("无有效赠送批次（过期/耗尽等均被查询排除）→ 不建批次、不记流水", async () => {
      const total = await service.transferGiftLotsToTeam(7, 11, prisma as never)
      expect(total.toString()).toBe("0")
      expect(prisma.creditLot.update).not.toHaveBeenCalled()
      expect(prisma.creditLot.create).not.toHaveBeenCalled()
      expect(prisma.creditTransaction.create).not.toHaveBeenCalled()
    })

    it("加锁读取最新剩余余额，重复调用不重复转入", async () => {
      // 模拟锁拿到前已有消费完成：原 200 只剩 75.5；转出后再次当前读返回空。
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 1, remaining: new Decimal("75.5"), expiresAt: null }])
        .mockResolvedValueOnce([])

      const first = await service.transferGiftLotsToTeam(7, 11, prisma as never)
      const second = await service.transferGiftLotsToTeam(7, 11, prisma as never)

      expect(first.toString()).toBe("75.5")
      expect(second.toString()).toBe("0")
      expect(prisma.creditLot.create).toHaveBeenCalledTimes(1)
      expect(prisma.creditTransaction.create).toHaveBeenCalledTimes(2)
    })

    it("企业入账失败向外抛出，由入队事务统一回滚", async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 1, remaining: new Decimal(200), expiresAt: null }])
      prisma.creditLot.create.mockRejectedValue(new Error("入账失败"))
      await expect(service.transferGiftLotsToTeam(7, 11, prisma as never)).rejects.toThrow(
        "入账失败"
      )
    })

    it("转入的 GIFT 在企业归档时清零，不退给成员或管理员", async () => {
      prisma.creditLot.findMany.mockResolvedValue([
        { id: 10, userId: 7, teamId: 11, bucket: CreditBucket.GIFT, remaining: new Decimal(200) },
      ])
      const result = await service.archiveTeamPool(11, 100)
      expect(result.returned.toString()).toBe("0")
      expect(prisma.creditLot.create).not.toHaveBeenCalled()
      expect(firstArgs<{ data: Record<string, unknown> }>(prisma.creditTransaction.create)).toEqual(
        [
          {
            data: {
              type: CreditTxnType.EXPIRE,
              bucket: CreditBucket.GIFT,
              amount: new Decimal(200),
              teamId: 11,
              source: "team.archive",
              userId: 7,
              direction: CreditDirection.DEBIT,
              lotId: 10,
            },
          },
        ]
      )
    })
  })

  describe("transferRechargeLotsToTeam（个人充值包注入企业共享池）", () => {
    it("多批次合并一条 DEBIT 行：归属=个人（teamId 空）、meta.injectToTeamId 标记、amount=合计；池侧一条 TEAM_RECHARGE", async () => {
      prisma.creditLot.findMany.mockResolvedValue([
        { id: 1, remaining: new Decimal(2000) },
        { id: 2, remaining: new Decimal(3000) },
      ])

      const total = await service.transferRechargeLotsToTeam(7, 11, {
        source: "billing.order",
        meta: { orderNo: "SR123" },
      })

      expect(total.toString()).toBe("5000")
      // 两个批次都清零置 EXHAUSTED
      const updates = firstArgs<LotUpdateArg>(prisma.creditLot.update)
      expect(updates).toHaveLength(2)
      expect(
        updates.every(u => u.data.remaining === 0 && u.data.status === CreditLotStatus.EXHAUSTED)
      ).toBe(true)
      // 两条流水：个人侧合并 DEBIT + 池侧 TEAM_RECHARGE CREDIT
      const txns = firstArgs<
        TxnCreateArg & {
          data: {
            direction?: CreditDirection
            teamId?: number | null
            meta?: { injectToTeamId?: number; injectedFromPersonal?: boolean }
          }
        }
      >(prisma.creditTransaction.create)
      expect(txns).toHaveLength(2)
      const debit = txns.find(t => t.data.direction === CreditDirection.DEBIT)
      expect(debit).toBeDefined()
      expect(debit!.data.type).toBe(CreditTxnType.MANUAL_ADJUST)
      expect(debit!.data.amount.toString()).toBe("5000") // 合并一行
      expect(debit!.data.teamId ?? null).toBeNull() // 个人户转出，归属=个人
      expect(debit!.data.meta?.injectToTeamId).toBe(11)
      const credit = txns.find(t => t.data.direction === CreditDirection.CREDIT)
      expect(credit).toBeDefined()
      expect(credit!.data.type).toBe(CreditTxnType.TEAM_RECHARGE)
      expect(credit!.data.teamId).toBe(11)
      expect(credit!.data.meta?.injectedFromPersonal).toBe(true)
    })

    it("无可注入批次 → 不写流水", async () => {
      prisma.creditLot.findMany.mockResolvedValue([])
      const total = await service.transferRechargeLotsToTeam(7, 11)
      expect(total.toString()).toBe("0")
      expect(prisma.creditTransaction.create).not.toHaveBeenCalled()
    })
  })

  describe("clearGrantedCredits（切 LV5 清零赠送类）", () => {
    it("PACKAGE + GIFT 两桶都清零、各写 EXPIRE(source=invite.switch)，RECHARGE 不参与", async () => {
      prisma.creditLot.findMany.mockResolvedValue([
        { id: 1, bucket: CreditBucket.PACKAGE, remaining: new Decimal(300), status: "ACTIVE" },
        { id: 2, bucket: CreditBucket.GIFT, remaining: new Decimal(200), status: "ACTIVE" },
      ])

      const n = await service.clearGrantedCredits(1)

      expect(n).toBe(2)
      // 只查 PACKAGE + GIFT 两桶（RECHARGE 不动）
      const where = firstArgs<{ where: { bucket: { in: CreditBucket[] } } }>(
        prisma.creditLot.findMany
      )[0].where
      expect(where.bucket).toEqual({ in: [CreditBucket.PACKAGE, CreditBucket.GIFT] })
      // 两批都置 0 / EXPIRED
      const updates = firstArgs<LotUpdateArg>(prisma.creditLot.update)
      expect(updates).toHaveLength(2)
      expect(updates.every(u => u.data.status === CreditLotStatus.EXPIRED)).toBe(true)
      // 两条 EXPIRE 流水，按各自桶落账、source=invite.switch
      const txns = firstArgs<TxnCreateArg & { data: { source?: string } }>(
        prisma.creditTransaction.create
      )
      expect(txns).toHaveLength(2)
      expect(txns.map(t => t.data.bucket).sort()).toEqual([CreditBucket.GIFT, CreditBucket.PACKAGE])
      expect(
        txns.every(t => t.data.type === CreditTxnType.EXPIRE && t.data.source === "invite.switch")
      ).toBe(true)
    })
  })
})
