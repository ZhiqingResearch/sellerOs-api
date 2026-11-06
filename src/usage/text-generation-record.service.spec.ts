import { Decimal } from "@prisma/client/runtime/library"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import {
  GENERATION_FUNCTIONS,
  QueryGenerationRecordsDto,
  TextGenerationFunction,
} from "./dto/query-generation-records.dto"
import { TextGenerationRecordService } from "./text-generation-record.service"

const createdAt = new Date("2026-11-02T04:00:00.000Z")
const now = new Date("2026-11-03T12:00:00.000Z")
beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(now.getTime())
})
afterEach(() => jest.useRealTimers())
const user = {
  id: 7,
  username: "测试用户",
  phone: "13800000000",
  orgs: [{ org: { name: "内容组" } }],
  roles: [{ role: { name: "运营", color: null } }],
}
const base = { id: "record-1", userId: 7, createdAt, deletedAt: null }

function createMocks() {
  const delegate = () => ({ findMany: jest.fn().mockResolvedValue([]) })
  const audit = {
    user: { findMany: jest.fn().mockResolvedValue([user]) },
    usageLog: delegate(),
    history: delegate(),
    businessAiRun: delegate(),
    categoryAnalysisRecord: delegate(),
    selectionAnalysisRecord: delegate(),
    smartPricingRecord: delegate(),
    promotionPlanRecord: delegate(),
    videoAnalysisRecord: delegate(),
    asinEvidenceRecord: delegate(),
    asinAuditRecord: delegate(),
    competitorAnalysisRecord: delegate(),
    chetaidouTask: delegate(),
    chetaidouCall: delegate(),
  }
  return { audit, service: new TextGenerationRecordService(audit as never) }
}

function charge(source: string, meta: Record<string, unknown>, credits = "2.5", id = 1) {
  return {
    id,
    userId: 7,
    source,
    credits: new Decimal(credits),
    meta: { model: "text-model", ...meta },
    requestId: `request-${id}`,
    createdAt,
  }
}

describe("文本生成记录功能与费用关联", () => {
  it("所有文本业务查询及近期流水都按数据库时间范围读取，旧审计允许近期新增优化", async () => {
    const { audit, service } = createMocks()
    await service.list({}, now)
    const range = { gte: new Date("2026-10-20T11:59:50.000Z"), lte: now }
    for (const table of [
      audit.history,
      audit.businessAiRun,
      audit.categoryAnalysisRecord,
      audit.selectionAnalysisRecord,
      audit.smartPricingRecord,
      audit.promotionPlanRecord,
      audit.videoAnalysisRecord,
      audit.asinEvidenceRecord,
      audit.competitorAnalysisRecord,
      audit.chetaidouTask,
      audit.chetaidouCall,
      audit.usageLog,
    ]) {
      const query = table.findMany.mock.calls[0] as unknown as [
        { where: { createdAt?: object; OR?: Array<{ createdAt: object }> } },
      ]
      expect(query[0].where.createdAt ?? query[0].where.OR?.[0].createdAt).toEqual(range)
    }
    const auditQuery = audit.asinAuditRecord.findMany.mock.calls[0] as unknown as [
      { where: { OR: object[] } },
    ]
    expect(auditQuery[0].where.OR).toContainEqual({ createdAt: range })
    expect(auditQuery[0].where.OR).toContainEqual({
      optimizationRevisions: { some: { createdAt: range } },
    })
  })

  it("严格按最近 14 天展示，窗口起点和当前时刻都包含，旧数据和未来数据不混入", async () => {
    const { audit, service } = createMocks()
    const start = new Date("2026-10-20T12:00:00.000Z")
    audit.smartPricingRecord.findMany.mockResolvedValue([
      { ...base, id: "old", productName: "旧数据", createdAt: new Date(start.getTime() - 1) },
      { ...base, id: "boundary", productName: "边界", createdAt: start },
      { ...base, id: "now", productName: "当前", createdAt: now },
      { ...base, id: "future", productName: "未来", createdAt: new Date(now.getTime() + 1) },
    ])
    expect((await service.list({ function: "SMART_PRICING" }, now)).map(row => row.id)).toEqual([
      "boundary",
      "now",
    ])
  })

  it("近两周内优化的旧审计仍有正文行，定向补查关联旧费用而非重新读取历史流水", async () => {
    const { audit, service } = createMocks()
    const oldDate = new Date("2026-10-01T04:00:00Z"),
      oldOptimization = new Date("2026-10-02T04:00:00Z")
    audit.asinAuditRecord.findMany.mockResolvedValue([
      {
        ...base,
        createdAt: oldDate,
        asin: "B012345678",
        productTitle: "旧审计新优化",
        clientRequestId: "parent",
        scoreSnapshot: { createdAt: oldDate },
        optimizationRevisions: [
          { revision: 1, createdAt: oldOptimization },
          { revision: 2, createdAt },
        ],
      },
    ])
    const current = charge("asin.audit", { recordId: base.id, stage: "optimize" }, "15", 2)
    const old = {
      ...charge("asin.audit", { recordId: base.id, stage: "optimize" }, "15", 1),
      createdAt: oldOptimization,
    }
    audit.usageLog.findMany.mockImplementation((args: { where: { OR?: unknown[] } }) =>
      Promise.resolve(args.where.OR ? [old] : [current])
    )
    const rows = await service.list({ function: "ASIN_AUDIT" }, now)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: `TEXT:ASIN_AUDIT:${base.id}:optimize`, credits: "30" })
    const olderQuery = audit.usageLog.findMany.mock.calls[1] as unknown as [
      { where: { createdAt: object; OR: Array<{ userId: number; OR: object[] }> } },
    ]
    expect(olderQuery[0].where.createdAt).toEqual({ lt: new Date("2026-10-20T11:59:50.000Z") })
    expect(olderQuery[0].where.OR).toHaveLength(1)
    expect(olderQuery[0].where.OR[0]).toMatchObject({ userId: 7 })
    expect(olderQuery[0].where.OR[0].OR).toContainEqual({
      meta: { path: "$.recordId", equals: base.id },
    })
  })

  it("完全早于近 14 天的范围直接返回空集，不查询历史表", async () => {
    const { audit, service } = createMocks()
    expect(
      await service.list(
        { function: "SMART_PRICING", dateFrom: "2026-09-01", dateTo: "2026-09-02" },
        now
      )
    ).toEqual([])
    expect(audit.usageLog.findMany).not.toHaveBeenCalled()
    expect(audit.smartPricingRecord.findMany).not.toHaveBeenCalled()
  })

  it("近期延迟扣费明确引用旧报告时补入上下文，不把窗口外报告误拆为新的孤立扣费", async () => {
    const { audit, service } = createMocks()
    audit.smartPricingRecord.findMany.mockResolvedValue([
      { ...base, createdAt: new Date("2026-10-01"), productName: "旧报告" },
    ])
    audit.usageLog.findMany.mockResolvedValue([
      charge("pricing.quote", { recordId: base.id }, "10"),
    ])
    expect(await service.list({ function: "SMART_PRICING" }, now)).toEqual([])
    const query = audit.smartPricingRecord.findMany.mock.calls[0] as unknown as [
      { where: { OR: object[] } },
    ]
    expect(query[0].where.OR).toContainEqual({ id: { in: [base.id] } })
    expect(audit.usageLog.findMany).toHaveBeenCalledTimes(1)
  })

  it("车泰斗只带调用幂等号的迟到费用也能定向找回旧任务上下文", async () => {
    const { audit, service } = createMocks()
    audit.chetaidouTask.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: base.id,
        ownerId: 7,
        type: "COMPOSE",
        status: "SUCCEEDED",
        createdAt: new Date("2026-10-01"),
      },
    ])
    audit.chetaidouCall.findMany.mockResolvedValue([
      { id: "old-call", taskId: base.id, model: "text-model" },
    ])
    const log = charge("chetaidou.compose", {}, "3")
    log.requestId = "chetaidou:charge:old-call"
    audit.usageLog.findMany.mockResolvedValue([log])
    expect(await service.list({ function: "CHETAIDOU_TEXT" }, now)).toEqual([])
    expect(audit.chetaidouTask.findMany).toHaveBeenCalledTimes(2)
    const query = audit.chetaidouCall.findMany.mock.calls[0] as unknown as [
      { where: { OR: object[] } },
    ]
    expect(query[0].where.OR).toContainEqual({ id: { in: ["old-call"] } })
  })

  it("智能定价额外返回实际模型并支持其筛选，固定计费标记和实扣积分保持原样", async () => {
    const { audit, service } = createMocks()
    audit.smartPricingRecord.findMany.mockResolvedValue([
      { ...base, clientRequestId: "client-1", productName: "定价" },
    ])
    audit.usageLog.findMany.mockResolvedValue([
      charge("pricing.quote", { recordId: base.id, model: "fixed-module" }, "10"),
    ])
    audit.businessAiRun.findMany.mockResolvedValue([
      {
        userId: 7,
        runId: "client-1-generate",
        operation: "generate",
        model: "requested-model",
        billing: { billing: { model: "actual-model" } },
      },
    ])
    for (const query of [
      { function: "SMART_PRICING" as const },
      { function: "SMART_PRICING" as const, model: "actual-model" },
    ]) {
      const rows = await service.list(query)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        model: "fixed-module",
        models: ["fixed-module"],
        actualModel: "actual-model",
        actualModels: ["actual-model"],
        modelLabel: "actual-model",
        credits: "10",
      })
    }
    expect(await service.list({ function: "SMART_PRICING", model: "unrelated-model" })).toEqual([])
    audit.businessAiRun.findMany.mockResolvedValue([])
    expect((await service.list({ function: "SMART_PRICING" }))[0]).toMatchObject({
      actualModel: null,
      actualModels: [],
      modelLabel: "—",
      credits: "10",
    })
    audit.usageLog.findMany.mockResolvedValue([])
    expect((await service.list({ function: "SMART_PRICING" }))[0]).toMatchObject({
      modelLabel: "—",
      credits: null,
    })
  })

  it("新品推广计划在原 modelLabel 返回生成模型，兼容共用运行号并保留固定积分", async () => {
    const { audit, service } = createMocks()
    audit.promotionPlanRecord.findMany.mockResolvedValue([
      { ...base, clientRequestId: "client-1", productName: "新品推广" },
    ])
    audit.usageLog.findMany.mockResolvedValue([
      charge("launch.plan", { recordId: base.id, model: "fixed-module" }, "15"),
    ])
    audit.businessAiRun.findMany.mockResolvedValue([
      {
        userId: 7,
        runId: "client-1-competitor-0",
        operation: "extract",
        model: "extract-model",
        billing: null,
      },
      {
        userId: 7,
        runId: "client-1",
        operation: "generate",
        model: "requested-model",
        billing: { billing: { model: "actual-model" } },
      },
    ])
    const rows = await service.list({ function: "PROMOTION_PLAN", model: "extract-model" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      model: "fixed-module",
      modelLabel: "actual-model",
      actualModel: "actual-model",
      actualModels: ["actual-model", "extract-model"],
      credits: "15",
    })
  })

  it("取证正文与旧 asin.audit 取证扣费合并为一行，取证费用不再混入审计", async () => {
    const { audit, service } = createMocks()
    audit.asinEvidenceRecord.findMany.mockResolvedValue([
      {
        ...base,
        asin: "B012345678",
        productTitle: "取证",
        clientRequestId: "saved",
        model: "text-model",
      },
    ])
    audit.usageLog.findMany.mockResolvedValue([
      {
        ...charge(
          "asin.audit",
          { stage: "evidence", scene: "evidence-module", clientRequestId: "generation" },
          "5",
          10904
        ),
        createdAt: new Date(createdAt.getTime() - 938),
      },
    ])
    const rows = await service.list({ function: "ASIN_EVIDENCE" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: "TEXT:ASIN_EVIDENCE:record-1",
      operation: "evidence",
      recordId: "record-1",
      credits: "5",
    })
    expect(await service.list({ function: "ASIN_AUDIT" })).toEqual([])
    expect((await service.list({})).map(row => row.credits)).toEqual(["5"])
  })

  const cases: Array<{
    fn: TextGenerationFunction
    table: keyof ReturnType<typeof createMocks>["audit"]
    source: string
    row: object
    meta: Record<string, unknown>
  }> = [
    {
      fn: "ASIN_EVIDENCE",
      table: "asinEvidenceRecord",
      source: "asin.audit.evidence",
      row: {
        ...base,
        asin: "B012345678",
        productTitle: "商品取证",
        model: "text-model",
        clientRequestId: "client-1",
      },
      meta: { clientRequestId: "client-1" },
    },
    {
      fn: "ASIN_AUDIT",
      table: "asinAuditRecord",
      source: "asin.audit",
      row: {
        ...base,
        asin: "B012345678",
        productTitle: "审计",
        status: "SCORED",
        clientRequestId: "client-1",
        scoreSnapshot: { createdAt },
        optimizationRevisions: [],
      },
      meta: { clientRequestId: "client-1", stage: "score" },
    },
    {
      fn: "COMPETITOR_ANALYSIS",
      table: "competitorAnalysisRecord",
      source: "competitor.research",
      row: { ...base, title: "竞品分析", clientRequestId: "run-1" },
      meta: { businessEventId: "run-1" },
    },
    {
      fn: "LISTING_GENERATION",
      table: "history",
      source: "listing.generate",
      row: {
        ...base,
        id: 42,
        type: "LISTING_GENERATION",
        title: "Listing 生成",
        listingRun: {
          runId: "run-1",
          status: "COMPLETED",
          steps: [{ id: 11, model: "text-model", usageLogId: 1, operation: "generation" }],
        },
      },
      meta: { listingHistoryId: 42 },
    },
    {
      fn: "LISTING_SCORING",
      table: "businessAiRun",
      source: "listing.score",
      row: {
        ...base,
        id: 43,
        module: "listing-score",
        operation: "score",
        status: "COMPLETED",
        model: "text-model",
        runId: "run-1",
        requestId: "request-1",
        usageLogId: 1,
      },
      meta: { businessEventId: "run-1" },
    },
    {
      fn: "CATEGORY_ANALYSIS",
      table: "categoryAnalysisRecord",
      source: "category.analysis",
      row: { ...base, id: 42, title: "类目分析", status: "COMPLETED", credits: new Decimal(0) },
      meta: { analysisId: 42 },
    },
    {
      fn: "PRODUCT_SELECTION",
      table: "selectionAnalysisRecord",
      source: "flow.workbench",
      row: { ...base, primaryCategoryName: "产品验证", status: "COMPLETED" },
      meta: { analysisId: base.id },
    },
    {
      fn: "SMART_PRICING",
      table: "smartPricingRecord",
      source: "pricing.quote",
      row: { ...base, productName: "智能定价" },
      meta: { recordId: base.id },
    },
    {
      fn: "PROMOTION_PLAN",
      table: "promotionPlanRecord",
      source: "launch.plan",
      row: { ...base, productName: "新品推广" },
      meta: { recordId: base.id },
    },
    {
      fn: "VIDEO_ANALYSIS",
      table: "videoAnalysisRecord",
      source: "video.analysis",
      row: { ...base, title: "视频分析", model: "text-model", chargeRequestId: "video-request" },
      meta: {},
    },
    {
      fn: "CHETAIDOU_TEXT",
      table: "chetaidouTask",
      source: "chetaidou.compose",
      row: { ...base, ownerId: 7, type: "COMPOSE", status: "SUCCEEDED" },
      meta: { taskId: base.id },
    },
  ]

  it.each(cases)("$fn 查询真实业务记录并关联实扣积分", async ({ fn, table, source, row, meta }) => {
    const { audit, service } = createMocks()
    audit[table].findMany.mockResolvedValue([row])
    const log = charge(source, meta)
    if (fn === "VIDEO_ANALYSIS") log.requestId = "charge:video-request"
    audit.usageLog.findMany.mockResolvedValue([log])
    const result = await service.list({ function: fn })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      function: fn,
      contentType: "TEXT",
      credits: "2.5",
      userId: 7,
      models: ["text-model"],
    })
    expect(result[0].resultLabel).not.toBe("已扣费，暂无关联报告")
    const calls = audit.usageLog.findMany.mock.calls as unknown as Array<
      [{ where: { source: { in: string[] } } }]
    >
    expect(calls[0][0].where.source.in).toContain(source)
  })

  it("同一审计只出打分、优化两行，各自关联积分，多次优化汇总到优化行", async () => {
    const { audit, service } = createMocks()
    audit.asinAuditRecord.findMany.mockResolvedValue([
      {
        ...cases[1].row,
        optimizationRevisions: [
          { revision: 1, createdAt },
          { revision: 2, createdAt },
        ],
      },
    ])
    audit.usageLog.findMany.mockResolvedValue([
      charge("asin.audit", { clientRequestId: "client-1", stage: "score" }, "20", 1),
      charge("asin.audit", { clientRequestId: "client-1", stage: "optimize" }, "15", 2),
      charge("asin.audit", { clientRequestId: "client-1", stage: "optimize" }, "15", 3),
      charge(
        "asin.audit",
        { clientRequestId: "other", stage: "optimize", asin: "B012345678" },
        "15",
        4
      ),
    ])
    const rows = await service.list({ function: "ASIN_AUDIT" })
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      id: `${base.id}:score`,
      recordId: base.id,
      function: "ASIN_AUDIT",
      operation: "score",
      credits: "20",
      resultLabel: "审计打分",
    })
    expect(rows[1]).toMatchObject({
      key: `TEXT:ASIN_AUDIT:${base.id}:optimize`,
      operation: "optimize",
      credits: "30",
      resultLabel: "审计优化",
    })
    expect(rows[2]).toMatchObject({
      id: "usage:4",
      function: "ASIN_AUDIT",
      status: "BILLED",
      operation: "optimize",
      credits: "15",
    })
  })

  it("旧扣费 ID 与存档 ID 不同时按唯一保存事件关联，优化用优化时间筛选且费用不多出一行", async () => {
    const { audit, service } = createMocks()
    const optimizedAt = new Date("2026-11-03T08:36:47.260Z")
    audit.asinAuditRecord.findMany.mockResolvedValue([
      {
        ...cases[1].row,
        optimizationRevisions: [{ revision: 1, createdAt: optimizedAt }],
      },
    ])
    audit.usageLog.findMany.mockResolvedValue([
      {
        ...charge("asin.audit", { clientRequestId: "score-call", stage: "score" }, "20", 1),
        createdAt: new Date(createdAt.getTime() - 1014),
      },
      {
        ...charge(
          "asin.audit",
          { clientRequestId: "optimization-call", stage: "optimize" },
          "15",
          12837
        ),
        createdAt: new Date(optimizedAt.getTime() - 799),
      },
    ])
    const rows = await service.list({ function: "ASIN_AUDIT" })
    expect(rows).toHaveLength(2)
    expect(rows.map(row => [row.operation, row.credits])).toEqual([
      ["score", "20"],
      ["optimize", "15"],
    ])
    expect(rows.some(row => row.status === "BILLED")).toBe(false)
    const filtered = await service.list({
      function: "ASIN_AUDIT",
      dateFrom: "2026-11-03",
      dateTo: "2026-11-03",
    })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]).toMatchObject({
      operation: "optimize",
      credits: "15",
      createdAt: optimizedAt,
    })
  })

  it("竞品归档和同一 run 的模型运行合并，流水只计一次", async () => {
    const { audit, service } = createMocks()
    audit.competitorAnalysisRecord.findMany.mockResolvedValue([cases[2].row])
    audit.businessAiRun.findMany.mockResolvedValue([
      {
        ...base,
        id: 99,
        module: "competitor-analysis",
        runId: "run-1",
        operation: "summary",
        model: "text-model",
        usageLogId: 1,
        requestId: "request-1",
        status: "COMPLETED",
      },
    ])
    audit.usageLog.findMany.mockResolvedValue([
      charge("competitor.research", { businessEventId: "run-1" }, "25"),
    ])
    const rows = await service.list({ function: "COMPETITOR_ANALYSIS" })
    expect(rows).toHaveLength(1)
    expect(rows[0].credits).toBe("25")
  })

  it("车泰斗重试/多次调用累加，但不把生图调用混入文本功能", async () => {
    const { audit, service } = createMocks()
    audit.chetaidouTask.findMany.mockResolvedValue([cases[10].row])
    audit.chetaidouCall.findMany.mockResolvedValue([
      { id: "call-1", taskId: base.id, model: "text-model" },
    ])
    const log = charge("chetaidou.compose", {}, "3")
    log.requestId = "chetaidou:charge:call-1"
    audit.usageLog.findMany.mockResolvedValue([log])
    expect((await service.list({ function: "CHETAIDOU_TEXT" }))[0].credits).toBe("3")
    const callQuery = audit.chetaidouCall.findMany.mock.calls[0] as unknown as [
      { where: { kind: string; ownerId?: number } },
    ]
    expect(callQuery[0].where).toMatchObject({ kind: "TEXT", ownerId: undefined })
    const calls = audit.usageLog.findMany.mock.calls as unknown as Array<
      [{ where: { source: { in: string[] } } }]
    >
    const sources = calls[0][0].where.source.in
    expect(sources).not.toContain("chetaidou.image")
    expect(sources).not.toContain("aicreative.ai_split")
  })

  it("模型筛选按报告的全部关联模型匹配，费用仍是该报告全量实扣，不受延迟扣费影响", async () => {
    const { audit, service } = createMocks()
    audit.asinEvidenceRecord.findMany.mockResolvedValue([cases[0].row])
    audit.usageLog.findMany.mockResolvedValue([
      charge("asin.audit.evidence", { clientRequestId: "client-1" }, "1", 1),
      {
        ...charge(
          "asin.audit.evidence",
          { clientRequestId: "client-1", model: "other-model" },
          "2",
          2
        ),
        createdAt: new Date("2026-11-03T05:00:00Z"),
      },
    ])
    const rows = await service.list({
      function: "ASIN_EVIDENCE",
      model: "other-model",
      dateFrom: "2026-11-02",
      dateTo: "2026-11-02",
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      model: "other-model",
      models: ["text-model", "other-model"],
      credits: "3",
    })
  })

  it("组织和角色取交集，关键词可搜索用户名、手机号及用户输入，日期含当日", async () => {
    const { audit, service } = createMocks()
    audit.smartPricingRecord.findMany.mockResolvedValue([
      { ...base, productName: "模型提取的商品名", product: { sourceText: "Coffee 定价" } },
    ])
    for (const keyword of ["coffee", "测试", "1380000"]) {
      const rows = await service.list({
        function: "SMART_PRICING",
        orgId: 2,
        roleId: 3,
        keyword,
        dateFrom: "2026-11-02",
        dateTo: "2026-11-02",
      })
      expect(rows).toHaveLength(1)
    }
    expect(audit.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgs: { some: { orgId: 2 } }, roles: { some: { roleId: 3 } } },
      })
    )
    const pricingQuery = audit.smartPricingRecord.findMany.mock.calls[0] as unknown as [
      { where: { userId: { in: number[] } } },
    ]
    expect(pricingQuery[0].where.userId).toEqual({ in: [7] })
    expect(await service.list({ function: "SMART_PRICING", dateFrom: "2026-11-03" })).toEqual([])
    expect(await service.list({ function: "SMART_PRICING", dateTo: "2026-11-01" })).toEqual([])
    expect(await service.list({ function: "SMART_PRICING", keyword: "不存在" })).toEqual([])
    expect(await service.list({ function: "SMART_PRICING", keyword: "模型提取的商品名" })).toEqual(
      []
    )
  })

  it("保留软删报告和实扣积分，隐藏结果链接；硬删报告的流水作为历史扣费保留", async () => {
    const { audit, service } = createMocks()
    audit.competitorAnalysisRecord.findMany.mockResolvedValue([
      { ...cases[2].row, reportPdfUrl: "https://example.com/report.pdf", deletedAt: createdAt },
    ])
    audit.usageLog.findMany.mockResolvedValue([
      charge("competitor.research", { businessEventId: "run-1" }, "25"),
      charge("competitor.research", { businessEventId: "deleted-report" }, "25", 2),
    ])
    const rows = await service.list({ function: "COMPETITOR_ANALYSIS" })
    expect(rows[0]).toMatchObject({ deleted: true, resultUrl: null, credits: "25" })
    expect(rows[1]).toMatchObject({ status: "BILLED", credits: "25" })
  })

  it("费用关联隔离用户和功能，以台账积分为准而不按 meta 二次扣减退款", async () => {
    const { audit, service } = createMocks()
    audit.smartPricingRecord.findMany.mockResolvedValue([{ ...base, productName: "定价" }])
    audit.promotionPlanRecord.findMany.mockResolvedValue([{ ...base, productName: "推广" }])
    audit.usageLog.findMany.mockResolvedValue([
      charge("pricing.quote", { recordId: base.id, refundedCredits: "1" }, "10"),
      charge("launch.plan", { recordId: base.id }, "15", 2),
      { ...charge("pricing.quote", { recordId: base.id }, "100", 3), userId: 8 },
    ])
    const rows = await service.list({})
    expect(rows.find(row => row.function === "SMART_PRICING")?.credits).toBe("10")
    expect(rows.find(row => row.function === "PROMOTION_PLAN")?.credits).toBe("15")
    expect(rows).toHaveLength(2)
  })

  it("图片、视频、雷达筛选不查询文本表；无人匹配组织时不查业务表", async () => {
    const { audit, service } = createMocks()
    for (const fn of ["IMAGE", "VIDEO", "INSPIRATION_RADAR"] as const)
      expect(await service.list({ function: fn })).toEqual([])
    expect(audit.usageLog.findMany).not.toHaveBeenCalled()
    audit.user.findMany.mockResolvedValue([])
    expect(await service.list({ function: "ASIN_AUDIT", orgId: 99 })).toEqual([])
    expect(audit.asinAuditRecord.findMany).not.toHaveBeenCalled()
  })

  it("DTO 接受全部 14 类功能，拒绝拆分的 ASIN 审计枚举", async () => {
    expect(GENERATION_FUNCTIONS).toHaveLength(14)
    for (const fn of GENERATION_FUNCTIONS)
      expect(await validate(plainToInstance(QueryGenerationRecordsDto, { function: fn }))).toEqual(
        []
      )
    expect(
      await validate(
        plainToInstance(QueryGenerationRecordsDto, { function: "ASIN_AUDIT_OPTIMIZE" })
      )
    ).not.toHaveLength(0)
    const all = plainToInstance(QueryGenerationRecordsDto, { function: "" })
    expect(await validate(all)).toEqual([])
    expect(all.function).toBeUndefined()
  })

  it("旧报告冗余积分不与未关联的台账重复累计", async () => {
    const { audit, service } = createMocks()
    audit.categoryAnalysisRecord.findMany.mockResolvedValue([
      { ...cases[5].row, credits: new Decimal(80) },
    ])
    audit.usageLog.findMany.mockResolvedValue([charge("category.analysis", {}, "80")])
    const rows = await service.list({ function: "CATEGORY_ANALYSIS" })
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.credits)).toEqual([null, "80"])
  })

  it("Listing 历史表与独立评分运行表数字 ID 撞号时仍有唯一列表 key", async () => {
    const { audit, service } = createMocks()
    audit.history.findMany.mockResolvedValue([
      { ...base, id: 43, type: "LISTING_SCORING", title: "历史评分", listingRun: null },
    ])
    audit.businessAiRun.findMany.mockResolvedValue([cases[4].row])
    const rows = await service.list({ function: "LISTING_SCORING" })
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(row => row.key)).size).toBe(2)
  })
})
