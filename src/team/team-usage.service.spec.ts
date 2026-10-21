import { Test } from "@nestjs/testing"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { TeamUsageService } from "./team-usage.service"

/** 用量分析 CSV 导出：成本（元）明细与合计统一两位小数（与页面 toFixed(2) 同口径）。 */
describe("TeamUsageService.exportCsv", () => {
  let service: TeamUsageService
  let prisma: {
    teamMember: { findMany: jest.Mock }
    usageLog: { findMany: jest.Mock }
    creditTransaction: { aggregate: jest.Mock; findMany: jest.Mock }
    aiModel: { findMany: jest.Mock }
    user: { findMany: jest.Mock }
  }

  beforeEach(async () => {
    prisma = {
      teamMember: {
        findMany: jest.fn().mockResolvedValue([
          { userId: 1, user: { id: 1, username: "赵芮" } },
          { userId: 2, user: { id: 2, username: "小李" } },
        ]),
      },
      usageLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 1,
            source: "listing.generate",
            credits: new Decimal(21),
            cost: new Decimal("1.743467"),
            meta: { model: "gemini-3.1-pro" },
          },
          {
            userId: 2,
            source: "listing.score",
            credits: new Decimal(3),
            cost: new Decimal("0.2"),
            meta: { model: "gemini-3.1-pro" },
          },
        ]),
      },
      creditTransaction: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal(24) } }),
        findMany: jest.fn().mockResolvedValue([]), // 默认无已移出消费者
      },
      aiModel: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    }
    const module = await Test.createTestingModule({
      providers: [TeamUsageService, { provide: PrismaService, useValue: prisma }],
    }).compile()
    service = module.get(TeamUsageService)
  })

  it.each(["member", "source", "model"] as const)(
    "%s 维度：成本明细与合计均两位小数",
    async dim => {
      const csv = await service.exportCsv(10, { dimension: dim })
      // 任何行都不得出现数据库原始六位精度
      expect(csv).not.toContain("1.743467")
      expect(csv).not.toContain("1.943467")
      const lines = csv.split("\n")
      const total = lines[lines.length - 1]
      // 合计行成本 = 1.743467 + 0.2 = 1.943467 → 1.94
      expect(total.startsWith("合计,")).toBe(true)
      expect(total).toContain("1.94")
    }
  )

  it("member 维度：明细行成本两位小数（1.743467 → 1.74、0.2 → 0.20）", async () => {
    const lines = (await service.exportCsv(10, { dimension: "member" })).split("\n")
    expect(lines[1]).toContain("1.74")
    expect(lines[2]).toContain("0.20")
  })

  it("member 维度表头含状态列，成员名渲染", async () => {
    const csv = await service.exportCsv(10, { dimension: "member" })
    expect(csv.split("\n")[0]).toBe("﻿成员,状态,调用次数,消耗积分,成本(元)")
    expect(csv).toContain("赵芮")
    expect(csv).toContain("小李")
  })

  it("停用成员：用量照常计入，memberStatus=DISABLED 且 label 纯姓名（CSV 状态列=已停用）", async () => {
    prisma.teamMember.findMany.mockResolvedValue([
      { userId: 1, status: "ACTIVE", user: { id: 1, username: "赵芮" } },
      { userId: 2, status: "DISABLED", user: { id: 2, username: "小李" } },
    ])
    const agg = await service.aggregate(10, { dimension: "member" })
    const byKey = new Map(agg.rows.map(r => [r.key, r]))
    expect(byKey.get("1")).toMatchObject({ label: "赵芮", memberStatus: "ACTIVE" })
    expect(byKey.get("2")).toMatchObject({ label: "小李", memberStatus: "DISABLED" })
    // 合计仍含停用成员的用量（赵芮 21 + 小李 3 = 24）
    expect(agg.total.credits.toString()).toBe("24")
    // CSV：label 纯姓名 + 状态列中文
    const csv = await service.exportCsv(10, { dimension: "member" })
    expect(csv).toContain("小李,已停用,")
    expect(csv).not.toContain("小李（已停用）")
  })

  it("已移出但用过企业积分的用户：memberStatus=REMOVED，功能/模型维度与合计都算上", async () => {
    // 成员行已删的 user 9：区间内有 TEAM_CONSUME 流水 → 找回并纳入统计
    prisma.creditTransaction.findMany.mockResolvedValue([{ userId: 9 }])
    prisma.user.findMany.mockResolvedValue([{ id: 9, username: "老王" }])
    prisma.usageLog.findMany.mockResolvedValue([
      {
        userId: 9,
        source: "listing.generate",
        credits: new Decimal(5),
        cost: new Decimal("0.5"),
        meta: { model: "gemini-3.1-pro" },
      },
    ])

    // 成员维度：label 纯姓名 + memberStatus=REMOVED；CSV 状态列=已移出
    const memberAgg = await service.aggregate(10, { dimension: "member" })
    expect(memberAgg.rows[0]).toMatchObject({ label: "老王", memberStatus: "REMOVED" })
    const memberCsv = await service.exportCsv(10, { dimension: "member" })
    expect(memberCsv).toContain("老王,已移出,")
    expect(memberCsv).not.toContain("老王（已移出）")

    // 功能/模型维度与合计也算上已移出用户（非 member 维度 memberStatus=null）
    const agg = await service.aggregate(10, { dimension: "source" })
    expect(agg.rows).toHaveLength(1)
    expect(agg.rows[0].key).toBe("listing.generate")
    expect(agg.rows[0].memberStatus).toBeNull()
    expect(agg.rows[0].calls).toBe(1)
    expect(agg.rows[0].credits.toString()).toBe("5")
    expect(agg.rows[0].costCny.toString()).toBe("0.5")
    expect(agg.total.calls).toBe(1)
    expect(agg.total.credits.toString()).toBe("5")

    // UsageLog 扫描范围含已移出用户 id（当前成员 1/2 + 已移出 9）
    const logCall = (
      prisma.usageLog.findMany.mock.calls.at(-1) as [{ where: { userId: { in: number[] } } }]
    )[0]
    expect(logCall.where.userId.in).toEqual(expect.arrayContaining([1, 2, 9]))
  })
})
