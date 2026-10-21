import { Test } from "@nestjs/testing"
import { Decimal } from "@prisma/client/runtime/library"
import { DefaultMemberRoleService } from "../common/services/default-member-role.service"
import { CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"
import { TeamLifecycleTask } from "./tasks/team-lifecycle.task"
import { TeamPoolService } from "./team-pool.service"
import { SYSTEM_ACTOR_ID } from "./team.constants"
import { TeamService } from "./team.service"

type AuditCreate = {
  data: { teamId: number; actorId: number; action: string; meta: Record<string, unknown> }
}

/** jest.Mock 的 calls 为 any；提取第 n 次调用实参并显式收窄类型后断言 */
const callArgs = <T extends unknown[]>(mock: jest.Mock, call: number): T => {
  const calls = mock.mock.calls as unknown[][]
  return calls[call] as T
}

/**
 * 生命周期推进逻辑在 TeamService.runLifecycle（transitionToGrace / transitionToArchived），
 * TeamLifecycleTask 仅负责调度与顶层异常兜底。这里用真实 TeamService + mock 协作者，
 * 经任务入口驱动，覆盖 GRACE/ARCHIVED 推进、幂等与异常行为。
 */
describe("TeamLifecycleTask", () => {
  const NOW = new Date("2026-08-20T00:00:00.000Z")

  let task: TeamLifecycleTask
  let team: TeamService
  let prisma: {
    team: {
      findMany: jest.Mock
      findUnique: jest.Mock
      findUniqueOrThrow: jest.Mock
      updateMany: jest.Mock
    }
    teamMember: { findUnique: jest.Mock; updateMany: jest.Mock }
    teamAuditLog: { create: jest.Mock }
    scheduledPlan: { findMany: jest.Mock }
    $transaction: jest.Mock
  }
  let credit: { archiveTeamPool: jest.Mock }
  let pool: Record<string, jest.Mock>

  /** 按查询的 status 分发到期行：ACTIVE 查询返回 activeDue，GRACE 查询返回 graceDue */
  const mockDueRows = (activeDue: unknown[], graceDue: unknown[]) => {
    prisma.team.findMany.mockImplementation((args: { where: { status: string } }) =>
      Promise.resolve(args.where.status === "ACTIVE" ? activeDue : graceDue)
    )
  }
  const lastAudit = (): AuditCreate => callArgs<[AuditCreate]>(prisma.teamAuditLog.create, 0)[0]

  beforeEach(async () => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW.getTime())
    prisma = {
      team: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        // archiveOneTeam 认领成功后读 adminId（退充值池用）
        findUniqueOrThrow: jest.fn().mockResolvedValue({ adminId: 100 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      teamMember: {
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      teamAuditLog: { create: jest.fn().mockResolvedValue({}) },
      // runLifecycle 先激活到期排队续费（M2b 新增），默认无到期排队单
      scheduledPlan: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    }
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma))
    credit = { archiveTeamPool: jest.fn().mockResolvedValue({ returned: new Decimal(0) }) }
    pool = {}

    const moduleRef = await Test.createTestingModule({
      providers: [
        TeamLifecycleTask,
        TeamService,
        { provide: DefaultMemberRoleService, useValue: { assign: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: CreditService, useValue: credit },
        { provide: TeamPoolService, useValue: pool },
      ],
    }).compile()
    task = moduleRef.get(TeamLifecycleTask)
    team = moduleRef.get(TeamService)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("进程启动时补跑一次生命周期（fire-and-forget catch-up）", () => {
    const spy = jest.spyOn(team, "runLifecycle").mockResolvedValue({ grace: 0, archived: 0 })
    task.onModuleInit()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it("到期 ACTIVE 团队推进 GRACE（宽限期开始）并写审计，不动池", async () => {
    mockDueRows([{ id: 1 }], [])

    await task.handleDailyLifecycle()

    expect(prisma.team.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: "ACTIVE", expiresAt: { lte: NOW } },
      data: { status: "GRACE" },
    })
    expect(lastAudit().data).toMatchObject({
      teamId: 1,
      actorId: SYSTEM_ACTOR_ID,
      action: "TEAM_GRACE",
    })
    expect(credit.archiveTeamPool).not.toHaveBeenCalled()
  })

  it("宽限期满 GRACE 团队推进 ARCHIVED：archiveTeamPool 退池 + 成员置 ARCHIVED + 审计", async () => {
    mockDueRows([], [{ id: 2, adminId: 100 }])
    credit.archiveTeamPool.mockResolvedValue({ returned: new Decimal(500) })

    await task.handleDailyLifecycle()

    expect(prisma.team.updateMany).toHaveBeenCalledWith({
      where: { id: 2, status: "GRACE" },
      data: { status: "ARCHIVED", archivedAt: NOW },
    })
    // 充值池退管理员个人户、套餐/赠送池清零（CreditService 内部完成），tx 为当前事务
    expect(credit.archiveTeamPool).toHaveBeenCalledWith(2, 100, prisma)
    // 成员名单保留但状态置 ARCHIVED
    expect(prisma.teamMember.updateMany).toHaveBeenCalledWith({
      where: { teamId: 2, status: { not: "ARCHIVED" } },
      data: { status: "ARCHIVED" },
    })
    expect(lastAudit().data).toMatchObject({
      teamId: 2,
      actorId: SYSTEM_ACTOR_ID,
      action: "TEAM_ARCHIVE",
      meta: { returnedToAdmin: "500" },
    })
  })

  it("幂等：到期行被并发认领（count=0）时跳过入账与审计；无到期行时不做任何写操作", async () => {
    mockDueRows([{ id: 1 }], [{ id: 2, adminId: 100 }])
    prisma.team.updateMany.mockResolvedValue({ count: 0 })

    await task.handleDailyLifecycle()

    expect(prisma.teamAuditLog.create).not.toHaveBeenCalled()
    expect(credit.archiveTeamPool).not.toHaveBeenCalled()
    expect(prisma.teamMember.updateMany).not.toHaveBeenCalled()

    // 重复跑：已无到期行，连 updateMany 都不触发
    prisma.team.findMany.mockResolvedValue([])
    prisma.team.updateMany.mockClear()
    await task.handleDailyLifecycle()
    expect(prisma.team.updateMany).not.toHaveBeenCalled()
  })

  it("服务层实际行为：某行事务失败会中断本轮（异常向上传播，后续行不再处理）", async () => {
    mockDueRows([{ id: 1 }, { id: 2 }], [])
    prisma.$transaction.mockRejectedValue(new Error("db down"))

    await expect(team.runLifecycle(NOW)).rejects.toThrow("db down")
    // 首行即失败：claim 未执行，第二行也未处理
    expect(prisma.team.updateMany).not.toHaveBeenCalled()
    expect(credit.archiveTeamPool).not.toHaveBeenCalled()
  })

  it("任务层兜底：runLifecycle 抛错被捕获记日志，不向调度器抛出", async () => {
    mockDueRows([{ id: 1 }, { id: 2 }], [])
    prisma.$transaction.mockRejectedValue(new Error("db down"))
    const loggerError = jest
      .spyOn((task as unknown as { logger: { error: (msg: string) => void } }).logger, "error")
      .mockImplementation(() => undefined)

    await expect(task.handleDailyLifecycle()).resolves.toBeUndefined()

    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("db down"))
    expect(prisma.team.updateMany).not.toHaveBeenCalled()
  })

  describe("archiveEarly（手动提前归档）", () => {
    it("GRACE 团队由本团队 ACTIVE 管理员归档：走与自动归档同一路径，审计 actorId=操作人", async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 2, status: "GRACE" })
      prisma.teamMember.findUnique.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" })
      credit.archiveTeamPool.mockResolvedValue({ returned: new Decimal(300) })

      const res = await team.archiveEarly(2, 100)

      expect(res).toEqual({ archived: true, alreadyArchived: false })
      expect(prisma.team.updateMany).toHaveBeenCalledWith({
        where: { id: 2, status: "GRACE" },
        data: { status: "ARCHIVED", archivedAt: NOW },
      })
      expect(credit.archiveTeamPool).toHaveBeenCalledWith(2, 100, prisma)
      expect(prisma.teamMember.updateMany).toHaveBeenCalledWith({
        where: { teamId: 2, status: { not: "ARCHIVED" } },
        data: { status: "ARCHIVED" },
      })
      expect(lastAudit().data).toMatchObject({
        teamId: 2,
        actorId: 100, // 操作人而非系统
        action: "TEAM_ARCHIVE",
        meta: { returnedToAdmin: "300" },
      })
    })

    it("幂等：已 ARCHIVED 直接返回成功，不重复清零/退回/写审计", async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 2, status: "ARCHIVED" })
      prisma.teamMember.findUnique.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" })

      const res = await team.archiveEarly(2, 100)

      expect(res).toEqual({ archived: true, alreadyArchived: true })
      expect(prisma.team.updateMany).not.toHaveBeenCalled()
      expect(credit.archiveTeamPool).not.toHaveBeenCalled()
      expect(prisma.teamAuditLog.create).not.toHaveBeenCalled()
    })

    it("ACTIVE 团队拒绝（仅宽限期可提前归档）", async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 2, status: "ACTIVE" })
      prisma.teamMember.findUnique.mockResolvedValue({ role: "ADMIN", status: "ACTIVE" })

      await expect(team.archiveEarly(2, 100)).rejects.toThrow("仅宽限期")
      expect(prisma.team.updateMany).not.toHaveBeenCalled()
    })

    it("非本团队 ACTIVE 管理员 403：普通成员 / 停用管理员 / 非成员", async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 2, status: "GRACE" })
      prisma.teamMember.findUnique.mockResolvedValue({ role: "MEMBER", status: "ACTIVE" })
      await expect(team.archiveEarly(2, 100)).rejects.toThrow("仅本团队管理员")

      prisma.teamMember.findUnique.mockResolvedValue({ role: "ADMIN", status: "DISABLED" })
      await expect(team.archiveEarly(2, 100)).rejects.toThrow("仅本团队管理员")

      prisma.teamMember.findUnique.mockResolvedValue(null)
      await expect(team.archiveEarly(2, 100)).rejects.toThrow("仅本团队管理员")

      expect(prisma.team.updateMany).not.toHaveBeenCalled()
    })

    it("团队不存在 404", async () => {
      prisma.team.findUnique.mockResolvedValue(null)
      await expect(team.archiveEarly(99, 100)).rejects.toThrow("团队不存在")
    })
  })
})
