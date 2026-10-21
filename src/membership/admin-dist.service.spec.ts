import { BadRequestException, NotFoundException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import { CreditBucket, CreditTxnType, InviteAppStatus } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { MailProvider } from "../common/providers/mail.provider"
import { DefaultMemberRoleService } from "../common/services/default-member-role.service"
import { PrismaService } from "../prisma/prisma.service"
import { AdminDistService } from "./admin-dist.service"
import { CreditService } from "./credit.service"
import { InviteService } from "./invite.service"
import { WalletService } from "./wallet.service"

/** jest.Mock 的 calls 为 any；提取第 n 次调用实参并显式收窄类型后断言 */
const callArgs = <T extends unknown[]>(mock: jest.Mock, call: number): T => {
  const calls = mock.mock.calls as unknown[][]
  return calls[call] as T
}

describe("AdminDistService", () => {
  let service: AdminDistService
  let prisma: {
    rebateRule: { findFirst: jest.Mock; upsert: jest.Mock }
    user: { findUnique: jest.Mock; findMany: jest.Mock; count: jest.Mock; groupBy: jest.Mock }
    team: { findMany: jest.Mock }
    inviteApplication: { count: jest.Mock }
    creditTransaction: { groupBy: jest.Mock; aggregate: jest.Mock; findMany: jest.Mock }
    creditLot: { aggregate: jest.Mock; groupBy: jest.Mock }
  }

  const rootUser = {
    id: 1,
    username: "root",
    phone: "13800000000",
    rebateRate: new Decimal(0.3),
    level2RebateRate: new Decimal(0.1),
    rebateEnabled: true,
    inviteQuota: 10,
    canInvite: true, // 根节点徽章（2026-08-31 第六批）
    isActive: true,
    subInviteAllowed: true,
    teamMemberships: [] as object[], // 默认个人计费（无企业徽章）
  }

  const mockTreeBase = () => {
    prisma.user.findUnique.mockResolvedValue(rootUser)
    prisma.rebateRule.findFirst.mockResolvedValue({
      id: 1,
      corpCounts: false,
      maxLayers: 2,
      perInviterCap: null,
      perConsumeCapPct: null,
    })
    prisma.inviteApplication.count.mockResolvedValue(3)
  }

  beforeEach(async () => {
    prisma = {
      rebateRule: { findFirst: jest.fn(), upsert: jest.fn() },
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      team: { findMany: jest.fn().mockResolvedValue([]) },
      inviteApplication: { count: jest.fn().mockResolvedValue(0) },
      creditTransaction: {
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal(0) } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      creditLot: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { remaining: new Decimal(0) } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    }
    const moduleRef = await Test.createTestingModule({
      providers: [AdminDistService, { provide: PrismaService, useValue: prisma }],
    }).compile()
    service = moduleRef.get(AdminDistService)
  })

  describe("getRebateRules", () => {
    it("表为空 → 返回默认值且不落库", async () => {
      prisma.rebateRule.findFirst.mockResolvedValue(null)
      const res = await service.getRebateRules()
      expect(res).toEqual({
        corpCounts: true,
        maxLayers: 2,
        perInviterCap: null,
        perConsumeCapPct: null,
      })
      expect(prisma.rebateRule.upsert).not.toHaveBeenCalled()
    })

    it("有配置行 → 返回行值（Decimal 转字符串）", async () => {
      prisma.rebateRule.findFirst.mockResolvedValue({
        id: 1,
        corpCounts: false,
        maxLayers: 3,
        perInviterCap: 5000,
        perConsumeCapPct: new Decimal(0.5),
      })
      const res = await service.getRebateRules()
      expect(res).toEqual({
        corpCounts: false,
        maxLayers: 3,
        perInviterCap: 5000,
        perConsumeCapPct: "0.5",
      })
    })
  })

  describe("updateRebateRules", () => {
    it("空 DTO → 400「至少传一项配置」且不 upsert", async () => {
      await expect(service.updateRebateRules({})).rejects.toThrow(BadRequestException)
      await expect(service.updateRebateRules({})).rejects.toThrow("至少传一项配置")
      expect(prisma.rebateRule.upsert).not.toHaveBeenCalled()
    })

    it("upsert 固定 id=1，仅透传所传字段（显式 null = 清除封顶）", async () => {
      prisma.rebateRule.upsert.mockResolvedValue({
        id: 1,
        corpCounts: true,
        maxLayers: 4,
        perInviterCap: null,
        perConsumeCapPct: null,
      })
      const res = await service.updateRebateRules({ maxLayers: 4, perInviterCap: null })
      expect(prisma.rebateRule.upsert).toHaveBeenCalledWith({
        where: { id: 1 },
        create: { id: 1, maxLayers: 4, perInviterCap: null },
        update: { maxLayers: 4, perInviterCap: null },
      })
      expect(res).toEqual({
        corpCounts: true,
        maxLayers: 4,
        perInviterCap: null,
        perConsumeCapPct: null,
      })
    })

    it("maxLayers 显式传 null → 落库 null（不限层级，2026-09-01 bug15）", async () => {
      prisma.rebateRule.upsert.mockResolvedValue({
        id: 1,
        corpCounts: true,
        maxLayers: null,
        perInviterCap: null,
        perConsumeCapPct: null,
      })
      const res = await service.updateRebateRules({ maxLayers: null })
      expect(prisma.rebateRule.upsert).toHaveBeenCalledWith({
        where: { id: 1 },
        create: { id: 1, maxLayers: null },
        update: { maxLayers: null },
      })
      expect(res.maxLayers).toBeNull()
    })
  })

  describe("getTree", () => {
    it("用户不存在 → 404", async () => {
      prisma.user.findUnique.mockResolvedValue(null)
      await expect(service.getTree({ userId: 99, page: 1, pageSize: 10 })).rejects.toThrow(
        NotFoundException
      )
    })

    it("聚合：本体字段 + 一级本月消耗/贡献返利/二级数 + 二级内嵌分页 + corpCounts 标注", async () => {
      mockTreeBase()
      prisma.user.findMany
        .mockResolvedValueOnce([
          {
            id: 2,
            username: "l1a",
            phone: "13100000002",
            canInvite: true,
            isActive: true,
            discount: new Decimal(0.8),
            rebateRate: new Decimal(0.3),
            // 占用中企业管理员 → 企业徽章
            teamMemberships: [
              {
                role: "ADMIN",
                status: "ACTIVE",
                team: { id: 40, name: "测试团队", status: "ACTIVE" },
              },
            ],
          },
          {
            id: 3,
            username: "l1b",
            phone: "13100000003",
            canInvite: false,
            isActive: false, // 已停用徽章
            discount: new Decimal(1),
            rebateRate: new Decimal(0.3),
            teamMemberships: [],
          },
        ]) // 一级
        .mockResolvedValueOnce([
          {
            id: 4,
            username: "l2a",
            phone: "13200000004",
            invitedById: 2,
            canInvite: false,
            isActive: true,
            discount: new Decimal(1),
            rebateRate: new Decimal(0.3),
            teamMemberships: [],
          },
          {
            id: 5,
            username: "l2b",
            phone: "13200000005",
            invitedById: 2,
            canInvite: false,
            isActive: true,
            discount: new Decimal(1),
            rebateRate: new Decimal(0.3),
            teamMemberships: [],
          },
          {
            id: 6,
            username: "l2c",
            phone: "13200000006",
            invitedById: 2,
            canInvite: false,
            isActive: true,
            discount: new Decimal(1),
            rebateRate: new Decimal(0.3),
            teamMemberships: [],
          },
        ]) // 二级（全挂在 l1a 下）
      prisma.creditTransaction.groupBy
        .mockResolvedValueOnce([
          { userId: 2, type: CreditTxnType.CONSUME, _sum: { amount: new Decimal(100) } },
          { userId: 2, type: CreditTxnType.TEAM_CONSUME, _sum: { amount: new Decimal(50) } }, // 企业池段
          { userId: 4, type: CreditTxnType.CONSUME, _sum: { amount: new Decimal(40) } },
        ]) // 本月消耗（用户×类型）
        .mockResolvedValueOnce([
          { userId: 1, relatedUserId: 2, _sum: { amount: new Decimal(30) } }, // l1a → 根（个人段）
          { userId: 2, relatedUserId: 6, _sum: { amount: new Decimal(5) } }, // l2c → l1a
          { userId: 1, relatedUserId: 6, _sum: { amount: new Decimal(3) } }, // l2c → 根
        ]) // 本月返利归属（收款人×消费者）
        .mockResolvedValueOnce([{ userId: 2, _sum: { amount: new Decimal(637) } }]) // 累计返利入账（全量）
        .mockResolvedValueOnce([{ teamId: 40, _sum: { amount: new Decimal(260) } }]) // 企业40全队本月池消耗（含本人50，2026-09-01 卷起）
        .mockResolvedValueOnce([{ userId: 1, teamId: 40, _sum: { amount: new Decimal(78) } }]) // 池段返利→根（REBATE_IN 带 teamId）
        // ===== 累计口径（bug14/15）=====
        .mockResolvedValueOnce([
          { userId: 2, type: CreditTxnType.CONSUME, _sum: { amount: new Decimal(400) } },
          { userId: 2, type: CreditTxnType.TEAM_CONSUME, _sum: { amount: new Decimal(100) } },
        ]) // 累计消耗（用户×类型）
        .mockResolvedValueOnce([
          { userId: 1, relatedUserId: 2, _sum: { amount: new Decimal(90) } }, // l1a → 根 累计（个人段）
          { userId: 2, relatedUserId: 6, _sum: { amount: new Decimal(15) } }, // l2c → l1a 累计
          { userId: 1, relatedUserId: 6, _sum: { amount: new Decimal(9) } }, // l2c → 根 累计
        ]) // 累计返利归属（收款人×消费者）
        .mockResolvedValueOnce([{ teamId: 40, _sum: { amount: new Decimal(800) } }]) // 企业40全队累计池消耗
        .mockResolvedValueOnce([{ userId: 1, teamId: 40, _sum: { amount: new Decimal(156) } }]) // 池段返利→根 累计
      // 返利可提现余额（REBATE 桶剩余）
      prisma.creditLot.groupBy.mockResolvedValue([
        { userId: 2, _sum: { remaining: new Decimal(337) } },
      ])

      const res = await service.getTree({ userId: 1, page: 2, pageSize: 2 })

      expect(res.user).toEqual({
        id: 1,
        username: "root",
        phone: "138****0000", // 本体手机号默认脱敏（全号走 GET /users/:id/phone 审计接口）
        rebateRate: "0.3",
        level2RebateRate: "0.1",
        rebateEnabled: true,
        inviteQuota: 10,
        inviteQuotaUsed: 3,
        subInviteAllowed: true, // 下级可继续邀请（回显用，2026-08-30 补）
        // 根节点徽章（2026-08-31 第六批）
        canInvite: true,
        effectiveCanInvite: true,
        isActive: true,
        team: null,
        level1Total: 2,
        monthConsumed: "0", // 根节点本人本月消耗（2026-08-31 补，与下级同口径）
        monthTeamConsumed: "0",
        monthRebateEarned: "0", // 根节点本月实得返利合计（全网络贡献）
        // 累计版（2026-09-01 bug14/15）
        totalConsumed: "0",
        totalTeamConsumed: "0",
        totalRebateEarned: "0",
      })
      expect(res.corpCounts).toBe(false)
      // 网络合计（树卡片头部）：2 一级 + 3 二级 = 5 人；本月消耗=360(l1a 个人100+全队池260)+40(l2a)=400；累计=1200(l1a 个人400+全队池800)+0=1200
      expect(res.networkCount).toBe(5)
      expect(res.networkMonthConsumed).toBe("400")
      expect(res.networkTotalConsumed).toBe("1200")
      expect(res.level1).toHaveLength(2)

      const l1a = res.level1[0]
      expect(l1a.id).toBe(2)
      expect(l1a.phone).toBe("131****0002") // 一级成员手机号脱敏下发（2026-08-30 补）
      expect(l1a.monthConsumed).toBe("360") // 企业管理员：本人个人 100 + 全队池 260（本人池 50 含在池里不双计）
      expect(l1a.monthTeamConsumed).toBe("260") // 其中池子集（标注用）
      expect(l1a.monthRebateContributed).toBe("108") // 个人段 30 + 本企业池段 78（卷起）
      // 累计三件套（bug14/15）：累计消耗=本人个人 400+全队池 800=1200；累计池消耗=全队 800；累计贡献=90+156=246
      expect(l1a.totalConsumed).toBe("1200")
      expect(l1a.totalTeamConsumed).toBe("800")
      expect(l1a.totalRebateContributed).toBe("246")
      // 按钮数据五件套（2026-08-31 补）：邀请配置回显 + 返利提现按钮/额度
      expect(l1a.canInvite).toBe(true)
      expect(l1a.discount).toBe("0.8")
      expect(l1a.rebateRate).toBe("0.3")
      expect(l1a.rebate).toBe("337")
      expect(l1a.rebateEarned).toBe("637")
      // 徽章数据（2026-08-31 第六批）
      expect(l1a.effectiveCanInvite).toBe(true)
      expect(l1a.isActive).toBe(true)
      expect(l1a.team).toEqual({ id: 40, name: "测试团队", role: "ADMIN" })
      expect(l1a.rebateAttribution).toEqual([
        { userId: 1, username: "root", amount: "108", totalAmount: "246" }, // 个人段+池段合并；本月/累计
      ])
      expect(l1a.level2Total).toBe(3)
      expect(l1a.corpCounts).toBe(false)
      // 二级内嵌分页：page=2&pageSize=2 → 第 3 个
      expect(l1a.level2.total).toBe(3)
      expect(l1a.level2.page).toBe(2)
      expect(l1a.level2.totalPages).toBe(2)
      expect(l1a.level2.items).toEqual([
        {
          id: 6,
          username: "l2c",
          phone: "132****0006",
          monthConsumed: "0",
          monthTeamConsumed: "0",
          monthRebateContributed: "3", // 二级成员本月贡献给根的返利（2026-08-31 补，对账用）
          totalConsumed: "0", // 累计三件套（bug14/15）
          totalTeamConsumed: "0",
          totalRebateContributed: "9", // 累计：根←l2c 9
          canInvite: false, // 二级节点同带五件套
          discount: "1",
          rebateRate: "0.3",
          rebate: "0",
          rebateEarned: "0",
          effectiveCanInvite: false, // 二级无向下派生
          isActive: true,
          team: null,
          rebateAttribution: [
            { userId: 2, username: "l1a", amount: "5", totalAmount: "15" }, // 二级 → 一级上级
            { userId: 1, username: "root", amount: "3", totalAmount: "9" }, // 二级 → 根
          ],
          corpCounts: false,
        },
      ])

      const l1b = res.level1[1]
      expect(l1b.monthConsumed).toBe("0")
      expect(l1b.monthRebateContributed).toBe("0")
      expect(l1b.rebate).toBe("0")
      expect(l1b.rebateEarned).toBe("0")
      expect(l1b.isActive).toBe(false)
      expect(l1b.team).toBeNull()
      expect(l1b.rebateAttribution).toEqual([]) // 无实付 → 空（前端渲染「无上游团队长」类文案）
      expect(l1b.level2Total).toBe(0)
      expect(l1b.level2.items).toEqual([])

      // 消耗聚合口径：CONSUME + TEAM_CONSUME 按 用户×类型 分组，当月 1 号起，覆盖根+一级+二级
      const [consumeArgs] = callArgs<
        [{ by: string[]; where: { userId: unknown; type: unknown; createdAt: { gte: Date } } }]
      >(prisma.creditTransaction.groupBy, 0)
      expect(consumeArgs.by).toEqual(["userId", "type"])
      expect(consumeArgs.where.type).toEqual({
        in: [CreditTxnType.CONSUME, CreditTxnType.TEAM_CONSUME],
      })
      expect(consumeArgs.where.userId).toEqual({ in: [2, 3, 4, 5, 6, 1] })
      expect(consumeArgs.where.createdAt.gte.getDate()).toBe(1)
      // 返利归属聚合口径：收款人×消费者成对，收款人=根+一级，消费者=一级+二级
      const [rebateArgs] = callArgs<
        [{ by: string[]; where: { userId: unknown; type: CreditTxnType; relatedUserId: unknown } }]
      >(prisma.creditTransaction.groupBy, 1)
      expect(rebateArgs.by).toEqual(["userId", "relatedUserId"])
      expect(rebateArgs.where).toMatchObject({
        userId: { in: [1, 2, 3] },
        type: CreditTxnType.REBATE_IN,
        relatedUserId: { in: [2, 3, 4, 5, 6] },
      })
      // 累计返利入账口径：一级+二级成员 REBATE_IN 全量（不分月）
      const [earnedArgs] = callArgs<[{ where: { userId: unknown; type: CreditTxnType } }]>(
        prisma.creditTransaction.groupBy,
        2
      )
      expect(earnedArgs.where).toEqual({
        userId: { in: [2, 3, 4, 5, 6] },
        type: CreditTxnType.REBATE_IN,
      })
      // 可提现余额口径：REBATE 桶 ACTIVE 批次剩余>0
      const [lotArgs] = callArgs<
        [{ where: { userId: unknown; bucket: CreditBucket; status: string; remaining: unknown } }]
      >(prisma.creditLot.groupBy, 0)
      expect(lotArgs.where).toMatchObject({
        userId: { in: [2, 3, 4, 5, 6] },
        bucket: CreditBucket.REBATE,
        status: "ACTIVE",
        remaining: { gt: 0 },
      })
    })

    it("网络合计去重：同企业管理员+成员同在树内，池消耗只计一次（2026-09-07 bug30）", async () => {
      mockTreeBase()
      prisma.user.findMany
        .mockResolvedValueOnce([
          {
            id: 2,
            username: "企业管理员A",
            phone: "13100000002",
            canInvite: true,
            isActive: true,
            discount: new Decimal(1),
            rebateRate: new Decimal(0.3),
            teamMemberships: [
              {
                role: "ADMIN",
                status: "ACTIVE",
                team: { id: 40, name: "测试团队", status: "ACTIVE" },
              },
            ],
          },
          {
            id: 3,
            username: "企业成员M",
            phone: "13100000003",
            canInvite: false,
            isActive: true,
            discount: new Decimal(1),
            rebateRate: new Decimal(0.3),
            teamMemberships: [
              {
                role: "MEMBER",
                status: "ACTIVE",
                team: { id: 40, name: "测试团队", status: "ACTIVE" },
              },
            ],
          },
        ]) // 一级：A 与 M 同企业
        .mockResolvedValueOnce([]) // 无二级
      prisma.creditTransaction.groupBy
        .mockResolvedValueOnce([
          { userId: 2, type: CreditTxnType.TEAM_CONSUME, _sum: { amount: new Decimal(20) } }, // A 本月池消耗 20
          { userId: 3, type: CreditTxnType.TEAM_CONSUME, _sum: { amount: new Decimal(44) } }, // M 本月池消耗 44
        ]) // 本月消耗
        .mockResolvedValueOnce([]) // 本月返利归属
        .mockResolvedValueOnce([]) // 累计返利入账
        .mockResolvedValueOnce([{ teamId: 40, _sum: { amount: new Decimal(64) } }]) // 全队本月池 64（20+44）
        .mockResolvedValueOnce([]) // 池段返利
        .mockResolvedValueOnce([
          { userId: 2, type: CreditTxnType.TEAM_CONSUME, _sum: { amount: new Decimal(40) } },
          { userId: 3, type: CreditTxnType.TEAM_CONSUME, _sum: { amount: new Decimal(88) } },
        ]) // 累计消耗
        .mockResolvedValueOnce([]) // 累计返利归属
        .mockResolvedValueOnce([{ teamId: 40, _sum: { amount: new Decimal(128) } }]) // 全队累计池 128
        .mockResolvedValueOnce([]) // 池段返利累计

      const res = await service.getTree({ userId: 1, page: 1, pageSize: 10 })

      // 节点展示口径不变：A 卷起全队池（0+64 / 0+128），M 显示本人池（44 / 88）
      expect(res.level1[0].monthConsumed).toBe("64")
      expect(res.level1[0].totalConsumed).toBe("128")
      expect(res.level1[1].monthConsumed).toBe("44")
      expect(res.level1[1].totalConsumed).toBe("88")
      // 网络合计：池只计一次——A 节点已含全队池，M 的本人池行不再重复计入（旧算法 108/216 双计）
      expect(res.networkMonthConsumed).toBe("64")
      expect(res.networkTotalConsumed).toBe("128")
    })

    it("无一级成员 → 空列表；根节点本月字段照常聚合（贡献返利 groupBy 跳过）", async () => {
      mockTreeBase()
      prisma.user.findMany.mockResolvedValue([])
      const res = await service.getTree({ userId: 1, page: 1, pageSize: 10 })
      expect(res.level1).toEqual([])
      expect(res.user.monthConsumed).toBe("0")
      expect(res.user.monthRebateEarned).toBe("0")
      // 消耗 groupBy 仍跑（含根节点本人）：本月 + 累计两次；贡献返利/池卷起 groupBy 无下级时跳过
      expect(prisma.creditTransaction.groupBy).toHaveBeenCalledTimes(2)
    })
  })

  describe("getTree scope 成员范围筛选（2026-08-31）", () => {
    // l1team：已进企业；l1personal：纯个人；l2a 挂 l1team（个人）；l2b 挂 l1personal（可邀请）
    const level1Rows = [
      {
        id: 2,
        username: "l1team",
        phone: "13100000002",
        canInvite: false,
        isActive: true,
        discount: new Decimal(1),
        rebateRate: new Decimal(0.3),
        teamMemberships: [
          { role: "MEMBER", status: "ACTIVE", team: { id: 40, name: "企业A", status: "ACTIVE" } },
        ],
      },
      {
        id: 3,
        username: "l1personal",
        phone: "13100000003",
        canInvite: false,
        isActive: true,
        discount: new Decimal(1),
        rebateRate: new Decimal(0.3),
        teamMemberships: [],
      },
    ]
    const level2Rows = [
      {
        id: 4,
        username: "l2a",
        phone: "13200000004",
        invitedById: 2,
        canInvite: false,
        isActive: true,
        discount: new Decimal(1),
        rebateRate: new Decimal(0.3),
        teamMemberships: [],
      },
      {
        id: 5,
        username: "l2b",
        phone: "13200000005",
        invitedById: 3,
        canInvite: true,
        isActive: true,
        discount: new Decimal(1),
        rebateRate: new Decimal(0.3),
        teamMemberships: [],
      },
    ]
    const mockScopeTree = (root: object) => {
      prisma.user.findUnique.mockResolvedValue(root)
      prisma.rebateRule.findFirst.mockResolvedValue(null)
      prisma.inviteApplication.count.mockResolvedValue(0)
      prisma.user.findMany.mockResolvedValueOnce(level1Rows).mockResolvedValueOnce(level2Rows)
    }

    it("scope=team：仅已进企业；不匹配且无匹配二级的一级成员被裁掉", async () => {
      mockScopeTree({ ...rootUser, canInvite: true })
      const res = await service.getTree({ userId: 1, page: 1, pageSize: 10, scope: "team" })
      expect(res.level1.map(l => l.id)).toEqual([2]) // l1personal 个人计费被裁
      expect(res.level1[0].level2Total).toBe(0) // l2a 不在企业，被筛掉
    })

    it("scope=personal：不匹配的一级成员含匹配二级时保留作上下文", async () => {
      mockScopeTree({ ...rootUser, canInvite: true })
      const res = await service.getTree({ userId: 1, page: 1, pageSize: 10, scope: "personal" })
      expect(res.level1.map(l => l.id)).toEqual([2, 3]) // l1team 因 l2a（个人）保留
      expect(res.level1[0].level2.items.map((l: { id: number }) => l.id)).toEqual([4])
      expect(res.level1[1].level2.items.map((l: { id: number }) => l.id)).toEqual([5])
    })

    it("scope=inviter：仅看本人 canInvite 落库值（2026-09-01 起落库制，根开关不再参与读侧派生）", async () => {
      mockScopeTree({ ...rootUser, canInvite: true, subInviteAllowed: true })
      const res = await service.getTree({ userId: 1, page: 1, pageSize: 10, scope: "inviter" })
      // 两个一级 canInvite 均为 false（未落库）→ 不匹配；l1personal 因含可邀请二级 l2b 保留作上下文
      expect(res.level1.map(l => l.id)).toEqual([3])
      expect(res.level1[0].level2Total).toBe(1) // l2b canInvite=true
    })

    it("scope=inviter：一级成员已被上级批量打开（canInvite=true 落库）→ 直接命中", async () => {
      const opened = level1Rows.map(r => ({ ...r, canInvite: true }))
      prisma.user.findUnique.mockResolvedValue({
        ...rootUser,
        canInvite: true,
        subInviteAllowed: true,
      })
      prisma.rebateRule.findFirst.mockResolvedValue(null)
      prisma.inviteApplication.count.mockResolvedValue(0)
      prisma.user.findMany.mockResolvedValueOnce(opened).mockResolvedValueOnce(level2Rows)
      const res = await service.getTree({ userId: 1, page: 1, pageSize: 10, scope: "inviter" })
      expect(res.level1.map(l => l.id)).toEqual([2, 3])
      expect(res.level1[0].level2Total).toBe(0) // l2a 本人不可邀请
      expect(res.level1[1].level2Total).toBe(1) // l2b canInvite=true
    })

    it("scope=inviter + 根关闭「下级可继续邀请」：仅本人 canInvite 或含匹配二级者保留", async () => {
      mockScopeTree({ ...rootUser, canInvite: true, subInviteAllowed: false })
      const res = await service.getTree({ userId: 1, page: 1, pageSize: 10, scope: "inviter" })
      expect(res.level1.map(l => l.id)).toEqual([3]) // l1team 无可邀请二级 → 裁掉
      expect(res.level1[0].level2.items.map((l: { id: number }) => l.id)).toEqual([5])
    })
  })

  describe("previewRebateRules 返利成本试算（2026-08-31，不落库）", () => {
    const mkUser = (
      id: number,
      invitedById: number | null,
      rate: string,
      l2rate: string | null,
      gate?: { rebateEnabled?: boolean; isActive?: boolean; canInvite?: boolean }
    ) => ({
      id,
      username: `用户${id}`,
      invitedById,
      rebateRate: new Decimal(rate),
      level2RebateRate: l2rate == null ? null : new Decimal(l2rate),
      rebateEnabled: gate?.rebateEnabled ?? true,
      isActive: gate?.isActive ?? true,
      canInvite: gate?.canInvite ?? true,
      invitedBy: null,
    })
    // 链：消费者 10 → 一级邀请人 2（30%）→ 二级邀请人 1（10%）
    const chainUsers = () => [
      mkUser(1, null, "0.3", "0.1"),
      mkUser(2, 1, "0.3", null),
      mkUser(10, 2, "0", null),
    ]
    const mockPreview = (opts: {
      rule?: object | null
      txns?: object[]
      users?: object[]
      teams?: object[]
    }) => {
      prisma.rebateRule.findFirst.mockResolvedValue(
        opts.rule === undefined
          ? { id: 1, corpCounts: true, maxLayers: 2, perInviterCap: null, perConsumeCapPct: null }
          : opts.rule
      )
      prisma.creditTransaction.findMany.mockResolvedValue(opts.txns ?? [])
      prisma.user.findMany.mockResolvedValue(opts.users ?? [])
      prisma.team.findMany.mockResolvedValue(opts.teams ?? [])
    }
    const consumeTxn = {
      userId: 10,
      teamId: null,
      type: CreditTxnType.CONSUME,
      amount: new Decimal(100),
    }

    it("两级回放：逐层四舍五入；effectiveRule 回显当前规则（空 DTO）", async () => {
      mockPreview({ txns: [consumeTxn], users: chainUsers() })
      const res = await service.previewRebateRules({})
      expect(res.consumeTotal).toBe("100")
      expect(res.rebateTotal).toBe("40") // 30 + 10
      expect(res.rebatePct).toBe("0.4000")
      expect(res.highRisk).toBe(false)
      expect(res.riskMessage).toBeNull()
      expect(res.effectiveRule).toEqual({
        corpCounts: true,
        maxLayers: 2,
        perInviterCap: null,
        perConsumeCapPct: null,
      })
    })

    it("maxLayers 传 null → 不限层级（第三层也计酬），effectiveRule 回显 null（2026-09-01 bug15）", async () => {
      mockPreview({
        txns: [consumeTxn],
        users: [
          mkUser(5, null, "0.3", "0.2"), // 第三层团队长（level2 比例 0.2）
          mkUser(1, 5, "0.3", "0.1"),
          mkUser(2, 1, "0.3", null),
          mkUser(10, 2, "0", null),
        ],
      })
      const res = await service.previewRebateRules({ maxLayers: null })
      expect(res.rebateTotal).toBe("60") // 30 + 10 + 20
      expect(res.effectiveRule.maxLayers).toBeNull()
    })

    it("byInviter 团队长明细：按预计返利降序，参与计酬人数按消耗者去重（2026-09-01 bug15）", async () => {
      const txn2 = {
        userId: 11,
        teamId: null,
        type: CreditTxnType.CONSUME,
        amount: new Decimal(50),
      }
      mockPreview({
        txns: [consumeTxn, txn2],
        users: [...chainUsers(), mkUser(11, 2, "0", null)], // 11 也是 2 的下级
      })
      const res = await service.previewRebateRules({})
      // 用户2：100×0.3 + 50×0.3 = 45（2 人计酬）；用户1：100×0.1 + 50×0.1 = 15（2 人计酬）
      expect(res.byInviter).toEqual([
        { userId: 2, username: "用户2", consumerCount: 2, rebateTotal: "45" },
        { userId: 1, username: "用户1", consumerCount: 2, rebateTotal: "15" },
      ])
    })

    it("对账口径：明细量化到 2 位小数，顶部预计返利 ≡ 量化后明细之和（2026-09-03 bug30）", async () => {
      const txn = {
        userId: 10,
        teamId: null,
        type: CreditTxnType.CONSUME,
        amount: new Decimal(7),
      }
      mockPreview({
        txns: [txn],
        users: [
          mkUser(1, null, "0.3", "0.15"),
          mkUser(2, 1, "0.3333", null), // 一级 7×0.3333=2.3331 → 量化 2.33
          mkUser(10, 2, "0", null),
        ],
      })
      const res = await service.previewRebateRules({})
      // 二级 7×0.15=1.05（≤2 位原样）；总额=2.33+1.05=3.38，而非原始精度合计 3.3831
      expect(res.byInviter).toEqual([
        { userId: 2, username: "用户2", consumerCount: 1, rebateTotal: "2.33" },
        { userId: 1, username: "用户1", consumerCount: 1, rebateTotal: "1.05" },
      ])
      expect(res.rebateTotal).toBe("3.38")
      const sum = res.byInviter.reduce((s, r) => s.plus(r.rebateTotal), new Decimal(0))
      expect(res.rebateTotal).toBe(sum.toString()) // 前端逐项相加必然可对账
    })

    it("预计返利/消耗 > 50% → highRisk + 风险提示文案", async () => {
      mockPreview({
        txns: [consumeTxn],
        users: [mkUser(1, null, "0.3", "0.3"), mkUser(2, 1, "0.3", null), mkUser(10, 2, "0", null)],
      })
      const res = await service.previewRebateRules({})
      expect(res.rebateTotal).toBe("60")
      expect(res.highRisk).toBe(true)
      expect(res.riskMessage).toContain("50%")
    })

    it("corpCounts=false：企业段只计入消耗分母不返利；true 时沿 Team.invitedById 企业邀请链结算", async () => {
      const teamTxn = {
        userId: 10,
        teamId: 40,
        type: CreditTxnType.TEAM_CONSUME,
        amount: new Decimal(100),
      }
      const teams = [{ id: 40, invitedById: 1 }] // 企业邀请人=用户 1
      mockPreview({ txns: [consumeTxn, teamTxn], users: chainUsers(), teams })

      const off = await service.previewRebateRules({ corpCounts: false })
      expect(off.consumeTotal).toBe("200")
      expect(off.rebateTotal).toBe("40") // 仅个人段 30+10
      expect(off.rebatePct).toBe("0.2000")

      mockPreview({ txns: [consumeTxn, teamTxn], users: chainUsers(), teams })
      const on = await service.previewRebateRules({})
      expect(on.rebateTotal).toBe("70") // 个人段 40 + 企业段 100×0.3（用户1 rebateRate）
      expect(on.rebatePct).toBe("0.3500")
    })

    it("perConsumeCapPct 草稿：单笔封顶等比缩减（30+10 → 20 封顶=15+5）", async () => {
      mockPreview({ txns: [consumeTxn], users: chainUsers() })
      const res = await service.previewRebateRules({ perConsumeCapPct: 0.2 })
      expect(res.rebateTotal).toBe("20")
      expect(res.effectiveRule.perConsumeCapPct).toBe("0.2")
    })

    it("perInviterCap 草稿：窗口内模拟累计封顶（30 截到 25，二级 10 照常）", async () => {
      mockPreview({ txns: [consumeTxn], users: chainUsers() })
      const res = await service.previewRebateRules({ perInviterCap: 25 })
      expect(res.rebateTotal).toBe("35")
    })

    it("计酬闸门：rebateEnabled=false 的层跳过、链不断（上级照常计）", async () => {
      mockPreview({
        txns: [consumeTxn],
        users: [
          mkUser(1, null, "0.3", "0.1"),
          mkUser(2, 1, "0.3", null, { rebateEnabled: false }), // 一级停计酬
          mkUser(10, 2, "0", null),
        ],
      })
      const res = await service.previewRebateRules({})
      expect(res.rebateTotal).toBe("10") // 仅二级 100×0.1
    })

    it("样本为空：rebatePct=null 且不报错", async () => {
      mockPreview({ txns: [], users: [] })
      const res = await service.previewRebateRules({})
      expect(res.consumeTotal).toBe("0")
      expect(res.rebatePct).toBeNull()
      expect(res.highRisk).toBe(false)
    })
  })

  describe("getInviteRebateDetail 邀请配置弹窗扩展数据（2026-08-31）", () => {
    it("rebate 汇总 + 网络人数 + corpKids（生效值/是否单独设定）+ upstreamRebateRate", async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 12, invitedById: 5 }) // me
        .mockResolvedValueOnce({ level2RebateRate: null }) // 上级 → 默认 0.10
      prisma.rebateRule.findFirst.mockResolvedValue({ id: 1, corpCounts: false }) // 全局关
      prisma.creditTransaction.aggregate
        .mockResolvedValueOnce({ _sum: { amount: new Decimal(637) } }) // earned
        .mockResolvedValueOnce({ _sum: { amount: new Decimal(300) } }) // withdrawn
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(337) } }) // available
      prisma.user.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2) // 一级/二级人数
      prisma.user.findMany.mockResolvedValue([
        {
          id: 21,
          username: "王强",
          corpPassUp: null, // 未单独设定 → 跟随全局 false
          teamMemberships: [{ team: { id: 40, name: "王强的团队" } }],
        },
        {
          id: 22,
          username: "陈晓",
          corpPassUp: true, // 单独开 → 覆盖全局
          teamMemberships: [{ team: { id: 41, name: "陈晓的团队" } }],
        },
      ])

      const res = await service.getInviteRebateDetail(12)

      expect(res.rebate).toEqual({ earned: "637", withdrawn: "300", available: "337" })
      expect(res.network).toEqual({ level1Count: 3, level2Count: 2 })
      expect(res.corpKids).toEqual([
        {
          userId: 21,
          username: "王强",
          teamId: 40,
          teamName: "王强的团队",
          enabled: false, // corpPassUp null → 跟随全局 corpCounts=false
          overridden: false,
        },
        {
          userId: 22,
          username: "陈晓",
          teamId: 41,
          teamName: "陈晓的团队",
          enabled: true, // 单独设定优先
          overridden: true,
        },
      ])
      expect(res.upstreamRebateRate).toBe("0.1") // 上级 level2RebateRate=null → 全局默认
    })

    it("无上级 → upstreamRebateRate=null；用户不存在 → 404", async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 12, invitedById: null })
      prisma.rebateRule.findFirst.mockResolvedValue(null) // 无规则行 → 默认 corpCounts=true
      prisma.creditTransaction.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(0) } })
      prisma.creditLot.aggregate.mockResolvedValue({ _sum: { remaining: new Decimal(0) } })
      prisma.user.count.mockResolvedValue(0)
      prisma.user.findMany.mockResolvedValue([])

      const res = await service.getInviteRebateDetail(12)
      expect(res.upstreamRebateRate).toBeNull()
      expect(res.corpKids).toEqual([])

      prisma.user.findUnique.mockReset().mockResolvedValue(null)
      await expect(service.getInviteRebateDetail(99)).rejects.toThrow(NotFoundException)
    })
  })

  describe("exportCsv", () => {
    it("BOM + 逗号/引号转义 + 本体/一级/二级行结构（规则缺省 corpCounts=true）", async () => {
      prisma.user.findUnique.mockResolvedValue({ ...rootUser, username: 'ro"ot' })
      prisma.rebateRule.findFirst.mockResolvedValue(null)
      prisma.inviteApplication.count.mockResolvedValue(0)
      prisma.user.findMany
        .mockResolvedValueOnce([
          {
            id: 2,
            username: "张,三",
            phone: "13300000002",
            canInvite: true,
            isActive: true,
            discount: new Decimal(1),
            rebateRate: new Decimal(0.3),
            teamMemberships: [],
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 4,
            username: '李"四',
            phone: "13300000004",
            invitedById: 2,
            canInvite: false,
            isActive: true,
            discount: new Decimal(1),
            rebateRate: new Decimal(0.3),
            teamMemberships: [],
          },
        ])
      prisma.creditTransaction.groupBy
        .mockResolvedValueOnce([{ userId: 2, _sum: { amount: new Decimal(100) } }])
        .mockResolvedValueOnce([])

      const csv = await service.exportCsv(1)
      expect(csv.charCodeAt(0)).toBe(0xfeff)
      const lines = csv.slice(1).split("\n")
      expect(lines).toHaveLength(4)
      expect(lines[0]).toBe(
        "层级,用户ID,用户名,上级,本月消耗积分,本月贡献返利,二级人数,企业池消耗计返利"
      )
      expect(lines[1]).toBe('本体,1,"ro""ot",,,,,是')
      expect(lines[2]).toBe('一级,2,"张,三","ro""ot",100,0,1,是')
      expect(lines[3]).toBe('二级,4,"李""四","张,三",0,,,是')
    })
  })

  describe("getDashboard", () => {
    it("汇总卡 4 项 + 明细行（返利倒序、手机号脱敏、内存分页）", async () => {
      prisma.user.count.mockResolvedValue(2) // inviterCount
      prisma.inviteApplication.count.mockResolvedValue(86) // invitedTotal
      prisma.creditTransaction.aggregate
        .mockResolvedValueOnce({ _sum: { amount: new Decimal("125600") } }) // inviteeConsumed
        .mockResolvedValueOnce({ _sum: { amount: new Decimal("37680") } }) // rebateTotal
      // 分销代理（canInvite=true）列表
      prisma.user.findMany.mockResolvedValueOnce([
        {
          id: 12,
          username: "王老板",
          phone: "13800001111",
          rebateRate: new Decimal("0.3"),
          discount: new Decimal("0.8"),
        },
        {
          id: 13,
          username: "李分销",
          phone: "13900002222",
          rebateRate: new Decimal("0.2"),
          discount: new Decimal("1"),
        },
      ])
      // 直接下级（id→邀请人）
      prisma.user.findMany.mockResolvedValueOnce([
        { id: 21, invitedById: 12 },
        { id: 22, invitedById: 12 },
        { id: 23, invitedById: 13 },
      ])
      prisma.creditTransaction.groupBy
        .mockResolvedValueOnce([
          { userId: 21, _sum: { amount: new Decimal("15000") } },
          { userId: 22, _sum: { amount: new Decimal("7000") } },
          { userId: 23, _sum: { amount: new Decimal("3000") } },
        ]) // 下级消耗
        .mockResolvedValueOnce([
          { userId: 12, _sum: { amount: new Decimal("6600") } },
          { userId: 13, _sum: { amount: new Decimal("900") } },
        ]) // 邀请人返利

      const res = await service.getDashboard({ page: 1, pageSize: 10 })

      expect(res.summary).toEqual({
        inviterCount: 2,
        invitedTotal: 86,
        inviteeConsumed: "125600",
        rebateTotal: "37680",
      })
      expect(res.total).toBe(2)
      // 返利倒序：王老板(6600) 在前
      expect(res.items[0]).toEqual({
        userId: 12,
        username: "王老板",
        phone: "138****1111",
        invitedCount: 2,
        inviteeConsumed: "22000",
        rebateEarned: "6600",
        rebateRate: "0.3",
        discount: "0.8",
      })
      expect(res.items[1]).toMatchObject({ userId: 13, invitedCount: 1, inviteeConsumed: "3000" })
      // 汇总 inviteeConsumed 按「全部被邀用户」过滤（与行级「直接下级」口径不同）
      const summaryConsumeWhere = (
        prisma.creditTransaction.aggregate.mock.calls as unknown as Array<[{ where: unknown }]>
      )[0][0].where
      expect(summaryConsumeWhere).toEqual({
        type: { in: [CreditTxnType.CONSUME, CreditTxnType.TEAM_CONSUME] },
        user: { invitedById: { not: null } },
      })
    })

    it("无分销代理 → 明细空、不查下级与聚合", async () => {
      prisma.user.count.mockResolvedValue(0)
      prisma.inviteApplication.count.mockResolvedValue(0)
      prisma.user.findMany.mockResolvedValue([]) // inviters 空

      const res = await service.getDashboard({ page: 1, pageSize: 10 })
      expect(res.items).toEqual([])
      expect(res.total).toBe(0)
      expect(res.totalPages).toBe(0)
      expect(prisma.creditTransaction.groupBy).not.toHaveBeenCalled()
    })
  })

  it("exportAllCsv：全局一次导出全部网络，字段按原型、消耗/返利归属全历史累计（2026-09-02 bug29）", async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 1 }]) // 一个网络根（无邀请人且有下级）
    prisma.user.groupBy.mockResolvedValue([
      { invitedById: 1, _count: { _all: 2 } }, // 根直接下线 2
      { invitedById: 2, _count: { _all: 1 } }, // 李小璐直接下线 1
    ])
    const fakeTree = {
      user: {
        id: 1,
        username: "吴君如",
        phone: "176****1223",
        canInvite: true,
        level1Total: 2,
        totalConsumed: "13",
        team: null,
      },
      level1: [
        {
          id: 2,
          username: "李小璐",
          phone: "178****5832",
          canInvite: true,
          level2Total: 1,
          totalConsumed: "20",
          team: { id: 9, name: "星辰科技", role: "ADMIN" },
          rebateAttribution: [{ userId: 1, username: "吴君如", amount: "5", totalAmount: "5.5" }],
          level2All: [
            {
              id: 3,
              username: "李乐乐",
              phone: "167****9081",
              canInvite: false,
              totalConsumed: "27",
              team: null,
              // 二级 → 一级上级 + 根，多级精确值（4dp 不截断）
              rebateAttribution: [
                { userId: 2, username: "李小璐", amount: "8", totalAmount: "8" },
                { userId: 1, username: "吴君如", amount: "2", totalAmount: "2" },
              ],
            },
          ],
        },
        {
          id: 4,
          username: "罗通",
          phone: "156****2222",
          canInvite: false,
          level2Total: 0,
          totalConsumed: "105",
          team: { id: 10, name: null, role: "MEMBER" }, // 未命名企业成员
          rebateAttribution: [],
          level2All: [],
        },
      ],
    }
    jest
      .spyOn(
        service as unknown as { loadTree: (id: number) => Promise<typeof fakeTree> },
        "loadTree"
      )
      .mockResolvedValue(fakeTree)

    const csv = await service.exportAllCsv()
    const rows = csv.split("\n")
    expect(rows[0]).toContain("姓名,手机号,邀请人,身份,直接下线,消耗,返利归属,企业归属")
    expect(rows[1]).toBe("吴君如,176****1223,—,团队长,2,13,—,个人计费")
    expect(rows[2]).toBe("李小璐,178****5832,吴君如,可邀请,1,20,吴君如+5.5,星辰科技")
    expect(rows[3]).toBe("李乐乐,167****9081,李小璐,普通,0,27,李小璐+8 / 吴君如+2,个人计费")
    expect(rows[4]).toBe("罗通,156****2222,吴君如,普通,0,105,—,未命名团队")
  })
})

describe("InviteService.getMyInvite（分销扩展字段）", () => {
  let inviteService: InviteService
  let prisma: {
    user: { findUnique: jest.Mock; count: jest.Mock; findMany: jest.Mock }
    inviteApplication: { findMany: jest.Mock; count: jest.Mock }
    creditTransaction: { aggregate: jest.Mock }
    creditLot: { aggregate: jest.Mock; groupBy: jest.Mock }
    rebateRule: { findFirst: jest.Mock }
  }

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      inviteApplication: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn() },
      creditTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal(0) } }),
      },
      creditLot: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { remaining: new Decimal(0) } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      rebateRule: { findFirst: jest.fn().mockResolvedValue(null) },
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        InviteService,
        { provide: DefaultMemberRoleService, useValue: { assign: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: {} },
        { provide: MailProvider, useValue: {} },
        { provide: WalletService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: AdminDistService, useValue: { getTree: jest.fn() } },
      ],
    }).compile()
    inviteService = moduleRef.get(InviteService)
  })

  it("返回 inviteQuota/inviteQuotaUsed/subInviteAllowed + 二级网络统计 + networkStats 统计卡", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 1,
      canInvite: true,
      shareCreditsWithInvitees: false,
      inviteCode: "OSAB12",
      inviteCodeExpiresAt: new Date(Date.now() + 3600_000),
      inviteQuota: 10,
      subInviteAllowed: true,
      rebateRate: new Decimal("0.3"),
      level2RebateRate: null, // → 默认 0.10
    })
    prisma.inviteApplication.count.mockResolvedValue(4)
    prisma.user.findMany
      .mockResolvedValueOnce([
        { id: 11, corpPassUp: null, teamMemberships: [] },
        { id: 12, corpPassUp: null, teamMemberships: [] },
      ]) // 一级 2 人
      .mockResolvedValueOnce([
        { id: 21, corpPassUp: null, teamMemberships: [] },
        { id: 22, corpPassUp: null, teamMemberships: [] },
        { id: 23, corpPassUp: null, teamMemberships: [] },
        { id: 24, corpPassUp: null, teamMemberships: [] },
        { id: 25, corpPassUp: null, teamMemberships: [] },
      ]) // 二级 5 人
    // 聚合调用顺序：getRebateSummary（earned/withdrawn → txn.agg ×2，available → lot.agg ×1）
    // → networkStats（consumed → txn.agg ×1，l1/l2 剩余 → lot.agg ×2）
    prisma.creditTransaction.aggregate
      .mockResolvedValueOnce({ _sum: { amount: new Decimal(0) } }) // earned
      .mockResolvedValueOnce({ _sum: { amount: new Decimal(0) } }) // withdrawn
      .mockResolvedValueOnce({ _sum: { amount: new Decimal(100) } }) // 网络消耗合计
    prisma.creditLot.aggregate
      .mockResolvedValueOnce({ _sum: { remaining: new Decimal(0) } }) // available（REBATE）
      .mockResolvedValueOnce({ _sum: { remaining: new Decimal(200) } }) // 一级剩余
      .mockResolvedValueOnce({ _sum: { remaining: new Decimal(300) } }) // 二级剩余

    const res = await inviteService.getMyInvite(1)
    expect(res.inviteCode).toBe("OSAB12")
    expect(res.inviteQuota).toBe(10)
    expect(res.inviteQuotaUsed).toBe(4)
    expect(res.subInviteAllowed).toBe(true)
    expect(res.network).toEqual({ level1Count: 2, level2Count: 5 })
    expect(res.rebate).toEqual({ earned: "0", withdrawn: "0", available: "0" })
    // networkStats：消耗 100；剩余 200+300=500；曾有总量 600；待结算 200×0.3 + 300×0.1 = 90；预计 = earned 0 + 90
    expect(res.networkStats).toEqual({
      consumedTotal: "100",
      remainingTotal: "500",
      rechargedTotal: "600",
      rebateRate: "0.3",
      level2RebateRate: "0.1",
      pendingRebate: "90",
      estimatedRebate: "90",
      corpPoolRemainingExcluded: "0",
    })
    // 名额口径 = 已批 APPROVED 申请数
    expect(prisma.inviteApplication.count).toHaveBeenCalledWith({
      where: { inviterId: 1, status: InviteAppStatus.APPROVED },
    })
  })

  it("无下级：聚合跳过，networkStats 全 0", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 1,
      canInvite: true,
      inviteCode: "OSAB12",
      inviteCodeExpiresAt: new Date(Date.now() + 3600_000),
      inviteQuota: null,
      subInviteAllowed: false,
      rebateRate: new Decimal("0.3"),
      level2RebateRate: null,
    })
    prisma.inviteApplication.count.mockResolvedValue(0)
    // user.findMany 默认 []（一级/二级都空）

    const res = await inviteService.getMyInvite(1)
    expect(res.network).toEqual({ level1Count: 0, level2Count: 0 })
    expect(res.networkStats).toEqual({
      consumedTotal: "0",
      remainingTotal: "0",
      rechargedTotal: "0",
      rebateRate: "0.3",
      level2RebateRate: "0.1",
      pendingRebate: "0",
      estimatedRebate: "0",
      corpPoolRemainingExcluded: "0",
    })
    expect(prisma.creditTransaction.aggregate).toHaveBeenCalledTimes(2) // 仅返利汇总两次（REBATE_IN/WITHDRAW），网络为空不跑消耗聚合
  })

  it("企业管理员下级：池消耗/池剩余卷起挂所在层；不计返利池不进预估（corpPoolRemainingExcluded 透出）", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 1,
      canInvite: true,
      shareCreditsWithInvitees: false,
      inviteCode: "OSAB12",
      inviteCodeExpiresAt: new Date(Date.now() + 3600_000),
      inviteQuota: null,
      subInviteAllowed: true,
      rebateRate: new Decimal("0.3"),
      level2RebateRate: null, // → 默认 0.10
    })
    prisma.inviteApplication.count.mockResolvedValue(0)
    prisma.user.findMany
      .mockResolvedValueOnce([
        // 一级：11=企业41管理员（corpPassUp 未设 → 随全局 true，池计返利）；12=企业42管理员（逐人关，池不计返利）
        { id: 11, corpPassUp: null, teamMemberships: [{ teamId: 41, team: { status: "ACTIVE" } }] },
        {
          id: 12,
          corpPassUp: false,
          teamMemberships: [{ teamId: 42, team: { status: "ACTIVE" } }],
        },
      ])
      .mockResolvedValueOnce([]) // 二级空
    // 聚合顺序：返利汇总（txn×2 + lot×1）→ 统计卡（个人消耗/池消耗 → txn×2；一级剩余 → lot×1；池剩余 → lot.groupBy；全局规则）
    prisma.creditTransaction.aggregate
      .mockResolvedValueOnce({ _sum: { amount: new Decimal(0) } }) // earned
      .mockResolvedValueOnce({ _sum: { amount: new Decimal(0) } }) // withdrawn
      .mockResolvedValueOnce({ _sum: { amount: new Decimal(10) } }) // 个人段消耗
      .mockResolvedValueOnce({ _sum: { amount: new Decimal(90) } }) // 池段消耗（全队）
    prisma.creditLot.aggregate
      .mockResolvedValueOnce({ _sum: { remaining: new Decimal(0) } }) // available（REBATE）
      .mockResolvedValueOnce({ _sum: { remaining: new Decimal(100) } }) // 一级个人剩余
    prisma.creditLot.groupBy.mockResolvedValue([
      { teamId: 41, _sum: { remaining: new Decimal(200) } },
      { teamId: 42, _sum: { remaining: new Decimal(300) } },
    ])
    prisma.rebateRule.findFirst.mockResolvedValue({ corpCounts: true })

    const res = await inviteService.getMyInvite(1)
    expect(res.networkStats).toEqual({
      consumedTotal: "100", // 10 个人 + 90 池
      remainingTotal: "600", // 100 个人 + 200 池41 + 300 池42
      rechargedTotal: "700",
      rebateRate: "0.3",
      level2RebateRate: "0.1",
      pendingRebate: "90", // (100+200)×0.3；池42 不计返利不进预估
      estimatedRebate: "90",
      corpPoolRemainingExcluded: "300",
    })
    // 个人剩余查询剔除企业池批次（teamId:null），池剩余按 teamId 分组查
    const lastLotAgg = (
      prisma.creditLot.aggregate.mock.calls as { where: Record<string, unknown> }[][]
    ).at(-1)?.[0]
    expect(lastLotAgg?.where.teamId).toBeNull()
    const groupByArg = (
      prisma.creditLot.groupBy.mock.calls as {
        by: string[]
        where: { teamId: { in: number[] } }
      }[][]
    )[0]?.[0]
    expect(groupByArg?.by).toEqual(["teamId"])
    expect(groupByArg?.where.teamId.in).toEqual([41, 42])
  })
})
