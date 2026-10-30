import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { AiModelExecMode, AiModelModality, Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import type { VideoGenerationRequest } from "@zhiqingresearch/ai-ts-sdk"
import { AiGatewayWebhookService } from "../ai-gateway/ai-gateway-webhook.service"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import { ModerationPendingException, TaskModerationService } from "../content-moderation/task-moderation.service"
import { moderationSnapshot } from "../content-moderation/task-moderation.service"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { fixedVideoRequestCredits } from "../usage/video-fixed-pricing"

type JsonIn = Prisma.InputJsonValue

/** VidFlowOS 代办提交入参：手机号映射用户 + 完整网关生成参数 */
export interface InternalCreateVideoTaskInput {
  phone: string
  category: string
  request: Omit<VideoGenerationRequest, "model" | "callback" | "n"> & {
    model: string
    callback?: boolean
    n?: number
  }
}

/**
 * VidFlowOS 内部生成代理：生成/预检/扣费全部复用本平台现有链路，
 * 任务行 source="vidflowos"、网关提交用 vidflowos 专属 Key。
 */
@Injectable()
export class InternalGenerationService {
  private readonly logger = new Logger(InternalGenerationService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayProvider,
    private readonly gatewayWebhook: AiGatewayWebhookService,
    private readonly usage: UsageService,
    private readonly moderation: TaskModerationService,
  ) {}

  /** 代提交视频任务：手机号查用户 → 容器项目 → createTask 同款内核（vidflowos Key） */
  async createVideoTask(
    input: InternalCreateVideoTaskInput
  ): Promise<{ taskId: number; status: string }> {
    if (typeof input.category !== "string" || !input.category.trim()) {
      throw new BadRequestException("必须指定视频模型业务分类")
    }
    const category = input.category.trim()
    const user = await this.prisma.user.findUnique({
      where: { phone: input.phone.trim() },
      select: { id: true },
    })
    if (!user) {
      // 对象形式的 message：VidFlowOS 侧从 message.code 识别该错误并转译为「积分账户不存在」
      throw new NotFoundException({ code: "USER_NOT_FOUND" })
    }

    const model = await this.prisma.aiGatewayModel.findFirst({
      where: {
        publicId: input.request.model,
        category,
        modality: AiModelModality.VIDEO,
        execMode: AiModelExecMode.ASYNC,
        enabled: true,
        gatewayActive: true,
      },
      select: { publicId: true, category: true, priceMultiplier: true },
    })
    if (!model) throw new BadRequestException("模型不存在或未启用")

    const request: VideoGenerationRequest = {
      ...input.request,
      model: model.publicId,
      n: 1,
      callback: true,
    }
    const fixedCredits = await fixedVideoRequestCredits(
      this.usage,
      model.publicId,
      category,
      request
    )
    if (fixedCredits !== null) {
      await this.usage.assertExactCreditsAffordable(user.id, fixedCredits)
    }

    const projectId = await this.ensureContainerProject(user.id)
    const task = await this.prisma.videoTask.create({
      data: {
        projectId,
        userId: user.id,
        source: "vidflowos",
        mode: model.category,
        model: model.publicId,
        prompt: request.prompt.trim(),
        durationSec: request.duration_seconds ?? 0,
        aspectRatio: request.aspect_ratio ?? null,
        resolution: request.resolution ?? null,
        generateAudio: request.generate_audio ?? false,
        keepSourceAudio: request.keep_source_audio ?? false,
        firstFrameUrl: request.first_frame?.url ?? null,
        lastFrameUrl: request.last_frame?.url ?? null,
        refMaterials: this.referenceSnapshots(request),
        generationParams: request as unknown as JsonIn,
        status: "WAITING_MODERATION",
      },
    })

    try {
      const gatewayTask = await this.gateway.createVideoTask(
        request,
        `video-task:${task.id}`,
        "vidflowos"
      )
      await this.prisma.videoTask.update({
        where: { id: task.id },
        data: { gatewayTaskId: gatewayTask.id },
      })
      try {
        await this.gatewayWebhook.applyVideoTask(gatewayTask)
      } catch (error) {
        this.logger.error(
          `[内部生成] Gateway 初始状态处理失败 task=${task.id}: ${(error as Error).message}`
        )
      }
      this.logger.log(
        `[内部生成] VidFlowOS 任务已提交 task=${task.id} gatewayTask=${gatewayTask.id} user=${user.id}`
      )
    } catch (error) {
      if (error instanceof ModerationPendingException) {
        const waiting = await this.prisma.videoTask.findUnique({ where: { id: task.id }, select: { status: true } })
        return { taskId: task.id, status: waiting?.status ?? "WAITING_MODERATION" }
      }
      this.logger.error(
        `[内部生成] Gateway 提交失败 task=${task.id}: ${error instanceof Error ? error.message : String(error)}`
      )
      // 与本平台提交同语义：仅网关明确拒绝（400/404）终态化并抛出；
      // 429/5xx/超时保留 GENERATING，等启动恢复按行 source 用 vidflowos Key 重提
      if (error instanceof BadRequestException) {
        await this.prisma.videoTask.updateMany({
          where: { id: task.id, status: { in: ["GENERATING", "WAITING_MODERATION"] }, deletedAt: null },
          data: { status: "FAILED", errorMessage: "AI Gateway 视频任务提交失败" },
        })
        throw error
      }
    }

    const refreshed = await this.prisma.videoTask.findUnique({
      where: { id: task.id },
      select: { status: true },
    })
    return { taskId: task.id, status: refreshed?.status ?? "GENERATING" }
  }

  /** 代办任务查询：GENERATING 时触发读时对账（按行 source 选 Key），返回终态与扣费留痕 */
  async getVideoTask(taskId: number) {
    let task = await this.prisma.videoTask.findFirst({
      where: { id: taskId, source: "vidflowos", deletedAt: null },
    })
    if (!task) throw new NotFoundException("任务不存在")

    if (task.moderationStatus) {
      await this.moderation.refresh(`video-task:${taskId}`)
      task = (await this.prisma.videoTask.findFirst({ where: { id: taskId, source: "vidflowos", deletedAt: null } })) ?? task
    }

    if (task.status === "GENERATING" && task.gatewayTaskId) {
      await this.gatewayWebhook.reconcileVideoTaskOnRead(task)
      task =
        (await this.prisma.videoTask.findFirst({
          where: { id: taskId, source: "vidflowos", deletedAt: null },
        })) ?? task
    }

    // 扣费留痕：终态扣费与任务落库同事务写入 UsageLog（requestId = gateway:{gatewayTaskId}）
    let costCny: Decimal | null = null
    let creditsCharged: Decimal | null = null
    if (task.gatewayTaskId) {
      const usageLog = await this.prisma.usageLog.findUnique({
        where: { requestId: `gateway:${task.gatewayTaskId}` },
        select: { cost: true, credits: true },
      })
      costCny = usageLog?.cost ?? null
      creditsCharged = usageLog?.credits ?? null
    }

    return {
      status: task.status,
      moderationStatus: task.moderationStatus,
      contentModeration: moderationSnapshot(task),
      resultUrl: task.resultUrl,
      errorMessage: task.errorMessage,
      costCny: costCny ? costCny.toString() : null,
      creditsCharged: creditsCharged ? creditsCharged.toString() : null,
      durationSec: task.durationSec,
      resolution: task.resolution,
    }
  }

  /** 代办任务取消：vidflowos Key 调网关取消后走统一终态处理 */
  async cancelVideoTask(taskId: number) {
    const task = await this.prisma.videoTask.findFirst({
      where: { id: taskId, source: "vidflowos", deletedAt: null },
      select: { status: true, gatewayTaskId: true },
    })
    if (!task) throw new NotFoundException("任务不存在")
    if (task.status === "WAITING_MODERATION") {
      const cancelled = await this.prisma.videoTask.updateMany({ where: { id: taskId, source: "vidflowos", status: "WAITING_MODERATION", deletedAt: null }, data: { status: "CANCELLED" } })
      if (!cancelled.count) throw new BadRequestException("任务已进入提交，请刷新后重试取消")
      return { status: "CANCELLED" }
    }
    if (task.status !== "GENERATING") throw new BadRequestException("仅运行中的任务可取消")
    if (!task.gatewayTaskId) throw new BadRequestException("任务正在提交，请稍后取消")

    const gatewayTask = await this.gateway.cancelVideoTask(task.gatewayTaskId, "vidflowos")
    await this.gatewayWebhook.applyVideoTask(gatewayTask)
    const cancelled = await this.prisma.videoTask.findFirst({
      where: { id: taskId },
      select: { status: true },
    })
    return { status: cancelled?.status ?? "CANCELLED" }
  }

  // ==================== 私有 ====================

  /** 容器项目：每个映射用户一个 source=vidflowos 的承载项目（VideoTask.projectId 非空外键） */
  private async ensureContainerProject(userId: number): Promise<number> {
    const existing = await this.prisma.videoProject.findFirst({
      where: { userId, source: "vidflowos", deletedAt: null },
      select: { id: true },
      orderBy: { id: "asc" },
    })
    if (existing) return existing.id
    const created = await this.prisma.videoProject.create({
      data: {
        name: "VidFlowOS 创作任务",
        type: "GENERAL",
        source: "vidflowos",
        userId,
      },
      select: { id: true },
    })
    return created.id
  }

  private referenceSnapshots(request: VideoGenerationRequest): JsonIn {
    const refs: Record<string, unknown>[] = []
    const append = (type: string, values: { url?: string }[] | undefined) => {
      values?.forEach((reference, index) =>
        refs.push({ type, name: `${type}${index + 1}`, ...reference })
      )
    }
    append("image", request.reference_images)
    append("video", request.reference_videos)
    append("audio", request.reference_audios)
    return refs.length ? (refs as unknown as JsonIn) : (Prisma.JsonNull as unknown as JsonIn)
  }
}
