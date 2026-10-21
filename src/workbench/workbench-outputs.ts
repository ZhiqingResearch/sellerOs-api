import type { HistoryType } from "@prisma/client"
import type { PrismaService } from "../prisma/prisma.service"

/** 工作台聚合的功能 key；与前端功能分布卡片一一对应 */
export enum WorkbenchFeatureKey {
  /** ASIN 取证 */
  ASIN_EVIDENCE = "asin_evidence",
  /** ASIN 自审 */
  ASIN_AUDIT = "asin_audit",
  /** 竞品分析 */
  COMPETITOR = "competitor",
  /** 选品 */
  SELECTION = "selection",
  /** 智能定价 */
  PRICING = "pricing",
  /** 新品推广计划 */
  LAUNCH_PLAN = "launch_plan",
  /** 广告优化（广告数据清洗） */
  AD_OPT = "ad_opt",
  /** Listing 生成 */
  LISTING = "listing",
  /** Listing 打分 */
  LISTING_SCORE = "listing_score",
  /** 上架 */
  PUBLISH = "publish",
  /** 商品链接（AI 商品工厂） */
  PRODUCT_FACTORY = "product_factory",
  /** 图片生成（商品图/通用/人像/批量改图，按成功张数） */
  IMAGE_GENERATION = "image_generation",
  /** 视频生成（通用创作，按成功条数） */
  VIDEO_GENERATION = "video_generation",
  /** 一键润色（按次数） */
  ENHANCE_PROMPT = "enhance_prompt",
  /** 由图推理（按次数） */
  IMAGE_INFERENCE = "image_inference",
  /** 中英互译（按次数） */
  TRANSLATE_PROMPT = "translate_prompt",
  /** 灵感雷达（按同步次数） */
  INSPIRATION_RADAR = "inspiration_radar",
  /** AI 拆图（按成功张数） */
  AI_SPLIT = "ai_split",
  /** 视频分析（按次数） */
  VIDEO_ANALYSIS = "video_analysis",
  /** 动作复刻（按成功条数） */
  MOTION_REPLICA = "motion_replica",
}

/** 最近产出列表的统一条目形状；跳转功能历史页由前端按 featureKey + recordId 路由 */
export interface WorkbenchOutputItem {
  featureKey: WorkbenchFeatureKey
  featureLabel: string
  recordId: string
  /** 列表展示标题；为 null 时前端显示「未命名」 */
  title: string | null
  occurredAt: Date
}

/** 单个功能的产出查询：周期内条数 + 最新 limit 条；since=null 表示不限时间 */
export interface WorkbenchOutputQuery {
  readonly key: WorkbenchFeatureKey
  readonly label: string
  count(userId: number, since: Date | null): Promise<number>
  latest(userId: number, since: Date | null, limit: number): Promise<WorkbenchOutputItem[]>
}

/** 周期时间条件；since=null 时不加时间过滤 */
function timeWhere(since: Date | null): { createdAt?: { gte: Date } } {
  return since ? { createdAt: { gte: since } } : {}
}

/** 最近产出列表标题截断（prompt / URL 等长文本）；空值归一为 null（前端显示「未命名」） */
function truncateTitle(text: string | null | undefined, max = 60): string | null {
  const trimmed = text?.trim()
  if (!trimmed) return null
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** 按 key/label 把各业务的行查询归一成统一条目 */
function defineQuery(
  key: WorkbenchFeatureKey,
  label: string,
  query: {
    count: (userId: number, since: Date | null) => Promise<number>
    latestRows: (
      userId: number,
      since: Date | null,
      limit: number
    ) => Promise<Array<{ id: string; title: string | null; createdAt: Date }>>
  }
): WorkbenchOutputQuery {
  return {
    key,
    label,
    count: query.count,
    latest: async (userId, since, limit) =>
      (await query.latestRows(userId, since, limit)).map(row => ({
        featureKey: key,
        featureLabel: label,
        recordId: row.id,
        title: row.title,
        occurredAt: row.createdAt,
      })),
  }
}

/**
 * 工作台产出查询注册表：每个功能一个 defineQuery 块，新增业务在这里追加一块即可接入聚合，
 * WorkbenchService / 模块注册无需改动。侵权排查后端暂无记录存储，未列入。
 */
export function workbenchOutputQueries(prisma: PrismaService): WorkbenchOutputQuery[] {
  return [
    // ASIN 取证：取证记录表不在 SOFT_DELETE_MODELS 自动过滤集合内（见 prisma.service.ts），需显式排除软删
    defineQuery(WorkbenchFeatureKey.ASIN_EVIDENCE, "ASIN 取证", {
      count: (userId, since) =>
        prisma.asinEvidenceRecord.count({
          where: { userId, deletedAt: null, ...timeWhere(since) },
        }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.asinEvidenceRecord.findMany({
          where: { userId, deletedAt: null, ...timeWhere(since) },
          select: { id: true, asin: true, productTitle: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({
          id: row.id,
          title: row.productTitle || row.asin,
          createdAt: row.createdAt,
        }))
      },
    }),
    defineQuery(WorkbenchFeatureKey.ASIN_AUDIT, "ASIN 自审", {
      count: (userId, since) =>
        prisma.asinAuditRecord.count({ where: { userId, ...timeWhere(since) } }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.asinAuditRecord.findMany({
          where: { userId, ...timeWhere(since) },
          select: { id: true, asin: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({ id: row.id, title: row.asin, createdAt: row.createdAt }))
      },
    }),
    defineQuery(WorkbenchFeatureKey.COMPETITOR, "竞品分析", {
      count: (userId, since) =>
        prisma.competitorAnalysisRecord.count({ where: { userId, ...timeWhere(since) } }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.competitorAnalysisRecord.findMany({
          where: { userId, ...timeWhere(since) },
          select: { id: true, title: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({ id: row.id, title: row.title || null, createdAt: row.createdAt }))
      },
    }),
    // 选品：仅统计已完成的五步分析，半截流程不算产出
    defineQuery(WorkbenchFeatureKey.SELECTION, "选品", {
      count: (userId, since) =>
        prisma.selectionAnalysisRecord.count({
          where: { userId, status: "COMPLETED", ...timeWhere(since) },
        }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.selectionAnalysisRecord.findMany({
          where: { userId, status: "COMPLETED", ...timeWhere(since) },
          select: { id: true, primaryCategoryName: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({
          id: row.id,
          title: row.primaryCategoryName || null,
          createdAt: row.createdAt,
        }))
      },
    }),
    defineQuery(WorkbenchFeatureKey.PRICING, "智能定价", {
      count: (userId, since) =>
        prisma.smartPricingRecord.count({ where: { userId, ...timeWhere(since) } }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.smartPricingRecord.findMany({
          where: { userId, ...timeWhere(since) },
          select: { id: true, productName: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({ id: row.id, title: row.productName, createdAt: row.createdAt }))
      },
    }),
    defineQuery(WorkbenchFeatureKey.LAUNCH_PLAN, "新品推广", {
      count: (userId, since) =>
        prisma.promotionPlanRecord.count({ where: { userId, ...timeWhere(since) } }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.promotionPlanRecord.findMany({
          where: { userId, ...timeWhere(since) },
          select: { id: true, productName: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({ id: row.id, title: row.productName, createdAt: row.createdAt }))
      },
    }),
    // 广告优化：仅统计清洗成功的任务，排队/失败不算产出
    defineQuery(WorkbenchFeatureKey.AD_OPT, "广告优化", {
      count: (userId, since) =>
        prisma.adCleaningTask.count({
          where: { userId, status: "SUCCESS", ...timeWhere(since) },
        }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.adCleaningTask.findMany({
          where: { userId, status: "SUCCESS", ...timeWhere(since) },
          select: { id: true, taskId: true, originalFilename: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({
          id: row.taskId,
          title: row.originalFilename,
          createdAt: row.createdAt,
        }))
      },
    }),
    // Listing 生成：走 History 操作历史，与 Listing 打分分开统计
    defineQuery(WorkbenchFeatureKey.LISTING, "Listing 生成", {
      count: (userId, since) =>
        prisma.history.count({
          where: {
            userId,
            type: "LISTING_GENERATION" satisfies HistoryType,
            ...timeWhere(since),
          },
        }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.history.findMany({
          where: {
            userId,
            type: "LISTING_GENERATION" satisfies HistoryType,
            ...timeWhere(since),
          },
          select: { id: true, title: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({ id: String(row.id), title: row.title, createdAt: row.createdAt }))
      },
    }),
    // Listing 打分：同走 History，与生成拆成两个分布项
    defineQuery(WorkbenchFeatureKey.LISTING_SCORE, "Listing 打分", {
      count: (userId, since) =>
        prisma.history.count({
          where: {
            userId,
            type: "LISTING_SCORING" satisfies HistoryType,
            ...timeWhere(since),
          },
        }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.history.findMany({
          where: {
            userId,
            type: "LISTING_SCORING" satisfies HistoryType,
            ...timeWhere(since),
          },
          select: { id: true, title: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({ id: String(row.id), title: row.title, createdAt: row.createdAt }))
      },
    }),
    // 上架：仅统计已提交发布的任务（publishSubmittedAt 非空），草稿不算产出
    defineQuery(WorkbenchFeatureKey.PUBLISH, "上架", {
      count: (userId, since) =>
        prisma.productPublishTask.count({
          where: { userId, publishSubmittedAt: { not: null }, ...timeWhere(since) },
        }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.productPublishTask.findMany({
          where: { userId, publishSubmittedAt: { not: null }, ...timeWhere(since) },
          select: { id: true, taskId: true, productName: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({
          id: row.taskId,
          title: row.productName,
          createdAt: row.createdAt,
        }))
      },
    }),
    // 商品链接（AI 商品工厂）：制作记录录入竞品链接/自有商品资料才创建，创建即计入；软删由全局扩展过滤
    defineQuery(WorkbenchFeatureKey.PRODUCT_FACTORY, "商品链接", {
      count: (userId, since) =>
        prisma.productFactoryRecord.count({ where: { userId, ...timeWhere(since) } }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.productFactoryRecord.findMany({
          where: { userId, ...timeWhere(since) },
          select: { id: true, productName: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({
          id: String(row.id),
          title: row.productName,
          createdAt: row.createdAt,
        }))
      },
    }),

    // ── 创作工具类（图片/视频/工具箱/雷达），全部纯查询、不加表 ─────────────────

    // 图片生成（商品图/通用/人像/批量改图）：按成功张数，两路相加——
    // GenerationTask(STANDARD) 的成功图（商品图/人像等图片项目链路）+ ImageGenJob(t2i/i2i) 的成功 item
    // （通用创作/批量改图）；AI_SPLIT 任务不在本项（AI 拆图单独成项）。软删由全局扩展过滤。
    defineQuery(WorkbenchFeatureKey.IMAGE_GENERATION, "图片生成", {
      count: async (userId, since) =>
        (await prisma.generatedImage.count({
          where: {
            status: "SUCCESS",
            source: "platform",
            task: {
              userId,
              generationMode: "STANDARD",
              source: "platform",
              project: { source: "platform" },
            },
            ...timeWhere(since),
          },
        })) +
        (await prisma.imageGenItem.count({
          where: { status: "SUCCEEDED", job: { userId, source: "platform" }, ...timeWhere(since) },
        })),
      latestRows: async (userId, since, limit) => {
        const [images, items] = await Promise.all([
          prisma.generatedImage.findMany({
            where: {
              status: "SUCCESS",
              source: "platform",
              task: {
                userId,
                generationMode: "STANDARD",
                source: "platform",
                project: { source: "platform" },
              },
              ...timeWhere(since),
            },
            select: { id: true, createdAt: true, task: { select: { prompt: true } } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit,
          }),
          prisma.imageGenItem.findMany({
            where: {
              status: "SUCCEEDED",
              job: { userId, source: "platform" },
              ...timeWhere(since),
            },
            select: { id: true, createdAt: true, job: { select: { prompt: true } } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit,
          }),
        ])
        return [
          ...images.map(row => ({
            id: String(row.id),
            title: truncateTitle(row.task?.prompt),
            createdAt: row.createdAt,
          })),
          ...items.map(row => ({
            id: String(row.id),
            title: truncateTitle(row.job?.prompt),
            createdAt: row.createdAt,
          })),
        ]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
      },
    }),

    // 视频生成（通用创作）：成功条数；排除动作复刻（单独成项）与带货创作（独立功能，锚 SalesWorkflow）
    defineQuery(WorkbenchFeatureKey.VIDEO_GENERATION, "视频生成", {
      count: (userId, since) =>
        prisma.videoTask.count({
          where: {
            userId,
            source: "platform",
            project: { source: "platform" },
            mode: { in: ["NORMAL", "REFERENCE"] },
            status: "SUCCESS",
            salesWorkflowId: null,
            ...timeWhere(since),
          },
        }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.videoTask.findMany({
          where: {
            userId,
            source: "platform",
            project: { source: "platform" },
            mode: { in: ["NORMAL", "REFERENCE"] },
            status: "SUCCESS",
            salesWorkflowId: null,
            ...timeWhere(since),
          },
          select: { id: true, prompt: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({
          id: String(row.id),
          title: truncateTitle(row.prompt),
          createdAt: row.createdAt,
        }))
      },
    }),

    // 提示词工具箱三件（一键润色/由图推理/中英互译）：按成功计费次数。
    // UsageLog(source=llm.generic) 按 requestId 前缀区分工具——后端扣费写
    // `toolbox:{tool}:{uuid}`、前端旧链路写 `toolbox-{功能名}-{uuid}`，两段前缀都覆盖；
    // MySQL 下 Prisma 不支持 JSON path 过滤（meta.feature 无法作为条件，见 ImageGenJob 审计快照注释）。
    toolboxUsageQuery(prisma, WorkbenchFeatureKey.ENHANCE_PROMPT, "一键润色", [
      "toolbox:enhance:",
      "toolbox-一键润色-",
    ]),
    toolboxUsageQuery(prisma, WorkbenchFeatureKey.IMAGE_INFERENCE, "由图推理", [
      "toolbox:image-inference:",
      "toolbox-由图推理-",
    ]),
    toolboxUsageQuery(prisma, WorkbenchFeatureKey.TRANSLATE_PROMPT, "中英互译", [
      "toolbox:translate:",
      "toolbox-中英互译-",
    ]),

    // 灵感雷达：按同步次数 = 扣费流水行数（每次成功抓取的同步产生一笔
    // source=inspiration_radar.refresh 的 CONSUME 流水）。口径注脚：抓到 0 条不扣费
    // 故不计（「有效同步」）；一次扣费跨多积分桶会拆多行而轻微多计（罕见）。
    defineQuery(WorkbenchFeatureKey.INSPIRATION_RADAR, "灵感雷达", {
      count: (userId, since) =>
        prisma.creditTransaction.count({
          where: { userId, source: "inspiration_radar.refresh", ...timeWhere(since) },
        }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.creditTransaction.findMany({
          where: { userId, source: "inspiration_radar.refresh", ...timeWhere(since) },
          select: { id: true, meta: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => {
          const subscriptionName = (row.meta as { subscriptionName?: unknown } | null)
            ?.subscriptionName
          return {
            id: String(row.id),
            title: typeof subscriptionName === "string" ? subscriptionName : null,
            createdAt: row.createdAt,
          }
        })
      },
    }),

    // AI 拆图：按成功张数（AI_SPLIT 任务的 GeneratedImage；STANDARD 已计入图片生成，不重复）
    defineQuery(WorkbenchFeatureKey.AI_SPLIT, "AI 拆图", {
      count: (userId, since) =>
        prisma.generatedImage.count({
          where: {
            status: "SUCCESS",
            source: "platform",
            task: {
              userId,
              generationMode: "AI_SPLIT",
              source: "platform",
              project: { source: "platform" },
            },
            ...timeWhere(since),
          },
        }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.generatedImage.findMany({
          where: {
            status: "SUCCESS",
            source: "platform",
            task: {
              userId,
              generationMode: "AI_SPLIT",
              source: "platform",
              project: { source: "platform" },
            },
            ...timeWhere(since),
          },
          select: { id: true, createdAt: true, task: { select: { prompt: true } } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({
          id: String(row.id),
          title: truncateTitle(row.task?.prompt),
          createdAt: row.createdAt,
        }))
      },
    }),

    // 视频分析：按成功计费次数（UsageLog source=video.analysis，前端旧扣费与后端新扣费同源，历史连续）；
    // 标题用 meta.videoUrl
    defineQuery(WorkbenchFeatureKey.VIDEO_ANALYSIS, "视频分析", {
      count: (userId, since) =>
        prisma.usageLog.count({
          where: { userId, source: "video.analysis", ...timeWhere(since) },
        }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.usageLog.findMany({
          where: { userId, source: "video.analysis", ...timeWhere(since) },
          select: { id: true, meta: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({
          id: String(row.id),
          title: truncateTitle(
            (row.meta as { videoUrl?: unknown } | null)?.videoUrl as string | undefined
          ),
          createdAt: row.createdAt,
        }))
      },
    }),

    // 动作复刻：按成功条数（mode=MOTION_CONTROL，含 legacy 小写值；软删由全局扩展过滤）
    defineQuery(WorkbenchFeatureKey.MOTION_REPLICA, "动作复刻", {
      count: (userId, since) =>
        prisma.videoTask.count({
          where: {
            userId,
            source: "platform",
            project: { source: "platform" },
            mode: { in: ["MOTION_CONTROL", "motion_control"] },
            status: "SUCCESS",
            ...timeWhere(since),
          },
        }),
      latestRows: async (userId, since, limit) => {
        const rows = await prisma.videoTask.findMany({
          where: {
            userId,
            source: "platform",
            project: { source: "platform" },
            mode: { in: ["MOTION_CONTROL", "motion_control"] },
            status: "SUCCESS",
            ...timeWhere(since),
          },
          select: { id: true, prompt: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })
        return rows.map(row => ({
          id: String(row.id),
          title: truncateTitle(row.prompt),
          createdAt: row.createdAt,
        }))
      },
    }),
  ]
}

/** 工具箱三件共用：UsageLog(llm.generic) 按 requestId 前缀过滤（两代格式都认） */
function toolboxUsageQuery(
  prisma: PrismaService,
  key: WorkbenchFeatureKey,
  label: string,
  requestIdPrefixes: string[]
): WorkbenchOutputQuery {
  const where = (userId: number, since: Date | null) => ({
    userId,
    source: "llm.generic",
    OR: requestIdPrefixes.map(prefix => ({ requestId: { startsWith: prefix } })),
    ...timeWhere(since),
  })
  return defineQuery(key, label, {
    count: (userId, since) => prisma.usageLog.count({ where: where(userId, since) }),
    latestRows: async (userId, since, limit) => {
      const rows = await prisma.usageLog.findMany({
        where: where(userId, since),
        select: { id: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
      })
      // 流水无业务标题（生成内容不留档），前端按「未命名」展示并路由到工具页
      return rows.map(row => ({ id: String(row.id), title: null, createdAt: row.createdAt }))
    },
  })
}
