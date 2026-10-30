import { modelDisplayNames, videoMetadata, jsonObject } from "../common/utils/generation-metadata"
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { AiModelExecMode, AiModelModality, Prisma } from "@prisma/client"
import type { VideoGenerationRequest } from "@zhiqingresearch/ai-ts-sdk"
import { randomUUID } from "node:crypto"
import { AiGatewayWebhookService } from "../ai-gateway/ai-gateway-webhook.service"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import { moderationBusinessTimeout } from "../content-moderation/task-moderation.service"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { fixedVideoRequestCredits, sumFixedVideoCredits } from "../usage/video-fixed-pricing"
import {
  BEAUTY_TASK_STATUSES,
  BeautyTaskStatsQueryDto,
  CreateBeautyProjectDto,
  CreateBeautyTaskBatchDto,
  CreateBeautyVideoTaskDto,
  QueryBeautyProjectDto,
  QueryBeautyTaskDto,
  UpdateBeautyProjectDto,
} from "./beauty-workflow.dto"

type JsonIn = Prisma.InputJsonValue

const BEAUTY_MODEL_CATEGORY = "BEAUTY"
const BEAUTY_TASK_TIMEOUT_MS = 30 * 60 * 1000
const SEGMENT_INDEX = {
  BASE_MAKEUP: 1,
  MAKEUP_PROCESS: 2,
  BEFORE_AFTER: 3,
} as const

@Injectable()
export class BeautyWorkflowService {
  private readonly logger = new Logger(BeautyWorkflowService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayProvider,
    private readonly gatewayWebhook: AiGatewayWebhookService,
    private readonly usage: UsageService
  ) {}

  createProject(dto: CreateBeautyProjectDto, userId: number) {
    return this.prisma.beautyProject.create({
      data: { name: dto.name?.trim() || "未命名美妆项目", userId },
    })
  }

  async findAllProjects(query: QueryBeautyProjectDto, userId: number) {
    const { page, pageSize, keyword } = query
    const where: Prisma.BeautyProjectWhereInput = {
      userId,
      ...(keyword ? { name: { contains: keyword } } : {}),
    }
    const [total, projects] = await Promise.all([
      this.prisma.beautyProject.count({ where }),
      this.prisma.beautyProject.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])
    const projectIds = projects.map(project => project.id)
    if (projectIds.length)
      await this.reconcileAndSweep({ userId, projectId: { in: projectIds } })
    const counts = await this.taskCountsByProject(projectIds)
    return {
      total,
      page,
      pageSize,
      items: projects.map(project => ({
        ...project,
        ...this.projectCounts(counts.get(project.id)),
      })),
    }
  }

  async findOneProject(projectId: number, userId: number) {
    const project = await this.assertProjectOwned(projectId, userId)
    await this.reconcileAndSweep({ userId, projectId })
    const counts = await this.taskCountsByProject([projectId])
    return { ...project, ...this.projectCounts(counts.get(projectId)) }
  }

  async updateProject(projectId: number, dto: UpdateBeautyProjectDto, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const name = dto.name.trim()
    if (!name) throw new BadRequestException("项目名称不能为空")
    return this.prisma.beautyProject.update({ where: { id: projectId }, data: { name } })
  }

  async deleteProject(projectId: number, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const generatingCount = await this.prisma.beautyTask.count({
      where: { projectId, status: { in: ["GENERATING", "WAITING_MODERATION"] } },
    })
    if (generatingCount > 0) {
      throw new BadRequestException("项目中有正在生成的任务，请等待任务结束后再删除")
    }

    const now = new Date()
    await this.prisma.$transaction([
      this.prisma.beautyTask.updateMany({
        where: { projectId, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.beautyProject.update({ where: { id: projectId }, data: { deletedAt: now } }),
    ])
    return { success: true }
  }

  async createTaskBatch(projectId: number, dto: CreateBeautyTaskBatchDto, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    this.validateTaskBatch(dto.tasks)

    const digitalHuman = await this.prisma.digitalHuman.findFirst({
      where: { id: dto.digitalHumanId, userId },
      select: {
        id: true,
        name: true,
        portraits: true,
        videos: true,
        voiceDesc: true,
        voiceAudio: true,
        persona: true,
        purposes: true,
        tags: true,
        roleCard: true,
      },
    })
    if (!digitalHuman) throw new BadRequestException("数字人不存在或无权使用")

    const model = await this.prisma.aiGatewayModel.findFirst({
      where: {
        category: BEAUTY_MODEL_CATEGORY,
        modality: AiModelModality.VIDEO,
        execMode: AiModelExecMode.ASYNC,
        enabled: true,
        gatewayActive: true,
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { publicId: true, priceMultiplier: true },
    })
    if (!model) throw new BadRequestException("美妆视频模型未启用")

    const prepared = dto.tasks.map(task => this.prepareTask(task))
    const requests: VideoGenerationRequest[] = prepared.map(task => ({
      model: model.publicId,
      prompt: task.prompt,
      mode: "reference_to_video",
      duration_seconds: task.durationSec,
      aspect_ratio: task.aspectRatio,
      resolution: task.resolution,
      reference_images: task.referenceImageUrls.map(url => ({ url })),
      generate_audio: false,
      n: 1,
      callback: true,
    }))
    // 固定一口价（积分/秒 × 分辨率档）：各请求都带分辨率且配了对应档（时长 0/缺失按 1 秒保底）→ 免调网关按
    // 精确积分预检（不打折口径，与终态固定价扣费同源）；任一未配置/缺档 → 回落网关估价 × 倍率
    const fixedTotal = sumFixedVideoCredits(
      await Promise.all(
        requests.map(request =>
          fixedVideoRequestCredits(this.usage, model.publicId, BEAUTY_MODEL_CATEGORY, request)
        )
      )
    )
    if (fixedTotal) await this.usage.assertExactCreditsAffordable(userId, fixedTotal)
    // 需要外部估价时，在全部素材审核通过后由Gateway提交入口统一预检。

    const digitalHumanSnapshot = {
      sourceId: digitalHuman.id,
      name: digitalHuman.name,
      portraits: digitalHuman.portraits,
      videos: digitalHuman.videos,
      voiceDesc: digitalHuman.voiceDesc,
      voiceAudio: digitalHuman.voiceAudio,
      persona: digitalHuman.persona,
      purposes: digitalHuman.purposes,
      tags: digitalHuman.tags,
      roleCard: digitalHuman.roleCard,
    } as unknown as JsonIn
    const batchKey = randomUUID()
    const tasks = await this.prisma.$transaction(
      prepared.map((task, batchIndex) =>
        this.prisma.beautyTask.create({
          data: {
            projectId,
            userId,
            batchKey,
            batchIndex,
            sourceDigitalHumanId: digitalHuman.id,
            digitalHumanSnapshot,
            beautyInput: {
              ...dto.beautyInput,
              ...(task.makeupKey ? { makeupKey: task.makeupKey } : {}),
              ...(task.makeupName ? { makeupName: task.makeupName } : {}),
              groupIndex: task.groupIndex,
              segmentType: task.segmentType,
              segmentIndex: task.segmentIndex,
            } as JsonIn,
            prompt: task.prompt,
            promptVersion: task.promptVersion,
            model: model.publicId,
            generationParams: requests[batchIndex] as unknown as JsonIn,
            durationSec: task.durationSec,
            aspectRatio: task.aspectRatio,
            resolution: task.resolution,
            generateAudio: false,
            referenceImageUrls: task.referenceImageUrls as JsonIn,
            status: "WAITING_MODERATION",
          },
        })
      )
    )

    tasks.forEach((task, index) => this.startGeneration(task.id, requests[index]))
    return {
      batchKey,
      total: tasks.length,
      message: "任务已开始生成；提交至上游后将无法取消",
      tasks: await this.publicTasks(tasks),
    }
  }

  async findAllTasks(query: QueryBeautyTaskDto, userId: number) {
    const { page, pageSize, projectId, batchKey, status } = query
    const where: Prisma.BeautyTaskWhereInput = { userId, projectId, batchKey, status }
    await this.reconcileAndSweep({ userId, projectId, batchKey })
    const [total, items] = await Promise.all([
      this.prisma.beautyTask.count({ where }),
      this.prisma.beautyTask.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { project: { select: { id: true, name: true } } },
      }),
    ])
    return { total, page, pageSize, items: await this.publicTasks(items) }
  }

  async getTaskStats(query: BeautyTaskStatsQueryDto, userId: number) {
    await this.reconcileAndSweep({ userId, projectId: query.projectId })
    const grouped = await this.prisma.beautyTask.groupBy({
      by: ["status"],
      where: { userId, projectId: query.projectId },
      _count: { _all: true },
    })
    const counts = Object.fromEntries(BEAUTY_TASK_STATUSES.map(status => [status, 0])) as Record<
      (typeof BEAUTY_TASK_STATUSES)[number],
      number
    >
    let total = 0
    for (const row of grouped) {
      total += row._count._all
      if (row.status in counts) counts[row.status as keyof typeof counts] = row._count._all
    }
    return { total, ...counts }
  }

  async findOneTask(taskId: number, userId: number) {
    return (await this.publicTasks([await this.loadTask(taskId, userId)]))[0]
  }

  private async loadTask(taskId: number, userId: number) {
    const task = await this.prisma.beautyTask.findUnique({
      where: { id: taskId },
      include: { project: { select: { id: true, name: true } } },
    })
    if (!task) throw new NotFoundException("美妆任务不存在")
    this.ensureOwner(task.userId, userId)

    // 读时对账：轮询时顺带查网关真实状态（Gateway 回调丢失时自愈）。
    // 拿到网关权威结论（含仍在 running）时以网关为准，跳过本地墙钟超时；对账可能已落终态，重读返回。
    const reconciled = await this.gatewayWebhook.reconcileBeautyVideoOnRead(task)
    if (reconciled) {
      return (
        (await this.prisma.beautyTask.findUnique({
          where: { id: taskId },
          include: { project: { select: { id: true, name: true } } },
        })) ?? task
      )
    }
    const timedOut = await this.timeoutTasks({ id: taskId, userId })
    if (timedOut.count === 0) return task
    return (
      (await this.prisma.beautyTask.findUnique({
        where: { id: taskId },
        include: { project: { select: { id: true, name: true } } },
      })) ?? task
    )
  }

  async cancelTask(taskId: number, userId: number) {
    const task = await this.assertTaskOwned(taskId, userId)
    if (task.status === "WAITING_MODERATION") {
      const cancelled = await this.prisma.beautyTask.updateMany({ where: { id: taskId, userId, status: "WAITING_MODERATION", deletedAt: null }, data: { status: "CANCELLED", finishedAt: new Date() } })
      if (!cancelled.count) throw new BadRequestException("任务已进入提交，请刷新后重试取消")
      return this.findOneTask(taskId, userId)
    }
    if (task.status !== "GENERATING") throw new BadRequestException("仅等待提交的任务可取消")
    if (task.submittedAt || task.gatewayTaskId) {
      throw new BadRequestException("任务已开始生成并提交至上游，暂不支持取消")
    }

    const result = await this.prisma.beautyTask.updateMany({
      where: {
        id: taskId,
        userId,
        status: "GENERATING",
        submittedAt: null,
        gatewayTaskId: null,
      },
      data: { status: "CANCELLED", finishedAt: new Date() },
    })
    if (result.count === 0) {
      throw new BadRequestException("任务已开始生成并提交至上游，暂不支持取消")
    }
    return this.findOneTask(taskId, userId)
  }

  async deleteTask(taskId: number, userId: number) {
    const task = await this.assertTaskOwned(taskId, userId)
    if (["GENERATING", "WAITING_MODERATION"].includes(task.status)) {
      throw new BadRequestException(
        task.submittedAt ? "任务已开始生成，暂不能删除" : "任务正在等待提交，请先取消后再删除"
      )
    }
    await this.prisma.beautyTask.update({
      where: { id: taskId },
      data: { deletedAt: new Date() },
    })
    return { success: true }
  }

  async clearInvalidTasks(projectId: number, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const result = await this.prisma.beautyTask.updateMany({
      where: {
        projectId,
        userId,
        status: { in: ["FAILED", "TIMEOUT", "CANCELLED"] },
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    })
    return { success: true, deletedCount: result.count }
  }

  /** 按 BeautyTask ID 批量软删除生成视频；生成中的任务禁止移除。 */
  async removeVideos(projectId: number, taskIds: number[], userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const ids = [...new Set(taskIds)]

    const result = await this.prisma.$transaction(async tx => {
      const tasks = await tx.beautyTask.findMany({
        where: { id: { in: ids }, projectId, userId, deletedAt: null },
        select: { id: true, status: true },
      })
      if (tasks.length !== ids.length) {
        throw new BadRequestException("部分 Beauty 视频不存在、已被移除或不属于当前项目")
      }
      if (tasks.some(task => ["GENERATING", "WAITING_MODERATION"].includes(task.status))) {
        throw new BadRequestException("生成中的 Beauty 视频不可移除，请等待生成完成")
      }

      const removed = await tx.beautyTask.updateMany({
        where: {
          id: { in: ids },
          projectId,
          userId,
          deletedAt: null,
          status: { notIn: ["GENERATING", "WAITING_MODERATION"] },
        },
        data: { deletedAt: new Date() },
      })
      if (removed.count !== ids.length) {
        throw new BadRequestException("部分 Beauty 视频状态已变化，请刷新后重试")
      }
      return removed.count
    })

    return { success: true, requestedCount: ids.length, removedCount: result }
  }

  private startGeneration(taskId: number, request: VideoGenerationRequest) {
    void this.submitTask(taskId, request).catch((error: Error) =>
      this.logger.error(`[美妆视频] 提交任务异常 task=${taskId}: ${error.message}`)
    )
  }

  private async submitTask(taskId: number, request: VideoGenerationRequest) {
    const claimed = await this.prisma.beautyTask.updateMany({
      where: { id: taskId, status: { in: ["GENERATING", "WAITING_MODERATION"] }, submittedAt: null, deletedAt: null },
      data: { submittedAt: new Date() },
    })
    if (claimed.count === 0) return

    let task
    try {
      task = await this.gateway.createVideoTask(request, `beauty-task:${taskId}`)
    } catch (error) {
      this.logger.error(
        `[美妆视频] Gateway 提交失败 task=${taskId}: ${error instanceof Error ? error.message : String(error)}`
      )
      // 仅网关明确拒绝（400/404 参数不合法/模型下架）才终态化；
      // 429/401/403/5xx/超时视为瞬态或结果不确定，保留 GENERATING 等启动恢复按幂等键重提
      if (!(error instanceof BadRequestException)) return
      await this.prisma.beautyTask.updateMany({
        where: { id: taskId, status: "GENERATING", deletedAt: null },
        data: {
          status: "FAILED",
          errorMessage: "AI Gateway 美妆视频任务提交失败",
          finishedAt: new Date(),
        },
      })
      return
    }

    await this.prisma.beautyTask.updateMany({
      where: { id: taskId, status: "GENERATING", gatewayTaskId: null, deletedAt: null },
      data: { gatewayTaskId: task.id },
    })
    await this.gatewayWebhook.applyVideoTask(task)
    this.logger.log(`[美妆视频] Gateway 任务已提交 task=${taskId} gatewayTask=${task.id}`)
  }

  private timeoutTasks(where: Prisma.BeautyTaskWhereInput, excludeIds?: Set<number>) {
    return this.prisma.beautyTask.updateMany({
      where: {
        ...where,
        status: "GENERATING",
        AND: [where, moderationBusinessTimeout(new Date(Date.now() - BEAUTY_TASK_TIMEOUT_MS))],
        deletedAt: null,
        ...(excludeIds?.size ? { id: { notIn: [...excludeIds] } } : {}),
      },
      data: {
        status: "TIMEOUT",
        errorMessage: "视频生成超时",
        finishedAt: new Date(),
      },
    })
  }

  /**
   * 读时对账 + 墙钟收口（列表/详情/计数共用）：scope 内 GENERATING 行先顺带查网关
   * （Gateway 回调丢失时自愈，2 分钟节流），网关确认仍在跑的行不被本地墙钟超时覆盖。
   */
  private async reconcileAndSweep(scope: Prisma.BeautyTaskWhereInput) {
    const generating = await this.prisma.beautyTask.findMany({
      where: { ...scope, status: "GENERATING", gatewayTaskId: { not: null }, deletedAt: null },
      select: { id: true, status: true, gatewayTaskId: true },
    })
    const authoritative = new Set<number>()
    await Promise.all(
      generating.map(async task => {
        if (await this.gatewayWebhook.reconcileBeautyVideoOnRead(task)) {
          authoritative.add(task.id)
        }
      })
    )
    await this.timeoutTasks(scope, authoritative)
  }

  private prepareTask(task: CreateBeautyVideoTaskDto) {
    const prompt = task.prompt.trim()
    if (!prompt) throw new BadRequestException("视频提示词不能为空")
    const referenceImageUrls = task.referenceImageUrls.map(url => this.normalizeUrl(url))
    if (referenceImageUrls.some(url => !/^https?:\/\//i.test(url))) {
      throw new BadRequestException("参考图必须是有效的 HTTP(S) URL")
    }
    return {
      ...task,
      prompt,
      aspectRatio: task.aspectRatio ?? "9:16",
      resolution: task.resolution ?? "720p",
      referenceImageUrls,
    }
  }

  private validateTaskBatch(tasks: CreateBeautyVideoTaskDto[]) {
    const positions = new Set<string>()
    for (const task of tasks) {
      if (SEGMENT_INDEX[task.segmentType] !== task.segmentIndex) {
        throw new BadRequestException("视频分段类型与顺序不匹配")
      }
      const key = `${task.groupIndex}:${task.segmentIndex}`
      if (positions.has(key)) throw new BadRequestException("同一妆容组内的视频分段不能重复")
      positions.add(key)
    }
  }

  private async taskCountsByProject(projectIds: number[]) {
    if (!projectIds.length) return new Map<number, Map<string, number>>()
    const rows = await this.prisma.beautyTask.groupBy({
      by: ["projectId", "status"],
      where: { projectId: { in: projectIds } },
      _count: { _all: true },
    })
    const result = new Map<number, Map<string, number>>()
    for (const row of rows) {
      const statusCounts = result.get(row.projectId) ?? new Map<string, number>()
      statusCounts.set(row.status, row._count._all)
      result.set(row.projectId, statusCounts)
    }
    return result
  }

  private projectCounts(statusCounts?: Map<string, number>) {
    const taskCount = [...(statusCounts?.values() ?? [])].reduce((sum, count) => sum + count, 0)
    return {
      taskCount,
      generatingCount: statusCounts?.get("GENERATING") ?? 0,
      successCount: statusCounts?.get("SUCCESS") ?? 0,
      failedCount: (statusCounts?.get("FAILED") ?? 0) + (statusCounts?.get("TIMEOUT") ?? 0),
    }
  }

  private withoutPrivatePersona(snapshot: Prisma.JsonValue): Prisma.JsonValue {
    if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") return snapshot
    return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "persona"))
  }

  private async publicTasks<T extends { model: string; generationParams: unknown; deliveryMeta: unknown; digitalHumanSnapshot: Prisma.JsonValue }>(items: T[]) {
    const names = await modelDisplayNames(this.prisma, items.map(i => i.model))
    return items.map(item => ({ ...item, publicId: item.model, displayName: names.get(item.model) ?? item.model,
      mode: jsonObject(item.generationParams).mode ?? null, ...videoMetadata(item.generationParams, item.deliveryMeta),
      digitalHumanSnapshot: this.withoutPrivatePersona(item.digitalHumanSnapshot) }))
  }

  private normalizeUrl(url: string) {
    const trimmed = url.trim()
    const markdownMatch = /^\[[^\]]+\]\((https?:\/\/[^)]+)\)$/.exec(trimmed)
    return markdownMatch?.[1] ?? trimmed
  }

  private async assertProjectOwned(projectId: number, userId: number) {
    const project = await this.prisma.beautyProject.findUnique({ where: { id: projectId } })
    if (!project) throw new NotFoundException("美妆项目不存在")
    this.ensureOwner(project.userId, userId)
    return project
  }

  private async assertTaskOwned(taskId: number, userId: number) {
    const task = await this.prisma.beautyTask.findUnique({ where: { id: taskId } })
    if (!task) throw new NotFoundException("美妆任务不存在")
    this.ensureOwner(task.userId, userId)
    return task
  }

  private ensureOwner(ownerId: number, userId: number) {
    if (ownerId !== userId) throw new ForbiddenException("无权操作该资源")
  }
}
