import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import { CreditBucket, CreditTxnType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import * as argon2 from "argon2"
import { CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"
import { SmsService } from "../sms/sms.service"
import { UserService } from "./user.service"

describe("UserService", () => {
  let service: UserService
  let sms: { sendPasswordResetNotice: jest.Mock }
  let credit: { grant: jest.Mock; getConsumableBalance: jest.Mock }
  let prisma: {
    user: {
      findMany: jest.Mock
      findUnique: jest.Mock
      count: jest.Mock
      create: jest.Mock
      update: jest.Mock
      groupBy: jest.Mock
    }
    roleModel: { count: jest.Mock; findMany: jest.Mock }
    organization: { count: jest.Mock; findUnique: jest.Mock }
    userRole: { deleteMany: jest.Mock; createMany: jest.Mock }
    userOrganization: { deleteMany: jest.Mock; createMany: jest.Mock }
    creditLot: { groupBy: jest.Mock }
    history: { create: jest.Mock }
    $transaction: jest.Mock
  }

  const userRow = (over: Record<string, unknown> = {}) => ({
    id: 1,
    username: "张明",
    phone: "13800001234",
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date("2025-08-12T10:24:00.000Z"),
    subscriptionTier: 2,
    membershipLevel: "LV2",
    canInvite: false,
    invitedById: null,
    rebateEnabled: true,
    rebateRate: new Decimal("0.3"), // 一级返佣比例（2026-08-31 补，「团队长 · 返佣 30%」列）
    invitedBy: null,
    teamMemberships: [],
    roles: [{ role: { id: 1, code: "ADMIN", name: "管理员", color: "#ff3b30" } }],
    orgs: [{ org: { id: 1, name: "深圳总部" } }],
    ...over,
  })

  beforeEach(async () => {
    prisma = {
      user: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        update: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]), // 一级下级数聚合（invitedCount）
      },
      roleModel: { count: jest.fn(), findMany: jest.fn() },
      organization: { count: jest.fn(), findUnique: jest.fn() },
      userRole: { deleteMany: jest.fn(), createMany: jest.fn() },
      userOrganization: { deleteMany: jest.fn(), createMany: jest.fn() },
      creditLot: { groupBy: jest.fn().mockResolvedValue([]) },
      history: { create: jest.fn().mockResolvedValue({}) },
      // 同时支持数组形式（updateUser/moveToOrg）与回调形式（batchCreate 交互事务）
      $transaction: jest
        .fn()
        .mockImplementation((arg: unknown) =>
          typeof arg === "function"
            ? (arg as (tx: typeof prisma) => unknown)(prisma)
            : Promise.resolve([])
        ),
    }

    sms = { sendPasswordResetNotice: jest.fn().mockResolvedValue(undefined) }
    credit = {
      grant: jest.fn().mockResolvedValue(undefined),
      getConsumableBalance: jest.fn().mockResolvedValue(new Decimal(0)),
    }

    const module = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: prisma },
        { provide: SmsService, useValue: sms },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("OS1234") } },
        { provide: CreditService, useValue: credit },
      ],
    }).compile()

    service = module.get(UserService)
  })

  describe("createUser", () => {
    it("默认密码 argon2 入库，建用户并嵌套写角色/组织", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // assertPhoneAvailable
        .mockResolvedValueOnce(userRow({ id: 7 })) // getUser
      prisma.roleModel.count.mockResolvedValue(1)
      prisma.organization.count.mockResolvedValue(1)
      prisma.user.create.mockResolvedValue({ id: 7 })

      const result = await service.createUser({
        username: "张明",
        phone: "13800001234",
        roleIds: [1],
        orgIds: [1],
      })

      const createCalls = prisma.user.create.mock.calls as Array<
        [{ data: { password: string; roles: { create: unknown[] }; orgs: { create: unknown[] } } }]
      >
      const createArg = createCalls[0][0]
      await expect(argon2.verify(createArg.data.password, "OS1234")).resolves.toBe(true)
      expect(createArg.data.roles.create).toEqual([{ roleId: 1 }])
      expect(createArg.data.orgs.create).toEqual([{ orgId: 1 }])
      expect(result.id).toBe(7)
      // 后台建号送 200 注册赠送积分（GIFT，SIGNUP_BONUS）
      expect(credit.grant).toHaveBeenCalledWith(
        7,
        CreditBucket.GIFT,
        200,
        expect.objectContaining({
          type: CreditTxnType.SIGNUP_BONUS,
          expiresAt: expect.any(Date) as Date,
        }),
        prisma
      )
    })

    it("手机号已存在抛 ConflictException", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 9 })
      await expect(service.createUser({ username: "张三", phone: "13800001234" })).rejects.toThrow(
        ConflictException
      )
      expect(prisma.user.create).not.toHaveBeenCalled()
    })

    it("角色 id 不存在抛 BadRequestException", async () => {
      prisma.user.findUnique.mockResolvedValue(null) // 手机号可用
      prisma.roleModel.count.mockResolvedValue(0) // 但角色不存在
      await expect(
        service.createUser({ username: "张三", phone: "13900000000", roleIds: [99] })
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe("batchCreate", () => {
    it("入参内部手机号重复抛 BadRequestException", async () => {
      await expect(
        service.batchCreate({
          users: [
            { username: "A", phone: "13800000001" },
            { username: "B", phone: "13800000001" },
          ],
        })
      ).rejects.toThrow(BadRequestException)
      expect(prisma.user.findMany).not.toHaveBeenCalled()
    })

    it("与库内手机号冲突抛 ConflictException", async () => {
      prisma.user.findMany.mockResolvedValue([{ phone: "13800000002" }])
      await expect(
        service.batchCreate({
          users: [
            { username: "A", phone: "13800000001" },
            { username: "B", phone: "13800000002" },
          ],
        })
      ).rejects.toThrow(ConflictException)
      expect(prisma.user.create).not.toHaveBeenCalled()
    })

    it("全部校验通过时事务内逐条创建并返回详情", async () => {
      prisma.user.findMany.mockResolvedValue([]) // 库内无冲突
      prisma.roleModel.count.mockResolvedValue(1)
      prisma.organization.count.mockResolvedValue(0)
      prisma.user.create.mockResolvedValueOnce({ id: 10 }).mockResolvedValueOnce({ id: 11 })
      prisma.user.findUnique
        .mockResolvedValueOnce(userRow({ id: 10 }))
        .mockResolvedValueOnce(userRow({ id: 11 }))

      const result = await service.batchCreate({
        users: [
          { username: "A", phone: "13800000001", roleIds: [1] },
          { username: "B", phone: "13800000002", roleIds: [1] },
        ],
      })

      expect(prisma.$transaction).toHaveBeenCalled()
      expect(prisma.user.create).toHaveBeenCalledTimes(2)
      expect(result.map(u => u.id)).toEqual([10, 11])
      // 批量建号每人各送 200 注册赠送积分
      expect(credit.grant).toHaveBeenCalledTimes(2)
      expect(credit.grant).toHaveBeenCalledWith(
        10,
        CreditBucket.GIFT,
        200,
        expect.objectContaining({
          type: CreditTxnType.SIGNUP_BONUS,
          expiresAt: expect.any(Date) as Date,
        }),
        prisma
      )
    })
  })

  describe("listRoleOptions", () => {
    it("返回角色简要选项（id/name/color）", async () => {
      prisma.roleModel.findMany.mockResolvedValue([{ id: 1, name: "运营主管", color: "#007aff" }])

      const result = await service.listRoleOptions()

      expect(result).toEqual([{ id: 1, name: "运营主管", color: "#007aff" }])
    })
  })

  describe("updateUser", () => {
    it("传 roleIds 时整组重置中间表", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1 }) // 存在性
        .mockResolvedValueOnce(userRow()) // getUser
      prisma.roleModel.count.mockResolvedValue(2)

      await service.updateUser(1, { roleIds: [1, 2] })

      expect(prisma.userRole.deleteMany).toHaveBeenCalledWith({ where: { userId: 1 } })
      expect(prisma.userRole.createMany).toHaveBeenCalledWith({
        data: [
          { userId: 1, roleId: 1 },
          { userId: 1, roleId: 2 },
        ],
        skipDuplicates: true,
      })
      expect(prisma.$transaction).toHaveBeenCalled()
    })

    it("改手机号且与他人冲突时抛 ConflictException", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1, phone: "13800001234" }) // 当前用户
        .mockResolvedValueOnce({ id: 9 }) // assertPhoneAvailable：新号已被占用
      await expect(service.updateUser(1, { phone: "13900000000" })).rejects.toThrow(
        ConflictException
      )
    })

    it("用户不存在抛 NotFoundException", async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      await expect(service.updateUser(99, { username: "x" })).rejects.toThrow(NotFoundException)
    })
  })

  describe("resetPassword", () => {
    it("标记强制改密 + 短信通知 + 不返回明文", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, phone: "13800001234" })
      prisma.user.update.mockResolvedValue({ id: 1 })

      const result = await service.resetPassword(1)

      const updateCalls = prisma.user.update.mock.calls as Array<
        [{ data: { mustChangePassword: boolean } }]
      >
      expect(updateCalls[0][0].data.mustChangePassword).toBe(true)
      expect(sms.sendPasswordResetNotice).toHaveBeenCalledWith("13800001234")
      expect(result).toEqual({ id: 1 })
    })
  })

  describe("setStatus", () => {
    it("停用写 isActive=false 且 deactivatedAt 非空", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1 })
        .mockResolvedValueOnce(userRow({ isActive: false }))

      await service.setStatus(1, false)

      const updateCalls = prisma.user.update.mock.calls as Array<
        [{ data: { isActive: boolean; deactivatedAt: Date | null } }]
      >
      expect(updateCalls[0][0].data.isActive).toBe(false)
      expect(updateCalls[0][0].data.deactivatedAt).toBeInstanceOf(Date)
    })

    it("启用写 isActive=true 且 deactivatedAt=null", async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce(userRow())

      await service.setStatus(1, true)

      const updateCalls = prisma.user.update.mock.calls as Array<
        [{ data: { isActive: boolean; deactivatedAt: Date | null } }]
      >
      expect(updateCalls[0][0].data.isActive).toBe(true)
      expect(updateCalls[0][0].data.deactivatedAt).toBeNull()
    })
  })

  describe("moveToOrg", () => {
    it("目标组织存在时幂等批量加入", async () => {
      prisma.organization.findUnique.mockResolvedValue({ id: 5 })
      prisma.userOrganization.createMany.mockResolvedValue({ count: 3 })

      const result = await service.moveToOrg({ userIds: [1, 2, 3], orgId: 5, replace: false })

      expect(prisma.userOrganization.createMany).toHaveBeenCalledWith({
        data: [
          { userId: 1, orgId: 5 },
          { userId: 2, orgId: 5 },
          { userId: 3, orgId: 5 },
        ],
        skipDuplicates: true,
      })
      expect(result).toEqual({ moved: 3 })
    })

    it("replace=true 时先清空用户组织再写入目标组织", async () => {
      prisma.organization.findUnique.mockResolvedValue({ id: 5 })

      const result = await service.moveToOrg({ userIds: [1, 2], orgId: 5, replace: true })

      expect(prisma.userOrganization.deleteMany).toHaveBeenCalledWith({
        where: { userId: { in: [1, 2] } },
      })
      expect(prisma.$transaction).toHaveBeenCalled()
      expect(result).toEqual({ moved: 2 })
    })

    it("目标组织不存在抛 NotFoundException", async () => {
      prisma.organization.findUnique.mockResolvedValue(null)
      await expect(service.moveToOrg({ userIds: [1], orgId: 99 })).rejects.toThrow(
        NotFoundException
      )
    })
  })

  describe("list（筛选/脱敏/视图列）", () => {
    it("手机号脱敏 + 会员视图列（level/team/invitedBy/points）", async () => {
      prisma.user.findMany.mockResolvedValue([
        userRow({
          invitedBy: { id: 9, username: "王老板" },
          teamMemberships: [
            {
              role: "ADMIN",
              status: "ACTIVE",
              team: { id: 3, name: "Acme", source: "SELF", status: "ACTIVE" },
            },
            {
              role: "MEMBER",
              status: "ACTIVE",
              team: { id: 4, name: "旧团队", source: "SELF", status: "ARCHIVED" },
            },
          ],
        }),
      ])
      prisma.user.count.mockResolvedValue(1)
      prisma.creditLot.groupBy.mockResolvedValue([
        { userId: 1, _sum: { remaining: new Decimal(1250) } },
      ])

      const res = await service.list({ page: 1, pageSize: 10 })

      const item = res.items[0]
      expect(item.phone).toBe("138****1234") // 脱敏
      expect(item.level).toBe("LV2")
      expect(item.subscriptionTier).toBe(2)
      expect(item.invitedBy).toEqual({ id: 9, username: "王老板" })
      // 只取占用中（ACTIVE/GRACE）企业，ARCHIVED 不算归属；带成员角色/状态
      expect(item.team).toEqual({
        id: 3,
        name: "Acme",
        source: "SELF",
        role: "ADMIN",
        memberStatus: "ACTIVE",
      })
      expect(item.points).toBe("1250")
    })

    it("停用（DISABLED）成员仍返回企业归属并标 memberStatus=DISABLED（不回落个人计费）", async () => {
      prisma.user.findMany.mockResolvedValue([
        userRow({
          membershipLevel: "NONE",
          subscriptionTier: null,
          teamMemberships: [
            {
              role: "MEMBER",
              status: "DISABLED",
              team: { id: 3, name: "Acme", source: "SELF", status: "ACTIVE" },
            },
          ],
        }),
      ])
      prisma.user.count.mockResolvedValue(1)

      const res = await service.list({ page: 1, pageSize: 10 })

      expect(res.items[0].team).toEqual({
        id: 3,
        name: "Acme",
        source: "SELF",
        role: "MEMBER",
        memberStatus: "DISABLED",
      })
      expect(res.items[0].level).toBe("NONE")
    })

    it("hasTeam 筛选：true=占用中企业归属（含停用成员）；false=纯个人计费", async () => {
      prisma.user.findMany.mockResolvedValue([])
      prisma.user.count.mockResolvedValue(0)

      await service.list({ page: 1, pageSize: 10, hasTeam: "true" })
      const where1 = (
        prisma.user.findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>
      )[0][0].where
      expect(where1.teamMemberships).toEqual({
        some: {
          status: { in: ["ACTIVE", "DISABLED"] },
          team: { status: { in: ["ACTIVE", "GRACE"] } },
        },
      })

      await service.list({ page: 1, pageSize: 10, hasTeam: "false" })
      const where2 = (
        prisma.user.findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>
      )[1][0].where
      expect(where2.teamMemberships).toEqual({
        none: {
          status: { in: ["ACTIVE", "DISABLED"] },
          team: { status: { in: ["ACTIVE", "GRACE"] } },
        },
      })
    })

    it("canInvite 筛选：true=分销代理（可邀请计酬）；false=未开启", async () => {
      prisma.user.findMany.mockResolvedValue([])
      prisma.user.count.mockResolvedValue(0)

      await service.list({ page: 1, pageSize: 10, canInvite: "true" })
      const where1 = (
        prisma.user.findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>
      )[0][0].where
      expect(where1.canInvite).toBe(true)

      await service.list({ page: 1, pageSize: 10, canInvite: "false" })
      const where2 = (
        prisma.user.findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>
      )[1][0].where
      expect(where2.canInvite).toBe(false)
    })

    it("level=TEAM / invited / teamId 筛选写入 where", async () => {
      prisma.user.findMany.mockResolvedValue([])
      prisma.user.count.mockResolvedValue(0)

      await service.list({ page: 1, pageSize: 10, level: "TEAM", invited: "true", teamId: 3 })

      const where = (
        prisma.user.findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>
      )[0][0].where
      expect(where.teamMemberships).toBeDefined()
      expect(where.invitedById).toEqual({ not: null })

      await service.list({ page: 1, pageSize: 10, level: "LV2", invited: "false" })
      const where2 = (
        prisma.user.findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>
      )[1][0].where
      expect(where2.subscriptionTier).toBe(2)
      expect(where2.invitedById).toBeNull()
    })

    it("level=NONE 按 subscriptionTier=null 筛选", async () => {
      prisma.user.findMany.mockResolvedValue([])
      prisma.user.count.mockResolvedValue(0)
      await service.list({ page: 1, pageSize: 10, level: "NONE" })
      const where = (
        prisma.user.findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>
      )[0][0].where
      expect(where.subscriptionTier).toBeNull()
    })
  })

  describe("getFullPhone（全号查看 + 审计）", () => {
    it("返回全号并写 History 审计（操作人=userId，目标在 data）", async () => {
      prisma.user.findUnique.mockResolvedValue({ phone: "13800001234" })

      const res = await service.getFullPhone(1, 99)

      expect(res.phone).toBe("13800001234")
      const arg = (
        prisma.history.create.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>
      )[0][0]
      expect(arg.data).toMatchObject({
        type: "ADMIN_ACTION",
        userId: 99,
        data: { action: "user.phone.view", targetUserId: 1, operatorId: 99 },
      })
    })

    it("用户不存在抛 NotFoundException", async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      await expect(service.getFullPhone(1, 99)).rejects.toThrow(NotFoundException)
      expect(prisma.history.create).not.toHaveBeenCalled()
    })
  })

  describe("getUser（详情同样脱敏 + 余额）", () => {
    it("返回脱敏手机号与剩余积分", async () => {
      prisma.user.findUnique.mockResolvedValue(userRow())
      credit.getConsumableBalance.mockResolvedValue(new Decimal(88))

      const res = await service.getUser(1)

      expect(res.phone).toBe("138****1234")
      expect(res.points).toBe("88")
    })
  })
})
