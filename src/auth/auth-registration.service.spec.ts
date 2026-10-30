import { ConflictException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { JwtService } from "@nestjs/jwt"
import { CreditBucket, CreditTxnType, Prisma } from "@prisma/client"
import * as argon2 from "argon2"
import { DefaultMemberRoleService } from "../common/services/default-member-role.service"
import { CreditService } from "../membership/credit.service"
import { InviteService } from "../membership/invite.service"
import { PrismaService } from "../prisma/prisma.service"
import { SmsService } from "../sms/sms.service"
import { AuthService } from "./auth.service"

describe("手机号自助注册", () => {
  const dto = { username: "tester01", phone: "15884033673", code: "123456", password: "Password1" }
  type State = {
    user: (Prisma.UserUncheckedCreateInput & { id: number }) | null
    sms: { id: number; code: string; used: boolean; attempts: number; expiredAt: Date }
    roleBound: boolean
    bonus: number
  }
  let state: State
  let pending: boolean
  let roleId: string
  let roleExists: boolean
  let service: AuthService
  let tx: {
    user: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; create: jest.Mock }
    inviteApplication: { findFirst: jest.Mock; create: jest.Mock }
    smsCode: { findFirst: jest.Mock; updateMany: jest.Mock }
    roleModel: { findUnique: jest.Mock }
    userRole: { upsert: jest.Mock }
    userOrganization: { createMany: jest.Mock }
  }
  let prisma: typeof tx & { $transaction: jest.Mock }
  let credit: { grant: jest.Mock }
  let invite: { registrationInviteData: jest.Mock }
  let jwt: { sign: jest.Mock }

  beforeEach(() => {
    state = {
      user: null,
      sms: {
        id: 1,
        code: dto.code,
        used: false,
        attempts: 0,
        expiredAt: new Date(Date.now() + 300000),
      },
      roleBound: false,
      bonus: 0,
    }
    pending = false
    roleId = "11"
    roleExists = true
    tx = {
      user: {
        findUnique: jest.fn(() => Promise.resolve(state.user && { id: state.user.id })),
        findUniqueOrThrow: jest.fn(() =>
          Promise.resolve({ ...state.user, roles: [{ role: { code: "MEMBER" } }], orgs: [] })
        ),
        create: jest.fn(({ data }: { data: Prisma.UserUncheckedCreateInput }) => {
          state.user = { ...data, id: 50 }
          return Promise.resolve(state.user)
        }),
      },
      inviteApplication: {
        findFirst: jest.fn(() => Promise.resolve(pending ? { id: 99 } : null)),
        create: jest.fn(),
      },
      smsCode: {
        findFirst: jest.fn(() => Promise.resolve({ ...state.sms })),
        updateMany: jest.fn(
          ({
            where,
            data,
          }: {
            where: { used: boolean; attempts: { lt: number }; expiredAt?: { gt: Date } }
            data: { used?: boolean; attempts?: { increment: number } }
          }) => {
            if (
              state.sms.used !== where.used ||
              state.sms.attempts >= where.attempts.lt ||
              (where.expiredAt && state.sms.expiredAt <= where.expiredAt.gt)
            )
              return Promise.resolve({ count: 0 })
            if (data.used !== undefined) state.sms.used = data.used
            if (data.attempts) state.sms.attempts += data.attempts.increment
            return Promise.resolve({ count: 1 })
          }
        ),
      },
      roleModel: { findUnique: jest.fn(() => Promise.resolve(roleExists ? { id: 11 } : null)) },
      userRole: {
        upsert: jest.fn(() => {
          state.roleBound = true
          return Promise.resolve({})
        }),
      },
      userOrganization: { createMany: jest.fn() },
    }
    // 内存事务用于验证回滚和并发结果；不替代真实 MySQL 的行锁验收。
    let tail: Promise<unknown> = Promise.resolve()
    prisma = {
      ...tx,
      $transaction: jest.fn((run: (client: typeof tx) => Promise<unknown>) => {
        const result = tail.then(async () => {
          const before = structuredClone(state)
          try {
            return await run(tx)
          } catch (error) {
            state = before
            throw error
          }
        })
        tail = result.catch(() => {})
        return result
      }),
    }
    credit = {
      grant: jest.fn((_userId: number, _bucket: CreditBucket, amount: number) => {
        state.bonus += amount
        return Promise.resolve({})
      }),
    }
    invite = {
      registrationInviteData: jest.fn().mockResolvedValue({ invitedById: 7, discount: 0.8 }),
    }
    jwt = { sign: jest.fn().mockReturnValue("signup-token") }
    const config = new ConfigService({ ACCESS_KEY_ID: "test", ACCESS_KEY_SECRET: "test" })
    jest
      .spyOn(config, "get")
      .mockImplementation((key: string) => (key === "DEFAULT_MEMBER_ROLE_ID" ? roleId : "test"))
    const database = prisma as unknown as PrismaService
    service = new AuthService(
      database,
      jwt as unknown as JwtService,
      new SmsService(config, database),
      credit as unknown as CreditService,
      new DefaultMemberRoleService(config),
      invite as unknown as InviteService
    )
  })

  it("无邀请码直接建号、绑定默认角色、送200积分并登录，无组织无申请", async () => {
    await expect(service.register(dto)).resolves.toEqual({ access_token: "signup-token" })
    expect(state.user).toMatchObject({
      username: dto.username,
      phone: dto.phone,
      balance: 0,
      lastLoginAt: expect.any(Date) as Date,
    })
    expect(await argon2.verify(state.user!.password, dto.password)).toBe(true)
    expect(state.user).not.toHaveProperty("invitedById")
    expect(state.user).not.toHaveProperty("orgs")
    expect(state.user?.mustChangePassword).toBeUndefined()
    expect(state.sms.used).toBe(true)
    expect(state.roleBound).toBe(true)
    expect(state.bonus).toBe(200)
    expect(tx.userRole.upsert).toHaveBeenCalledWith({
      where: { userId_roleId: { userId: 50, roleId: 11 } },
      create: { userId: 50, roleId: 11 },
      update: {},
    })
    expect(credit.grant).toHaveBeenCalledWith(
      50,
      CreditBucket.GIFT,
      200,
      expect.objectContaining({
        type: CreditTxnType.SIGNUP_BONUS,
        source: "phone.signup",
        expiresAt: expect.any(Date) as Date,
      }),
      tx
    )
    const [, , , { expiresAt }] = credit.grant.mock.calls[0] as [
      number,
      CreditBucket,
      number,
      { expiresAt: Date },
    ]
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(30 * 86400000 - 5000)
    expect(jwt.sign).toHaveBeenCalledWith({
      sub: 50,
      phone: dto.phone,
      roleCode: "MEMBER",
      currentOrgId: null,
    })
    expect(tx.userOrganization.createMany).not.toHaveBeenCalled()
    expect(tx.inviteApplication.create).not.toHaveBeenCalled()
    expect(invite.registrationInviteData).not.toHaveBeenCalled()
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 15000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    })
  })

  it("带邀请码直接绑定邀请关系与折扣，无需审核且不复制组织", async () => {
    await service.register({ ...dto, inviteCode: "OS1234" })
    expect(invite.registrationInviteData).toHaveBeenCalledWith(tx, "OS1234")
    expect(state.user).toMatchObject({ invitedById: 7, discount: 0.8 })
    expect(credit.grant).toHaveBeenCalledWith(
      50,
      CreditBucket.GIFT,
      200,
      expect.objectContaining({ source: "invite.signup" }),
      tx
    )
    expect(tx.inviteApplication.create).not.toHaveBeenCalled()
    expect(tx.userOrganization.createMany).not.toHaveBeenCalled()
  })

  it("邀请码无效或名额已满时不核销短信、不建号", async () => {
    invite.registrationInviteData.mockRejectedValue(new Error("该邀请链接名额已用完"))
    await expect(service.register({ ...dto, inviteCode: "OS1234" })).rejects.toThrow("名额已用完")
    expect(tx.smsCode.updateMany).not.toHaveBeenCalled()
    expect(state.user).toBeNull()
    expect(state.bonus).toBe(0)
  })

  it("已有待审申请直接拦截，不核销验证码", async () => {
    pending = true
    await expect(service.register(dto)).rejects.toThrow("审核中")
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(state.sms.used).toBe(false)
    expect(state.user).toBeNull()
  })

  it("事务内复核待审占用，拦截快检后的变化", async () => {
    tx.inviteApplication.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 99 })
    await expect(service.register(dto)).rejects.toThrow("审核中")
    expect(tx.smsCode.updateMany).not.toHaveBeenCalled()
    expect(state.user).toBeNull()
  })

  it("错码计数提交保留，累计五次后正确验证码也不能使用", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(service.register({ ...dto, code: "000000" })).rejects.toThrow(
        "验证码无效或已过期"
      )
    }
    expect(state.sms.attempts).toBe(5)
    await expect(service.register(dto)).rejects.toThrow("验证码无效或已过期")
    expect(state.user).toBeNull()
    expect(state.bonus).toBe(0)
    expect(jwt.sign).not.toHaveBeenCalled()
  })

  it.each(["expired", "used"])("%s 的验证码不能建号", async condition => {
    if (condition === "expired") state.sms.expiredAt = new Date(0)
    else state.sms.used = true
    await expect(service.register(dto)).rejects.toThrow("验证码无效或已过期")
    expect(state.user).toBeNull()
  })

  it.each(["角色配置缺失", "角色不存在", "积分入账失败"])(
    "%s 时建号、角色和验证码整体回滚",
    async failure => {
      if (failure === "角色配置缺失") roleId = ""
      if (failure === "角色不存在") roleExists = false
      if (failure === "积分入账失败") credit.grant.mockRejectedValue(new Error(failure))
      await expect(service.register(dto)).rejects.toThrow()
      expect(state).toMatchObject({ user: null, roleBound: false, bonus: 0, sms: { used: false } })
      expect(jwt.sign).not.toHaveBeenCalled()
    }
  )

  it("并发同手机号只建一个账号、送一份积分、签一个token", async () => {
    const results = await Promise.allSettled([service.register(dto), service.register(dto)])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(ConflictException)
    expect(tx.user.create).toHaveBeenCalledTimes(1)
    expect(state.bonus).toBe(200)
    expect(jwt.sign).toHaveBeenCalledTimes(1)
  })

  it("并发撞数据库手机号唯一索引转409，事务回滚不送积分", async () => {
    tx.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique", {
        code: "P2002",
        clientVersion: "6",
        meta: { target: "User_phone_key" },
      })
    )
    await expect(service.register(dto)).rejects.toThrow(ConflictException)
    expect(state.sms.used).toBe(false)
    expect(state.bonus).toBe(0)
  })
})
