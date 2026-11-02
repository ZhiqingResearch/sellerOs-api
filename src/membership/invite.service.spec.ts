import { ConflictException, NotFoundException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import {
  CreditBucket,
  CreditTxnType,
  InviteAppStatus,
  MembershipLevel,
  Prisma,
} from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { MailProvider } from "../common/providers/mail.provider"
import { DefaultMemberRoleService } from "../common/services/default-member-role.service"
import { PrismaService } from "../prisma/prisma.service"
import { AdminDistService } from "./admin-dist.service"
import { CreditService } from "./credit.service"
import { InviteService } from "./invite.service"
import { WalletService } from "./wallet.service"

interface UserCreateArg {
  data: {
    username: string
    invitedById: number
    email?: string
    membershipLevel: MembershipLevel
    discount: Decimal
    balance: number
  }
}
interface UserUpdateArg {
  data: { canInvite?: boolean; membershipLevel?: MembershipLevel; inviteCode?: string | null }
}

/** jest.Mock 的 calls 为 any；提取第 n 次调用实参并显式收窄类型后断言 */
const callArgs = <T extends unknown[]>(mock: jest.Mock, call: number): T => {
  const calls = mock.mock.calls as unknown[][]
  return calls[call] as T
}

describe("InviteService", () => {
  let service: InviteService
  let prisma: {
    user: {
      findUnique: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
      create: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
    }
    emailCode: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock; updateMany: jest.Mock }
    inviteApplication: {
      findFirst: jest.Mock
      findUnique: jest.Mock
      findMany: jest.Mock
      create: jest.Mock
      update: jest.Mock
      updateMany: jest.Mock
      count: jest.Mock
    }
    creditTransaction: {
      aggregate: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
      groupBy: jest.Mock
    }
    creditLot: { aggregate: jest.Mock; groupBy: jest.Mock }
    roleModel: { findUnique: jest.Mock }
    userRole: { createMany: jest.Mock; findMany: jest.Mock; upsert: jest.Mock }
    userOrganization: { createMany: jest.Mock }
    $transaction: jest.Mock
    $queryRaw: jest.Mock
  }
  let credit: { clearGrantedCredits: jest.Mock; grant: jest.Mock; withdrawRebate: jest.Mock }
  let mail: { sendVerificationCode: jest.Mock }
  let wallet: { listTransactions: jest.Mock }
  let config: { get: jest.Mock }
  let adminDist: { getTree: jest.Mock }

  const future = () => new Date(Date.now() + 3600_000)
  const past = () => new Date(Date.now() - 3600_000)

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      emailCode: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inviteApplication: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
      creditTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal(0) } }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      creditLot: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { remaining: new Decimal(0) } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      roleModel: { findUnique: jest.fn().mockResolvedValue({ id: 11 }) },
      userRole: {
        upsert: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]), // 全量角色选项（listInvitees roleOptions）
      },
      userOrganization: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([]),
    }
    prisma.$transaction.mockImplementation((arg: unknown) =>
      // 数组形态（批量 Promise）与回调形态都支持（sendEmailCode 作废旧码走数组形态）
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma)
    )

    credit = {
      clearGrantedCredits: jest.fn().mockResolvedValue(0),
      grant: jest.fn().mockResolvedValue({ id: 1 }),
      withdrawRebate: jest
        .fn()
        .mockResolvedValue({ withdrawn: new Decimal(100), balanceAfter: new Decimal(0) }),
    }
    mail = { sendVerificationCode: jest.fn().mockResolvedValue(undefined) }
    wallet = { listTransactions: jest.fn().mockResolvedValue({ items: [], total: 0 }) }
    config = {
      get: jest.fn((key: string) => (key === "DEFAULT_MEMBER_ROLE_ID" ? "11" : "Default@123")),
    }
    adminDist = { getTree: jest.fn().mockResolvedValue({ user: { id: 1 }, level1: [] }) }

    const moduleRef = await Test.createTestingModule({
      providers: [
        InviteService,
        DefaultMemberRoleService,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: credit },
        { provide: MailProvider, useValue: mail },
        { provide: WalletService, useValue: wallet },
        { provide: ConfigService, useValue: config },
        { provide: AdminDistService, useValue: adminDist },
      ],
    }).compile()
    service = moduleRef.get(InviteService)
  })

  describe("verifyInviteCode", () => {
    it("有效邀请码返回邀请人", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        username: "inv",
        canInvite: true,
        isActive: true,
        inviteCodeExpiresAt: future(),
      })
      const res = await service.verifyInviteCode("OS1234")
      expect(res).toEqual({ valid: true, inviterId: 1, inviterName: "inv" })
    })

    it("过期邀请码 → 无效链接", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        username: "inv",
        canInvite: true,
        isActive: true,
        inviteCodeExpiresAt: past(),
      })
      await expect(service.verifyInviteCode("OS1234")).rejects.toThrow("无效链接")
    })

    it("邀请人账号已停用 → 旧邀请码立即失效（无效链接）", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        username: "inv",
        canInvite: true,
        isActive: false, // 平台停用：公开校验直接拦截
        inviteCodeExpiresAt: future(),
      })
      await expect(service.verifyInviteCode("OS1234")).rejects.toThrow("无效链接")
    })

    it("邀请名额已用尽 → 入口即拦截（不再产生批不掉的死单）", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        username: "inv",
        canInvite: true,
        isActive: true,
        inviteQuota: 2,
        inviteCodeExpiresAt: future(),
      })
      prisma.user.count.mockResolvedValue(2) // 已建号 2/2，含自助注册
      await expect(service.verifyInviteCode("OS1234")).rejects.toThrow("名额已用完")
    })
  })

  describe("registrationInviteData", () => {
    const inviter = () => ({
      id: 7,
      username: "邀请人",
      canInvite: true,
      isActive: true,
      inviteCodeExpiresAt: future(),
      inviteQuota: 2,
      discount: new Decimal("0.8"),
      subInviteAllowed: false,
    })

    it("先锁邀请人，再校验实际已建号人数，只返回邀请关系和折扣", async () => {
      prisma.user.findUnique.mockResolvedValue(inviter())
      prisma.user.count.mockResolvedValue(1)
      const data = await service.registrationInviteData(
        prisma as unknown as Prisma.TransactionClient,
        "OS1234"
      )
      expect(data).toEqual({ invitedById: 7, discount: new Decimal("0.8") })
      const [query, code] = callArgs<[TemplateStringsArray, string]>(prisma.$queryRaw, 0)
      expect(query.join("?")).toBe("SELECT id FROM `User` WHERE inviteCode = ? FOR UPDATE")
      expect(code).toBe("OS1234")
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.user.findUnique.mock.invocationCallOrder[0]
      )
      expect(prisma.user.count).toHaveBeenCalledWith({ where: { invitedById: 7 } })
      expect(prisma.inviteApplication.count).not.toHaveBeenCalled()
      expect(prisma.userOrganization.createMany).not.toHaveBeenCalled()
    })

    it("下级可继续邀请开启时，赋予邀请权及7天邀请码", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ ...inviter(), subInviteAllowed: true })
        .mockResolvedValueOnce(null)
      const data = await service.registrationInviteData(
        prisma as unknown as Prisma.TransactionClient,
        "OS1234"
      )
      expect(data).toMatchObject({
        invitedById: 7,
        canInvite: true,
        inviteCode: expect.stringMatching(/^OS[A-Z2-9]{4}$/) as string,
        inviteCodeExpiresAt: expect.any(Date) as Date,
      })
      expect(data.inviteCodeExpiresAt!.getTime() - Date.now()).toBeGreaterThan(7 * 86400000 - 5000)
    })

    it.each([
      null,
      { canInvite: false },
      { isActive: false },
      { inviteCodeExpiresAt: new Date(0) },
    ])("无效邀请人 %j 不允许绑定", async invalid => {
      prisma.user.findUnique.mockResolvedValue(
        invalid === null ? null : { ...inviter(), ...invalid }
      )
      await expect(
        service.registrationInviteData(prisma as unknown as Prisma.TransactionClient, "OS1234")
      ).rejects.toThrow("无效链接")
    })

    it("实际建号已满时拦截，即使没有审核通过的申请记录", async () => {
      prisma.user.findUnique.mockResolvedValue(inviter())
      prisma.user.count.mockResolvedValue(2)
      await expect(
        service.registrationInviteData(prisma as unknown as Prisma.TransactionClient, "OS1234")
      ).rejects.toThrow("名额已用完")
      expect(prisma.inviteApplication.count).not.toHaveBeenCalled()
    })
  })

  describe("register", () => {
    const validInviter = {
      id: 1,
      username: "inv",
      canInvite: true,
      isActive: true,
      inviteCodeExpiresAt: future(),
    }
    const dto = {
      inviteCode: "OS1234",
      username: "张三",
      email: "buyer@example.com",
      phone: "18800000000",
      emailCode: "123456",
      password: "secret123",
    }

    it("校验通过 → 建 PENDING 申请（含用户名）", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(validInviter).mockResolvedValueOnce(null) // inviter, phone free
      prisma.emailCode.findFirst.mockResolvedValue({ id: 9, code: "123456", attempts: 0 })
      prisma.inviteApplication.findFirst.mockResolvedValue(null)
      prisma.inviteApplication.create.mockResolvedValue({ id: 99, status: InviteAppStatus.PENDING })

      const res = await service.register(dto)
      expect(res.applicationId).toBe(99)
      expect(prisma.emailCode.updateMany).toHaveBeenCalledWith({
        where: { id: 9, used: false },
        data: { used: true },
      }) // 验证码原子标记已用
      const createArg = (
        prisma.inviteApplication.create.mock.calls as unknown as Array<
          [{ data: { username: string } }]
        >
      )[0][0]
      expect(createArg.data.username).toBe("张三")
    })

    it("手机号已注册 → 409", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(validInviter).mockResolvedValueOnce({ id: 7 })
      prisma.emailCode.findFirst.mockResolvedValue({ id: 9, code: "123456", attempts: 0 })
      await expect(service.register(dto)).rejects.toBeInstanceOf(ConflictException)
    })

    it("资料校验失败不消费验证码（2026-08-31 bug12）：手机号已注册 → 409 且不触碰 emailCode", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(validInviter).mockResolvedValueOnce({ id: 7 })
      await expect(service.register(dto)).rejects.toBeInstanceOf(ConflictException)
      // 可恢复的资料校验在核销验证码之前：用户改资料后可用原码重试
      expect(prisma.emailCode.findFirst).not.toHaveBeenCalled()
      expect(prisma.emailCode.updateMany).not.toHaveBeenCalled()
    })

    it("待审占用/重复申请同样不消费验证码（bug12）", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(validInviter).mockResolvedValueOnce(null)
      prisma.inviteApplication.findFirst.mockResolvedValueOnce({ id: 5 }) // 手机号已被待审申请占用
      await expect(service.register(dto)).rejects.toThrow("已提交注册申请")
      expect(prisma.emailCode.findFirst).not.toHaveBeenCalled()

      prisma.user.findUnique.mockResolvedValueOnce(validInviter).mockResolvedValueOnce(null)
      prisma.inviteApplication.findFirst
        .mockResolvedValueOnce(null) // 手机号无占用
        .mockResolvedValueOnce({ id: 6 }) // 重复待审申请（同邀请人同邮箱）
      await expect(service.register(dto)).rejects.toThrow("已提交申请")
      expect(prisma.emailCode.findFirst).not.toHaveBeenCalled()
    })

    it("手机号已被待审申请占用 → 409（全局唯一）", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(validInviter).mockResolvedValueOnce(null) // inviter, 无正式账号
      prisma.emailCode.findFirst.mockResolvedValue({ id: 9, code: "123456", attempts: 0 })
      prisma.inviteApplication.findFirst.mockResolvedValueOnce({ id: 5 }) // 已有 PENDING 占用该手机号
      await expect(service.register(dto)).rejects.toThrow("已提交注册申请")
    })

    it("并发竞态：findFirst 漏过、insert 撞 pendingPhone 唯一约束(P2002) → 409", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(validInviter).mockResolvedValueOnce(null)
      prisma.emailCode.findFirst.mockResolvedValue({ id: 9, code: "123456", attempts: 0 })
      prisma.inviteApplication.findFirst.mockResolvedValue(null) // 预检漏过
      prisma.inviteApplication.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "6",
        })
      )
      await expect(service.register(dto)).rejects.toThrow("已提交注册申请")
    })

    it("邮箱验证码错误 → 400 并记一次失败；连续 5 次失败作废当前码", async () => {
      // 新顺序（bug12）：先资料校验（邀请人→手机号无占用→无待审），再核销验证码；两次调用各自的查询序列
      prisma.user.findUnique
        .mockResolvedValueOnce(validInviter) // 第 1 次：邀请人
        .mockResolvedValueOnce(null) // 第 1 次：手机号无占用
        .mockResolvedValueOnce(validInviter) // 第 2 次：邀请人
        .mockResolvedValue(null) // 第 2 次起：手机号无占用
      // 第 4 次失败：只计数，不作废
      prisma.emailCode.findFirst.mockResolvedValue({ id: 9, code: "999999", attempts: 3 })
      await expect(service.register(dto)).rejects.toThrow("验证码")
      expect(prisma.emailCode.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { attempts: 4, used: false },
      })
      // 第 5 次失败：作废
      prisma.emailCode.findFirst.mockResolvedValue({ id: 9, code: "999999", attempts: 4 })
      await expect(service.register(dto)).rejects.toThrow("验证码")
      expect(prisma.emailCode.update).toHaveBeenLastCalledWith({
        where: { id: 9 },
        data: { attempts: 5, used: true },
      })
    })

    it("并发下同一张码只会核销成功一次（updateMany 占位失败 → 400）", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(validInviter).mockResolvedValue(null)
      prisma.emailCode.findFirst.mockResolvedValue({ id: 9, code: "123456", attempts: 0 })
      prisma.emailCode.updateMany.mockResolvedValue({ count: 0 }) // 已被并发请求先用掉
      await expect(service.register(dto)).rejects.toThrow("验证码")
    })

    it("邮箱验证码不存在或已过期 → 400", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(validInviter)
      prisma.emailCode.findFirst.mockResolvedValue(null)
      await expect(service.register(dto)).rejects.toThrow("验证码")
    })
  })

  describe("refreshCode 并发安全（2026-08-31 bug11）", () => {
    it("正常刷新：条件更新以旧码占位，返回新码与有效期", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1, canInvite: true, invitedBy: null }) // requireInviter
        .mockResolvedValueOnce({ inviteCode: "OSOLD1", inviteCodeExpiresAt: future() }) // 当前码
        .mockResolvedValueOnce(null) // generateUniqueCode 唯一性校验
      const res = await service.refreshCode(1)
      expect(res.inviteCode).toMatch(/^OS/)
      expect(res.inviteCode).not.toBe("OSOLD1")
      const arg = prisma.user.updateMany.mock.calls as unknown as Array<
        [{ where: { id: number; inviteCode: string | null } }]
      >
      expect(arg[0][0].where).toEqual({ id: 1, inviteCode: "OSOLD1" }) // 占位条件=读到的旧值
    })

    it("并发被抢先（占位 count=0）→ 重读返回最新有效码：所有成功响应的码=最终有效码", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1, canInvite: true, invitedBy: null }) // requireInviter
        .mockResolvedValueOnce({ inviteCode: "OSOLD1", inviteCodeExpiresAt: future() }) // 当前码
        .mockResolvedValueOnce(null) // generateUniqueCode
        .mockResolvedValueOnce({ inviteCode: "OSWIN1", inviteCodeExpiresAt: future() }) // 重读：并发写入已生效
      prisma.user.updateMany.mockResolvedValue({ count: 0 }) // 被抢先
      const res = await service.refreshCode(1)
      expect(res.inviteCode).toBe("OSWIN1") // 返回最终有效码，不是本请求生成的孤儿码
    })

    it("占位失败且重读码已失效 → 下轮重试生成并落新码", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1, canInvite: true, invitedBy: null }) // requireInviter
        .mockResolvedValueOnce({ inviteCode: "OSOLD1", inviteCodeExpiresAt: future() })
        .mockResolvedValueOnce(null) // generateUniqueCode #1
        .mockResolvedValueOnce({ inviteCode: "OSGONE", inviteCodeExpiresAt: past() }) // 重读：已失效
        .mockResolvedValueOnce({ inviteCode: "OSGONE", inviteCodeExpiresAt: past() }) // 第 2 轮当前码
        .mockResolvedValueOnce(null) // generateUniqueCode #2
      prisma.user.updateMany
        .mockResolvedValueOnce({ count: 0 }) // 第 1 轮被抢先
        .mockResolvedValueOnce({ count: 1 }) // 第 2 轮占位成功
      const res = await service.refreshCode(1)
      expect(res.inviteCode).toMatch(/^OS/)
      expect(res.inviteCode).not.toBe("OSGONE")
      expect(prisma.user.updateMany).toHaveBeenCalledTimes(2)
    })
  })

  describe("approve", () => {
    const pendingApp = {
      id: 99,
      inviterId: 1,
      status: InviteAppStatus.PENDING,
      username: "张三",
      email: "buyer@example.com",
      phone: "18800000000",
      passwordHash: "hash",
    }

    it("建普通用户账号（不写等级）+ 邮箱入库 + 继承折扣 + 200 赠送积分", async () => {
      prisma.inviteApplication.findFirst.mockResolvedValue(pendingApp)
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // phone free
        .mockResolvedValueOnce({
          canInvite: true,
          discount: new Decimal("0.8"),
          inviteQuota: null,
          roles: [],
          orgs: [],
        }) // inviter
      prisma.user.create.mockResolvedValue({ id: 50 })

      const res = await service.approve(99, 1)

      expect(res.userId).toBe(50)
      // 名额并发锁：事务内 FOR UPDATE 锁邀请人行
      expect(prisma.$queryRaw).toHaveBeenCalled()
      const createArg = (prisma.user.create.mock.calls as unknown as Array<[UserCreateArg]>)[0][0]
      expect(createArg.data.username).toBe("张三") // 用注册时填的称谓
      expect(createArg.data.invitedById).toBe(1)
      expect(createArg.data.email).toBe("buyer@example.com") // 注册验证过的邮箱入库（到期提醒/收据邮箱用）
      expect(createArg.data.membershipLevel).toBeUndefined() // 普通用户（LV4 已取消）
      expect(createArg.data.discount.toString()).toBe("0.8")
      expect(createArg.data.balance).toBe(0)
      expect(credit.grant).toHaveBeenCalledWith(
        50,
        CreditBucket.GIFT,
        200,
        expect.objectContaining({
          type: CreditTxnType.SIGNUP_BONUS,
          expiresAt: expect.any(Date) as Date,
        }),
        prisma
      )
      const appClaim = (
        prisma.inviteApplication.updateMany.mock.calls as unknown as Array<
          [{ where: { id: number; status: InviteAppStatus }; data: { status: InviteAppStatus } }]
        >
      )[0][0]
      expect(appClaim.where).toEqual({ id: 99, status: InviteAppStatus.PENDING }) // 原子认领
      expect(appClaim.data.status).toBe(InviteAppStatus.APPROVED)
    })

    it("并发双通过：原子认领失败（count=0）→ 400 已处理，不建账号不发积分", async () => {
      prisma.inviteApplication.findFirst.mockResolvedValue(pendingApp) // 快照读仍是 PENDING
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // phone free
        .mockResolvedValueOnce({
          canInvite: true,
          discount: new Decimal("0.8"),
          inviteQuota: null,
          roles: [],
          orgs: [],
        })
      prisma.inviteApplication.updateMany.mockResolvedValue({ count: 0 }) // 已被并发请求认领

      await expect(service.approve(99, 1)).rejects.toThrow("该申请已处理")
      expect(prisma.user.create).not.toHaveBeenCalled()
      expect(credit.grant).not.toHaveBeenCalled()
    })

    it("建号撞手机号唯一约束（P2002）→ 409 而非 500", async () => {
      prisma.inviteApplication.findFirst.mockResolvedValue(pendingApp)
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // phone free（快检漏过的竞态）
        .mockResolvedValueOnce({
          canInvite: true,
          discount: new Decimal("0.8"),
          inviteQuota: null,
          roles: [],
          orgs: [],
        })
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "6",
        })
      )
      await expect(service.approve(99, 1)).rejects.toBeInstanceOf(ConflictException)
    })

    it("邀请名额已用完 → 400，不建账号", async () => {
      prisma.inviteApplication.findFirst.mockResolvedValue(pendingApp)
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // phone free
        .mockResolvedValueOnce({
          canInvite: true,
          discount: new Decimal("0.8"),
          inviteQuota: 5,
          roles: [],
          orgs: [],
        })
      prisma.user.count.mockResolvedValue(5) // 已建号 5/5，不含尚未建号的本次申请

      await expect(service.approve(99, 1)).rejects.toThrow("名额已用完")
      expect(prisma.user.create).not.toHaveBeenCalled()
    })

    it("旧审批在实际已用人数小于上限时允许占最后一个名额", async () => {
      prisma.inviteApplication.findFirst.mockResolvedValue(pendingApp)
      prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
        canInvite: true,
        discount: new Decimal("0.8"),
        inviteQuota: 5,
        orgs: [],
      })
      prisma.user.count.mockResolvedValue(4)
      prisma.user.create.mockResolvedValue({ id: 50 })
      await expect(service.approve(99, 1)).resolves.toMatchObject({ userId: 50 })
      expect(prisma.user.count).toHaveBeenCalledWith({ where: { invitedById: 1 } })
      expect(prisma.inviteApplication.count).not.toHaveBeenCalled()
    })

    it("邀请人已被关闭邀请权限 → 403，不建账号", async () => {
      prisma.inviteApplication.findFirst.mockResolvedValue(pendingApp)
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // phone free
        .mockResolvedValueOnce({
          canInvite: false,
          discount: new Decimal("0.8"),
          inviteQuota: null,
          roles: [],
          orgs: [],
        })

      await expect(service.approve(99, 1)).rejects.toThrow("未开启邀请权限")
      expect(prisma.user.create).not.toHaveBeenCalled()
    })

    it("不继承邀请人的角色，只绑定默认角色，仍继承组织", async () => {
      prisma.inviteApplication.findFirst.mockResolvedValue(pendingApp)
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // phone free
        .mockResolvedValueOnce({
          canInvite: true,
          discount: new Decimal("0.8"),
          roles: [
            { roleId: 1, role: { code: "ADMIN" } },
            { roleId: 3, role: { code: "USER" } },
            { roleId: 5, role: { code: "operator" } },
          ],
          orgs: [{ orgId: 9 }],
        })
      prisma.user.create.mockResolvedValue({ id: 50 })

      await service.approve(99, 1)

      expect(prisma.userRole.createMany).not.toHaveBeenCalled()
      expect(prisma.userRole.upsert).toHaveBeenCalledTimes(1)
      expect(prisma.userRole.upsert).toHaveBeenCalledWith({
        where: { userId_roleId: { userId: 50, roleId: 11 } },
        create: { userId: 50, roleId: 11 },
        update: {},
      })
      expect(prisma.userOrganization.createMany).toHaveBeenCalledWith({
        data: [{ userId: 50, orgId: 9 }],
      })
    })

    it("邀请人只有 ADMIN 角色时：仍只绑定默认角色并继承组织", async () => {
      prisma.inviteApplication.findFirst.mockResolvedValue(pendingApp)
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // phone free
        .mockResolvedValueOnce({
          canInvite: true,
          discount: new Decimal("0.8"),
          roles: [{ roleId: 1, role: { code: "ADMIN" } }],
          orgs: [{ orgId: 9 }],
        })
      prisma.user.create.mockResolvedValue({ id: 50 })

      await service.approve(99, 1)

      expect(prisma.userRole.createMany).not.toHaveBeenCalled()
      expect(prisma.userRole.upsert).toHaveBeenCalledWith({
        where: { userId_roleId: { userId: 50, roleId: 11 } },
        create: { userId: 50, roleId: 11 },
        update: {},
      })
      expect(prisma.userOrganization.createMany).toHaveBeenCalledWith({
        data: [{ userId: 50, orgId: 9 }],
      })
    })

    it.each(["配置缺失", "角色不存在", "角色绑定失败"])(
      "%s 时审批事务失败，不发积分",
      async failure => {
        prisma.inviteApplication.findFirst.mockResolvedValue(pendingApp)
        prisma.user.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ canInvite: true, discount: new Decimal(1), orgs: [] })
        prisma.user.create.mockResolvedValue({ id: 50 })
        if (failure === "配置缺失") config.get.mockReturnValue("")
        if (failure === "角色不存在") prisma.roleModel.findUnique.mockResolvedValue(null)
        if (failure === "角色绑定失败")
          prisma.userRole.upsert.mockRejectedValue(new Error("角色绑定失败"))

        await expect(service.approve(99, 1)).rejects.toThrow()
        expect(prisma.$transaction).toHaveBeenCalledTimes(1)
        expect(credit.grant).not.toHaveBeenCalled()
      }
    )

    it("已处理的申请 → 400", async () => {
      prisma.inviteApplication.findFirst.mockResolvedValue({
        id: 99,
        inviterId: 1,
        status: InviteAppStatus.APPROVED,
      })
      await expect(service.approve(99, 1)).rejects.toThrow("已处理")
    })
  })

  describe("reject", () => {
    it("拒绝成功：原子认领流转 + 释放 pendingPhone 占用", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, canInvite: true }) // requireInviter
      prisma.inviteApplication.findFirst.mockResolvedValue({
        id: 99,
        inviterId: 1,
        status: InviteAppStatus.PENDING,
      })
      const res = await service.reject(99, 1)
      expect(res.status).toBe(InviteAppStatus.REJECTED)
      const arg = (
        prisma.inviteApplication.updateMany.mock.calls as unknown as Array<
          [
            {
              where: { id: number; inviterId: number; status: InviteAppStatus }
              data: { status: InviteAppStatus; pendingPhone: null }
            },
          ]
        >
      )[0][0]
      expect(arg.where).toEqual({ id: 99, inviterId: 1, status: InviteAppStatus.PENDING })
      expect(arg.data.status).toBe(InviteAppStatus.REJECTED)
      expect(arg.data.pendingPhone).toBeNull()
    })

    it("与 approve 并发落败（认领 count=0）→ 400 该申请已处理", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, canInvite: true })
      prisma.inviteApplication.findFirst.mockResolvedValue({
        id: 99,
        inviterId: 1,
        status: InviteAppStatus.PENDING,
      })
      prisma.inviteApplication.updateMany.mockResolvedValue({ count: 0 })
      await expect(service.reject(99, 1)).rejects.toThrow("该申请已处理")
    })

    it("邀请人已被关闭邀请权限 → 403", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, canInvite: false })
      await expect(service.reject(99, 1)).rejects.toThrow("未开启邀请权限")
      expect(prisma.inviteApplication.updateMany).not.toHaveBeenCalled()
    })
  })

  // ==================== 运营代审（admin/dist/applications，2026-08-31） ====================

  describe("listApplicationsAdmin（运营侧申请队列）", () => {
    it("状态/关键词过滤 + 分页 + 申请人手机号脱敏", async () => {
      prisma.inviteApplication.findMany.mockResolvedValue([
        {
          id: 99,
          status: InviteAppStatus.PENDING,
          username: "张三",
          email: "buyer@example.com",
          phone: "18800000000",
          createdAt: new Date(),
          reviewedAt: null,
          inviter: { id: 7, username: "吴君如" },
        },
      ])
      prisma.inviteApplication.count.mockResolvedValue(21)

      const res = await service.listApplicationsAdmin({
        page: 2,
        pageSize: 10,
        status: InviteAppStatus.PENDING,
        keyword: "吴君如",
      })

      expect(res.total).toBe(21)
      expect(res.totalPages).toBe(3)
      expect(res.items[0].phone).toBe("188****0000") // 脱敏
      expect(res.items[0].inviter).toEqual({ id: 7, username: "吴君如" })
      const [args] = callArgs<
        [
          {
            where: {
              status: InviteAppStatus
              OR: Array<Record<string, unknown>>
            }
            skip: number
          },
        ]
      >(prisma.inviteApplication.findMany, 0)
      expect(args.where.status).toBe(InviteAppStatus.PENDING)
      expect(args.where.OR).toHaveLength(4) // 申请人用户名/邮箱/手机号 + 邀请人用户名
      expect(args.skip).toBe(10)
    })

    it("默认全部状态（不传 status 不加过滤）", async () => {
      await service.listApplicationsAdmin({ page: 1, pageSize: 10 })
      const [args] = callArgs<[{ where: Record<string, unknown> }]>(
        prisma.inviteApplication.findMany,
        0
      )
      expect(args.where.status).toBeUndefined()
    })
  })

  describe("approveByAdmin / rejectByAdmin（运营代审）", () => {
    const pendingApp = {
      id: 99,
      inviterId: 7, // 别人的申请：运营代审不限归属
      status: InviteAppStatus.PENDING,
      username: "张三",
      email: "buyer@example.com",
      phone: "18800000000",
      passwordHash: "hash",
    }

    it("代审批通过：与邀请人自审同口径（原子认领 + 建号 invitedById=申请邀请人 + 200 赠送）", async () => {
      prisma.inviteApplication.findUnique.mockResolvedValue(pendingApp)
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // phone free
        .mockResolvedValueOnce({
          canInvite: true,
          discount: new Decimal("0.8"),
          inviteQuota: null,
          invitedBy: null,
          roles: [],
          orgs: [],
        }) // 邀请人
      prisma.user.create.mockResolvedValue({ id: 50 })

      const res = await service.approveByAdmin(99)

      expect(res).toEqual({ userId: 50, status: InviteAppStatus.APPROVED })
      const createArg = (prisma.user.create.mock.calls as unknown as Array<[UserCreateArg]>)[0][0]
      expect(createArg.data.invitedById).toBe(7) // 归申请上的邀请人，不是操作人
      expect(credit.grant).toHaveBeenCalledWith(
        50,
        CreditBucket.GIFT,
        200,
        expect.objectContaining({ type: CreditTxnType.SIGNUP_BONUS }),
        prisma
      )
    })

    it("邀请人已被关闭邀请权限 → 403，存量申请不放行（与自审同口径）", async () => {
      prisma.inviteApplication.findUnique.mockResolvedValue(pendingApp)
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // phone free
        .mockResolvedValueOnce({ canInvite: false, invitedBy: null }) // 邀请人已关闭
      await expect(service.approveByAdmin(99)).rejects.toThrow("未开启邀请权限")
      expect(prisma.user.create).not.toHaveBeenCalled()
    })

    it("申请不存在 → 404；已处理 → 400", async () => {
      prisma.inviteApplication.findUnique.mockResolvedValue(null)
      await expect(service.approveByAdmin(99)).rejects.toThrow(NotFoundException)
      prisma.inviteApplication.findUnique.mockResolvedValue({
        ...pendingApp,
        status: InviteAppStatus.APPROVED,
      })
      await expect(service.approveByAdmin(99)).rejects.toThrow("该申请已处理")
    })

    it("代驳回：不卡邀请人权限，原子认领 PENDING；并发落败 → 400", async () => {
      prisma.inviteApplication.findUnique.mockResolvedValue(pendingApp)
      const res = await service.rejectByAdmin(99)
      expect(res.status).toBe(InviteAppStatus.REJECTED)
      const [args] = callArgs<
        [{ where: { id: number; status: InviteAppStatus }; data: { pendingPhone: null } }]
      >(prisma.inviteApplication.updateMany, 0)
      expect(args.where).toEqual({ id: 99, status: InviteAppStatus.PENDING }) // 无 inviterId 归属条件
      expect(args.data.pendingPhone).toBeNull()

      prisma.inviteApplication.updateMany.mockResolvedValue({ count: 0 })
      await expect(service.rejectByAdmin(99)).rejects.toThrow("该申请已处理")
    })
  })

  describe("setInviteConfig", () => {
    it("开启邀请 → 只发邀请码，套餐/积分/等级不动（LV5 已取消）", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 1,
          canInvite: false,
          invitedById: null,
          subscriptionTier: 2,
          inviteQuota: null,
        })
        .mockResolvedValueOnce(null) // 邀请码唯一性
        .mockResolvedValueOnce({ canInvite: true, membershipLevel: MembershipLevel.LV2 })

      await service.setInviteConfig(1, { canInvite: true })

      expect(credit.clearGrantedCredits).not.toHaveBeenCalled() // 不再清零套餐/赠送
      const updateArg = (prisma.user.update.mock.calls as unknown as Array<[UserUpdateArg]>)[0][0]
      expect(updateArg.data.canInvite).toBe(true)
      expect(updateArg.data.membershipLevel).toBeUndefined() // 等级只随订阅变化
      expect(typeof updateArg.data.inviteCode).toBe("string")
    })

    it("被邀请用户单独开通邀请权：上级双开关（canInvite+subInviteAllowed）都在 → 放行，发码 + 清人工关闭标记（2026-09-23 恢复拦截后的放行分支）", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 1,
          canInvite: false,
          invitedById: 9, // 被邀请用户
          subscriptionTier: null,
          inviteQuota: null,
          subInviteAllowed: false,
        })
        .mockResolvedValueOnce({ username: "上级分销", canInvite: true, subInviteAllowed: true }) // 邀请人
        .mockResolvedValueOnce(null) // generateUniqueCode 唯一性校验
        .mockResolvedValueOnce({ canInvite: true }) // getInviteOverview

      await service.setInviteConfig(1, { canInvite: true })

      const updateArg = (
        prisma.user.update.mock.calls as unknown as Array<
          [UserUpdateArg & { data: { canInviteManualOff?: boolean } }]
        >
      )[0][0]
      expect(updateArg.data.canInvite).toBe(true)
      expect(updateArg.data.canInviteManualOff).toBe(false) // 单人开通即清人工关闭标记
      expect(typeof updateArg.data.inviteCode).toBe("string")
    })

    it("被邀请用户单独开通邀请权：上级未开「下级可继续邀请」→ 400（2026-09-23 恢复 §4.1 拦截）", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 1,
          canInvite: false,
          invitedById: 9,
          subscriptionTier: null,
          inviteQuota: null,
          subInviteAllowed: false,
        })
        .mockResolvedValueOnce({ username: "上级分销", canInvite: true, subInviteAllowed: false })

      await expect(service.setInviteConfig(1, { canInvite: true })).rejects.toThrow(
        "该用户由 上级分销 邀请注册，不能开一级分销代理；如需让他继续邀请下级，请在【客户运营·分销管理】里对 上级分销 开启「下级可继续邀请」。"
      )
      expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it("被邀请用户单独开通邀请权：上级本人邀请权已关 → 400", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 1,
          canInvite: false,
          invitedById: 9,
          subscriptionTier: null,
          inviteQuota: null,
          subInviteAllowed: false,
        })
        .mockResolvedValueOnce({ username: "上级分销", canInvite: false, subInviteAllowed: true })

      await expect(service.setInviteConfig(1, { canInvite: true })).rejects.toThrow(
        "不能开一级分销代理"
      )
      expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it("被邀请用户已开着邀请权：重复提交 canInvite=true 幂等不拦截（存量行可正常保存其它配置）", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 1,
          canInvite: true, // 已开着（存量直开数据）
          invitedById: 9,
          subscriptionTier: null,
          inviteQuota: null,
          subInviteAllowed: false,
        })
        .mockResolvedValueOnce({ canInvite: true }) // getInviteOverview

      await service.setInviteConfig(1, { canInvite: true, discount: 0.9 })

      const updateArg = (
        prisma.user.update.mock.calls as unknown as Array<
          [UserUpdateArg & { data: { discount?: number; canInvite?: boolean } }]
        >
      )[0][0]
      expect(updateArg.data.discount).toBe(0.9)
      expect(updateArg.data.canInvite).toBeUndefined() // 不重复走开启分支
      // 邀请人查询未发生（守卫只拦「关 → 开」）
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2)
    })

    it("单人关闭被邀请用户的邀请权 → 打人工关闭标记 canInviteManualOff=true（上级批量打开时跳过）", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 21,
          canInvite: true,
          invitedById: 1, // 被邀请用户
          subscriptionTier: null,
          inviteQuota: null,
          subInviteAllowed: false,
        })
        .mockResolvedValueOnce({ canInvite: false }) // getInviteOverview

      await service.setInviteConfig(21, { canInvite: false })

      const updateArg = (
        prisma.user.update.mock.calls as unknown as Array<
          [UserUpdateArg & { data: { canInviteManualOff?: boolean } }]
        >
      )[0][0]
      expect(updateArg.data.canInvite).toBe(false)
      expect(updateArg.data.canInviteManualOff).toBe(true)
      expect(updateArg.data.inviteCode).toBeNull()
    })

    it("打开「下级可继续邀请」→ 批量打开一级下级（发邀请码）；人工单独关过的跳过（2026-09-01 落库制）", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 1,
          canInvite: true,
          invitedById: null,
          subscriptionTier: 2,
          inviteQuota: null,
          subInviteAllowed: false,
        })
        .mockResolvedValueOnce(null) // generateUniqueCode（kid 21）
        .mockResolvedValueOnce(null) // generateUniqueCode（kid 22）
        .mockResolvedValueOnce({ canInvite: true }) // getInviteOverview
      // 待打开下级：只挑「未开 + 未被人工单关」的直接下级
      prisma.user.findMany.mockResolvedValueOnce([{ id: 21 }, { id: 22 }])

      await service.setInviteConfig(1, { subInviteAllowed: true })

      const findArg = (
        prisma.user.findMany.mock.calls as unknown as Array<[{ where: object }]>
      )[0][0]
      expect(findArg.where).toEqual({ invitedById: 1, canInvite: false, canInviteManualOff: false })
      const updates = prisma.user.update.mock.calls as unknown as Array<
        [
          UserUpdateArg & {
            data: { canInvite?: boolean; rebateEnabled?: boolean; inviteCode?: unknown }
          },
        ]
      >
      expect(updates).toHaveLength(3) // 本人 + 2 下级
      expect(updates[0][0].data.subInviteAllowed).toBe(true)
      expect(updates[1][0].where).toEqual({ id: 21 })
      expect(updates[1][0].data.canInvite).toBe(true)
      expect(updates[1][0].data.rebateEnabled).toBe(true) // 连带恢复返利（2026-09-03 bug31 同口径）
      expect(typeof updates[1][0].data.inviteCode).toBe("string")
      expect(updates[2][0].where).toEqual({ id: 22 })
      expect(updates[2][0].data.canInvite).toBe(true)
    })

    it("关闭「下级可继续邀请」→ 批量收回一级下级（清码+连带关返利+等级重算），不打人工标记（重开即恢复）", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 1,
          canInvite: true,
          invitedById: null,
          subscriptionTier: 2,
          inviteQuota: null,
          subInviteAllowed: true,
        })
        .mockResolvedValueOnce({ canInvite: true }) // getInviteOverview
      prisma.user.findMany.mockResolvedValueOnce([
        { id: 21, subscriptionTier: null },
        { id: 22, subscriptionTier: 3 },
      ]) // 当前开着的直接下级

      await service.setInviteConfig(1, { subInviteAllowed: false })

      const findArg = (
        prisma.user.findMany.mock.calls as unknown as Array<[{ where: object }]>
      )[0][0]
      expect(findArg.where).toEqual({ invitedById: 1, canInvite: true }) // 只收「当前开着的」
      const updates = prisma.user.update.mock.calls as unknown as Array<[UserUpdateArg]>
      expect(updates).toHaveLength(3)
      expect(updates[0][0].data.subInviteAllowed).toBe(false)
      expect(updates[1][0]).toEqual({
        where: { id: 21 },
        data: {
          canInvite: false,
          inviteCode: null,
          inviteCodeExpiresAt: null,
          rebateEnabled: false, // 连带关返利（与单人关闭同口径）
          shareCreditsWithInvitees: false, // 连带关额度共享（2026-09-02 bug28，重开不自动恢复）
          canInviteManualOff: false, // 批量收回不算人工关闭——上级重开即恢复
          membershipLevel: "NONE",
        },
      })
      expect(updates[2][0].data).toMatchObject({
        canInvite: false,
        canInviteManualOff: false,
        membershipLevel: MembershipLevel.LV3, // 等级按订阅重算
      })
    })

    it("被邀请用户不可开「下级可继续邀请」（网络两级封顶）；本人无邀请权也不可开", async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 116,
        canInvite: true,
        invitedById: 115, // 被邀请用户 → 防三级裂变
        subscriptionTier: null,
        inviteQuota: null,
        subInviteAllowed: false,
      })
      await expect(service.setInviteConfig(116, { subInviteAllowed: true })).rejects.toThrow(
        "最多两级"
      )
      expect(prisma.user.update).not.toHaveBeenCalled()

      prisma.user.findUnique.mockResolvedValueOnce({
        id: 9,
        canInvite: false, // 本人还没开邀请权
        invitedById: null,
        subscriptionTier: null,
        inviteQuota: null,
        subInviteAllowed: false,
      })
      await expect(service.setInviteConfig(9, { subInviteAllowed: true })).rejects.toThrow(
        "请先开启"
      )
    })

    it("名额边界（2026-09-02 bug29）：上限=已用允许保存（不再误报「名额已用尽」）；上限<已用才 400", async () => {
      // ① 上限 3 < 已建号 4 → 400，且不写库
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        canInvite: true,
        invitedById: null,
        subscriptionTier: null,
        inviteQuota: null,
      })
      prisma.user.count.mockResolvedValue(4)
      await expect(service.setInviteConfig(1, { inviteQuota: 3 })).rejects.toThrow(
        "邀请名额上限不能小于当前已用人数"
      )
      expect(prisma.user.update).not.toHaveBeenCalled()

      // ② 上限 3 = 已建号 3 → 保存成功（已开邀请状态下仅改配置；新增邀请由 verify/register 入口拦截）
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 1,
          canInvite: true,
          invitedById: null,
          subscriptionTier: null,
          inviteQuota: 3,
        })
        .mockResolvedValueOnce({ canInvite: true, membershipLevel: MembershipLevel.NONE }) // getInviteOverview
      prisma.user.count.mockResolvedValue(3)
      await service.setInviteConfig(1, { inviteQuota: 3 })
      const updateArg = (
        prisma.user.update.mock.calls as unknown as Array<
          [UserUpdateArg & { data: { inviteQuota?: number } }]
        >
      )[0][0]
      expect(updateArg.data.inviteQuota).toBe(3)
    })

    it("关闭邀请：清码 + 收回下级邀请 + 连带关闭「参与返利计划」（2026-08-31，原型关闭确认弹窗口径）", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 1,
          canInvite: true,
          invitedById: null,
          subscriptionTier: 1,
          inviteQuota: null,
        })
        .mockResolvedValueOnce({ canInvite: false, membershipLevel: MembershipLevel.LV1 }) // getInviteOverview

      await service.setInviteConfig(1, { canInvite: false })

      const updateArg = (
        prisma.user.update.mock.calls as unknown as Array<
          [UserUpdateArg & { data: { rebateEnabled?: boolean; subInviteAllowed?: boolean } }]
        >
      )[0][0]
      expect(updateArg.data.canInvite).toBe(false)
      expect(updateArg.data.inviteCode).toBeNull()
      expect(updateArg.data.subInviteAllowed).toBe(false)
      expect(updateArg.data.rebateEnabled).toBe(false) // 连带关闭，返利收益停止累积
    })

    it("重开邀请同步恢复 rebateEnabled（2026-09-03 bug31：撤销关闭时的连带关返利，废 8-31 手动重开口径）", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 1,
          canInvite: false,
          invitedById: null,
          subscriptionTier: null,
          inviteQuota: null,
        })
        .mockResolvedValueOnce(null) // 邀请码唯一性
        .mockResolvedValueOnce({ canInvite: true, membershipLevel: MembershipLevel.NONE })

      await service.setInviteConfig(1, { canInvite: true })

      const updateArg = (
        prisma.user.update.mock.calls as unknown as Array<
          [
            UserUpdateArg & {
              data: { rebateEnabled?: boolean; shareCreditsWithInvitees?: boolean }
            },
          ]
        >
      )[0][0]
      expect(updateArg.data.canInvite).toBe(true)
      expect(updateArg.data.rebateEnabled).toBe(true) // 同步恢复「参与返利计划」
      expect(updateArg.data.shareCreditsWithInvitees).toBeUndefined() // 额度共享不自动恢复（bug28 口径保留）
    })

    it("corpPassUpToggles：直接下级 + 占用中企业管理员 → 写其 corpPassUp", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 1,
          canInvite: true,
          invitedById: null,
          subscriptionTier: null,
          inviteQuota: null,
        })
        .mockResolvedValueOnce({ canInvite: true, membershipLevel: MembershipLevel.NONE })
      prisma.user.findMany.mockResolvedValue([
        {
          id: 21,
          username: "王强",
          invitedById: 1,
          teamMemberships: [{ team: { status: "ACTIVE" } }],
        },
      ])

      await service.setInviteConfig(1, { corpPassUpToggles: [{ userId: 21, enabled: false }] })

      const updates = prisma.user.update.mock.calls as unknown as Array<
        [{ where: { id: number }; data: { corpPassUp?: boolean } }]
      >
      expect(updates[1][0]).toEqual({ where: { id: 21 }, data: { corpPassUp: false } })
    })

    it("corpPassUpToggles：非直接下级 / 已不是占用中企业管理员 → 400 报用户名", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        canInvite: true,
        invitedById: null,
        subscriptionTier: null,
        inviteQuota: null,
      })
      // 非直接下级
      prisma.user.findMany.mockResolvedValue([
        {
          id: 22,
          username: "李婷",
          invitedById: 999,
          teamMemberships: [{ team: { status: "ACTIVE" } }],
        },
      ])
      await expect(
        service.setInviteConfig(1, { corpPassUpToggles: [{ userId: 22, enabled: true }] })
      ).rejects.toThrow("李婷")
      // 直接下级但团队已归档（非占用中）
      prisma.user.findMany.mockResolvedValue([
        {
          id: 21,
          username: "王强",
          invitedById: 1,
          teamMemberships: [{ team: { status: "ARCHIVED" } }],
        },
      ])
      await expect(
        service.setInviteConfig(1, { corpPassUpToggles: [{ userId: 21, enabled: true }] })
      ).rejects.toThrow("王强")
    })
  })

  describe("withdraw", () => {
    it("不再卡邀请权限（历史返利保留可提）→ 直接调 credit.withdrawRebate", async () => {
      // 关闭 canInvite 只停新增计佣；REBATE 桶不可消费、提现是唯一出口，锁死即永久沉淀
      const res = await service.withdraw(1, 100, "提现至支付宝")
      expect(credit.withdrawRebate).toHaveBeenCalledWith(1, 100, { note: "提现至支付宝" })
      expect(res.withdrawn).toBe("100")
    })
  })

  describe("sendEmailCode", () => {
    it("60s 内重复发 → 400 限频", async () => {
      prisma.emailCode.findFirst.mockResolvedValue({ createdAt: new Date() })
      await expect(service.sendEmailCode("a@b.com")).rejects.toThrow("频繁")
    })

    it("正常发送 → 作废旧码 + 写新码 + 发邮件", async () => {
      prisma.emailCode.findFirst.mockResolvedValue(null)
      const res = await service.sendEmailCode("a@b.com")
      expect(res).toEqual({ sent: true })
      // 重发作废：该邮箱所有未使用旧码置 used，仅最新码可核销
      expect(prisma.emailCode.updateMany).toHaveBeenCalledWith({
        where: { email: "a@b.com", used: false },
        data: { used: true },
      })
      expect(prisma.emailCode.create).toHaveBeenCalled()
      expect(mail.sendVerificationCode).toHaveBeenCalled()
    })
  })

  describe("listInvitees", () => {
    it("非邀请人 → 403", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, canInvite: false })
      await expect(service.listInvitees(1, { page: 1, pageSize: 10 })).rejects.toThrow("邀请")
    })

    it("邀请人：返回角色/总额度/已消耗/剩余/状态/贡献返利（默认已消耗倒序）", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        canInvite: true,
        shareCreditsWithInvitees: true,
      })
      prisma.user.findMany.mockResolvedValue([
        {
          id: 7,
          username: "carol",
          phone: "18000000007",
          membershipLevel: MembershipLevel.FOUNDER,
          discount: new Decimal("0.8"),
          isActive: true,
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          roles: [{ role: { code: "writer", name: "Listing写手", color: "#abc" } }],
          teamMemberships: [],
        },
        {
          id: 8,
          username: "dave",
          phone: "18000000008",
          membershipLevel: MembershipLevel.FOUNDER,
          discount: new Decimal("0.8"),
          isActive: false,
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
          roles: [],
          teamMemberships: [],
        },
      ])
      // 剩余（自己可消费余额）
      prisma.creditLot.groupBy.mockResolvedValue([
        { userId: 7, _sum: { remaining: new Decimal(640) } },
        { userId: 8, _sum: { remaining: new Decimal(430) } },
      ])
      // 三次 creditTransaction.groupBy：①自己消耗 ②动用邀请人额度的消耗 ③贡献返利
      prisma.creditTransaction.groupBy
        .mockResolvedValueOnce([
          { userId: 7, _sum: { amount: new Decimal(780) } },
          { userId: 8, _sum: { amount: new Decimal(520) } },
        ])
        .mockResolvedValueOnce([{ relatedUserId: 7, _sum: { amount: new Decimal(100) } }])
        .mockResolvedValueOnce([{ relatedUserId: 7, _sum: { amount: new Decimal(60) } }])
      // 全量角色选项（跨页去重）
      prisma.userRole.findMany.mockResolvedValue([
        { role: { code: "writer", name: "Listing写手", color: "#abc" } },
      ])

      const res = await service.listInvitees(1, { page: 1, pageSize: 10 })

      expect(res.total).toBe(2)
      expect(res.canShareFromInviter).toBe(true)
      expect(res.roleOptions).toEqual([{ code: "writer", name: "Listing写手", color: "#abc" }])
      // 默认按已消耗倒序：carol 已消耗=780(自己)+100(动用邀请人额度)=880 > dave 520
      expect(res.items[0]).toMatchObject({
        id: 7,
        level: "FOUNDER",
        isActive: true,
        phone: "180****0007", // 下级手机号默认脱敏（2026-08-31 起）
        total: "1520", // 已消耗 880 + 自己剩余 640
        consumed: "880", // 自己 780 + 动用邀请人额度 100
        remaining: "640",
        rebateContributed: "60",
      })
      expect(res.items[0].roles).toEqual([{ code: "writer", name: "Listing写手", color: "#abc" }])
      expect(res.items[1]).toMatchObject({ id: 8, isActive: false, consumed: "520" })
      // 自己消耗口径：CONSUME + TEAM_CONSUME（企业下级的企业积分消费也计入，2026-08-31 补）
      const ownArgs = (
        prisma.creditTransaction.groupBy.mock.calls as unknown as Array<
          [{ where: { type: unknown } }]
        >
      )[0][0]
      expect(ownArgs.where.type).toEqual({ in: ["CONSUME", "TEAM_CONSUME"] })
    })

    it("可按已消耗升序排序", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, canInvite: true })
      prisma.user.findMany.mockResolvedValue([
        {
          id: 7,
          username: "c",
          phone: "1",
          membershipLevel: "FOUNDER",
          discount: new Decimal(1),
          isActive: true,
          createdAt: new Date(),
          roles: [],
          teamMemberships: [],
        },
        {
          id: 8,
          username: "d",
          phone: "2",
          membershipLevel: "FOUNDER",
          discount: new Decimal(1),
          isActive: true,
          createdAt: new Date(),
          roles: [],
          teamMemberships: [],
        },
      ])
      prisma.creditTransaction.groupBy
        .mockResolvedValueOnce([
          { userId: 7, _sum: { amount: new Decimal(780) } },
          { userId: 8, _sum: { amount: new Decimal(520) } },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
      const res = await service.listInvitees(1, {
        page: 1,
        pageSize: 10,
        sortBy: "consumed",
        sortDir: "asc",
      })
      expect(res.items.map(i => i.id)).toEqual([8, 7])
    })

    it("企业管理员下级：已消耗/贡献返利卷起本企业池（成员可能非我下级），普通下级只计本人（2026-09-01 bug9 复修）", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, canInvite: true })
      prisma.user.findMany.mockResolvedValue([
        {
          id: 7,
          username: "admin",
          phone: "1",
          membershipLevel: "NONE",
          discount: new Decimal(1),
          isActive: true,
          createdAt: new Date(),
          roles: [],
          // 占用中企业管理员（团队 42 ACTIVE）
          teamMemberships: [{ teamId: 42, team: { status: "ACTIVE" } }],
        },
        {
          id: 8,
          username: "member",
          phone: "2",
          membershipLevel: "NONE",
          discount: new Decimal(1),
          isActive: true,
          createdAt: new Date(),
          roles: [],
          // 普通企业成员（非管理员）：不卷起，只计本人池行
          teamMemberships: [],
        },
      ])
      prisma.creditTransaction.groupBy
        .mockResolvedValueOnce([
          { userId: 7, type: "CONSUME", _sum: { amount: new Decimal(4) } }, // 管理员本人个人消费
          { userId: 7, type: "TEAM_CONSUME", _sum: { amount: new Decimal(6) } }, // 管理员本人池消费（含在全队 26 内）
          { userId: 8, type: "TEAM_CONSUME", _sum: { amount: new Decimal(9) } }, // 普通成员本人池消费
        ])
        .mockResolvedValueOnce([]) // 动用邀请人额度
        .mockResolvedValueOnce([{ relatedUserId: 7, _sum: { amount: new Decimal(2) } }]) // 个人段贡献返利
        .mockResolvedValueOnce([{ teamId: 42, _sum: { amount: new Decimal(26) } }]) // 企业42全队池消耗
        .mockResolvedValueOnce([{ teamId: 42, _sum: { amount: new Decimal(13) } }]) // 池段为我贡献返利

      const res = await service.listInvitees(1, { page: 1, pageSize: 10 })
      const admin = res.items.find(i => i.id === 7)!
      const member = res.items.find(i => i.id === 8)!
      // 管理员行：4（个人）+ 26（全队池，含本人 6，不双计）= 30；贡献返利 2 + 13 = 15
      expect(admin.consumed).toBe("30")
      expect(admin.rebateContributed).toBe("15")
      // 普通成员行：本人池 9；贡献返利 0
      expect(member.consumed).toBe("9")
      expect(member.rebateContributed).toBe("0")
    })

    it("注册时间范围筛选（2026-08-31 bug10）：startDate/endDate 按北京自然日整天过滤 createdAt", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, canInvite: true })
      prisma.user.findMany.mockResolvedValue([])
      await service.listInvitees(1, {
        page: 1,
        pageSize: 10,
        startDate: "2026-08-01",
        endDate: "2026-08-31",
      })
      const whereArg = (
        prisma.user.findMany.mock.calls as unknown as Array<
          [{ where: { createdAt?: { gte: Date; lte: Date } } }]
        >
      )[0][0].where
      // 北京 8/1 00:00:00.000 = UTC 7/31 16:00；北京 8/31 23:59:59.999 = UTC 8/31 15:59:59.999
      expect(whereArg.createdAt?.gte.toISOString()).toBe("2026-07-31T16:00:00.000Z")
      expect(whereArg.createdAt?.lte.toISOString()).toBe("2026-08-31T15:59:59.999Z")
    })

    it("注册时间可单独传一端；起 > 止 → 400（bug10）", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, canInvite: true })
      prisma.user.findMany.mockResolvedValue([])
      await service.listInvitees(1, { page: 1, pageSize: 10, startDate: "2026-08-01" })
      const whereArg2 = (
        prisma.user.findMany.mock.calls as unknown as Array<
          [{ where: { createdAt?: { gte?: Date; lte?: Date } } }]
        >
      )[0][0].where
      expect(whereArg2.createdAt?.gte?.toISOString()).toBe("2026-07-31T16:00:00.000Z")
      expect(whereArg2.createdAt?.lte).toBeUndefined()

      await expect(
        service.listInvitees(1, {
          page: 1,
          pageSize: 10,
          startDate: "2026-08-31",
          endDate: "2026-08-01",
        })
      ).rejects.toThrow("注册开始日期不能晚于结束日期")
    })

    it("停用 / 启用下级：仅能操作自己邀请的用户", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1, canInvite: true }) // requireInviter
        .mockResolvedValueOnce({ id: 7, invitedById: 2 }) // 该下级属于别人
      await expect(service.setInviteeStatus(1, 7, false)).rejects.toThrow("自己邀请")
    })

    it("停用下级：写 isActive=false + deactivatedAt", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1, canInvite: true })
        .mockResolvedValueOnce({ id: 7, invitedById: 1 })
      await service.setInviteeStatus(1, 7, false)
      const arg = (
        prisma.user.update.mock.calls as unknown as Array<
          [{ where: { id: number }; data: { isActive: boolean; deactivatedAt: Date | null } }]
        >
      )[0][0]
      expect(arg.where).toEqual({ id: 7 })
      expect(arg.data.isActive).toBe(false)
      expect(arg.data.deactivatedAt).toBeInstanceOf(Date)
    })
  })

  describe("resetInviteePassword", () => {
    it("仅能重置自己邀请的用户：他人下级 → 403，且不改密", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1, canInvite: true }) // requireInviter
        .mockResolvedValueOnce({ id: 7, invitedById: 2 }) // 属于别人
      await expect(service.resetInviteePassword(1, 7)).rejects.toThrow("自己邀请")
      expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it("重置成功：置默认密码 + mustChangePassword=true（不发短信）", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1, canInvite: true }) // requireInviter
        .mockResolvedValueOnce({ id: 7, invitedById: 1 })
      const res = await service.resetInviteePassword(1, 7)
      expect(res).toEqual({ id: 7 })
      const arg = (
        prisma.user.update.mock.calls as unknown as Array<
          [{ where: { id: number }; data: { password: string; mustChangePassword: boolean } }]
        >
      )[0][0]
      expect(arg.where).toEqual({ id: 7 })
      expect(arg.data.mustChangePassword).toBe(true)
      expect(typeof arg.data.password).toBe("string")
      expect(arg.data.password).not.toBe("Default@123") // 落库的是哈希、非明文
    })

    it("非邀请人调用 → 403（requireInviter 拦截）", async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 1, canInvite: false })
      await expect(service.resetInviteePassword(1, 7)).rejects.toThrow("邀请")
    })
  })

  describe("listInviteeTransactions", () => {
    it("非邀请人 → 403", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, canInvite: false })
      await expect(
        service.listInviteeTransactions(1, 7, { page: 1, pageSize: 10 })
      ).rejects.toThrow("邀请")
    })

    it("查非自己邀请的用户 → 403", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1, canInvite: true }) // requireInviter
        .mockResolvedValueOnce({ invitedById: 999 }) // 该用户不是我邀请的
      await expect(
        service.listInviteeTransactions(1, 7, { page: 1, pageSize: 10 })
      ).rejects.toThrow("只能查看自己邀请")
      expect(wallet.listTransactions).not.toHaveBeenCalled()
    })

    it("查自己邀请的下级 → 委托 wallet.listTransactions", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1, canInvite: true })
        .mockResolvedValueOnce({ invitedById: 1 })
      const query = { page: 1, pageSize: 10 }
      await service.listInviteeTransactions(1, 7, query)
      expect(wallet.listTransactions).toHaveBeenCalledWith(7, query)
    })

    it("透传 consumeSource / direction 等筛选给下级流水查询", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1, canInvite: true })
        .mockResolvedValueOnce({ invitedById: 1 })
      const query = { page: 1, pageSize: 10, direction: "DEBIT", consumeSource: "OWN_RECHARGE" }
      await service.listInviteeTransactions(1, 7, query as never)
      // 委托下级流水查询，wallet.listTransactions 内按 consumeSource 走扣费来源筛选
      expect(wallet.listTransactions).toHaveBeenCalledWith(7, query)
    })
  })

  describe("getMyTree（C 端邀请团队关系树）", () => {
    it("非邀请人 → 403（requireInviter 拦截），不委托关系树", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, canInvite: false })
      await expect(service.getMyTree(1, { page: 1, pageSize: 10 })).rejects.toThrow("邀请")
      expect(adminDist.getTree).not.toHaveBeenCalled()
    })

    it("邀请人 → 以本人 userId 委托 AdminDistService.getTree（与后台 dist/tree 同结构）", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 1, canInvite: true })
      const res = await service.getMyTree(1, { page: 2, pageSize: 5 })
      expect(adminDist.getTree).toHaveBeenCalledWith({ userId: 1, page: 2, pageSize: 5 })
      expect(res).toEqual({ user: { id: 1 }, level1: [] })
    })
  })

  describe("二级邀请（2026-09-01 起落库制：上级开关批量写入/收回下级 canInvite，读侧不再派生）", () => {
    it("verifyInviteCode：上级批量打开后（canInvite=true 落库）邀请码有效", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 116,
        username: "李小璐",
        canInvite: true,
        isActive: true,
        inviteCodeExpiresAt: future(),
      })
      const res = await service.verifyInviteCode("OSAB12")
      expect(res).toEqual({ valid: true, inviterId: 116, inviterName: "李小璐" })
    })

    it("verifyInviteCode：本人 canInvite=false（未落库/已被收回）→ 无效链接（上级开关不再派生）", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 116,
        username: "李小璐",
        canInvite: false,
        isActive: true,
        inviteCodeExpiresAt: future(),
      })
      await expect(service.verifyInviteCode("OSAB12")).rejects.toThrow("无效链接")
    })

    it("approve：邀请人开着「下级可继续邀请」→ 新下级落库即带邀请权+邀请码", async () => {
      prisma.inviteApplication.findFirst.mockResolvedValue({
        id: 100,
        inviterId: 116,
        status: InviteAppStatus.PENDING,
        username: "新下级",
        email: "new@example.com",
        phone: "18811112222",
        passwordHash: "hash",
      })
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // phone free
        .mockResolvedValueOnce({
          canInvite: true,
          subInviteAllowed: true, // 开着 → 新下级自动带邀请权
          discount: new Decimal("0.9"),
          inviteQuota: null,
          roles: [],
          orgs: [],
        })
        .mockResolvedValueOnce(null) // generateUniqueCode（新下级邀请码）唯一性校验
      prisma.user.create.mockResolvedValue({ id: 60 })

      const res = await service.approve(100, 116)
      expect(res.userId).toBe(60)
      const createArg = (
        prisma.user.create.mock.calls as unknown as Array<
          [
            {
              data: { canInvite?: boolean; inviteCode?: string | null; inviteCodeExpiresAt?: Date }
            },
          ]
        >
      )[0][0]
      expect(createArg.data.canInvite).toBe(true)
      expect(typeof createArg.data.inviteCode).toBe("string")
      expect(createArg.data.inviteCodeExpiresAt).toBeInstanceOf(Date)
    })

    it("approve：邀请人没开「下级可继续邀请」→ 新下级默认无邀请权", async () => {
      prisma.inviteApplication.findFirst.mockResolvedValue({
        id: 100,
        inviterId: 116,
        status: InviteAppStatus.PENDING,
        username: "新下级",
        email: "new@example.com",
        phone: "18811112222",
        passwordHash: "hash",
      })
      prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
        canInvite: true,
        subInviteAllowed: false,
        discount: new Decimal("0.9"),
        inviteQuota: null,
        roles: [],
        orgs: [],
      })
      prisma.user.create.mockResolvedValue({ id: 60 })

      await service.approve(100, 116)
      const createArg = (
        prisma.user.create.mock.calls as unknown as Array<[{ data: { canInvite?: boolean } }]>
      )[0][0]
      expect(createArg.data.canInvite).toBeUndefined()
    })

    it("approve：邀请人邀请权已被收回（canInvite=false）→ 存量待审申请 403 不放行", async () => {
      prisma.inviteApplication.findFirst.mockResolvedValue({
        id: 100,
        inviterId: 116,
        status: InviteAppStatus.PENDING,
        username: "新下级",
        email: "new@example.com",
        phone: "18811112222",
        passwordHash: "hash",
      })
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // phone free
        .mockResolvedValueOnce({
          canInvite: false, // 被单人关闭或上级批量收回
          discount: new Decimal("0.9"),
          inviteQuota: null,
          roles: [],
          orgs: [],
        })
      await expect(service.approve(100, 116)).rejects.toThrow("未开启邀请权限")
      expect(prisma.user.create).not.toHaveBeenCalled()
    })

    it("getMyInvite：canInvite=true 但无邀请码 → 惰性生成并返回（邀请入口即用）", async () => {
      const me = {
        id: 116,
        canInvite: true,
        shareCreditsWithInvitees: false,
        inviteCode: null,
        inviteCodeExpiresAt: null,
        inviteQuota: null,
        subInviteAllowed: false,
      }
      prisma.user.findUnique
        .mockResolvedValueOnce(me) // requireInviter（getMyInvite）
        .mockResolvedValueOnce(me) // requireInviter（ensureFreshCode → refreshCode）
        .mockResolvedValueOnce({ inviteCode: null, inviteCodeExpiresAt: null }) // refreshCode 读当前码（占位条件用）
        .mockResolvedValueOnce(null) // generateUniqueCode 唯一性校验
      const res = await service.getMyInvite(116)
      expect(typeof res.inviteCode).toBe("string")
      expect(res.inviteCode).toMatch(/^OS/)
      expect(res.subInviteAllowed).toBe(false)
      // 根用户（无邀请人）：二级返利比例正常下发（bug23 对照组）
      expect(res.networkStats.level2RebateRate).toBe("0.1")
      expect(prisma.user.updateMany).toHaveBeenCalled() // 新码已条件占位落库（2026-08-31 refreshCode 并发安全）
    })

    it("getMyInvite：被邀请人视角不下发二级返利比例（bug23——上游配置与其收益无关，两级封顶也无二级下线）", async () => {
      const me = {
        id: 116,
        canInvite: true,
        shareCreditsWithInvitees: false,
        inviteCode: null,
        inviteCodeExpiresAt: null,
        inviteQuota: null,
        subInviteAllowed: false,
        invitedById: 115, // 本人是被邀请人
        rebateRate: new Decimal("0.3"),
        level2RebateRate: new Decimal("0.5"), // 即使字段有值也不应下发
      }
      prisma.user.findUnique
        .mockResolvedValueOnce(me) // requireInviter（getMyInvite）
        .mockResolvedValueOnce(me) // requireInviter（ensureFreshCode → refreshCode）
        .mockResolvedValueOnce({ inviteCode: null, inviteCodeExpiresAt: null })
        .mockResolvedValueOnce(null) // generateUniqueCode 唯一性校验
      const res = await service.getMyInvite(116)
      expect(res.networkStats.rebateRate).toBe("0.3") // 本人一级比例照发
      expect(res.networkStats.level2RebateRate).toBeNull() // 上游二级比例裁剪
    })

    it("getMyInvite：canInvite=false（落库制，上级开关不再派生）→ 403", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 116, canInvite: false })
      await expect(service.getMyInvite(116)).rejects.toThrow("未开启邀请权限")
    })

    it("setInviteConfig：关闭邀请级联收回其一级下级的邀请权（批量收回，与关开关同路径）", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 1,
          canInvite: true,
          invitedById: null,
          subscriptionTier: 2,
          inviteQuota: null,
          subInviteAllowed: true, // 开着下级邀请 → 关邀请时级联收回
        })
        .mockResolvedValueOnce({ canInvite: false, membershipLevel: MembershipLevel.LV2 }) // getInviteOverview
      prisma.user.findMany.mockResolvedValueOnce([{ id: 21, subscriptionTier: null }]) // 开着的下级

      await service.setInviteConfig(1, { canInvite: false })

      const updates = prisma.user.update.mock.calls as unknown as Array<
        [UserUpdateArg & { data: { subInviteAllowed?: boolean } }]
      >
      expect(updates[0][0].data.canInvite).toBe(false)
      expect(updates[0][0].data.subInviteAllowed).toBe(false)
      expect(updates[0][0].data.inviteCode).toBeNull()
      expect(updates[1][0]).toEqual({
        where: { id: 21 },
        data: {
          canInvite: false,
          inviteCode: null,
          inviteCodeExpiresAt: null,
          rebateEnabled: false,
          shareCreditsWithInvitees: false,
          canInviteManualOff: false,
          membershipLevel: "NONE",
        },
      })
    })
  })
})
