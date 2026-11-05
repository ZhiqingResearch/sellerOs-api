import { GenerationRecord, Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { AuditPrismaService } from "./audit-prisma.service"
import { UnifiedGenerationRecordReader } from "./unified-generation-record-reader"

const now = new Date("2026-11-05T08:00:00Z")
const user = { id: 7, username: "测试用户", phone: "13800000000", orgs: [], roles: [] }
const row = (overrides: Partial<GenerationRecord> = {}): GenerationRecord => ({
  id: 1n,
  userId: 7,
  function: "SMART_PRICING",
  sourceType: "TEXT",
  sourceId: "SMART_PRICING:report-1",
  operation: "",
  prompt: "商品定价",
  modelPublicId: "actual-model",
  modelDisplayName: "实际模型名称",
  credits: new Decimal("10.25"),
  resultUrl: null,
  resultCount: null,
  deletedAt: null,
  occurredAt: now,
  updatedAt: now,
  ...overrides,
})

function setup(rows = [row()]) {
  const client = {
    generationRecord: {
      findMany: jest.fn().mockResolvedValue(rows),
      count: jest.fn().mockResolvedValue(42),
      aggregate: jest.fn().mockResolvedValue({ _sum: { credits: new Decimal("123.4567") } }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    user: { findMany: jest.fn().mockResolvedValue([user]) },
    $transaction: jest.fn(),
  }
  client.$transaction.mockImplementation((run: (tx: unknown) => Promise<unknown>) => run(client))
  const audit = { generationTask: { findMany: jest.fn().mockResolvedValue([]) } }
  return {
    client,
    audit,
    reader: new UnifiedGenerationRecordReader(
      client as unknown as PrismaService,
      audit as unknown as AuditPrismaService
    ),
  }
}

describe("成功生成记录主表查询", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(now.getTime())
  })
  afterEach(() => jest.useRealTimers())

  it("数据库分页，总数和积分汇总使用完整筛选集；内部BigInt不进入响应", async () => {
    const { reader, client, audit } = setup()
    const result = await reader.list({
      page: 2,
      pageSize: 20,
      function: "SMART_PRICING",
      model: "actual-model",
    })
    const where = {
      occurredAt: { gte: new Date("2026-10-22T08:00:00Z"), lte: now },
      function: "SMART_PRICING",
      modelPublicId: "actual-model",
    }
    expect(client.generationRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where, skip: 20, take: 20 })
    )
    expect(client.generationRecord.count).toHaveBeenCalledWith({ where })
    expect(client.generationRecord.aggregate).toHaveBeenCalledWith({
      where,
      _sum: { credits: true },
    })
    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    })
    expect(result).toMatchObject({
      total: 42,
      page: 2,
      pageSize: 20,
      totalPages: 3,
      summary: { totalCredits: "123.4567" },
    })
    expect(result.items[0]).toMatchObject({
      id: "report-1",
      key: "TEXT:SMART_PRICING:report-1",
      model: "actual-model",
      modelLabel: "实际模型名称",
      actualModel: "actual-model",
      actualModels: ["actual-model"],
      credits: "10.25",
      createdAt: now.toISOString(),
    })
    expect(() => JSON.stringify(result)).not.toThrow()
    expect(audit.generationTask.findMany).not.toHaveBeenCalled()
  })

  it("用户名和提示词匹配采用OR，组织和角色限制采用AND", async () => {
    const { reader, client } = setup()
    client.user.findMany
      .mockResolvedValueOnce([{ id: 7 }, { id: 8 }])
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce([user])
    await reader.list({ page: 1, pageSize: 10, keyword: "测试", orgId: 3, roleId: 4 })
    expect(client.generationRecord.count).toHaveBeenCalledWith({
      where: {
        occurredAt: { gte: new Date("2026-10-22T08:00:00Z"), lte: now },
        userId: { in: [7, 8] },
        OR: [{ prompt: { contains: "测试" } }, { userId: { in: [7] } }],
      },
    })
    expect(client.user.findMany).toHaveBeenCalledWith({
      where: {
        orgs: { some: { orgId: 3 } },
        roles: { some: { roleId: 4 } },
        OR: [{ username: { contains: "测试" } }, { phone: { contains: "测试" } }],
      },
      select: { id: true },
    })
  })

  it("超出两周的日期取交集，所有查询保持相同边界", async () => {
    const { reader, client } = setup([])
    await reader.list({ page: 1, pageSize: 10, dateFrom: "2020-01-01", dateTo: "2099-01-01" })
    expect(client.generationRecord.count).toHaveBeenCalledWith({
      where: {
        occurredAt: { gte: new Date("2026-10-22T08:00:00Z"), lte: now },
      },
    })
    expect(client.user.findMany).not.toHaveBeenCalled()
  })

  it("空组织范围不放宽筛选，返回用户ID空集合", async () => {
    const { reader, client } = setup([])
    client.user.findMany.mockResolvedValue([])
    await reader.list({ page: 1, pageSize: 10, orgId: 3 })
    expect(client.generationRecord.count).toHaveBeenCalledWith({
      where: {
        occurredAt: { gte: new Date("2026-10-22T08:00:00Z"), lte: now },
        userId: { in: [] },
      },
    })
  })

  it("费用未知与免费不混淆；已删除记录仍保留费用并隐藏链接", async () => {
    const { reader } = setup([
      row({ credits: null, modelPublicId: null, modelDisplayName: null }),
      row({
        id: 2n,
        sourceId: "SMART_PRICING:report-2",
        credits: new Decimal(0),
        deletedAt: now,
        resultUrl: "https://example.com/deleted",
      }),
    ])
    const result = await reader.list({ page: 1, pageSize: 10 })
    expect(result.items[0]).toMatchObject({
      credits: null,
      modelLabel: "—",
      models: [],
      actualModel: null,
      actualModels: [],
    })
    expect(result.items[1]).toMatchObject({ credits: "0", deleted: true, resultUrl: null })
  })

  it("文本报告即使有预览链接和数量，也不使用图片数量摘要", async () => {
    const { reader } = setup([
      row({
        function: "COMPETITOR_ANALYSIS",
        sourceId: "COMPETITOR_ANALYSIS:report-1",
        resultCount: 1,
        resultUrl: "https://example.com/report.pdf",
      }),
    ])
    const result = await reader.list({ page: 1, pageSize: 10 })
    expect(result.items[0].resultLabel).toBe("竞品分析")
  })

  it("同一审计的多次优化与同一订阅的多次刷新有独立key，并保留父业务id", async () => {
    const { reader } = setup([
      row({
        function: "ASIN_AUDIT",
        sourceId: "ASIN_AUDIT:report-1:revision:11",
        operation: "optimize",
        credits: new Decimal(15),
      }),
      row({
        id: 2n,
        function: "ASIN_AUDIT",
        sourceId: "ASIN_AUDIT:report-1:revision:12",
        operation: "optimize",
        credits: new Decimal(15),
      }),
      row({
        id: 3n,
        function: "INSPIRATION_RADAR",
        sourceType: "INSPIRATION_RADAR",
        sourceId: "8:refresh:1730800000000",
      }),
      row({
        id: 4n,
        function: "LISTING_GENERATION",
        sourceId: "LISTING_GENERATION:9:task:10",
        operation: "optimization",
      }),
      row({ id: 5n, function: "VIDEO", sourceType: "RPA_VIDEO", sourceId: "12:event:100" }),
    ])
    const result = await reader.list({ page: 1, pageSize: 10 })
    expect(result.items[0]).toMatchObject({
      key: "TEXT:ASIN_AUDIT:report-1:revision:11:optimize",
      recordId: "report-1",
      credits: "15",
    })
    expect(result.items[1]).toMatchObject({
      key: "TEXT:ASIN_AUDIT:report-1:revision:12:optimize",
      recordId: "report-1",
      credits: "15",
    })
    expect(result.items[2]).toMatchObject({
      key: "INSPIRATION_RADAR:8:refresh:1730800000000",
      id: 8,
    })
    expect(result.items[3]).toMatchObject({ key: "TEXT:LISTING_GENERATION:9:task:10", id: 9 })
    expect(result.items[4]).toMatchObject({ key: "RPA_VIDEO:12:event:100", id: 12 })
  })

  it.each([
    [
      "ASIN_AUDIT",
      "TEXT",
      "ASIN_AUDIT:report-1",
      "score",
      "TEXT:ASIN_AUDIT:report-1:score",
      "report-1:score",
      "SCORED",
    ],
    [
      "ASIN_AUDIT",
      "TEXT",
      "ASIN_AUDIT:report-1",
      "optimize",
      "TEXT:ASIN_AUDIT:report-1:optimize",
      "report-1:optimize",
      "OPTIMIZED",
    ],
    [
      "ASIN_EVIDENCE",
      "TEXT",
      "ASIN_EVIDENCE:report-1",
      "evidence",
      "TEXT:ASIN_EVIDENCE:report-1",
      "report-1",
      "SUCCESS",
    ],
    [
      "LISTING_SCORING",
      "TEXT_RUN",
      "listing-score:123",
      "score",
      "TEXT_RUN:listing-score:123",
      123,
      "COMPLETED",
    ],
    [
      "CATEGORY_ANALYSIS",
      "TEXT",
      "CATEGORY_ANALYSIS:23",
      "",
      "TEXT:CATEGORY_ANALYSIS:23",
      23,
      "COMPLETED",
    ],
    ["IMAGE", "IMAGEGEN", "job-1", "", "IMAGEGEN:job-1", "job-1", "SUCCESS"],
    ["VIDEO", "RPA_VIDEO", "23", "", "RPA_VIDEO:23", 23, "SUCCESS"],
    [
      "CHETAIDOU_TEXT",
      "TEXT",
      "CHETAIDOU_TEXT:task-1",
      "IDEATION",
      "TEXT:CHETAIDOU_TEXT:task-1",
      "task-1",
      "SUCCEEDED",
    ],
  ])(
    "%s兼容旧key、业务id与成功状态",
    async (fn, sourceType, sourceId, operation, key, id, status) => {
      const { reader } = setup([
        row({
          function: fn,
          sourceType,
          sourceId,
          operation,
        }),
      ])
      const result = await reader.list({ page: 1, pageSize: 10 })
      expect(result.items[0]).toMatchObject({ key, id, status })
      if (fn === "ASIN_AUDIT" || fn === "ASIN_EVIDENCE")
        expect(result.items[0].recordId).toBe("report-1")
    }
  )

  it("拆图仅为当前页补查代表任务id，数量摘要不再读取方向或总席位", async () => {
    const { reader, audit } = setup([
      row({ function: "IMAGE", sourceType: "AI_SPLIT", sourceId: "group-1", resultCount: 3 }),
    ])
    audit.generationTask.findMany.mockResolvedValue([
      { id: 9, groupId: "group-1", createdAt: now },
      { id: 10, groupId: "group-1", createdAt: now },
    ])
    const result = await reader.list({ page: 1, pageSize: 10 })
    expect(result.items[0]).toMatchObject({
      key: "AI_SPLIT:group-1",
      id: 9,
      resultLabel: "成功 3 张",
      resultCount: 3,
    })
    expect(audit.generationTask.findMany).toHaveBeenCalledTimes(1)
    expect(audit.generationTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          source: "platform",
          project: { source: "platform" },
          generationMode: "AI_SPLIT",
          OR: [{ groupId: { in: ["group-1"] } }, { id: { in: [] } }],
        },
      })
    )
  })

  it("模型选项使用实际publicId和最新名称快照；不受分页与已选模型收窄", async () => {
    const { reader, client } = setup()
    client.generationRecord.groupBy.mockResolvedValue([
      {
        function: "SMART_PRICING",
        modelPublicId: "m1",
        modelDisplayName: "旧名称",
        _max: { occurredAt: new Date("2026-11-04") },
      },
      {
        function: "SMART_PRICING",
        modelPublicId: "m1",
        modelDisplayName: "新名称",
        _max: { occurredAt: now },
      },
      {
        function: "SMART_PRICING",
        modelPublicId: "m2",
        modelDisplayName: null,
        _max: { occurredAt: now },
      },
    ])
    const extra = { function: "SMART_PRICING" as const, model: "m2", page: 3, pageSize: 1 }
    expect(await reader.getModelOptions(extra)).toEqual([
      { function: "SMART_PRICING", value: "m1", label: "新名称" },
      { function: "SMART_PRICING", value: "m2", label: "m2" },
    ])
    expect(client.generationRecord.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {
              function: "SMART_PRICING",
              occurredAt: { gte: new Date("2026-10-22T08:00:00Z"), lte: now },
            },
            { function: { not: "INSPIRATION_RADAR" }, modelPublicId: { not: null } },
          ],
        },
      })
    )
    expect(client.generationRecord.findMany).not.toHaveBeenCalled()
  })
})
