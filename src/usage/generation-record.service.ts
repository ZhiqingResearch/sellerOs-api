import { Injectable } from "@nestjs/common"
import { CreditTxnType, Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { RPA_MODEL_LABELS } from "../rpa-creation/rpa-creation.capabilities"
import { AuditPrismaService } from "./audit-prisma.service"
import {
  GenerationRecordModelOptionDto,
  QueryGenerationRecordModelOptionsDto,
  QueryGenerationRecordsDto,
} from "./dto/query-generation-records.dto"

const ZERO = new Decimal(0)

// 已停用：视频出片结果改为永久保留。保留原配置便于将来恢复。
// const VIDEO_RETENTION_DAYS = 3

// 视频扣费流水 source 前缀（video-project.generate 等都以此开头），用于反查每条出片的实扣积分
const VIDEO_SOURCE_PREFIX = "video-project"
// 图片扣费流水 source 前缀（兼容 aicreative.image_generate 与其子来源）
const IMAGE_SOURCE_PREFIX = "aicreative.image_generate"
// AI 拆图扣费流水：工作流阶段（多模态拆解/规划）+ 终态生图，均盖 meta.taskId/meta.groupId
const SPLIT_WORKFLOW_SOURCE = "aicreative.ai_split"
const SPLIT_IMAGE_SOURCE = "aicreative.image_generate.ai_split"
// 图片任务从创建到扣费完成可能跨较长时间（排队/重试），放宽反查时间窗避免漏匹配
const IMAGE_CREDIT_TIME_PADDING_MS = 24 * 60 * 60 * 1000
// 视频任务同样是异步出片，创建到扣费可能超过 1 分钟（排队/轮询/下载/转存），放宽反查时间窗避免漏匹配
const VIDEO_CREDIT_TIME_PADDING_MS = 24 * 60 * 60 * 1000
// 灵感雷达刷新扣费来源
const INSPIRATION_SOURCE = "inspiration_radar.refresh"
const INSPIRATION_CREDIT_TIME_PADDING_MS = 60_000
// 影刀 RPA 成功回调扣费来源；同一任务首次回调和失败重试可能产生多笔，按 taskId 累加。
const RPA_SOURCE = "rpa-creation.generate"
const RPA_CREDIT_TIME_PADDING_MS = 60_000
// 分镜视频扣费：source 与视频共用 video-project 前缀，靠 meta.taskType 区分两条表（id 独立自增会撞号）；
// customer.storyboard-video.generate 为收敛前的旧 source，历史流水兼容反查
const STORYBOARD_TASK_TYPE = "storyboard-video"
const STORYBOARD_LEGACY_SOURCE = "customer.storyboard-video.generate"
const STORYBOARD_CREDIT_TIME_PADDING_MS = 24 * 60 * 60 * 1000
// 美妆视频扣费 source 前缀（beauty-workflow.generate 为 BeautyTask 专属，无撞号问题）
const BEAUTY_SOURCE_PREFIX = "beauty-workflow"
const BEAUTY_CREDIT_TIME_PADDING_MS = 24 * 60 * 60 * 1000

// 图片模型 code → 展示名（视频侧用 capabilities 的 label，无需在此维护）
const IMAGE_MODEL_LABELS: Record<string, string> = {
  FLUX_PRO_11: "FLUX Pro 1.1",
  GPT_IMAGE_1: "GPT Image",
  NANO_BANANA: "Nano Banana",
  QWEN_IMAGE_V2: "Qwen Image",
}

const INSPIRATION_PLATFORM_LABELS: Record<string, string> = {
  PINTEREST: "Pinterest",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
}

// 列表行（图片 / 视频 / 灵感雷达归一）
interface GenerationRecord {
  key: string
  function: "IMAGE" | "VIDEO" | "INSPIRATION_RADAR"
  id: number | string // GenerationTask/VideoTask 等数字 id；t2i/i2i 为 jobId(UUID)，key 前缀区分
  userId: number
  username: string
  phone: string
  orgs: string[]
  roles: { name: string; color: string | null }[]
  prompt: string
  model: string
  modelLabel: string
  credits: string | null // 实扣积分（按 UsageLog.meta.taskId / meta.jobId 反查）
  status: string
  resultUrl: string | null
  resultCount?: number
  resultLabel?: string
  expired: boolean
  deleted: boolean // 该记录对应的任务/订阅是否已被软删除（审计视图仍展示，扣费流水已发生）
  createdAt: Date
}

// 反查视频积分所需的最小行
interface VideoCreditRow {
  id: number
  userId: number
  createdAt: Date
}

interface InspirationCreditRow {
  id: number
  userId: number
  lastRefreshedAt: Date
}

interface RpaCreditRow {
  id: number
  userId: number
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

interface InspirationCreditInfo {
  credits: Decimal
  resultCount: number | null
}

type ImageGenerationRecordRow = {
  id: number
  prompt: string
  model: string
  status: string
  createdAt: Date
  deletedAt: Date | null
  sourceJobId: string | null // 成品入库快照行的来源 ImageGenJob.id（积分经 meta.jobId 反查）
  user: UserRow
  generatedImages: { url: string | null; status: string; adopted: boolean }[]
}

// 通用生图 t2i/i2i 任务行（ImageGenJob）：model/prompt 为审计快照列（部署前
// 老行可能为 null，投影兜底空串）；无软删，过期终态行仍为生成记录的历史数据源
type ImageGenJobRecordRow = {
  id: string
  kind: string
  status: string
  businessType: string
  model: string | null
  prompt: string | null
  createdAt: Date
  user: UserRow
  items: { url: string | null; status: string; fileKey?: string | null }[]
}

// AI 拆图任务行（generationMode=AI_SPLIT），用于按 groupId 聚合
type SplitTaskRow = {
  id: number
  groupId: string | null
  directionIndex: number | null
  status: string
  prompt: string
  model: string
  createdAt: Date
  deletedAt: Date | null
  user: UserRow
  generatedImages: { url: string | null; status: string; adopted: boolean; order: number }[]
}

// 一次拆图（任务组）聚合后的展示单元：方向席位口径，含全部任务 id 供积分反查
interface SplitGroupRow {
  groupId: string // 实际展示 key（groupId 为空的历史行退化为 task:{id}）
  representativeId: number
  prompt: string
  model: string
  createdAt: Date // 组发起时刻（组内任务最早 createdAt）
  user: UserRow
  taskIds: number[]
  running: boolean
  successCount: number
  seatCount: number
  directionCount: number
  firstResultUrl: string | null
  deleted: boolean
}

type VideoGenerationRecordRow = {
  id: number
  prompt: string
  model: string
  modelName: string | null
  status: string
  resultUrl: string | null
  createdAt: Date
  deletedAt: Date | null
  user: UserRow
}

// 分镜视频：model/prompt 在 generationParams JSON 快照里，user 经 客户→项目→生产→分镜 关系链取
type StoryboardVideoRecordRow = {
  id: number
  status: string
  url: string | null
  generationParams: Prisma.JsonValue
  createdAt: Date
  deletedAt: Date | null
  storyboard: { production: { project: { customer: { user: UserRow } } } }
}

// 美妆视频：model/prompt/status/resultUrl 均为实体列，user 直连
type BeautyVideoRecordRow = {
  id: number
  prompt: string
  model: string
  status: string
  resultUrl: string | null
  createdAt: Date
  deletedAt: Date | null
  user: UserRow
}

type InspirationSubscriptionRecordRow = {
  id: number
  name: string
  keywords: Prisma.JsonValue
  platforms: Prisma.JsonValue
  lastRefreshedAt: Date | null
  deletedAt: Date | null
  user: UserRow
  items: { mediaUrl: string; thumbnailUrl: string | null }[]
  _count: { items: number }
}

type RpaCreationRecordRow = {
  id: number
  prompt: string
  model: string
  mediaType: string
  quantity: number
  status: string
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  deletedAt: Date | null
  user: UserRow
  outputs: { status: string; url: string | null }[]
}

type GenerationRecordFilterQuery = Pick<
  QueryGenerationRecordsDto,
  "keyword" | "orgId" | "roleId" | "model" | "dateFrom" | "dateTo"
>

const USER_SELECT = {
  select: {
    id: true,
    username: true,
    phone: true,
    orgs: { select: { org: { select: { name: true } } } },
    roles: { select: { role: { select: { name: true, color: true } } } },
  },
} satisfies Prisma.UserDefaultArgs

@Injectable()
export class GenerationRecordService {
  constructor(
    private readonly prisma: PrismaService,
    // 审计/对账视图专用的只读客户端：不挂软删除扩展，能读到已删除行。
    // 软删除模型（图片/视频任务、灵感雷达订阅）的统计与列表走它，其余（计费流水表，非软删除）走 prisma。
    private readonly audit: AuditPrismaService
  ) {}

  /** 模型筛选选项：基于完整筛选集去重，不受列表分页和当前 model 影响。 */
  async getModelOptions(
    query: QueryGenerationRecordModelOptionsDto
  ): Promise<GenerationRecordModelOptionDto[]> {
    const includeImage = !query.function || query.function === "IMAGE"
    const includeVideo = !query.function || query.function === "VIDEO"
    const rpaMediaTypes = this.rpaMediaTypes(query.function)

    const [
      imageModels,
      splitModels,
      imageGenModels,
      videoModels,
      rpaModels,
      beautyModels,
      storyboardCount,
    ] = await Promise.all([
      includeImage
        ? this.audit.generationTask.groupBy({
            by: ["model"],
            where: this.buildImageWhere(query),
          })
        : Promise.resolve([]),
      // AI 拆图并入 IMAGE 维度，模型选项同样并入（与普通生图重合的模型由去重兜住）
      includeImage
        ? this.audit.generationTask.groupBy({
            by: ["model"],
            where: this.buildSplitWhere(query),
          })
        : Promise.resolve([]),
      // 通用生图 t2i/i2i（ImageGenJob 快照列）并入 IMAGE 维度
      includeImage
        ? this.audit.imageGenJob.groupBy({
            by: ["model"],
            where: this.buildImageGenJobWhere(query),
          })
        : Promise.resolve([]),
      includeVideo
        ? this.audit.videoTask.groupBy({
            by: ["model", "modelName"],
            where: this.buildVideoWhere(query),
          })
        : Promise.resolve([]),
      rpaMediaTypes.length
        ? this.audit.rpaCreationTask.groupBy({
            by: ["model", "mediaType"],
            where: this.buildRpaWhere(query, rpaMediaTypes),
          })
        : Promise.resolve([]),
      // 美妆模型为实体列可直接 groupBy；分镜模型在 JSON 快照里无法 groupBy，改为有数据时取 STORYBOARD 目录行
      includeVideo
        ? this.audit.beautyTask.groupBy({
            by: ["model"],
            where: this.buildBeautyWhere(query),
          })
        : Promise.resolve([]),
      includeVideo
        ? this.audit.storyboardVideo.count({ where: this.buildStoryboardWhere(query) })
        : Promise.resolve(0),
    ])

    const options: GenerationRecordModelOptionDto[] = imageModels.map(({ model }) => ({
      value: model,
      label: this.imageModelLabel(model),
      function: "IMAGE",
    }))
    for (const { model } of splitModels) {
      options.push({
        value: model,
        label: this.imageModelLabel(model),
        function: "IMAGE",
      })
    }
    // 快照列为 null 的老行无模型可筛，跳过（去重兜住与普通生图重合的模型）
    for (const { model } of imageGenModels) {
      if (!model) continue
      options.push({
        value: model,
        label: this.imageModelLabel(model),
        function: "IMAGE",
      })
    }

    const videoLabelsByModel = new Map<string, Set<string>>()
    for (const { model, modelName } of videoModels) {
      const labels = videoLabelsByModel.get(model) ?? new Set<string>()
      labels.add(modelName ?? model)
      videoLabelsByModel.set(model, labels)
    }
    // 分镜模型在 JSON 快照中，沿用现有 STORYBOARD 目录选项来源。
    const storyboardModels =
      storyboardCount > 0
        ? await this.prisma.aiGatewayModel.findMany({
            where: { category: "STORYBOARD", modality: "VIDEO", enabled: true },
            select: { publicId: true },
          })
        : []
    for (const { model } of beautyModels) {
      const labels = videoLabelsByModel.get(model) ?? new Set<string>()
      labels.add(model)
      videoLabelsByModel.set(model, labels)
    }
    for (const { publicId } of storyboardModels) {
      const labels = videoLabelsByModel.get(publicId) ?? new Set<string>()
      labels.add(publicId)
      videoLabelsByModel.set(publicId, labels)
    }
    for (const [value, labels] of videoLabelsByModel) {
      options.push({
        value,
        label: [...labels].sort((a, b) => a.localeCompare(b, "zh-CN")).join(" / "),
        function: "VIDEO",
      })
    }

    for (const { model, mediaType } of rpaModels) {
      if (mediaType !== "IMAGE" && mediaType !== "VIDEO") continue
      options.push({
        value: model,
        label: RPA_MODEL_LABELS[model] ?? model,
        function: mediaType,
      })
    }

    const unique = [
      ...new Map(options.map(option => [`${option.function}:${option.value}`, option])).values(),
    ]
    const gatewayLabels = await this.gatewayModelLabelMap(unique.map(option => option.value))
    for (const option of unique) {
      option.label = gatewayLabels.get(option.value) ?? option.label
    }
    return unique.sort(
      (a, b) =>
        a.function.localeCompare(b.function) ||
        a.label.localeCompare(b.label, "zh-CN") ||
        a.value.localeCompare(b.value)
    )
  }

  /** 用户生成记录列表（管理员）：合并图片 + 视频 + RPA 创作 + 灵感雷达，附累计实扣积分 */
  async list(query: QueryGenerationRecordsDto) {
    const { page, pageSize } = query
    const skip = (page - 1) * pageSize
    const includeImage = !query.function || query.function === "IMAGE"
    const includeVideo = !query.function || query.function === "VIDEO"
    const includeInspiration =
      (!query.function || query.function === "INSPIRATION_RADAR") && !query.model
    const rpaMediaTypes = this.rpaMediaTypes(query.function)
    const includeRpa = rpaMediaTypes.length > 0

    const imageWhere = this.buildImageWhere(query)
    // AI 拆图并入 IMAGE 功能维度，但按任务组（groupId）聚合后参与归并，不与普通生图混行
    const splitWhere = this.buildSplitWhere(query)
    // 通用生图 t2i/i2i 并入 IMAGE 功能维度（独立 key 前缀，不与 GenerationTask 行混）
    const imageGenWhere = this.buildImageGenJobWhere(query)
    const videoWhere = this.buildVideoWhere(query)
    const storyboardWhere = this.buildStoryboardWhere(query)
    const beautyWhere = this.buildBeautyWhere(query)
    const inspirationWhere = this.buildInspirationWhere(query)
    const rpaWhere = this.buildRpaWhere(query, rpaMediaTypes)

    // 跨多表按 createdAt 归并分页：各取前 skip+pageSize 条，合并排序后切出当前页
    const fetchN = skip + pageSize

    // 分镜/美妆视频并入 VIDEO 功能维度（共用 includeVideo 开关）；
    // AI 拆图一次拉全量组（数据量小），组数即 total，页内行再切片
    const [
      imageTotal,
      splitGroups,
      imageGenTotal,
      videoTotal,
      storyboardTotal,
      beautyTotal,
      inspirationTotal,
      rpaTotal,
    ] = await Promise.all([
      includeImage ? this.audit.generationTask.count({ where: imageWhere }) : Promise.resolve(0),
      includeImage ? this.fetchSplitGroups(splitWhere) : Promise.resolve([] as SplitGroupRow[]),
      includeImage ? this.audit.imageGenJob.count({ where: imageGenWhere }) : Promise.resolve(0),
      includeVideo ? this.audit.videoTask.count({ where: videoWhere }) : Promise.resolve(0),
      includeVideo
        ? this.audit.storyboardVideo.count({ where: storyboardWhere })
        : Promise.resolve(0),
      includeVideo ? this.audit.beautyTask.count({ where: beautyWhere }) : Promise.resolve(0),
      includeInspiration
        ? this.audit.inspirationSubscription.count({ where: inspirationWhere })
        : Promise.resolve(0),
      includeRpa ? this.audit.rpaCreationTask.count({ where: rpaWhere }) : Promise.resolve(0),
    ] as const)
    const [
      imageRows,
      imageGenRows,
      videoRows,
      storyboardRows,
      beautyRows,
      inspirationRows,
      rpaRows,
    ] = await Promise.all([
      includeImage
        ? this.audit.generationTask.findMany({
            where: imageWhere,
            orderBy: { createdAt: "desc" },
            take: fetchN,
              select: {
                id: true,
                prompt: true,
                model: true,
                status: true,
                createdAt: true,
                deletedAt: true,
                sourceJobId: true,
                user: USER_SELECT,
                generatedImages: {
                  where: { source: "platform" },
                  select: { url: true, status: true, adopted: true },
                  orderBy: [{ adopted: "desc" }, { order: "asc" }],
                  take: 5,
                },
              },
          })
        : Promise.resolve([] as ImageGenerationRecordRow[]),
      includeImage
        ? this.audit.imageGenJob.findMany({
            where: imageGenWhere,
            orderBy: { createdAt: "desc" },
            take: fetchN,
            select: {
              id: true,
              kind: true,
              status: true,
              businessType: true,
              model: true,
              prompt: true,
              createdAt: true,
              user: USER_SELECT,
              items: {
                select: { url: true, status: true, fileKey: true },
                orderBy: { idx: "asc" },
              },
            },
          })
        : Promise.resolve([] as ImageGenJobRecordRow[]),
      includeVideo
        ? this.audit.videoTask.findMany({
            where: videoWhere,
            orderBy: { createdAt: "desc" },
            take: fetchN,
            select: {
              id: true,
              prompt: true,
              model: true,
              modelName: true,
              status: true,
              resultUrl: true,
              createdAt: true,
              deletedAt: true,
              user: USER_SELECT,
            },
          })
        : Promise.resolve([] as VideoGenerationRecordRow[]),
      includeVideo
        ? (this.audit.storyboardVideo.findMany({
            where: storyboardWhere,
            orderBy: { createdAt: "desc" },
            take: fetchN,
            select: {
              id: true,
              status: true,
              url: true,
              generationParams: true,
              createdAt: true,
              deletedAt: true,
              storyboard: {
                select: {
                  production: {
                    select: {
                      project: { select: { customer: { select: { user: USER_SELECT } } } },
                    },
                  },
                },
              },
            },
          }) as unknown as Promise<StoryboardVideoRecordRow[]>)
        : Promise.resolve([] as StoryboardVideoRecordRow[]),
      includeVideo
        ? this.audit.beautyTask.findMany({
            where: beautyWhere,
            orderBy: { createdAt: "desc" },
            take: fetchN,
            select: {
              id: true,
              prompt: true,
              model: true,
              status: true,
              resultUrl: true,
              createdAt: true,
              deletedAt: true,
              user: USER_SELECT,
            },
          })
        : Promise.resolve([] as BeautyVideoRecordRow[]),
      includeInspiration
        ? this.audit.inspirationSubscription.findMany({
            where: inspirationWhere,
            orderBy: { lastRefreshedAt: "desc" },
            take: fetchN,
            select: {
              id: true,
              name: true,
              keywords: true,
              platforms: true,
              lastRefreshedAt: true,
              deletedAt: true,
              user: USER_SELECT,
              items: {
                select: { mediaUrl: true, thumbnailUrl: true },
                orderBy: [{ likes: "desc" }, { createdAt: "desc" }],
                take: 1,
              },
              _count: { select: { items: true } },
            },
          })
        : Promise.resolve([] as InspirationSubscriptionRecordRow[]),
      includeRpa
        ? this.audit.rpaCreationTask.findMany({
            where: rpaWhere,
            orderBy: { createdAt: "desc" },
            take: fetchN,
            select: {
              id: true,
              prompt: true,
              model: true,
              mediaType: true,
              quantity: true,
              status: true,
              createdAt: true,
              updatedAt: true,
              completedAt: true,
              deletedAt: true,
              user: USER_SELECT,
              outputs: {
                where: { deletedAt: null },
                select: { status: true, url: true },
                orderBy: { order: "asc" },
              },
            },
          })
        : Promise.resolve([] as RpaCreationRecordRow[]),
    ] as const)

    const now = Date.now()
    const pageSplitGroups = splitGroups.slice(0, fetchN)
    const merged: GenerationRecord[] = [
      ...imageRows.map(r => this.toImageRecord(r)),
      ...pageSplitGroups.map(g => this.toSplitGroupRecord(g)),
      ...imageGenRows.map(r => this.toImageGenJobRecord(r)),
      ...videoRows.map(r => this.toVideoRecord(r, now)),
      ...storyboardRows.map(r => this.toStoryboardVideoRecord(r)),
      ...beautyRows.map(r => this.toBeautyVideoRecord(r)),
      ...inspirationRows
        .filter(r => r.lastRefreshedAt != null)
        .map(r => this.toInspirationRecord({ ...r, lastRefreshedAt: r.lastRefreshedAt! })),
      ...rpaRows.map(r => this.toRpaRecord(r)),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(skip, skip + pageSize)

    const modelRecords = merged.filter(r => r.function !== "INSPIRATION_RADAR")
    const gatewayLabels = await this.gatewayModelLabelMap(modelRecords.map(r => r.model))
    for (const record of modelRecords) {
      record.modelLabel = gatewayLabels.get(record.model) ?? record.modelLabel
    }

    // 图片 / AI 拆图 / t2i/i2i / 视频 / 分镜 / 美妆 / RPA / 灵感雷达积分：按各自任务标识反查当前页
    // （GenerationRecord.id 已放宽 number|string，按 key 前缀收窄后投影）
    const creditRow = (r: GenerationRecord) => ({
      id: r.id,
      userId: r.userId,
      createdAt: r.createdAt,
    })
    const imageCreditMap = await this.imageCreditsByTask(
      merged
        .filter(r => r.key.startsWith("IMAGE:"))
        .map(r => ({ ...creditRow(r), id: r.id as number }))
    )
    // t2i/i2i：按 meta.jobId（字符串 jobId）反查，与 IMAGE:/AI_SPLIT: 分支互不混淆。
    // 入库快照行（IMAGE: 且带 sourceJobId）的积分同走此 map——扣费流水盖的是源
    // job 的 jobId；已归档 job 的 IMAGEGEN 行已被 where 隐藏，同一笔钱只挂一行。
    const sourceJobByTaskId = new Map(
      imageRows.filter(r => r.sourceJobId).map(r => [r.id, r.sourceJobId!])
    )
    const imageGenCreditMap = await this.imageGenCreditsByJob([
      ...merged
        .filter(r => r.key.startsWith("IMAGEGEN:"))
        .map(r => ({ ...creditRow(r), id: r.id as string })),
      ...imageRows
        .filter(r => r.sourceJobId)
        .map(r => ({ id: r.sourceJobId!, userId: r.user.id, createdAt: r.createdAt })),
    ])
    const splitCreditMap = await this.splitCreditsByGroup(pageSplitGroups)
    const creditMap = await this.videoCreditsByTask(
      merged
        .filter(r => r.key.startsWith("VIDEO:"))
        .map(r => ({ ...creditRow(r), id: r.id as number }))
    )
    const storyboardCreditMap = await this.storyboardCreditsByTask(
      merged
        .filter(r => r.key.startsWith("STORYBOARD_VIDEO:"))
        .map(r => ({ ...creditRow(r), id: r.id as number }))
    )
    const beautyCreditMap = await this.beautyCreditsByTask(
      merged
        .filter(r => r.key.startsWith("BEAUTY_VIDEO:"))
        .map(r => ({ ...creditRow(r), id: r.id as number }))
    )
    const selectedRpaIds = new Set(merged.filter(r => r.key.startsWith("RPA_")).map(r => r.id))
    const rpaCreditMap = await this.rpaCreditsByTask(
      rpaRows
        .filter(r => selectedRpaIds.has(r.id))
        .map(r => ({
          id: r.id,
          userId: r.user.id,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          completedAt: r.completedAt,
        }))
    )
    const inspirationCreditMap = await this.inspirationCreditsBySubscription(
      merged
        .filter(r => r.function === "INSPIRATION_RADAR")
        .map(r => ({
          id: r.id as number,
          userId: r.userId,
          lastRefreshedAt: r.createdAt,
        }))
    )
    for (const r of merged) {
      if (r.key.startsWith("IMAGE:")) {
        // 入库快照行按 sourceJobId 走 meta.jobId 反查；普通生成行走 meta.taskId
        const srcJob = sourceJobByTaskId.get(r.id as number)
        r.credits = srcJob
          ? (imageGenCreditMap.get(srcJob)?.toString() ?? null)
          : (imageCreditMap.get(r.id as number)?.toString() ?? null)
      }
      if (r.key.startsWith("IMAGEGEN:"))
        r.credits = imageGenCreditMap.get(r.id as string)?.toString() ?? null
      if (r.key.startsWith("AI_SPLIT:"))
        r.credits = splitCreditMap.get(r.key.slice("AI_SPLIT:".length))?.toString() ?? null
      if (r.key.startsWith("VIDEO:")) r.credits = creditMap.get(r.id as number)?.toString() ?? null
      if (r.key.startsWith("STORYBOARD_VIDEO:"))
        r.credits = storyboardCreditMap.get(r.id as number)?.toString() ?? null
      if (r.key.startsWith("BEAUTY_VIDEO:"))
        r.credits = beautyCreditMap.get(r.id as number)?.toString() ?? null
      if (r.key.startsWith("RPA_")) r.credits = rpaCreditMap.get(r.id as number)?.toString() ?? null
      if (r.function === "INSPIRATION_RADAR") {
        const info = inspirationCreditMap.get(r.id as number)
        r.credits = info?.credits.toString() ?? null
        if (info?.resultCount != null) {
          r.resultCount = info.resultCount
          r.resultLabel = this.formatInspirationResultLabel(info.resultCount)
        }
      }
    }

    // 累计实扣积分：对筛选后的图片 + AI 拆图 + t2i/i2i + 视频 + 分镜 + 美妆 + RPA + 灵感雷达分别求和后汇总
    const [
      imageCredits,
      splitCredits,
      imageGenCredits,
      videoCredits,
      storyboardCredits,
      beautyCredits,
      inspirationCredits,
      rpaCredits,
    ] = await Promise.all([
      includeImage ? this.sumImageCredits(imageWhere) : ZERO,
      includeImage ? this.sumSplitCreditsOfGroups(splitGroups) : ZERO,
      includeImage ? this.sumImageGenCredits(imageGenWhere) : ZERO,
      includeVideo ? this.sumVideoCredits(videoWhere) : ZERO,
      includeVideo ? this.sumStoryboardCredits(storyboardWhere) : ZERO,
      includeVideo ? this.sumBeautyCredits(beautyWhere) : ZERO,
      includeInspiration ? this.sumInspirationCredits(inspirationWhere) : ZERO,
      includeRpa ? this.sumRpaCredits(rpaWhere) : ZERO,
    ])
    const totalCredits = imageCredits
      .plus(splitCredits)
      .plus(imageGenCredits)
      .plus(videoCredits)
      .plus(storyboardCredits)
      .plus(beautyCredits)
      .plus(inspirationCredits)
      .plus(rpaCredits)
    const total =
      imageTotal +
      splitGroups.length +
      imageGenTotal +
      videoTotal +
      storyboardTotal +
      beautyTotal +
      inspirationTotal +
      rpaTotal

    return {
      items: merged.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      summary: { totalCredits: totalCredits.toString() },
    }
  }

  // ==================== where 构造 ====================

  /** 用户维度筛选（组织 / 角色）+ 关键词（用户名 / 手机号 / 提示词）+ 模型 + 时间范围，图片表 */
  private buildImageWhere(q: GenerationRecordFilterQuery): Prisma.GenerationTaskWhereInput {
    const user = this.userWhere(q)
    return {
      // 普通图片生成记录；AI 拆图走 buildSplitWhere 按任务组单独聚合后并入 IMAGE 维度。
      source: "platform",
      project: { source: "platform" },
      generationMode: "STANDARD",
      ...(q.model ? { model: q.model } : {}),
      ...this.createdAtWhere(q),
      ...(user ? { user } : {}),
      ...(q.keyword
        ? {
            OR: [
              { prompt: { contains: q.keyword } },
              { user: { username: { contains: q.keyword } } },
              { user: { phone: { contains: q.keyword } } },
            ],
          }
        : {}),
    }
  }

  /** AI 拆图任务筛选：与 buildImageWhere 同口径，仅 generationMode 不同 */
  private buildSplitWhere(q: GenerationRecordFilterQuery): Prisma.GenerationTaskWhereInput {
    const user = this.userWhere(q)
    return {
      source: "platform",
      project: { source: "platform" },
      generationMode: "AI_SPLIT",
      ...(q.model ? { model: q.model } : {}),
      ...this.createdAtWhere(q),
      ...(user ? { user } : {}),
      ...(q.keyword
        ? {
            OR: [
              { prompt: { contains: q.keyword } },
              { user: { username: { contains: q.keyword } } },
              { user: { phone: { contains: q.keyword } } },
            ],
          }
        : {}),
    }
  }

  /** 通用生图 t2i/i2i 任务筛选（ImageGenJob）：与 buildImageWhere 同口径，走快照列。
   *  刻意不带 expiresAt 过滤——快照轮询的 30 分钟 404 是 GET 契约，过期终态行
   *  仍是生成记录的历史数据源（保留期见 ReconciliationService.cleanupExpiredJobs）。
   *  已归档（taskId 已回写，成品入库为 GenerationTask 快照行）的 job 不再出
   *  IMAGEGEN 行——同一笔消费只展示入库行一行，积分经 sourceJobId 关联，不双计。 */
  private buildImageGenJobWhere(q: GenerationRecordFilterQuery): Prisma.ImageGenJobWhereInput {
    const user = this.userWhere(q)
    return {
      source: "platform",
      kind: { not: "CROP" },
      taskId: null,
      ...(q.model ? { model: q.model } : {}),
      ...this.createdAtWhere(q),
      ...(user ? { user } : {}),
      ...(q.keyword
        ? {
            OR: [
              { prompt: { contains: q.keyword } },
              { user: { username: { contains: q.keyword } } },
              { user: { phone: { contains: q.keyword } } },
            ],
          }
        : {}),
    }
  }

  /**
   * 拉取筛选集内全部 AI 拆图任务并按任务组（groupId）聚合成展示单元，按组发起时刻倒序。
   * 席位口径与图库 mergeSplitRetrySeats 一致：每 directionIndex 跨重试任务取最优图
   * （成功优先、同优取新）；任一任务在跑即 GENERATING。
   */
  private async fetchSplitGroups(where: Prisma.GenerationTaskWhereInput): Promise<SplitGroupRow[]> {
    const tasks = (await this.audit.generationTask.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        groupId: true,
        directionIndex: true,
        status: true,
        prompt: true,
        model: true,
        createdAt: true,
        deletedAt: true,
        user: USER_SELECT,
        generatedImages: {
          where: { source: "platform", deletedAt: null },
          orderBy: [{ order: "asc" }, { id: "asc" }],
          select: { url: true, status: true, adopted: true, order: true },
        },
      },
    })) as SplitTaskRow[]

    const groups = new Map<string, SplitGroupRow & { tasks: SplitTaskRow[] }>()
    for (const task of tasks) {
      // 创建路径必写 groupId；空值的历史行退化为每任务自成一组，保证仍可见
      const key = task.groupId ?? `task:${task.id}`
      let group = groups.get(key)
      if (!group) {
        group = {
          groupId: key,
          representativeId: task.id,
          prompt: task.prompt,
          model: task.model,
          createdAt: task.createdAt,
          user: task.user,
          taskIds: [],
          running: false,
          successCount: 0,
          seatCount: 0,
          directionCount: 0,
          firstResultUrl: null,
          deleted: true,
          tasks: [],
        }
        groups.set(key, group)
      }
      group.tasks.push(task)
      group.taskIds.push(task.id)
      if (task.id < group.representativeId) {
        group.representativeId = task.id
        group.prompt = task.prompt
        group.model = task.model
        group.createdAt = task.createdAt
        group.user = task.user
      }
      group.createdAt = new Date(Math.min(group.createdAt.getTime(), task.createdAt.getTime()))
      if (task.status === "GENERATING") group.running = true
      if (task.deletedAt == null) group.deleted = false
    }

    for (const group of groups.values()) {
      // 席位聚合：按方向分组，同方向内按 order 取最优图（后写覆盖，除非先前成功且当前未成功）
      const directionSeats = new Map<number, Map<number, SplitTaskRow["generatedImages"][number]>>()
      for (const task of group.tasks) {
        const direction = task.directionIndex ?? -1
        let seats = directionSeats.get(direction)
        if (!seats) {
          seats = new Map<number, SplitTaskRow["generatedImages"][number]>()
          directionSeats.set(direction, seats)
        }
        for (const image of task.generatedImages) {
          const previous = seats.get(image.order)
          if (!previous || image.status === "SUCCESS" || previous.status !== "SUCCESS") {
            seats.set(image.order, image)
          }
        }
      }
      const seats = [...directionSeats.values()].flatMap(seatMap => [...seatMap.values()])
      group.seatCount = seats.length
      group.directionCount = directionSeats.size
      const successes = seats.filter(seat => seat.status === "SUCCESS" && seat.url)
      group.successCount = successes.length
      const [first] = [...successes].sort(
        (a, b) => Number(b.adopted) - Number(a.adopted) || a.order - b.order
      )
      group.firstResultUrl = first?.url ?? null
    }

    return [...groups.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ tasks, ...group }) => {
        void tasks
        return group
      })
  }

  private buildVideoWhere(q: GenerationRecordFilterQuery): Prisma.VideoTaskWhereInput {
    const user = this.userWhere(q)
    return {
      source: "platform",
      project: { source: "platform" },
      ...(q.model ? { model: q.model } : {}),
      ...this.createdAtWhere(q),
      ...(user ? { user } : {}),
      ...(q.keyword
        ? {
            OR: [
              { prompt: { contains: q.keyword } },
              { user: { username: { contains: q.keyword } } },
              { user: { phone: { contains: q.keyword } } },
            ],
          }
        : {}),
    }
  }

  /** 分镜视频：model 在 generationParams JSON 里（path+equals 过滤），user 经客户关系链；
   *  prompt 也在 JSON 里无法 LIKE，关键词只匹配用户名/手机号 */
  private buildStoryboardWhere(q: GenerationRecordFilterQuery): Prisma.StoryboardVideoWhereInput {
    const user = this.userWhere(q)
    const customerUser: Prisma.UserWhereInput = { ...(user ?? {}) }
    if (q.keyword) {
      customerUser.OR = [{ username: { contains: q.keyword } }, { phone: { contains: q.keyword } }]
    }
    return {
      ...(q.model ? { generationParams: { path: "$.model", equals: q.model } } : {}),
      ...this.createdAtWhere(q),
      ...(Object.keys(customerUser).length
        ? { storyboard: { production: { project: { customer: { user: customerUser } } } } }
        : {}),
    }
  }

  /** 美妆视频：model/prompt 均为实体列，user 直连 */
  private buildBeautyWhere(q: GenerationRecordFilterQuery): Prisma.BeautyTaskWhereInput {
    const user = this.userWhere(q)
    return {
      ...(q.model ? { model: q.model } : {}),
      ...this.createdAtWhere(q),
      ...(user ? { user } : {}),
      ...(q.keyword
        ? {
            OR: [
              { prompt: { contains: q.keyword } },
              { user: { username: { contains: q.keyword } } },
              { user: { phone: { contains: q.keyword } } },
            ],
          }
        : {}),
    }
  }

  private buildInspirationWhere(
    q: GenerationRecordFilterQuery
  ): Prisma.InspirationSubscriptionWhereInput {
    const user = this.userWhere(q)
    const lastRefreshedAt = this.lastRefreshedAtWhere(q)
    return {
      lastRefreshedAt,
      ...(user ? { user } : {}),
      ...(q.keyword
        ? {
            OR: [
              { name: { contains: q.keyword } },
              { user: { username: { contains: q.keyword } } },
              { user: { phone: { contains: q.keyword } } },
            ],
          }
        : {}),
    }
  }

  private buildRpaWhere(
    q: GenerationRecordFilterQuery,
    mediaTypes: string[]
  ): Prisma.RpaCreationTaskWhereInput {
    const user = this.userWhere(q)
    return {
      mediaType: { in: mediaTypes },
      ...(q.model ? { model: q.model } : {}),
      ...this.createdAtWhere(q),
      ...(user ? { user } : {}),
      ...(q.keyword
        ? {
            OR: [
              { prompt: { contains: q.keyword } },
              { user: { username: { contains: q.keyword } } },
              { user: { phone: { contains: q.keyword } } },
            ],
          }
        : {}),
    }
  }

  private rpaMediaTypes(functionFilter?: QueryGenerationRecordsDto["function"]): string[] {
    if (functionFilter === "IMAGE") return ["IMAGE"]
    if (functionFilter === "VIDEO") return ["VIDEO"]
    if (functionFilter === "INSPIRATION_RADAR") return []
    return ["IMAGE", "VIDEO"]
  }

  /** 组织 / 角色筛选（命中任一则返回 user 关系过滤，否则 undefined） */
  private userWhere(q: GenerationRecordFilterQuery): Prisma.UserWhereInput | undefined {
    if (!q.orgId && !q.roleId) return undefined
    return {
      ...(q.orgId ? { orgs: { some: { orgId: q.orgId } } } : {}),
      ...(q.roleId ? { roles: { some: { roleId: q.roleId } } } : {}),
    }
  }

  /** 时间范围：dateTo 只给日期时按当日末尾闭区间处理 */
  private createdAtWhere(q: GenerationRecordFilterQuery): { createdAt?: Prisma.DateTimeFilter } {
    if (!q.dateFrom && !q.dateTo) return {}
    const createdAt: Prisma.DateTimeFilter = {}
    if (q.dateFrom) createdAt.gte = new Date(q.dateFrom)
    if (q.dateTo) {
      // 纯日期（无时间部分）→ 取下一日 0 点做开区间上界，等价于「含当日」
      const dateOnly = !q.dateTo.includes("T")
      const end = new Date(q.dateTo)
      if (dateOnly) {
        end.setDate(end.getDate() + 1)
        createdAt.lt = end
      } else {
        createdAt.lte = end
      }
    }
    return { createdAt }
  }

  private lastRefreshedAtWhere(q: GenerationRecordFilterQuery): Prisma.DateTimeNullableFilter {
    const lastRefreshedAt: Prisma.DateTimeNullableFilter = { not: null }
    if (q.dateFrom) lastRefreshedAt.gte = new Date(q.dateFrom)
    if (q.dateTo) {
      const dateOnly = !q.dateTo.includes("T")
      const end = new Date(q.dateTo)
      if (dateOnly) {
        end.setDate(end.getDate() + 1)
        lastRefreshedAt.lt = end
      } else {
        lastRefreshedAt.lte = end
      }
    }
    return lastRefreshedAt
  }

  // ==================== 视频积分反查 ====================

  /** 按 UsageLog.meta.taskId 反查每条图片任务的实扣积分（一次任务可能对应多次扣费，累加） */
  private async imageCreditsByTask(rows: VideoCreditRow[]): Promise<Map<number, Decimal>> {
    const map = new Map<number, Decimal>()
    if (!rows.length) return map

    const ids = new Set(rows.map(r => r.id))
    const userIds = [...new Set(rows.map(r => r.userId))]
    const times = rows.map(r => r.createdAt.getTime())
    const gte = new Date(Math.min(...times) - IMAGE_CREDIT_TIME_PADDING_MS)
    const lte = new Date(Math.max(...times) + IMAGE_CREDIT_TIME_PADDING_MS)

    const logs = await this.prisma.usageLog.findMany({
      where: {
        userId: { in: userIds },
        source: { startsWith: IMAGE_SOURCE_PREFIX },
        createdAt: { gte, lte },
      },
      select: { credits: true, meta: true },
    })

    for (const log of logs) {
      const taskId = (log.meta as { taskId?: number } | null)?.taskId
      if (typeof taskId !== "number" || !ids.has(taskId) || log.credits == null) continue
      map.set(taskId, (map.get(taskId) ?? ZERO).plus(log.credits))
    }
    return map
  }

  /** 按 UsageLog.meta.jobId 反查每个 t2i/i2i 任务的实扣积分（一次生成多 item、
   *  多 attempt 流水均盖同一 jobId，累加）。该 source 前缀下 meta.jobId 仅
   *  t2i/i2i 扣费盖（generate 盖数字 taskId、AI 拆图盖 groupId），键型不同互不混淆。 */
  private async imageGenCreditsByJob(
    rows: {
      id: string
      userId: number
      createdAt: Date
    }[]
  ): Promise<Map<string, Decimal>> {
    const map = new Map<string, Decimal>()
    if (!rows.length) return map

    const ids = new Set(rows.map(r => r.id))
    const userIds = [...new Set(rows.map(r => r.userId))]
    const times = rows.map(r => r.createdAt.getTime())
    const gte = new Date(Math.min(...times) - IMAGE_CREDIT_TIME_PADDING_MS)
    const lte = new Date(Math.max(...times) + IMAGE_CREDIT_TIME_PADDING_MS)

    const logs = await this.prisma.usageLog.findMany({
      where: {
        userId: { in: userIds },
        OR: [
          { source: { startsWith: IMAGE_SOURCE_PREFIX } },
          // 车泰斗工作台生图费用（source=chetaidou.image，meta.jobId 精确关联）
          { source: "chetaidou.image" },
        ],
        createdAt: { gte, lte },
      },
      select: { credits: true, meta: true },
    })

    for (const log of logs) {
      const jobId = (log.meta as { jobId?: string } | null)?.jobId
      if (typeof jobId !== "string" || !ids.has(jobId) || log.credits == null) continue
      map.set(jobId, (map.get(jobId) ?? ZERO).plus(log.credits))
    }
    return map
  }

  /**
   * AI 拆图组实扣积分：工作流阶段（aicreative.ai_split）与终态生图（aicreative.image_generate.ai_split）
   * 流水均盖 meta.groupId / meta.taskId，按 groupId 归组累加（含重试任务流水），taskId 兜底匹配。
   */
  private async splitCreditsByGroup(groups: SplitGroupRow[]): Promise<Map<string, Decimal>> {
    const map = new Map<string, Decimal>()
    if (!groups.length) return map

    const userIds = [...new Set(groups.map(g => g.user.id))]
    const times = groups.map(g => g.createdAt.getTime())
    const gte = new Date(Math.min(...times) - IMAGE_CREDIT_TIME_PADDING_MS)
    const lte = new Date(Math.max(...times) + IMAGE_CREDIT_TIME_PADDING_MS)

    const logs = await this.prisma.usageLog.findMany({
      where: {
        userId: { in: userIds },
        OR: [{ source: SPLIT_WORKFLOW_SOURCE }, { source: { startsWith: SPLIT_IMAGE_SOURCE } }],
        createdAt: { gte, lte },
      },
      select: { credits: true, meta: true },
    })

    for (const log of logs) {
      if (log.credits == null) continue
      const meta = log.meta as { taskId?: number; groupId?: string } | null
      const group =
        (meta?.groupId ? groups.find(g => g.groupId === meta.groupId) : undefined) ??
        (typeof meta?.taskId === "number"
          ? groups.find(g => g.taskIds.includes(meta.taskId!))
          : undefined)
      if (!group) continue
      map.set(group.groupId, (map.get(group.groupId) ?? ZERO).plus(log.credits))
    }
    return map
  }

  /** 全部拆图组的实扣积分合计（复用已聚合的组集合，不二次查任务表） */
  private async sumSplitCreditsOfGroups(groups: SplitGroupRow[]): Promise<Decimal> {
    const map = await this.splitCreditsByGroup(groups)
    return [...map.values()].reduce((sum, c) => sum.plus(c), ZERO)
  }

  /** 按 UsageLog.meta.taskId 反查每条视频出片的实扣积分（一次出片对应一条 UsageLog） */
  private async videoCreditsByTask(rows: VideoCreditRow[]): Promise<Map<number, Decimal>> {
    const map = new Map<number, Decimal>()
    if (!rows.length) return map

    const ids = new Set(rows.map(r => r.id))
    const userIds = [...new Set(rows.map(r => r.userId))]
    const times = rows.map(r => r.createdAt.getTime())
    const gte = new Date(Math.min(...times) - VIDEO_CREDIT_TIME_PADDING_MS)
    const lte = new Date(Math.max(...times) + VIDEO_CREDIT_TIME_PADDING_MS)

    const logs = await this.prisma.usageLog.findMany({
      where: {
        userId: { in: userIds },
        source: { startsWith: VIDEO_SOURCE_PREFIX },
        createdAt: { gte, lte },
      },
      select: { credits: true, meta: true },
    })

    for (const log of logs) {
      const meta = log.meta as { taskId?: number; taskType?: string } | null
      // 分镜扣费共用 video-project 前缀且 StoryboardVideo.id 与 VideoTask.id 会撞号，必须排除
      if (meta?.taskType === STORYBOARD_TASK_TYPE) continue
      const taskId = meta?.taskId
      if (typeof taskId !== "number" || !ids.has(taskId) || log.credits == null) continue
      map.set(taskId, (map.get(taskId) ?? ZERO).plus(log.credits))
    }
    return map
  }

  /**
   * 按 UsageLog 反查每条分镜视频的实扣积分。
   * 新流水（source=video-project.*）靠 meta.taskType 鉴别；旧流水（customer.storyboard-video.generate，
   * source 为分镜专属）直接按 meta.taskId 匹配——两类都不会与 VideoTask 混淆。
   */
  private async storyboardCreditsByTask(rows: VideoCreditRow[]): Promise<Map<number, Decimal>> {
    const map = new Map<number, Decimal>()
    if (!rows.length) return map

    const ids = new Set(rows.map(r => r.id))
    const userIds = [...new Set(rows.map(r => r.userId))]
    const times = rows.map(r => r.createdAt.getTime())
    const gte = new Date(Math.min(...times) - STORYBOARD_CREDIT_TIME_PADDING_MS)
    const lte = new Date(Math.max(...times) + STORYBOARD_CREDIT_TIME_PADDING_MS)

    const logs = await this.prisma.usageLog.findMany({
      where: {
        userId: { in: userIds },
        OR: [{ source: { startsWith: VIDEO_SOURCE_PREFIX } }, { source: STORYBOARD_LEGACY_SOURCE }],
        createdAt: { gte, lte },
      },
      select: { source: true, credits: true, meta: true },
    })

    for (const log of logs) {
      const meta = log.meta as { taskId?: number; taskType?: string } | null
      if (log.source === STORYBOARD_LEGACY_SOURCE) {
        // 旧 source 分镜专属，无撞号风险，直接认
      } else if (meta?.taskType !== STORYBOARD_TASK_TYPE) {
        continue
      }
      const taskId = meta?.taskId
      if (typeof taskId !== "number" || !ids.has(taskId) || log.credits == null) continue
      map.set(taskId, (map.get(taskId) ?? ZERO).plus(log.credits))
    }
    return map
  }

  /** 按 UsageLog.meta.taskId 反查每条美妆视频的实扣积分（source 前缀为 BeautyTask 专属） */
  private async beautyCreditsByTask(rows: VideoCreditRow[]): Promise<Map<number, Decimal>> {
    const map = new Map<number, Decimal>()
    if (!rows.length) return map

    const ids = new Set(rows.map(r => r.id))
    const userIds = [...new Set(rows.map(r => r.userId))]
    const times = rows.map(r => r.createdAt.getTime())
    const gte = new Date(Math.min(...times) - BEAUTY_CREDIT_TIME_PADDING_MS)
    const lte = new Date(Math.max(...times) + BEAUTY_CREDIT_TIME_PADDING_MS)

    const logs = await this.prisma.usageLog.findMany({
      where: {
        userId: { in: userIds },
        source: { startsWith: BEAUTY_SOURCE_PREFIX },
        createdAt: { gte, lte },
      },
      select: { credits: true, meta: true },
    })

    for (const log of logs) {
      const taskId = (log.meta as { taskId?: number } | null)?.taskId
      if (typeof taskId !== "number" || !ids.has(taskId) || log.credits == null) continue
      map.set(taskId, (map.get(taskId) ?? ZERO).plus(log.credits))
    }
    return map
  }

  /** 按 UsageLog.meta.taskId 汇总 RPA 任务首次生成及后续失败重试产生的全部实扣积分。 */
  private async rpaCreditsByTask(rows: RpaCreditRow[]): Promise<Map<number, Decimal>> {
    const map = new Map<number, Decimal>()
    if (!rows.length) return map

    const ids = new Set(rows.map(r => r.id))
    const userIds = [...new Set(rows.map(r => r.userId))]
    const starts = rows.map(r => r.createdAt.getTime())
    const ends = rows.map(r => (r.completedAt ?? r.updatedAt).getTime())
    const gte = new Date(Math.min(...starts) - RPA_CREDIT_TIME_PADDING_MS)
    const lte = new Date(Math.max(...ends) + RPA_CREDIT_TIME_PADDING_MS)

    const logs = await this.prisma.usageLog.findMany({
      where: {
        userId: { in: userIds },
        source: RPA_SOURCE,
        createdAt: { gte, lte },
      },
      select: { credits: true, meta: true },
    })

    for (const log of logs) {
      const taskId = (log.meta as { taskId?: number } | null)?.taskId
      if (typeof taskId !== "number" || !ids.has(taskId) || log.credits == null) continue
      map.set(taskId, (map.get(taskId) ?? ZERO).plus(log.credits))
    }
    return map
  }

  /** 按 CreditTransaction.meta.subscriptionId 反查每个灵感雷达订阅最近一次刷新的实扣积分和结果数 */
  private async inspirationCreditsBySubscription(
    rows: InspirationCreditRow[]
  ): Promise<Map<number, InspirationCreditInfo>> {
    const map = new Map<number, InspirationCreditInfo>()
    if (!rows.length) return map

    const ids = new Set(rows.map(r => r.id))
    const userIds = [...new Set(rows.map(r => r.userId))]
    const times = rows.map(r => r.lastRefreshedAt.getTime())
    const gte = new Date(Math.min(...times) - INSPIRATION_CREDIT_TIME_PADDING_MS)
    const lte = new Date(Math.max(...times) + INSPIRATION_CREDIT_TIME_PADDING_MS)

    const logs = await this.prisma.creditTransaction.findMany({
      where: {
        type: CreditTxnType.CONSUME,
        source: INSPIRATION_SOURCE,
        createdAt: { gte, lte },
        OR: [{ userId: { in: userIds } }, { relatedUserId: { in: userIds } }],
      },
      select: { amount: true, meta: true },
    })

    for (const log of logs) {
      const meta = log.meta as { subscriptionId?: number; resultCount?: number } | null
      const subscriptionId = meta?.subscriptionId
      if (typeof subscriptionId !== "number" || !ids.has(subscriptionId)) continue
      const cur = map.get(subscriptionId) ?? { credits: ZERO, resultCount: null }
      map.set(subscriptionId, {
        credits: cur.credits.plus(log.amount),
        resultCount:
          typeof meta?.resultCount === "number" && Number.isFinite(meta.resultCount)
            ? meta.resultCount
            : cur.resultCount,
      })
    }
    return map
  }

  /** 筛选后全部图片任务的实扣积分合计。普通生成行按 meta.taskId 反查；成品入库
   *  快照行（sourceJobId 非空）按源 job 的 meta.jobId 反查——与列表行级口径一致，
   *  且 sumImageGenCredits 的 where 已排除归档 job，两边不双计。 */
  private async sumImageCredits(where: Prisma.GenerationTaskWhereInput): Promise<Decimal> {
    const tasks = await this.audit.generationTask.findMany({
      where,
      select: { id: true, userId: true, createdAt: true, sourceJobId: true },
    })
    const plain = tasks.filter(t => !t.sourceJobId)
    const archived = tasks
      .filter(t => t.sourceJobId)
      .map(t => ({ id: t.sourceJobId!, userId: t.userId, createdAt: t.createdAt }))
    const [byTask, byJob] = await Promise.all([
      this.imageCreditsByTask(plain),
      this.imageGenCreditsByJob(archived),
    ])
    return [...byTask.values(), ...byJob.values()].reduce((sum, c) => sum.plus(c), ZERO)
  }

  /** 筛选后全部 t2i/i2i 任务的实扣积分合计 */
  private async sumImageGenCredits(where: Prisma.ImageGenJobWhereInput): Promise<Decimal> {
    const jobs = await this.audit.imageGenJob.findMany({
      where,
      select: { id: true, userId: true, createdAt: true },
    })
    const map = await this.imageGenCreditsByJob(jobs)
    return [...map.values()].reduce((sum, c) => sum.plus(c), ZERO)
  }

  /** 筛选后全部视频出片的实扣积分合计 */
  private async sumVideoCredits(where: Prisma.VideoTaskWhereInput): Promise<Decimal> {
    const tasks = await this.audit.videoTask.findMany({
      where,
      select: { id: true, userId: true, createdAt: true },
    })
    const map = await this.videoCreditsByTask(tasks)
    return [...map.values()].reduce((sum, c) => sum.plus(c), ZERO)
  }

  /** 筛选后全部分镜视频的实扣积分合计（userId 经 客户→项目→生产→分镜 关系链取） */
  private async sumStoryboardCredits(where: Prisma.StoryboardVideoWhereInput): Promise<Decimal> {
    const tasks = await this.audit.storyboardVideo.findMany({
      where,
      select: {
        id: true,
        createdAt: true,
        storyboard: {
          select: {
            production: {
              select: { project: { select: { customer: { select: { userId: true } } } } },
            },
          },
        },
      },
    })
    const map = await this.storyboardCreditsByTask(
      tasks.map(t => ({
        id: t.id,
        userId: t.storyboard.production.project.customer.userId,
        createdAt: t.createdAt,
      }))
    )
    return [...map.values()].reduce((sum, c) => sum.plus(c), ZERO)
  }

  /** 筛选后全部美妆视频的实扣积分合计 */
  private async sumBeautyCredits(where: Prisma.BeautyTaskWhereInput): Promise<Decimal> {
    const tasks = await this.audit.beautyTask.findMany({
      where,
      select: { id: true, userId: true, createdAt: true },
    })
    const map = await this.beautyCreditsByTask(tasks)
    return [...map.values()].reduce((sum, c) => sum.plus(c), ZERO)
  }

  /** 筛选后全部灵感雷达最近刷新记录的实扣积分合计 */
  private async sumInspirationCredits(
    where: Prisma.InspirationSubscriptionWhereInput
  ): Promise<Decimal> {
    const rows = await this.audit.inspirationSubscription.findMany({
      where,
      select: { id: true, userId: true, lastRefreshedAt: true },
    })
    const map = await this.inspirationCreditsBySubscription(
      rows
        .filter(r => r.lastRefreshedAt != null)
        .map(r => ({ ...r, lastRefreshedAt: r.lastRefreshedAt! }))
    )
    return [...map.values()].reduce((sum, c) => sum.plus(c.credits), ZERO)
  }

  /** 筛选后全部 RPA 图片/视频任务的实扣积分合计。 */
  private async sumRpaCredits(where: Prisma.RpaCreationTaskWhereInput): Promise<Decimal> {
    const rows = await this.audit.rpaCreationTask.findMany({
      where,
      select: {
        id: true,
        userId: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
      },
    })
    const map = await this.rpaCreditsByTask(rows)
    return [...map.values()].reduce((sum, c) => sum.plus(c), ZERO)
  }

  // ==================== 归一 ====================

  private toImageRecord(r: ImageGenerationRecordRow): GenerationRecord {
    const deleted = r.deletedAt != null
    const hit = r.generatedImages.find(i => i.status === "SUCCESS" && i.url)
    return {
      key: `IMAGE:${r.id}`,
      function: "IMAGE",
      id: r.id,
      ...this.userFields(r.user),
      prompt: r.prompt,
      model: r.model,
      modelLabel: this.imageModelLabel(r.model),
      credits: null, // 反查后回填
      status: r.status,
      resultUrl: deleted ? null : (hit?.url ?? null),
      expired: false, // 图片保留策略未定，本期不判失效
      deleted,
      createdAt: r.createdAt,
    }
  }

  /** AI 拆图任务组 → 列表行：一次拆图一行，成功张数按方向席位口径，积分反查后回填 */
  private toSplitGroupRecord(group: SplitGroupRow): GenerationRecord {
    const status = group.running
      ? "GENERATING"
      : group.seatCount > 0 && group.successCount === group.seatCount
        ? "SUCCESS"
        : "FAILED"
    return {
      key: `AI_SPLIT:${group.groupId}`,
      function: "IMAGE",
      id: group.representativeId,
      ...this.userFields(group.user),
      prompt: group.prompt,
      model: group.model,
      modelLabel: this.imageModelLabel(group.model),
      credits: null, // 反查后回填
      status,
      resultUrl: group.deleted ? null : group.firstResultUrl,
      resultCount: group.successCount,
      resultLabel: `成功 ${group.successCount}/${group.seatCount} 张 · ${group.directionCount} 个方向`,
      expired: false,
      deleted: group.deleted,
      createdAt: group.createdAt,
    }
  }

  /** t2i/i2i 任务（ImageGenJob）→ 列表行：独立 key 前缀 IMAGEGEN:（不以 IMAGE:
   *  开头，积分回填分支不互串），id 为 jobId(UUID)；状态映射对外口径；
   *  积分按 UsageLog.meta.jobId 反查后回填。 */
  private toImageGenJobRecord(r: ImageGenJobRecordRow): GenerationRecord {
    // 车泰斗工作台（businessType=CHETAIDOU）：以 item.status=SUCCEEDED 且 fileKey
    // 有值计数；细分状态映射进统一口径（COMPLETED→SUCCESS，PARTIAL→SUCCESS 且
    // label 明示，CANCELLED→CANCELLED，QUEUED/RUNNING/WAITING_RECONCILIATION→
    // GENERATING）
    const isChetaidou = r.businessType === "CHETAIDOU"
    const status = isChetaidou
      ? r.status === "COMPLETED" || r.status === "PARTIAL"
        ? "SUCCESS"
        : r.status === "FAILED"
          ? "FAILED"
          : r.status === "CANCELLED"
            ? "CANCELLED"
            : "GENERATING"
      : r.status === "COMPLETED"
        ? "SUCCESS"
        : r.status === "FAILED"
          ? "FAILED"
          : "GENERATING"
    const done = isChetaidou
      ? r.items.filter(i => i.status === "SUCCEEDED" && i.fileKey)
      : r.items.filter(i => i.status === "SUCCEEDED" && i.url)
    const kindLabel = isChetaidou
      ? "车泰斗素材"
      : r.kind === "TEXT_TO_IMAGE"
        ? "文生图"
        : "图生图"
    return {
      key: `IMAGEGEN:${r.id}`,
      function: "IMAGE",
      id: r.id,
      ...this.userFields(r.user),
      prompt: r.prompt ?? "",
      model: r.model ?? "",
      modelLabel: this.imageModelLabel(r.model ?? ""),
      credits: null, // 反查后回填
      status,
      resultUrl: done[0]?.url ?? null,
      resultCount: done.length,
      resultLabel:
        isChetaidou && r.status === "PARTIAL"
          ? `${kindLabel} · 部分成功 ${done.length}/${r.items.length} 张`
          : `${kindLabel} · 成功 ${done.length}/${r.items.length} 张`,
      expired: false,
      deleted: false,
      createdAt: r.createdAt,
    }
  }

  private toVideoRecord(r: VideoGenerationRecordRow, now: number): GenerationRecord {
    const deleted = r.deletedAt != null
    void now // 为注释保留的 3 天过期逻辑保留入参，恢复时无需调整调用方。
    // 兼容动作复刻分类拆分前以 REFERENCE 模式落库的历史任务。
    // 永久保留后继续返回 expired 字段以兼容前端，但固定为 false。
    const expired = false
    // 原 3 天过期逻辑：
    // const expired =
    //   r.status === "SUCCESS" && now - r.createdAt.getTime() > VIDEO_RETENTION_DAYS * 86_400_000
    return {
      key: `VIDEO:${r.id}`,
      function: "VIDEO",
      id: r.id,
      ...this.userFields(r.user),
      prompt: r.prompt,
      model: r.model,
      modelLabel: r.modelName ?? r.model,
      credits: null, // 反查后回填
      status: r.status,
      // 永久保留后仅在记录已删除时隐藏结果链接，不再因时间超过 3 天置空。
      resultUrl: deleted ? null : r.resultUrl,
      // 原 3 天过期逻辑：
      // resultUrl: deleted || expired ? null : r.resultUrl,
      expired,
      deleted,
      createdAt: r.createdAt,
    }
  }

  /** 分镜视频 JSON 快照读取（generationParams.model / .prompt） */
  private storyboardParams(r: StoryboardVideoRecordRow): {
    model: string | null
    prompt: string | null
  } {
    const params = r.generationParams
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      return { model: null, prompt: null }
    }
    const model = params.model
    const prompt = params.prompt
    return {
      model: typeof model === "string" && model ? model : null,
      prompt: typeof prompt === "string" && prompt ? prompt : null,
    }
  }

  private toStoryboardVideoRecord(r: StoryboardVideoRecordRow): GenerationRecord {
    const deleted = r.deletedAt != null
    const { model, prompt } = this.storyboardParams(r)
    return {
      key: `STORYBOARD_VIDEO:${r.id}`,
      function: "VIDEO",
      id: r.id,
      ...this.userFields(r.storyboard.production.project.customer.user),
      prompt: prompt ?? "（分镜视频）",
      model: model ?? "",
      modelLabel: model ?? "分镜视频",
      credits: null, // 反查后回填
      status: r.status,
      resultUrl: deleted ? null : r.url,
      expired: false,
      deleted,
      createdAt: r.createdAt,
    }
  }

  private toBeautyVideoRecord(r: BeautyVideoRecordRow): GenerationRecord {
    const deleted = r.deletedAt != null
    return {
      key: `BEAUTY_VIDEO:${r.id}`,
      function: "VIDEO",
      id: r.id,
      ...this.userFields(r.user),
      prompt: r.prompt,
      model: r.model,
      modelLabel: r.model,
      credits: null, // 反查后回填
      status: r.status,
      resultUrl: deleted ? null : r.resultUrl,
      expired: false,
      deleted,
      createdAt: r.createdAt,
    }
  }

  /** 按 publicId 统一展示名；跨类别重名时取 id 最小的有效名称，历史停用模型同样解析。 */
  private async gatewayModelLabelMap(models: string[]): Promise<Map<string, string>> {
    const distinct = [...new Set(models.filter(m => m))]
    if (!distinct.length) return new Map()
    const rows = await this.prisma.aiGatewayModel.findMany({
      where: { publicId: { in: distinct } },
      select: { publicId: true, displayName: true },
      orderBy: { id: "asc" },
    })
    const labels = new Map<string, string>()
    for (const row of rows) {
      if (row.displayName.trim() && !labels.has(row.publicId)) {
        labels.set(row.publicId, row.displayName)
      }
    }
    return labels
  }

  private toInspirationRecord(r: {
    id: number
    name: string
    keywords: Prisma.JsonValue
    platforms: Prisma.JsonValue
    lastRefreshedAt: Date
    deletedAt: Date | null
    user: UserRow
    items: { mediaUrl: string; thumbnailUrl: string | null }[]
    _count: { items: number }
  }): GenerationRecord {
    const deleted = r.deletedAt != null
    const keywords = Array.isArray(r.keywords) ? r.keywords.map(String) : []
    const platforms = Array.isArray(r.platforms)
      ? r.platforms
          .filter((p): p is string => typeof p === "string")
          .map(p => INSPIRATION_PLATFORM_LABELS[p] ?? p)
      : []
    const first = r.items[0]
    return {
      key: `INSPIRATION_RADAR:${r.id}`,
      function: "INSPIRATION_RADAR",
      id: r.id,
      ...this.userFields(r.user),
      prompt: keywords.length ? `订阅「${r.name}」: ${keywords.join(", ")}` : `订阅「${r.name}」`,
      model: "APIFY",
      modelLabel: platforms.length ? platforms.join(" / ") : "Apify",
      credits: null,
      status: "SUCCESS",
      resultUrl: deleted ? null : (first?.thumbnailUrl ?? first?.mediaUrl ?? null),
      resultCount: r._count.items,
      resultLabel: this.formatInspirationResultLabel(r._count.items),
      expired: false,
      deleted,
      createdAt: r.lastRefreshedAt,
    }
  }

  private toRpaRecord(r: RpaCreationRecordRow): GenerationRecord {
    const deleted = r.deletedAt != null
    const successes = r.outputs.filter(output => output.status === "SUCCESS" && output.url)
    const isImage = r.mediaType === "IMAGE"
    return {
      key: `RPA_${isImage ? "IMAGE" : "VIDEO"}:${r.id}`,
      function: isImage ? "IMAGE" : "VIDEO",
      id: r.id,
      ...this.userFields(r.user),
      prompt: r.prompt,
      model: r.model,
      modelLabel: RPA_MODEL_LABELS[r.model] ?? r.model,
      credits: null,
      status: r.status,
      resultUrl: deleted ? null : (successes[0]?.url ?? null),
      resultCount: successes.length,
      resultLabel: `成功 ${successes.length}/${r.quantity} ${isImage ? "张" : "条"}`,
      expired: false,
      deleted,
      createdAt: r.createdAt,
    }
  }

  private formatInspirationResultLabel(count: number): string {
    return `抓取 ${count} 张`
  }

  private imageModelLabel(model: string): string {
    return IMAGE_MODEL_LABELS[model] ?? model
  }

  private userFields(user: UserRow) {
    return {
      userId: user.id,
      username: user.username,
      phone: user.phone,
      orgs: user.orgs.map(o => o.org.name),
      roles: user.roles.map(r => ({ name: r.role.name, color: r.role.color })),
    }
  }
}

// 与 USER_SELECT 对应的行类型
type UserRow = {
  id: number
  username: string
  phone: string
  orgs: { org: { name: string } }[]
  roles: { role: { name: string; color: string | null } }[]
}
