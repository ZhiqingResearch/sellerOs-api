import { Test } from "@nestjs/testing"
import { CreditTxnType } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { CreditService } from "./credit.service"
import { WalletService } from "./wallet.service"

describe("WalletService.listTransactions", () => {
  let service: WalletService
  let prisma: {
    user: { findUnique: jest.Mock; findMany: jest.Mock }
    creditTransaction: { findMany: jest.Mock; count: jest.Mock }
    scheduledPlan: { findMany: jest.Mock }
    receipt: { findMany: jest.Mock }
    teamMember: { findFirst: jest.Mock; findMany: jest.Mock }
    listingRun: { findMany: jest.Mock }
  }

  beforeEach(async () => {
    prisma = {
      // 默认：普通用户（非邀请人、非被邀请人）→ 走 userId=自己 的基础查询
      user: {
        findUnique: jest.fn().mockResolvedValue({ canInvite: false, invitedById: null }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      creditTransaction: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      scheduledPlan: { findMany: jest.fn().mockResolvedValue([]) },
      receipt: { findMany: jest.fn().mockResolvedValue([]) },
      // 默认非企业管理员（记录隔离：仅本人行）；管理员用例按需覆盖 findFirst
      teamMember: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      listingRun: { findMany: jest.fn().mockResolvedValue([]) },
    }
    const module = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: {} },
      ],
    }).compile()
    service = module.get(WalletService)
  })

  // where 现为 { AND: [common, scoped, ...] }；common（含 type/方向/时间）在 AND[0]
  type FindManyArg = { where: { AND: Array<Record<string, unknown>> } }
  const andOf = (): Array<Record<string, unknown>> => {
    const calls = prisma.creditTransaction.findMany.mock.calls as unknown as Array<[FindManyArg]>
    return calls[0][0].where.AND
  }
  const commonOf = (): Record<string, unknown> => andOf()[0]

  it("默认排除返利入账/提现：提现不进使用记录(DEBIT)、返利入账不进充值记录(CREDIT)", async () => {
    await service.listTransactions(1, { page: 1, pageSize: 10, direction: "DEBIT" } as never)
    expect(commonOf().type).toEqual({
      notIn: [CreditTxnType.REBATE_IN, CreditTxnType.REBATE_WITHDRAW],
    })
  })

  it("显式按 type 查询时放行（覆盖默认排除）", async () => {
    await service.listTransactions(1, {
      page: 1,
      pageSize: 10,
      type: CreditTxnType.CONSUME,
    })
    expect(commonOf().type).toBe(CreditTxnType.CONSUME)
  })

  it("普通用户：按 userId 自己范围查询", async () => {
    await service.listTransactions(1, { page: 1, pageSize: 10 })
    expect(andOf()).toContainEqual({ userId: 1 })
  })

  describe("企业用户查询个人历史", () => {
    type HistoryRow = {
      id: number
      userId: number
      teamId: number | null
      direction: string
      type: string
      createdAt: Date
    }
    type HistoryWhere = {
      AND?: HistoryWhere[]
      OR?: HistoryWhere[]
      userId?: number
      teamId?: number | null | { not: null }
      direction?: string
      type?: string | { notIn: string[] }
      createdAt?: { gte?: Date; lte?: Date }
    }
    const matches = (row: HistoryRow, where: HistoryWhere): boolean => {
      if (where.AND && !where.AND.every(clause => matches(row, clause))) return false
      if (where.OR && !where.OR.some(clause => matches(row, clause))) return false
      if (where.userId !== undefined && row.userId !== where.userId) return false
      if (where.teamId !== undefined) {
        if (typeof where.teamId === "object" && where.teamId !== null) {
          if (row.teamId === null) return false
        } else if (row.teamId !== where.teamId) return false
      }
      if (where.direction && row.direction !== where.direction) return false
      if (typeof where.type === "string" && row.type !== where.type) return false
      if (typeof where.type === "object" && where.type.notIn.includes(row.type)) return false
      if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false
      if (where.createdAt?.lte && row.createdAt > where.createdAt.lte) return false
      return true
    }
    const setupHistory = (admin: boolean) => {
      const joinedAt = new Date("2026-08-01T00:00:00.000Z")
      prisma.teamMember.findFirst.mockImplementation(({ where }: { where: { role?: string } }) =>
        Promise.resolve(where.role === "ADMIN" ? (admin ? { teamId: 7 } : null) : { joinedAt })
      )
      const rows = [
        { id: 1, userId: 1, teamId: null, createdAt: new Date("2026-07-01") },
        { id: 2, userId: 1, teamId: null, createdAt: new Date("2026-09-01") },
        { id: 3, userId: 1, teamId: 7, createdAt: new Date("2026-09-02") },
        { id: 4, userId: 2, teamId: null, createdAt: new Date("2026-07-02") },
        { id: 5, userId: 2, teamId: 7, createdAt: new Date("2026-09-03") },
        { id: 6, userId: 1, teamId: null, createdAt: new Date("2026-07-03") },
      ].map(row => ({
        ...row,
        direction: row.id === 6 ? "CREDIT" : "DEBIT",
        type:
          row.id === 6
            ? CreditTxnType.MANUAL_ADJUST
            : row.teamId
              ? CreditTxnType.TEAM_CONSUME
              : CreditTxnType.CONSUME,
        amount: new Decimal(10),
        balanceAfter: new Decimal(90),
        bucket: "RECHARGE",
        source: "aicreative.image_generate",
        relatedUserId: null,
        meta: null,
      }))
      prisma.creditTransaction.findMany.mockImplementation(
        ({ where, skip = 0, take }: { where: HistoryWhere; skip?: number; take?: number }) => {
          const filtered = rows.filter(row => matches(row, where)).sort((a, b) => b.id - a.id)
          return Promise.resolve(filtered.slice(skip, take === undefined ? undefined : skip + take))
        }
      )
      prisma.creditTransaction.count.mockImplementation(({ where }: { where: HistoryWhere }) =>
        Promise.resolve(rows.filter(row => matches(row, where)).length)
      )
    }

    it.each([
      { admin: false, ownership: undefined, ids: [3, 2, 1] },
      { admin: false, ownership: "PERSONAL" as const, ids: [2, 1] },
      { admin: false, ownership: "TEAM" as const, ids: [3] },
      { admin: true, ownership: undefined, ids: [5, 3, 2, 1] },
      { admin: true, ownership: "PERSONAL" as const, ids: [2, 1] },
      { admin: true, ownership: "TEAM" as const, ids: [5, 3] },
    ])(
      "管理员=$admin、归属=$ownership：保留本人历史且不暴露他人个人记录",
      async ({ admin, ownership, ids }) => {
        setupHistory(admin)
        const result = await service.listTransactions(1, {
          page: 1,
          pageSize: 10,
          direction: "DEBIT",
          ownership,
        })
        expect(result.items.map(row => row.id)).toEqual(ids)
        expect(result.total).toBe(ids.length)
      }
    )

    it("方向筛选仍区分入账与扣减，显式日期筛选仍生效", async () => {
      setupHistory(false)
      const credit = await service.listTransactions(1, {
        page: 1,
        pageSize: 10,
        direction: "CREDIT",
        ownership: "PERSONAL",
      })
      expect(credit.items.map(row => row.id)).toEqual([6])
      const debit = await service.listTransactions(1, {
        page: 1,
        pageSize: 10,
        direction: "DEBIT",
        ownership: "PERSONAL",
        startDate: "2026-08-01T00:00:00.000Z",
      })
      expect(debit.items.map(row => row.id)).toEqual([2])
    })
  })

  it("被邀请人(LV4)：纳入动用邀请人额度的消费行（relatedUserId=自己 的 CONSUME）", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, invitedById: 2 })
    await service.listTransactions(7, { page: 1, pageSize: 10 })
    expect(andOf()).toContainEqual({
      OR: [{ userId: 7 }, { relatedUserId: 7, type: CreditTxnType.CONSUME }],
    })
  })

  it("被邀请人(LV4)：consumeSource=邀请人余额 → relatedUserId=自己 + RECHARGE 桶", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, invitedById: 2 })
    await service.listTransactions(7, {
      page: 1,
      pageSize: 10,
      consumeSource: "INVITER_RECHARGE",
    } as never)
    expect(andOf()).toContainEqual({
      type: CreditTxnType.CONSUME,
      relatedUserId: 7,
      bucket: "RECHARGE",
    })
  })

  it("邀请人(LV5)：consumerUserId 指定下级 → relatedUserId=该下级", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: true, invitedById: null })
    await service.listTransactions(2, {
      page: 1,
      pageSize: 10,
      consumerUserId: "9",
    })
    expect(andOf()).toContainEqual({ userId: 2 })
    expect(andOf()).toContainEqual({ relatedUserId: 9 })
  })

  it("邀请人(LV5)：consumerUserId=self → relatedUserId 为空（本人）", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: true, invitedById: null })
    await service.listTransactions(2, {
      page: 1,
      pageSize: 10,
      consumerUserId: "self",
    })
    expect(andOf()).toContainEqual({ relatedUserId: null })
  })

  it("使用用户列：relatedUserId=null→本人，否则解析为下级用户名", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: true, invitedById: null })
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 1,
        userId: 2,
        direction: "DEBIT",
        bucket: "RECHARGE",
        type: CreditTxnType.CONSUME,
        amount: "10",
        balanceAfter: "90",
        source: "listing.generate",
        relatedUserId: 9,
        meta: null,
        createdAt: new Date(),
      },
      {
        id: 2,
        userId: 2,
        direction: "DEBIT",
        bucket: "RECHARGE",
        type: CreditTxnType.CONSUME,
        amount: "5",
        balanceAfter: "85",
        source: "listing.generate",
        relatedUserId: null,
        meta: null,
        createdAt: new Date(),
      },
    ])
    prisma.user.findMany.mockResolvedValue([{ id: 9, username: "李婷" }])
    const res = await service.listTransactions(2, { page: 1, pageSize: 10 })
    expect(res.items[0].consumerName).toBe("李婷")
    expect(res.items[1].consumerName).toBe("本人")
    // 本行不外泄归属人 userId
    expect((res.items[0] as Record<string, unknown>).userId).toBeUndefined()
  })

  it("积分归属筛选：ownership=PERSONAL → teamId 为空；TEAM → teamId 有值", async () => {
    await service.listTransactions(1, { page: 1, pageSize: 10, ownership: "PERSONAL" } as never)
    expect(andOf()).toContainEqual({ teamId: null })
    prisma.creditTransaction.findMany.mockClear()
    await service.listTransactions(1, { page: 1, pageSize: 10, ownership: "TEAM" } as never)
    expect(andOf()).toContainEqual({ teamId: { not: null } })
  })

  it("调用方式筛选：invokeType=API/PLATFORM → where 带 invokeType；不传则不带", async () => {
    await service.listTransactions(1, { page: 1, pageSize: 10, invokeType: "API" } as never)
    expect(andOf()).toContainEqual({ invokeType: "API" })
    prisma.creditTransaction.findMany.mockClear()
    await service.listTransactions(1, { page: 1, pageSize: 10, invokeType: "PLATFORM" } as never)
    expect(andOf()).toContainEqual({ invokeType: "PLATFORM" })
    prisma.creditTransaction.findMany.mockClear()
    await service.listTransactions(1, { page: 1, pageSize: 10 })
    expect(andOf().some(part => "invokeType" in part)).toBe(false)
  })

  it("调用方式列：API 行 → API 调用；行缺省（历史/mock）→ 平台使用兜底", async () => {
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 305,
        userId: 1,
        direction: "DEBIT",
        bucket: "RECHARGE",
        type: CreditTxnType.CONSUME,
        amount: "10",
        balanceAfter: "90",
        source: "listing.generate",
        invokeType: "API",
        relatedUserId: null,
        teamId: null,
        meta: null,
        createdAt: new Date(),
      },
      {
        id: 306,
        userId: 1,
        direction: "DEBIT",
        bucket: "RECHARGE",
        type: CreditTxnType.CONSUME,
        amount: "5",
        balanceAfter: "85",
        source: "aicreative.image_generate",
        relatedUserId: null,
        teamId: null,
        meta: null,
        createdAt: new Date(),
      },
    ])
    const res = await service.listTransactions(1, { page: 1, pageSize: 10 })
    expect(res.items[0].invokeType).toBe("API")
    expect(res.items[0].invokeTypeLabel).toBe("API 调用")
    expect(res.items[1].invokeType).toBe("PLATFORM")
    expect(res.items[1].invokeTypeLabel).toBe("平台使用")
  })

  it("积分归属列：个人行（teamId 空）单边推导——个人侧取值、企业侧 null", async () => {
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 301,
        userId: 1,
        direction: "DEBIT",
        bucket: "RECHARGE",
        type: CreditTxnType.CONSUME,
        amount: "50",
        balanceAfter: "450",
        source: "listing.generate",
        relatedUserId: null,
        teamId: null,
        meta: null,
        createdAt: new Date(),
      },
    ])
    const res = await service.listTransactions(1, { page: 1, pageSize: 10 })
    const row = res.items[0]
    expect(row.ownership).toBe("PERSONAL")
    expect(row.ownerships).toEqual(["PERSONAL"])
    expect(row.personalCredits).toBe("50")
    expect(row.teamCredits).toBeNull()
    expect(row.personalBalanceAfter).toBe("450")
    expect(row.teamBalanceAfter).toBeNull()
    expect(row.consumeEventId).toBeNull()
    // 本行不外泄 teamId
    expect((row as Record<string, unknown>).teamId).toBeUndefined()
  })

  it("积分归属列：企业行（teamId 有值）单边推导——企业侧取值、个人侧 null", async () => {
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 302,
        userId: 1,
        direction: "DEBIT",
        bucket: "PACKAGE",
        type: CreditTxnType.TEAM_CONSUME,
        amount: "80",
        balanceAfter: "920",
        source: "listing.generate",
        relatedUserId: null,
        teamId: 7,
        meta: null,
        createdAt: new Date(),
      },
    ])
    const res = await service.listTransactions(1, { page: 1, pageSize: 10 })
    const row = res.items[0]
    expect(row.ownership).toBe("TEAM")
    expect(row.ownerships).toEqual(["TEAM"])
    expect(row.personalCredits).toBeNull()
    expect(row.teamCredits).toBe("80")
    expect(row.personalBalanceAfter).toBeNull()
    expect(row.teamBalanceAfter).toBe("920")
  })

  it("混合扣费事件：按展示单元合并为一行（代表=企业段行），total 按合并后计", async () => {
    const giftRow = {
      id: 303,
      userId: 1,
      direction: "DEBIT",
      bucket: "GIFT",
      type: CreditTxnType.CONSUME,
      amount: "20",
      balanceAfter: "100",
      source: "listing.generate",
      relatedUserId: null,
      teamId: null,
      meta: {
        consumeEventId: "evt-1",
        ownershipSplit: {
          personal: "20",
          team: "30",
          personalBalanceAfter: "100",
          teamBalanceAfter: "970",
        },
      },
      createdAt: new Date(),
    }
    const teamRow = {
      id: 304,
      userId: 1,
      direction: "DEBIT",
      bucket: "PACKAGE",
      type: CreditTxnType.TEAM_CONSUME,
      amount: "30",
      balanceAfter: "970",
      source: "listing.generate",
      relatedUserId: null,
      teamId: 7,
      meta: {
        consumeEventId: "evt-1",
        ownershipSplit: {
          personal: "20",
          team: "30",
          personalBalanceAfter: "100",
          teamBalanceAfter: "970",
        },
      },
      createdAt: new Date(),
    }
    prisma.creditTransaction.findMany
      .mockResolvedValueOnce([giftRow, teamRow]) // 事件章轻量扫描
      .mockResolvedValueOnce([teamRow]) // 代表行（企业段）取回
      .mockResolvedValueOnce([giftRow, teamRow]) // 事件兄弟段聚合
    const res = await service.listTransactions(1, { page: 1, pageSize: 10 })
    // 一笔事件只出一行，总数按合并后展示单元计
    expect(res.total).toBe(1)
    expect(res.items).toHaveLength(1)
    const row = res.items[0]
    // 代表行=企业段：个人段行不进列表（成员/管理员视角都可见池行，记录隔离不破）
    expect(row.ownership).toBe("TEAM")
    expect(row.ownerships).toEqual(["PERSONAL", "TEAM"])
    expect(row.personalCredits).toBe("20")
    expect(row.teamCredits).toBe("30")
    expect(row.personalBalanceAfter).toBe("100")
    expect(row.teamBalanceAfter).toBe("970")
    expect(row.consumeEventId).toBe("evt-1")
    // 事件级聚合：总额=各段合计 20+30=50；来源=个人赠送积分+企业套餐积分（按扣减顺序）
    expect(row.eventTotalCredits).toBe("50")
    expect(row.eventConsumeSources).toEqual([
      { consumeSource: "OWN_GIFT", label: "个人赠送积分", credits: "20" },
      { consumeSource: "TEAM_PACKAGE", label: "企业套餐积分", credits: "30" },
    ])
    // 兄弟段经 consumeEventId JSON 路径同批取回
    expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ meta: { path: "$.consumeEventId", equals: "evt-1" } }] },
      })
    )
  })

  it("混合事件分页按展示单元计：事件的各段不重复占行、不跨页重复出现", async () => {
    const mk = (id: number, teamId: number | null, eid: string | null, extra: object = {}) => ({
      id,
      userId: 1,
      direction: "DEBIT",
      bucket: teamId ? "PACKAGE" : "RECHARGE",
      type: teamId ? CreditTxnType.TEAM_CONSUME : CreditTxnType.CONSUME,
      amount: "1",
      balanceAfter: "100",
      source: "llm.generic",
      relatedUserId: null,
      teamId,
      meta: eid
        ? {
            consumeEventId: eid,
            ownershipSplit: {
              personal: "1",
              team: "1",
              personalBalanceAfter: "100",
              teamBalanceAfter: "200",
            },
          }
        : null,
      createdAt: new Date(),
      ...extra,
    })
    // desc 扫描序：evt-1（个人段→企业段）、evt-2（企业段→个人段）、单行 301
    const scan = [
      mk(306, null, "evt-1"),
      mk(305, 7, "evt-1"),
      mk(304, 7, "evt-2"),
      mk(303, null, "evt-2"),
      mk(301, null, null),
    ]
    const single = mk(301, null, null)
    prisma.creditTransaction.findMany
      .mockResolvedValueOnce(scan) // 事件章扫描
      .mockResolvedValueOnce([single]) // 第 2 页代表行
      .mockResolvedValueOnce([]) // 无事件兄弟（本页无事件行）
    // 展示单元 = evt-1、evt-2、单行 301 → 共 3 个；pageSize=2 的第 2 页只剩单行
    const res = await service.listTransactions(1, { page: 2, pageSize: 2 })
    expect(res.total).toBe(3)
    expect(res.totalPages).toBe(2)
    expect(res.items).toHaveLength(1)
    expect(res.items[0].consumeEventId).toBeNull()
  })

  it("四模块业务操作：同一 businessEventId 汇总成一条父记录并返回真实扣费明细", async () => {
    const createdAt = new Date("2026-09-09T06:00:00.000Z")
    const tokenRow = {
      id: 701,
      userId: 1,
      direction: "DEBIT",
      bucket: "RECHARGE",
      type: CreditTxnType.CONSUME,
      amount: "3",
      balanceAfter: "97",
      source: "listing.generate",
      relatedUserId: null,
      teamId: null,
      meta: {
        businessEventId: "listing-run-1",
        usageChargeId: "charge-token",
        operation: "generation",
        usageKind: "model",
      },
      createdAt,
    }
    const mcpRow = {
      ...tokenRow,
      id: 702,
      amount: "2",
      balanceAfter: "95",
      meta: {
        businessEventId: "listing-run-1",
        usageChargeId: "charge-mcp",
        operation: "mcp",
        usageKind: "mcp",
      },
    }
    prisma.creditTransaction.findMany
      .mockResolvedValueOnce([mcpRow, tokenRow])
      .mockResolvedValueOnce([mcpRow, tokenRow])

    const res = await service.listTransactions(1, {
      page: 1,
      pageSize: 10,
      direction: "DEBIT",
    } as never)

    expect(res.total).toBe(1)
    expect(res.items).toHaveLength(1)
    expect(res.items[0].amount.toString()).toBe("5")
    expect(res.items[0].businessEventId).toBe("listing-run-1")
    expect(res.items[0].businessGroupKey).toBe("business:listing.generate:listing-run-1")
    expect(res.items[0].businessDetails).toHaveLength(2)
    expect(res.items[0].businessDetails?.map(item => item.amount.toString())).toEqual(["3", "2"])
  })

  it("固定Listing生成25加优化5汇总30，保留优化明细", async () => {
    const createdAt = new Date("2026-09-09T06:00:00.000Z")
    const tokenRow = {
      id: 701,
      userId: 1,
      direction: "DEBIT",
      bucket: "RECHARGE",
      type: CreditTxnType.CONSUME,
      amount: "25",
      balanceAfter: "75",
      source: "listing.generate",
      relatedUserId: null,
      teamId: null,
      meta: {
        businessEventId: "listing-run-1",
        pricing: "fixed_module",
        usageChargeId: "charge-token",
        operation: "generation",
        usageKind: "model",
      },
      createdAt,
    }
    const mcpRow = {
      ...tokenRow,
      id: 702,
      amount: "5",
      balanceAfter: "70",
      meta: {
        businessEventId: "listing-run-1",
        pricing: "fixed_module",
        usageChargeId: "charge-mcp",
        operation: "optimization",
        usageKind: "mcp",
      },
    }
    prisma.creditTransaction.findMany
      .mockResolvedValueOnce([mcpRow, tokenRow])
      .mockResolvedValueOnce([mcpRow, tokenRow])

    const res = await service.listTransactions(1, {
      page: 1,
      pageSize: 10,
      direction: "DEBIT",
    } as never)

    expect(res.total).toBe(1)
    expect(res.items).toHaveLength(1)
    expect(res.items[0].amount.toString()).toBe("30")
    expect(res.items[0].businessEventId).toBe("listing-run-1")
    expect(res.items[0].businessGroupKey).toBe("business:listing.generate:listing-run-1")
    expect(res.items[0].businessDetails).toHaveLength(2)
    expect(res.items[0].businessDetails?.map(item => item.amount.toString())).toEqual(["25", "5"])
  })

  it("类目分析按任务合并关键词取数、多类目取数和AI扣费，分页不拆开历史流水", async () => {
    const row = (
      id: number,
      eventId: string,
      amount: string,
      categoryId: string,
      usageKind: string
    ) => ({
      id,
      userId: 1,
      direction: "DEBIT",
      bucket: "RECHARGE",
      type: CreditTxnType.CONSUME,
      amount,
      balanceAfter: String(6000 - id),
      source: "category.analysis",
      relatedUserId: null,
      teamId: null,
      meta: {
        businessEventId: eventId,
        analysisId: eventId === "analysis-1" ? 1 : 2,
        categoryId,
        usageKind,
        usageChargeId: `charge-${id}`,
      },
      createdAt: new Date(`2026-09-18T09:${id - 800}:00.000Z`),
    })
    const taskRows = [
      row(805, "analysis-1", "1", "cat-b", "model"),
      row(804, "analysis-1", "62", "cat-b", "mcp"),
      row(803, "analysis-1", "1", "cat-a", "model"),
      row(802, "analysis-1", "61", "cat-a", "mcp"),
      row(801, "analysis-1", "1", "keyword-resolution", "mcp"),
    ]
    prisma.creditTransaction.findMany
      .mockResolvedValueOnce([...taskRows, row(800, "analysis-2", "2", "cat-a", "model")])
      .mockResolvedValueOnce(taskRows)

    const res = await service.listTransactions(1, {
      page: 1,
      pageSize: 1,
      direction: "DEBIT",
    } as never)

    expect(res.total).toBe(2)
    expect(res.totalPages).toBe(2)
    expect(res.items).toHaveLength(1)
    expect(res.items[0].amount.toString()).toBe("126")
    expect(res.items[0].balanceAfter.toString()).toBe("5195")
    expect(res.items[0].businessGroupKey).toBe("business:category.analysis:analysis-1")
    expect(res.items[0].businessDetails).toHaveLength(5)
    expect(res.items[0].businessDetails?.map(item => item.amount.toString())).toEqual([
      "1",
      "61",
      "1",
      "62",
      "1",
    ])
    expect(prisma.creditTransaction.findMany.mock.calls[1][0].where.id.in).toEqual([
      805, 804, 803, 802, 801,
    ])
  })

  it("Listing 生成与 Listing 评分即使 businessEventId 相同也分别显示", async () => {
    const row = (id: number, source: string) => ({
      id,
      userId: 1,
      direction: "DEBIT",
      bucket: "RECHARGE",
      type: CreditTxnType.CONSUME,
      amount: "1",
      balanceAfter: "99",
      source,
      relatedUserId: null,
      teamId: null,
      meta: { businessEventId: "listing-run-2", usageChargeId: `charge-${id}` },
      createdAt: new Date(),
    })
    const generateRow = row(711, "listing.generate")
    const scoreRow = row(712, "listing.score")
    prisma.creditTransaction.findMany
      .mockResolvedValueOnce([scoreRow, generateRow])
      .mockResolvedValueOnce([scoreRow, generateRow])

    const res = await service.listTransactions(1, {
      page: 1,
      pageSize: 10,
      direction: "DEBIT",
    } as never)

    expect(res.total).toBe(2)
    expect(res.items.map(item => item.source)).toEqual(["listing.score", "listing.generate"])
  })

  it("旧 Listing 流水：通过 listingHistoryId/listingRunId 关联成同一条父记录", async () => {
    const row = (id: number, meta: Record<string, unknown>) => ({
      id,
      userId: 1,
      direction: "DEBIT",
      bucket: "RECHARGE",
      type: CreditTxnType.CONSUME,
      amount: "1",
      balanceAfter: "99",
      source: "listing.generate",
      relatedUserId: null,
      teamId: null,
      meta,
      createdAt: new Date(),
    })
    const modelRow = row(721, {
      listingHistoryId: 328,
      listingStepId: 13,
      operation: "generation",
    })
    const mcpRow = row(722, {
      listingRunId: "legacy-listing-run",
      operation: "mcp",
    })
    prisma.listingRun.findMany.mockResolvedValue([{ historyId: 328, runId: "legacy-listing-run" }])
    prisma.creditTransaction.findMany
      .mockResolvedValueOnce([mcpRow, modelRow])
      .mockResolvedValueOnce([mcpRow, modelRow])

    const res = await service.listTransactions(1, {
      page: 1,
      pageSize: 10,
      direction: "DEBIT",
    } as never)

    expect(res.total).toBe(1)
    expect(res.items[0].businessEventId).toBe("legacy-listing-run")
    expect(res.items[0].amount.toString()).toBe("2")
    expect(res.items[0].businessDetails).toHaveLength(2)
  })

  it("混合扣费事件：代表行取企业段，个人段金额/来源经事件兄弟查询补齐", async () => {
    const teamRow = {
      id: 304,
      userId: 1,
      direction: "DEBIT",
      bucket: "PACKAGE",
      type: CreditTxnType.TEAM_CONSUME,
      amount: "1",
      balanceAfter: "54996",
      source: "llm.generic",
      relatedUserId: null,
      teamId: 7,
      meta: {
        consumeEventId: "evt-2",
        ownershipSplit: {
          personal: "2",
          team: "1",
          personalBalanceAfter: "7186",
          teamBalanceAfter: "54996",
        },
      },
      createdAt: new Date(),
    }
    const personalRow = {
      id: 305,
      userId: 1,
      direction: "DEBIT",
      bucket: "RECHARGE",
      type: CreditTxnType.CONSUME,
      amount: "2",
      balanceAfter: "7186",
      source: "llm.generic",
      relatedUserId: null,
      teamId: null,
      meta: {
        consumeEventId: "evt-2",
        ownershipSplit: {
          personal: "2",
          team: "1",
          personalBalanceAfter: "7186",
          teamBalanceAfter: "54996",
        },
      },
      createdAt: new Date(),
    }
    prisma.creditTransaction.findMany
      .mockResolvedValueOnce([teamRow, personalRow]) // 事件章扫描
      .mockResolvedValueOnce([teamRow]) // 代表行（企业段）取回
      .mockResolvedValueOnce([teamRow, personalRow]) // 事件兄弟段聚合
    const res = await service.listTransactions(1, { page: 1, pageSize: 10 })
    expect(res.total).toBe(1) // 合并为一行
    expect(res.items).toHaveLength(1)
    const row = res.items[0]
    expect(row.amount).toBe("1") // 行级仍是本段（企业段）
    expect(row.eventTotalCredits).toBe("3") // 事件总额=企业1+个人2
    expect(row.eventConsumeSources).toEqual([
      { consumeSource: "TEAM_PACKAGE", label: "企业套餐积分", credits: "1" },
      { consumeSource: "OWN_RECHARGE", label: "个人充值积分", credits: "2" },
    ])
    expect(row.ownerships).toEqual(["PERSONAL", "TEAM"])
    expect(row.personalCredits).toBe("2")
    expect(row.teamCredits).toBe("1")
  })

  it("记录隔离·企业管理员：默认范围 = 本人行 ∪ 本企业池行（teamId）", async () => {
    prisma.teamMember.findFirst.mockResolvedValue({ teamId: 7 }) // ADMIN 成员
    await service.listTransactions(1, { page: 1, pageSize: 10, direction: "DEBIT" } as never)
    expect(andOf()).toContainEqual({ OR: [{ userId: 1 }, { teamId: 7 }] })
  })

  it("记录隔离·企业管理员：consumerUserId=成员 id → 该成员的企业池行；self → 仅本人行", async () => {
    prisma.teamMember.findFirst.mockResolvedValue({ teamId: 7 })
    await service.listTransactions(1, { page: 1, pageSize: 10, consumerUserId: "63" })
    expect(andOf()).toContainEqual({ teamId: 7, userId: 63 })
    prisma.creditTransaction.findMany.mockClear()
    await service.listTransactions(1, { page: 1, pageSize: 10, consumerUserId: "self" })
    expect(andOf()).toContainEqual({ userId: 1 })
    expect(andOf().some(c => Array.isArray((c as { OR?: unknown[] }).OR))).toBe(false)
  })

  it("记录隔离·企业成员（非管理员）：维持仅本人行", async () => {
    prisma.teamMember.findFirst.mockResolvedValue(null) // 非 ADMIN
    await service.listTransactions(63, { page: 1, pageSize: 10, direction: "DEBIT" } as never)
    expect(andOf()).toContainEqual({ userId: 63 })
    // 不走管理员的 OR 放宽分支
    expect(andOf().some(c => Array.isArray((c as { OR?: unknown[] }).OR))).toBe(false)
  })

  it("记录隔离·池行的使用用户 = 行属主（管理员看成员扣减行显示成员名）", async () => {
    prisma.teamMember.findFirst.mockResolvedValue({ teamId: 7 })
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 401,
        userId: 63, // 成员小雅的企业池扣减行
        direction: "DEBIT",
        bucket: "PACKAGE",
        type: CreditTxnType.TEAM_CONSUME,
        amount: "30",
        balanceAfter: "970",
        source: "listing.generate",
        relatedUserId: null,
        teamId: 7,
        meta: null,
        createdAt: new Date(),
      },
      {
        id: 402,
        userId: 1, // 管理员自己的池行 → 本人
        direction: "DEBIT",
        bucket: "PACKAGE",
        type: CreditTxnType.TEAM_CONSUME,
        amount: "10",
        balanceAfter: "960",
        source: "listing.score",
        relatedUserId: null,
        teamId: 7,
        meta: null,
        createdAt: new Date(),
      },
    ])
    prisma.user.findMany.mockResolvedValue([{ id: 63, username: "小雅" }])
    const res = await service.listTransactions(1, { page: 1, pageSize: 10 })
    expect(res.items[0].consumerUserId).toBe(63)
    expect(res.items[0].consumerName).toBe("小雅")
    expect(res.items[1].consumerUserId).toBeNull()
    expect(res.items[1].consumerName).toBe("本人")
  })

  it("被邀请人视角：动用邀请人额度的行，balanceAfter 展示邀请人侧扣后余额（2026-09-01 bug13 产品口径）", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, invitedById: 2 }) // LV4
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 230,
        userId: 2, // 记在邀请人账上
        direction: "DEBIT",
        bucket: "RECHARGE",
        type: CreditTxnType.CONSUME,
        amount: "3",
        balanceAfter: "8997", // 存的是邀请人池余额
        source: "listing.score",
        relatedUserId: 7, // 实际消费者=自己
        meta: { consumerBalanceAfter: "-3" }, // 旧快照字段，读侧已不使用
        createdAt: new Date(),
      },
    ])
    const res = await service.listTransactions(7, { page: 1, pageSize: 10 })
    expect(res.items[0].balanceAfter).toBe("8997") // 邀请人扣后余额（不再显示消费者自己的 -3）
  })

  it("手动调减(MANUAL_ADJUST/DEBIT)：扣费来源归个人充值积分 OWN_RECHARGE（手动只动 RECHARGE）", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, invitedById: 2 }) // LV4
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 228,
        userId: 7,
        direction: "DEBIT",
        bucket: "RECHARGE",
        type: CreditTxnType.MANUAL_ADJUST,
        amount: "400",
        balanceAfter: "193",
        source: "admin.recharge.manual",
        relatedUserId: null,
        meta: { reason: "后台手动扣减" },
        createdAt: new Date(),
      },
    ])
    const res = await service.listTransactions(7, { page: 1, pageSize: 10 })
    expect(res.items[0].consumeSource).toBe("OWN_RECHARGE")
    expect(res.items[0].consumeSourceLabel).toBe("个人充值积分")
  })

  it("成员赠送积分转出：归个人赠送积分，支持同口径筛选和中文项目名", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, invitedById: null })
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 240,
        userId: 7,
        direction: "DEBIT",
        bucket: "GIFT",
        type: CreditTxnType.MANUAL_ADJUST,
        amount: "200",
        balanceAfter: "300",
        source: "team.member.gift.transfer",
        teamId: null,
        relatedUserId: null,
        meta: { injectToTeamId: 11 },
        createdAt: new Date(),
      },
    ])

    const res = await service.listTransactions(7, {
      page: 1,
      pageSize: 10,
      consumeSource: "OWN_GIFT",
    } as never)

    expect(res.items[0]).toMatchObject({
      consumeSource: "OWN_GIFT",
      consumeSourceLabel: "个人赠送积分",
      title: "个人赠送积分转入企业共享池",
    })
    expect(andOf()).toContainEqual({
      userId: 7,
      relatedUserId: null,
      teamId: null,
      bucket: "GIFT",
      OR: [
        { type: CreditTxnType.CONSUME },
        { type: CreditTxnType.MANUAL_ADJUST, direction: "DEBIT" },
      ],
    })
  })

  it("手动调增(MANUAL_ADJUST/CREDIT)：入账非扣费 → consumeSource 为 null", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, invitedById: 2 }) // LV4
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 229,
        userId: 7,
        direction: "CREDIT",
        bucket: "RECHARGE",
        type: CreditTxnType.MANUAL_ADJUST,
        amount: "400",
        balanceAfter: "593",
        source: "admin.recharge.manual",
        relatedUserId: null,
        meta: null,
        createdAt: new Date(),
      },
    ])
    const res = await service.listTransactions(7, { page: 1, pageSize: 10 })
    expect(res.items[0].consumeSource).toBeNull()
    expect(res.items[0].consumeSourceLabel).toBeNull()
  })

  it("被邀请人(LV4)：consumeSource=个人充值积分 → 含 CONSUME 与手动调减(MANUAL_ADJUST/DEBIT)", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, invitedById: 2 })
    await service.listTransactions(7, {
      page: 1,
      pageSize: 10,
      consumeSource: "OWN_RECHARGE",
    } as never)
    expect(andOf()).toContainEqual({
      userId: 7,
      relatedUserId: null,
      teamId: null, // 个人侧（池行归 TEAM_*，不串扰）
      bucket: "RECHARGE",
      OR: [
        { type: CreditTxnType.CONSUME },
        { type: CreditTxnType.MANUAL_ADJUST, direction: "DEBIT" },
      ],
    })
  })

  it("普通用户也支持 consumeSource 筛选（不再仅限 LV4）", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, invitedById: null }) // 普通用户
    await service.listTransactions(3, {
      page: 1,
      pageSize: 10,
      consumeSource: "OWN_PACKAGE",
    } as never)
    // 个人套餐积分 = 消费扣 PACKAGE ∪ 客服补偿扣回（赠送层合池扣减，bucket=null）
    expect(andOf()).toContainEqual({
      userId: 3,
      relatedUserId: null,
      teamId: null, // 个人侧（池行归 TEAM_*，不串扰）
      OR: [
        { type: CreditTxnType.CONSUME, bucket: "PACKAGE" },
        { type: CreditTxnType.MANUAL_ADJUST, direction: "DEBIT", bucket: null },
      ],
    })
  })

  it("后台积分扣减(MANUAL_ADJUST/DEBIT/bucket=null)：扣费来源归个人套餐积分 OWN_PACKAGE", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, invitedById: null })
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 230,
        userId: 3,
        direction: "DEBIT",
        bucket: null,
        type: CreditTxnType.MANUAL_ADJUST,
        amount: "100",
        balanceAfter: "18300",
        source: "客服补偿赠送",
        relatedUserId: null,
        meta: { compensation: true, giftCredits: -100 },
        createdAt: new Date(),
      },
    ])
    const res = await service.listTransactions(3, { page: 1, pageSize: 10 })
    expect(res.items[0].consumeSource).toBe("OWN_PACKAGE")
    expect(res.items[0].consumeSourceLabel).toBe("个人套餐积分")
    expect(res.items[0].title).toBe("后台积分扣减")
    expect(res.items[0].category).toBe("手动调整")
  })

  it("企业池消费行（TEAM_CONSUME）：按 bucket 归企业套餐/充值/赠送积分", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, invitedById: null })
    const mk = (id: number, bucket: string) => ({
      id,
      userId: 3,
      direction: "DEBIT",
      bucket,
      type: CreditTxnType.TEAM_CONSUME,
      amount: "5",
      balanceAfter: "100",
      source: "listing.generate",
      relatedUserId: null,
      teamId: 10,
      meta: null,
      createdAt: new Date(),
    })
    prisma.creditTransaction.findMany.mockResolvedValue([
      mk(301, "PACKAGE"),
      mk(302, "RECHARGE"),
      mk(303, "GIFT"),
    ])
    const res = await service.listTransactions(3, { page: 1, pageSize: 10 })
    expect(res.items.map(i => [i.consumeSource, i.consumeSourceLabel])).toEqual([
      ["TEAM_PACKAGE", "企业套餐积分"],
      ["TEAM_RECHARGE", "企业充值积分"],
      ["TEAM_GIFT", "企业赠送积分"],
    ])
  })

  it("企业池调整扣减行（MANUAL_ADJUST/DEBIT/teamId）→ 企业充值积分", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, invitedById: null })
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 304,
        userId: 3,
        direction: "DEBIT",
        bucket: "RECHARGE",
        type: CreditTxnType.MANUAL_ADJUST,
        amount: "100",
        balanceAfter: "9900",
        source: "admin.team.adjust",
        relatedUserId: null,
        teamId: 10,
        meta: null,
        createdAt: new Date(),
      },
    ])
    const res = await service.listTransactions(3, { page: 1, pageSize: 10 })
    expect(res.items[0].consumeSource).toBe("TEAM_RECHARGE")
    expect(res.items[0].consumeSourceLabel).toBe("企业充值积分")
    expect(res.items[0].title).toBe("企业池调整")
  })

  it("企业管理员 consumeSource=TEAM_PACKAGE → 本企业全部池行（teamId 约束）", async () => {
    prisma.teamMember.findFirst.mockResolvedValue({ teamId: 7 }) // 我是 team 7 的 ADMIN
    await service.listTransactions(1, {
      page: 1,
      pageSize: 10,
      consumeSource: "TEAM_PACKAGE",
    } as never)
    expect(andOf()).toContainEqual({
      teamId: 7,
      type: CreditTxnType.TEAM_CONSUME,
      bucket: "PACKAGE",
    })
  })

  it("企业管理员 consumeSource=TEAM_RECHARGE → 池消费 RECHARGE ∪ 池调整扣减", async () => {
    prisma.teamMember.findFirst.mockResolvedValue({ teamId: 7 })
    await service.listTransactions(1, {
      page: 1,
      pageSize: 10,
      consumeSource: "TEAM_RECHARGE",
    } as never)
    expect(andOf()).toContainEqual({
      teamId: 7,
      bucket: "RECHARGE",
      OR: [
        { type: CreditTxnType.TEAM_CONSUME },
        { type: CreditTxnType.MANUAL_ADJUST, direction: "DEBIT" },
      ],
    })
  })

  it("企业成员（非管理员）consumeSource=TEAM_GIFT → 仅本人池行（记录隔离）", async () => {
    // teamMember.findFirst 默认 null → 非管理员
    await service.listTransactions(3, {
      page: 1,
      pageSize: 10,
      consumeSource: "TEAM_GIFT",
    } as never)
    expect(andOf()).toContainEqual({
      userId: 3,
      teamId: { not: null },
      type: CreditTxnType.TEAM_CONSUME,
      bucket: "GIFT",
    })
  })

  it("类型筛选拆分：type=MANUAL_ADJUST 排除正向补偿发放；type=GIFT_COMPENSATE 仅正向补偿", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, invitedById: null })
    const commonOfCall = (i: number) =>
      (
        prisma.creditTransaction.findMany.mock.calls as unknown as Array<
          [{ where: { AND: unknown[] } }]
        >
      )[i][0].where.AND[0]

    await service.listTransactions(3, {
      page: 1,
      pageSize: 10,
      type: "MANUAL_ADJUST",
    })
    expect(commonOfCall(0)).toMatchObject({
      type: "MANUAL_ADJUST",
      NOT: { direction: "CREDIT", meta: { path: "$.compensation", equals: true } },
    })

    // 每次调用含事件章扫描 + 分页两次 findMany，清零后按本次首调用取 where
    prisma.creditTransaction.findMany.mockClear()
    await service.listTransactions(3, {
      page: 1,
      pageSize: 10,
      type: "GIFT_COMPENSATE",
    })
    expect(commonOfCall(0)).toMatchObject({
      type: "MANUAL_ADJUST",
      direction: "CREDIT",
      meta: { path: "$.compensation", equals: true },
    })
  })

  it("收据列：在线单按 meta.orderNo 关联 receiptNo；后台人工充值未开票 → canClaimReceipt=true", async () => {
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 1,
        userId: 1,
        direction: "CREDIT",
        bucket: "RECHARGE",
        type: CreditTxnType.RECHARGE_PACK,
        amount: "300",
        balanceAfter: "300",
        source: "billing.order",
        relatedUserId: null,
        meta: { orderNo: "SR001", priceCny: 30 },
        createdAt: new Date(),
      },
      {
        id: 2,
        userId: 1,
        direction: "CREDIT",
        bucket: "RECHARGE",
        type: CreditTxnType.RECHARGE_CUSTOM,
        amount: "500",
        balanceAfter: "800",
        source: "admin.recharge.custom",
        relatedUserId: null,
        meta: { priceCny: 50 },
        createdAt: new Date(),
      },
      {
        id: 3,
        userId: 1,
        direction: "CREDIT",
        bucket: "RECHARGE",
        type: CreditTxnType.MANUAL_ADJUST,
        amount: "100",
        balanceAfter: "900",
        source: "admin.recharge.manual",
        relatedUserId: null,
        meta: { reason: "客服补" },
        createdAt: new Date(),
      },
    ])
    prisma.receipt.findMany.mockResolvedValue([
      { receiptNo: "SR100", manualRef: null, order: { orderNo: "SR001" } },
    ])

    const res = await service.listTransactions(1, { page: 1, pageSize: 10 })

    // 在线单已开票 → 收据编号，不可补开
    expect(res.items[0].receiptNo).toBe("SR100")
    expect(res.items[0].canClaimReceipt).toBe(false)
    // 后台人工充值（真实收款类型）且未开票 → 可补开
    expect(res.items[1].receiptNo).toBeNull()
    expect(res.items[1].canClaimReceipt).toBe(true)
    // 手动调整无付款事实 → 不可开
    expect(res.items[2].receiptNo).toBeNull()
    expect(res.items[2].canClaimReceipt).toBe(false)
    // 收据查询按 orderNo + manualRef 双通道批量关联
    expect(prisma.receipt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { order: { orderNo: { in: ["SR001"] } } },
            { manualRef: { in: ["txn:1", "txn:2", "txn:3"] } },
          ],
        },
      })
    )
  })

  it("收据列：已补开的人工充值（manualRef=txn:id）返回 receiptNo，不再可补开", async () => {
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 2,
        userId: 1,
        direction: "CREDIT",
        bucket: "RECHARGE",
        type: CreditTxnType.RECHARGE_PACK,
        amount: "100",
        balanceAfter: "100",
        source: "admin.recharge.pack",
        relatedUserId: null,
        meta: { priceCny: 10 },
        createdAt: new Date(),
      },
    ])
    prisma.receipt.findMany.mockResolvedValue([
      { receiptNo: "SR200", manualRef: "txn:2", order: null },
    ])

    const res = await service.listTransactions(1, { page: 1, pageSize: 10 })

    expect(res.items[0].receiptNo).toBe("SR200")
    expect(res.items[0].canClaimReceipt).toBe(false)
  })
})

describe("WalletService.getTransactionOptions", () => {
  let service: WalletService
  let prisma: {
    user: { findUnique: jest.Mock; findMany: jest.Mock }
    teamMember: { findFirst: jest.Mock; findMany: jest.Mock }
  }

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      // 默认非企业管理员；企业管理员用例按需覆盖
      teamMember: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
    }
    const module = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: {} },
      ],
    }).compile()
    service = module.get(WalletService)
  })

  it("所有用户一致返回 buckets + consumeSources，不区分等级", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false }) // 普通用户
    const res = await service.getTransactionOptions(1)
    expect(res.buckets?.map(o => o.value)).toEqual(["", "RECHARGE", "PACKAGE", "GIFT"])
    // 扣费来源：个人 3 + 邀请人 2 + 企业 3（与列表「扣费来源」列同枚举，一一对应）
    expect(res.consumeSources?.map(o => o.value)).toEqual([
      "",
      "OWN_PACKAGE",
      "OWN_RECHARGE",
      "OWN_GIFT",
      "INVITER_GIFT",
      "INVITER_RECHARGE",
      "TEAM_PACKAGE",
      "TEAM_RECHARGE",
      "TEAM_GIFT",
    ])
    // 积分归属筛选（个人/企业）同样所有用户一致下发
    expect(res.ownerships?.map(o => o.value)).toEqual(["", "PERSONAL", "TEAM"])
    expect(res.ownerships?.map(o => o.label)).toEqual(["全部", "个人", "企业"])
  })

  it("LV5(邀请人)：buckets + consumeSources 之外额外返回 consumers（本人 + 各下级）", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: true })
    prisma.user.findMany.mockResolvedValue([{ id: 9, username: "李婷" }])
    const res = await service.getTransactionOptions(2)
    expect(res.buckets).toHaveLength(4) // 桶粗筛
    expect(res.consumeSources).toHaveLength(9) // 扣费来源细分（个人 3 + 邀请人 2 + 企业 3）
    expect((res as { consumers?: { value: string; label: string }[] }).consumers).toEqual([
      { value: "self", label: "本人" },
      { value: "9", label: "李婷" },
    ])
  })

  it("企业管理员：consumers = 本人 + 本企业成员（排除 ARCHIVED；本人不重复）", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false })
    prisma.teamMember.findFirst.mockResolvedValue({ teamId: 7 }) // 我是 team 7 的 ADMIN
    prisma.teamMember.findMany.mockResolvedValue([
      { userId: 1, user: { username: "我" } },
      { userId: 63, user: { username: "小雅" } },
      { userId: 74, user: { username: "QA" } },
    ])
    const res = await service.getTransactionOptions(1)
    expect((res as { consumers?: { value: string; label: string }[] }).consumers).toEqual([
      { value: "self", label: "本人" },
      { value: "63", label: "小雅" },
      { value: "74", label: "QA" },
    ])
  })

  it("普通用户（非邀请人非管理员）：不下发 consumers", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false })
    const res = await service.getTransactionOptions(1)
    expect((res as { consumers?: unknown }).consumers).toBeUndefined()
  })
})

describe("WalletService.getWallet 批次明细（lots）", () => {
  let service: WalletService
  let creditLot: { findMany: jest.Mock }

  const lot = (over: Record<string, unknown>) => ({
    id: 1,
    bucket: "PACKAGE",
    sourceType: "RECHARGE_PLAN",
    sourceRef: "SR2026",
    amount: "2200",
    remaining: "1500",
    grantedAt: new Date("2026-08-01"),
    expiresAt: new Date(Date.now() + 30 * 86400000), // 30 天后
    status: "ACTIVE",
    ...over,
  })

  beforeEach(async () => {
    creditLot = { findMany: jest.fn().mockResolvedValue([]) }
    const prisma = {
      user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      teamMember: { findFirst: jest.fn().mockResolvedValue(null), count: jest.fn() },
      creditLot,
      // 批次「来源」富标签的批量关联查询（默认空 → 走兜底标签）
      billingOrder: { findMany: jest.fn().mockResolvedValue([]) },
      rechargePack: { findMany: jest.fn().mockResolvedValue([]) },
      scheduledPlan: { findMany: jest.fn().mockResolvedValue([]) },
      membershipPlan: { findMany: jest.fn().mockResolvedValue([]) },
    }
    const module = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: CreditService,
          useValue: { getWallet: jest.fn().mockResolvedValue({ buckets: {} }) },
        },
      ],
    }).compile()
    service = module.get(WalletService)
    // resolveIdentityView 非团队路径要读 user
    prisma.user.findUnique.mockResolvedValue({
      canInvite: false,
      subscriptionTier: null,
      subscriptionExpiresAt: null,
    })
  })

  it("只查个人批次（teamId=null），按获得时间倒序封顶 100", async () => {
    const prisma = (service as never as { prisma: { creditLot: { findMany: jest.Mock } } }).prisma
    await service.getWallet(1)
    expect(prisma.creditLot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 1, teamId: null },
        orderBy: { grantedAt: "desc" },
        take: 100,
      })
    )
  })

  it("字段映射：总额/已用/剩余 + 中文标签", async () => {
    creditLot.findMany.mockResolvedValue([lot({})])
    const r = await service.getWallet(1)
    const l = (r as { lots: Record<string, unknown>[] }).lots[0]
    expect(l).toMatchObject({
      bucket: "PACKAGE",
      bucketLabel: "套餐积分",
      sourceType: "RECHARGE_PLAN",
      sourceLabel: "会员套餐",
      sourceRef: "SR2026",
      amount: "2200",
      used: "700", // 2200 - 1500
      remaining: "1500",
      status: "ACTIVE",
      statusLabel: "生效中",
    })
  })

  it("状态推导：到期已过（即使每日任务未跑）→ 已过期；剩余 0 → 已用完", async () => {
    creditLot.findMany.mockResolvedValue([
      lot({ id: 1, expiresAt: new Date(Date.now() - 1000), status: "ACTIVE" }),
      lot({ id: 2, remaining: "0", expiresAt: null }),
      lot({ id: 3, bucket: "RECHARGE", sourceType: "RECHARGE_PACK", expiresAt: null }),
    ])
    const r = await service.getWallet(1)
    const lots = (r as { lots: { status: string; statusLabel: string }[] }).lots
    expect(lots[0].status).toBe("EXPIRED")
    expect(lots[1].status).toBe("EXHAUSTED")
    expect(lots[2].status).toBe("ACTIVE")
    expect(lots[2].statusLabel).toBe("生效中")
  })

  it("积分类型/来源按原型口径给富标签（套餐/随赠/注册/充值包/自定义/升级/补偿）", async () => {
    const prisma = (
      service as never as {
        prisma: {
          billingOrder: { findMany: jest.Mock }
          rechargePack: { findMany: jest.Mock }
          scheduledPlan: { findMany: jest.Mock }
          membershipPlan: { findMany: jest.Mock }
        }
      }
    ).prisma
    // 关联数据：plan:LV1 → Explorer；pack:2 → ¥100；订单 SR9 → Plus 套餐快照、SR10 → 升级快照
    prisma.membershipPlan.findMany.mockResolvedValue([{ tier: 1, name: "Explorer" }])
    prisma.rechargePack.findMany.mockResolvedValue([{ id: 2, priceCny: "100" }])
    prisma.billingOrder.findMany.mockResolvedValue([
      { orderNo: "SR9", snapshot: { kind: "plan", tier: 2, planName: "Plus" } },
      { orderNo: "SR10", snapshot: { kind: "upgrade", fromTier: 1, toTier: 2 } },
    ])

    creditLot.findMany.mockResolvedValue([
      lot({ id: 1, bucket: "PACKAGE", sourceType: "RECHARGE_PLAN", sourceRef: "plan:LV1" }),
      lot({ id: 2, bucket: "GIFT", sourceType: "RECHARGE_PLAN", sourceRef: "plan:LV1" }),
      lot({ id: 3, bucket: "GIFT", sourceType: "SIGNUP_BONUS", sourceRef: null }),
      lot({ id: 4, bucket: "RECHARGE", sourceType: "RECHARGE_PACK", sourceRef: "pack:2" }),
      lot({ id: 5, bucket: "GIFT", sourceType: "RECHARGE_PACK", sourceRef: "pack:2" }),
      lot({ id: 6, bucket: "RECHARGE", sourceType: "RECHARGE_CUSTOM", sourceRef: "custom:66.5" }),
      lot({ id: 7, bucket: "GIFT", sourceType: "MANUAL_ADJUST", sourceRef: null }),
      lot({ id: 8, bucket: "PACKAGE", sourceType: "RECHARGE_PLAN", sourceRef: "SR9" }),
      lot({ id: 9, bucket: "GIFT", sourceType: "RECHARGE_PLAN", sourceRef: "SR10" }),
      lot({
        id: 10,
        bucket: "RECHARGE",
        sourceType: "RECHARGE_PLAN",
        sourceRef: "upgrade:LV1->LV2",
      }),
    ])
    const r = await service.getWallet(1)
    const lots = (r as { lots: { bucketLabel: string; sourceLabel: string }[] }).lots
    const got = lots.map(l => [l.bucketLabel, l.sourceLabel])
    expect(got).toEqual([
      ["套餐积分", "Lv.1 Explorer 月度套餐"],
      ["套餐赠送积分", "Lv.1 套餐随赠"],
      ["活动赠送积分", "新用户注册赠送"],
      ["充值包积分", "¥100 充值包"],
      ["活动赠送积分", "¥100 充值包赠送"],
      ["充值积分", "¥66.50 自定义充值"],
      ["活动赠送积分", "后台积分发放"],
      ["套餐积分", "Lv.2 Plus 月度套餐"],
      ["套餐赠送积分", "会员升级补差（Lv.1 → Lv.2）"],
      ["充值积分", "会员升级补差（Lv.1 → Lv.2）"],
    ])
  })
})

/** 身份视图：SUB_ACTIVE / SUB_EXPIRED 按「有效期」推导（到期降级后 tier 会被置空，不能只看 tier）。 */
describe("WalletService.getWallet 身份视图", () => {
  let service: WalletService
  let prisma: { user: { findUnique: jest.Mock } }

  beforeEach(async () => {
    prisma = { user: { findUnique: jest.fn() } }
    const module = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: PrismaService,
          useValue: {
            user: prisma.user,
            teamMember: { findFirst: jest.fn().mockResolvedValue(null), count: jest.fn() },
            creditLot: { findMany: jest.fn().mockResolvedValue([]) },
            billingOrder: { findMany: jest.fn().mockResolvedValue([]) },
            rechargePack: { findMany: jest.fn().mockResolvedValue([]) },
            scheduledPlan: { findMany: jest.fn().mockResolvedValue([]) },
            membershipPlan: { findMany: jest.fn().mockResolvedValue([]) },
          },
        },
        {
          provide: CreditService,
          useValue: { getWallet: jest.fn().mockResolvedValue({ buckets: {} }) },
        },
      ],
    }).compile()
    service = module.get(WalletService)
  })

  const identityOf = async () => (await service.getWallet(1)) as { identity: string }

  it("在期订阅 → SUB_ACTIVE", async () => {
    prisma.user.findUnique.mockResolvedValue({
      canInvite: false,
      subscriptionExpiresAt: new Date(Date.now() + 86400000),
    })
    expect((await identityOf()).identity).toBe("SUB_ACTIVE")
  })

  it("已过期订阅（tier 尚未被每日任务置空）→ SUB_EXPIRED", async () => {
    prisma.user.findUnique.mockResolvedValue({
      canInvite: false,
      subscriptionExpiresAt: new Date(Date.now() - 86400000),
    })
    expect((await identityOf()).identity).toBe("SUB_EXPIRED")
  })

  it("已过期且 tier 已被降级任务置空 → 仍 SUB_EXPIRED（按 expiresAt 判定）", async () => {
    prisma.user.findUnique.mockResolvedValue({
      canInvite: false,
      subscriptionExpiresAt: new Date(Date.now() - 10 * 86400000),
    })
    expect((await identityOf()).identity).toBe("SUB_EXPIRED")
  })

  it("从未订阅 → NONE；邀请人 → DISTRIBUTOR（canInvite 同步下发）", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false, subscriptionExpiresAt: null })
    let w = (await service.getWallet(1)) as { identity: string; canInvite: boolean }
    expect(w.identity).toBe("NONE")
    expect(w.canInvite).toBe(false)
    prisma.user.findUnique.mockResolvedValue({ canInvite: true, subscriptionExpiresAt: null })
    w = await service.getWallet(1)
    expect(w.identity).toBe("DISTRIBUTOR")
    expect(w.canInvite).toBe(true)
  })

  it("邀请权读落库值（2026-09-01 起落库制，废读时派生）：canInvite=false 即 NONE，上级开关不再影响读侧", async () => {
    // 上级开了「下级可继续邀请」时，下级 canInvite 已被批量落库为 true；读侧只看本人落库值
    prisma.user.findUnique.mockResolvedValue({
      canInvite: false,
      subscriptionExpiresAt: null,
    })
    const w = (await service.getWallet(1)) as { identity: string; canInvite: boolean }
    expect(w.identity).toBe("NONE")
    expect(w.canInvite).toBe(false)
  })
})

describe("WalletService.getWallet 团队块（池余额/已用）", () => {
  let service: WalletService
  let prisma: {
    user: { findUnique: jest.Mock }
    teamMember: { findFirst: jest.Mock; count: jest.Mock }
    creditLot: { findMany: jest.Mock; groupBy: jest.Mock }
    creditTransaction: { aggregate: jest.Mock }
  }

  const membership = {
    role: "ADMIN",
    monthlyQuota: null,
    quotaUsedThisMonth: 0,
    quotaMonth: null,
    team: {
      id: 10,
      name: "Acme",
      nameFilled: true,
      source: "CUSTOM",
      status: "ACTIVE",
      tier: null,
      seats: 20,
      quotaMode: "SHARED",
      overLimitPolicy: "BLOCK",
      discount: "0.8",
      expiresAt: new Date(Date.now() + 30 * 86400000),
      graceUntil: null,
      dataKeepUntil: null,
      admin: { username: "boss_zhang" },
    },
  }

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ canInvite: false }) }, // 分销身份（默认非邀请人）
      teamMember: {
        findFirst: jest.fn().mockResolvedValue(membership),
        count: jest.fn().mockResolvedValue(3),
      },
      creditLot: {
        findMany: jest.fn().mockResolvedValue([]), // 个人批次明细
        groupBy: jest.fn().mockResolvedValue([
          { bucket: "PACKAGE", _sum: { remaining: 1000 } },
          { bucket: "GIFT", _sum: { remaining: 200 } },
          { bucket: "RECHARGE", _sum: { remaining: 500 } },
        ]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal("1800") } }), // 池累计发放
      },
      creditTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal("678") } }),
      },
    }
    const module = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: PrismaService,
          useValue: {
            teamMember: prisma.teamMember,
            creditLot: prisma.creditLot,
            creditTransaction: prisma.creditTransaction,
            billingOrder: { findMany: jest.fn().mockResolvedValue([]) },
            rechargePack: { findMany: jest.fn().mockResolvedValue([]) },
            scheduledPlan: { findMany: jest.fn().mockResolvedValue([]) },
            membershipPlan: { findMany: jest.fn().mockResolvedValue([]) },
            userOrganization: { findMany: jest.fn().mockResolvedValue([]) }, // 无组织 → orgName null
            user: prisma.user,
          },
        },
        {
          provide: CreditService,
          useValue: { getWallet: jest.fn().mockResolvedValue({ buckets: {} }) },
        },
      ],
    }).compile()
    service = module.get(WalletService)
  })

  it("返回池 套餐/充值/可用/累计已用（PACKAGE+GIFT 并入套餐口径）", async () => {
    const w = (await service.getWallet(1)) as {
      identity: string
      team: {
        poolPackage: string
        poolRecharge: string
        poolRemaining: string
        poolUsedTotal: string
        source: string
      }
    }
    expect(w.identity).toBe("TEAM_ADMIN")
    expect(w.team.source).toBe("CUSTOM")
    expect(w.team.poolPackage).toBe("1200") // 1000 PACKAGE + 200 GIFT
    expect(w.team.poolRecharge).toBe("500")
    expect(w.team.poolRemaining).toBe("1700")
    expect(w.team.poolUsedTotal).toBe("678")
    expect((w.team as { poolGrantedTotal: string }).poolGrantedTotal).toBe("1800") // 池累计发放
    expect((w.team as { poolManualDeducted: string }).poolManualDeducted).toBe("678") // 手动扣减合计（同 aggregate mock）
    // 新增：管理员用户名 / 所属组织（无组织 null）/ 企业名回落
    expect((w.team as { adminName: string }).adminName).toBe("boss_zhang")
    expect((w.team as { orgName: string | null }).orgName).toBeNull()
    expect((w.team as { name: string }).name).toBe("Acme")
    expect((w.team as { nameFilled: boolean }).nameFilled).toBe(true) // 显式命名标记透传
    const aggArg = (
      prisma.creditTransaction.aggregate.mock.calls as unknown as Array<
        [{ where: Record<string, unknown> }]
      >
    )[0][0]
    expect(aggArg.where).toEqual({ teamId: 10, type: "TEAM_CONSUME" })
  })

  it("池无消耗流水时已用为 0", async () => {
    prisma.creditTransaction.aggregate.mockResolvedValue({ _sum: { amount: null } })
    const w = (await service.getWallet(1)) as { team: { poolUsedTotal: string } }
    expect(w.team.poolUsedTotal).toBe("0")
  })

  it("团队身份与分销身份独立下发（§5.6）：管理员兼邀请人 → identity=TEAM_ADMIN 且 canInvite=true", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: true })
    let w = (await service.getWallet(1)) as { identity: string; canInvite: boolean }
    expect(w.identity).toBe("TEAM_ADMIN")
    expect(w.canInvite).toBe(true)

    prisma.user.findUnique.mockResolvedValue({ canInvite: false })
    w = await service.getWallet(1)
    expect(w.identity).toBe("TEAM_ADMIN")
    expect(w.canInvite).toBe(false)
  })

  it("团队身份下分销权限读落库值（2026-09-01 起落库制）：成员 canInvite=false → canInvite=false（上级开关不再派生）", async () => {
    prisma.user.findUnique.mockResolvedValue({ canInvite: false })
    const w = (await service.getWallet(1)) as { identity: string; canInvite: boolean }
    expect(w.identity).toBe("TEAM_ADMIN")
    expect(w.canInvite).toBe(false)
  })

  it("GRACE 宽限期：池余额查询不按到期日过滤（含冻结批次展示），在期仍过滤", async () => {
    const poolGroupByWhere = () =>
      (prisma.creditLot.groupBy.mock.calls as unknown[][]).map(
        c => (c[0] as { where: { teamId?: number; OR?: unknown } }).where
      )

    const prev = membership.team.status
    try {
      membership.team.status = "GRACE"
      await service.getWallet(1)
      const gracePoolQuery = poolGroupByWhere().find(w => w.teamId === 10)
      expect(gracePoolQuery?.OR).toBeUndefined()

      membership.team.status = prev
      prisma.creditLot.groupBy.mockClear()
      await service.getWallet(1)
      const activePoolQuery = poolGroupByWhere().find(w => w.teamId === 10)
      expect(activePoolQuery?.OR).toBeDefined()
    } finally {
      membership.team.status = prev
    }
  })

  describe("达限状态标签（limitState）", () => {
    const monthKey = (() => {
      const n = new Date()
      return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`
    })()
    const reachedMembership = (
      overLimitPolicy: string,
      teamOver: Record<string, unknown> = {}
    ) => ({
      ...membership,
      monthlyQuota: 800,
      quotaUsedThisMonth: 800, // 已达上限
      quotaMonth: monthKey,
      team: { ...membership.team, overLimitPolicy, ...teamOver },
    })
    type LimitView = { team: { limitState: string | null; limitStateLabel: string | null } }

    it("WARN 仅提醒 + 已达上限 → EXCEEDED（已超额）", async () => {
      prisma.teamMember.findFirst.mockResolvedValue(reachedMembership("WARN"))
      const w = (await service.getWallet(1)) as LimitView
      expect(w.team.limitState).toBe("EXCEEDED")
      expect(w.team.limitStateLabel).toBe("已超额")
    })

    it("BLOCK 阻止使用 + 已达上限 → CAPPED（已限额）；INDEPENDENT 同 CAPPED", async () => {
      prisma.teamMember.findFirst.mockResolvedValue(reachedMembership("BLOCK"))
      let w = (await service.getWallet(1)) as LimitView
      expect(w.team.limitState).toBe("CAPPED")
      expect(w.team.limitStateLabel).toBe("已限额")
      // 独立配额模式：即使 WARN 也是硬上限
      prisma.teamMember.findFirst.mockResolvedValue(
        reachedMembership("WARN", { quotaMode: "INDEPENDENT" })
      )
      w = (await service.getWallet(1)) as LimitView
      expect(w.team.limitState).toBe("CAPPED")
    })

    it("未达上限 / 不限额 / 非在期团队 → null", async () => {
      // 未达上限
      prisma.teamMember.findFirst.mockResolvedValue({
        ...reachedMembership("WARN"),
        quotaUsedThisMonth: 100,
      })
      expect(((await service.getWallet(1)) as LimitView).team.limitState).toBeNull()
      // 不限额（默认 membership monthlyQuota=null）
      prisma.teamMember.findFirst.mockResolvedValue(membership)
      expect(((await service.getWallet(1)) as LimitView).team.limitState).toBeNull()
      // 已达上限但团队 GRACE（冻结，不按达限标记）
      prisma.teamMember.findFirst.mockResolvedValue(reachedMembership("BLOCK", { status: "GRACE" }))
      expect(((await service.getWallet(1)) as LimitView).team.limitState).toBeNull()
    })
  })
})

/** 归档团队身份：数据保留期内仍识别 TEAM_ARCHIVED_*（入口保留 + 续费恢复）；保留期过后回落个人身份。 */
describe("WalletService.getWallet 归档团队身份", () => {
  let service: WalletService
  let prisma: {
    user: { findUnique: jest.Mock }
    teamMember: { findFirst: jest.Mock; count: jest.Mock }
    creditLot: { findMany: jest.Mock; groupBy: jest.Mock }
    creditTransaction: { aggregate: jest.Mock }
  }

  const archivedMembership = (role: string) => ({
    role,
    status: "ARCHIVED",
    monthlyQuota: null,
    quotaUsedThisMonth: 0,
    quotaMonth: null,
    team: {
      id: 10,
      name: "Acme",
      source: "SELF",
      status: "ARCHIVED",
      tier: 2,
      seats: 5,
      quotaMode: "SHARED",
      overLimitPolicy: "BLOCK",
      discount: "1",
      expiresAt: new Date(Date.now() - 40 * 86400000),
      graceUntil: new Date(Date.now() - 10 * 86400000),
      dataKeepUntil: new Date(Date.now() + 20 * 86400000), // 保留期内
      archivedAt: new Date(Date.now() - 10 * 86400000),
      admin: { username: "boss_zhang" },
    },
  })

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ canInvite: false, subscriptionExpiresAt: null }),
      },
      teamMember: {
        // 第一次（ACTIVE 成员行）查不到 → 第二次归档兜底命中
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue(archivedMembership("ADMIN")),
        count: jest.fn().mockResolvedValue(0),
      },
      creditLot: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]), // 归档池已清零
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal("100") } }), // 池累计发放
      },
      creditTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal("100") } }),
      },
    }
    const module = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: PrismaService,
          useValue: {
            user: prisma.user,
            teamMember: prisma.teamMember,
            creditLot: prisma.creditLot,
            creditTransaction: prisma.creditTransaction,
            billingOrder: { findMany: jest.fn().mockResolvedValue([]) },
            rechargePack: { findMany: jest.fn().mockResolvedValue([]) },
            scheduledPlan: { findMany: jest.fn().mockResolvedValue([]) },
            membershipPlan: { findMany: jest.fn().mockResolvedValue([]) },
            userOrganization: { findMany: jest.fn().mockResolvedValue([]) },
          },
        },
        {
          provide: CreditService,
          useValue: { getWallet: jest.fn().mockResolvedValue({ buckets: {} }) },
        },
      ],
    }).compile()
    service = module.get(WalletService)
  })

  it("保留期内的归档管理员 → TEAM_ARCHIVED_ADMIN，team 块带 ARCHIVED 状态", async () => {
    const w = (await service.getWallet(1)) as {
      identity: string
      team: { teamId: number; status: string; name: string }
    }
    expect(w.identity).toBe("TEAM_ARCHIVED_ADMIN")
    expect(w.team.teamId).toBe(10)
    expect(w.team.status).toBe("ARCHIVED")
    // 归档兜底查询：成员行 ARCHIVED + 团队 ARCHIVED + 保留期内（dataKeepUntil 空或未来）
    const archivedCall = (
      prisma.teamMember.findFirst.mock.calls as unknown as Array<[{ where: unknown }]>
    )[1][0]
    expect(archivedCall.where).toEqual({
      userId: 1,
      status: "ARCHIVED",
      team: {
        status: "ARCHIVED",
        OR: [{ dataKeepUntil: null }, { dataKeepUntil: { gt: expect.any(Date) as Date } }],
      },
    })
  })

  it("保留期内的归档成员 → TEAM_ARCHIVED_MEMBER", async () => {
    prisma.teamMember.findFirst
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(archivedMembership("MEMBER"))
    const w = (await service.getWallet(1)) as { identity: string }
    expect(w.identity).toBe("TEAM_ARCHIVED_MEMBER")
  })

  it("归档摘要字段：管理员带退回积分/名单数/归档时间；成员 archiveReturned=null", async () => {
    // 管理员视角
    let w = (await service.getWallet(1)) as {
      team: {
        archivedAt: Date | null
        archivedMemberCount: number | null
        archiveReturned: string | null
        myPoolUsedTotal: string
        poolGrantedTotal: string
        poolManualDeducted: string
      }
    }
    expect(w.team.archivedAt).toEqual(expect.any(Date))
    expect(w.team.archivedMemberCount).toBe(0)
    expect(w.team.archiveReturned).toBe("100") // TEAM_ARCHIVE_RETURN 流水合计
    expect(w.team.myPoolUsedTotal).toBe("100") // 本人企业段累计消耗
    expect(w.team.poolGrantedTotal).toBe("100") // 池累计发放
    expect(w.team.poolManualDeducted).toBe("100") // 平台手动扣减合计

    // 成员视角：退回积分不下发
    prisma.teamMember.findFirst
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(archivedMembership("MEMBER"))
    w = (await service.getWallet(1)) as typeof w
    expect(w.team.archiveReturned).toBeNull()
    expect(w.team.archivedMemberCount).toBe(0)
  })

  it("在期团队不下发归档摘要字段（archivedMemberCount/archiveReturned=null）", async () => {
    prisma.teamMember.findFirst.mockReset().mockResolvedValue({
      ...archivedMembership("ADMIN"),
      status: "ACTIVE",
      team: { ...archivedMembership("ADMIN").team, status: "ACTIVE", archivedAt: null },
    })
    const w = (await service.getWallet(1)) as {
      team: { archivedMemberCount: number | null; archiveReturned: string | null }
    }
    expect(w.team.archivedMemberCount).toBeNull()
    expect(w.team.archiveReturned).toBeNull()
  })

  it("保留期已过（DB 过滤后查不到）→ 回落个人身份 NONE，team=null", async () => {
    prisma.teamMember.findFirst.mockReset().mockResolvedValue(null)
    const w = (await service.getWallet(1)) as { identity: string; team: unknown }
    expect(w.identity).toBe("NONE")
    expect(w.team).toBeNull()
    expect(prisma.teamMember.findFirst).toHaveBeenCalledTimes(2) // ACTIVE 未中 → 归档兜底也未中
  })

  it("有 ACTIVE 成员行时不再走归档兜底（只查一次）", async () => {
    prisma.teamMember.findFirst.mockReset().mockResolvedValue({
      ...archivedMembership("ADMIN"),
      status: "ACTIVE",
      team: { ...archivedMembership("ADMIN").team, status: "ACTIVE" },
    })
    const w = (await service.getWallet(1)) as { identity: string }
    expect(w.identity).toBe("TEAM_ADMIN")
    expect(prisma.teamMember.findFirst).toHaveBeenCalledTimes(1)
  })
})
