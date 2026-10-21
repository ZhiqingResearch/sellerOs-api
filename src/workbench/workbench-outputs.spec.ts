import { PrismaService } from "../prisma/prisma.service"
import { WorkbenchFeatureKey, workbenchOutputQueries } from "./workbench-outputs"

/** workbench-outputs.ts 中 11 个功能查询的 where 构造与字段映射口径 */
describe("workbenchOutputQueries", () => {
  const since = new Date("2026-09-03T00:00:00.000Z")
  let prisma: Record<string, { count: jest.Mock; findMany: jest.Mock }>

  const queryOf = (key: WorkbenchFeatureKey) => {
    const query = workbenchOutputQueries(prisma as unknown as PrismaService).find(
      q => q.key === key
    )
    if (!query) throw new Error(`未找到功能查询：${key}`)
    return query
  }

  beforeEach(() => {
    prisma = {
      asinEvidenceRecord: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      asinAuditRecord: {
        count: jest.fn().mockResolvedValue(3),
        findMany: jest.fn().mockResolvedValue([]),
      },
      competitorAnalysisRecord: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      selectionAnalysisRecord: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      smartPricingRecord: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      promotionPlanRecord: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      adCleaningTask: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      history: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
      productPublishTask: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      productFactoryRecord: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      generatedImage: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      imageGenItem: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      videoTask: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      usageLog: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      creditTransaction: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
    }
  })

  it("共注册 20 个功能查询", () => {
    expect(workbenchOutputQueries(prisma as unknown as PrismaService)).toHaveLength(20)
  })

  it("ASIN 取证：显式排除软删，标题缺商品名时回落 asin", async () => {
    const query = queryOf(WorkbenchFeatureKey.ASIN_EVIDENCE)
    prisma.asinEvidenceRecord.findMany.mockResolvedValue([
      {
        id: "e1",
        asin: "B0GQB1C381",
        productTitle: null,
        createdAt: new Date("2026-09-09T11:53:00.000Z"),
      },
      {
        id: "e2",
        asin: "B09VLJJPL6",
        productTitle: "便携榨汁杯",
        createdAt: new Date("2026-09-08T08:32:00.000Z"),
      },
    ])

    await query.count(7, since)
    expect(prisma.asinEvidenceRecord.count).toHaveBeenCalledWith({
      where: { userId: 7, deletedAt: null, createdAt: { gte: since } },
    })

    await query.count(7, null)
    expect(prisma.asinEvidenceRecord.count).toHaveBeenLastCalledWith({
      where: { userId: 7, deletedAt: null },
    })

    const items = await query.latest(7, since, 5)
    expect(prisma.asinEvidenceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 7, deletedAt: null, createdAt: { gte: since } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 5,
      })
    )
    expect(items[0]).toMatchObject({
      featureKey: WorkbenchFeatureKey.ASIN_EVIDENCE,
      featureLabel: "ASIN 取证",
      recordId: "e1",
      title: "B0GQB1C381",
    })
    expect(items[1].title).toBe("便携榨汁杯")
  })

  it("ASIN 自审：周期时间条件 + asin 作标题", async () => {
    const query = queryOf(WorkbenchFeatureKey.ASIN_AUDIT)
    prisma.asinAuditRecord.findMany.mockResolvedValue([
      { id: "r1", asin: "B0GQB1C381", createdAt: new Date("2026-09-09T11:53:00.000Z") },
    ])

    await query.count(7, since)
    expect(prisma.asinAuditRecord.count).toHaveBeenCalledWith({
      where: { userId: 7, createdAt: { gte: since } },
    })

    await query.count(7, null)
    expect(prisma.asinAuditRecord.count).toHaveBeenLastCalledWith({ where: { userId: 7 } })

    const items = await query.latest(7, since, 5)
    expect(prisma.asinAuditRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 7, createdAt: { gte: since } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 5,
      })
    )
    expect(items[0]).toMatchObject({
      featureKey: WorkbenchFeatureKey.ASIN_AUDIT,
      featureLabel: "ASIN 自审",
      recordId: "r1",
      title: "B0GQB1C381",
    })
  })

  it("竞品分析：空标题归一为 null", async () => {
    const query = queryOf(WorkbenchFeatureKey.COMPETITOR)
    prisma.competitorAnalysisRecord.findMany.mockResolvedValue([
      { id: "r1", title: "", createdAt: new Date("2026-09-08T00:00:00.000Z") },
      { id: "r2", title: "对标分析", createdAt: new Date("2026-09-07T00:00:00.000Z") },
    ])

    const items = await query.latest(7, null, 10)
    expect(items[0].title).toBeNull()
    expect(items[1].title).toBe("对标分析")
  })

  it("选品：仅统计 COMPLETED，标题取主类目名", async () => {
    const query = queryOf(WorkbenchFeatureKey.SELECTION)
    prisma.selectionAnalysisRecord.findMany.mockResolvedValue([
      {
        id: "r1",
        primaryCategoryName: "消费电子",
        createdAt: new Date("2026-09-06T00:00:00.000Z"),
      },
    ])

    await query.count(7, since)
    expect(prisma.selectionAnalysisRecord.count).toHaveBeenCalledWith({
      where: { userId: 7, status: "COMPLETED", createdAt: { gte: since } },
    })

    const items = await query.latest(7, null, 10)
    expect(items[0].title).toBe("消费电子")
  })

  it("智能定价 / 新品推广：productName 作标题", async () => {
    const pricing = queryOf(WorkbenchFeatureKey.PRICING)
    prisma.smartPricingRecord.findMany.mockResolvedValue([
      { id: "p1", productName: "便携榨汁杯", createdAt: new Date("2026-09-07T00:00:00.000Z") },
    ])
    const pricingItems = await pricing.latest(7, null, 10)
    expect(pricingItems[0].featureKey).toBe(WorkbenchFeatureKey.PRICING)
    expect(pricingItems[0].title).toBe("便携榨汁杯")

    const launch = queryOf(WorkbenchFeatureKey.LAUNCH_PLAN)
    prisma.promotionPlanRecord.findMany.mockResolvedValue([
      { id: "l1", productName: "无线蓝牙耳机", createdAt: new Date("2026-09-08T00:00:00.000Z") },
    ])
    const launchItems = await launch.latest(7, null, 10)
    expect(launchItems[0].featureKey).toBe(WorkbenchFeatureKey.LAUNCH_PLAN)
    expect(launchItems[0].title).toBe("无线蓝牙耳机")
  })

  it("广告优化：仅统计 SUCCESS，recordId 用对外 taskId", async () => {
    const query = queryOf(WorkbenchFeatureKey.AD_OPT)
    prisma.adCleaningTask.findMany.mockResolvedValue([
      {
        id: 1,
        taskId: "t-1",
        originalFilename: "搜索词报告.xlsx",
        createdAt: new Date("2026-09-08T00:00:00.000Z"),
      },
    ])

    await query.count(7, since)
    expect(prisma.adCleaningTask.count).toHaveBeenCalledWith({
      where: { userId: 7, status: "SUCCESS", createdAt: { gte: since } },
    })

    const items = await query.latest(7, null, 10)
    expect(items[0]).toMatchObject({ recordId: "t-1", title: "搜索词报告.xlsx" })
  })

  it("Listing 生成：只取 LISTING_GENERATION 历史", async () => {
    const query = queryOf(WorkbenchFeatureKey.LISTING)
    prisma.history.findMany.mockResolvedValue([
      { id: 9, title: "Listing · 无线蓝牙耳机", createdAt: new Date("2026-09-05T00:00:00.000Z") },
    ])

    await query.count(7, null)
    expect(prisma.history.count).toHaveBeenCalledWith({
      where: { userId: 7, type: "LISTING_GENERATION" },
    })

    const items = await query.latest(7, null, 10)
    expect(items[0].recordId).toBe("9")
    expect(items[0].featureKey).toBe(WorkbenchFeatureKey.LISTING)
  })

  it("Listing 打分：只取 LISTING_SCORING 历史，与生成分开统计", async () => {
    const query = queryOf(WorkbenchFeatureKey.LISTING_SCORE)
    prisma.history.findMany.mockResolvedValue([
      { id: 12, title: "Listing 评分 · 瑜伽垫", createdAt: new Date("2026-09-06T00:00:00.000Z") },
    ])

    await query.count(7, since)
    expect(prisma.history.count).toHaveBeenCalledWith({
      where: { userId: 7, type: "LISTING_SCORING", createdAt: { gte: since } },
    })

    const items = await query.latest(7, null, 10)
    expect(items[0]).toMatchObject({
      featureKey: WorkbenchFeatureKey.LISTING_SCORE,
      featureLabel: "Listing 打分",
      recordId: "12",
      title: "Listing 评分 · 瑜伽垫",
    })
  })

  it("上架：只统计已提交发布（publishSubmittedAt 非空），recordId 用对外 taskId", async () => {
    const query = queryOf(WorkbenchFeatureKey.PUBLISH)
    prisma.productPublishTask.findMany.mockResolvedValue([
      {
        id: 3,
        taskId: "task-3",
        productName: "瑜伽垫",
        createdAt: new Date("2026-09-04T00:00:00.000Z"),
      },
    ])

    await query.count(7, since)
    expect(prisma.productPublishTask.count).toHaveBeenCalledWith({
      where: { userId: 7, publishSubmittedAt: { not: null }, createdAt: { gte: since } },
    })

    const items = await query.latest(7, null, 10)
    expect(items[0]).toMatchObject({ recordId: "task-3", title: "瑜伽垫" })
  })

  it("商品链接：制作记录全量计入，数字 id 转字符串 + productName 作标题", async () => {
    const query = queryOf(WorkbenchFeatureKey.PRODUCT_FACTORY)
    prisma.productFactoryRecord.findMany.mockResolvedValue([
      {
        id: 5,
        productName: "竞品复刻 · B0D9LMV4MQ",
        createdAt: new Date("2026-09-08T00:00:00.000Z"),
      },
    ])

    await query.count(7, since)
    expect(prisma.productFactoryRecord.count).toHaveBeenCalledWith({
      where: { userId: 7, createdAt: { gte: since } },
    })

    await query.count(7, null)
    expect(prisma.productFactoryRecord.count).toHaveBeenLastCalledWith({ where: { userId: 7 } })

    const items = await query.latest(7, since, 5)
    expect(prisma.productFactoryRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 7, createdAt: { gte: since } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 5,
      })
    )
    expect(items[0]).toMatchObject({
      featureKey: WorkbenchFeatureKey.PRODUCT_FACTORY,
      featureLabel: "商品链接",
      recordId: "5",
      title: "竞品复刻 · B0D9LMV4MQ",
    })
  })

  it("图片生成：STANDARD 成功图 + ImageGenJob 成功 item 两路相加，标题取 prompt 截断", async () => {
    const query = queryOf(WorkbenchFeatureKey.IMAGE_GENERATION)
    prisma.generatedImage.count.mockResolvedValue(3)
    prisma.imageGenItem.count.mockResolvedValue(4)
    prisma.generatedImage.findMany.mockResolvedValue([
      {
        id: 11,
        createdAt: new Date("2026-09-09T10:00:00.000Z"),
        task: { prompt: "白底图 一只无线耳机" },
      },
    ])
    prisma.imageGenItem.findMany.mockResolvedValue([
      {
        id: 22,
        createdAt: new Date("2026-09-09T11:00:00.000Z"),
        job: { prompt: null },
      },
    ])

    await expect(query.count(7, since)).resolves.toBe(7)
    expect(prisma.generatedImage.count).toHaveBeenCalledWith({
      where: {
        status: "SUCCESS",
        source: "platform",
        task: {
          userId: 7,
          generationMode: "STANDARD",
          source: "platform",
          project: { source: "platform" },
        },
        createdAt: { gte: since },
      },
    })
    expect(prisma.imageGenItem.count).toHaveBeenCalledWith({
      where: {
        status: "SUCCEEDED",
        job: { userId: 7, source: "platform" },
        createdAt: { gte: since },
      },
    })

    const items = await query.latest(7, since, 5)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      featureKey: WorkbenchFeatureKey.IMAGE_GENERATION,
      recordId: "22",
      title: null,
    })
    expect(items[1]).toMatchObject({ recordId: "11", title: "白底图 一只无线耳机" })
  })

  it("视频生成：仅 NORMAL/REFERENCE 且排除带货，成功条数", async () => {
    const query = queryOf(WorkbenchFeatureKey.VIDEO_GENERATION)

    await query.count(7, since)
    expect(prisma.videoTask.count).toHaveBeenCalledWith({
      where: {
        userId: 7,
        source: "platform",
        project: { source: "platform" },
        mode: { in: ["NORMAL", "REFERENCE"] },
        status: "SUCCESS",
        salesWorkflowId: null,
        createdAt: { gte: since },
      },
    })
  })

  it.each([WorkbenchFeatureKey.VIDEO_GENERATION, WorkbenchFeatureKey.MOTION_REPLICA])(
    "%s 最近产出与数量均过滤 VidFlow 来源",
    async key => {
      const query = queryOf(key)
      await query.count(7, since)
      await query.latest(7, since, 5)
      const visible = { source: "platform", project: { source: "platform" } }
      expect(prisma.videoTask.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining(visible) })
      )
      expect(prisma.videoTask.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining(visible) })
      )
    }
  )

  it("三件套：UsageLog(llm.generic) 按 requestId 两代前缀过滤（后端冒号 / 前端连字符）", async () => {
    for (const [key, prefixes] of [
      [WorkbenchFeatureKey.ENHANCE_PROMPT, ["toolbox:enhance:", "toolbox-一键润色-"]],
      [WorkbenchFeatureKey.IMAGE_INFERENCE, ["toolbox:image-inference:", "toolbox-由图推理-"]],
      [WorkbenchFeatureKey.TRANSLATE_PROMPT, ["toolbox:translate:", "toolbox-中英互译-"]],
    ] as const) {
      const query = queryOf(key)
      await query.count(7, since)
      expect(prisma.usageLog.count).toHaveBeenLastCalledWith({
        where: {
          userId: 7,
          source: "llm.generic",
          OR: prefixes.map(prefix => ({ requestId: { startsWith: prefix } })),
          createdAt: { gte: since },
        },
      })

      prisma.usageLog.findMany.mockResolvedValue([
        { id: 901, createdAt: new Date("2026-09-09T09:00:00.000Z") },
      ])
      const items = await query.latest(7, null, 5)
      expect(items[0]).toMatchObject({ recordId: "901", title: null })
    }
  })

  it("灵感雷达：按扣费流水 source 计数，标题取 meta.subscriptionName", async () => {
    const query = queryOf(WorkbenchFeatureKey.INSPIRATION_RADAR)
    prisma.creditTransaction.findMany.mockResolvedValue([
      {
        id: 2974,
        meta: { subscriptionName: "春季花园", resultCount: 20 },
        createdAt: new Date("2026-09-18T08:41:10.000Z"),
      },
      { id: 2975, meta: null, createdAt: new Date("2026-09-17T08:41:10.000Z") },
    ])

    await query.count(7, since)
    expect(prisma.creditTransaction.count).toHaveBeenCalledWith({
      where: { userId: 7, source: "inspiration_radar.refresh", createdAt: { gte: since } },
    })

    const items = await query.latest(7, null, 5)
    expect(items[0]).toMatchObject({
      featureLabel: "灵感雷达",
      recordId: "2974",
      title: "春季花园",
    })
    expect(items[1].title).toBeNull()
  })

  it("AI 拆图：仅 AI_SPLIT 任务的成功图（与图片生成互斥不重复）", async () => {
    const query = queryOf(WorkbenchFeatureKey.AI_SPLIT)

    await query.count(7, since)
    expect(prisma.generatedImage.count).toHaveBeenCalledWith({
      where: {
        status: "SUCCESS",
        source: "platform",
        task: {
          userId: 7,
          generationMode: "AI_SPLIT",
          source: "platform",
          project: { source: "platform" },
        },
        createdAt: { gte: since },
      },
    })
  })

  it("视频分析：UsageLog(video.analysis) 计数，标题取 meta.videoUrl 截断", async () => {
    const query = queryOf(WorkbenchFeatureKey.VIDEO_ANALYSIS)
    prisma.usageLog.findMany.mockResolvedValue([
      {
        id: 801,
        meta: { videoUrl: "https://cdn.example.com/video-analysis/sources/abc.mp4" },
        createdAt: new Date("2026-09-19T08:00:00.000Z"),
      },
    ])

    await query.count(7, since)
    expect(prisma.usageLog.count).toHaveBeenCalledWith({
      where: { userId: 7, source: "video.analysis", createdAt: { gte: since } },
    })

    const items = await query.latest(7, null, 5)
    expect(items[0]).toMatchObject({
      featureLabel: "视频分析",
      title: "https://cdn.example.com/video-analysis/sources/abc.mp4",
    })
  })

  it("动作复刻：仅 MOTION_CONTROL（含 legacy 小写）成功任务", async () => {
    const query = queryOf(WorkbenchFeatureKey.MOTION_REPLICA)

    await query.count(7, since)
    expect(prisma.videoTask.count).toHaveBeenCalledWith({
      where: {
        userId: 7,
        source: "platform",
        project: { source: "platform" },
        mode: { in: ["MOTION_CONTROL", "motion_control"] },
        status: "SUCCESS",
        createdAt: { gte: since },
      },
    })
  })
})
