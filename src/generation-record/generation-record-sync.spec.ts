/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
// 测试内存委托模拟异构 Prisma 表；生产逻辑由实际同步函数执行。
import { Prisma } from "@prisma/client"
import { memoryClient } from "../../test/generation-record-memory"
import { hashJson } from "../common/utils/canonical-json"
import {
  eligibleGenerationSource,
  generationIdentity,
  projectGenerationSource,
  syncGenerationSource,
} from "./generation-record-sync"

const occurredAt = new Date("2026-11-03T12:00:00Z")
const user = { id: 7, username: "运营", phone: "13800000000", orgs: [], roles: [] }

const image = (extra = {}) => ({
  id: 1,
  userId: 7,
  user,
  source: "platform",
  project: { source: "platform" },
  generationMode: "STANDARD",
  groupId: null,
  model: "model-1",
  prompt: "产品白底图",
  status: "SUCCESS",
  createdAt: occurredAt,
  deletedAt: null,
  sourceJobId: null,
  generatedImages: [{ url: "https://example.com/image", status: "SUCCESS", adopted: false }],
  ...extra,
})

describe("generation projection", () => {
  it.each(["  前端原文\r\n第二行  ", ""])(
    "在线原始输入不受业务字段归一化影响：%j",
    async prompt => {
      const { tx, data } = memoryClient({ generationTask: [image({ prompt: "模型执行稿" })] })
      await syncGenerationSource(tx, "generationTask", 1, { prompt })
      expect(data.generationRecord[0].prompt).toBe(prompt)
    }
  )

  it.each([
    {
      source: "history" as const,
      extra: {
        type: "LISTING_GENERATION",
        title: "系统标题",
        data: { params: { keyword: "用户描述" }, result: { title: "AI结果" } },
        version: 1,
      },
      prompt: "用户描述",
    },
    {
      source: "categoryAnalysisRecord" as const,
      extra: { title: "系统标题", status: "COMPLETED", keywords: ["用户关键词"], categories: [] },
      prompt: JSON.stringify(["用户关键词"]),
    },
    {
      source: "selectionAnalysisRecord" as const,
      extra: {
        status: "COMPLETED",
        entry: "PRODUCT",
        primaryCategoryName: "系统类目",
        steps: [{ payload: { productData: { asin: "B0DSGRHL7C" } } }],
      },
      prompt: "B0DSGRHL7C",
    },
    {
      source: "promotionPlanRecord" as const,
      extra: {
        productName: "AI商品名",
        input: { productText: "用户描述", competitorLinks: ["B0DSGRHL7C"] },
      },
      prompt: JSON.stringify({ productText: "用户描述", competitorLinks: ["B0DSGRHL7C"] }),
    },
    {
      source: "videoAnalysisRecord" as const,
      extra: { title: "AI视频标题", videoUrl: "https://example.com/user.mp4", focus: "用户关注点" },
      prompt: JSON.stringify({ videoUrl: "https://example.com/user.mp4", focus: "用户关注点" }),
    },
    {
      source: "businessAiRun" as const,
      extra: {
        module: "listing-score",
        status: "COMPLETED",
        outputText: "AI评分结果",
        billing: { userInput: "用户评分输入" },
      },
      prompt: "用户评分输入",
    },
    {
      source: "videoTask" as const,
      extra: {
        user,
        status: "SUCCESS",
        mode: "MOTION_CONTROL",
        prompt: "系统默认提示词",
        deliveryMeta: { userInput: "用户动作说明" },
      },
      prompt: "用户动作说明",
    },
    {
      source: "beautyTask" as const,
      extra: {
        user,
        status: "SUCCESS",
        prompt: "系统美妆模板",
        beautyInput: { style: "用户妆容要求" },
      },
      prompt: JSON.stringify({ style: "用户妆容要求" }),
    },
    {
      source: "imageGenJob" as const,
      extra: {
        user,
        status: "COMPLETED",
        kind: "TEXT_TO_IMAGE",
        prompt: "系统合成稿",
        request: { userInput: "用户生图输入" },
        items: [],
      },
      prompt: "用户生图输入",
    },
  ])(
    "$source writes user input through the real snapshot projection",
    async ({ source, extra, prompt }) => {
      const root = {
        id: source === "history" ? 9 : "input-report",
        userId: 7,
        source: "platform",
        project: { source: "platform" },
        taskId: null,
        businessType: "IMAGE_CREATIVE",
        clientRequestId: null,
        createdAt: occurredAt,
        deletedAt: null,
        ...extra,
      }
      const { tx, data } = memoryClient({
        [source]: [root],
        historyRevision: [
          {
            id: 1,
            historyId: root.id,
            data: "data" in extra ? extra.data : {},
            createdAt: occurredAt,
          },
        ],
      })
      await syncGenerationSource(tx, source, root.id)
      expect(data.generationRecord).toHaveLength(1)
      expect(data.generationRecord[0].prompt).toBe(prompt)
    }
  )

  it.each([
    {
      source: "smartPricingRecord" as const,
      row: {
        productName: "模型提取的商品名",
        product: { sourceText: "用户输入的商品描述", sourceUrl: "https://example.com/product" },
      },
      prompt: "用户输入的商品描述",
    },
    {
      source: "smartPricingRecord" as const,
      row: {
        productName: "模型提取的商品名",
        product: { sourceUrl: "https://example.com/product" },
      },
      prompt: "https://example.com/product",
    },
    {
      source: "smartPricingRecord" as const,
      row: { productName: "模型提取的商品名", product: { filenames: ["采购报价.pdf"] } },
      prompt: JSON.stringify(["采购报价.pdf"]),
    },
    {
      source: "competitorAnalysisRecord" as const,
      row: { title: "竞品分析 · 1 个竞品", inputSnapshot: { sourceText: "B0DSGRHL7C" } },
      prompt: "B0DSGRHL7C",
    },
    {
      source: "competitorAnalysisRecord" as const,
      row: {
        title: "自动标题",
        inputSnapshot: { mode: "ASIN", ownAsin: "B0AAAA0001", competitorAsins: ["B0BBBB0002"] },
      },
      prompt: JSON.stringify({
        mode: "ASIN",
        ownAsin: "B0AAAA0001",
        competitorAsins: ["B0BBBB0002"],
      }),
    },
    {
      source: "competitorAnalysisRecord" as const,
      row: {
        title: "自动标题",
        inputSnapshot: {
          mode: "KEYWORD",
          keyword: "portable blender",
          competitorAsins: ["B0BBBB0002"],
        },
      },
      prompt: "portable blender",
    },
    {
      source: "smartPricingRecord" as const,
      row: { productName: "不能冒充用户输入的商品名", product: {} },
      prompt: "",
    },
    {
      source: "competitorAnalysisRecord" as const,
      row: { title: "不能冒充用户输入的标题", inputSnapshot: {} },
      prompt: "",
    },
  ])(
    "$source freezes user input instead of a generated title: $prompt",
    async ({ source, row, prompt }) => {
      const root = {
        id: "report",
        userId: 7,
        clientRequestId: null,
        createdAt: occurredAt,
        deletedAt: null,
        ...row,
      }
      const { tx, data } = memoryClient({ [source]: [root] })
      await syncGenerationSource(tx, source, root.id)
      expect(data.generationRecord).toHaveLength(1)
      expect(data.generationRecord[0].prompt).toBe(prompt)
      const select = tx[source].findMany.mock.calls[0][0].select
      expect(select[source === "smartPricingRecord" ? "product" : "inputSnapshot"]).toBe(true)
    }
  )

  it("writes only successful sources and keeps identities without redundant stage", () => {
    expect(
      generationIdentity({
        key: "TEXT:ASIN_AUDIT:report:optimize",
        function: "ASIN_AUDIT",
        operation: "optimize",
      })
    ).toEqual({ sourceType: "TEXT", sourceId: "ASIN_AUDIT:report", operation: "optimize" })
    for (const status of ["RUNNING", "QUEUED", "FAILED", "CANCELLED", "BILLED"])
      expect(eligibleGenerationSource("imageGenJob", { status })).toBe(false)
    expect(eligibleGenerationSource("chetaidouTask", { status: "PARTIAL", type: "IDEATION" })).toBe(
      false
    )
    expect(
      eligibleGenerationSource("imageGenJob", { status: "PARTIAL", businessType: "CHETAIDOU" })
    ).toBe(true)
    expect(eligibleGenerationSource("businessAiRun", { status: "COMPLETED", outputText: "" })).toBe(
      false
    )
  })

  it("limits media SQL to one source and exact billing refs; duplicate callbacks replace credits", async () => {
    const { tx, data } = memoryClient({
      generationTask: [image()],
      generatedImage: [
        { id: 1, taskId: 1, source: "platform", deletedAt: null, status: "SUCCESS", url: "u" },
        { id: 2, taskId: 1, source: "platform", deletedAt: null, status: "SUCCESS", url: "v" },
      ],
      usageLog: [
        {
          id: 10,
          userId: 7,
          source: "aicreative.image_generate",
          meta: { taskId: 1 },
          credits: new Prisma.Decimal("1.2345"),
        },
        {
          id: 11,
          userId: 7,
          source: "aicreative.image_generate",
          meta: { taskId: 99 },
          credits: new Prisma.Decimal(900),
        },
      ],
    })
    await syncGenerationSource(tx, "generationTask", 1)
    await syncGenerationSource(tx, "generationTask", 1)
    expect(data.generationRecord).toHaveLength(1)
    expect(data.generationRecord[0].credits.toString()).toBe("1.2345")
    expect(data.generationRecord[0].resultCount).toBe(2)
    expect(data.generationRecord[0].modelDisplayName).toBe("实际模型一")
    expect(tx.usageLog.findMany.mock.calls[0][0].where.AND[1]).toEqual({
      OR: [{ meta: { path: "$.taskId", equals: 1 } }],
    })
    data.aiGatewayModel[0].displayName = "后来改名"
    data.usageLog[0].credits = new Prisma.Decimal(0)
    await syncGenerationSource(tx, "generationTask", 1)
    expect(data.generationRecord[0].modelDisplayName).toBe("实际模型一")
    expect(data.generationRecord[0].credits.toString()).toBe("1.2345")
  })

  it("historical unknown remains null when the immutable snapshot is replayed", async () => {
    const { tx, data } = memoryClient({ generationTask: [image()] })
    await syncGenerationSource(tx, "generationTask", 1)
    expect(data.generationRecord[0].credits).toBeNull()
    data.usageLog.push({
      id: 1,
      userId: 7,
      source: "aicreative.image_generate",
      meta: { taskId: 1 },
      credits: new Prisma.Decimal("0.3"),
    })
    await syncGenerationSource(tx, "generationTask", 1)
    expect(data.generationRecord).toHaveLength(1)
    expect(data.generationRecord[0].credits).toBeNull()
  })

  it("does not project vidflowos or CROP or PRODUCT_SELECTION catalog", async () => {
    const { tx } = memoryClient({
      generationTask: [image({ source: "vidflowos", project: { source: "vidflowos" } })],
    })
    expect(
      await projectGenerationSource(tx, "generationTask", image({ source: "vidflowos" }))
    ).toEqual([])
    expect(
      await projectGenerationSource(tx, "imageGenJob", {
        id: "crop",
        status: "COMPLETED",
        kind: "CROP",
      })
    ).toEqual([])
  })

  it("keeps every ASIN optimization revision separate with only its own exact fee", async () => {
    const root = {
      id: "report",
      userId: 7,
      asin: "B000000001",
      productTitle: "产品",
      clientRequestId: "request",
      createdAt: new Date("2020-01-01"),
      deletedAt: null,
    }
    const snapshot = { recordId: "report", createdAt: root.createdAt, scoreResult: { score: 80 } }
    const revisions = [
      {
        id: 1,
        recordId: "report",
        revision: 1,
        createdAt: occurredAt,
        optimizationResult: { title: "优化一" },
      },
      {
        id: 2,
        recordId: "report",
        revision: 2,
        createdAt: new Date(occurredAt.getTime() + 1000),
        optimizationResult: { title: "优化二" },
      },
    ]
    const log = (id: number, stage: string, amount: string, result: unknown) => ({
      id,
      userId: 7,
      source: "asin.audit",
      requestId: `charge:${id}`,
      createdAt: occurredAt,
      meta: { stage, recordId: "report", model: "model-1", resultHash: hashJson(result) },
      credits: new Prisma.Decimal(amount),
    })
    const { tx, data } = memoryClient({
      asinAuditRecord: [root],
      asinAuditScoreSnapshot: [snapshot],
      asinAuditOptimizationRevision: revisions,
      usageLog: [
        log(1, "score", "2", snapshot.scoreResult),
        log(2, "optimize", "0.3", revisions[0].optimizationResult),
        log(3, "optimize", "0.4", revisions[1].optimizationResult),
      ],
    })
    await syncGenerationSource(tx, "asinAuditRecord", "report")
    expect(data.generationRecord).toHaveLength(3)
    expect(
      data.generationRecord.find(row => row.sourceId.endsWith("revision:1")).credits.toString()
    ).toBe("0.3")
    expect(
      data.generationRecord.find(row => row.sourceId.endsWith("revision:2")).credits.toString()
    ).toBe("0.4")
    await syncGenerationSource(tx, "asinAuditRecord", "report")
    expect(data.generationRecord).toHaveLength(3)
    data.generationRecord.length = 0
    await syncGenerationSource(tx, "asinAuditRecord", "report", {
      from: occurredAt,
      to: new Date(occurredAt.getTime() + 2000),
    })
    expect(data.generationRecord).toHaveLength(2)
    expect(data.generationRecord.every(row => row.operation === "optimize")).toBe(true)
  })

  it("records a second paid optimization with identical body without changing its revision or replaying money", async () => {
    const root = {
      id: "report",
      userId: 7,
      asin: "B000000001",
      productTitle: "产品",
      clientRequestId: "request",
      createdAt: occurredAt,
    }
    const body = { title: "相同优化正文" }
    const revision = {
      id: 9,
      recordId: "report",
      revision: 1,
      createdAt: occurredAt,
      optimizationResult: body,
    }
    const log = (id: number, amount: string, createdAt: Date) => ({
      id,
      userId: 7,
      source: "asin.audit",
      requestId: `charge:${id}`,
      createdAt,
      meta: {
        stage: "optimize",
        recordId: "report",
        revisionId: 9,
        model: "model-1",
        resultHash: hashJson(body),
      },
      credits: new Prisma.Decimal(amount),
    })
    const { tx, data } = memoryClient({
      asinAuditRecord: [root],
      asinAuditOptimizationRevision: [revision],
      usageLog: [log(1, "20", occurredAt)],
    })
    await syncGenerationSource(tx, "asinAuditRecord", "report")
    data.usageLog.push(log(2, "21", new Date(occurredAt.getTime() + 1000)))
    await syncGenerationSource(tx, "asinAuditRecord", "report")
    await syncGenerationSource(tx, "asinAuditRecord", "report")
    expect(data.generationRecord).toHaveLength(2)
    expect(data.generationRecord.map(row => row.credits.toString())).toEqual(["20", "21"])
    expect(data.generationRecord[1].sourceId).toBe("ASIN_AUDIT:report:revision:9:event:2")
    expect(data.asinAuditOptimizationRevision).toHaveLength(1)
  })

  it("records separate RPA successful output batches and excludes callbacks with no successes", async () => {
    const root = {
      id: 5,
      userId: 7,
      mediaType: "IMAGE",
      model: "model-1",
      prompt: "产品",
      status: "SUCCESS",
      createdAt: occurredAt,
      completedAt: occurredAt,
    }
    const outputs = [1, 2].map(id => ({
      id,
      taskId: 5,
      status: "SUCCESS",
      url: `u${id}`,
      order: id,
    }))
    const logs = [1, 2].map(id => ({
      id,
      userId: 7,
      source: "rpa-creation.generate",
      createdAt: occurredAt,
      meta: { taskId: 5, successfulOutputIds: [id] },
      credits: new Prisma.Decimal(id),
    }))
    const { tx, data } = memoryClient({
      rpaCreationTask: [root],
      rpaCreationOutput: outputs,
      usageLog: logs,
    })
    await syncGenerationSource(tx, "rpaCreationTask", 5)
    await syncGenerationSource(tx, "rpaCreationTask", 5)
    expect(data.generationRecord.map(row => row.sourceId)).toEqual(["5:event:1", "5:event:2"])
    expect(data.generationRecord.map(row => row.credits.toString())).toEqual(["1", "2"])
    expect(data.generationRecord.map(row => row.resultCount)).toEqual([1, 1])
    data.rpaCreationOutput.length = 0
    expect(await projectGenerationSource(tx, "rpaCreationTask", root)).toEqual([])
  })

  it("waits for every successful pipeline image settlement, then snapshots once", async () => {
    const children = [1, 2].map(id => ({
      id,
      taskId: 1,
      source: "platform",
      deletedAt: null,
      status: "SUCCESS",
      url: `url${id}`,
      providerJobId: `gateway${id}`,
      deliveryMeta: {},
    }))
    const { tx, data } = memoryClient({
      generationTask: [image({ executionSpec: { provider: "model-1" } })],
      generatedImage: children,
    })
    await syncGenerationSource(tx, "generationTask", 1, { requireSettlement: true })
    expect(data.generationRecord).toHaveLength(0)
    children[0].deliveryMeta = { generationRecordCredits: "0" }
    await syncGenerationSource(tx, "generationTask", 1, { requireSettlement: true })
    expect(data.generationRecord).toHaveLength(0)
    children[1].deliveryMeta = { generationRecordCredits: "1.25" }
    data.usageLog.push({
      id: 1,
      userId: 7,
      source: "aicreative.image_generate",
      meta: { taskId: 1, gatewayTaskId: "gateway2" },
      credits: new Prisma.Decimal("1.25"),
    })
    await syncGenerationSource(tx, "generationTask", 1, { requireSettlement: true })
    expect(data.generationRecord[0].credits.toString()).toBe("1.25")
    data.usageLog[0].credits = new Prisma.Decimal(999)
    await syncGenerationSource(tx, "generationTask", 1, { requireSettlement: true })
    expect(data.generationRecord[0].credits.toString()).toBe("1.25")
  })

  it.each([
    ["0", "0"],
    [null, null],
  ])("distinguishes settled free %s from unknown", async (evidence, expected) => {
    const { tx, data } = memoryClient({
      generationTask: [image({ executionSpec: { provider: "model-1" } })],
      generatedImage: [
        {
          id: 1,
          taskId: 1,
          source: "platform",
          status: "SUCCESS",
          url: "u",
          deletedAt: null,
          deliveryMeta: { generationRecordCredits: evidence },
        },
      ],
    })
    await syncGenerationSource(tx, "generationTask", 1, { requireSettlement: true })
    expect(data.generationRecord).toHaveLength(1)
    expect(data.generationRecord[0].credits?.toString() ?? null).toBe(expected)
  })

  it("uses the completed Chetaidou call ledger including confirmed free calls without duplicating retries", async () => {
    const root = {
      id: "ct",
      rootTaskId: "ct",
      ownerId: 7,
      type: "COMPOSE",
      status: "SUCCEEDED",
      createdAt: occurredAt,
      finishedAt: occurredAt,
    }
    const child = { ...root, id: "ct-retry", rootTaskId: "ct" }
    const { tx, data } = memoryClient({
      chetaidouTask: [root, child],
      chetaidouCall: [
        {
          id: "call-free",
          taskId: "ct",
          rootTaskId: "ct",
          ownerId: 7,
          kind: "TEXT",
          model: "model-1",
          billingStatus: "FREE",
          chargedCredits: null,
          createdAt: occurredAt,
        },
        {
          id: "call-paid",
          taskId: "ct-retry",
          rootTaskId: "ct",
          ownerId: 7,
          kind: "TEXT",
          model: "model-1",
          billingStatus: "SETTLED",
          chargedCredits: new Prisma.Decimal("2.3456"),
          createdAt: occurredAt,
        },
      ],
    })
    await syncGenerationSource(tx, "chetaidouTask", "ct")
    await syncGenerationSource(tx, "chetaidouTask", "ct-retry")
    expect(data.generationRecord).toHaveLength(1)
    expect(data.generationRecord[0].credits.toString()).toBe("2.3456")
    expect(data.generationRecord[0].sourceId).toBe("CHETAIDOU_TEXT:ct")
  })

  it("does not change a successful snapshot when the source is later deleted or edited", async () => {
    const { tx, data } = memoryClient({ generationTask: [image()] })
    await syncGenerationSource(tx, "generationTask", 1)
    const original = { ...data.generationRecord[0] }
    data.generationTask[0].deletedAt = occurredAt
    data.generationTask[0].prompt = "后来编辑"
    await syncGenerationSource(tx, "generationTask", 1)
    expect(data.generationRecord[0]).toEqual(original)
    expect(data.generationRecord[0].deletedAt).toBeNull()
    expect(data.generationRecord[0].resultUrl).toBe("https://example.com/image")
  })
})
