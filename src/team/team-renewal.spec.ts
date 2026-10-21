import { Test } from "@nestjs/testing"
import { CreditTxnType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { DefaultMemberRoleService } from "../common/services/default-member-role.service"
import { CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"
import { TeamPoolService } from "./team-pool.service"
import { SYSTEM_ACTOR_ID } from "./team.constants"
import { TeamService } from "./team.service"

/** jest.Mock 的 calls 为 any；提取第 n 次调用实参并显式收窄类型后断言 */
const callArgs = <T extends unknown[]>(mock: jest.Mock, call: number): T => {
  const calls = mock.mock.calls as unknown[][]
  return calls[call] as T
}

/**
 * M2b 订单结算接线：createSelfServeTeam（自助建队）/ scheduleTeamRenewalInTx（续费排队）/
 * activateDueTeamPlans（到期激活发放）/ activateAllDueTeamPlans（扫描）。
 * 真实 TeamService + mock 协作者（$transaction 直接回调 prisma 作 tx）。
 */
describe("TeamService 订单结算接线", () => {
  const NOW = new Date("2026-08-20T00:00:00.000Z")
  const DAY = 24 * 60 * 60 * 1000

  let service: TeamService
  let prisma: {
    team: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock }
    teamMember: {
      findFirst: jest.Mock
      upsert: jest.Mock
      update: jest.Mock
    }
    teamAuditLog: { create: jest.Mock }
    creditLot: { updateMany: jest.Mock }
    scheduledPlan: {
      findFirst: jest.Mock
      findMany: jest.Mock
      create: jest.Mock
      updateMany: jest.Mock
    }
    user: { findUnique: jest.Mock; update: jest.Mock }
    $transaction: jest.Mock
  }
  let credit: { clearGrantedCredits: jest.Mock; cancelPendingScheduledPlans: jest.Mock }
  let pool: { grantPool: jest.Mock }

  beforeEach(async () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW.getTime())
    prisma = {
      team: {
        create: jest
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 10, ...args.data })
          ),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      teamMember: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      teamAuditLog: { create: jest.fn().mockResolvedValue({}) },
      creditLot: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      scheduledPlan: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 21, ...args.data })
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ username: "xiaoxiao" }),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(),
    }
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma))
    credit = {
      clearGrantedCredits: jest.fn().mockResolvedValue(0),
      cancelPendingScheduledPlans: jest.fn().mockResolvedValue(0),
    }
    pool = { grantPool: jest.fn().mockResolvedValue(undefined) }

    const moduleRef = await Test.createTestingModule({
      providers: [
        TeamService,
        { provide: DefaultMemberRoleService, useValue: { assign: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: credit },
        { provide: TeamPoolService, useValue: pool },
      ],
    }).compile()
    service = moduleRef.get(TeamService)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe("createSelfServeTeam", () => {
    it("购买人已归属占用中企业 → 拦截", async () => {
      prisma.teamMember.findFirst.mockResolvedValue({ teamId: 5 })
      await expect(
        service.createSelfServeTeam(
          { adminUserId: 7, tier: 1, seats: 5, periodDays: 30 },
          prisma as never
        )
      ).rejects.toThrow("已归属")
      expect(prisma.team.create).not.toHaveBeenCalled()
    })

    it("成功：SELF/ACTIVE/折扣 1/有效期快照 + 管理员入队（终止个人套餐）+ 审计 + 固化企业邀请人", async () => {
      prisma.user.findUnique.mockResolvedValue({ username: "xiaoxiao", invitedById: 42 })
      const team = await service.createSelfServeTeam(
        { name: "Acme", adminUserId: 7, tier: 2, seats: 20, periodDays: 30 },
        prisma as never
      )
      expect(team.id).toBe(10)
      const create = callArgs<[{ data: Record<string, unknown> }]>(prisma.team.create, 0)[0]
      expect(create.data).toMatchObject({
        name: "Acme",
        source: "SELF",
        status: "ACTIVE",
        tier: 2,
        seats: 20,
        adminId: 7,
        invitedById: 42, // 企业邀请人快照 = 建队时管理员 invitedById（企业池返利沿此链结算）
      })
      expect((create.data.expiresAt as Date).getTime()).toBe(NOW.getTime() + 30 * DAY)
      // graceUntil = expiresAt+30d；dataKeepUntil = expiresAt+60d
      expect((create.data.graceUntil as Date).getTime()).toBe(NOW.getTime() + 60 * DAY)
      expect((create.data.dataKeepUntil as Date).getTime()).toBe(NOW.getTime() + 90 * DAY)
      // joinTeam 同口径：清个人套餐/赠送 + 取消个人排队单 + 落管理员成员行
      expect(credit.clearGrantedCredits).toHaveBeenCalledWith(7, prisma)
      expect(credit.cancelPendingScheduledPlans).toHaveBeenCalledWith(7, prisma)
      // 加入企业即终止个人套餐身份：档位/冗余等级/有效期全清（企业到期退出后落无等级，不恢复原档）
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { subscriptionTier: null, membershipLevel: "NONE", subscriptionExpiresAt: null },
      })
      const upsert = callArgs<[{ create: Record<string, unknown> }]>(prisma.teamMember.upsert, 0)[0]
      expect(upsert.create).toMatchObject({
        teamId: 10,
        userId: 7,
        role: "ADMIN",
        status: "ACTIVE",
      })
      const audit = callArgs<[{ data: { action: string; actorId: number } }]>(
        prisma.teamAuditLog.create,
        0
      )[0]
      expect(audit.data).toMatchObject({ action: "TEAM_CREATE", actorId: 7, teamId: 10 })
    })

    it("未填企业名 → 默认「{开通人用户名}的团队」且 nameFilled=false", async () => {
      await service.createSelfServeTeam(
        { name: null, adminUserId: 7, tier: 1, seats: 5, periodDays: 30 },
        prisma as never
      )
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 7 },
        select: { username: true, invitedById: true }, // 用户名（默认名）+ 邀请人快照同一次取
      })
      const create = callArgs<[{ data: Record<string, unknown> }]>(prisma.team.create, 0)[0]
      expect(create.data.name).toBe("xiaoxiao的团队")
      expect(create.data.nameFilled).toBe(false)
      expect(create.data.invitedById).toBeNull() // 管理员无邀请人 → 快照为空（结算回落管理员邀请关系）
    })

    it("已填企业名 → 不落默认名，nameFilled=true（仍查用户取邀请人快照）", async () => {
      await service.createSelfServeTeam(
        { name: " Acme ", adminUserId: 7, tier: 1, seats: 5, periodDays: 30 },
        prisma as never
      )
      expect(prisma.user.findUnique).toHaveBeenCalled() // invitedById 固化必须查
      const create = callArgs<[{ data: Record<string, unknown> }]>(prisma.team.create, 0)[0]
      expect(create.data.name).toBe("Acme")
      expect(create.data.nameFilled).toBe(true)
    })
  })

  describe("scheduleTeamRenewalInTx", () => {
    it("队尾 = max(团队到期, 已排队队尾)；落 ScheduledPlan（userId=管理员 + teamId + 快照）", async () => {
      prisma.team.findUnique.mockResolvedValue({
        id: 10,
        adminId: 7,
        expiresAt: new Date(NOW.getTime() + 10 * DAY),
      })
      // 已有一笔排队：activateAt=NOW+10d，period=30 → 队尾 NOW+40d
      prisma.scheduledPlan.findMany.mockResolvedValue([
        { activateAt: new Date(NOW.getTime() + 10 * DAY), periodDays: 30 },
      ])

      await service.scheduleTeamRenewalInTx(
        prisma as never,
        10,
        {
          tier: 1,
          planName: "Standard",
          priceCny: new Decimal("99.00"),
          poolPackageCredits: 10000,
          poolGiftCredits: 1000,
          periodDays: 30,
        },
        NOW
      )

      const create = callArgs<[{ data: Record<string, unknown> }]>(
        prisma.scheduledPlan.create,
        0
      )[0]
      expect(create.data).toMatchObject({
        userId: 7,
        teamId: 10,
        tier: 1,
        packageCredits: 10000,
        giftCredits: 1000,
        periodDays: 30,
      })
      expect((create.data.activateAt as Date).getTime()).toBe(NOW.getTime() + 40 * DAY)
    })

    it("无排队且已过期 → activateAt=now（立即待激活）", async () => {
      prisma.team.findUnique.mockResolvedValue({
        id: 10,
        adminId: 7,
        expiresAt: new Date(NOW.getTime() - DAY),
      })
      await service.scheduleTeamRenewalInTx(
        prisma as never,
        10,
        {
          tier: 1,
          planName: "Standard",
          priceCny: new Decimal("99.00"),
          poolPackageCredits: 10000,
          poolGiftCredits: 1000,
          periodDays: 30,
        },
        NOW
      )
      const create = callArgs<[{ data: { activateAt: Date } }]>(prisma.scheduledPlan.create, 0)[0]
      expect(create.data.activateAt.getTime()).toBe(NOW.getTime())
    })
  })

  describe("renewTeamImmediateInTx（团队续费立即生效，2026-08-25 起废排队制）", () => {
    const snapshot = {
      tier: 2,
      planName: "Flagship",
      poolPackageCredits: 30000,
      poolGiftCredits: 6000,
      periodDays: 30,
    }

    it("在期续费：团队有效期顺延 + 池积分立即入账（到期=新有效期）+ 切档 + 审计", async () => {
      prisma.team.findUnique.mockResolvedValue({
        id: 10,
        adminId: 7,
        status: "ACTIVE",
        tier: 2,
        expiresAt: new Date(NOW.getTime() + 10 * DAY),
      })

      const res = await service.renewTeamImmediateInTx(prisma as never, 10, snapshot, NOW)

      const newExpiry = new Date(NOW.getTime() + 40 * DAY) // 原到期 NOW+10d + 30d
      expect(res.expiresAt).toEqual(newExpiry)
      const grant = callArgs<[number, Record<string, unknown>, unknown]>(pool.grantPool, 0)
      expect(grant[0]).toBe(10)
      expect(grant[1]).toMatchObject({
        ownerUserId: 7,
        packageCredits: 30000,
        giftCredits: 6000,
        packageExpiresAt: newExpiry,
        // 团队续费：流水类型归「套餐订阅」，meta 带 tier/name/expiresAt 供充值记录展示
        type: CreditTxnType.RECHARGE_PLAN,
      })
      expect(grant[1].meta).toMatchObject({ tier: 2, name: "Flagship" })
      const upd = callArgs<[{ data: Record<string, unknown> }]>(prisma.team.update, 0)[0]
      expect(upd.data.tier).toBe(2)
      expect((upd.data.expiresAt as Date).getTime()).toBe(newExpiry.getTime())
      // graceUntil = 新到期+30d；dataKeepUntil = 新到期+60d
      expect((upd.data.graceUntil as Date).getTime()).toBe(newExpiry.getTime() + 30 * DAY)
      expect((upd.data.dataKeepUntil as Date).getTime()).toBe(newExpiry.getTime() + 60 * DAY)
      const audit = callArgs<[{ data: { action: string } }]>(prisma.teamAuditLog.create, 0)[0]
      expect(audit.data.action).toBe("TEAM_RENEW")
    })

    it("存量池套餐批次顺延：未过期的 RECHARGE_PLAN PACKAGE/GIFT 批次统一延长到新有效期", async () => {
      prisma.team.findUnique.mockResolvedValue({
        id: 10,
        adminId: 7,
        status: "ACTIVE",
        tier: 2,
        expiresAt: new Date(NOW.getTime() + 10 * DAY),
      })

      await service.renewTeamImmediateInTx(prisma as never, 10, snapshot, NOW)

      const newExpiry = new Date(NOW.getTime() + 40 * DAY)
      const args = callArgs<[{ where: Record<string, unknown>; data: { expiresAt: Date } }]>(
        prisma.creditLot.updateMany,
        0
      )[0]
      expect(args.data.expiresAt).toEqual(newExpiry)
      expect(args.where).toEqual({
        teamId: 10,
        sourceType: CreditTxnType.RECHARGE_PLAN, // 池充值包本金/赠送（TEAM_PACK/TEAM_CUSTOM）不顺延
        bucket: { in: ["PACKAGE", "GIFT"] },
        status: "ACTIVE",
        remaining: { gt: 0 },
        expiresAt: { gt: NOW, lt: newExpiry },
      })
    })

    it("升档续费：允许立即切高档", async () => {
      prisma.team.findUnique.mockResolvedValue({
        id: 10,
        adminId: 7,
        status: "ACTIVE",
        tier: 1,
        expiresAt: new Date(NOW.getTime() + 10 * DAY),
      })
      await service.renewTeamImmediateInTx(prisma as never, 10, snapshot, NOW)
      const upd = callArgs<[{ data: Record<string, unknown> }]>(prisma.team.update, 0)[0]
      expect(upd.data.tier).toBe(2)
    })

    it("高等级续费低等级 → 400，零写操作", async () => {
      prisma.team.findUnique.mockResolvedValue({
        id: 10,
        adminId: 7,
        status: "ACTIVE",
        tier: 3,
        expiresAt: new Date(NOW.getTime() + 10 * DAY),
      })
      await expect(
        service.renewTeamImmediateInTx(prisma as never, 10, snapshot, NOW)
      ).rejects.toThrow("高等级套餐不能续费低等级套餐")
      expect(pool.grantPool).not.toHaveBeenCalled()
      expect(prisma.team.update).not.toHaveBeenCalled()
    })

    it("GRACE/已到期 → 拦截（走 restoreTeam 恢复链路）", async () => {
      prisma.team.findUnique.mockResolvedValue({
        id: 10,
        adminId: 7,
        status: "GRACE",
        tier: 1,
        expiresAt: new Date(NOW.getTime() - DAY),
      })
      await expect(
        service.renewTeamImmediateInTx(prisma as never, 10, snapshot, NOW)
      ).rejects.toThrow("不在有效期")
      expect(pool.grantPool).not.toHaveBeenCalled()
    })
  })

  describe("activateDueTeamPlans", () => {
    const plan = {
      id: 21,
      teamId: 10,
      tier: 1,
      activateAt: NOW,
      periodDays: 30,
      planName: "Standard",
      packageCredits: 10000,
      giftCredits: 1000,
    }

    it("无到期排队单 → 0，零写操作", async () => {
      prisma.scheduledPlan.findFirst.mockResolvedValue(null)
      const res = await service.activateDueTeamPlans(10, NOW)
      expect(res.activated).toBe(0)
      expect(pool.grantPool).not.toHaveBeenCalled()
      expect(prisma.team.update).not.toHaveBeenCalled()
    })

    it("ACTIVE 且当前周期未结束 → 不激活（队列等待）", async () => {
      prisma.scheduledPlan.findFirst.mockResolvedValue(plan)
      prisma.team.findUnique.mockResolvedValue({
        id: 10,
        adminId: 7,
        status: "ACTIVE",
        expiresAt: new Date(NOW.getTime() + DAY),
        members: [],
      })
      const res = await service.activateDueTeamPlans(10, NOW)
      expect(res.activated).toBe(0)
      expect(prisma.scheduledPlan.updateMany).not.toHaveBeenCalled()
    })

    it("到期激活（GRACE）：发池积分（有效期=新周期末）+ 团队顺延恢复 ACTIVE + 审计", async () => {
      prisma.scheduledPlan.findFirst.mockResolvedValueOnce(plan).mockResolvedValueOnce(null) // 第二轮无单收工
      prisma.team.findUnique.mockResolvedValue({
        id: 10,
        adminId: 7,
        status: "GRACE",
        expiresAt: new Date(NOW.getTime() - DAY),
        members: [{ userId: 7, status: "ACTIVE" }],
      })

      const res = await service.activateDueTeamPlans(10, NOW)

      expect(res.activated).toBe(1)
      const grant = callArgs<
        [
          number,
          {
            packageCredits?: number
            giftCredits?: number
            packageExpiresAt?: Date
            type?: CreditTxnType
          },
          unknown,
        ]
      >(pool.grantPool, 0)
      expect(grant[0]).toBe(10)
      // 遗留排队激活：流水类型归「套餐订阅」
      expect(grant[1]).toMatchObject({
        packageCredits: 10000,
        giftCredits: 1000,
        type: CreditTxnType.RECHARGE_PLAN,
      })
      expect(grant[1].packageExpiresAt?.getTime()).toBe(NOW.getTime() + 30 * DAY)
      const update = callArgs<[{ data: Record<string, unknown> }]>(prisma.team.update, 0)[0]
      expect(update.data).toMatchObject({ status: "ACTIVE", tier: 1, archivedAt: null })
      expect((update.data.expiresAt as Date).getTime()).toBe(NOW.getTime() + 30 * DAY)
      const audit = callArgs<[{ data: { action: string; actorId: number } }]>(
        prisma.teamAuditLog.create,
        0
      )[0]
      expect(audit.data).toMatchObject({ action: "TEAM_RENEW", actorId: SYSTEM_ACTOR_ID })
    })

    it("ARCHIVED 激活：额外接回成员名单（置回 ACTIVE）", async () => {
      prisma.scheduledPlan.findFirst.mockResolvedValueOnce(plan).mockResolvedValueOnce(null)
      prisma.team.findUnique.mockResolvedValue({
        id: 10,
        adminId: 7,
        status: "ARCHIVED",
        expiresAt: new Date(NOW.getTime() - 40 * DAY),
        members: [{ userId: 8, status: "ARCHIVED" }],
      })

      await service.activateDueTeamPlans(10, NOW)

      expect(prisma.teamMember.update).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 10, userId: 8 } },
        data: { status: "ACTIVE" },
      })
    })

    it("DISABLED 不激活；并发抢单（count=0）跳过不重复发放", async () => {
      prisma.scheduledPlan.findFirst.mockResolvedValue(plan)
      prisma.team.findUnique.mockResolvedValue({
        id: 10,
        adminId: 7,
        status: "DISABLED",
        expiresAt: new Date(NOW.getTime() - DAY),
        members: [],
      })
      const res = await service.activateDueTeamPlans(10, NOW)
      expect(res.activated).toBe(0)
      expect(pool.grantPool).not.toHaveBeenCalled()

      // 并发：claim 失败 → skip → 下轮无单收工
      jest.clearAllMocks()
      prisma.scheduledPlan.findFirst.mockResolvedValueOnce(plan).mockResolvedValueOnce(null)
      prisma.team.findUnique.mockResolvedValue({
        id: 10,
        adminId: 7,
        status: "GRACE",
        expiresAt: new Date(NOW.getTime() - DAY),
        members: [],
      })
      prisma.scheduledPlan.updateMany.mockResolvedValue({ count: 0 })
      const res2 = await service.activateDueTeamPlans(10, NOW)
      expect(res2.activated).toBe(0)
      expect(pool.grantPool).not.toHaveBeenCalled()
    })
  })

  describe("activateAllDueTeamPlans", () => {
    it("按 distinct teamId 逐团队激活；teamId=null 行跳过", async () => {
      prisma.scheduledPlan.findMany.mockResolvedValue([{ teamId: 10 }, { teamId: null }])
      prisma.scheduledPlan.findFirst.mockResolvedValue(null) // 各团队内无单（快速路径）
      const res = await service.activateAllDueTeamPlans(NOW)
      expect(res.teams).toBe(1)
      expect(res.activated).toBe(0)
      const findManyWhere = callArgs<[{ where: Record<string, unknown> }]>(
        prisma.scheduledPlan.findMany,
        0
      )[0]
      expect(findManyWhere.where).toMatchObject({ teamId: { not: null }, status: "PENDING" })
    })
  })
})
