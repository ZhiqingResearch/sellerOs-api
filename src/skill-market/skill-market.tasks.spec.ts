import { Test } from "@nestjs/testing"
import { PrismaService } from "../prisma/prisma.service"
import { SkillMarketTasks } from "./skill-market.tasks"

describe("SkillMarketTasks 计数校准", () => {
  let tasks: SkillMarketTasks
  let prisma: {
    skillMarketSkill: { findMany: jest.Mock; update: jest.Mock }
    skillMarketUserSkill: { groupBy: jest.Mock }
    skillMarketDownloadEvent: { groupBy: jest.Mock }
  }

  beforeEach(async () => {
    prisma = {
      skillMarketSkill: { findMany: jest.fn(), update: jest.fn() },
      skillMarketUserSkill: { groupBy: jest.fn() },
      skillMarketDownloadEvent: { groupBy: jest.fn() },
    }
    const moduleRef = await Test.createTestingModule({
      providers: [SkillMarketTasks, { provide: PrismaService, useValue: prisma }],
    }).compile()
    tasks = moduleRef.get(SkillMarketTasks)
  })

  it("按关系表/事件表回写偏差计数，removedAt 行同样计入去重数", async () => {
    prisma.skillMarketUserSkill.groupBy.mockResolvedValue([
      { skillId: "listing-opt", _count: { _all: 3 } }, // 含 removedAt 行
      { skillId: "trending", _count: { _all: 1 } },
    ])
    prisma.skillMarketDownloadEvent.groupBy.mockResolvedValue([
      { skillId: "listing-opt", _count: { _all: 5 } },
    ])
    prisma.skillMarketSkill.findMany.mockResolvedValue([
      // listing-opt 两个计数都有偏差；trending 事件数缺（缓存 1 → 应为 0）
      { id: 1, skillId: "listing-opt", downloadCount: BigInt(2), downloadEventCount: BigInt(4) },
      { id: 2, skillId: "trending", downloadCount: BigInt(1), downloadEventCount: BigInt(1) },
      // 无任何数据的技能：两个缓存都应归零
      { id: 3, skillId: "neg-kw", downloadCount: BigInt(7), downloadEventCount: BigInt(0) },
    ])
    prisma.skillMarketSkill.update.mockResolvedValue({})

    await tasks.handleDailyCalibrate()

    const updates = prisma.skillMarketSkill.update.mock.calls as Array<
      [{ where: { id: number }; data: Record<string, unknown> }]
    >
    expect(updates).toHaveLength(3)
    expect(updates[0][0]).toMatchObject({
      where: { id: 1 },
      data: { downloadCount: BigInt(3), downloadEventCount: BigInt(5) },
    })
    expect(updates[1][0]).toMatchObject({
      where: { id: 2 },
      data: { downloadCount: BigInt(1), downloadEventCount: BigInt(0) },
    })
    expect(updates[2][0]).toMatchObject({
      where: { id: 3 },
      data: { downloadCount: BigInt(0), downloadEventCount: BigInt(0) },
    })
  })

  it("计数一致时不产生任何写操作", async () => {
    prisma.skillMarketUserSkill.groupBy.mockResolvedValue([
      { skillId: "listing-opt", _count: { _all: 3 } },
    ])
    prisma.skillMarketDownloadEvent.groupBy.mockResolvedValue([
      { skillId: "listing-opt", _count: { _all: 5 } },
    ])
    prisma.skillMarketSkill.findMany.mockResolvedValue([
      { id: 1, skillId: "listing-opt", downloadCount: BigInt(3), downloadEventCount: BigInt(5) },
    ])

    await tasks.handleDailyCalibrate()

    expect(prisma.skillMarketSkill.update).not.toHaveBeenCalled()
  })

  it("任务异常不抛出（不影响进程）", async () => {
    prisma.skillMarketUserSkill.groupBy.mockRejectedValue(new Error("db down"))

    await expect(tasks.handleDailyCalibrate()).resolves.toBeUndefined()
  })
})
