import { BadRequestException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { CreditBucket, CreditTxnType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { AdminRechargeService } from "./admin-recharge.service"
import { CreditService } from "./credit.service"
import { RechargeAccessService } from "./recharge-access.service"

type RecordRechargeCall = [
  number,
  {
    type: CreditTxnType
    source: string
    lots: { bucket: CreditBucket; amount: number | Decimal; expiresAt?: Date | null }[]
    meta: Record<string, unknown>
  },
]

describe("AdminRechargeService", () => {
  let service: AdminRechargeService
  let prisma: {
    membershipPlan: { findUnique: jest.Mock }
    rechargePack: { findUnique: jest.Mock }
    user: { findUnique: jest.Mock; update: jest.Mock; findMany: jest.Mock }
    creditLot: { groupBy: jest.Mock }
    creditTransaction: { groupBy: jest.Mock; findMany: jest.Mock; count: jest.Mock }
    scheduledPlan: { findMany: jest.Mock }
    $transaction: jest.Mock
  }
  let credit: {
    grant: jest.Mock
    recordRecharge: jest.Mock
    adjust: jest.Mock
    getWallet: jest.Mock
    withdrawRebate: jest.Mock
    renewImmediateInTx: jest.Mock
    activateDuePlans: jest.Mock
    listScheduledPlans: jest.Mock
    upgradePlanImmediate: jest.Mock
  }
  let access: { invalidate: jest.Mock }

  const recordRechargeCalls = () =>
    credit.recordRecharge.mock.calls as unknown as RecordRechargeCall[]

  beforeEach(async () => {
    prisma = {
      membershipPlan: { findUnique: jest.fn() },
      rechargePack: { findUnique: jest.fn() },
      user: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
      creditLot: { groupBy: jest.fn().mockResolvedValue([]) },
      creditTransaction: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      scheduledPlan: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    }
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma))

    credit = {
      grant: jest.fn().mockResolvedValue({ id: 1 }),
      recordRecharge: jest.fn().mockResolvedValue(undefined),
      adjust: jest.fn().mockResolvedValue(undefined),
      getWallet: jest.fn().mockResolvedValue({ total: new Decimal(0) }),
      withdrawRebate: jest
        .fn()
        .mockResolvedValue({ withdrawn: new Decimal(500), balanceAfter: new Decimal(0) }),
      renewImmediateInTx: jest.fn().mockResolvedValue({ expiresAt: new Date() }),
      activateDuePlans: jest.fn().mockResolvedValue({ activated: 0 }),
      listScheduledPlans: jest.fn().mockResolvedValue([]),
      upgradePlanImmediate: jest.fn().mockResolvedValue({ total: new Decimal(0) }),
    }
    access = { invalidate: jest.fn() }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminRechargeService,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: credit },
        { provide: RechargeAccessService, useValue: access },
      ],
    }).compile()
    service = moduleRef.get(AdminRechargeService)
  })

  // 个人套餐 fixture（chargePlan / quotePlanUpgrade 两个 describe 共用）
  type PlanRow = {
    tier: number
    name: string
    active: boolean
    packageCredits: number
    giftCredits: number
    periodDays: number
    priceCny: Decimal
  }
  const planByTier: Record<number, PlanRow> = {
    2: {
      tier: 2,
      name: "Plus",
      active: true,
      packageCredits: 4000,
      giftCredits: 600,
      periodDays: 30,
      priceCny: new Decimal(399),
    },
    3: {
      tier: 3,
      name: "Ultra",
      active: true,
      packageCredits: 7000,
      giftCredits: 2000,
      periodDays: 30,
      priceCny: new Decimal(699),
    },
  }
  const mockPlans = () =>
    prisma.membershipPlan.findUnique.mockImplementation((...args: unknown[]) => {
      const tier = (args[0] as { where: { tier: number } }).where.tier
      return Promise.resolve(planByTier[tier] ?? null)
    })

  describe("chargePlan（升级补差额）", () => {
    it("LV2→LV3 升级：差价/积分差按剩余天数折算（委托 upgradePlanImmediate）、到期日不变", async () => {
      mockPlans()
      const expiresAt = new Date(Date.now() + 3 * 86400000) // 还剩 3 天 → 折算系数 3/30
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: 2,
        subscriptionExpiresAt: expiresAt,
      })

      await service.chargePlan(12, 3)

      const call = credit.upgradePlanImmediate.mock.calls[0] as unknown as [
        number,
        {
          fromTier: number
          toTier: number
          planName: string
          packageDiff: number
          giftDiff: number
          expiresAt: Date
        },
        { meta?: { priceCny?: number } },
      ]
      expect(call[0]).toBe(12)
      // 积分差按剩余 3 天折算：套餐本体 (7000-4000)×3/30=300、赠送 (2000-600)×3/30=140
      expect(call[1]).toEqual({
        fromTier: 2,
        toTier: 3,
        planName: "Ultra",
        packageDiff: 300,
        giftDiff: 140,
        expiresAt, // 到期日不变（跟随原订阅）
      })
      // 折算费用差 = (699-399)×3/30 = 30（后台通道不收款，仅留痕）
      expect(call[2].meta?.priceCny).toBe(30)
    })

    it("无有效套餐（已过期/未订阅）→ 报错引导续费", async () => {
      mockPlans()
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: null,
        subscriptionExpiresAt: null,
      })
      await expect(service.chargePlan(12, 3)).rejects.toThrow("续费")
    })

    it("周期内不可降级/平级", async () => {
      mockPlans()
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: 3,
        subscriptionExpiresAt: new Date(Date.now() + 86400000),
      })
      await expect(service.chargePlan(12, 2)).rejects.toThrow("升级")
    })

    it("邀请人也可升级（LV5 限制已取消，任何人可订阅）", async () => {
      mockPlans()
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: true,
        invitedById: null,
        subscriptionTier: 2,
        subscriptionExpiresAt: new Date(Date.now() + 10 * 86400000),
      })
      await service.chargePlan(12, 3)
      expect(credit.upgradePlanImmediate).toHaveBeenCalled()
    })
  })

  describe("quotePlanUpgrade（升级补差试算，只读）", () => {
    it("LV2→LV3：与 chargePlan 同一算价点（按剩余天数折算），不落库", async () => {
      mockPlans()
      const expiresAt = new Date(Date.now() + 3 * 86400000) // 剩 3 天 → 系数 0.1
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: 2,
        subscriptionExpiresAt: expiresAt,
      })

      const q = await service.quotePlanUpgrade(12, 3)

      expect(q.fromTier).toBe(2)
      expect(q.toTier).toBe(3)
      expect(q.costCny).toBe(30) // (699-399)×3/30
      expect(q.packageDiff).toBe(300) // (7000-4000)×3/30
      expect(q.giftDiff).toBe(140) // (2000-600)×3/30
      expect(q.creditsDiff).toBe(440)
      expect(q.remainingDays).toBe(3)
      expect(q.expiresAt).toEqual(expiresAt) // 到期日不变
      // 只读：不发积分、不切档
      expect(credit.upgradePlanImmediate).not.toHaveBeenCalled()
      expect(credit.renewImmediateInTx).not.toHaveBeenCalled()
    })

    it("与 chargePlan 数值一致（同一算价点）", async () => {
      mockPlans()
      const expiresAt = new Date(Date.now() + 10 * 86400000)
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: 2,
        subscriptionExpiresAt: expiresAt,
      })

      const q = await service.quotePlanUpgrade(12, 3)
      await service.chargePlan(12, 3)
      const call = credit.upgradePlanImmediate.mock.calls[0] as unknown as [
        number,
        { packageDiff: number; giftDiff: number; expiresAt: Date },
        { meta?: { priceCny?: number } },
      ]
      expect(call[1].packageDiff).toBe(q.packageDiff)
      expect(call[1].giftDiff).toBe(q.giftDiff)
      expect(call[2].meta?.priceCny).toBe(q.costCny)
    })

    it("无有效套餐 / 降级平级 / 套餐下架 → 400", async () => {
      mockPlans()
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: null,
        subscriptionExpiresAt: null,
      })
      await expect(service.quotePlanUpgrade(12, 3)).rejects.toThrow("续费")

      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: 3,
        subscriptionExpiresAt: new Date(Date.now() + 86400000),
      })
      await expect(service.quotePlanUpgrade(12, 2)).rejects.toThrow("更高档")

      prisma.membershipPlan.findUnique.mockResolvedValue(null)
      await expect(service.quotePlanUpgrade(12, 3)).rejects.toThrow("套餐不存在或已下架")
    })
  })

  describe("renewPlan（续费，立即生效）", () => {
    const plan = {
      tier: 2,
      name: "Plus",
      active: true,
      packageCredits: 4000,
      giftCredits: 600,
      periodDays: 30,
      priceCny: new Decimal(399),
    }

    it("校验通过后在事务内委托 credit.renewImmediateInTx（带套餐快照），返回 wallet + 遗留队列", async () => {
      prisma.membershipPlan.findUnique.mockResolvedValue(plan)
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: 3,
        subscriptionExpiresAt: new Date("2026-06-30T00:00:00.000Z"),
      })
      credit.listScheduledPlans.mockResolvedValue([{ id: 9, tier: 2 }])

      const res = await service.renewPlan(12, 2)

      const call = credit.renewImmediateInTx.mock.calls[0] as unknown as [
        unknown,
        number,
        Record<string, unknown>,
      ]
      expect(call[1]).toBe(12)
      expect(call[2]).toMatchObject({
        tier: 2,
        planName: "Plus",
        packageCredits: 4000,
        giftCredits: 600,
        periodDays: 30,
      })
      expect(res.scheduledPlans).toEqual([{ id: 9, tier: 2 }])
      expect(res.wallet).toBeDefined()
    })

    it("已过期的 LV3 续 LV2：允许（已过期视为新起一期，不受禁降档约束）", async () => {
      prisma.membershipPlan.findUnique.mockResolvedValue(plan)
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: 3,
        subscriptionExpiresAt: new Date("2026-06-30T00:00:00.000Z"),
      })
      await expect(service.renewPlan(12, 2)).resolves.toBeDefined()
      expect(credit.renewImmediateInTx).toHaveBeenCalled()
    })

    it("在期高等级续费低等级 → 400（内核守卫，原样透传）", async () => {
      prisma.membershipPlan.findUnique.mockResolvedValue(plan)
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: 3,
        subscriptionExpiresAt: new Date(Date.now() + 10 * 86400000),
      })
      credit.renewImmediateInTx.mockRejectedValue(
        new BadRequestException("高等级套餐不能续费低等级套餐")
      )
      await expect(service.renewPlan(12, 2)).rejects.toThrow("高等级套餐不能续费低等级套餐")
    })

    it("邀请人也可续费（LV5 限制已取消）", async () => {
      prisma.membershipPlan.findUnique.mockResolvedValue(plan)
      prisma.user.findUnique.mockResolvedValue({ id: 12, isActive: true })
      await service.renewPlan(12, 2)
      expect(credit.renewImmediateInTx).toHaveBeenCalled()
    })
  })

  describe("chargePack", () => {
    it("合并 1 笔 recordRecharge：本金→RECHARGE(永不过期)、赠送→GIFT(30d)，meta 带 priceCny+本金+赠送", async () => {
      prisma.rechargePack.findUnique.mockResolvedValue({
        id: 2,
        active: true,
        baseCredits: 1000,
        bonusCredits: 100,
        priceCny: new Decimal(100),
      })
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: null,
        subscriptionExpiresAt: null,
      })

      await service.chargePack(12, 2)

      const [uid, opts] = recordRechargeCalls()[0]
      expect(uid).toBe(12)
      expect(opts.type).toBe(CreditTxnType.RECHARGE_PACK)
      expect(opts.meta).toEqual(
        expect.objectContaining({ packId: 2, priceCny: 100, baseCredits: 1000, bonusCredits: 100 })
      )
      const recharge = opts.lots.find(l => l.bucket === CreditBucket.RECHARGE)
      const gift = opts.lots.find(l => l.bucket === CreditBucket.GIFT)
      expect(new Decimal(recharge!.amount).toString()).toBe("1000")
      expect(recharge!.expiresAt).toBeNull() // 本金永不过期
      expect(new Decimal(gift!.amount).toString()).toBe("100")
      expect(gift!.expiresAt).toBeInstanceOf(Date) // 赠送 30 天过期
    })
  })

  describe("chargeCustom", () => {
    it("充 200 元 → 本金 2000 进 RECHARGE、赠送 10%(200) 进 GIFT，合并 1 笔，meta 带明细", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: null,
        subscriptionExpiresAt: null,
      })

      await service.chargeCustom(12, 200)

      const [uid, opts] = recordRechargeCalls()[0]
      expect(uid).toBe(12)
      expect(opts.type).toBe(CreditTxnType.RECHARGE_CUSTOM)
      expect(opts.meta).toEqual(
        expect.objectContaining({ priceCny: 200, baseCredits: 2000, bonusCredits: 200 })
      )
      const recharge = opts.lots.find(l => l.bucket === CreditBucket.RECHARGE)
      const gift = opts.lots.find(l => l.bucket === CreditBucket.GIFT)
      expect(new Decimal(recharge!.amount).toString()).toBe("2000")
      expect(new Decimal(gift!.amount).toString()).toBe("200")
    })

    it("充 50 元 → 赠送 0%（bonusCredits=0，recordRecharge 内部跳过 0 批次）", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 12,
        isActive: true,
        canInvite: false,
        invitedById: null,
        subscriptionTier: null,
        subscriptionExpiresAt: null,
      })

      await service.chargeCustom(12, 50)

      const [, opts] = recordRechargeCalls()[0]
      expect(opts.meta).toEqual(
        expect.objectContaining({ priceCny: 50, baseCredits: 500, bonusCredits: 0 })
      )
      const recharge = opts.lots.find(l => l.bucket === CreditBucket.RECHARGE)
      expect(new Decimal(recharge!.amount).toString()).toBe("500")
    })
  })

  describe("manualAdjust", () => {
    it("调用 credit.adjust（任意等级）", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 12, isActive: true })
      await service.manualAdjust(12, -300, "扣减测试")
      expect(credit.adjust).toHaveBeenCalledWith(
        12,
        -300,
        expect.objectContaining({ source: "admin.recharge.manual" })
      )
    })

    it("禁用（停用）用户充值抛错", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 12, isActive: false })
      await expect(service.manualAdjust(12, 100, "x")).rejects.toThrow("已被禁用")
      expect(credit.adjust).not.toHaveBeenCalled()
    })
  })

  describe("setRechargeFlag", () => {
    it("更新 canRecharge 并失效缓存", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 12 })
      const res = await service.setRechargeFlag(12, true)
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 12 },
        data: { canRecharge: true },
      })
      expect(access.invalidate).toHaveBeenCalledWith(12)
      expect(res).toEqual({ userId: 12, canRecharge: true })
    })
  })

  describe("listUsers", () => {
    it("默认剩余积分倒序 + 返利单独汇总 + 分页", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 1,
          username: "alice",
          phone: "18000000001",
          canInvite: false,
          invitedById: null,
          subscriptionTier: 2,
          subscriptionExpiresAt: null,
          discount: new Decimal(1),
          rebateRate: new Decimal("0.3"),
          canRecharge: false,
          invitedBy: null,
          roles: [],
          orgs: [],
          _count: { invitees: 0 },
        },
        {
          id: 2,
          username: "bob",
          phone: "18000000002",
          canInvite: true,
          invitedById: null,
          subscriptionTier: null,
          subscriptionExpiresAt: null,
          discount: new Decimal(1),
          rebateRate: new Decimal("0.3"),
          canRecharge: false,
          invitedBy: null,
          roles: [],
          orgs: [],
          _count: { invitees: 3 },
        },
      ])
      prisma.creditLot.groupBy.mockResolvedValue([
        { userId: 1, bucket: CreditBucket.RECHARGE, _sum: { remaining: new Decimal(100) } },
        { userId: 1, bucket: CreditBucket.PACKAGE, _sum: { remaining: new Decimal(30) } },
        { userId: 1, bucket: CreditBucket.GIFT, _sum: { remaining: new Decimal(20) } },
        { userId: 2, bucket: CreditBucket.RECHARGE, _sum: { remaining: new Decimal(500) } },
        { userId: 2, bucket: CreditBucket.REBATE, _sum: { remaining: new Decimal(40) } },
      ])

      prisma.creditTransaction.groupBy.mockResolvedValue([
        { userId: 2, _sum: { amount: new Decimal(120) } },
      ])

      const res = await service.listUsers({ page: 1, pageSize: 10 })

      expect(res.total).toBe(2)
      expect(res.items[0].userId).toBe(2) // 剩余 500 排在前
      expect(res.items[0].phone).toBe("180****0002") // 手机号默认脱敏（2026-08-30 起，全号走 /users/:id/phone 审计接口）
      expect(res.items[0].level).toBe("NONE") // canInvite 不再是等级（LV5 已取消），无订阅=NONE
      expect(res.items[0].rebate).toBe("40") // 可提现返利余额
      expect(res.items[0].rebateEarned).toBe("120") // 累计返利
      expect(res.items[0].invitedCount).toBe(3)
      expect(res.items[0].hasDownline).toBe(true)
      expect(res.items[0].orgs).toEqual([])
      expect(res.items[0].roles).toEqual([])
      expect(res.items[0].rechargePoints).toBe("500") // 充值积分
      expect(res.items[0].packagePoints).toBe("0") // 无套餐
      expect(res.items[0].giftPoints).toBe("0") // 无赠送
      expect(res.items[1].userId).toBe(1)
      expect(res.items[1].level).toBe("LV2")
      expect(res.items[1].points).toBe("150") // 100 充值 + 30 套餐 + 20 注册赠送
      expect(res.items[1].rechargePoints).toBe("100") // 充值积分（RECHARGE）
      expect(res.items[1].packagePoints).toBe("30") // 套餐积分（PACKAGE）
      expect(res.items[1].giftPoints).toBe("20") // 赠送积分（GIFT）
      expect(res.items[1].rebateEarned).toBe("0")
      expect(res.items[1].hasDownline).toBe(false)
    })

    it("排除禁用（停用）用户：where 带 isActive=true", async () => {
      prisma.user.findMany.mockResolvedValue([])
      await service.listUsers({ page: 1, pageSize: 10 })
      const whereArg = (
        prisma.user.findMany.mock.calls as unknown as Array<[{ where: { isActive?: boolean } }]>
      )[0][0].where
      expect(whereArg.isActive).toBe(true)
    })

    it("inviteStatus=inviter：canInvite=true 或返利余额>0（已关邀请仍留列表，2026-08-31 口径）", async () => {
      prisma.user.findMany.mockResolvedValue([])
      await service.listUsers({ page: 1, pageSize: 10, inviteStatus: "inviter" })
      const whereArg = (
        prisma.user.findMany.mock.calls as unknown as Array<
          [{ where: { canInvite?: boolean; AND?: unknown[] } }]
        >
      )[0][0].where
      expect(whereArg.canInvite).toBeUndefined() // 不再是简单等值过滤
      const anyDate = expect.any(Date) as Date // 非对称匹配器，展开为 Date 避免 unsafe-assignment
      expect(whereArg.AND).toEqual([
        {
          OR: [
            { canInvite: true },
            {
              creditLots: {
                some: {
                  bucket: CreditBucket.REBATE,
                  status: "ACTIVE",
                  remaining: { gt: 0 },
                  OR: [{ expiresAt: null }, { expiresAt: { gt: anyDate } }],
                },
              },
            },
          ],
        },
      ])
    })

    it("按等级筛选（level=INVITER 只留邀请人）", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 2,
          username: "bob",
          phone: "18000000002",
          canInvite: true,
          invitedById: null,
          subscriptionTier: null,
          subscriptionExpiresAt: null,
          discount: new Decimal(1),
          rebateRate: new Decimal("0.3"),
          canRecharge: false,
          invitedBy: null,
          roles: [],
          orgs: [],
          _count: { invitees: 0 },
        },
      ])
      const res = await service.listUsers({ page: 1, pageSize: 10, level: "LV2" })
      expect(res.total).toBe(0)
    })

    it("回显本人开关 shareCredits 与邀请人共享开关 inviterShareCredits（被邀请人行）", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 5,
          username: "founder",
          phone: "18000000005",
          canInvite: false,
          invitedById: 2,
          subscriptionTier: null,
          subscriptionExpiresAt: null,
          discount: new Decimal(1),
          rebateRate: new Decimal("0.3"),
          canRecharge: false,
          shareCreditsWithInvitees: false, // 被邀请人自己不共享
          subInviteAllowed: true, // 下级可继续邀请（邀请配置弹窗回显）
          invitedBy: { id: 2, username: "bob", shareCreditsWithInvitees: true }, // 其邀请人已开启共享
          roles: [],
          orgs: [],
          _count: { invitees: 0 },
        },
      ])
      prisma.creditLot.groupBy.mockResolvedValue([])
      prisma.creditTransaction.groupBy.mockResolvedValue([])

      const res = await service.listUsers({ page: 1, pageSize: 10 })

      expect(res.items[0].shareCredits).toBe(false) // 本人不共享
      expect(res.items[0].subInviteAllowed).toBe(true) // 下级可继续邀请回显
      expect(res.items[0].inviterShareCredits).toBe(true) // 邀请人已对我开启共享
    })

    it("无邀请人的用户 inviterShareCredits 为 null", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 1,
          username: "alice",
          phone: "18000000001",
          canInvite: false,
          invitedById: null,
          subscriptionTier: null,
          subscriptionExpiresAt: null,
          discount: new Decimal(1),
          rebateRate: new Decimal("0.3"),
          canRecharge: false,
          shareCreditsWithInvitees: false,
          invitedBy: null,
          roles: [],
          orgs: [],
          _count: { invitees: 0 },
        },
      ])
      prisma.creditLot.groupBy.mockResolvedValue([])
      prisma.creditTransaction.groupBy.mockResolvedValue([])

      const res = await service.listUsers({ page: 1, pageSize: 10 })
      expect(res.items[0].inviterShareCredits).toBeNull()
    })
  })

  describe("listRechargeTransactions", () => {
    it("默认含充值类型、附 title/amountCny、带用户信息", async () => {
      prisma.creditTransaction.findMany.mockResolvedValue([
        {
          id: 9,
          direction: "CREDIT",
          bucket: "PACKAGE",
          type: CreditTxnType.RECHARGE_PLAN,
          amount: new Decimal(4600),
          balanceAfter: new Decimal(4600),
          source: "admin.recharge.plan",
          meta: { tier: 2, priceCny: 399 },
          createdAt: new Date("2026-06-10T00:00:00.000Z"),
          user: { id: 12, username: "alice", phone: "18000000001" },
        },
      ])
      prisma.creditTransaction.count.mockResolvedValue(1)

      const res = await service.listRechargeTransactions({ page: 1, pageSize: 10 })

      expect(res.total).toBe(1)
      expect(res.items[0].category).toBe("套餐订阅")
      expect(res.items[0].title).toBe("Lv.2 月度套餐")
      expect(res.items[0].amountCny).toBe(399)
      expect(res.items[0].amount).toBe("4600")
      expect(res.items[0].status).toBe("COMPLETED")
      expect(res.items[0].scheduled).toBe(false) // 普通(非排队)记录
      expect(res.items[0].effectiveAt).toBeNull()
      expect(res.items[0].user).toEqual({ id: 12, username: "alice", phone: "18000000001" })

      const whereArg = (
        prisma.creditTransaction.findMany.mock.calls as unknown as Array<
          [{ where: { type: unknown } }]
        >
      )[0][0].where
      expect(whereArg.type).toEqual({
        in: ["RECHARGE_PLAN", "RECHARGE_PACK", "RECHARGE_CUSTOM", "MANUAL_ADJUST", "SIGNUP_BONUS"],
      })
    })

    it("按类型筛选：type=SIGNUP_BONUS 直接透传为单值条件", async () => {
      prisma.creditTransaction.findMany.mockResolvedValue([])
      prisma.creditTransaction.count.mockResolvedValue(0)

      await service.listRechargeTransactions({ page: 1, pageSize: 10, type: "SIGNUP_BONUS" })

      const whereArg = (
        prisma.creditTransaction.findMany.mock.calls as unknown as Array<
          [{ where: { type: unknown } }]
        >
      )[0][0].where
      expect(whereArg.type).toBe("SIGNUP_BONUS")
    })

    it("按类型筛选：MANUAL_ADJUST 排除正向补偿发放；GIFT_COMPENSATE 仅正向补偿（与列表类型列同口径）", async () => {
      prisma.creditTransaction.findMany.mockResolvedValue([])
      prisma.creditTransaction.count.mockResolvedValue(0)

      await service.listRechargeTransactions({ page: 1, pageSize: 10, type: "MANUAL_ADJUST" })
      let whereArg = (
        prisma.creditTransaction.findMany.mock.calls as unknown as Array<
          [{ where: Record<string, unknown> }]
        >
      )[0][0].where
      expect(whereArg).toMatchObject({
        type: "MANUAL_ADJUST",
        NOT: { direction: "CREDIT", meta: { path: "$.compensation", equals: true } },
      })

      await service.listRechargeTransactions({
        page: 1,
        pageSize: 10,
        type: "GIFT_COMPENSATE" as never,
      })
      whereArg = (
        prisma.creditTransaction.findMany.mock.calls as unknown as Array<
          [{ where: Record<string, unknown> }]
        >
      )[1][0].where
      expect(whereArg).toMatchObject({
        type: "MANUAL_ADJUST",
        direction: "CREDIT",
        meta: { path: "$.compensation", equals: true },
      })
    })

    it("续费排队下单的记录：关联套餐仍 PENDING → scheduled=true + effectiveAt（生效时间）", async () => {
      prisma.creditTransaction.findMany.mockResolvedValue([
        {
          id: 10,
          direction: "CREDIT",
          bucket: "PACKAGE",
          type: CreditTxnType.RECHARGE_PLAN,
          amount: new Decimal(4600),
          balanceAfter: null,
          source: "admin.recharge.plan",
          meta: {
            tier: 2,
            priceCny: 399,
            scheduled: true,
            activateAt: "2026-06-30T00:00:00.000Z",
            scheduledPlanId: 77,
          },
          createdAt: new Date("2026-06-23T00:00:00.000Z"),
          user: { id: 12, username: "alice", phone: "18000000001" },
        },
      ])
      prisma.creditTransaction.count.mockResolvedValue(1)
      prisma.scheduledPlan.findMany.mockResolvedValue([{ id: 77, status: "PENDING" }])

      const res = await service.listRechargeTransactions({ page: 1, pageSize: 10 })

      expect(res.items[0].scheduled).toBe(true)
      expect(res.items[0].effectiveAt).toBe("2026-06-30T00:00:00.000Z")
      expect(res.items[0].balanceAfter).toBeNull() // 未到账
    })

    it("续费已激活：关联套餐 ACTIVATED → scheduled=false + effectiveAt=null（不再显示待生效）", async () => {
      prisma.creditTransaction.findMany.mockResolvedValue([
        {
          id: 190,
          direction: "CREDIT",
          bucket: "PACKAGE",
          type: CreditTxnType.RECHARGE_PLAN,
          amount: new Decimal(4600),
          balanceAfter: null,
          source: "admin.recharge.plan",
          meta: {
            tier: 2,
            priceCny: 399,
            scheduled: true,
            activateAt: "2026-06-24T02:24:52.782Z",
            scheduledPlanId: 88,
          },
          createdAt: new Date("2026-06-24T02:24:52.806Z"),
          user: { id: 6, username: "test", phone: "15108328487" },
        },
      ])
      prisma.creditTransaction.count.mockResolvedValue(1)
      prisma.scheduledPlan.findMany.mockResolvedValue([{ id: 88, status: "ACTIVATED" }])

      const res = await service.listRechargeTransactions({ page: 1, pageSize: 10, userId: 6 })

      expect(res.items[0].scheduled).toBe(false) // 已生效，不再标待生效
      expect(res.items[0].expired).toBe(false) // 无 meta.expiresAt（或未过）→ 不标已过期
      expect(res.items[0].effectiveAt).toBeNull()
      expect(credit.activateDuePlans).toHaveBeenCalledWith(6) // 指定用户时读时兜底激活
    })

    it("已过期：meta.expiresAt 已过 → expired=true，title 末尾带【套餐升级】", async () => {
      prisma.creditTransaction.findMany.mockResolvedValue([
        {
          id: 200,
          direction: "CREDIT",
          bucket: "PACKAGE",
          type: CreditTxnType.RECHARGE_PLAN,
          amount: new Decimal(9000),
          balanceAfter: new Decimal(0),
          source: "admin.recharge.plan",
          meta: {
            tier: 3,
            name: "Ultra",
            upgrade: true,
            priceCny: 30,
            expiresAt: "2020-01-01T00:00:00.000Z", // 早已过期
          },
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          user: { id: 6, username: "test", phone: "15108328487" },
        },
      ])
      prisma.creditTransaction.count.mockResolvedValue(1)
      prisma.scheduledPlan.findMany.mockResolvedValue([])

      const res = await service.listRechargeTransactions({ page: 1, pageSize: 10 })

      expect(res.items[0].expired).toBe(true)
      expect(res.items[0].scheduled).toBe(false)
      expect(res.items[0].title).toBe("Lv.3 Ultra 月度套餐【套餐升级】")
    })
  })

  describe("listUserWithdrawals", () => {
    it("返回指定用户的提现明细（分页）", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 12 })
      prisma.creditTransaction.findMany.mockResolvedValue([
        {
          id: 5,
          amount: new Decimal(500),
          balanceAfter: new Decimal(0),
          meta: { note: "[后台代发] 已打款" },
          createdAt: new Date("2026-06-15T00:00:00.000Z"),
        },
      ])
      prisma.creditTransaction.count.mockResolvedValue(1)

      const res = await service.listUserWithdrawals(12, { page: 1, pageSize: 10 })

      expect(res.total).toBe(1)
      expect(res.items[0]).toMatchObject({ id: 5, amount: "500", balanceAfter: "0" })
      const whereArg = (
        prisma.creditTransaction.findMany.mock.calls as unknown as Array<
          [{ where: { userId: number; type: string } }]
        >
      )[0][0].where
      expect(whereArg).toEqual({ userId: 12, type: "REBATE_WITHDRAW" })
    })
  })

  describe("rebateWithdraw", () => {
    it("用户不存在 → 404", async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      await expect(service.rebateWithdraw(12, 500)).rejects.toThrow("用户不存在")
      expect(credit.withdrawRebate).not.toHaveBeenCalled()
    })

    it("代发：调 withdrawRebate 并标注后台代发", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 12 })
      const res = await service.rebateWithdraw(12, 500, "已打款")
      expect(credit.withdrawRebate).toHaveBeenCalledWith(12, 500, {
        note: "[后台代发] 已打款",
      })
      expect(res).toEqual({ userId: 12, withdrawn: "500", balanceAfter: "0" })
    })

    it("已关闭邀请权限的用户：历史返利不锁定，仍可代发提现", async () => {
      // 关闭 canInvite 只停新增计佣；REBATE 桶不可消费、提现是唯一出口（与用户侧 withdraw 同口径）
      prisma.user.findUnique.mockResolvedValue({ id: 12 })
      const res = await service.rebateWithdraw(12, 500)
      expect(credit.withdrawRebate).toHaveBeenCalledWith(12, 500, { note: "[后台代发]" })
      expect(res.userId).toBe(12)
    })
  })
})
