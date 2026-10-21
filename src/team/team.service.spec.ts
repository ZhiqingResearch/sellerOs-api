import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import { Decimal } from "@prisma/client/runtime/library"
import { DefaultMemberRoleService } from "../common/services/default-member-role.service"
import { CreditService } from "../membership/credit.service"
import { DAY_MS } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { TeamPoolService } from "./team-pool.service"
import {
  TEAM_DATA_KEEP_DAYS,
  TEAM_GRACE_DAYS,
  dataKeepUntilOf,
  graceUntilOf,
} from "./team.constants"
import { TeamService } from "./team.service"

jest.mock("argon2", () => ({ hash: jest.fn().mockResolvedValue("hashed-password") }))

type AuditCreate = {
  data: { teamId: number; actorId: number; action: string; meta: Record<string, unknown> }
}
type MemberUpsert = {
  where: { teamId_userId: { teamId: number; userId: number } }
  create: { teamId: number; userId: number; role: string; status: string; joinedAt: Date }
  update: Record<string, unknown>
}

/** jest.Mock 的 calls 为 any；提取第 n 次调用实参并显式收窄类型后断言 */
const callArgs = <T extends unknown[]>(mock: jest.Mock, call: number): T => {
  const calls = mock.mock.calls as unknown[][]
  return calls[call] as T
}

/** 提取 mock 全部调用的首个实参 */
const firstArgs = <T>(mock: jest.Mock): T[] => {
  const calls = mock.mock.calls as unknown[][]
  return calls.map(c => c[0] as T)
}

describe("TeamService", () => {
  let service: TeamService
  let config: { get: jest.Mock }
  let prisma: {
    user: {
      findFirst: jest.Mock
      findUnique: jest.Mock
      findMany: jest.Mock
      create: jest.Mock
      update: jest.Mock
    }
    team: {
      findUnique: jest.Mock
      findUniqueOrThrow: jest.Mock
      create: jest.Mock
      update: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
      groupBy: jest.Mock
    }
    teamMember: {
      findFirst: jest.Mock
      findUnique: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
      upsert: jest.Mock
      delete: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
      groupBy: jest.Mock
    }
    roleModel: { findUnique: jest.Mock }
    userRole: { upsert: jest.Mock }
    teamAuditLog: { create: jest.Mock }
    creditTransaction: { groupBy: jest.Mock; aggregate: jest.Mock }
    creditLot: { updateMany: jest.Mock }
    rebateRule: { findFirst: jest.Mock }
    $queryRaw: jest.Mock
    $transaction: jest.Mock
  }
  let credit: {
    clearGrantedCredits: jest.Mock
    cancelPendingScheduledPlans: jest.Mock
    consumableBalance: jest.Mock
    transferGiftLotsToTeam: jest.Mock
  }
  let pool: { grantPool: jest.Mock; poolBuckets: jest.Mock; poolGrantedTotal: jest.Mock }

  const expiresAt = new Date("2027-01-01T00:00:00.000Z")
  const activeTeam = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: "星辰科技",
    source: "CUSTOM",
    status: "ACTIVE",
    seats: 3,
    adminId: 100,
    discount: new Decimal(1),
    expiresAt,
    graceUntil: graceUntilOf(expiresAt),
    dataKeepUntil: dataKeepUntilOf(expiresAt),
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  })
  const detailTeam = () => ({
    ...activeTeam(),
    admin: { id: 100, username: "老板", phone: "13800000000" },
    members: [],
  })
  const memberRow = (over: Record<string, unknown> = {}) => ({
    teamId: 1,
    userId: 2,
    role: "MEMBER",
    status: "ACTIVE",
    ...over,
  })
  const lastAudit = (): AuditCreate => callArgs<[AuditCreate]>(prisma.teamAuditLog.create, 0)[0]

  beforeEach(async () => {
    config = { get: jest.fn().mockReturnValue("11") }
    prisma = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      team: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      teamMember: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
        upsert: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      roleModel: { findUnique: jest.fn().mockResolvedValue({ id: 11 }) },
      userRole: { upsert: jest.fn().mockResolvedValue({}) },
      teamAuditLog: { create: jest.fn().mockResolvedValue({}) },
      creditTransaction: {
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
      },
      creditLot: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      rebateRule: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 2 }]),
      $transaction: jest.fn(),
    }
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma))
    credit = {
      clearGrantedCredits: jest.fn().mockResolvedValue(0),
      cancelPendingScheduledPlans: jest.fn().mockResolvedValue(0),
      // 默认个人套餐积分为 0（可拉入）。
      consumableBalance: jest.fn().mockResolvedValue(new Decimal(0)),
      transferGiftLotsToTeam: jest.fn().mockResolvedValue(new Decimal(0)),
    }
    pool = {
      grantPool: jest.fn().mockResolvedValue(undefined),
      poolBuckets: jest.fn().mockResolvedValue({
        package: new Decimal(5000),
        gift: new Decimal(0),
        recharge: new Decimal(2000),
        total: new Decimal(7000),
      }),
      poolGrantedTotal: jest.fn().mockResolvedValue(new Decimal(7000)),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        TeamService,
        DefaultMemberRoleService,
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: credit },
        { provide: TeamPoolService, useValue: pool },
      ],
    }).compile()
    service = moduleRef.get(TeamService)
  })

  describe("createCustomTeam", () => {
    const dto = {
      name: "星辰科技",
      seats: 3,
      expiresAt: "2027-01-01T00:00:00.000Z",
      adminUserId: 100,
      memberIds: [2, 3],
      poolPackageCredits: 5000,
      poolRechargeCredits: 2000,
      contractAmountCny: 12000,
      contractNote: "合同 HT-2026-001",
    }

    it("成功开通：建队 + 逐成员落行 + 池入账 + 审计，返回详情", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 100 })
      prisma.user.findMany.mockResolvedValue([{ id: 100 }, { id: 2 }, { id: 3 }])
      prisma.teamMember.findMany.mockResolvedValue([])
      prisma.team.create.mockResolvedValue({ id: 1 })
      prisma.team.findUnique.mockResolvedValue(detailTeam())

      const res = await service.createCustomTeam(999, dto)

      const [createArg] = callArgs<[{ data: Record<string, unknown> }]>(prisma.team.create, 0)
      expect(createArg.data).toMatchObject({
        name: "星辰科技",
        nameFilled: true, // 后台显式填了名
        source: "CUSTOM",
        status: "ACTIVE",
        seats: 3,
        adminId: 100,
        discount: new Decimal(1),
        expiresAt: new Date(dto.expiresAt),
        graceUntil: graceUntilOf(new Date(dto.expiresAt)),
        dataKeepUntil: dataKeepUntilOf(new Date(dto.expiresAt)),
      })
      // 管理员 + 2 成员逐一落行；管理员角色 ADMIN，其余 MEMBER
      const upserts = firstArgs<MemberUpsert>(prisma.teamMember.upsert)
      expect(upserts).toHaveLength(3)
      expect(upserts.map(u => [u.create.userId, u.create.role])).toEqual([
        [100, "ADMIN"],
        [2, "MEMBER"],
        [3, "MEMBER"],
      ])
      expect(upserts[0].where).toEqual({ teamId_userId: { teamId: 1, userId: 100 } })
      // 加入即终止个人套餐 + 取消排队单
      expect(credit.clearGrantedCredits).toHaveBeenCalledTimes(3)
      expect(credit.clearGrantedCredits).toHaveBeenCalledWith(2, prisma)
      expect(credit.cancelPendingScheduledPlans).toHaveBeenCalledWith(3, prisma)
      // 池入账带 teamId
      const [grantTeamId, grantOpts, grantTx] = callArgs<
        [
          number,
          { ownerUserId: number; packageCredits: number; rechargeCredits: number; source: string },
          unknown,
        ]
      >(pool.grantPool, 0)
      expect(grantTeamId).toBe(1)
      expect(grantOpts).toMatchObject({
        ownerUserId: 100,
        packageCredits: 5000,
        rechargeCredits: 2000,
        source: "admin.team.custom",
      })
      expect(grantTx).toBe(prisma)
      const auditData = lastAudit().data as unknown as { meta: Record<string, unknown> }
      expect(lastAudit().data).toMatchObject({ teamId: 1, actorId: 999, action: "TEAM_CREATE" })
      expect(auditData.meta).toMatchObject({
        contractAmountCny: 12000,
        contractNote: "合同 HT-2026-001", // 合同备注随创建审计留痕
      })
      expect(res.id).toBe(1)
      expect(res.pool.grantedTotal.toString()).toBe("7000")
    })

    it("未填企业名 → name=null 且 nameFilled=false", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 100 })
      prisma.user.findMany.mockResolvedValue([{ id: 100 }])
      prisma.teamMember.findMany.mockResolvedValue([])
      prisma.team.create.mockResolvedValue({ id: 1 })
      prisma.team.findUnique.mockResolvedValue(detailTeam())

      await service.createCustomTeam(999, { ...dto, name: undefined, memberIds: [] })

      const [createArg] = callArgs<[{ data: Record<string, unknown> }]>(prisma.team.create, 0)
      expect(createArg.data.name).toBeNull()
      expect(createArg.data.nameFilled).toBe(false)
    })

    it("管理员账号不存在 → 400", async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      await expect(service.createCustomTeam(999, dto)).rejects.toThrow("管理员账号不存在")
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it("去重后人数超席位 → 400", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 100 })
      await expect(service.createCustomTeam(999, { ...dto, seats: 2 })).rejects.toThrow(
        "已选人数超过席位数"
      )
      // memberIds 与管理员重复时先去重再比席位（[100,2,3] 去重后 3 人 = 3 席位，放行）
      prisma.user.findMany.mockResolvedValue([{ id: 100 }, { id: 2 }, { id: 3 }])
      prisma.teamMember.findMany.mockResolvedValue([])
      prisma.team.create.mockResolvedValue({ id: 1 })
      prisma.team.findUnique.mockResolvedValue(detailTeam())
      await expect(
        service.createCustomTeam(999, { ...dto, seats: 3, memberIds: [100, 2, 3] })
      ).resolves.toBeDefined()
    })

    it("存在无效成员账号 → 400；已归属其他企业 → 400 并列出来", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 100 })
      prisma.user.findMany.mockResolvedValue([{ id: 100 }, { id: 2 }])
      await expect(service.createCustomTeam(999, dto)).rejects.toThrow("存在无效的成员账号")

      prisma.user.findMany.mockResolvedValue([{ id: 100 }, { id: 2 }, { id: 3 }])
      prisma.teamMember.findMany.mockResolvedValue([{ userId: 2 }])
      await expect(service.createCustomTeam(999, dto)).rejects.toThrow(
        "用户 #2 已归属其他企业，不可选入"
      )
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })
  })

  describe("updateSettings", () => {
    it("显式改名 → name + nameFilled=true 落库并写审计", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.team.findUniqueOrThrow.mockResolvedValue({
        ...activeTeam(),
        admin: { id: 100, username: "老板", phone: "13800000000" },
      })

      await service.updateSettings(1, 100, { name: "新企业名" })

      const [upd] = callArgs<[{ data: Record<string, unknown> }]>(prisma.team.update, 0)
      expect(upd.data).toMatchObject({ name: "新企业名", nameFilled: true })
      expect(lastAudit().data).toMatchObject({ action: "SETTINGS_UPDATE" })
    })

    it("名称清空（空串）→ nameFilled=false（回到未命名口径）", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.team.findUniqueOrThrow.mockResolvedValue({
        ...activeTeam(),
        admin: { id: 100, username: "老板", phone: "13800000000" },
      })

      await service.updateSettings(1, 100, { name: "  " })

      const [upd] = callArgs<[{ data: Record<string, unknown> }]>(prisma.team.update, 0)
      expect(upd.data).toMatchObject({ nameFilled: false })
    })
  })

  describe("overview", () => {
    const overviewMember = (userId: number, status: string) => ({
      teamId: 1,
      userId,
      role: userId === 100 ? "ADMIN" : "MEMBER",
      status,
      monthlyQuota: null,
      quotaUsedThisMonth: new Decimal(0),
      user: { id: userId, username: `u${userId}` },
    })

    it("在期团队：席位/成员按 ACTIVE+DISABLED 统计（不含已移出 ARCHIVED 行）", async () => {
      prisma.team.findUniqueOrThrow.mockResolvedValue({
        ...activeTeam(),
        quotaMode: "SHARED",
        overLimitPolicy: "WARN",
        members: [
          overviewMember(100, "ACTIVE"),
          overviewMember(2, "DISABLED"),
          overviewMember(9, "ARCHIVED"), // 早前移出
        ],
      })
      prisma.creditTransaction.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(4) } })
      prisma.teamMember.count.mockResolvedValue(1) // disabledMemberCount

      const res = await service.overview(1)

      expect(res.seats).toEqual({ used: 2, total: 3 })
      expect(res.memberCount).toBe(2)
      expect(res.reminders.poolLow).toBe(false) // 7000/7000 不低
    })

    it("GRACE 团队：池余额按含冻结批次口径查询（poolBuckets includeFrozen=true）", async () => {
      prisma.team.findUniqueOrThrow.mockResolvedValue({
        ...activeTeam({ status: "GRACE" }),
        quotaMode: "SHARED",
        overLimitPolicy: "WARN",
        members: [overviewMember(100, "ACTIVE")],
      })
      prisma.creditTransaction.aggregate.mockResolvedValue({ _sum: { amount: null } })
      prisma.teamMember.count.mockResolvedValue(0)

      await service.overview(1)

      const bucketCall = (pool.poolBuckets.mock.calls as unknown[][])[0] as [
        number,
        unknown,
        { includeFrozen: boolean } | undefined,
      ]
      expect(bucketCall[0]).toBe(1)
      expect(bucketCall[2]).toEqual({ includeFrozen: true })
    })

    it("归档团队：席位/成员按归档保留名单统计（与成员列表同集合），池不足提醒不下发", async () => {
      prisma.team.findUniqueOrThrow.mockResolvedValue({
        ...activeTeam({ status: "ARCHIVED", archivedAt: new Date("2026-08-29T00:00:00.000Z") }),
        quotaMode: "SHARED",
        overLimitPolicy: "WARN",
        members: [overviewMember(100, "ARCHIVED"), overviewMember(2, "ARCHIVED")],
      })
      // 归档后池已清零：total=0 而 grantedTotal>0 —— 在期口径会触发 poolLow，归档只读不应提醒
      pool.poolBuckets.mockResolvedValue({
        package: new Decimal(0),
        gift: new Decimal(0),
        recharge: new Decimal(0),
        total: new Decimal(0),
      })
      prisma.teamMember.count.mockResolvedValue(0)

      const res = await service.overview(1)

      expect(res.seats).toEqual({ used: 2, total: 3 })
      expect(res.memberCount).toBe(2)
      expect(res.reminders.poolLow).toBe(false)
      expect(res.reminders.cappedMembers).toEqual([])
      expect(res.reminders.nearLimitMembers).toEqual([])
    })
  })

  describe("identity", () => {
    const ctxOf = (teamOver: Record<string, unknown> = {}) =>
      ({
        team: activeTeam(teamOver),
        member: { role: "ADMIN", status: "ACTIVE", joinedAt: new Date() },
      }) as never
    const countWhere = () =>
      (prisma.teamMember.count.mock.calls as unknown[][])[0][0] as {
        where: { status: unknown }
      }

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ id: 100, username: "老板", phone: "13800000000" })
    })

    it("在期团队：席位按 ACTIVE+DISABLED 占座口径（不含 ARCHIVED 行）", async () => {
      prisma.teamMember.count.mockResolvedValue(5)
      const res = await service.identity(ctxOf())
      expect(countWhere().where.status).toEqual({ not: "ARCHIVED" })
      expect(res.team.seatsUsed).toBe(5)
    })

    it("归档团队：席位按归档保留名单统计（与总览/钱包 archivedMemberCount 同口径）", async () => {
      prisma.teamMember.count.mockResolvedValue(2)
      const res = await service.identity(ctxOf({ status: "ARCHIVED" }))
      expect(countWhere().where.status).toBe("ARCHIVED")
      expect(res.team.seatsUsed).toBe(2)
    })
  })

  describe("addMember / joinExistingUser", () => {
    const setupJoinable = () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.user.findUnique.mockResolvedValue({ id: 2, isActive: true })
    }

    it("已存在手机号账号直接拉入：保留原平台角色，落 MEMBER 行 + 清个人套餐 + 审计", async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 2, roles: [{ roleId: 3 }, { roleId: 7 }] })
      setupJoinable()

      const res = await service.addMember(1, 100, { account: "13800138000" })

      expect(res).toEqual({ userId: 2, teamId: 1, created: false })
      expect(prisma.userRole.upsert).not.toHaveBeenCalled()
      expect(prisma.roleModel.findUnique).not.toHaveBeenCalled()
      const [upsertArg] = callArgs<[MemberUpsert]>(prisma.teamMember.upsert, 0)
      expect(upsertArg).toMatchObject({
        where: { teamId_userId: { teamId: 1, userId: 2 } },
        create: { teamId: 1, userId: 2, role: "MEMBER", status: "ACTIVE" },
        update: {
          role: "MEMBER",
          status: "ACTIVE",
          monthlyQuota: null,
          quotaUsedThisMonth: 0,
          quotaMonth: null,
        },
      })
      expect(upsertArg.create.joinedAt).toBeInstanceOf(Date)
      expect(credit.clearGrantedCredits).toHaveBeenCalledWith(2, prisma)
      expect(credit.cancelPendingScheduledPlans).toHaveBeenCalledWith(2, prisma)
      expect(lastAudit().data).toMatchObject({
        action: "MEMBER_ADD",
        meta: { userId: 2, account: "13800138000", created: false },
      })
    })

    it.each(["13800138000", "member@example.com", null])(
      "已有用户（入口账号=%s）即使无角色、默认角色未配置，也正常加入且不补角色",
      async account => {
        setupJoinable()
        prisma.user.findFirst.mockResolvedValue({ id: 2, roles: [] })
        config.get.mockReturnValue(undefined)

        const result = account
          ? await service.addMember(1, 100, { account })
          : await service.joinExistingUser(1, 100, 2)

        expect(result).toEqual({ userId: 2, teamId: 1, created: false })
        expect(config.get).not.toHaveBeenCalled()
        expect(prisma.roleModel.findUnique).not.toHaveBeenCalled()
        expect(prisma.userRole.upsert).not.toHaveBeenCalled()
        expect(prisma.teamMember.upsert).toHaveBeenCalled()
      }
    )

    it("空白账号 → 400", async () => {
      await expect(service.addMember(1, 100, { account: "  " })).rejects.toThrow("成员账号不能为空")
    })

    it("未注册邮箱 → 400（邮箱不支持开新账号）", async () => {
      prisma.user.findFirst.mockResolvedValue(null)
      await expect(service.addMember(1, 100, { account: "a@b.com" })).rejects.toThrow(
        "该邮箱未注册"
      )
    })

    it("未注册手机号无初始密码 → 400", async () => {
      prisma.user.findFirst.mockResolvedValue(null)
      await expect(service.addMember(1, 100, { account: "13800138000" })).rejects.toThrow(
        "新成员需设置初始密码"
      )
    })

    it("未注册手机号 + 初始密码：开新账号（强制改密）后拉入", async () => {
      prisma.user.findFirst.mockResolvedValue(null)
      prisma.user.create.mockResolvedValue({ id: 2 })
      setupJoinable()

      const res = await service.addMember(1, 100, {
        account: "13800138000",
        username: "张三",
        initialPassword: "Abcd1234",
      })

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          username: "张三",
          phone: "13800138000",
          password: "hashed-password",
          mustChangePassword: true,
        },
        select: { id: true },
      })
      expect(res).toEqual({ userId: 2, teamId: 1, created: true })
      expect(prisma.teamMember.upsert).toHaveBeenCalled()
      expect(prisma.userRole.upsert).toHaveBeenCalledWith({
        where: { userId_roleId: { userId: 2, roleId: 11 } },
        create: { userId: 2, roleId: 11 },
        update: {},
      })
      expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    })

    it.each([
      [undefined, "系统未配置默认成员角色"],
      ["invalid", "默认成员角色 ID 必须为有效的正整数"],
      ["11", "配置的默认成员角色不存在"],
    ])(
      "新账号默认角色配置异常（%s）使入队事务失败，不转积分、不写成员和审计",
      async (value, message) => {
        prisma.user.findFirst.mockResolvedValue(null)
        prisma.user.create.mockResolvedValue({ id: 2 })
        setupJoinable()
        config.get.mockReturnValue(value)
        prisma.roleModel.findUnique.mockResolvedValue(null)

        await expect(
          service.addMember(1, 100, { account: "13800138000", initialPassword: "Abcd1234" })
        ).rejects.toThrow(message)
        expect(prisma.$transaction).toHaveBeenCalledTimes(1)
        expect(prisma.userRole.upsert).not.toHaveBeenCalled()
        expect(credit.transferGiftLotsToTeam).not.toHaveBeenCalled()
        expect(prisma.teamMember.upsert).not.toHaveBeenCalled()
        expect(prisma.teamAuditLog.create).not.toHaveBeenCalled()
      }
    )

    it("新账号建号、角色、入队、审计均使用同一个事务客户端", async () => {
      prisma.user.findFirst.mockResolvedValue(null)
      const tx = {
        ...prisma,
        user: {
          ...prisma.user,
          create: jest.fn().mockResolvedValue({ id: 2 }),
          findUnique: jest.fn().mockResolvedValue({ id: 2, isActive: true }),
          update: jest.fn().mockResolvedValue({}),
        },
        team: { ...prisma.team, findUnique: jest.fn().mockResolvedValue(activeTeam()) },
        roleModel: { findUnique: jest.fn().mockResolvedValue({ id: 11 }) },
        userRole: { upsert: jest.fn().mockResolvedValue({}) },
        teamMember: { ...prisma.teamMember, upsert: jest.fn().mockResolvedValue({}) },
        teamAuditLog: { create: jest.fn().mockResolvedValue({}) },
      }
      prisma.$transaction.mockImplementation((cb: (client: unknown) => Promise<unknown>) => cb(tx))

      await service.addMember(1, 100, { account: "13800138000", initialPassword: "Abcd1234" })
      expect(tx.user.create).toHaveBeenCalled()
      expect(tx.userRole.upsert).toHaveBeenCalled()
      expect(tx.teamMember.upsert).toHaveBeenCalled()
      expect(tx.teamAuditLog.create).toHaveBeenCalled()
      expect(credit.clearGrantedCredits).toHaveBeenCalledWith(2, tx)
      expect(credit.transferGiftLotsToTeam).toHaveBeenCalledWith(2, 1, tx)
      expect(prisma.user.create).not.toHaveBeenCalled()
      expect(prisma.userRole.upsert).not.toHaveBeenCalled()
      expect(prisma.teamMember.upsert).not.toHaveBeenCalled()
      expect(prisma.teamAuditLog.create).not.toHaveBeenCalled()

      tx.teamMember.upsert.mockRejectedValue(new Error("入队失败"))
      await expect(
        service.addMember(1, 100, { account: "13800138001", initialPassword: "Abcd1234" })
      ).rejects.toThrow("入队失败")
      // 错误传回外层事务，没有后置事务外的角色绑定/建号。
      expect(prisma.user.create).not.toHaveBeenCalled()
      expect(prisma.userRole.upsert).not.toHaveBeenCalled()
      expect(tx.teamAuditLog.create).toHaveBeenCalledTimes(1)
    })

    it("个人套餐积分未用完（PACKAGE>0）→ 400 拦截，不转移赠送积分", async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 2 })
      setupJoinable()
      credit.consumableBalance.mockResolvedValue(new Decimal(300))

      await expect(service.addMember(1, 100, { account: "13800138000" })).rejects.toThrow(
        "不可直接拉入企业"
      )
      // 拦截发生在席位/角色绑定之前，不落成员行
      expect(prisma.teamMember.upsert).not.toHaveBeenCalled()
      expect(credit.transferGiftLotsToTeam).not.toHaveBeenCalled()
      // 赠送积分不再参与拦截。
      const balArgs = credit.consumableBalance.mock.calls[0] as unknown as [
        unknown,
        number,
        string[],
      ]
      expect(balArgs[1]).toBe(2)
      expect(balArgs[2]).toEqual(["PACKAGE"])
    })

    it("仅有赠送积分 → 转入企业后加入，转移与清理/入队/审计共用事务", async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 2 })
      setupJoinable()
      credit.transferGiftLotsToTeam.mockResolvedValue(new Decimal(200))

      await service.addMember(1, 100, { account: "13800138000" })

      expect(credit.consumableBalance).toHaveBeenCalledWith(prisma, 2, ["PACKAGE"])
      expect(credit.transferGiftLotsToTeam).toHaveBeenCalledWith(2, 1, prisma)
      expect(credit.transferGiftLotsToTeam.mock.invocationCallOrder[0]).toBeLessThan(
        credit.clearGrantedCredits.mock.invocationCallOrder[0]
      )
      expect(lastAudit().data.meta).toMatchObject({ userId: 2, transferredGiftCredits: "200" })
      expect(prisma.$transaction).toHaveBeenCalledTimes(1)
      // 先锁成员账号再读归属，避免并发拉入时以旧快照重复操作。
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.team.findUnique.mock.invocationCallOrder[0]
      )
    })

    it("赠送转移失败 → 事务失败，不执行清理、入队和审计", async () => {
      setupJoinable()
      credit.transferGiftLotsToTeam.mockRejectedValue(new Error("转入失败"))

      await expect(service.joinExistingUser(1, 100, 2)).rejects.toThrow("转入失败")
      expect(credit.clearGrantedCredits).not.toHaveBeenCalled()
      expect(prisma.teamMember.upsert).not.toHaveBeenCalled()
      expect(prisma.teamAuditLog.create).not.toHaveBeenCalled()
    })

    it("个人套餐/赠送积分为 0 → 放行（正常拉入）", async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 2 })
      setupJoinable()
      credit.consumableBalance.mockResolvedValue(new Decimal(0))

      const res = await service.addMember(1, 100, { account: "13800138000" })
      expect(res).toEqual({ userId: 2, teamId: 1, created: false })
      expect(prisma.teamMember.upsert).toHaveBeenCalled()
    })

    it("平台已停用账号（isActive=false）→ 400，不落成员行", async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 2 })
      setupJoinable()
      prisma.user.findUnique.mockResolvedValue({ id: 2, isActive: false })

      await expect(service.addMember(1, 100, { account: "13800138000" })).rejects.toThrow(
        "该账号已停用，不可加入企业团队"
      )
      expect(prisma.teamMember.upsert).not.toHaveBeenCalled()
      expect(prisma.userRole.upsert).not.toHaveBeenCalled()
    })

    it("成员去重：已是本团队成员 → 400；已归属其他企业 → 400", async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 2 })
      setupJoinable()
      prisma.teamMember.findFirst.mockResolvedValue({ teamId: 1 })
      await expect(service.addMember(1, 100, { account: "13800138000" })).rejects.toThrow(
        "该用户已是本团队成员"
      )

      prisma.teamMember.findFirst.mockResolvedValue({ teamId: 9 })
      await expect(service.addMember(1, 100, { account: "13800138000" })).rejects.toThrow(
        "该用户已归属其他企业，不可重复加入"
      )
      expect(prisma.userRole.upsert).not.toHaveBeenCalled()
    })

    it("席位上限：占座成员数（ACTIVE+DISABLED）达 seats → 400", async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 2 })
      setupJoinable()
      prisma.teamMember.count.mockResolvedValue(3) // seats = 3
      await expect(service.addMember(1, 100, { account: "13800138000" })).rejects.toThrow(
        "席位已满，请先升级席位"
      )
      // 停用成员仍占座：统计口径为「非 ARCHIVED」，不能只数 ACTIVE
      expect(prisma.teamMember.count).toHaveBeenCalledWith({
        where: { teamId: 1, status: { not: "ARCHIVED" } },
      })
      expect(prisma.userRole.upsert).not.toHaveBeenCalled()
    })

    it("团队状态校验：非 ACTIVE → 400；团队不存在 → 404", async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 2 })
      prisma.team.findUnique.mockResolvedValue(activeTeam({ status: "GRACE" }))
      await expect(service.addMember(1, 100, { account: "13800138000" })).rejects.toThrow(
        "团队当前状态不可添加成员"
      )

      prisma.team.findUnique.mockResolvedValue(null)
      await expect(service.addMember(1, 100, { account: "13800138000" })).rejects.toThrow(
        NotFoundException
      )
    })
  })

  describe("removeMember", () => {
    it("成功移出：删成员行 + 审计", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.findUnique.mockResolvedValue(memberRow())

      const res = await service.removeMember(1, 100, 2)
      expect(credit.transferGiftLotsToTeam).not.toHaveBeenCalled()
      expect(prisma.creditLot.updateMany).not.toHaveBeenCalled()

      expect(prisma.teamMember.delete).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 1, userId: 2 } },
      })
      expect(lastAudit().data).toMatchObject({
        action: "MEMBER_REMOVE",
        meta: { userId: 2, role: "MEMBER" },
      })
      expect(res).toEqual({ userId: 2, removed: true })
    })

    it("管理员不可移出 → 400；成员不存在 → 404", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.findUnique.mockResolvedValue(memberRow({ userId: 100, role: "ADMIN" }))
      await expect(service.removeMember(1, 100, 100)).rejects.toThrow(
        "管理员不可移出，请先指定新管理员"
      )
      expect(prisma.$transaction).not.toHaveBeenCalled()

      prisma.teamMember.findUnique.mockResolvedValue(null)
      await expect(service.removeMember(1, 100, 2)).rejects.toThrow(NotFoundException)
    })
  })

  describe("setMemberRole", () => {
    it("移交管理员：新管理员升任 + 原管理员降为成员 + team.adminId 切换", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.findUnique.mockResolvedValue(memberRow())

      const res = await service.setMemberRole(1, 100, 2, "ADMIN")

      expect(prisma.teamMember.update).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 1, userId: 2 } },
        data: { role: "ADMIN" },
      })
      expect(prisma.teamMember.updateMany).toHaveBeenCalledWith({
        where: { teamId: 1, userId: 100 },
        data: { role: "MEMBER" },
      })
      expect(prisma.team.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { adminId: 2 },
      })
      expect(lastAudit().data).toMatchObject({
        action: "MEMBER_ROLE",
        meta: { userId: 2, role: "ADMIN", previousAdminId: 100 },
      })
      expect(res).toEqual({ userId: 2, role: "ADMIN" })
    })

    it("目标已是管理员：直接返回，不走事务", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.findUnique.mockResolvedValue(memberRow({ userId: 100, role: "ADMIN" }))

      const res = await service.setMemberRole(1, 100, 100, "ADMIN")

      expect(res).toEqual({ userId: 100, role: "ADMIN" })
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it("当前管理员不可直接降为成员 → 400；普通成员降为成员成功", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.findUnique.mockResolvedValue(memberRow({ userId: 100, role: "ADMIN" }))
      await expect(service.setMemberRole(1, 100, 100, "MEMBER")).rejects.toThrow(
        "不能直接将管理员设为成员"
      )

      prisma.teamMember.findUnique.mockResolvedValue(memberRow())
      const res = await service.setMemberRole(1, 100, 2, "MEMBER")
      expect(prisma.teamMember.update).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 1, userId: 2 } },
        data: { role: "MEMBER" },
      })
      expect(res).toEqual({ userId: 2, role: "MEMBER" })
    })

    it("成员不存在或已归档 → 404", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.findUnique.mockResolvedValue(null)
      await expect(service.setMemberRole(1, 100, 2, "ADMIN")).rejects.toThrow(NotFoundException)

      prisma.teamMember.findUnique.mockResolvedValue(memberRow({ status: "ARCHIVED" }))
      await expect(service.setMemberRole(1, 100, 2, "ADMIN")).rejects.toThrow("成员不存在")
    })
  })

  describe("setMemberStatus", () => {
    it("管理员不可停用 → 400", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.findUnique.mockResolvedValue(memberRow({ userId: 100, role: "ADMIN" }))
      await expect(service.setMemberStatus(1, 100, 100, "DISABLED")).rejects.toThrow(
        "管理员不可停用"
      )
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it("停用成功：更新状态 + 审计", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.findUnique.mockResolvedValue(memberRow())

      const res = await service.setMemberStatus(1, 100, 2, "DISABLED")

      expect(prisma.teamMember.update).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 1, userId: 2 } },
        data: { status: "DISABLED" },
      })
      expect(lastAudit().data.action).toBe("MEMBER_STATUS")
      expect(res).toEqual({ userId: 2, status: "DISABLED" })
    })

    it("启用前唯一归属校验：已加入其他企业 → 400；未占用则可启用", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.findUnique.mockResolvedValue(memberRow({ status: "DISABLED" }))
      prisma.teamMember.findFirst.mockResolvedValue({ teamId: 9 })
      await expect(service.setMemberStatus(1, 100, 2, "ACTIVE")).rejects.toThrow(
        "该用户已归属其他企业，不可启用"
      )

      prisma.teamMember.findFirst.mockResolvedValue(null)
      const res = await service.setMemberStatus(1, 100, 2, "ACTIVE")
      expect(res).toEqual({ userId: 2, status: "ACTIVE" })
    })
  })

  describe("requireTeamAdmin", () => {
    const ctx = (role: string, status: string) => ({
      team: activeTeam(),
      member: memberRow({ role, status }),
    })

    it("ACTIVE 管理员放行；成员或被停用的管理员 → 403", () => {
      expect(() => service.requireTeamAdmin(ctx("ADMIN", "ACTIVE") as never)).not.toThrow()
      expect(() => service.requireTeamAdmin(ctx("MEMBER", "ACTIVE") as never)).toThrow(
        ForbiddenException
      )
      expect(() => service.requireTeamAdmin(ctx("ADMIN", "DISABLED") as never)).toThrow(
        "仅企业管理员可执行该操作"
      )
    })
  })

  describe("requireTeamAdminRead（只读守卫）", () => {
    const ctx = (role: string, status: string, teamStatus = "ACTIVE") => ({
      team: activeTeam({ status: teamStatus }),
      member: memberRow({ role, status }),
    })

    it("ACTIVE 团队：ACTIVE 管理员放行；成员 → 403", () => {
      expect(() => service.requireTeamAdminRead(ctx("ADMIN", "ACTIVE") as never)).not.toThrow()
      expect(() => service.requireTeamAdminRead(ctx("MEMBER", "ACTIVE") as never)).toThrow(
        ForbiddenException
      )
    })

    it("归档团队：归档管理员（成员行 ARCHIVED）放行只读；归档成员 → 403", () => {
      expect(() =>
        service.requireTeamAdminRead(ctx("ADMIN", "ARCHIVED", "ARCHIVED") as never)
      ).not.toThrow()
      expect(() =>
        service.requireTeamAdminRead(ctx("MEMBER", "ARCHIVED", "ARCHIVED") as never)
      ).toThrow(ForbiddenException)
    })

    it("归档管理员写操作仍被 requireTeamAdmin 拦截（只读不放写）", () => {
      expect(() => service.requireTeamAdmin(ctx("ADMIN", "ARCHIVED", "ARCHIVED") as never)).toThrow(
        ForbiddenException
      )
    })
  })

  describe("updateTeam（席位调整）", () => {
    it("没有需要更新的字段 → 400", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      await expect(service.updateTeam(1, 100, {})).rejects.toThrow("没有需要更新的字段")
    })

    it("席位不得低于当前在用 → 400", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam())
      prisma.teamMember.count.mockResolvedValue(5)
      await expect(service.updateTeam(1, 100, { seats: 3 })).rejects.toThrow(
        "席位数不得低于当前在用席位（5）"
      )
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it("自助购买企业折扣固定 1，不可调整 → 400", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam({ source: "SELF" }))
      await expect(service.updateTeam(1, 100, { discount: 0.7 })).rejects.toThrow(
        "自助购买企业的共享池折扣固定为 1"
      )
    })

    it("提升席位成功：更新 + 审计后返回详情", async () => {
      prisma.team.findUnique.mockResolvedValueOnce(activeTeam()).mockResolvedValue(detailTeam())
      prisma.teamMember.count.mockResolvedValue(1)

      const res = await service.updateTeam(1, 100, { seats: 10 })

      expect(prisma.team.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { seats: 10 },
      })
      expect(lastAudit().data.action).toBe("TEAM_UPDATE")
      expect(res.id).toBe(1)
    })

    it("改到期日：联动重算 graceUntil / dataKeepUntil", async () => {
      prisma.team.findUnique.mockResolvedValueOnce(activeTeam()).mockResolvedValue(detailTeam())
      const newExpiresAt = new Date("2027-06-30T00:00:00.000Z")

      await service.updateTeam(1, 100, { expiresAt: "2027-06-30T00:00:00.000Z" })

      expect(prisma.team.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          expiresAt: newExpiresAt,
          graceUntil: graceUntilOf(newExpiresAt),
          dataKeepUntil: dataKeepUntilOf(newExpiresAt),
        },
      })
    })
  })

  describe("getAdminTeamDetail（平台详情）", () => {
    it("成员带所属组织 orgs 与累计已消耗 consumedTotal（CONSUME+TEAM_CONSUME 全时段 DEBIT 合计）", async () => {
      prisma.team.findUnique.mockResolvedValue({
        ...detailTeam(),
        members: [
          {
            userId: 63,
            role: "MEMBER",
            status: "ACTIVE",
            joinedAt: new Date("2026-08-01T00:00:00.000Z"),
            monthlyQuota: 800,
            quotaUsedThisMonth: new Decimal(120),
            user: {
              id: 63,
              username: "小雅",
              phone: "18800000063",
              orgs: [{ org: { id: 1, name: "品牌运营部" } }],
              invitedBy: { id: 12, username: "张明" }, // bug26：邀请人
              roles: [{ role: { id: 3, code: "OPS", name: "运营专员", color: "#0a84ff" } }], // 业务角色（2026-09-03）
            },
          },
          {
            // 管理员成员行（bug33：池段返利卷起挂在本行）
            userId: 100,
            role: "ADMIN",
            status: "ACTIVE",
            joinedAt: new Date("2026-08-02T00:00:00.000Z"),
            monthlyQuota: null,
            quotaUsedThisMonth: new Decimal(0),
            user: {
              id: 100,
              username: "老板",
              phone: "13800000000",
              orgs: [],
              invitedBy: { id: 12, username: "张明" },
              roles: [],
            },
          },
        ],
      })
      prisma.creditTransaction.groupBy.mockImplementation(
        (arg: { where?: { direction?: unknown; teamId?: unknown } }) => {
          // 消耗聚合（direction=DEBIT）
          if (arg?.where?.direction != null) {
            return Promise.resolve([{ userId: 63, _sum: { amount: new Decimal(3400) } }])
          }
          // 池段返利（teamId 有值）：受益人 12 累计 156——非管理员成员不卷起
          if (arg?.where?.teamId != null) {
            return Promise.resolve([{ userId: 12, _sum: { amount: new Decimal(156) } }])
          }
          // 个人段返利：消费者 63 → 受益人 12 累计 44
          return Promise.resolve([
            { userId: 12, relatedUserId: 63, _sum: { amount: new Decimal(44) } },
          ])
        }
      )
      prisma.user.findMany.mockResolvedValue([{ id: 12, username: "张明" }]) // 受益人用户名补查

      const res = await service.getAdminTeamDetail(1)

      expect(res.members[0].orgs).toEqual([{ id: 1, name: "品牌运营部" }])
      expect(res.members[0].roles).toEqual([
        { id: 3, code: "OPS", name: "运营专员", color: "#0a84ff" },
      ])
      expect(res.members[0].consumedTotal).toBe("3400")
      // bug26：邀请人 + 返利归属（个人段 44；池段 156 不卷到非管理员行）
      expect(res.members[0].inviter).toEqual({ id: 12, username: "张明" })
      expect(res.members[0].rebateAttribution).toEqual([
        { userId: 12, username: "张明", amount: "44" },
      ])
      // 管理员行卷起池段 156
      expect(res.members[1].rebateAttribution).toEqual([
        { userId: 12, username: "张明", amount: "156" },
      ])
      // 2026-09-07 bug33：本企业返利合计 = 成员表返利归属全量汇总（44 个人段 + 156 池段），与明细逐项加总一致
      expect(res.corpRebateTotal).toBe("200")
      const [args] = callArgs<[{ where: { type: unknown; direction: string } }]>(
        prisma.creditTransaction.groupBy,
        0
      )
      expect(args.where.type).toEqual({ in: ["CONSUME", "TEAM_CONSUME"] })
      expect(args.where.direction).toBe("DEBIT")
    })

    it("面板字段：inviter=Team.invitedById 快照对应用户；corpRebate 与 §5.6 corpKids 同语义（2026-09-03）", async () => {
      prisma.team.findUnique.mockResolvedValue({
        ...detailTeam(),
        invitedById: 12, // 建队邀请人快照
        admin: { id: 100, username: "老板", phone: "13800000000", corpPassUp: false }, // 逐人关过 → 不跟随全局
        members: [],
      })
      prisma.user.findUnique.mockResolvedValue({ id: 12, username: "张明" }) // 快照邀请人
      prisma.rebateRule.findFirst.mockResolvedValue({ id: 1, corpCounts: true })

      const res = await service.getAdminTeamDetail(1)

      expect(res.inviter).toEqual({ id: 12, username: "张明" })
      expect(res.corpRebate).toEqual({ enabled: false, overridden: true }) // 逐人设定优先于全局
      expect(res.corpRebateTotal).toBe("0")
    })

    it("面板字段兜底：无快照/快照账号已注销 → inviter=null；未单独设定 → enabled 跟随全局、overridden=false", async () => {
      prisma.team.findUnique.mockResolvedValue({
        ...detailTeam(), // invitedById 缺省 = 无快照
        admin: { id: 100, username: "老板", phone: "13800000000", corpPassUp: null },
        members: [],
      })
      prisma.rebateRule.findFirst.mockResolvedValue({ id: 1, corpCounts: false })

      const res = await service.getAdminTeamDetail(1)

      expect(res.inviter).toBeNull()
      expect(prisma.user.findUnique).not.toHaveBeenCalled() // 无快照不查
      expect(res.corpRebate).toEqual({ enabled: false, overridden: false }) // 跟随全局 corpCounts=false
    })
  })

  describe("restoreTeam", () => {
    it("恢复天数非正整数 → 400", async () => {
      await expect(service.restoreTeam(1, 0, 100)).rejects.toThrow("恢复天数必须为正整数")
      await expect(service.restoreTeam(1, 1.5, 100)).rejects.toThrow(BadRequestException)
      expect(prisma.$transaction).not.toHaveBeenCalled()
    })

    it("团队不存在 → 404；ACTIVE 团队无需恢复 → 400", async () => {
      prisma.team.findUnique.mockResolvedValue(null)
      await expect(service.restoreTeam(1, 30, 100)).rejects.toThrow(NotFoundException)

      prisma.team.findUnique.mockResolvedValue(activeTeam({ members: [] }))
      await expect(service.restoreTeam(1, 30, 100)).rejects.toThrow("团队当前状态无需恢复")
    })

    it.each(["GRACE", "ARCHIVED", "DISABLED"])(
      "%s → ACTIVE：重算有效期并清归档标记",
      async status => {
        prisma.team.findUnique.mockResolvedValue(
          activeTeam({ status, archivedAt: status === "ARCHIVED" ? new Date() : null, members: [] })
        )

        const before = Date.now()
        const res = await service.restoreTeam(1, 30, 100)
        const after = Date.now()

        const [updateArg] = callArgs<
          [
            {
              data: {
                status: string
                expiresAt: Date
                graceUntil: Date
                dataKeepUntil: Date
                archivedAt: null
              }
            },
          ]
        >(prisma.team.update, 0)
        const updateData = updateArg.data
        expect(updateData.status).toBe("ACTIVE")
        expect(updateData.archivedAt).toBeNull()
        // expiresAt = now + 30 天；graceUntil/dataKeepUntil 以其为准重算
        expect(updateData.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY_MS)
        expect(updateData.expiresAt.getTime()).toBeLessThanOrEqual(after + 30 * DAY_MS)
        expect(updateData.graceUntil.getTime() - updateData.expiresAt.getTime()).toBe(
          TEAM_GRACE_DAYS * DAY_MS
        )
        expect(updateData.dataKeepUntil.getTime() - updateData.expiresAt.getTime()).toBe(
          TEAM_DATA_KEEP_DAYS * DAY_MS
        )
        expect(lastAudit().data).toMatchObject({
          action: "TEAM_RESTORE",
          meta: { from: status, periodDays: 30 },
        })
        expect(res.status).toBe("ACTIVE")
        expect(res.expiresAt.getTime()).toBe(updateData.expiresAt.getTime())
      }
    )

    it("接回成员：非 ACTIVE 置回 ACTIVE；已加入他企的跳过并列出", async () => {
      prisma.team.findUnique.mockResolvedValue(
        activeTeam({
          status: "GRACE",
          members: [
            memberRow({ userId: 100, role: "ADMIN", status: "ARCHIVED" }),
            memberRow({ userId: 2, status: "ACTIVE" }),
            memberRow({ userId: 3, status: "ARCHIVED" }),
          ],
        })
      )
      // 归档期间 user 3 已加入其他企业
      prisma.teamMember.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ teamId: 9 })

      const res = await service.restoreTeam(1, 30, 100)

      // 仅 user 100 需要置回 ACTIVE（user 2 已是 ACTIVE，user 3 被跳过）
      expect(prisma.teamMember.update).toHaveBeenCalledTimes(1)
      expect(prisma.teamMember.update).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 1, userId: 100 } },
        data: { status: "ACTIVE" },
      })
      expect(res.restoredMemberIds).toEqual([100, 2])
      expect(res.skippedMembers).toEqual([
        { userId: 3, reason: "归档/停用期间已加入其他企业，需重新添加" },
      ])
    })

    it("宽限期保留的套餐/赠送批次随恢复顺延到新有效期（RECHARGE_PLAN 来源，remaining>0）", async () => {
      prisma.team.findUnique.mockResolvedValue(activeTeam({ status: "GRACE", members: [] }))

      const res = await service.restoreTeam(1, 30, 100)

      expect(prisma.creditLot.updateMany).toHaveBeenCalledWith({
        where: {
          teamId: 1,
          sourceType: "RECHARGE_PLAN",
          bucket: { in: ["PACKAGE", "GIFT"] },
          status: "ACTIVE",
          remaining: { gt: 0 },
          expiresAt: { lt: res.expiresAt },
        },
        data: { expiresAt: res.expiresAt },
      })
    })
  })

  describe("listTeams", () => {
    const findManyWhere = () =>
      (prisma.team.findMany.mock.calls as unknown as Array<[{ where: { OR?: unknown[] } }]>)[0][0]
        .where

    it.each([
      { roles: [] },
      {
        roles: [
          { id: 3, code: "OPS", name: "运营", color: "#1677ff" },
          { id: 7, code: "VIEWER", name: "查看者", color: null },
        ],
      },
    ])("企业列表返回管理员的平台角色数组：$roles", async ({ roles }) => {
      prisma.team.findMany.mockResolvedValue([
        {
          ...activeTeam(),
          admin: {
            id: 100,
            username: "老板",
            phone: "13800000000",
            roles: roles.map(role => ({ role })),
          },
          _count: { members: 1 },
        },
      ])

      const result = await service.listTeams({ page: 1, pageSize: 10, source: "CUSTOM" } as never)

      expect(result.items[0].admin).toEqual({
        id: 100,
        username: "老板",
        phone: "13800000000",
        roles,
      })
      expect(
        firstArgs<{ include: unknown; where: unknown }>(prisma.team.findMany)[0]
      ).toMatchObject({
        where: { source: "CUSTOM" },
        include: {
          admin: {
            select: {
              id: true,
              username: true,
              phone: true,
              roles: {
                select: { role: { select: { id: true, code: true, name: true, color: true } } },
              },
            },
          },
        },
      })
    })

    it("普通关键词：企业名/管理员名/手机号 三条件 contains", async () => {
      await service.listTeams({ page: 1, pageSize: 10, keyword: "星辰" } as never)
      expect(findManyWhere().OR).toEqual([
        { name: { contains: "星辰" } },
        { admin: { username: { contains: "星辰" } } },
        { admin: { phone: { contains: "星辰" } } },
      ])
    })

    it("搜展示名「xxx的团队」（空名团队回落名）：剥后缀追加管理员名匹配", async () => {
      await service.listTeams({ page: 1, pageSize: 10, keyword: "赵芮的团队" } as never)
      expect(findManyWhere().OR).toEqual([
        { name: { contains: "赵芮的团队" } },
        { admin: { username: { contains: "赵芮的团队" } } },
        { admin: { phone: { contains: "赵芮的团队" } } },
        { admin: { username: { contains: "赵芮" } } }, // 展示名回落匹配
      ])
    })

    it("归档企业：seatsUsed 按归档保留名单统计（与总览/成员列表同口径，不再显示 0）", async () => {
      prisma.team.findMany.mockResolvedValue([
        {
          id: 8,
          name: "CODEX_QA_团队",
          nameFilled: true,
          source: "CUSTOM",
          status: "ARCHIVED",
          tier: 1,
          seats: 2,
          admin: { id: 11, username: "qa", phone: "13000000000", roles: [] },
          discount: 1,
          expiresAt: new Date(),
          graceUntil: null,
          archivedAt: new Date(),
          createdAt: new Date(),
          _count: { members: 0 }, // 非 ARCHIVED 成员数为 0（成员行已整体置 ARCHIVED）
        },
      ])
      prisma.teamMember.groupBy.mockResolvedValue([{ teamId: 8, _count: { _all: 2 } }])

      const res = await service.listTeams({ page: 1, pageSize: 10 } as never)

      expect(prisma.teamMember.groupBy).toHaveBeenCalledWith({
        by: ["teamId"],
        where: { teamId: { in: [8] }, status: "ARCHIVED" },
        _count: { _all: true },
      })
      expect(res.items[0].seatsUsed).toBe(2)
      expect(res.items[0].seats).toBe(2)
    })
  })
})
