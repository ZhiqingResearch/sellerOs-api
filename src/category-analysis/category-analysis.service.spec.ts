import { ConfigService } from "@nestjs/config"
import { Prisma } from "@prisma/client"
import { createHash } from "crypto"
import type {
  AiGatewayBillingUsage,
  AiGatewayStreamEvent,
  AiGatewayStreamOptions,
} from "../common/providers/ai-gateway.provider"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { canonicalJson } from "../product-selection/canonical-json"
import type { ChargeModelParams, ChargeModelResult } from "../usage/usage.service"
import { UsageService } from "../usage/usage.service"
import { CategoryAnalysisService } from "./category-analysis.service"
import type { CategoryEvidence, KeywordResolution } from "./category-analysis.types"
import { CategoryEvidenceProvider, type CategoryDataUsage } from "./category-evidence.provider"

const categories = Array.from({ length: 5 }, (_, index) => ({
  nodeId: String(index),
  nodeIdPath: `1:${index}`,
  name: `Storage ${index}`,
  path: `家居 > 收纳${index}`,
}))
const evidence: CategoryEvidence = {
  source: "sif_sample",
  rows: [],
  months: [],
  keywords: [],
  keepa: [],
  notices: [],
}
const markdown = [
  "# 收纳 建议谨慎评估 可重点评估 建议差异化切入 建议暂缓",
  ...["核心结论", "准入风险", "市场容量", "竞争格局", "头部动态", "切入机会"].map(
    title => `## ${title}\n指标需补充，请核实后再决定是否进入。`
  ),
  "### 数据核对\n需补充样本",
].join("\n")
const dto = { requestId: "request", marketplace: "US", categories }
const fingerprint = createHash("sha256")
  .update(canonicalJson({ marketplace: "US", categories }))
  .digest("hex")

interface TaskMutation {
  where?: Record<string, unknown>
  data: {
    status?: string
    result?: unknown
    error?: string
    credits?: Prisma.Decimal | { increment: Prisma.Decimal | number | string }
    leaseExpiresAt?: Date | null
  }
}

function billing(
  requestId: string,
  costCny = "0.12",
  model = "ZQ-Think-Flash"
): AiGatewayBillingUsage {
  return { requestId, requestIds: [requestId], costCny, model, currency: "CNY" }
}

function setup() {
  const record = {
    id: 1,
    userId: 7,
    requestId: "request",
    categories,
    keywords: [] as string[],
    plan: "cat",
    resolution: null as KeywordResolution | null,
    marketplace: "US",
    status: "PENDING",
    credits: new Prisma.Decimal(0),
    fingerprint,
    deletedAt: null,
    title: "收纳",
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  const records = {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn().mockResolvedValue(record),
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  }
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 7 }]),
    categoryAnalysisRecord: {
      updateMany: jest
        .fn<Promise<{ count: number }>, [TaskMutation]>()
        .mockResolvedValue({ count: 1 }),
      update: jest.fn<Promise<unknown>, [TaskMutation]>().mockResolvedValue(record),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(record),
    },
  }
  const prisma = {
    categoryAnalysisRecord: records,
    usageLog: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: (value: unknown) => Promise<unknown>) => fn(tx)),
  }
  const data = {
    collect: jest.fn().mockImplementation(() => Promise.resolve({ ...evidence, notices: [] })),
    resolveKeywords: jest.fn(),
  }
  let gatewaySequence = 0
  const gateway = {
    streamChat: jest.fn<Generator<AiGatewayStreamEvent>, [string, string, AiGatewayStreamOptions?]>(
      function* () {
        yield { type: "text", content: markdown }
        yield {
          type: "billing",
          content: "",
          billing: billing(`gateway-${++gatewaySequence}`),
        }
      }
    ),
  }
  const usage = {
    assertFixedModuleAffordable: jest.fn(),
    chargeFixedModule: jest.fn().mockImplementation(async (_user, _source, params: { quantity?: number }) => ({ creditsCharged: new Prisma.Decimal(80 * (params.quantity ?? 1)), duplicate: false })),
    assertExactCreditsAffordable: jest.fn(),
    chargeExactCreditsInTransaction: jest.fn(),
    chargeMcpInTransaction: jest
      .fn()
      .mockResolvedValue({ creditsCharged: new Prisma.Decimal(2), duplicate: false }),
    gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Prisma.Decimal("2.5")),
    chargeModelInTransaction: jest
      .fn<
        Promise<Pick<ChargeModelResult, "creditsCharged" | "duplicate">>,
        [unknown, number, Prisma.Decimal, ChargeModelParams]
      >()
      .mockImplementation((_tx, _userId, cost) =>
        Promise.resolve({ creditsCharged: cost.mul(10).ceil(), duplicate: false })
      ),
  }
  const service = new CategoryAnalysisService(
    prisma as unknown as PrismaService,
    data as unknown as CategoryEvidenceProvider,
    gateway as unknown as AiGatewayProvider,
    usage as unknown as UsageService,
    new ConfigService({ AI_GATEWAY_API_KEY: "test" })
  )
  return { service, records, record, tx, prisma, data, gateway, usage }
}

function progress(ctx: ReturnType<typeof setup>) {
  return ctx.tx.categoryAnalysisRecord.updateMany.mock.calls.map(([args]) => args.data)
}

describe("类目分析成功后固定扣费", () => {
  it("确认提交只创建零积分任务，事务完成后才调度取数", async () => {
    const ctx = setup()
    const process = jest.spyOn(ctx.service, "processQueue").mockResolvedValue()
    await ctx.service.create(7, dto)
    expect((ctx.tx.categoryAnalysisRecord.create.mock.calls as unknown[][])[0][0]).toMatchObject({
      data: { credits: 0 },
    })
    expect(ctx.usage.assertExactCreditsAffordable).not.toHaveBeenCalled()
    expect(ctx.usage.chargeExactCreditsInTransaction).not.toHaveBeenCalled()
    expect(ctx.usage.chargeModelInTransaction).not.toHaveBeenCalled()
    expect(process.mock.invocationCallOrder[0]).toBeGreaterThan(
      ctx.tx.categoryAnalysisRecord.create.mock.invocationCallOrder[0]
    )
  })

  it("相同 requestId 返回原任务，不创建或扣第二次", async () => {
    const ctx = setup()
    ctx.records.findUnique.mockResolvedValue(ctx.record)
    expect((await ctx.service.create(7, dto)).id).toBe(1)
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled()
    expect(ctx.usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it("并发提交在用户锁后检查重复请求，只创建一次", async () => {
    const ctx = setup()
    jest.spyOn(ctx.service, "processQueue").mockResolvedValue()
    ctx.tx.categoryAnalysisRecord.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ctx.record)
    await Promise.all([ctx.service.create(7, dto), ctx.service.create(7, dto)])
    expect(ctx.tx.$queryRaw).toHaveBeenCalledTimes(2)
    expect(ctx.tx.categoryAnalysisRecord.create).toHaveBeenCalledTimes(1)
    expect(ctx.usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it("创建事务失败不启动取数或扣费", async () => {
    const ctx = setup()
    const process = jest.spyOn(ctx.service, "processQueue").mockResolvedValue()
    ctx.tx.categoryAnalysisRecord.create.mockRejectedValue(new Error("database unavailable"))
    await expect(ctx.service.create(7, dto)).rejects.toThrow("database unavailable")
    expect(process).not.toHaveBeenCalled()
    expect(ctx.data.collect).not.toHaveBeenCalled()
    expect(ctx.usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it("唯一键冲突在事务外返回首个任务，不重复扣费", async () => {
    const ctx = setup()
    ctx.records.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(ctx.record)
    ctx.tx.categoryAnalysisRecord.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique request", {
        code: "P2002",
        clientVersion: "test",
      })
    )
    expect((await ctx.service.create(7, dto)).id).toBe(1)
    expect(ctx.usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it("五个类目全部成功一次结算400积分，不再收取中间调用费用", async () => {
    const ctx = setup()
    await ctx.service.processQueue()
    expect(ctx.data.collect).toHaveBeenCalledTimes(5)
    expect(ctx.usage.chargeFixedModule).toHaveBeenCalledTimes(1)
    expect(ctx.usage.assertFixedModuleAffordable).toHaveBeenCalledWith(7, "category.analysis", undefined, undefined, 5)
    expect(ctx.usage.chargeFixedModule).toHaveBeenCalledWith(7, "category.analysis", expect.objectContaining({ requestId: "category-analysis:7:1", quantity: 5 }), ctx.tx)
    expect(ctx.tx.categoryAnalysisRecord.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { credits: new Prisma.Decimal(400) } })
    expect(ctx.usage.chargeModelInTransaction).not.toHaveBeenCalled()
    expect(ctx.usage.chargeMcpInTransaction).not.toHaveBeenCalled()
  })
  it("余额不足不创建任务或调用外部服务", async () => {
    const ctx = setup()
    ctx.usage.assertFixedModuleAffordable.mockRejectedValue(new Error("积分余额不足"))
    await expect(ctx.service.create(7, dto)).rejects.toThrow("积分余额不足")
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled()
    expect(ctx.data.collect).not.toHaveBeenCalled()
    expect(ctx.usage.assertFixedModuleAffordable).toHaveBeenCalledWith(7, "category.analysis", undefined, undefined, 5)
  })
  it("排队期间余额变化，按实际类目总价复检且不启动分析", async () => {
    const ctx = setup()
    ctx.usage.assertFixedModuleAffordable.mockRejectedValue(new Error("积分余额不足"))
    await ctx.service.processQueue()
    expect(ctx.data.collect).not.toHaveBeenCalled()
    expect(ctx.usage.chargeFixedModule).not.toHaveBeenCalled()
    expect(progress(ctx).at(-1)?.status).toBe("FAILED")
  })
  it.each(["data", "stream", "format", "later-category"])("最终失败不扣费：%s", async failure => {
    const ctx = setup()
    if (failure === "data") ctx.data.collect.mockRejectedValue(new Error("data unavailable"))
    if (failure === "later-category") ctx.data.collect.mockResolvedValueOnce(evidence).mockRejectedValueOnce(new Error("later failure"))
    if (failure === "stream") ctx.gateway.streamChat.mockImplementation(function* () {
      yield { type: "billing", content: "", billing: billing("upstream-cost") }
      throw new Error("connection lost")
    })
    if (failure === "format") ctx.gateway.streamChat.mockImplementation(function* () {
      yield { type: "text", content: "invalid report" }
      yield { type: "billing", content: "", billing: billing("upstream-cost") }
    })
    await ctx.service.processQueue()
    expect(progress(ctx).at(-1)?.status).toBe("FAILED")
    expect(ctx.usage.chargeFixedModule).not.toHaveBeenCalled()
    expect(ctx.usage.chargeMcpInTransaction).not.toHaveBeenCalled()
    expect(ctx.usage.chargeModelInTransaction).not.toHaveBeenCalled()
  })
  it("格式重试成功只结算一次，零成本账单不影响固定售价", async () => {
    const ctx = setup()
    ctx.record.categories = categories.slice(0, 1)
    ctx.gateway.streamChat.mockImplementationOnce(function* () {
      yield { type: "text", content: "invalid report" }
      yield { type: "billing", content: "", billing: billing("first", "0") }
    }).mockImplementationOnce(function* () {
      yield { type: "text", content: markdown }
      yield { type: "billing", content: "", billing: billing("second", "0") }
    })
    await ctx.service.processQueue()
    expect(ctx.gateway.streamChat).toHaveBeenCalledTimes(2)
    expect(ctx.usage.chargeFixedModule).toHaveBeenCalledTimes(1)
    expect(progress(ctx).at(-1)?.status).toBe("COMPLETED")
  })
  it("同时调度不会重复执行或结算", async () => {
    const ctx = setup()
    await Promise.all([ctx.service.processQueue(), ctx.service.processQueue()])
    expect(ctx.usage.chargeFixedModule).toHaveBeenCalledTimes(1)
  })
  it("执行权失效不能结算", async () => {
    const ctx = setup()
    ctx.tx.categoryAnalysisRecord.updateMany.mockResolvedValue({ count: 0 })
    await expect(ctx.service["_saveProgress"](1, 7, "expired", [], "COMPLETED")).rejects.toThrow("执行权已失效")
    expect(ctx.usage.chargeFixedModule).not.toHaveBeenCalled()
  })
  it("扣费失败不保存已扣积分，任务失败且保留报告", async () => {
    const ctx = setup()
    ctx.usage.chargeFixedModule.mockRejectedValue(new Error("billing unavailable"))
    await ctx.service.processQueue()
    expect(ctx.tx.categoryAnalysisRecord.update).not.toHaveBeenCalled()
    expect(progress(ctx).at(-1)?.status).toBe("FAILED")
  })

  it("读取与删除都按用户和软删除字段隔离", async () => {
    const ctx = setup()
    ctx.records.findFirst.mockResolvedValue(null)
    await expect(ctx.service.findOne(8, 1)).rejects.toThrow("类目分析记录不存在")
    await expect(ctx.service.remove(8, 1)).rejects.toThrow("类目分析记录不存在")
    expect(ctx.records.findFirst).toHaveBeenCalledWith({
      where: { id: 1, userId: 8, deletedAt: null },
    })
    expect(ctx.records.updateMany).not.toHaveBeenCalled()
    expect(ctx.prisma.usageLog.findFirst).not.toHaveBeenCalled()
  })

  it("旧失败任务按退款流水返回已退积分，普通任务默认零", async () => {
    const ctx = setup()
    expect((await ctx.service.findOne(7, 1)).refundedCredits).toBe("0")
    ctx.prisma.usageLog.findFirst.mockResolvedValue({ meta: { refundedCredits: "20" } })
    expect((await ctx.service.findOne(7, 1)).refundedCredits).toBe("20")
    expect(ctx.prisma.usageLog.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 7,
        source: "category.analysis",
        AND: [
          { meta: { path: "$.analysisId", equals: 1 } },
          { meta: { path: "$.refundedCredits", not: Prisma.AnyNull } },
        ],
      },
      select: { meta: true },
    })
  })

  it("相同 requestId 不同参数拒绝复用", async () => {
    const ctx = setup()
    ctx.records.findUnique.mockResolvedValue({ ...ctx.record, fingerprint: "different" })
    await expect(ctx.service.create(7, dto)).rejects.toThrow("请求编号已用于其他分析")
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe("关键词任务分流与确认", () => {
  it("关键词候选再次切换口径时保留已定位的类目编号", async () => {
    const ctx = setup()
    ctx.tx.categoryAnalysisRecord.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...ctx.record, ...data })
    )
    jest.spyOn(ctx.service, "processQueue").mockResolvedValue()
    const selected = {
      ...categories[0],
      categoryId: "510156",
      from: "keyword" as const,
      resolvedFrom: ["spice rack"],
    }
    await ctx.service.create(7, {
      ...dto,
      categories: [selected],
      keywords: ["spice rack"],
      plan: "mix",
    })
    expect(ctx.tx.categoryAnalysisRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ categories: [selected], plan: "mix" }) as unknown,
      })
    )
  })
  const resolution: KeywordResolution = {
    candidates: [
      {
        categoryId: "123",
        categoryName: "Storage",
        hits: 8,
        sales: 1000,
        kws: ["spice rack"],
        best: 0,
      },
    ],
    topAsins: [],
    notices: [],
  }
  it.each([false, true])("关键词口径即使原有选择也需确认实际类目数量，已定位=%s", async hasResolution => {
    const ctx = setup()
    ctx.record.plan = "kw"
    ctx.record.keywords = ["spice rack"]
    ctx.record.resolution = hasResolution ? resolution : null
    ctx.data.resolveKeywords.mockResolvedValue(resolution)
    await ctx.service.processQueue()
    expect(ctx.records.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "AWAITING_SELECTION" }) }))
    expect(ctx.data.collect).not.toHaveBeenCalled()
    expect(ctx.usage.chargeFixedModule).not.toHaveBeenCalled()
  })
  it("确认多个候选时按总数校验，余额不足保留待选状态", async () => {
    const ctx = setup()
    ctx.record.status = "AWAITING_SELECTION"
    ctx.record.resolution = { ...resolution, candidates: [...resolution.candidates, { ...resolution.candidates[0], categoryId: "456" }] }
    ctx.usage.assertFixedModuleAffordable.mockRejectedValue(new Error("积分余额不足"))
    await expect(ctx.service.confirmCandidates(7, 1, ["123", "456"])).rejects.toThrow("积分余额不足")
    expect(ctx.usage.assertFixedModuleAffordable).toHaveBeenCalledWith(7, "category.analysis", undefined, undefined, 2)
    expect(ctx.records.updateMany).not.toHaveBeenCalled()
  })
  it("中文或空输入在创建任务与取数之前拦截", async () => {
    const ctx = setup()
    await expect(
      ctx.service.create(7, { ...dto, categories: [], keywords: ["耳机"] })
    ).rejects.toThrow("英文关键词")
    await expect(ctx.service.create(7, { ...dto, categories: [], keywords: [] })).rejects.toThrow(
      "请选择类目"
    )
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled()
    expect(ctx.data.collect).not.toHaveBeenCalled()
  })
  it("只关键词反查后持久化等待状态，不单独结算反查费用，不执行AI", async () => {
    const ctx = setup()
    ctx.record.categories = []
    ctx.record.keywords = ["spice rack"]
    ctx.data.resolveKeywords.mockImplementation(
      (_keywords: string[], _site: string, usage: CategoryDataUsage) => {
        usage.totalCalls = 3
        return Promise.resolve(resolution)
      }
    )
    await ctx.service.processQueue()
    expect(ctx.records.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "AWAITING_SELECTION", resolution }) as unknown,
      })
    )
    expect(ctx.data.collect).not.toHaveBeenCalled()
    expect(ctx.gateway.streamChat).not.toHaveBeenCalled()
    expect(ctx.usage.chargeMcpInTransaction).not.toHaveBeenCalled()
  })
  it("确认只能选择自己的候选，校验后原子进入队列", async () => {
    const ctx = setup()
    ctx.record.status = "AWAITING_SELECTION"
    ctx.record.resolution = resolution
    jest.spyOn(ctx.service, "processQueue").mockResolvedValue()
    await expect(ctx.service.confirmCandidates(7, 1, ["999"])).rejects.toThrow("候选列表")
    await ctx.service.confirmCandidates(7, 1, ["123"])
    expect(ctx.records.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, userId: 7, deletedAt: null, status: "AWAITING_SELECTION" },
        data: expect.objectContaining({
          status: "PENDING",
          plan: "kw",
          categories: [expect.objectContaining({ categoryId: "123", from: "keyword" }) as unknown],
        }) as unknown,
      })
    )
  })
  it("确认后重试同一选择幂等，不同选择拒绝", async () => {
    const ctx = setup()
    ctx.record.status = "PROCESSING"
    ctx.record.resolution = { ...resolution, confirmedIds: ["123"] }
    await ctx.service.confirmCandidates(7, 1, ["123"])
    expect(ctx.records.updateMany).not.toHaveBeenCalled()
    ctx.record.resolution.confirmedIds = ["456"]
    await expect(ctx.service.confirmCandidates(7, 1, ["123"])).rejects.toThrow("已确认")
  })
  it("已确认任务续跑使用持久化结果，反查不重复执行或扣费", async () => {
    const ctx = setup()
    ctx.record.keywords = ["spice rack"]
    ctx.record.plan = "kw"
    ctx.record.resolution = { ...resolution, confirmedIds: ["0"] }
    ctx.record.categories = categories.slice(0, 1)
    await ctx.service.processQueue()
    expect(ctx.data.resolveKeywords).not.toHaveBeenCalled()
    expect(ctx.data.collect).toHaveBeenCalledTimes(1)
    expect(ctx.usage.chargeMcpInTransaction).not.toHaveBeenCalled()
    expect(ctx.gateway.streamChat).toHaveBeenCalledTimes(1)
  })
})
