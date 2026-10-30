import { modelDisplayNames, videoMetadata } from "../common/utils/generation-metadata"
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common"
import { AiModelExecMode, AiModelModality, Prisma, type VideoTask } from "@prisma/client"
import type { MediaReference, VideoGenerationRequest } from "@zhiqingresearch/ai-ts-sdk"
import { AiGatewayWebhookService } from "../ai-gateway/ai-gateway-webhook.service"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import type { AiGatewayVideoRequestDto } from "../ai-gateway/dto/ai-gateway-model.dto"
import { TaskModerationService, ModerationPendingException, moderationBusinessTimeout } from "../content-moderation/task-moderation.service"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { fixedVideoRequestCredits, sumFixedVideoCredits } from "../usage/video-fixed-pricing"
import {
  CreateMotionControlBatchDto,
  CreateVideoProjectDto,
  QueryVideoProjectDto,
  QueryVideoTaskDto,
  UpdateVideoProjectDto,
  VIDEO_TASK_STATUSES,
  VideoTaskStatsQueryDto,
} from "./video-project.dto"

// TokenLab 时代动作复刻的旧 model 标识，仅用于启动时收口历史在途任务；下个版本可删
const MOTION_CONTROL_LEGACY_MODEL = "kling-motion"
const MOTION_CONTROL_MAX_BATCH_TASKS = 100
// 网关 Schema 要求 prompt 非空，用户未填补充描述时用固定兜底文案
const MOTION_CONTROL_PROMPT_FALLBACK = "动作复刻"
const VIDEO_TASK_TIMEOUT_MS = 30 * 60 * 1000

@Injectable()
export class VideoProjectService implements OnModuleInit {
  private readonly logger = new Logger(VideoProjectService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayProvider,
    private readonly gatewayWebhook: AiGatewayWebhookService,
    private readonly usage: UsageService,
    private readonly moderation: TaskModerationService,
  ) {}

  async onModuleInit(): Promise<void> {
    // 动作复刻已切 AI Gateway，TokenLab 直连轮询不再执行；历史在途任务按失败收口
    // （旧链路仅在成功后扣费，失败不产生账单），避免任务永久停在 GENERATING。
    const swept = await this.prisma.videoTask.updateMany({
      where: { status: "GENERATING", model: MOTION_CONTROL_LEGACY_MODEL },
      data: { status: "FAILED", errorMessage: "动作复刻链路已升级，历史任务已中断" },
    })
    if (swept.count > 0) {
      this.logger.warn(`[动作复刻] 已收口 ${swept.count} 条 TokenLab 时代在途任务`)
    }
  }

  createProject(dto: CreateVideoProjectDto, userId: number) {
    return this.prisma.videoProject.create({
      data: { name: dto.name?.trim() || "未命名项目", userId },
    })
  }

  async findAllProjects(query: QueryVideoProjectDto, userId: number) {
    const { page = 1, pageSize = 10, keyword, type } = query
    const where: Prisma.VideoProjectWhereInput = {
      userId,
      source: "platform",
      ...(type ? { type } : {}),
      ...(keyword ? { name: { contains: keyword } } : {}),
    }
    const [total, rows] = await Promise.all([
      this.prisma.videoProject.count({ where }),
      this.prisma.videoProject.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    const ids = rows.map(project => project.id)
    const grouped = ids.length
      ? await this.prisma.videoTask.groupBy({
          by: ["projectId", "status"],
          where: { projectId: { in: ids }, source: "platform", project: { source: "platform" } },
          _count: { _all: true },
        })
      : []
    const counts = new Map(ids.map(id => [id, { successCount: 0, totalCount: 0 }]))
    for (const row of grouped) {
      const count = counts.get(row.projectId)
      if (!count) continue
      count.totalCount += row._count._all
      if (row.status === "SUCCESS") count.successCount += row._count._all
    }

    return {
      total,
      page,
      pageSize,
      items: rows.map(project => ({ ...project, ...counts.get(project.id) })),
    }
  }

  async findOneProject(id: number, userId: number) {
    let project = await this.prisma.videoProject.findFirst({
      where: { id, userId, source: "platform" },
      include: {
        tasks: { where: { source: "platform", deletedAt: null }, orderBy: { createdAt: "desc" } },
      },
    })
    if (!project) throw new NotFoundException("项目不存在")

    // 读时对账：项目详情轮询时对 GENERATING 行顺带查网关，对账后重读保证计数与状态最新
    const generating = project.tasks.filter(
      task => task.status === "GENERATING" && task.gatewayTaskId
    )
    if (generating.length) {
      await Promise.all(generating.map(task => this.gatewayWebhook.reconcileVideoTaskOnRead(task)))
      project =
        (await this.prisma.videoProject.findFirst({
          where: { id, userId, source: "platform" },
          include: {
            tasks: {
              where: { source: "platform", deletedAt: null },
              orderBy: { createdAt: "desc" },
            },
          },
        })) ?? project
    }
    return {
      ...project,
      tasks: await this.publicTasks(project.tasks),
      successCount: project.tasks.filter(task => task.status === "SUCCESS").length,
      totalCount: project.tasks.length,
    }
  }

  async updateProject(id: number, dto: UpdateVideoProjectDto, userId: number) {
    await this.assertProjectOwned(id, userId)
    return this.prisma.videoProject.update({
      where: { id },
      data: { name: dto.name?.trim() },
    })
  }

  async deleteProject(id: number, userId: number) {
    await this.assertProjectOwned(id, userId)
    const generating = await this.prisma.videoTask.count({
      where: {
        projectId: id,
        source: "platform",
        project: { source: "platform" },
        status: { in: ["GENERATING", "WAITING_MODERATION"] },
      },
    })
    if (generating > 0) throw new BadRequestException("项目存在生成中的视频，请先取消")

    const deletedAt = new Date()
    await this.prisma.$transaction([
      this.prisma.videoTask.updateMany({
        where: {
          projectId: id,
          source: "platform",
          project: { source: "platform" },
          deletedAt: null,
        },
        data: { deletedAt },
      }),
      this.prisma.videoProject.update({ where: { id }, data: { deletedAt } }),
    ])
    return { success: true }
  }

  async createTask(projectId: number, dto: AiGatewayVideoRequestDto, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const model = await this.prisma.aiGatewayModel.findFirst({
      where: {
        publicId: dto.publicId,
        category: dto.category,
        modality: AiModelModality.VIDEO,
        execMode: AiModelExecMode.ASYNC,
        enabled: true,
        gatewayActive: true,
      },
      select: { publicId: true, displayName: true, priceMultiplier: true },
    })
    if (!model) throw new NotFoundException("模型不存在或未启用")

    const request: VideoGenerationRequest = {
      ...dto.params,
      model: model.publicId,
      n: 1,
      callback: true,
    }
    // 固定一口价（积分/秒 × 分辨率档）：请求带分辨率且配了该档（时长 0/缺失按 1 秒保底）→ 免调网关按精确积分
    // 预检（不打折口径，与终态固定价扣费同源）；未配置/自动档（缺分辨率或时长）→
    // 回落网关估价 × 倍率的保守上限预检
    const fixedCredits = await fixedVideoRequestCredits(
      this.usage,
      model.publicId,
      dto.category,
      request
    )
    if (fixedCredits) {
      await this.usage.assertExactCreditsAffordable(userId, fixedCredits)
    }

    const references = this.referenceSnapshots(request)
    const task = await this.prisma.videoTask.create({
      data: {
        projectId,
        userId,
        mode: dto.category,
        model: model.publicId,
        modelName: model.displayName,
        prompt: request.prompt.trim(),
        durationSec: request.duration_seconds ?? 0,
        aspectRatio: request.aspect_ratio ?? null,
        resolution: request.resolution ?? null,
        generateAudio: request.generate_audio ?? false,
        keepSourceAudio: request.keep_source_audio ?? false,
        firstFrameUrl: this.referenceUrl(request.first_frame),
        lastFrameUrl: this.referenceUrl(request.last_frame),
        refMaterials: references.length ? (references as Prisma.InputJsonValue) : Prisma.JsonNull,
        generationParams: request as unknown as Prisma.InputJsonValue,
        status: "WAITING_MODERATION",
      },
    })

    let gatewayTask
    try {
      gatewayTask = await this.gateway.createVideoTask(request, `video-task:${task.id}`)
    } catch (error) {
      if (error instanceof ModerationPendingException) return this.findOneTask(task.id, userId)
      this.logger.error(
        `[VideoTask] Gateway 提交失败 task=${task.id}: ${error instanceof Error ? error.message : String(error)}`
      )
      // 仅网关明确拒绝（400/404 参数不合法/模型下架）才终态化并抛给用户；
      // 429/401/403/5xx/超时视为瞬态或结果不确定，保留 GENERATING 等启动恢复按幂等键重提
      if (!(error instanceof BadRequestException)) {
        return (await this.publicTasks([task]))[0]
      }
      await this.prisma.videoTask.updateMany({
        where: { id: task.id, status: { in: ["GENERATING", "WAITING_MODERATION"] }, deletedAt: null },
        data: {
          status: "FAILED",
          errorMessage: "AI Gateway 视频任务提交失败",
        },
      })
      throw error
    }

    const updated = await this.prisma.videoTask.update({
      where: { id: task.id },
      data: { gatewayTaskId: gatewayTask.id },
    })
    try {
      await this.gatewayWebhook.applyVideoTask(gatewayTask)
    } catch (error) {
      this.logger.error(
        `[VideoTask] Gateway 初始状态处理失败 task=${task.id}: ${(error as Error).message}`
      )
    }
    this.logger.log(
      `[VideoTask] Gateway 任务已提交 task=${task.id} gatewayTask=${gatewayTask.id} model=${model.publicId}`
    )
    return (await this.publicTasks([updated]))[0]
  }

  async createMotionControlBatch(
    projectId: number,
    dto: CreateMotionControlBatchDto,
    userId: number
  ) {
    await this.assertProjectOwned(projectId, userId)
    const total = dto.actionVideos.length * dto.targetImages.length
    if (total > MOTION_CONTROL_MAX_BATCH_TASKS) {
      throw new BadRequestException(`动作复刻单次最多提交 ${MOTION_CONTROL_MAX_BATCH_TASKS} 条任务`)
    }
    // 不绑死具体模型：按类别取唯一启用的 MOTION_CONTROL 视频模型，换模型只需改 AiGatewayModel 目录
    const model = await this.prisma.aiGatewayModel.findFirst({
      where: {
        category: "MOTION_CONTROL",
        modality: AiModelModality.VIDEO,
        execMode: AiModelExecMode.ASYNC,
        enabled: true,
        gatewayActive: true,
      },
      orderBy: { sortOrder: "asc" },
      select: { publicId: true, displayName: true, priceMultiplier: true },
    })
    if (!model) throw new NotFoundException("动作复刻模型不存在或未启用")

    // 网关约束：恰好 1 张目标图 + 1 条动作视频，时长跟随动作视频，分辨率 720p/1080p
    const motionResolution = dto.resolution ?? "1080p"
    const characterOrientation = dto.characterOrientation ?? "video"
    if (characterOrientation === "image") {
      const tooLong = dto.actionVideos.filter(video => video.durationSec > 10)
      if (tooLong.length) {
        throw new BadRequestException(
          `以目标图朝向为主时动作视频最长 10 秒：${tooLong.map(video => video.name).join("、")}`
        )
      }
    }
    const jobs = dto.actionVideos.flatMap(actionVideo =>
      dto.targetImages.map(targetImage => ({
        actionVideo,
        targetImage,
        request: {
          model: model.publicId,
          prompt: dto.prompt?.trim() || MOTION_CONTROL_PROMPT_FALLBACK,
          mode: "motion_control",
          duration_seconds: actionVideo.durationSec,
          resolution: motionResolution,
          // Kling V2.6 契约：音轨生成只允许关闭，保留动作视频原音轨
          generate_audio: false,
          keep_source_audio: true,
          character_orientation: characterOrientation,
          reference_images: [{ url: normalizeUrl(targetImage.url) }],
          reference_videos: [{ url: normalizeUrl(actionVideo.url) }],
          n: 1,
          callback: true,
        } as VideoGenerationRequest,
      }))
    )
    // 固定一口价（积分/秒 × 分辨率档）：配了该档（时长 0/缺失按 1 秒保底）→ 免调网关按精确积分
    // 预检（不打折口径，与终态固定价扣费同源）；未配置/时长缺失 → 回落网关估价 × 倍率
    const fixedTotal = sumFixedVideoCredits(
      await Promise.all(
        jobs.map(job =>
          fixedVideoRequestCredits(this.usage, model.publicId, "MOTION_CONTROL", job.request)
        )
      )
    )
    if (fixedTotal) {
      await this.usage.assertExactCreditsAffordable(userId, fixedTotal)
    }

    const tasks: VideoTask[] = []
    for (const job of jobs) {
      tasks.push(
        await this.createMotionTask(projectId, userId, model.displayName, job.request, job)
      )
    }
    return { total, tasks: await this.publicTasks(tasks) }
  }

  async findAllTasks(query: QueryVideoTaskDto, userId: number) {
    const { page = 1, pageSize = 10, projectId, status } = query
    const where: Prisma.VideoTaskWhereInput = {
      userId,
      projectId,
      status,
      source: "platform",
      project: { source: "platform" },
    }
    const [total, items] = await Promise.all([
      this.prisma.videoTask.count({ where }),
      this.prisma.videoTask.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { project: { select: { id: true, name: true } } },
      }),
    ])

    // 读时对账：任务中心轮询时对 GENERATING 行顺带查网关，对账后重读保证返回最新状态
    const generating = items.filter(task => task.status === "GENERATING" && task.gatewayTaskId)
    if (generating.length) {
      await Promise.all(generating.map(task => this.gatewayWebhook.reconcileVideoTaskOnRead(task)))
      const refreshed = await this.prisma.videoTask.findMany({
        where: {
          id: { in: generating.map(task => task.id) },
          source: "platform",
          project: { source: "platform" },
        },
        include: { project: { select: { id: true, name: true } } },
      })
      const byId = new Map(refreshed.map(task => [task.id, task]))
      return {
        total,
        page,
        pageSize,
        items: await this.publicTasks(items.map(task => byId.get(task.id) ?? task)),
      }
    }
    return { total, page, pageSize, items: await this.publicTasks(items) }
  }

  async getTaskStats(query: VideoTaskStatsQueryDto, userId: number) {
    const grouped = await this.prisma.videoTask.groupBy({
      by: ["status"],
      where: {
        userId,
        projectId: query.projectId,
        source: "platform",
        project: { source: "platform" },
      },
      _count: { _all: true },
    })
    const counts = Object.fromEntries(VIDEO_TASK_STATUSES.map(status => [status, 0])) as Record<
      (typeof VIDEO_TASK_STATUSES)[number],
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
    let task = await this.prisma.videoTask.findUnique({
      where: { id: taskId, source: "platform", project: { source: "platform" } },
      include: { project: { select: { id: true, name: true } } },
    })
    if (!task) throw new NotFoundException("任务不存在")
    this.ensureOwner(task.userId, userId)

    if (task.moderationStatus) {
      await this.moderation.refresh(`video-task:${taskId}`)
      task = (await this.prisma.videoTask.findUnique({
        where: { id: taskId, source: "platform", project: { source: "platform" } },
        include: { project: { select: { id: true, name: true } } },
      })) ?? task
    }

    // 读时对账：轮询时顺带查网关真实状态（Gateway 回调丢失时自愈）。
    // 拿到网关权威结论（含仍在 running）时以网关为准，跳过本地墙钟超时。
    const reconciled = await this.gatewayWebhook.reconcileVideoTaskOnRead(task)
    if (reconciled) {
      task =
        (await this.prisma.videoTask.findUnique({
          where: { id: taskId, source: "platform", project: { source: "platform" } },
          include: { project: { select: { id: true, name: true } } },
        })) ?? task
    }

    const timeoutBefore = new Date(Date.now() - VIDEO_TASK_TIMEOUT_MS)
    if (!reconciled && task.status === "GENERATING" && (task.moderationPassedAt ?? task.createdAt) <= timeoutBefore) {
      await this.prisma.videoTask.updateMany({
        where: {
          id: taskId,
          status: "GENERATING",
          ...moderationBusinessTimeout(timeoutBefore),
          deletedAt: null,
        },
        data: { status: "TIMEOUT", errorMessage: "视频生成超时" },
      })
      task =
        (await this.prisma.videoTask.findUnique({
          where: { id: taskId, source: "platform", project: { source: "platform" } },
          include: { project: { select: { id: true, name: true } } },
        })) ?? task
    }
    return (await this.publicTasks([task]))[0]
  }

  async cancelTask(taskId: number, userId: number) {
    const task = await this.assertTaskOwned(taskId, userId)
    if (task.status === "WAITING_MODERATION") {
      const cancelled = await this.prisma.videoTask.updateMany({ where: { id: taskId, userId, status: "WAITING_MODERATION", deletedAt: null }, data: { status: "CANCELLED" } })
      if (!cancelled.count) throw new BadRequestException("任务已进入提交，请刷新后重试取消")
      return this.findOneTask(taskId, userId)
    }
    if (task.status !== "GENERATING") throw new BadRequestException("仅运行中的任务可取消")
    if (!task.gatewayTaskId) throw new BadRequestException("任务正在提交，请稍后取消")

    const gatewayTask = await this.gateway.cancelVideoTask(
      task.gatewayTaskId,
      task.source === "vidflowos" ? "vidflowos" : "platform"
    )
    await this.gatewayWebhook.applyVideoTask(gatewayTask)
    const cancelledTask = await this.prisma.videoTask.findUnique({
      where: { id: taskId, source: "platform", project: { source: "platform" } },
    })
    if (!cancelledTask) throw new NotFoundException("任务不存在")
    return (await this.publicTasks([cancelledTask]))[0]
  }

  async deleteTask(taskId: number, userId: number) {
    const task = await this.assertTaskOwned(taskId, userId)
    if (["GENERATING", "WAITING_MODERATION"].includes(task.status)) {
      throw new BadRequestException("生成中的视频不可删除，请先取消")
    }
    await this.prisma.videoTask.update({
      where: { id: taskId, source: "platform", project: { source: "platform" } },
      data: { deletedAt: new Date() },
    })
    return { success: true }
  }

  async clearInvalidTasks(projectId: number, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const deletedAt = new Date()
    const [cancelled, failed, timeout] = await this.prisma.$transaction([
      this.prisma.videoTask.updateMany({
        where: {
          projectId,
          userId,
          source: "platform",
          project: { source: "platform" },
          status: { in: ["CANCELLED", "CANCELED"] },
          deletedAt: null,
        },
        data: { deletedAt },
      }),
      this.prisma.videoTask.updateMany({
        where: {
          projectId,
          userId,
          source: "platform",
          project: { source: "platform" },
          status: "FAILED",
          deletedAt: null,
        },
        data: { deletedAt },
      }),
      this.prisma.videoTask.updateMany({
        where: {
          projectId,
          userId,
          source: "platform",
          project: { source: "platform" },
          status: "TIMEOUT",
          deletedAt: null,
        },
        data: { deletedAt },
      }),
    ])
    const deletedTotal = cancelled.count + failed.count + timeout.count
    return {
      success: true,
      deletedTotal,
      deletedCancelled: cancelled.count,
      deletedFailed: failed.count,
      deletedTimeout: timeout.count,
      deletedExpired: 0,
    }
  }

  async removeVideos(projectId: number, taskIds: number[], userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const ids = [...new Set(taskIds)]
    const removedCount = await this.prisma.$transaction(async tx => {
      const tasks = await tx.videoTask.findMany({
        where: {
          id: { in: ids },
          projectId,
          userId,
          source: "platform",
          project: { source: "platform" },
          deletedAt: null,
        },
        select: { id: true, status: true },
      })
      if (tasks.length !== ids.length) {
        throw new BadRequestException("部分视频不存在、已被移除或不属于当前项目")
      }
      if (tasks.some(task => ["GENERATING", "WAITING_MODERATION"].includes(task.status))) {
        throw new BadRequestException("生成中的视频不可移除，请先取消或等待生成完成")
      }
      const removed = await tx.videoTask.updateMany({
        where: {
          id: { in: ids },
          projectId,
          userId,
          source: "platform",
          project: { source: "platform" },
          status: { notIn: ["GENERATING", "WAITING_MODERATION"] },
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      })
      if (removed.count !== ids.length) {
        throw new BadRequestException("部分视频已被移除，请刷新后重试")
      }
      return removed.count
    })
    return { success: true, requestedCount: ids.length, removedCount }
  }

  private async createMotionTask(
    projectId: number,
    userId: number,
    displayName: string,
    request: VideoGenerationRequest,
    job: {
      actionVideo: CreateMotionControlBatchDto["actionVideos"][number]
      targetImage: CreateMotionControlBatchDto["targetImages"][number]
    }
  ): Promise<VideoTask> {
    const task = await this.prisma.videoTask.create({
      data: {
        projectId,
        userId,
        mode: "MOTION_CONTROL",
        model: request.model,
        modelName: displayName,
        prompt: request.prompt,
        durationSec: request.duration_seconds ?? 0,
        resolution: request.resolution ?? null,
        generateAudio: request.generate_audio ?? false,
        keepSourceAudio: request.keep_source_audio ?? false,
        refMaterials: [
          { type: "video", url: job.actionVideo.url, name: job.actionVideo.name },
          { type: "image", url: job.targetImage.url, name: job.targetImage.name },
        ],
        generationParams: request as unknown as Prisma.InputJsonValue,
        status: "WAITING_MODERATION",
      },
    })

    try {
      const gatewayTask = await this.gateway.createVideoTask(request, `video-task:${task.id}`)
      const updated = await this.prisma.videoTask.update({
        where: { id: task.id },
        data: { gatewayTaskId: gatewayTask.id },
      })
      try {
        await this.gatewayWebhook.applyVideoTask(gatewayTask)
      } catch (error) {
        this.logger.error(
          `[动作复刻] Gateway 初始状态处理失败 task=${task.id}: ${(error as Error).message}`
        )
      }
      this.logger.log(`[动作复刻] Gateway 任务已提交 task=${task.id} gatewayTask=${gatewayTask.id}`)
      return updated
    } catch (error) {
      if (error instanceof ModerationPendingException) {
        return (await this.prisma.videoTask.findUnique({ where: { id: task.id } })) ?? task
      }
      this.logger.error(
        `[动作复刻] Gateway 提交失败 task=${task.id}: ${error instanceof Error ? error.message : String(error)}`
      )
      // 仅网关明确拒绝（400/404 参数不合法/模型下架）才终态化：单条标记失败，其余批次任务继续提交；
      // 429/401/403/5xx/超时视为瞬态或结果不确定，保留 GENERATING 等启动对账按幂等键重提
      if (!(error instanceof BadRequestException)) {
        return task
      }
      await this.prisma.videoTask.updateMany({
        where: { id: task.id, status: { in: ["GENERATING", "WAITING_MODERATION"] }, deletedAt: null },
        data: { status: "FAILED", errorMessage: "AI Gateway 视频任务提交失败" },
      })
      return { ...task, status: "FAILED", errorMessage: "AI Gateway 视频任务提交失败" }
    }
  }

  private referenceSnapshots(request: VideoGenerationRequest): Prisma.JsonObject[] {
    const refs: Prisma.JsonObject[] = []
    const append = (type: string, values: MediaReference[] | undefined) => {
      values?.forEach((reference, index) =>
        refs.push({ type, name: `${type}${index + 1}`, ...reference })
      )
    }
    append("image", request.reference_images)
    append("video", request.reference_videos)
    append("audio", request.reference_audios)
    return refs
  }

  private referenceUrl(reference?: MediaReference): string | null {
    return reference && "url" in reference ? (reference.url ?? null) : null
  }

  private async publicTasks<T extends { model: string; modelName: string | null; status: string; resultUrl: string | null; updatedAt: Date }>(tasks: T[]) {
    const names = await modelDisplayNames(this.prisma, tasks.map(t => t.model))
    return tasks.map(task => this.toPublicTask(task, names))
  }

  private toPublicTask<
    T extends {
      model: string
      modelName: string | null
      status: string
      resultUrl: string | null
      updatedAt: Date
    },
  >(
    task: T, names: Map<string, string>
  ): Omit<T, "model" | "modelName"> & {
    publicId: string
    displayName: string
    isExpired: boolean
  } & ReturnType<typeof videoMetadata> {
    const { model, modelName, ...data } = task
    return {
      ...data,
      publicId: model,
      displayName: names.get(model) ?? modelName ?? model,
      ...videoMetadata((task as unknown as { generationParams?: unknown }).generationParams, (task as unknown as { deliveryMeta?: unknown }).deliveryMeta),
      isExpired: false,
    }
  }

  private async assertProjectOwned(projectId: number, userId: number) {
    const project = await this.prisma.videoProject.findUnique({
      where: { id: projectId, source: "platform" },
      select: { userId: true },
    })
    if (!project) throw new NotFoundException("项目不存在")
    this.ensureOwner(project.userId, userId)
  }

  private async assertTaskOwned(taskId: number, userId: number) {
    const task = await this.prisma.videoTask.findUnique({
      where: { id: taskId, source: "platform", project: { source: "platform" } },
      select: { userId: true, status: true, gatewayTaskId: true, source: true },
    })
    if (!task) throw new NotFoundException("任务不存在")
    this.ensureOwner(task.userId, userId)
    return task
  }

  private ensureOwner(ownerId: number, userId: number) {
    if (ownerId !== userId) throw new ForbiddenException("无权访问该资源")
  }
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  return /^\[[^\]]+\]\((https?:\/\/[^)]+)\)$/.exec(trimmed)?.[1] ?? trimmed
}
