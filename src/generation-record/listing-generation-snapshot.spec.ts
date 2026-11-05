import { Prisma } from "@prisma/client"
import { listingGenerationChargeId } from "../usage/fixed-module-credits"
import {
  projectListingGenerationRecords,
  readListingTaskResult,
} from "./listing-generation-snapshot"

const time = new Date("2026-11-05T08:00:00Z")
const history = {
  id: 9,
  userId: 7,
  type: "LISTING_GENERATION" as const,
  title: "原商品",
  data: { result: { title: "后来修改的正文" } },
  version: 4,
  createdAt: time,
}
const step = (id: number, operation: string, usageLogId: number | null) => ({
  id,
  operation,
  usageLogId,
  listingRunId: 5,
  status: "COMPLETED",
  model: "actual-model",
  outputText: '{"title":"已保存正文","description":"完整描述"}',
  requestId: "request",
  error: null,
  createdAt: time,
  updatedAt: time,
})
const task = (id: number, mainStepId: number, operation = "optimization") => ({
  id,
  mainStepId,
  status: "COMPLETED",
  longTitleStepId: null,
  listingRunId: 5,
  planIndex: 0,
  input: {
    main: { operation, systemPrompt: "never-return" },
    result: { title: `成功结果${id}`, description: "正文" },
    context: { params: { market: "amazon_de" } },
  },
  attemptId: `attempt-${id}`,
  updatedAt: time,
  createdAt: time,
  billing: { credential: "never-return" },
  isModelComplete: true,
  error: null,
  leaseUntil: null,
})

function setup(
  generations = [task(1, 11), task(2, 12)],
  steps = [step(11, "optimization", 101), step(12, "optimization", 102)]
) {
  const logs = [
    {
      id: 101,
      credits: new Prisma.Decimal(5),
      requestId: "r1",
      meta: { operation: "optimization" },
    },
    {
      id: 102,
      credits: new Prisma.Decimal(5),
      requestId: "r2",
      meta: { operation: "optimization" },
    },
  ]
  const client = {
    listingRun: {
      findUnique: jest.fn().mockResolvedValue({ id: 5, runId: "run-1", steps, generations }),
    },
    historyRevision: {
      findMany: jest.fn().mockResolvedValue([{ id: 40, data: history.data, createdAt: time }]),
    },
    usageLog: { findMany: jest.fn().mockResolvedValue(logs) },
    listingGenerationTask: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ ...generations[0], listingRun: { historyId: 9, history } }),
    },
    listingAiStep: { findMany: jest.fn().mockResolvedValue(steps) },
  }
  return { client, logs, tx: client as unknown as Prisma.TransactionClient }
}

describe("Listing 每次成功操作快照", () => {
  it("两次优化各自一行各自5积分，身份使用固定任务id", async () => {
    const { tx } = setup()
    const records = await projectListingGenerationRecords(tx, history)
    expect(
      records.map(row => ({ key: row.key, credits: row.credits, operation: row.operation }))
    ).toEqual([
      { key: "TEXT:LISTING_GENERATION:9:task:1", credits: "5", operation: "optimization" },
      { key: "TEXT:LISTING_GENERATION:9:task:2", credits: "5", operation: "optimization" },
    ])
  })

  it("未完成、失败和未采纳的优化不记成功消费记录", async () => {
    const { tx } = setup(
      [{ ...task(1, 11), status: "PARTIAL" }, { ...task(2, 12), status: "FAILED" }, task(3, 13)],
      [step(11, "optimization", 101), step(12, "optimization", 102), step(13, "optimization", null)]
    )
    expect(await projectListingGenerationRecords(tx, history)).toEqual([])
  })

  it("生成A/B复用一笔已结算费用时，后续任务明确免费，不重复算积分", async () => {
    const { tx, client } = setup(
      [task(1, 11, "generation"), task(2, 12, "generation")],
      [step(11, "generation", 101), step(12, "generation", null)]
    )
    client.usageLog.findMany.mockResolvedValue([
      {
        id: 101,
        credits: new Prisma.Decimal(10),
        requestId: listingGenerationChargeId(7, "run-1"),
        meta: { operation: "generation" },
      },
    ])
    const records = await projectListingGenerationRecords(tx, history)
    expect(records.map(row => row.credits)).toEqual(["10", "0"])
  })

  it("找不到账单的历史成功结果保持未知，不拿其它优化费用填充", async () => {
    const { tx, client } = setup([task(1, 11, "generation")], [step(11, "generation", null)])
    client.usageLog.findMany.mockResolvedValue([])
    expect((await projectListingGenerationRecords(tx, history))[0].credits).toBeNull()
  })

  it("没有后台任务的旧报告绑定固定revision，原生成费用排除优化账单", async () => {
    const { tx, client } = setup([], [step(11, "generation", 101), step(12, "optimization", 102)])
    client.usageLog.findMany.mockResolvedValue([
      {
        id: 101,
        credits: new Prisma.Decimal(10),
        requestId: "g1",
        meta: { operation: "generation" },
      },
      {
        id: 102,
        credits: new Prisma.Decimal(5),
        requestId: "o1",
        meta: { operation: "optimization" },
      },
    ])
    const records = await projectListingGenerationRecords(tx, history)
    expect(records.map(row => ({ key: row.key, credits: row.credits }))).toEqual([
      { key: "TEXT:LISTING_GENERATION:9:revision:40", credits: "10" },
      { key: "TEXT:LISTING_GENERATION:9:step:12", credits: "5" },
    ])
  })

  it("旧报告回填跳过初始化空版本，后续编辑不会生成另一条初始消费记录", async () => {
    const { tx, client } = setup([], [])
    client.historyRevision.findMany.mockResolvedValue([
      { id: 39, data: { params: {}, plans: [] }, createdAt: time },
      { id: 40, data: { result: { title: "原始成功正文" } }, createdAt: time },
      { id: 41, data: { result: { title: "后来手工编辑" } }, createdAt: time },
    ])
    const records = await projectListingGenerationRecords(tx, history)
    expect(records.map(value => value.key)).toEqual(["TEXT:LISTING_GENERATION:9:revision:40"])
  })

  it("详情读取当次保存结果，后来改History不会改变正文或暴露内部input/billing", async () => {
    const { tx } = setup()
    const detail = await readListingTaskResult(tx, 9, 1)
    expect(detail?.content.report).toMatchObject({
      params: { market: "amazon_de" },
      plans: [{ result: { title: "成功结果1" } }],
    })
    expect(JSON.stringify(detail)).not.toContain("后来修改的正文")
    expect(JSON.stringify(detail)).not.toContain("never-return")
  })

  it("B方案详情保留数组位置，不被前端按A方案展示", async () => {
    const { tx, client } = setup()
    client.listingGenerationTask.findFirst.mockResolvedValue({
      ...task(1, 11),
      planIndex: 1,
      listingRun: { historyId: 9, history },
    })
    const detail = await readListingTaskResult(tx, 9, 1)
    expect(detail?.content.report.plans).toEqual([
      null,
      { planIndex: 1, result: { title: "成功结果1", description: "正文" } },
    ])
  })
})
