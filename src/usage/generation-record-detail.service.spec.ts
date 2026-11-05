import { BadRequestException, NotFoundException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { QueryGenerationRecordDetailDto } from "./dto/generation-record-detail.dto"
import { GenerationRecordDetailService } from "./generation-record-detail.service"

const createdAt = new Date("2026-11-02T04:00:00Z")
const base = { userId: 99, createdAt, deletedAt: null, status: "COMPLETED" }
const result = { title: "已生成的报告", sections: [{ text: "正文" }] }

function createMocks() {
  const delegate = () => ({
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
  })
  const audit = {
    usageLog: delegate(),
    businessAiRun: delegate(),
    history: delegate(),
    historyRevision: delegate(),
    listingGenerationTask: delegate(),
    listingAiStep: delegate(),
    categoryAnalysisRecord: delegate(),
    asinEvidenceRecord: delegate(),
    asinAuditRecord: delegate(),
    asinAuditOptimizationRevision: delegate(),
    generationRecord: delegate(),
    competitorAnalysisRecord: delegate(),
    selectionAnalysisRecord: delegate(),
    smartPricingRecord: delegate(),
    promotionPlanRecord: delegate(),
    videoAnalysisRecord: delegate(),
    chetaidouTask: delegate(),
    chetaidouBreakdown: delegate(),
    chetaidouGroup: { findMany: jest.fn().mockResolvedValue([]) },
  }
  return { audit, service: new GenerationRecordDetailService(audit as never) }
}

describe("管理员生成记录正文", () => {
  it("ASIN优化事件读取固定revision及该笔冻结积分，伪造event返回404", async () => {
    const { audit, service } = createMocks()
    audit.asinAuditOptimizationRevision.findFirst.mockResolvedValue({
      revision: 1,
      schemaVersion: 1,
      optimizationResult: result,
      createdAt,
      record: { userId: 99, deletedAt: null },
    })
    const key = "TEXT:ASIN_AUDIT:report:revision:9:event:12:optimize"
    await expect(service.detail(key)).rejects.toBeInstanceOf(NotFoundException)
    const occurredAt = new Date(createdAt.getTime() + 1000)
    audit.generationRecord.findUnique.mockResolvedValue({
      credits: new Decimal("21.5"),
      modelPublicId: "model-1",
      occurredAt,
    })
    expect(await service.detail(key)).toMatchObject({
      available: true,
      recordId: "report",
      operation: "optimize",
      credits: "21.5",
      models: ["model-1"],
      createdAt: occurredAt.toISOString(),
      content: { revision: 1, optimizationResult: result },
    })
    expect(audit.generationRecord.findUnique).toHaveBeenCalledWith({
      where: {
        sourceType_sourceId_operation: {
          sourceType: "TEXT",
          sourceId: "ASIN_AUDIT:report:revision:9:event:12",
          operation: "optimize",
        },
      },
    })
    expect(audit.asinAuditOptimizationRevision.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 9, recordId: "report" } })
    )
  })

  it("Listing成功版本key读取固定revision，兼容旧报告正文结构", async () => {
    const { audit, service } = createMocks()
    audit.historyRevision.findFirst.mockResolvedValue({
      data: result,
      createdAt,
      history: { userId: 99 },
    })
    expect(await service.detail("TEXT:LISTING_GENERATION:7:revision:33")).toMatchObject({
      available: true,
      content: { report: result, steps: [] },
      userId: 99,
    })
    expect(audit.historyRevision.findFirst).toHaveBeenCalledWith({
      where: { id: 33, historyId: 7, history: { type: "LISTING_GENERATION" } },
      select: { data: true, createdAt: true, history: { select: { userId: true } } },
    })
    expect(audit.history.findFirst).not.toHaveBeenCalled()
  })

  it("Listing优化任务key返回当次正文，不读取后续改写的History正文", async () => {
    const { audit, service } = createMocks()
    audit.listingGenerationTask.findFirst.mockResolvedValue({
      id: 8,
      listingRunId: 1,
      mainStepId: 11,
      longTitleStepId: null,
      planIndex: 0,
      updatedAt: createdAt,
      input: {
        main: { operation: "optimization", systemPrompt: "never-return" },
        result,
        context: { params: { market: "amazon_de" } },
      },
      billing: { credential: "never-return" },
      listingRun: { history: { userId: 99, data: { title: "later changed" } } },
    })
    audit.listingAiStep.findMany.mockResolvedValue([
      {
        id: 11,
        operation: "optimization",
        model: "model",
        status: "COMPLETED",
        usageLogId: 100,
        outputText: JSON.stringify(result),
      },
    ])
    const detail = await service.detail("TEXT:LISTING_GENERATION:7:task:8")
    expect(detail).toMatchObject({
      available: true,
      content: { report: { params: { market: "amazon_de" }, plans: [{ result }] } },
    })
    expect(audit.listingGenerationTask.findFirst).toHaveBeenCalledWith({
      where: { id: 8, status: "COMPLETED", listingRun: { historyId: 7 } },
      include: { listingRun: { include: { history: true } } },
    })
    expect(JSON.stringify(detail)).not.toContain("never-return")
    expect(JSON.stringify(detail)).not.toContain("later changed")
  })

  it("新品推广计划详情附带实际生成模型，正文保持原 result", async () => {
    const { audit, service } = createMocks()
    audit.promotionPlanRecord.findUnique.mockResolvedValue({
      ...base,
      clientRequestId: "promotion-1",
      result,
    })
    audit.businessAiRun.findMany.mockResolvedValue([
      {
        userId: 99,
        runId: "promotion-1",
        operation: "generate",
        model: "promotion-model",
        billing: null,
      },
    ])
    expect(await service.detail("TEXT:PROMOTION_PLAN:record-1")).toMatchObject({
      available: true,
      actualModel: "promotion-model",
      actualModels: ["promotion-model"],
      content: result,
    })
  })

  it("智能定价详情返回存档站点、币种、类目和实际模型，不暴露网关账单", async () => {
    const { audit, service } = createMocks()
    audit.smartPricingRecord.findUnique.mockResolvedValue({
      ...base,
      clientRequestId: "client-1",
      marketplaceCode: "AMAZON_DE",
      marketplaceName: "Amazon DE",
      currency: "EUR",
      category: "家居用品",
      product: {},
      inputSnapshot: {},
      competitorContext: null,
      result,
    })
    audit.businessAiRun.findMany.mockResolvedValue([
      {
        userId: 99,
        runId: "client-1-generate",
        operation: "generate",
        model: "requested-model",
        billing: { billing: { model: "actual-model", secret: "never-return" } },
      },
    ])
    const detail = await service.detail("TEXT:SMART_PRICING:record-1")
    expect(detail).toMatchObject({
      actualModel: "actual-model",
      actualModels: ["actual-model"],
      available: true,
      content: { result },
    })
    expect(detail.content).toEqual({
      marketplaceCode: "AMAZON_DE",
      marketplaceName: "Amazon DE",
      currency: "EUR",
      category: "家居用品",
      product: {},
      input: {},
      competitorContext: null,
      result,
    })
    expect(audit.smartPricingRecord.findUnique).toHaveBeenCalledWith({
      where: { id: "record-1" },
      select: {
        clientRequestId: true,
        userId: true,
        createdAt: true,
        deletedAt: true,
        marketplaceCode: true,
        marketplaceName: true,
        currency: true,
        category: true,
        product: true,
        inputSnapshot: true,
        competitorContext: true,
        result: true,
      },
    })
    expect(JSON.stringify(detail)).not.toContain("never-return")
  })

  it("取证的旧来源扣费链接返回取证正文、积分和模型，不能伪装成审计", async () => {
    const { audit, service } = createMocks()
    const report = {
      ...base,
      id: "evidence-1",
      clientRequestId: "saved",
      asin: "B012345678",
      model: "evidence-model",
      evidence: result,
    }
    const log = {
      id: 10904,
      userId: 99,
      source: "asin.audit",
      requestId: "charge:asin-audit:evidence:uuid",
      meta: {
        stage: "evidence",
        scene: "evidence-module",
        clientRequestId: "generation",
        model: "evidence-model",
      },
      createdAt: new Date(createdAt.getTime() - 938),
      credits: new Decimal(5),
    }
    audit.asinEvidenceRecord.findUnique.mockResolvedValue(report)
    audit.asinEvidenceRecord.findMany.mockResolvedValue([report])
    audit.usageLog.findUnique.mockResolvedValue(log)
    audit.usageLog.findMany.mockResolvedValue([log])
    for (const key of ["TEXT:ASIN_EVIDENCE:evidence-1", "TEXT:ASIN_EVIDENCE:usage:10904"]) {
      expect(await service.detail(key)).toMatchObject({
        key,
        function: "ASIN_EVIDENCE",
        available: true,
        operation: "evidence",
        credits: "5",
        models: ["evidence-model"],
        content: result,
      })
    }
    await expect(service.detail("TEXT:ASIN_AUDIT:usage:10904")).rejects.toBeInstanceOf(
      NotFoundException
    )
  })

  it("打分和优化分别返回各自正文、模型和积分，旧扣费链接也能读取对应优化正文", async () => {
    const { audit, service } = createMocks()
    const optimizedAt = new Date("2026-11-03T08:36:47.260Z")
    const report = {
      ...base,
      id: "record-1",
      asin: "B012345678",
      productTitle: "商品",
      clientRequestId: "saved-report",
      scoreSnapshot: {
        createdAt,
        schemaVersion: 1,
        evidence: { asin: "B012345678" },
        scoreResult: { total: 80 },
      },
      optimizationRevisions: [
        {
          revision: 2,
          schemaVersion: 1,
          createdAt: optimizedAt,
          optimizationResult: { listing: { title: "最新优化" } },
        },
      ],
    }
    const logs = [
      {
        id: 1,
        userId: 99,
        source: "asin.audit",
        requestId: "score-request",
        meta: { stage: "score", recordId: "record-1", model: "score-model" },
        createdAt,
        credits: new Decimal(20),
      },
      {
        id: 12837,
        userId: 99,
        source: "asin.audit",
        requestId: "opt-request",
        meta: { stage: "optimize", clientRequestId: "generation-request", model: "opt-model" },
        createdAt: new Date(optimizedAt.getTime() - 799),
        credits: new Decimal(15),
      },
    ]
    audit.asinAuditRecord.findUnique.mockResolvedValue(report)
    audit.asinAuditRecord.findMany.mockResolvedValue([report])
    audit.usageLog.findMany.mockResolvedValue(logs)
    const score = await service.detail("TEXT:ASIN_AUDIT:record-1:score")
    expect(score).toMatchObject({
      operation: "score",
      recordId: "record-1",
      credits: "20",
      models: ["score-model"],
      content: { scoreResult: { total: 80 } },
    })
    expect(score.content).not.toHaveProperty("optimizationResult")
    const optimize = await service.detail("TEXT:ASIN_AUDIT:record-1:optimize")
    expect(optimize).toMatchObject({
      operation: "optimize",
      credits: "15",
      models: ["opt-model"],
      createdAt: optimizedAt.toISOString(),
      content: { revision: 2, optimizationResult: { listing: { title: "最新优化" } } },
    })
    expect(optimize.content).not.toHaveProperty("scoreResult")
    audit.usageLog.findUnique.mockResolvedValue(logs[1])
    expect(await service.detail("TEXT:ASIN_AUDIT:usage:12837")).toMatchObject({
      key: "TEXT:ASIN_AUDIT:usage:12837",
      available: true,
      operation: "optimize",
      credits: "15",
      content: optimize.content,
    })
    audit.asinAuditRecord.findUnique.mockResolvedValue({ ...report, deletedAt: createdAt })
    expect(await service.detail("TEXT:ASIN_AUDIT:record-1:optimize")).toMatchObject({
      deleted: true,
      available: false,
      content: null,
      credits: "15",
    })
  })

  it("未生成优化时不能用优化 key 返回打分正文", async () => {
    const { audit, service } = createMocks()
    audit.asinAuditRecord.findUnique.mockResolvedValue({
      ...base,
      scoreSnapshot: { createdAt, scoreResult: result },
      optimizationRevisions: [],
    })
    await expect(service.detail("TEXT:ASIN_AUDIT:record-1:optimize")).rejects.toBeInstanceOf(
      NotFoundException
    )
  })

  const cases = [
    {
      fn: "ASIN_EVIDENCE",
      table: "asinEvidenceRecord",
      method: "findUnique",
      id: "record-1",
      row: { ...base, evidence: result },
      expected: result,
    },
    {
      fn: "ASIN_AUDIT",
      table: "asinAuditRecord",
      method: "findUnique",
      id: "record-1",
      row: {
        ...base,
        status: "OPTIMIZED",
        scoreSnapshot: { evidence: { asin: "B012345678" }, scoreResult: result, schemaVersion: 1 },
        optimizationRevisions: [
          { revision: 1, schemaVersion: 1, optimizationResult: { title: "优化一" }, createdAt },
          { revision: 2, schemaVersion: 1, optimizationResult: { title: "优化二" }, createdAt },
        ],
      },
      expected: {
        evidence: { asin: "B012345678" },
        scoreResult: result,
        schemaVersion: 1,
        optimizations: [
          { revision: 1, schemaVersion: 1, optimizationResult: { title: "优化一" }, createdAt },
          { revision: 2, schemaVersion: 1, optimizationResult: { title: "优化二" }, createdAt },
        ],
      },
    },
    {
      fn: "COMPETITOR_ANALYSIS",
      table: "competitorAnalysisRecord",
      method: "findUnique",
      id: "record-1",
      row: {
        ...base,
        inputSnapshot: { asins: ["B012345678"] },
        analysisResult: result,
        products: [],
        reportData: { boards: [] },
        reportPdfUrl: null,
      },
      expected: {
        input: { asins: ["B012345678"] },
        analysisResult: result,
        products: [],
        reportData: { boards: [] },
        reportPdfUrl: null,
      },
    },
    {
      fn: "LISTING_GENERATION",
      table: "history",
      method: "findFirst",
      id: "1",
      row: { ...base, data: result, listingRun: null },
      expected: { report: result, steps: [] },
    },
    {
      fn: "LISTING_SCORING",
      table: "history",
      method: "findFirst",
      id: "2",
      row: { ...base, data: { total: 85 }, listingRun: null },
      expected: { report: { total: 85 }, steps: [] },
    },
    {
      fn: "CATEGORY_ANALYSIS",
      table: "categoryAnalysisRecord",
      method: "findUnique",
      id: "1",
      row: { ...base, result: [result] },
      expected: [result],
    },
    {
      fn: "PRODUCT_SELECTION",
      table: "selectionAnalysisRecord",
      method: "findFirst",
      id: "record-1",
      row: {
        ...base,
        marketplace: "US",
        entry: "PRODUCT",
        steps: [{ stepNo: 1, stepType: "PRODUCT_VALIDATION", payload: result }],
      },
      expected: {
        marketplace: "US",
        entry: "PRODUCT",
        steps: [{ stepNo: 1, stepType: "PRODUCT_VALIDATION", payload: result }],
      },
    },
    {
      fn: "SMART_PRICING",
      table: "smartPricingRecord",
      method: "findUnique",
      id: "record-1",
      row: {
        ...base,
        marketplaceCode: "AMAZON_US",
        marketplaceName: "Amazon US",
        currency: "USD",
        category: "咖啡机",
        product: { name: "咖啡机" },
        inputSnapshot: { cost: 10 },
        competitorContext: null,
        result,
      },
      expected: {
        marketplaceCode: "AMAZON_US",
        marketplaceName: "Amazon US",
        currency: "USD",
        category: "咖啡机",
        product: { name: "咖啡机" },
        input: { cost: 10 },
        competitorContext: null,
        result,
      },
    },
    {
      fn: "PROMOTION_PLAN",
      table: "promotionPlanRecord",
      method: "findUnique",
      id: "record-1",
      row: { ...base, result },
      expected: result,
    },
    {
      fn: "VIDEO_ANALYSIS",
      table: "videoAnalysisRecord",
      method: "findUnique",
      id: "record-1",
      row: { ...base, result },
      expected: result,
    },
    {
      fn: "CHETAIDOU_TEXT",
      table: "chetaidouTask",
      method: "findFirst",
      id: "task-1",
      row: {
        ownerId: 99,
        createdAt,
        status: "SUCCEEDED",
        type: "COMPOSE",
        output: result,
        rootTaskId: "task-1",
        imageId: 4,
      },
      expected: { type: "COMPOSE", output: result, groups: [], breakdown: null },
    },
  ] as const

  it.each(cases)(
    "$fn 返回该用户已保存的完整正文",
    async ({ fn, table, method, id, row, expected }) => {
      const { audit, service } = createMocks()
      audit[table][method].mockResolvedValue(row)
      const key = `TEXT:${fn}:${id}`
      expect(await service.detail(key)).toMatchObject({
        key,
        function: fn,
        contentType: "TEXT",
        userId: 99,
        available: true,
        format: "JSON",
        content: expected,
        deleted: false,
        message: null,
        createdAt: createdAt.toISOString(),
      })
    }
  )

  it("独立 Listing 评分优先使用已修复的交付正文，不泄露账单及内部字段", async () => {
    const { audit, service } = createMocks()
    audit.businessAiRun.findFirst.mockResolvedValue({
      ...base,
      outputText: "原始错误正文",
      billing: {
        resultText: JSON.stringify({ total: 90, report: result }),
        primary: { billing: { credential: "never-return" } },
      },
      inputHash: "never-return",
    })
    const detail = await service.detail("TEXT_RUN:listing-score:1")
    expect(detail.content).toEqual({ total: 90, report: result })
    expect(detail.format).toBe("JSON")
    expect(JSON.stringify(detail)).not.toContain("never-return")
    expect(audit.businessAiRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, module: "listing-score" } })
    )
  })

  it("竞品未归档总结与独立评分原始纯文本按 TEXT 返回，读取不触发模型或计费", async () => {
    const { audit, service } = createMocks()
    audit.businessAiRun.findFirst.mockResolvedValue({
      ...base,
      outputText: "# 竞品总结\n正文",
      billing: { token: "never-return" },
    })
    expect(await service.detail("TEXT_RUN:competitor-analysis:1")).toMatchObject({
      function: "COMPETITOR_ANALYSIS",
      available: true,
      format: "TEXT",
      content: "# 竞品总结\n正文",
    })
    audit.businessAiRun.findFirst.mockResolvedValue({
      ...base,
      outputText: "评分正文",
      billing: null,
    })
    expect((await service.detail("TEXT_RUN:listing-score:1")).content).toBe("评分正文")
  })

  it("Listing 尚无报告时不把空 plans 当正文，保存的生成步骤则仍可查看", async () => {
    const { audit, service } = createMocks()
    const row = {
      ...base,
      status: "ANALYZING",
      data: { params: { keyword: "咖啡机" }, plans: [] },
      listingRun: { status: "ANALYZING", steps: [] as object[] },
    }
    audit.history.findFirst.mockResolvedValue(row)
    expect(await service.detail("TEXT:LISTING_GENERATION:1")).toMatchObject({
      available: false,
      format: null,
      content: null,
    })
    row.listingRun.steps.push({ operation: "generation", outputText: " \n " })
    expect((await service.detail("TEXT:LISTING_GENERATION:1")).available).toBe(false)
    row.listingRun.steps.push({
      operation: "generation",
      model: "model-1",
      status: "FAILED",
      outputText: "部分生成正文",
    })
    expect((await service.detail("TEXT:LISTING_GENERATION:1")).available).toBe(true)
    expect(audit.history.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, type: "LISTING_GENERATION" } })
    )
  })

  it("软删记录保留元信息但不返回正文，未完成及空正文返回 available=false", async () => {
    const { audit, service } = createMocks()
    audit.asinEvidenceRecord.findUnique.mockResolvedValue({
      ...base,
      deletedAt: createdAt,
      evidence: { secretDeletedBody: "已删除正文" },
    })
    const deleted = await service.detail("TEXT:ASIN_EVIDENCE:record-1")
    expect(deleted).toMatchObject({
      deleted: true,
      available: false,
      content: null,
      format: null,
      message: "记录已删除，正文不可用",
    })
    expect(JSON.stringify(deleted)).not.toContain("secretDeletedBody")
    audit.categoryAnalysisRecord.findUnique.mockResolvedValue({
      ...base,
      status: "PENDING",
      result: null,
    })
    expect(await service.detail("TEXT:CATEGORY_ANALYSIS:1")).toMatchObject({
      status: "PENDING",
      available: false,
      content: null,
    })
    audit.businessAiRun.findFirst.mockResolvedValue({ ...base, outputText: " \n ", billing: null })
    expect((await service.detail("TEXT_RUN:listing-score:1")).available).toBe(false)
  })

  it("历史扣费必须匹配功能，存在但无报告时返回说明，不返回 meta 或 requestParams", async () => {
    const { audit, service } = createMocks()
    audit.usageLog.findUnique.mockResolvedValue({
      userId: 99,
      source: "asin.audit",
      createdAt,
      meta: { token: "never-return" },
      requestParams: "never-return",
    })
    const detail = await service.detail("TEXT:ASIN_AUDIT:usage:1")
    expect(detail).toMatchObject({
      status: "BILLED",
      available: false,
      content: null,
      format: null,
      message: "仅有扣费流水，暂无关联报告正文",
    })
    expect(JSON.stringify(detail)).not.toContain("never-return")
    await expect(service.detail("TEXT:ASIN_EVIDENCE:usage:1")).rejects.toBeInstanceOf(
      NotFoundException
    )
  })

  it("车泰斗联想返回维度选项，拆解沿已保存 breakdownId 取 payload，不读取内部请求快照", async () => {
    const { audit, service } = createMocks()
    audit.chetaidouTask.findFirst.mockResolvedValue({
      ownerId: 99,
      createdAt,
      type: "IDEATION",
      status: "PARTIAL",
      rootTaskId: "root-1",
      imageId: 4,
      output: null,
      snapshot: "never-return",
    })
    audit.chetaidouGroup.findMany.mockResolvedValue([
      { id: "group-1", options: ["选项1"], status: "SUCCEEDED" },
    ])
    expect(await service.detail("TEXT:CHETAIDOU_TEXT:task-1")).toMatchObject({
      available: true,
      content: { groups: [{ id: "group-1", options: ["选项1"], status: "SUCCEEDED" }] },
    })
    audit.chetaidouTask.findFirst.mockResolvedValue({
      ownerId: 99,
      createdAt,
      type: "BREAKDOWN",
      status: "SUCCEEDED",
      rootTaskId: "task-1",
      imageId: 4,
      output: { breakdownId: 12 },
    })
    audit.chetaidouBreakdown.findFirst.mockResolvedValue({ schemaVersion: 1, payload: result })
    const detail = await service.detail("TEXT:CHETAIDOU_TEXT:task-1")
    expect(detail).toMatchObject({
      available: true,
      content: { breakdown: { schemaVersion: 1, payload: result } },
    })
    expect(audit.chetaidouBreakdown.findFirst).toHaveBeenCalledWith({
      where: { id: 12, imageId: 4 },
      select: { schemaVersion: true, payload: true },
    })
    expect(JSON.stringify(detail)).not.toContain("never-return")
  })

  it.each([
    "",
    "IMAGE:1",
    "TEXT:IMAGE:1",
    "TEXT:UNKNOWN:1",
    "TEXT_RUN:smart-pricing:1",
    "TEXT_RUN:listing-score:0",
    "TEXT_RUN:listing-score:4294967296",
    "TEXT:CATEGORY_ANALYSIS:-1",
    "TEXT:LISTING_SCORING:01",
    "TEXT:LISTING_SCORING:abc",
    "TEXT:ASIN_AUDIT:usage:1:2",
    "TEXT:ASIN_AUDIT:usage:9007199254740993",
  ])("拒绝非法标识 %s", async key => {
    const { service } = createMocks()
    await expect(service.detail(key)).rejects.toBeInstanceOf(BadRequestException)
  })

  it("不存在或已硬删的报告返回 404；正文 key 必填且限制长度", async () => {
    const { service } = createMocks()
    await expect(service.detail("TEXT:PROMOTION_PLAN:missing")).rejects.toBeInstanceOf(
      NotFoundException
    )
    await expect(service.detail("TEXT_RUN:listing-score:1")).rejects.toBeInstanceOf(
      NotFoundException
    )
    await expect(service.detail("TEXT:ASIN_AUDIT:usage:1")).rejects.toBeInstanceOf(
      NotFoundException
    )
    for (const value of [{}, { key: "" }, { key: "x".repeat(257) }])
      expect(
        await validate(plainToInstance(QueryGenerationRecordDetailDto, value))
      ).not.toHaveLength(0)
    expect(
      await validate(
        plainToInstance(QueryGenerationRecordDetailDto, { key: "TEXT:ASIN_AUDIT:record-1" })
      )
    ).toEqual([])
  })
})
