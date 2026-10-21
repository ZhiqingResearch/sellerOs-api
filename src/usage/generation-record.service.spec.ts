import { Decimal } from "@prisma/client/runtime/library"
import { GenerationRecordService } from "./generation-record.service"

const user = {
  id: 7,
  username: "测试用户",
  phone: "13800000000",
  orgs: [{ org: { name: "内容组" } }],
  roles: [{ role: { name: "运营", color: "#123456" } }],
}

function createMocks() {
  const prisma = {
    usageLog: { findMany: jest.fn().mockResolvedValue([]) },
    creditTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    aiGatewayModel: { findMany: jest.fn().mockResolvedValue([]) },
  }
  const audit = {
    generationTask: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    videoTask: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    storyboardVideo: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    beautyTask: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    inspirationSubscription: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rpaCreationTask: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    imageGenJob: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
  }
  const service = new GenerationRecordService(prisma as never, audit as never)
  return { service, prisma, audit }
}

describe("GenerationRecordService 模型目录展示名", () => {
  it("模型选项统一使用目录名称，保留原始筛选值，同 publicId 取首个有效名称", async () => {
    const { service, prisma, audit } = createMocks()
    audit.generationTask.groupBy.mockResolvedValue([{ model: "image-model" }])
    audit.imageGenJob.groupBy.mockResolvedValue([{ model: "job-model" }])
    audit.videoTask.groupBy.mockResolvedValue([
      { model: "video-model", modelName: "历史名称一" },
      { model: "video-model", modelName: "历史名称二" },
    ])
    audit.beautyTask.groupBy.mockResolvedValue([{ model: "beauty-model" }])
    audit.rpaCreationTask.groupBy.mockResolvedValue([{ model: "rpa-model", mediaType: "VIDEO" }])
    audit.storyboardVideo.count.mockResolvedValue(1)
    const models = [
      "image-model",
      "job-model",
      "video-model",
      "beauty-model",
      "rpa-model",
      "storyboard-model",
    ]
    prisma.aiGatewayModel.findMany.mockImplementation(
      ({ where }: { where: { category?: string } }) =>
        Promise.resolve(
          where.category
            ? [{ publicId: "storyboard-model" }]
            : [
                { publicId: "video-model", displayName: " " },
                ...models.map(publicId => ({ publicId, displayName: `目录-${publicId}` })),
                { publicId: "video-model", displayName: "后续类别名称" },
              ]
        )
    )

    const options = await service.getModelOptions({})

    expect(options).toHaveLength(models.length)
    for (const model of models) {
      expect(options).toContainEqual({
        value: model,
        label: `目录-${model}`,
        function: ["image-model", "job-model"].includes(model) ? "IMAGE" : "VIDEO",
      })
    }
    expect(prisma.aiGatewayModel.findMany).toHaveBeenLastCalledWith({
      where: { publicId: { in: expect.arrayContaining(models) } },
      select: { publicId: true, displayName: true },
      orderBy: { id: "asc" },
    })
    expect(options).toEqual(
      [...options].sort(
        (a, b) =>
          a.function.localeCompare(b.function) ||
          a.label.localeCompare(b.label, "zh-CN") ||
          a.value.localeCompare(b.value)
      )
    )
  })

  it("模型选项未命中目录或名称为空时保留原展示名", async () => {
    const { service, prisma, audit } = createMocks()
    audit.generationTask.groupBy.mockResolvedValue([{ model: "NANO_BANANA" }])
    audit.videoTask.groupBy.mockResolvedValue([
      { model: "legacy-video", modelName: "历史视频名称" },
    ])
    audit.rpaCreationTask.groupBy.mockResolvedValue([
      { model: "NANO_BANANA_2", mediaType: "IMAGE" },
    ])
    prisma.aiGatewayModel.findMany.mockResolvedValue([
      { publicId: "NANO_BANANA", displayName: "" },
      { publicId: "legacy-video", displayName: "   " },
    ])

    expect(await service.getModelOptions({})).toEqual(
      expect.arrayContaining([
        { value: "NANO_BANANA", label: "Nano Banana", function: "IMAGE" },
        { value: "NANO_BANANA_2", label: "Nano Banana 2", function: "IMAGE" },
        { value: "legacy-video", label: "历史视频名称", function: "VIDEO" },
      ])
    )
  })

  it.each(["目录名称", "", "   ", null])(
    "所有生成记录按目录覆盖名称或保留回退值（%s）",
    async displayName => {
      const { service, prisma, audit } = createMocks()
      const createdAt = new Date("2026-10-14T01:00:00.000Z")
      const base = {
        id: 1,
        model: "NANO_BANANA",
        prompt: "商品图",
        status: "SUCCESS",
        createdAt,
        updatedAt: createdAt,
        completedAt: createdAt,
        deletedAt: null,
        user,
        userId: user.id,
      }
      audit.generationTask.count.mockResolvedValue(1)
      audit.generationTask.findMany.mockImplementation(
        ({ where }: { where: { generationMode?: string } }) =>
          Promise.resolve([
            {
              ...base,
              groupId: "split-1",
              directionIndex: 0,
              generatedImages: [],
              ...(where.generationMode === "STANDARD" ? {} : { id: 2 }),
            },
          ])
      )
      audit.imageGenJob.count.mockResolvedValue(2)
      audit.imageGenJob.findMany.mockResolvedValue([
        { ...base, id: "job-1", kind: "TEXT_TO_IMAGE", businessType: "DEFAULT", items: [] },
        { ...base, id: "job-2", kind: "TEXT_TO_IMAGE", businessType: "CHETAIDOU", items: [] },
      ])
      audit.videoTask.count.mockResolvedValue(1)
      audit.videoTask.findMany.mockResolvedValue([{ ...base, modelName: "历史视频名称" }])
      audit.beautyTask.count.mockResolvedValue(1)
      audit.beautyTask.findMany.mockResolvedValue([base])
      audit.storyboardVideo.count.mockResolvedValue(1)
      audit.storyboardVideo.findMany.mockResolvedValue([
        {
          ...base,
          generationParams: { model: base.model },
          storyboard: { production: { project: { customer: { user } } } },
        },
      ])
      audit.rpaCreationTask.count.mockResolvedValue(1)
      audit.rpaCreationTask.findMany.mockResolvedValue([
        { ...base, mediaType: "IMAGE", quantity: 1, outputs: [] },
      ])
      audit.inspirationSubscription.count.mockResolvedValue(1)
      audit.inspirationSubscription.findMany.mockResolvedValue([
        {
          ...base,
          name: "灵感",
          keywords: [],
          platforms: ["PINTEREST"],
          lastRefreshedAt: createdAt,
          items: [],
          _count: { items: 0 },
        },
      ])
      prisma.aiGatewayModel.findMany.mockResolvedValue(
        displayName === null
          ? []
          : [
              { publicId: base.model, displayName },
              { publicId: "APIFY", displayName: "不应覆盖平台名" },
            ]
      )

      const result = await service.list({ page: 1, pageSize: 20 })
      const fallbacks: Record<string, string> = {
        "IMAGE:1": "Nano Banana",
        "AI_SPLIT:split-1": "Nano Banana",
        "IMAGEGEN:job-1": "Nano Banana",
        "IMAGEGEN:job-2": "Nano Banana",
        "VIDEO:1": "历史视频名称",
        "BEAUTY_VIDEO:1": base.model,
        "STORYBOARD_VIDEO:1": base.model,
        "RPA_IMAGE:1": base.model,
        "INSPIRATION_RADAR:1": "Pinterest",
      }
      expect(result.items).toHaveLength(Object.keys(fallbacks).length)
      for (const item of result.items) {
        expect(item.modelLabel).toBe(
          item.function === "INSPIRATION_RADAR"
            ? "Pinterest"
            : displayName?.trim()
              ? displayName
              : fallbacks[item.key]
        )
        expect(item.model).toBe(item.function === "INSPIRATION_RADAR" ? "APIFY" : base.model)
      }
      expect(prisma.aiGatewayModel.findMany).toHaveBeenCalledTimes(1)
      expect(prisma.aiGatewayModel.findMany).toHaveBeenCalledWith({
        where: { publicId: { in: [base.model] } },
        select: { publicId: true, displayName: true },
        orderBy: { id: "asc" },
      })
    }
  )

  it("列表只查询当前页模型，仍按原始模型 ID 筛选", async () => {
    const { service, prisma, audit } = createMocks()
    const createdAt = new Date("2026-10-14T01:00:00.000Z")
    audit.videoTask.count.mockResolvedValue(2)
    audit.videoTask.findMany.mockResolvedValue(
      ["page-model", "off-page-model"].map((model, id) => ({
        id,
        model,
        modelName: "旧名称",
        createdAt,
        prompt: "视频",
        status: "SUCCESS",
        deletedAt: null,
        user,
        userId: user.id,
      }))
    )
    prisma.aiGatewayModel.findMany.mockResolvedValue([
      { publicId: "page-model", displayName: "新名称" },
    ])

    const result = await service.list({
      page: 1,
      pageSize: 1,
      function: "VIDEO",
      model: "page-model",
    })

    expect(result.items[0]).toMatchObject({ model: "page-model", modelLabel: "新名称" })
    expect(audit.videoTask.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ model: "page-model" }) })
    )
    expect(prisma.aiGatewayModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publicId: { in: ["page-model"] } } })
    )
  })
})

describe("GenerationRecordService RPA 生成记录", () => {
  it("把 RPA 图片和视频合并进列表，并累加首次回调与重试的实际扣分", async () => {
    const { service, prisma, audit } = createMocks()
    const imageCreatedAt = new Date("2026-08-18T01:00:00.000Z")
    const videoCreatedAt = new Date("2026-08-18T02:00:00.000Z")
    const imageTask = {
      id: 11,
      prompt: "生成商品主图",
      model: "NANO_BANANA_2",
      mediaType: "IMAGE",
      quantity: 2,
      status: "SUCCESS",
      createdAt: imageCreatedAt,
      updatedAt: new Date("2026-08-18T01:02:00.000Z"),
      completedAt: new Date("2026-08-18T01:02:00.000Z"),
      deletedAt: null,
      user,
      outputs: [
        { status: "SUCCESS", url: "https://cdn.example.com/image-1.png" },
        { status: "SUCCESS", url: "https://cdn.example.com/image-2.png" },
      ],
    }
    const videoTask = {
      id: 12,
      prompt: "生成产品视频",
      model: "VEO_3_1_FAST",
      mediaType: "VIDEO",
      quantity: 2,
      status: "SUCCESS",
      createdAt: videoCreatedAt,
      updatedAt: new Date("2026-08-18T02:10:00.000Z"),
      completedAt: new Date("2026-08-18T02:10:00.000Z"),
      deletedAt: null,
      user,
      outputs: [
        { status: "SUCCESS", url: "https://cdn.example.com/video-1.mp4" },
        { status: "SUCCESS", url: "https://cdn.example.com/video-2.mp4" },
      ],
    }
    audit.rpaCreationTask.count.mockResolvedValue(2)
    audit.rpaCreationTask.findMany.mockImplementation((args: { select?: { userId?: boolean } }) =>
      Promise.resolve(
        args.select?.userId
          ? [
              {
                id: imageTask.id,
                userId: user.id,
                createdAt: imageTask.createdAt,
                updatedAt: imageTask.updatedAt,
                completedAt: imageTask.completedAt,
              },
              {
                id: videoTask.id,
                userId: user.id,
                createdAt: videoTask.createdAt,
                updatedAt: videoTask.updatedAt,
                completedAt: videoTask.completedAt,
              },
            ]
          : [videoTask, imageTask]
      )
    )
    prisma.usageLog.findMany.mockResolvedValue([
      { credits: new Decimal("2"), meta: { taskId: 11 } },
      { credits: new Decimal("9.6"), meta: { taskId: 12 } },
      { credits: new Decimal("9.6"), meta: { taskId: 12 } },
    ])

    const result = await service.list({ page: 1, pageSize: 20 })

    expect(result.total).toBe(2)
    expect(result.totalPages).toBe(1)
    expect(result.summary.totalCredits).toBe("21.2")
    expect(result.items).toEqual([
      expect.objectContaining({
        key: "RPA_VIDEO:12",
        function: "VIDEO",
        modelLabel: "Veo 3.1 - Fast",
        credits: "19.2",
        resultUrl: "https://cdn.example.com/video-1.mp4",
        resultCount: 2,
        resultLabel: "成功 2/2 条",
      }),
      expect.objectContaining({
        key: "RPA_IMAGE:11",
        function: "IMAGE",
        modelLabel: "Nano Banana 2",
        credits: "2",
        resultUrl: "https://cdn.example.com/image-1.png",
        resultCount: 2,
        resultLabel: "成功 2/2 张",
      }),
    ])
    const usageCall = prisma.usageLog.findMany.mock.calls[0] as [
      { where: { source: string }; select: { credits: boolean; meta: boolean } },
    ]
    expect(usageCall[0].where.source).toBe("rpa-creation.generate")
    expect(usageCall[0].select).toEqual({ credits: true, meta: true })
  })

  it("分镜/美妆并入 VIDEO 生成记录，积分反查按 taskType 区分撞号任务", async () => {
    const { service, prisma, audit } = createMocks()
    const createdAt = new Date("2026-09-01T03:00:00.000Z")
    // 分镜与 VideoTask 故意同 id=301：video-project 前缀下靠 meta.taskType 鉴别
    audit.videoTask.count.mockResolvedValue(1)
    audit.videoTask.findMany.mockResolvedValue([
      {
        id: 301,
        prompt: "通用视频",
        model: "sourcing-veo-fast-i2v",
        modelName: "Veo 3.1 Fast 图生/首尾帧",
        status: "SUCCESS",
        resultUrl: "https://cdn.example.com/video.mp4",
        createdAt,
        deletedAt: null,
        user,
      },
    ])
    audit.storyboardVideo.count.mockResolvedValue(1)
    audit.storyboardVideo.findMany.mockResolvedValue([
      {
        id: 301,
        status: "SUCCESS",
        url: "https://cdn.example.com/storyboard.mp4",
        generationParams: {
          model: "sourcing-storyboard-veo-lite",
          prompt: "镜头固定，薄雾缓慢移动",
        },
        createdAt,
        deletedAt: null,
        storyboard: {
          production: { project: { customer: { userId: user.id, user } } },
        },
      },
    ])
    audit.beautyTask.count.mockResolvedValue(1)
    audit.beautyTask.findMany.mockResolvedValue([
      {
        id: 401,
        prompt: "素颜上底妆卡点视频",
        model: "sourcing-beauty-seedance-mini",
        status: "SUCCESS",
        resultUrl: "https://cdn.example.com/beauty.mp4",
        createdAt,
        deletedAt: null,
        userId: user.id,
        user,
      },
    ])
    prisma.aiGatewayModel.findMany.mockResolvedValue([
      { publicId: "sourcing-storyboard-veo-lite", displayName: "客户分镜 Veo 3.1 Lite" },
      { publicId: "sourcing-beauty-seedance-mini", displayName: "美妆专线 Seedance 2.0 Mini" },
    ])
    // 按 where 分流，贴近真实 DB 过滤：video 调用只见 video-project 前缀行、
    // 分镜调用（OR 条件）见 video-project + 旧 source 行、美妆调用只见 beauty-workflow 行
    prisma.usageLog.findMany.mockImplementation((args: { where?: Record<string, unknown> }) => {
      const where = JSON.stringify(args.where ?? {})
      if (where.includes("beauty-workflow")) {
        return Promise.resolve([
          { source: "beauty-workflow.generate", credits: new Decimal("6"), meta: { taskId: 401 } },
        ])
      }
      if (where.includes("OR")) {
        return Promise.resolve([
          {
            source: "video-project.generate",
            credits: new Decimal("2"),
            meta: { taskId: 301, taskType: "storyboard-video" },
          },
          {
            source: "customer.storyboard-video.generate",
            credits: new Decimal("3"),
            meta: { taskId: 301 },
          },
        ])
      }
      if (where.includes("video-project")) {
        return Promise.resolve([
          { source: "video-project.generate", credits: new Decimal("99"), meta: { taskId: 301 } },
          {
            source: "video-project.generate",
            credits: new Decimal("2"),
            meta: { taskId: 301, taskType: "storyboard-video" },
          },
        ])
      }
      return Promise.resolve([])
    })

    const result = await service.list({ page: 1, pageSize: 20 })

    expect(result.total).toBe(3)
    const byKey = new Map(result.items.map(item => [item.key, item]))
    expect(byKey.get("VIDEO:301")).toMatchObject({
      credits: "99", // taskType=storyboard-video 的 2 积分被排除，不串到撞号的 VideoTask 上
      modelLabel: "Veo 3.1 Fast 图生/首尾帧",
    })
    expect(byKey.get("STORYBOARD_VIDEO:301")).toMatchObject({
      credits: "5", // 2（taskType 鉴别的新流水）+ 3（旧 source 兼容）
      modelLabel: "客户分镜 Veo 3.1 Lite",
      prompt: "镜头固定，薄雾缓慢移动",
      function: "VIDEO",
    })
    expect(byKey.get("BEAUTY_VIDEO:401")).toMatchObject({
      credits: "6",
      modelLabel: "美妆专线 Seedance 2.0 Mini",
      function: "VIDEO",
    })
    expect(result.summary.totalCredits).toBe("110") // 99 + 5 + 6
  })

  it("IMAGE 筛选只查询 RPA 图片，并透传模型、关键词、组织、角色和日期条件", async () => {
    const { service, audit } = createMocks()

    await service.list({
      page: 1,
      pageSize: 10,
      function: "IMAGE",
      model: "NANO_BANANA_2",
      keyword: "商品",
      orgId: 3,
      roleId: 5,
      dateFrom: "2026-08-01",
      dateTo: "2026-08-18",
    })

    expect(audit.videoTask.count).not.toHaveBeenCalled()
    expect(audit.inspirationSubscription.count).not.toHaveBeenCalled()
    const countCall = audit.rpaCreationTask.count.mock.calls[0] as [
      {
        where: {
          mediaType: { in: string[] }
          model: string
          createdAt: { gte: Date; lt: Date }
          user: {
            orgs: { some: { orgId: number } }
            roles: { some: { roleId: number } }
          }
          OR: unknown[]
        }
      },
    ]
    expect(countCall[0].where).toMatchObject({
      mediaType: { in: ["IMAGE"] },
      model: "NANO_BANANA_2",
      createdAt: {
        gte: new Date("2026-08-01"),
        lt: new Date("2026-08-19"),
      },
      user: {
        orgs: { some: { orgId: 3 } },
        roles: { some: { roleId: 5 } },
      },
    })
    expect(countCall[0].where.OR).toHaveLength(3)
  })

  it("模型选项包含 RPA 模型并归入现有 IMAGE/VIDEO 分类", async () => {
    const { service, audit } = createMocks()
    audit.rpaCreationTask.groupBy.mockResolvedValue([
      { model: "NANO_BANANA_2", mediaType: "IMAGE" },
      { model: "VEO_3_1_FAST", mediaType: "VIDEO" },
    ])

    const result = await service.getModelOptions({})

    expect(result).toEqual([
      { value: "NANO_BANANA_2", label: "Nano Banana 2", function: "IMAGE" },
      { value: "VEO_3_1_FAST", label: "Veo 3.1 - Fast", function: "VIDEO" },
    ])
    expect(audit.rpaCreationTask.groupBy).toHaveBeenCalledWith({
      by: ["model", "mediaType"],
      where: { mediaType: { in: ["IMAGE", "VIDEO"] } },
    })
  })

  it("AI 拆图按任务组聚合成一行并入 IMAGE，积分含工作流阶段 + 终态生图 + 重试流水", async () => {
    const { service, prisma, audit } = createMocks()
    const startedAt = new Date("2026-09-04T07:00:00.000Z")
    // 同组 3 任务：方向0 首跑失败 + 重试成功，方向1 成功（2 张图）→ 席位 3/3 成功、2 个方向
    const splitTasks = [
      {
        id: 100,
        groupId: "g1",
        directionIndex: 0,
        status: "FAILED",
        prompt: "方向0首次提示词",
        model: "ZQ-Image-1",
        createdAt: startedAt,
        deletedAt: null,
        user,
        generatedImages: [{ url: null, status: "FAILED", adopted: false, order: 0 }],
      },
      {
        id: 101,
        groupId: "g1",
        directionIndex: 1,
        status: "SUCCESS",
        prompt: "方向1提示词",
        model: "ZQ-Image-1",
        createdAt: new Date("2026-09-04T07:00:30.000Z"),
        deletedAt: null,
        user,
        generatedImages: [
          { url: "https://cdn.example.com/d1-0.png", status: "SUCCESS", adopted: false, order: 0 },
          { url: "https://cdn.example.com/d1-1.png", status: "SUCCESS", adopted: false, order: 1 },
        ],
      },
      {
        id: 103,
        groupId: "g1",
        directionIndex: 0,
        status: "SUCCESS",
        prompt: "方向0重试提示词",
        model: "ZQ-Image-1",
        createdAt: new Date("2026-09-04T07:05:00.000Z"),
        deletedAt: null,
        user,
        generatedImages: [
          {
            url: "https://cdn.example.com/d0-retry.png",
            status: "SUCCESS",
            adopted: false,
            order: 0,
          },
        ],
      },
    ]
    audit.generationTask.findMany.mockImplementation(
      (args: { where?: { generationMode?: string } }) =>
        Promise.resolve(args.where?.generationMode === "AI_SPLIT" ? splitTasks : [])
    )
    // 阶段费盖 groupId、终态费只盖 taskId（验证兜底匹配）、另组的流水不得串入
    prisma.usageLog.findMany.mockImplementation((args: { where?: Record<string, unknown> }) => {
      const where = JSON.stringify(args.where ?? {})
      if (!where.includes("aicreative.ai_split")) return Promise.resolve([])
      return Promise.resolve([
        {
          source: "aicreative.ai_split",
          credits: new Decimal("15"),
          meta: { taskId: 100, groupId: "g1", stage: "WORKFLOW_1" },
        },
        {
          source: "aicreative.ai_split",
          credits: new Decimal("9"),
          meta: { taskId: 100, groupId: "g1", stage: "WORKFLOW_2" },
        },
        {
          source: "aicreative.image_generate.ai_split",
          credits: new Decimal("8"),
          meta: { taskId: 101 },
        },
        {
          source: "aicreative.image_generate.ai_split",
          credits: new Decimal("8"),
          meta: { taskId: 103 },
        },
        {
          source: "aicreative.ai_split",
          credits: new Decimal("99"),
          meta: { taskId: 999, groupId: "g-other" },
        },
      ])
    })

    const result = await service.list({ page: 1, pageSize: 20 })

    expect(result.total).toBe(1) // 组数而非任务数
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      key: "AI_SPLIT:g1",
      function: "IMAGE",
      id: 100,
      prompt: "方向0首次提示词", // 代表任务（组内最小 id）
      model: "ZQ-Image-1",
      modelLabel: "ZQ-Image-1",
      status: "SUCCESS",
      credits: "40", // 15 + 9 + 8 + 8，含重试；另组 99 不串入
      resultUrl: "https://cdn.example.com/d0-retry.png",
      resultCount: 3,
      resultLabel: "成功 3/3 张 · 2 个方向",
    })
    expect(result.summary.totalCredits).toBe("40")
  })

  it("function=IMAGE 同时返回普通生图与拆图组行，筛选条件透传拆图查询", async () => {
    const { service, audit } = createMocks()
    const createdAt = new Date("2026-09-04T08:00:00.000Z")
    audit.generationTask.count.mockResolvedValue(1)
    audit.generationTask.findMany.mockImplementation(
      (args: { where?: { generationMode?: string } }) =>
        Promise.resolve(
          args.where?.generationMode === "AI_SPLIT"
            ? [
                {
                  id: 300,
                  groupId: "g2",
                  directionIndex: 0,
                  status: "SUCCESS",
                  prompt: "一个苹果",
                  model: "ZQ-Image-1",
                  createdAt,
                  deletedAt: null,
                  user,
                  generatedImages: [
                    {
                      url: "https://cdn.example.com/split.png",
                      status: "SUCCESS",
                      adopted: true,
                      order: 0,
                    },
                  ],
                },
              ]
            : [
                {
                  id: 201,
                  prompt: "人像",
                  model: "ZQ-Image-1",
                  status: "SUCCESS",
                  createdAt: new Date("2026-09-04T09:00:00.000Z"),
                  deletedAt: null,
                  user,
                  generatedImages: [
                    { url: "https://cdn.example.com/std.png", status: "SUCCESS", adopted: true },
                  ],
                },
              ]
        )
    )

    const result = await service.list({
      page: 1,
      pageSize: 10,
      function: "IMAGE",
      model: "ZQ-Image-1",
      keyword: "苹果",
    })

    expect(audit.videoTask.count).not.toHaveBeenCalled()
    expect(result.total).toBe(2)
    expect(result.items.map(item => item.key)).toEqual(["IMAGE:201", "AI_SPLIT:g2"])
    const splitCall = audit.generationTask.findMany.mock.calls.find(
      ([args]: [{ where?: { generationMode?: string } }]) =>
        args.where?.generationMode === "AI_SPLIT"
    ) as [{ where: Record<string, unknown> }]
    expect(splitCall[0].where).toMatchObject({
      generationMode: "AI_SPLIT",
      model: "ZQ-Image-1",
    })
    expect(splitCall[0].where.OR).toHaveLength(3)
  })

  it("模型选项并入拆图模型，与普通生图重合时去重", async () => {
    const { service, audit } = createMocks()
    audit.generationTask.groupBy.mockImplementation(
      (args: { where?: { generationMode?: string } }) =>
        Promise.resolve(
          args.where?.generationMode === "AI_SPLIT"
            ? [{ model: "ZQ-Image-1" }]
            : [{ model: "ZQ-Image-1" }, { model: "NANO_BANANA" }]
        )
    )

    const result = await service.getModelOptions({})

    expect(result).toEqual([
      { value: "NANO_BANANA", label: "Nano Banana", function: "IMAGE" },
      { value: "ZQ-Image-1", label: "ZQ-Image-1", function: "IMAGE" },
    ])
  })
})

describe("GenerationRecordService 通用生图 t2i/i2i 生成记录", () => {
  it("按 jobId 一行并入 IMAGE，积分按 meta.jobId 反查累加，异键流水不串入", async () => {
    const { service, prisma, audit } = createMocks()
    const t2iCreatedAt = new Date("2026-09-11T03:00:00.000Z")
    const i2iCreatedAt = new Date("2026-09-11T03:05:00.000Z")
    const t2iJob = {
      id: "0b6b8e62-1111-4111-8111-111111111111",
      kind: "TEXT_TO_IMAGE",
      status: "COMPLETED",
      model: "atlas-gpt",
      prompt: "文生图提示词",
      createdAt: t2iCreatedAt,
      user,
      items: [
        { url: "https://cdn.example.com/t2i-1.png", status: "SUCCEEDED" },
        { url: null, status: "FAILED" },
      ],
    }
    const i2iJob = {
      id: "0b6b8e62-2222-4222-8222-222222222222",
      kind: "IMAGE_TO_IMAGE",
      status: "FAILED",
      model: "ZQ-Image-2-Backup",
      prompt: "图生图提示词",
      createdAt: i2iCreatedAt,
      user,
      items: [{ url: null, status: "FAILED" }],
    }
    audit.imageGenJob.count.mockResolvedValue(2)
    audit.imageGenJob.findMany.mockImplementation(
      (args: { select?: { kind?: boolean; userId?: boolean } }) =>
        Promise.resolve(
          args.select?.kind
            ? [i2iJob, t2iJob] // 列表投影（orderBy 由真实现传，mock 不校验顺序）
            : [
                { id: t2iJob.id, userId: user.id, createdAt: t2iCreatedAt },
                { id: i2iJob.id, userId: user.id, createdAt: i2iCreatedAt },
              ] // sumImageGenCredits 最小行
        )
    )
    // 同 job 两笔（多 item/attempt）累加；generate 流水（meta.taskId）与外来 jobId 不得串入
    prisma.usageLog.findMany.mockResolvedValue([
      { credits: new Decimal("10"), meta: { jobId: t2iJob.id, kind: "TEXT_TO_IMAGE" } },
      { credits: new Decimal("5"), meta: { jobId: t2iJob.id, kind: "TEXT_TO_IMAGE" } },
      { credits: new Decimal("3"), meta: { jobId: i2iJob.id, kind: "IMAGE_TO_IMAGE" } },
      { credits: new Decimal("99"), meta: { taskId: 555, provider: "atlas-gpt" } },
      { credits: new Decimal("88"), meta: { jobId: "job-not-in-page" } },
    ])

    const result = await service.list({ page: 1, pageSize: 20 })

    expect(result.total).toBe(2)
    expect(result.items.map(item => item.key)).toEqual([
      `IMAGEGEN:${i2iJob.id}`,
      `IMAGEGEN:${t2iJob.id}`,
    ])
    expect(result.items[1]).toMatchObject({
      key: `IMAGEGEN:${t2iJob.id}`,
      function: "IMAGE",
      id: t2iJob.id,
      prompt: "文生图提示词",
      model: "atlas-gpt",
      modelLabel: "atlas-gpt",
      status: "SUCCESS",
      credits: "15", // 10 + 5，含同 job 多流水
      resultUrl: "https://cdn.example.com/t2i-1.png",
      resultCount: 1,
      resultLabel: "文生图 · 成功 1/2 张",
      deleted: false,
    })
    expect(result.items[0]).toMatchObject({
      key: `IMAGEGEN:${i2iJob.id}`,
      status: "FAILED",
      credits: "3",
      resultUrl: null,
      resultLabel: "图生图 · 成功 0/1 张",
    })
    expect(result.summary.totalCredits).toBe("18") // 15 + 3
  })

  it("筛选条件透传 ImageGenJob 查询，且刻意不带 expiresAt 过滤（过期终态行是历史）", async () => {
    const { service, audit } = createMocks()

    await service.list({
      page: 1,
      pageSize: 10,
      function: "IMAGE",
      model: "atlas-gpt",
      keyword: "沙发",
      orgId: 3,
      roleId: 5,
      dateFrom: "2026-09-01",
      dateTo: "2026-09-11",
    })

    const countCall = audit.imageGenJob.count.mock.calls[0] as [{ where: Record<string, unknown> }]
    expect(countCall[0].where).toMatchObject({
      model: "atlas-gpt",
      createdAt: {
        gte: new Date("2026-09-01"),
        lt: new Date("2026-09-12"),
      },
      user: {
        orgs: { some: { orgId: 3 } },
        roles: { some: { roleId: 5 } },
      },
    })
    expect(countCall[0].where.OR).toHaveLength(3)
    expect(countCall[0].where).not.toHaveProperty("expiresAt")
    expect(countCall[0].where.taskId).toBeNull() // 已归档 job 隐藏（积分挂入库行）
    // function=IMAGE 时才查；列表取数与计数同 where
    const findCall = audit.imageGenJob.findMany.mock.calls.find(
      (args: unknown[]) => (args[0] as { select?: { kind?: boolean } }).select?.kind
    ) as [{ where: Record<string, unknown> }]
    expect(findCall[0].where).toEqual(countCall[0].where)
  })

  it("function=VIDEO 时不查询 ImageGenJob；模型选项并入 t2i/i2i 模型（null 快照跳过）", async () => {
    const { service, audit } = createMocks()

    await service.list({ page: 1, pageSize: 10, function: "VIDEO" })
    expect(audit.imageGenJob.count).not.toHaveBeenCalled()
    expect(audit.imageGenJob.findMany).not.toHaveBeenCalled()

    audit.imageGenJob.groupBy.mockResolvedValue([{ model: "atlas-gpt" }, { model: null }])
    const options = await service.getModelOptions({ function: "IMAGE" })
    expect(options).toEqual([{ value: "atlas-gpt", label: "atlas-gpt", function: "IMAGE" }])
    expect(audit.imageGenJob.groupBy).toHaveBeenCalledWith({
      by: ["model"],
      where: { source: "platform", kind: { not: "CROP" }, taskId: null }, // 裁剪、VidFlow 及已归档 job 隐藏
    })
  })

  it("批量改图入库行按 sourceJobId 挂积分（meta.jobId 口径），已归档 job 不再出 IMAGEGEN 行（不双计）", async () => {
    const { service, prisma, audit } = createMocks()
    const archivedAt = new Date("2026-09-11T06:00:00.000Z")
    // 入库快照行（IMAGE:2149，带 sourceJobId 指向源 job）
    audit.generationTask.count.mockResolvedValue(1)
    audit.generationTask.findMany.mockImplementation(
      (args: { where?: { generationMode?: string }; select?: { sourceJobId?: boolean } }) => {
        if (args.where?.generationMode === "AI_SPLIT") return []
        return args.select?.sourceJobId
          ? [
              {
                id: 2149,
                prompt: "换个角度",
                model: "ZQ-Image-2",
                status: "SUCCESS",
                createdAt: archivedAt,
                deletedAt: null,
                sourceJobId: "job-archived-1",
                user,
                generatedImages: [
                  { url: "https://cdn.example.com/a1.png", status: "SUCCESS", adopted: false },
                ],
              },
            ]
          : [{ id: 2149, userId: user.id, createdAt: archivedAt, sourceJobId: "job-archived-1" }]
      }
    )
    // 已归档 job 被 where(taskId:null) 排除 → 无 IMAGEGEN 行
    audit.imageGenJob.count.mockResolvedValue(0)
    audit.imageGenJob.findMany.mockResolvedValue([])
    // 流水：源 job 的扣费（meta.jobId=32）+ 同号数字 taskId 的流水（9）——入库行
    // 必须走 jobId 口径取 32，不得误挂 9
    prisma.usageLog.findMany.mockResolvedValue([
      { credits: new Decimal("32"), meta: { jobId: "job-archived-1", kind: "IMAGE_TO_IMAGE" } },
      { credits: new Decimal("9"), meta: { taskId: 2149, provider: "atlas-gpt" } },
    ])

    const result = await service.list({ page: 1, pageSize: 20 })

    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({ key: "IMAGE:2149", credits: "32" })
    expect(result.summary.totalCredits).toBe("32") // sumImageCredits 经 sourceJobId 求和，不双计
  })
})

describe("视频用户生成记录来源隔离", () => {
  it("同用户的 VidFlow 视频不进入结果、模型选项或扣分合计", async () => {
    const { service, prisma, audit } = createMocks()
    const createdAt = new Date("2026-10-13T01:00:00.000Z")
    const rows = [
      {
        id: 601,
        source: "platform",
        project: { source: "platform" },
        model: "seller-video",
        modelName: "Seller 视频",
      },
      {
        id: 602,
        source: "vidflowos",
        project: { source: "vidflowos" },
        model: "vid-video",
        modelName: "VidFlow 视频",
      },
      {
        id: 603,
        source: "platform",
        project: { source: "vidflowos" },
        model: "old-vid-video",
        modelName: "历史 VidFlow 视频",
      },
    ].map(row => ({
      ...row,
      prompt: "视频提示词",
      status: "SUCCESS",
      resultUrl: "https://example.com/video.mp4",
      createdAt,
      deletedAt: null,
      userId: user.id,
      user,
    }))
    const filtered = (where: { source?: string; project?: { source?: string } }) =>
      rows.filter(
        row =>
          (!where.source || row.source === where.source) &&
          (!where.project?.source || row.project.source === where.project.source)
      )
    audit.videoTask.findMany.mockImplementation(
      ({ where }: { where: Parameters<typeof filtered>[0] }) => Promise.resolve(filtered(where))
    )
    audit.videoTask.count.mockImplementation(
      ({ where }: { where: Parameters<typeof filtered>[0] }) =>
        Promise.resolve(filtered(where).length)
    )
    audit.videoTask.groupBy.mockImplementation(
      ({ where }: { where: Parameters<typeof filtered>[0] }) =>
        Promise.resolve(
          filtered(where).map(row => ({ model: row.model, modelName: row.modelName }))
        )
    )
    prisma.usageLog.findMany.mockResolvedValue([
      { credits: new Decimal(3), meta: { taskId: 601 } },
      { credits: new Decimal(99), meta: { taskId: 602 } },
      { credits: new Decimal(99), meta: { taskId: 603 } },
    ])
    const result = await service.list({ page: 1, pageSize: 10, function: "VIDEO" })
    expect(result.total).toBe(1)
    expect(result.items.map(item => item.key)).toEqual(["VIDEO:601"])
    expect(result.items[0].credits).toBe("3")
    expect(result.summary.totalCredits).toBe("3")
    await expect(service.getModelOptions({ function: "VIDEO" })).resolves.toEqual([
      { value: "seller-video", label: "Seller 视频", function: "VIDEO" },
    ])
  })

  it("列表、总数、积分汇总和模型选项使用相同来源限制", async () => {
    const { service, audit } = createMocks()
    await service.list({ page: 1, pageSize: 10, function: "VIDEO", keyword: "测试" })
    const visible = { source: "platform", project: { source: "platform" } }
    expect(audit.videoTask.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(visible) })
    )
    // 列表和全量积分汇总会分别查询 VideoTask，两者均须限定来源。
    expect(audit.videoTask.findMany).toHaveBeenCalledTimes(2)
    for (const [args] of audit.videoTask.findMany.mock.calls as [{ where: unknown }][]) {
      expect(args.where).toMatchObject(visible)
    }
    await service.getModelOptions({ function: "VIDEO", keyword: "测试" })
    expect(audit.videoTask.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(visible) })
    )
  })
})
