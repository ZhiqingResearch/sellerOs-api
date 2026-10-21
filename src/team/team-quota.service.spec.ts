import { BadRequestException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { Decimal } from "@prisma/client/runtime/library"
import { CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"
import { TeamPoolService } from "./team-pool.service"
import { TeamQuotaService } from "./team-quota.service"
import { quotaMonthOf } from "./team.constants"

describe("TeamQuotaService", () => {
  let service: TeamQuotaService
  let prisma: {
    team: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock }
    teamMember: {
      findUnique: jest.Mock
      findMany: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
    }
    teamAuditLog: { create: jest.Mock }
    creditTransaction: { aggregate: jest.Mock }
    $transaction: jest.Mock
  }
  let credit: { consumeTeamCredits: jest.Mock }
  let pool: Record<string, jest.Mock>

  const activeTeam = (over: Record<string, unknown> = {}) => ({
    id: 1,
    status: "ACTIVE",
    quotaMode: "SHARED",
    overLimitPolicy: "WARN",
    ...over,
  })
  const activeMember = (over: Record<string, unknown> = {}) => ({
    teamId: 1,
    userId: 2,
    role: "MEMBER",
    status: "ACTIVE",
    monthlyQuota: 1000,
    quotaUsedThisMonth: new Decimal(100),
    quotaMonth: quotaMonthOf(),
    ...over,
  })
  const consumeOk = () =>
    credit.consumeTeamCredits.mockResolvedValue({
      creditsCharged: new Decimal(50),
      costCny: new Decimal(5),
      breakdown: [],
      balanceAfter: new Decimal(950),
    })

  beforeEach(async () => {
    prisma = {
      team: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
      teamMember: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      teamAuditLog: { create: jest.fn().mockResolvedValue({}) },
      creditTransaction: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }) },
      $transaction: jest.fn(),
    }
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma))
    credit = { consumeTeamCredits: jest.fn() }
    pool = {}

    const moduleRef = await Test.createTestingModule({
      providers: [
        TeamQuotaService,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: credit },
        { provide: TeamPoolService, useValue: pool },
      ],
    }).compile()
    service = moduleRef.get(TeamQuotaService)
  })

  describe("listQuota", () => {
    beforeEach(() => {
      pool.poolBuckets = jest.fn().mockResolvedValue({
        package: new Decimal(0),
        gift: new Decimal(0),
        recharge: new Decimal(0),
        total: new Decimal(0),
      })
      pool.poolGrantedTotal = jest.fn().mockResolvedValue(new Decimal(7000))
    })

    it("在期团队：成员列表按 ACTIVE+DISABLED 口径（不含已移出 ARCHIVED 行）", async () => {
      prisma.team.findUniqueOrThrow.mockResolvedValue({
        quotaMode: "SHARED",
        overLimitPolicy: "WARN",
        adminId: 100,
        expiresAt: new Date("2026-09-27T00:00:00.000Z"),
        status: "ACTIVE",
      })
      prisma.teamMember.findMany.mockResolvedValue([
        activeMember({
          userId: 100,
          role: "ADMIN",
          monthlyQuota: null,
          user: { id: 100, username: "老板", phone: "13800000000" },
        }),
        activeMember({
          userId: 9,
          status: "ARCHIVED",
          user: { id: 9, username: "旧成员", phone: "13800000009" },
        }), // 早前移出
      ])

      const res = await service.listQuota(1)

      expect(res.members).toHaveLength(1)
      expect(res.members[0]).toMatchObject({ userId: 100, isTeamAdmin: true })
    })

    it("归档团队：按归档保留名单返回（历史限额/已用原样保留），懒重置 where 排除归档团队", async () => {
      prisma.team.findUniqueOrThrow.mockResolvedValue({
        quotaMode: "SHARED",
        overLimitPolicy: "WARN",
        adminId: 100,
        expiresAt: new Date("2026-08-28T00:00:00.000Z"),
        status: "ARCHIVED",
      })
      prisma.teamMember.findMany.mockResolvedValue([
        activeMember({
          userId: 100,
          role: "ADMIN",
          status: "ARCHIVED",
          monthlyQuota: null,
          user: { id: 100, username: "老板", phone: "13800000000" },
        }),
        activeMember({
          userId: 2,
          status: "ARCHIVED",
          monthlyQuota: 800,
          quotaUsedThisMonth: new Decimal(120),
          user: { id: 2, username: "成员", phone: "13800000002" },
        }),
      ])

      const res = await service.listQuota(1)

      expect(res.members).toHaveLength(2)
      expect(res.members[1]).toMatchObject({
        userId: 2,
        status: "ARCHIVED",
        monthlyQuota: 800,
      })
      expect(res.members[1].quotaUsedThisMonth.toString()).toBe("120") // 历史用量未被懒重置清掉
      expect(res.members[1].quotaRemaining.toString()).toBe("680")
      // 懒重置带归档团队排除条件（对归档团队为 no-op，历史不被清零）
      const reset = (prisma.teamMember.updateMany.mock.calls as unknown[][])[0][0] as {
        where: { team?: { status?: { not?: string } } }
      }
      expect(reset.where.team).toEqual({ status: { not: "ARCHIVED" } })
    })
  })

  describe("deductWithQuota", () => {
    it("成功扣费：同事务累加本月已用并回写 quotaMonth", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.findUnique.mockResolvedValue(activeMember())
      prisma.teamMember.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...activeMember(), ...data })
      )
      consumeOk()

      const res = await service.deductWithQuota(1, 2, 50, 5, { source: "text.generate" })

      expect(credit.consumeTeamCredits).toHaveBeenCalledWith(
        1,
        2,
        expect.any(Decimal),
        expect.any(Decimal),
        { source: "text.generate" },
        prisma
      )
      // 100 + 50 = 150 累加回写
      expect(prisma.teamMember.update).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 1, userId: 2 } },
        data: { quotaUsedThisMonth: new Decimal(150), quotaMonth: quotaMonthOf() },
      })
      expect(res.quotaUsedThisMonth.toString()).toBe("150")
      expect(res.monthlyQuota).toBe(1000)
      expect(res.quotaRemaining?.toString()).toBe("850")
      expect(res.warnExceeded).toBe(false)
    })

    it("懒重置：quotaMonth 跨月则清零重计后再扣", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.findUnique.mockResolvedValue(activeMember({ quotaMonth: "2026-01" }))
      const updateArgs: unknown[] = []
      prisma.teamMember.update.mockImplementation((args: { data: Record<string, unknown> }) => {
        updateArgs.push(args)
        return Promise.resolve({ ...activeMember(), ...args.data })
      })
      consumeOk()

      const res = await service.deductWithQuota(1, 2, 50, 5)

      // 第一次 update = 懒重置清零；第二次 = 累加 0+50
      expect(updateArgs[0]).toEqual({
        where: { teamId_userId: { teamId: 1, userId: 2 } },
        data: { quotaUsedThisMonth: 0, quotaMonth: quotaMonthOf() },
      })
      expect(updateArgs[1]).toEqual({
        where: { teamId_userId: { teamId: 1, userId: 2 } },
        data: { quotaUsedThisMonth: new Decimal(50), quotaMonth: quotaMonthOf() },
      })
      expect(res.quotaUsedThisMonth.toString()).toBe("50")
    })

    it("BLOCK 策略：超额抛 400 且不扣池", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam({ overLimitPolicy: "BLOCK" }))
      prisma.teamMember.findUnique.mockResolvedValue(
        activeMember({ monthlyQuota: 100, quotaUsedThisMonth: new Decimal(90) })
      )

      await expect(service.deductWithQuota(1, 2, 20, 2)).rejects.toThrow(BadRequestException)
      await expect(service.deductWithQuota(1, 2, 20, 2)).rejects.toThrow("已达本月使用上限")
      expect(credit.consumeTeamCredits).not.toHaveBeenCalled()
    })

    it("WARN 策略：超额放行并标记 warnExceeded", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam({ overLimitPolicy: "WARN" }))
      prisma.teamMember.findUnique.mockResolvedValue(
        activeMember({ monthlyQuota: 100, quotaUsedThisMonth: new Decimal(90) })
      )
      prisma.teamMember.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...activeMember(), ...data })
      )
      consumeOk()

      const res = await service.deductWithQuota(1, 2, 50, 5)
      expect(res.warnExceeded).toBe(true)
      expect(credit.consumeTeamCredits).toHaveBeenCalled()
    })

    it("INDEPENDENT 模式：即使 WARN 策略也硬拦截；未分配额度同样拦截", async () => {
      prisma.team.findUnique.mockResolvedValue(
        activeTeam({ quotaMode: "INDEPENDENT", overLimitPolicy: "WARN" })
      )
      prisma.teamMember.findUnique.mockResolvedValue(
        activeMember({ monthlyQuota: 100, quotaUsedThisMonth: new Decimal(90) })
      )
      await expect(service.deductWithQuota(1, 2, 20, 2)).rejects.toThrow("已达本月使用上限")

      prisma.teamMember.findUnique.mockResolvedValue(activeMember({ monthlyQuota: null }))
      await expect(service.deductWithQuota(1, 2, 20, 2)).rejects.toThrow("未分配额度")
      expect(credit.consumeTeamCredits).not.toHaveBeenCalled()
    })

    it("非 ACTIVE 团队（GRACE 宽限）冻结消费", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam({ status: "GRACE" }))
      await expect(service.deductWithQuota(1, 2, 20, 2)).rejects.toThrow("已冻结")
      expect(credit.consumeTeamCredits).not.toHaveBeenCalled()
    })

    it("SHARED 不限额度（monthlyQuota=null）直接放行", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.findUnique.mockResolvedValue(activeMember({ monthlyQuota: null }))
      prisma.teamMember.update.mockImplementation(({ data }) =>
        Promise.resolve({ ...activeMember({ monthlyQuota: null }), ...data })
      )
      consumeOk()

      const res = await service.deductWithQuota(1, 2, 50, 5)
      expect(res.monthlyQuota).toBeNull()
      expect(res.quotaRemaining).toBeNull()
    })
  })
})
