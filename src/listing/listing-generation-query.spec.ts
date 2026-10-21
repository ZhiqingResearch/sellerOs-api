import { Logger } from "@nestjs/common"
import { type ListingGenerationTask } from "@prisma/client"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { ListingAiService } from "./listing-ai.service"
import { ListingGenerationService } from "./listing-generation.service"
import { ListingRunService } from "./listing-run.service"

const LARGE_TEXT = "产品规则与上下文".repeat(40_000)
const MODEL_OUTPUT = '{"title":"Golf net","description":"Practice net","bullets":["Portable"]}'
const SCORE_OUTPUT = JSON.stringify({
  total: 80,
  potential: "A",
  suggestions: [],
  dimensions: [{ name: "质量", score: 80, maxScore: 100, criteria: [] }],
})

type TaskQuery = {
  where?: {
    id?: number
    listingRunId?: number
    status?: string | { in: string[] }
    leaseUntil?: { lt: Date }
  }
  select?: Partial<Record<keyof ListingGenerationTask, boolean>>
  orderBy?: unknown
  take?: number
}

function createTask(id: number, status: string): ListingGenerationTask {
  return {
    id,
    attemptId: `attempt-${id}`,
    listingRunId: 20,
    planIndex: id % 2,
    mainStepId: id * 10,
    longTitleStepId: null,
    status,
    isModelComplete: true,
    input: {
      main: { operation: "generation", userPrompt: LARGE_TEXT },
      context: { params: { keyword: "golf net", market: "ebay_us" }, rules: LARGE_TEXT },
      autoScore: { operation: "score", userPrompt: LARGE_TEXT },
      autoScoreStepId: id * 10 + 1,
      result: { title: "Golf net", description: LARGE_TEXT },
    },
    billing: {
      billing: { requestId: `private-billing-${id}` },
      score: { billing: { requestId: `private-score-billing-${id}` } },
      isScoreComplete: true,
    },
    leaseUntil: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function matchesTask(task: ListingGenerationTask, where: TaskQuery["where"] = {}) {
  return (
    (where.id === undefined || task.id === where.id) &&
    (where.listingRunId === undefined || task.listingRunId === where.listingRunId) &&
    (where.status === undefined ||
      (typeof where.status === "string"
        ? task.status === where.status
        : where.status.in.includes(task.status))) &&
    (!where.leaseUntil || (!!task.leaseUntil && task.leaseUntil < where.leaseUntil.lt))
  )
}

function selectTask(task: ListingGenerationTask, query: TaskQuery) {
  return query.select
    ? Object.fromEntries(
        Object.entries(query.select)
          .filter(([, isSelected]) => isSelected)
          .map(([key]) => [key, task[key as keyof ListingGenerationTask]])
      )
    : { ...task }
}

/** 模拟本次故障：大 JSON 随分页/排序查询返回时耗尽排序缓冲，主键读取不受影响。 */
function findTasks(tasks: ListingGenerationTask[], query: TaskQuery, isFirst = false) {
  const results = tasks
    .filter(task => matchesTask(task, query.where))
    .sort((left, right) => left.id - right.id)
    .slice(0, isFirst ? 1 : query.take)
    .map(task => selectTask(task, query))
  if (
    (isFirst || query.orderBy || query.take !== undefined) &&
    results.some(task => Buffer.byteLength(JSON.stringify(task), "utf8") > 262_144)
  ) {
    throw new Error("1038 Out of sort memory")
  }
  return results
}

function createFixture(tasks: ListingGenerationTask[] = []) {
  const prisma = {
    listingGenerationTask: {
      findMany: jest.fn(async (query: TaskQuery) => findTasks(tasks, query)),
      findFirst: jest.fn(async (query: TaskQuery) => findTasks(tasks, query, true)[0] ?? null),
      findUnique: jest.fn(async (query: TaskQuery) => {
        const task = tasks.find(task => matchesTask(task, query.where))
        return task ? selectTask(task, query) : null
      }),
      updateMany: jest.fn(async (query: TaskQuery & { data: Partial<ListingGenerationTask> }) => {
        const matches = tasks.filter(task => matchesTask(task, query.where))
        matches.forEach(task => Object.assign(task, query.data))
        return { count: matches.length }
      }),
    },
    listingRun: {
      findFirst: jest.fn(async (_query: unknown) => ({ id: 20 }) as { id: number } | null),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 20,
        runId: "run",
        historyId: 30,
        history: { userId: 5 },
      }),
    },
    listingAiStep: {
      findMany: jest.fn(async (query: { where: { id: { in: number[] } } }) =>
        query.where.id.in.map(id => ({ id, outputText: `output-${id}-${LARGE_TEXT}` }))
      ),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 11, outputText: SCORE_OUTPUT }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  }
  const gateway = {
    streamChat: jest.fn(async function* (
      _systemPrompt: string,
      _userPrompt: string,
      _options: unknown
    ) {
      yield { type: "text", content: MODEL_OUTPUT }
    }),
  }
  const ai = { chargeSavedOutput: jest.fn().mockResolvedValue(88) }
  const runs = {
    update: jest.fn(
      async (
        _userId: number,
        _runId: string,
        _data: unknown,
        callback: (tx: unknown) => Promise<void>
      ) => callback(prisma)
    ),
  }
  const service = new ListingGenerationService(
    prisma as unknown as PrismaService,
    gateway as unknown as AiGatewayProvider,
    ai as unknown as ListingAiService,
    runs as unknown as ListingRunService
  )
  return { tasks, prisma, gateway, ai, runs, service }
}

function flushExecutions() {
  return new Promise<void>(resolve => setImmediate(resolve))
}

describe("Listing 大上下文查询与队列恢复", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())

  it("大上下文先查摘要再按主键恢复，保留完整正文且不下发账单或其他任务上下文", async () => {
    const ready = createTask(2, "READY")
    ready.longTitleStepId = 22
    const f = createFixture([createTask(3, "COMPLETED"), ready, createTask(1, "QUEUED")])

    const result = await f.service.read(5, "run")

    expect(Buffer.byteLength(JSON.stringify(ready.input), "utf8")).toBeGreaterThan(262_144)
    expect(result).toEqual([
      { attemptId: "attempt-1", status: "QUEUED", planIndex: 1 },
      {
        attemptId: "attempt-2",
        status: "READY",
        planIndex: 0,
        context: { params: { keyword: "golf net", market: "ebay_us" }, rules: LARGE_TEXT },
        isModelComplete: true,
        outputText: `output-20-${LARGE_TEXT}`,
        longTitleText: `output-22-${LARGE_TEXT}`,
        error: null,
      },
      { attemptId: "attempt-3", status: "COMPLETED", planIndex: 1 },
    ])
    expect(f.prisma.listingGenerationTask.findUnique).toHaveBeenCalledTimes(1)
    expect(f.prisma.listingGenerationTask.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 2 } })
    )
    expect(JSON.stringify(result)).not.toContain("private-billing")
  })

  it("无所属权时不读取任何任务或正文", async () => {
    const f = createFixture([createTask(1, "READY")])
    f.prisma.listingRun.findFirst.mockResolvedValue(null)

    await expect(f.service.read(9, "run")).rejects.toThrow("生成记录不存在")

    expect(f.prisma.listingRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: "run", history: { userId: 9 } } })
    )
    expect(f.prisma.listingGenerationTask.findMany).not.toHaveBeenCalled()
    expect(f.prisma.listingGenerationTask.findUnique).not.toHaveBeenCalled()
    expect(f.prisma.listingAiStep.findMany).not.toHaveBeenCalled()
  })

  it("READY 在详情读取前已被完成时只返回最新状态摘要", async () => {
    const f = createFixture([createTask(1, "READY")])
    const findUnique = f.prisma.listingGenerationTask.findUnique.getMockImplementation()!
    f.prisma.listingGenerationTask.findUnique.mockImplementation(async query => {
      f.tasks[0].status = "COMPLETED"
      return findUnique(query)
    })

    expect(await f.service.read(5, "run")).toEqual([
      { attemptId: "attempt-1", status: "COMPLETED", planIndex: 1 },
    ])
    expect(f.prisma.listingAiStep.findMany).not.toHaveBeenCalled()
  })

  it("大 JSON 的评分恢复、主生成和评分队列均可执行且模型收到完整提示词", async () => {
    const f = createFixture([
      createTask(3, "SCORE_QUEUED"),
      createTask(2, "QUEUED"),
      createTask(1, "SCORE_READY"),
    ])

    await f.service.poll()
    await flushExecutions()

    expect(f.runs.update).toHaveBeenCalledWith(
      5,
      "run",
      expect.objectContaining({
        status: "COMPLETED",
        data: expect.objectContaining({
          plans: [
            expect.objectContaining({ result: { title: "Golf net", description: LARGE_TEXT } }),
          ],
        }),
      }),
      expect.any(Function)
    )
    expect(f.gateway.streamChat).toHaveBeenCalledTimes(2)
    expect(f.gateway.streamChat.mock.calls.map(call => call[1])).toEqual([LARGE_TEXT, LARGE_TEXT])
    expect(f.tasks.map(task => task.status)).toEqual(["SCORE_READY", "READY", "COMPLETED"])
    expect(f.ai.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.prisma.listingGenerationTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, status: true }, orderBy: { id: "asc" } })
    )
  })

  it("单条评分详情读取或结算失败不会阻塞后续评分和新任务", async () => {
    const f = createFixture([
      createTask(1, "SCORE_READY"),
      createTask(2, "SCORE_READY"),
      createTask(3, "SCORE_READY"),
      createTask(4, "QUEUED"),
    ])
    const findUnique = f.prisma.listingGenerationTask.findUnique.getMockImplementation()!
    f.prisma.listingGenerationTask.findUnique.mockImplementation(async query => {
      if (query.where?.id === 1) throw new Error("读取失败")
      return findUnique(query)
    })
    const finalizeScore = f.service.finalizeScore.bind(f.service)
    jest.spyOn(f.service, "finalizeScore").mockImplementation(async task => {
      if (task.id === 2) throw new Error("结算事务失败")
      await finalizeScore(task)
    })

    await f.service.poll()
    await flushExecutions()

    expect(f.tasks.map(task => task.status)).toEqual([
      "SCORE_READY",
      "SCORE_READY",
      "COMPLETED",
      "READY",
    ])
    expect(f.gateway.streamChat).toHaveBeenCalledTimes(1)
    expect(f.ai.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it("评分列表查询整体失败仍调度新生成任务", async () => {
    const f = createFixture([createTask(1, "QUEUED")])
    const findMany = f.prisma.listingGenerationTask.findMany.getMockImplementation()!
    f.prisma.listingGenerationTask.findMany.mockImplementation(async query => {
      if (query.where?.status === "SCORE_READY") throw new Error("1038 Out of sort memory")
      return findMany(query)
    })

    await f.service.poll()
    await flushExecutions()

    expect(f.tasks[0].status).toBe("READY")
    expect(f.gateway.streamChat).toHaveBeenCalledTimes(1)
  })

  it("评分恢复详情已被其他 worker 完成时不重复结算", async () => {
    const f = createFixture([createTask(1, "SCORE_READY")])
    const findUnique = f.prisma.listingGenerationTask.findUnique.getMockImplementation()!
    f.prisma.listingGenerationTask.findUnique.mockImplementation(async query => {
      f.tasks[0].status = "COMPLETED"
      return findUnique(query)
    })

    await f.service.poll()

    expect(f.runs.update).not.toHaveBeenCalled()
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
  })

  it("队列详情加载失败发生在认领之前，不把未调用模型的任务遗留为 RUNNING", async () => {
    const f = createFixture([createTask(1, "QUEUED")])
    f.prisma.listingGenerationTask.findUnique.mockRejectedValue(new Error("读取失败"))

    await f.service.poll()

    expect(f.tasks[0].status).toBe("QUEUED")
    expect(f.gateway.streamChat).not.toHaveBeenCalled()
    expect(f.prisma.listingGenerationTask.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 1 }) })
    )
  })

  it("原子认领输给其他 worker 时不调用模型", async () => {
    const f = createFixture([createTask(1, "QUEUED")])
    const updateMany = f.prisma.listingGenerationTask.updateMany.getMockImplementation()!
    f.prisma.listingGenerationTask.updateMany.mockImplementation(async query => {
      if (query.where?.id === 1) {
        f.tasks[0].status = "RUNNING"
        return { count: 0 }
      }
      return updateMany(query)
    })

    await f.service.poll()

    expect(f.gateway.streamChat).not.toHaveBeenCalled()
    expect(f.ai.chargeSavedOutput).not.toHaveBeenCalled()
  })

  it("候选任务在主键加载前变为 RUNNING 时不重新认领或重复调用模型", async () => {
    const f = createFixture([createTask(1, "QUEUED")])
    const findUnique = f.prisma.listingGenerationTask.findUnique.getMockImplementation()!
    f.prisma.listingGenerationTask.findUnique.mockImplementation(async query => {
      f.tasks[0].status = "RUNNING"
      return findUnique(query)
    })

    await f.service.poll()

    expect(f.gateway.streamChat).not.toHaveBeenCalled()
    expect(f.prisma.listingGenerationTask.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 1 }) })
    )
  })

  it("任务先读后认领仍保持每实例最多两个并发任务，释放后继续队列", async () => {
    const f = createFixture([
      createTask(3, "QUEUED"),
      createTask(1, "QUEUED"),
      createTask(2, "QUEUED"),
    ])
    const completions: Array<() => void> = []
    const execute = jest
      .spyOn(f.service, "execute")
      .mockImplementation(() => new Promise<void>(resolve => completions.push(resolve)))

    await f.service.poll()
    await f.service.poll()
    expect(execute.mock.calls.map(([task]) => task.id)).toEqual([1, 2])
    expect(f.tasks[0].status).toBe("QUEUED")

    completions.shift()!()
    await flushExecutions()
    await f.service.poll()
    expect(execute.mock.calls.map(([task]) => task.id)).toEqual([1, 2, 3])

    completions.forEach(resolve => resolve())
    await flushExecutions()
  })
})
