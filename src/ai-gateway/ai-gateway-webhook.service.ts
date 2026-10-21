import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { InvokeType, Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import {
  type ImageTask,
  type ImageTaskArtifact,
  type TaskWebhookEvent,
  type VideoGenerationRequest,
  type VideoTask,
  verifyWebhookSignature,
} from "@zhiqingresearch/ai-ts-sdk"
import { probeMp4DurationSec } from "../common/utils/video-duration-probe"
import { CREDIT_PER_CNY } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import {
  AiGatewayImageArtifactService,
  type StoredImageArtifact,
} from "./ai-gateway-image-artifact.service"
import {
  AiGatewayImageCallbacksService,
  IMAGE_PIPELINE_IDEMPOTENCY_PREFIX,
  parseImagePipelineIdempotencyKey,
} from "./ai-gateway-image-callbacks.service"
import { AiGatewayProvider } from "./ai-gateway.provider"
import {
  ChetaidouGatewayReceiptService,
  isChetaidouCallRequestId,
} from "./chetaidou-gateway-receipt.service"

interface WebhookHeaders {
  secretVersion?: string
  timestamp?: string
  signature?: string
  eventId?: string
}

interface StoryboardVideoRecoveryRow {
  id: number
  gatewayTaskId: string | null
  generationParams: Prisma.JsonValue | null
}

interface StoryboardVideoCallbackRow extends StoryboardVideoRecoveryRow {
  status: string
  gatewayEventId: string | null
  storyboardId: number
  projectId: number
  userId: number
}

interface BeautyVideoRecoveryRow {
  id: number
  gatewayTaskId: string | null
  generationParams: Prisma.JsonValue | null
  submittedAt: Date | null
}

interface BeautyVideoCallbackRow {
  id: number
  status: string
  gatewayEventId: string | null
  projectId: number
  userId: number
  model: string
  durationSec: number | null
  resolution: string | null
}

@Injectable()
export class AiGatewayWebhookService implements OnModuleInit {
  private readonly logger = new Logger(AiGatewayWebhookService.name)
  /** 读时对账节流：同一行 2 分钟内不重复查网关（进程内 Map，重启由启动恢复兜底） */
  private static readonly VIDEO_READ_RECONCILE_THROTTLE_MS = 2 * 60 * 1000
  /** 各业务行最近一次读时对账成功时间（key = `${kind}:${id}`）；仅在 getTask 成功后记录，失败不节流以保持自愈 */
  private readonly readReconcileAt = new Map<string, number>()

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayProvider,
    private readonly usage: UsageService,
    private readonly artifacts: AiGatewayImageArtifactService,
    private readonly imageCallbacks: AiGatewayImageCallbacksService,
    private readonly chetaidouReceipts: ChetaidouGatewayReceiptService
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all([
      this.recoverVideoTasks(),
      this.recoverStoryboardVideoTasks(),
      this.recoverBeautyVideoTasks(),
      this.recoverImageGenerationTasks(),
    ])
  }

  private async recoverVideoTasks(): Promise<void> {
    const tasks = await this.prisma.videoTask.findMany({
      where: {
        AND: [
          // TIMEOUT 行一并恢复：读时对账连续失败 + 回调丢失会被墙钟标成假超时，
          // 启动对账按网关真实终态翻案（与分镜/美妆两表口径一致）
          {
            OR: [{ status: "GENERATING" }, { status: "TIMEOUT", gatewayEventId: null }],
          },
          { OR: [{ gatewayTaskId: { not: null } }, { gatewayTaskId: null, providerJobId: null }] },
        ],
      },
      select: { id: true, gatewayTaskId: true, generationParams: true, source: true },
    })

    await Promise.all(
      tasks.map(async task => {
        try {
          const keyOwner = this.keyOwnerOf(task.source)
          let gatewayTask: VideoTask
          if (task.gatewayTaskId) {
            gatewayTask = await this.gateway.getTask(task.gatewayTaskId, keyOwner)
          } else {
            const request = this.videoRequest(task.generationParams)
            if (!request) return
            gatewayTask = await this.gateway.createVideoTask(
              request,
              `video-task:${task.id}`,
              keyOwner
            )
            const linked = await this.prisma.videoTask.updateMany({
              where: {
                id: task.id,
                status: { in: ["GENERATING", "TIMEOUT"] },
                gatewayTaskId: null,
                deletedAt: null,
              },
              data: { gatewayTaskId: gatewayTask.id },
            })
            if (linked.count === 0) return
            this.logger.log(
              `[AI Gateway] 启动时恢复任务关联 task=${task.id} gatewayTask=${gatewayTask.id}`
            )
          }
          try {
            await this.applyVideoTask(gatewayTask)
          } catch (error) {
            // 落库/扣费异常不终态化：保持 GENERATING，等待 Gateway 回调重试或下次启动恢复
            this.logger.error(
              `[AI Gateway] 启动恢复状态处理失败 task=${task.id}: ${(error as Error).message}`
            )
          }
        } catch (error) {
          // 仅「未关联任务重新提交被网关明确拒绝」才终态化（模型下架/参数不合法，任务不可能成功）；
          // 已关联任务的 getTask 失败视为瞬态（如网关滚动重启短暂 4xx），保留 GENERATING，
          // 否则会把上游仍在跑、即将成功的任务错杀为 FAILED（回调到达后无法翻案）
          if (task.gatewayTaskId == null && error instanceof BadRequestException) {
            await this.prisma.videoTask.updateMany({
              where: {
                id: task.id,
                status: { in: ["GENERATING", "TIMEOUT"] },
                deletedAt: null,
              },
              data: {
                status: "FAILED",
                errorMessage: "AI Gateway 视频任务恢复失败",
              },
            })
          }
          this.logger.error(
            `[AI Gateway] 启动对账失败 task=${task.id} gatewayTask=${task.gatewayTaskId ?? "未关联"}: ${(error as Error).message}`
          )
        }
      })
    )
  }

  /**
   * 图片创作任务（人像/AI拆图 GenerationTask）启动恢复：扫描已关联网关任务仍卡 GENERATING 的行，
   * 按网关真实终态统一走 applyImageTask 落图+扣费。查询失败视为瞬态，仅告警保留 GENERATING。
   * 未关联网关任务（gatewayTaskId 为空）的提交期卡住不在这里处理：
   * AI拆图由 resumePendingTasks 定时重拾，人像由 PortraitTaskRunner 启动时按幂等键重提交。
   */
  private async recoverImageGenerationTasks(): Promise<void> {
    const tasks = await this.prisma.generationTask.findMany({
      where: { status: "GENERATING", gatewayTaskId: { not: null }, deletedAt: null },
      select: { id: true, gatewayTaskId: true, source: true },
    })

    await Promise.all(
      tasks.map(async task => {
        try {
          const gatewayTask = await this.gateway.getImageTask(
            task.gatewayTaskId!,
            this.keyOwnerOf(task.source)
          )
          await this.applyImageTask(gatewayTask)
        } catch (error) {
          this.logger.error(
            `[AI Gateway] 图片任务启动对账失败 task=${task.id} gatewayTask=${task.gatewayTaskId}: ${(error as Error).message}`
          )
        }
      })
    )
  }

  private async recoverStoryboardVideoTasks(): Promise<void> {
    // deletedAt IS NULL 必须显式写：$queryRaw 不走软删除扩展，
    // 已删分镜的席位不能被重提网关任务（会产生用户不可见却要扣费的出片）
    const tasks = await this.prisma.$queryRaw<StoryboardVideoRecoveryRow[]>`
      SELECT id, taskId AS gatewayTaskId, generationParams
      FROM StoryboardVideo
      WHERE generationParams IS NOT NULL
        AND deletedAt IS NULL
        AND (
          status = 'GENERATING'
          OR (status = 'TIMEOUT' AND gatewayEventId IS NULL)
        )
    `

    await Promise.all(
      tasks.map(async task => {
        try {
          let gatewayTask: VideoTask
          if (task.gatewayTaskId) {
            gatewayTask = await this.gateway.getTask(task.gatewayTaskId)
          } else {
            const request = this.videoRequest(task.generationParams)
            if (!request) return
            gatewayTask = await this.gateway.createVideoTask(request, `storyboard-video:${task.id}`)
            await this.prisma.storyboardVideo.updateMany({
              where: {
                id: task.id,
                status: { in: ["GENERATING", "TIMEOUT"] },
                gatewayTaskId: null,
                deletedAt: null,
              },
              data: { gatewayTaskId: gatewayTask.id },
            })
          }
          try {
            await this.applyVideoTask(gatewayTask)
          } catch (error) {
            // 落库/扣费异常不终态化：保持原状态，等待 Gateway 回调重试或下次启动恢复
            this.logger.error(
              `[AI Gateway] 分镜视频启动恢复状态处理失败 video=${task.id}: ${(error as Error).message}`
            )
          }
        } catch (error) {
          // 仅「未关联任务重新提交被网关明确拒绝」才终态化；已关联任务的查询失败视为瞬态，保留原状态
          if (task.gatewayTaskId == null && error instanceof BadRequestException) {
            await this.prisma.storyboardVideo.updateMany({
              where: {
                id: task.id,
                status: { in: ["GENERATING", "TIMEOUT"] },
                gatewayEventId: null,
              },
              data: { status: "FAILED", errorMessage: "AI Gateway 分镜视频任务恢复失败" },
            })
          }
          this.logger.error(
            `[AI Gateway] 分镜视频启动对账失败 video=${task.id} gatewayTask=${task.gatewayTaskId ?? "未关联"}: ${(error as Error).message}`
          )
        }
      })
    )
  }

  private async recoverBeautyVideoTasks(): Promise<void> {
    const tasks = await this.prisma.$queryRaw<BeautyVideoRecoveryRow[]>`
      SELECT id, providerJobId AS gatewayTaskId, generationParams, submittedAt
      FROM BeautyTask
      WHERE (
          status = 'GENERATING'
          OR (status = 'TIMEOUT' AND (providerJobId IS NOT NULL OR submittedAt IS NOT NULL))
        )
        AND generationParams IS NOT NULL
        AND gatewayEventId IS NULL
    `

    await Promise.all(
      tasks.map(async task => {
        try {
          let gatewayTask: VideoTask
          if (task.gatewayTaskId) {
            gatewayTask = await this.gateway.getTask(task.gatewayTaskId)
          } else {
            const request = this.videoRequest(task.generationParams)
            if (!request) return
            if (!(await this.markBeautyTaskSubmitted(task))) return
            gatewayTask = await this.gateway.createVideoTask(request, `beauty-task:${task.id}`)
            const linked = await this.prisma.beautyTask.updateMany({
              where: {
                id: task.id,
                status: { in: ["GENERATING", "TIMEOUT"] },
                gatewayTaskId: null,
                gatewayEventId: null,
              },
              data: { gatewayTaskId: gatewayTask.id },
            })
            if (linked.count === 0) return
          }
          try {
            await this.applyVideoTask(gatewayTask)
          } catch (error) {
            // 落库/扣费异常不终态化：保持原状态，等待 Gateway 回调重试或下次启动恢复
            this.logger.error(
              `[AI Gateway] 美妆视频启动恢复状态处理失败 task=${task.id}: ${(error as Error).message}`
            )
          }
        } catch (error) {
          // 仅「未关联任务重新提交被网关明确拒绝」才终态化；已关联任务的查询失败视为瞬态，保留原状态
          if (task.gatewayTaskId == null && error instanceof BadRequestException) {
            await this.prisma.beautyTask.updateMany({
              where: {
                id: task.id,
                status: { in: ["GENERATING", "TIMEOUT"] },
                gatewayEventId: null,
              },
              data: {
                status: "FAILED",
                errorMessage: "AI Gateway 美妆视频任务恢复失败",
                finishedAt: new Date(),
              },
            })
          }
          this.logger.error(
            `[AI Gateway] 美妆视频启动对账失败 task=${task.id} gatewayTask=${task.gatewayTaskId ?? "未关联"}: ${(error as Error).message}`
          )
        }
      })
    )
  }

  async receiveWebhook(rawBody: Buffer | undefined, headers: WebhookHeaders): Promise<void> {
    const { secretVersion, timestamp, signature, eventId } = headers
    if (!rawBody || !secretVersion || !/^[1-9]\d*$/.test(secretVersion)) {
      throw new UnauthorizedException("AI Gateway 回调请求头无效")
    }

    const secret = this.config.get<string>(`AI_GATEWAY_CALLBACK_SECRET_V${secretVersion}`)?.trim()
    if (!secret || !timestamp || !signature || !eventId) {
      throw new UnauthorizedException("AI Gateway 回调请求头无效")
    }
    if (!verifyWebhookSignature({ secret, rawBody, timestamp, signature })) {
      throw new UnauthorizedException("AI Gateway 回调签名无效")
    }

    let event: TaskWebhookEvent
    try {
      event = JSON.parse(rawBody.toString("utf8")) as TaskWebhookEvent
    } catch {
      throw new BadRequestException("AI Gateway 回调正文不是有效 JSON")
    }
    if (event?.object !== "event" || event.id !== eventId) {
      throw new UnauthorizedException("AI Gateway 回调事件 ID 不一致")
    }

    const task = event.data?.task
    if (!event.type || !task) throw new BadRequestException("AI Gateway 回调事件格式无效")
    if (event.type !== `${task.object}.${task.status}`) {
      throw new BadRequestException("AI Gateway 回调事件类型不一致")
    }
    switch (task.object) {
      case "video.task":
        await this.applyVideoTask(task, event.id)
        return
      case "image.task":
        // 管线任务终态事件 id 先落库(best-effort 审计,waiter 消费/无 waiter
        // 吞掉两条分支都盖;对分发返回无影响,详见 stampPipelineImageEvent)
        await this.stampPipelineImageEvent(task, event.id)
        // 通用生图管线的进程内 waiter 优先(提交后即注册,hub 分发终态);
        // 未命中再按幂等键前缀识别管线任务 —— waiter 已不在(进程重启/
        // 多副本回调落错副本/晚到回调)的管线任务安静吞掉:管线不走
        // GenerationTask 落库路径,查不到会 503 引发网关重试风暴。
        if (this.imageCallbacks.notify(task)) return
        // 车泰斗调用（chetaidou:call:<uuid>）：先持久化回执（回执落库失败
        // 抛非 2xx 让网关重试），后续转存/结算由 Chetaidou runner/对账处理
        if (isChetaidouCallRequestId(task.request_id)) {
          const persisted = await this.chetaidouReceipts.persistImageTaskReceipt(task, event.id)
          if (!persisted) {
            throw new InternalServerErrorException("车泰斗回调回执落库失败，请重试")
          }
          return
        }
        if (task.request_id?.startsWith(IMAGE_PIPELINE_IDEMPOTENCY_PREFIX)) {
          this.logger.debug(
            `[AI Gateway 回调] 管线图片任务无 waiter(已收敛/晚到),安静跳过 task=${task.id} request_id=${task.request_id}`
          )
          return
        }
        await this.applyImageTask(task, event.id)
        return
      default:
        this.logger.warn(`[AI Gateway 回调] 暂未接入任务类型 object=${task.object}`)
    }
  }

  /** 网关终态失败的原始错误快照（排查用）：errorMessage 保持中文口径，两者并行落库 */
  private gatewayErrorOf(task: VideoTask): Prisma.InputJsonValue | undefined {
    if (!("error" in task) || !task.error) return undefined
    return {
      code: task.error.code ?? null,
      type: task.error.type ?? null,
      message: task.error.message,
      requestId: task.request_id ?? null,
    }
  }

  /** 失败直接透出网关原始错误（Gateway 为自研应用）；无 error 对象时兜底中文 */
  private errorMessageOf(task: VideoTask): string {
    if ("error" in task && task.error?.message) return task.error.message
    return "AI Gateway 视频生成失败"
  }

  /**
   * 金额为 0 时跳过扣费（chargeModel 要求金额 > 0；负数已在 validateUsage 拦截）。
   * 用数值判定而非字符串匹配：网关零金额可能序列化为 "0E-8"/"0.00E0" 等指数形态，正则会漏判
   * 导致终态事务反复回滚、任务永久卡在 GENERATING。
   */
  private isChargeableAmount(amount: string): boolean {
    return !new Decimal(amount).isZero()
  }

  /** 均分为 n 份：前 n-1 份等额、末份吸收除法余量，合计严格等于原值（AI 拆图按张拆扣费记录用） */
  private splitEvenly(total: Decimal, parts: number): Decimal[] {
    if (parts <= 1) return [total]
    const share = total.div(parts)
    return [...Array.from({ length: parts - 1 }, () => share), total.minus(share.mul(parts - 1))]
  }

  /**
   * 读时对账：前端轮询视频任务时顺带查网关拿真实状态，Gateway 回调丢失时自愈。
   * 仅处理已关联网关任务的 GENERATING 行；同一行 2 分钟节流；查询异常吞掉只打日志。
   * 返回 true = 近 2 分钟内拿到过网关权威结论（queued/running 也算），调用方可据此跳过本地墙钟超时。
   */
  async reconcileVideoTaskOnRead(task: {
    id: number
    status: string
    gatewayTaskId: string | null
    source?: string | null
  }): Promise<boolean> {
    return this.reconcileGatewayTaskOnRead("视频任务", task)
  }

  /** 分镜席位视频（StoryboardVideo）读时对账，语义同 reconcileVideoTaskOnRead */
  async reconcileStoryboardVideoOnRead(video: {
    id: number
    status: string
    gatewayTaskId: string | null
  }): Promise<boolean> {
    return this.reconcileGatewayTaskOnRead("分镜视频", video)
  }

  /** 美妆视频（BeautyTask）读时对账，语义同 reconcileVideoTaskOnRead */
  async reconcileBeautyVideoOnRead(task: {
    id: number
    status: string
    gatewayTaskId: string | null
  }): Promise<boolean> {
    return this.reconcileGatewayTaskOnRead("美妆视频", task)
  }

  /**
   * 图片创作任务（人像/AI拆图 GenerationTask）读时对账：前端轮询时主动查网关真实状态，
   * 回调丢失时经同一套 applyImageTask 落图+扣费（CAS/requestId 幂等，与 webhook 并发安全）。
   * 仅处理已关联网关任务的 GENERATING 行；同一行 2 分钟节流；查询异常吞掉只打日志。
   */
  async reconcileImageTaskOnRead(task: {
    id: number
    status: string
    gatewayTaskId: string | null
    source?: string | null
  }): Promise<boolean> {
    if (task.status !== "GENERATING" || !task.gatewayTaskId) return false
    if (!this.gateway.isConfigured()) return false
    const key = `图片任务:${task.id}`
    const now = Date.now()
    const last = this.readReconcileAt.get(key) ?? 0
    if (now - last < AiGatewayWebhookService.VIDEO_READ_RECONCILE_THROTTLE_MS) return true
    try {
      const gatewayTask = await this.gateway.getImageTask(
        task.gatewayTaskId,
        this.keyOwnerOf(task.source)
      )
      this.readReconcileAt.set(key, Date.now())
      await this.applyImageTask(gatewayTask)
      return true
    } catch (error) {
      this.logger.warn(
        `[AI Gateway] 图片任务读时对账失败 id=${task.id} gatewayTask=${task.gatewayTaskId}: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }

  /** 任务行 source → 网关 Key 归属（vidflowos 代办任务用专属 Key 查询/重提，其余走 platform） */
  private keyOwnerOf(source?: string | null): "platform" | "vidflowos" {
    return source === "vidflowos" ? "vidflowos" : "platform"
  }

  /** 三类网关视频行共用的读时对账内核：查网关后统一走 applyVideoTask（按网关任务 ID 自动路由到对应表） */
  private async reconcileGatewayTaskOnRead(
    kind: string,
    row: { id: number; status: string; gatewayTaskId: string | null; source?: string | null }
  ): Promise<boolean> {
    if (row.status !== "GENERATING" || !row.gatewayTaskId) return false
    const key = `${kind}:${row.id}`
    const now = Date.now()
    const last = this.readReconcileAt.get(key) ?? 0
    if (now - last < AiGatewayWebhookService.VIDEO_READ_RECONCILE_THROTTLE_MS) return true
    try {
      const gatewayTask = await this.gateway.getTask(row.gatewayTaskId, this.keyOwnerOf(row.source))
      this.readReconcileAt.set(key, Date.now())
      await this.applyVideoTask(gatewayTask)
      return true
    } catch (error) {
      this.logger.warn(
        `[AI Gateway] ${kind}读时对账失败 id=${row.id} gatewayTask=${row.gatewayTaskId}: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }

  /**
   * 真实时长解析：对产物视频探测一次 MP4 元数据（范围请求解析 mvhd，≤5s，失败 null 不抛错），
   * 探测不到回落本地任务行的请求快照（仅正数）；全未知返回 undefined（调用方不写该列）。
   * 用于网关终态未回传正数 duration_seconds 的场景（自动时长档 / 缺失 / 回传 0）。
   * 仅用于 durationSec 列展示回填，不参与计费口径。
   */
  private async resolveRealDurationSec(
    videoUrl: string | undefined,
    localDurationSec: number | null | undefined,
    deliveryMeta?: { actualDurationSec?: number; durationSource?: string }
  ): Promise<number | undefined> {
    const probed = videoUrl ? await probeMp4DurationSec(videoUrl) : null
    if (probed != null) {
      if (deliveryMeta) {
        deliveryMeta.actualDurationSec = probed
        deliveryMeta.durationSource = "probe"
      }
      return probed
    }
    return typeof localDurationSec === "number" && localDurationSec > 0
      ? localDurationSec
      : undefined
  }

  async applyVideoTask(task: VideoTask, eventId?: string): Promise<boolean> {
    const taskUsage = this.gateway.validateVideoTask(task)
    if (task.status === "queued" || task.status === "running") return false
    const appliedEventId = eventId ?? `task:${task.id}:${task.status}`

    const status = {
      succeeded: "SUCCESS",
      failed: "FAILED",
      canceled: "CANCELLED",
      expired: "TIMEOUT",
    }[task.status]
    const resultUrl = task.status === "succeeded" ? task.result.videos[0].url : null
    if ("error" in task) {
      this.logger.warn(
        `[AI Gateway] 视频任务失败 task=${task.id} status=${task.status} code=${task.error.code} type=${task.error.type}: ${task.error.message}`
      )
    }
    const errorMessage =
      task.status === "failed"
        ? this.errorMessageOf(task)
        : task.status === "canceled"
          ? "视频生成已取消"
          : task.status === "expired"
            ? "视频生成超时"
            : null
    const gatewayError = this.gatewayErrorOf(task)
    const gatewayDurationSec =
      task.status === "succeeded" ? task.result.duration_seconds : undefined
    const resolution = task.status === "succeeded" ? task.result.resolution : undefined
    // 展示回填口径：仅采信正数时长，自动时长档（创建时未指定）/ 网关缺失 / 回传 0 视为未知，
    // CAS 过后探测产物回填真实秒数。只写 durationSec 列供展示，不参与扣费
    let durationSec =
      typeof gatewayDurationSec === "number" && gatewayDurationSec > 0
        ? gatewayDurationSec
        : undefined

    let localTask = await this.findLocalVideoTask(task.id)
    if (!localTask) {
      const storyboardTask = await this.findStoryboardVideoTask(task.id)
      if (storyboardTask) {
        return this.applyStoryboardVideoTask(task, appliedEventId, taskUsage, storyboardTask)
      }
      const beautyTask = await this.findBeautyVideoTask(task.id)
      if (beautyTask) {
        return this.applyBeautyVideoTask(task, appliedEventId, taskUsage, beautyTask)
      }
      await this.recoverVideoTaskAssociation(task)
      localTask = await this.findLocalVideoTask(task.id)
    }
    if (!localTask) {
      await this.recoverStoryboardVideoAssociation(task)
      const storyboardTask = await this.findStoryboardVideoTask(task.id)
      if (storyboardTask) {
        return this.applyStoryboardVideoTask(task, appliedEventId, taskUsage, storyboardTask)
      }
      await this.recoverBeautyVideoAssociation(task)
      const beautyTask = await this.findBeautyVideoTask(task.id)
      if (beautyTask) {
        return this.applyBeautyVideoTask(task, appliedEventId, taskUsage, beautyTask)
      }
      throw new ServiceUnavailableException("AI Gateway 回调任务尚未建立关联")
    }
    if (
      !["GENERATING", "TIMEOUT"].includes(localTask.status) ||
      localTask.gatewayEventId === appliedEventId
    ) {
      return false
    }

    const deliveryMeta = {
      ...(durationSec != null ? { actualDurationSec: durationSec, durationSource: "gateway" } : {}),
      ...(resolution ? { actualResolution: resolution } : {}),
    }

    // 真实时长回填（仅展示，不影响计费）：网关终态未回传正数时长时，对产物视频探测一次
    // MP4 元数据（≤5s，失败返回 null 不抛错），仍拿不到回落本地请求快照；全未知则不写该列。
    // 放在 CAS 判定之后：事件会被去重拒绝时不多发探测请求
    if (task.status === "succeeded" && durationSec == null) {
      durationSec = await this.resolveRealDurationSec(
        task.result.videos[0]?.url,
        localTask.durationSec,
        deliveryMeta
      )
    }

    // 计费口径：该 (model, mode) 在固定价表配了任意档位 → 进入固定价模式：仅 SUCCESS 按
    // 「积分/秒 × 实际时长」精确扣费（exactCredits，不打折不乘倍率；时长 0/缺失按 1 秒保底，
    // 档位缺失回落按量），失败/取消/超时一律不扣；未配置 → 全按量（网关 usage ×
    // priceMultiplier，失败也扣已产生成本）。分辨率/时长优先网关终态回传值，缺省回落本地任务行（创建时的请求快照）；
    // mode 取创建请求快照（网关终态不回显），精确档未命中退通配行
    const fixedPriceMap = await this.usage.gatewayFixedVideoCreditsPerSec(
      localTask.model,
      localTask.mode
    )
    const fixedCharge =
      task.status === "succeeded"
        ? this.pickFixedVideoCharge(
            fixedPriceMap,
            resolution ?? localTask.resolution,
            // 计费时长维持原口径（与探测回填无关）：网关回传值，缺省回落本地请求快照
            gatewayDurationSec ?? localTask.durationSec,
            this.videoRequest(localTask.generationParams)?.mode
          )
        : null
    const skipMeteredCharge = fixedPriceMap != null && task.status !== "succeeded"

    // 价格倍率：网关 usage × 倍率后计费（与前端报价同口径）；meta 留原始金额与倍率供对账
    const priceMultiplier =
      !fixedCharge && !skipMeteredCharge && taskUsage && this.isChargeableAmount(taskUsage.amount)
        ? await this.usage.gatewayPriceMultiplier(localTask.model, localTask.mode)
        : new Decimal(1)

    const applied = await this.prisma.$transaction(
      async tx => {
        const updated = await tx.videoTask.updateMany({
          where: {
            id: localTask.id,
            status: { in: ["GENERATING", "TIMEOUT"] },
            deletedAt: null,
            gatewayEventId: null,
          },
          data: {
            status,
            gatewayEventId: appliedEventId,
            resultUrl,
            errorMessage,
            ...(gatewayError != null ? { gatewayError } : {}),
            ...(task.status === "succeeded" ? { deliveryMeta } : {}),
            ...(durationSec != null ? { durationSec } : {}),
            ...(resolution ? { resolution } : {}),
          },
        })
        if (updated.count === 0) return false

        // source 按业务入口分流：带货（salesWorkflowId 锚定）> 动作复刻（mode）> 通用兜底
        const source =
          localTask.salesWorkflowId != null
            ? "video-project.sales"
            : localTask.mode === "MOTION_CONTROL"
              ? "video-project.motion"
              : "video-project.generate"
        const baseMeta = {
          gatewayTaskId: task.id,
          gatewayEventId: appliedEventId,
          projectId: localTask.projectId,
          taskId: localTask.id,
          mode: localTask.mode,
          ...(localTask.salesWorkflowId != null
            ? { salesWorkflowId: localTask.salesWorkflowId }
            : {}),
          status,
        }
        if (fixedCharge) {
          // 一口价模式：仅 SUCCESS 扣费（失败路径由 skipMeteredCharge 拦下），按
          // 「积分/秒 × 实际时长」精确计费（不打折）
          const credits = fixedCharge.creditsPerSec.mul(fixedCharge.durationSec)
          await this.usage.chargeModelInTransaction(
            tx,
            localTask.userId,
            credits.div(CREDIT_PER_CNY).toString(),
            {
              source,
              model: localTask.model,
              exactCredits: credits.toString(),
              meta: {
                ...baseMeta,
                pricingMode: "fixed",
                fixedCreditsPerSec: fixedCharge.creditsPerSec.toString(),
                durationSec: fixedCharge.durationSec,
                resolution: fixedCharge.resolution,
                ...(fixedCharge.flat ? { flat: true } : {}),
                gatewayAmountCny: taskUsage?.amount ?? "0",
              },
              requestId: `gateway:${task.id}`,
              allowOverdraft: true,
            }
          )
        } else if (!skipMeteredCharge && taskUsage && this.isChargeableAmount(taskUsage.amount)) {
          await this.usage.chargeModelInTransaction(
            tx,
            localTask.userId,
            new Decimal(taskUsage.amount).mul(priceMultiplier).toString(),
            {
              source,
              model: localTask.model,
              meta: {
                ...baseMeta,
                gatewayAmountCny: taskUsage.amount,
                priceMultiplier: priceMultiplier.toString(),
              },
              requestId: `gateway:${task.id}`,
              allowOverdraft: true,
            }
          )
        }
        return true
      },
      { timeout: 15_000 }
    )

    if (applied) {
      this.logger.log(
        `[AI Gateway 回调] task=${task.id} status=${status} usage=${taskUsage?.amount ?? "0"} CNY`
      )
    }
    return applied
  }

  private async applyStoryboardVideoTask(
    task: VideoTask,
    eventId: string,
    taskUsage: ReturnType<AiGatewayProvider["validateVideoTask"]>,
    localTask: StoryboardVideoCallbackRow
  ): Promise<boolean> {
    if (task.status === "queued" || task.status === "running") return false
    if (
      !["GENERATING", "TIMEOUT"].includes(localTask.status) ||
      localTask.gatewayEventId === eventId
    ) {
      return false
    }

    const status = {
      succeeded: "SUCCESS",
      failed: "FAILED",
      canceled: "CANCELLED",
      expired: "TIMEOUT",
    }[task.status]
    const url = task.status === "succeeded" ? task.result.videos[0].url : null
    const errorMessage =
      task.status === "failed"
        ? this.errorMessageOf(task)
        : task.status === "canceled"
          ? "视频生成已取消"
          : task.status === "expired"
            ? "视频生成超时"
            : null
    const gatewayError = this.gatewayErrorOf(task)
    const request = this.videoRequest(localTask.generationParams)
    const succeeded = task.status === "succeeded"

    // 计费口径：同 applyVideoTask——固定价表配了该 (model, STORYBOARD) 任意档位 → 仅 SUCCESS
    // 按「积分/秒 × 实际时长」精确扣费（时长 0/缺失按 1 秒保底，档位缺失回落按量），失败/取消/超时不扣；
    // StoryboardVideo 行不存时长/分辨率，候选取网关终态回传值 → generationParams 请求快照兜底
    const fixedPriceMap = await this.usage.gatewayFixedVideoCreditsPerSec(
      request?.model ?? task.model,
      "STORYBOARD"
    )
    const fixedCharge = succeeded
      ? this.pickFixedVideoCharge(
          fixedPriceMap,
          task.result.resolution ?? request?.resolution,
          task.result.duration_seconds ?? request?.duration_seconds,
          request?.mode
        )
      : null
    const skipMeteredCharge = fixedPriceMap != null && !succeeded

    // 价格倍率：网关 usage × 倍率后计费（与前端报价同口径）；meta 留原始金额与倍率供对账
    const priceMultiplier =
      !fixedCharge && !skipMeteredCharge && taskUsage && this.isChargeableAmount(taskUsage.amount)
        ? await this.usage.gatewayPriceMultiplier(request?.model ?? task.model, "STORYBOARD")
        : new Decimal(1)

    const applied = await this.prisma.$transaction(async tx => {
      const updated = await tx.storyboardVideo.updateMany({
        where: {
          id: localTask.id,
          status: { in: ["GENERATING", "TIMEOUT"] },
          gatewayEventId: null,
          // 软删行不落终态不扣费（删除分镜 = 放弃生成；findStoryboardVideoTask
          // 刻意不过滤软删，让已删行的事件在这里被 CAS 安静拦下而不是 503 重试）
          deletedAt: null,
        },
        data: {
          status,
          url,
          errorMessage,
          ...(gatewayError != null ? { gatewayError } : {}),
          gatewayEventId: eventId,
          ...(succeeded
            ? {
                generationMeta: {
                  actualDurationSec: task.result.duration_seconds ?? null,
                  actualResolution: task.result.resolution ?? null,
                },
              }
            : {}),
        },
      })
      if (updated.count === 0) return false

      if (fixedCharge) {
        // 一口价模式：仅 SUCCESS 扣费（失败路径由 skipMeteredCharge 拦下），精确积分不打折
        const credits = fixedCharge.creditsPerSec.mul(fixedCharge.durationSec)
        await this.usage.chargeModelInTransaction(
          tx,
          localTask.userId,
          credits.div(CREDIT_PER_CNY).toString(),
          {
            source: "video-project.generate",
            model: request?.model ?? task.model,
            exactCredits: credits.toString(),
            meta: {
              gatewayTaskId: task.id,
              gatewayEventId: eventId,
              projectId: localTask.projectId,
              storyboardId: localTask.storyboardId,
              taskId: localTask.id,
              status,
              pricingMode: "fixed",
              fixedCreditsPerSec: fixedCharge.creditsPerSec.toString(),
              durationSec: fixedCharge.durationSec,
              resolution: fixedCharge.resolution,
              ...(fixedCharge.flat ? { flat: true } : {}),
              gatewayAmountCny: taskUsage?.amount ?? "0",
              // 生成记录反查鉴别：StoryboardVideo.id 与 VideoTask.id 独立自增会撞号，
              // source 又同用 video-project 前缀，必须靠该字段区分两条表
              taskType: "storyboard-video",
            },
            requestId: `gateway:${task.id}`,
            allowOverdraft: true,
          }
        )
      } else if (!skipMeteredCharge && taskUsage && this.isChargeableAmount(taskUsage.amount)) {
        await this.usage.chargeModelInTransaction(
          tx,
          localTask.userId,
          new Decimal(taskUsage.amount).mul(priceMultiplier).toString(),
          {
            source: "video-project.generate",
            model: request?.model ?? task.model,
            meta: {
              gatewayTaskId: task.id,
              gatewayEventId: eventId,
              projectId: localTask.projectId,
              storyboardId: localTask.storyboardId,
              taskId: localTask.id,
              status,
              gatewayAmountCny: taskUsage.amount,
              priceMultiplier: priceMultiplier.toString(),
              // 生成记录反查鉴别：StoryboardVideo.id 与 VideoTask.id 独立自增会撞号，
              // source 又同用 video-project 前缀，必须靠该字段区分两条表
              taskType: "storyboard-video",
            },
            requestId: `gateway:${task.id}`,
            allowOverdraft: true,
          }
        )
      }
      return true
    })

    if (applied) {
      this.logger.log(
        `[AI Gateway 分镜回调] task=${task.id} video=${localTask.id} status=${status} usage=${taskUsage?.amount ?? "0"} CNY`
      )
    }
    return applied
  }

  private async applyBeautyVideoTask(
    task: VideoTask,
    eventId: string,
    taskUsage: ReturnType<AiGatewayProvider["validateVideoTask"]>,
    localTask: BeautyVideoCallbackRow
  ): Promise<boolean> {
    if (task.status === "queued" || task.status === "running") return false
    if (
      !["GENERATING", "TIMEOUT"].includes(localTask.status) ||
      localTask.gatewayEventId === eventId
    ) {
      return false
    }

    const status = {
      succeeded: "SUCCESS",
      failed: "FAILED",
      canceled: "CANCELLED",
      expired: "TIMEOUT",
    }[task.status]
    const resultUrl = task.status === "succeeded" ? task.result.videos[0].url : null
    const errorMessage =
      task.status === "failed"
        ? this.errorMessageOf(task)
        : task.status === "canceled"
          ? "视频生成已取消"
          : task.status === "expired"
            ? "视频生成超时"
            : null
    const gatewayError = this.gatewayErrorOf(task)
    const succeeded = task.status === "succeeded"

    // 真实时长回填（仅展示，不影响计费）：同 applyVideoTask——网关未回传正数时长时探测
    // 产物视频，拿不到回落本地快照；全未知则不写该列（保持 null）
    const gatewayDurationSec = succeeded ? task.result.duration_seconds : undefined
    let durationSec: number | undefined =
      typeof gatewayDurationSec === "number" && gatewayDurationSec > 0
        ? gatewayDurationSec
        : undefined
    const deliveryMeta = {
      ...(durationSec != null ? { actualDurationSec: durationSec, durationSource: "gateway" } : {}),
      ...(succeeded && task.result.resolution ? { actualResolution: task.result.resolution } : {}),
    }
    if (succeeded && durationSec == null) {
      durationSec = await this.resolveRealDurationSec(
        resultUrl ?? undefined,
        localTask.durationSec,
        deliveryMeta
      )
    }

    // 计费口径：同 applyVideoTask——固定价表配了该 (model, BEAUTY) 任意档位 → 仅 SUCCESS
    // 按「积分/秒 × 实际时长」精确扣费（时长 0/缺失按 1 秒保底，档位缺失回落按量），失败/取消/超时不扣；
    // 候选取网关终态回传值 → 本地任务行兜底
    const fixedPriceMap = await this.usage.gatewayFixedVideoCreditsPerSec(localTask.model, "BEAUTY")
    const fixedCharge = succeeded
      ? this.pickFixedVideoCharge(
          fixedPriceMap,
          task.result.resolution ?? localTask.resolution,
          // 计费时长维持原口径（与探测回填无关）：网关回传值，缺省回落本地请求快照
          gatewayDurationSec ?? localTask.durationSec
          // 美业模型无 mode 维度，走通配行
        )
      : null
    const skipMeteredCharge = fixedPriceMap != null && !succeeded

    // 价格倍率：网关 usage × 倍率后计费（与前端报价同口径）；meta 留原始金额与倍率供对账
    const priceMultiplier =
      !fixedCharge && !skipMeteredCharge && taskUsage && this.isChargeableAmount(taskUsage.amount)
        ? await this.usage.gatewayPriceMultiplier(localTask.model, "BEAUTY")
        : new Decimal(1)

    const applied = await this.prisma.$transaction(
      async tx => {
        const updated = await tx.beautyTask.updateMany({
          where: {
            id: localTask.id,
            status: { in: ["GENERATING", "TIMEOUT"] },
            gatewayEventId: null,
          },
          data: {
            status,
            resultUrl,
            errorMessage,
            ...(gatewayError != null ? { gatewayError } : {}),
            gatewayEventId: eventId,
            finishedAt: new Date(),
            ...(task.status === "succeeded"
              ? {
                  deliveryMeta,
                  resolution: task.result.resolution,
                  ...(durationSec != null ? { durationSec } : {}),
                }
              : {}),
          },
        })
        if (updated.count === 0) return false

        if (fixedCharge) {
          // 一口价模式：仅 SUCCESS 扣费（失败路径由 skipMeteredCharge 拦下），精确积分不打折
          const credits = fixedCharge.creditsPerSec.mul(fixedCharge.durationSec)
          await this.usage.chargeModelInTransaction(
            tx,
            localTask.userId,
            credits.div(CREDIT_PER_CNY).toString(),
            {
              source: "beauty-workflow.generate",
              model: localTask.model,
              exactCredits: credits.toString(),
              meta: {
                gatewayTaskId: task.id,
                gatewayEventId: eventId,
                projectId: localTask.projectId,
                taskId: localTask.id,
                status,
                pricingMode: "fixed",
                fixedCreditsPerSec: fixedCharge.creditsPerSec.toString(),
                durationSec: fixedCharge.durationSec,
                resolution: fixedCharge.resolution,
                ...(fixedCharge.flat ? { flat: true } : {}),
                gatewayAmountCny: taskUsage?.amount ?? "0",
              },
              requestId: `gateway:${task.id}`,
              allowOverdraft: true,
            }
          )
        } else if (!skipMeteredCharge && taskUsage && this.isChargeableAmount(taskUsage.amount)) {
          await this.usage.chargeModelInTransaction(
            tx,
            localTask.userId,
            new Decimal(taskUsage.amount).mul(priceMultiplier).toString(),
            {
              source: "beauty-workflow.generate",
              model: localTask.model,
              meta: {
                gatewayTaskId: task.id,
                gatewayEventId: eventId,
                projectId: localTask.projectId,
                taskId: localTask.id,
                status,
                gatewayAmountCny: taskUsage.amount,
                priceMultiplier: priceMultiplier.toString(),
              },
              requestId: `gateway:${task.id}`,
              allowOverdraft: true,
            }
          )
        }
        return true
      },
      { timeout: 15_000 }
    )

    if (applied) {
      this.logger.log(
        `[AI Gateway 美妆回调] task=${task.id} beautyTask=${localTask.id} status=${status} usage=${taskUsage?.amount ?? "0"} CNY`
      )
    }
    return applied
  }

  /**
   * 从固定价表中取「积分/秒 × 分辨率档」的计费要素（同步挑选，map 由调用方先行读取）。
   * 时长 0/缺失（自动时长档、网关未回传）按 1 秒保底计——固定价模式不因时长未知回落按量；
   * 档位缺失返回 null，固定价模式下 SUCCESS 缺档回落按量，见各 apply 路径。
   * 带分辨率未命中精确档 → 兜底 `flat` 按次档（flat，不乘时长，与 resolveFixedVideoTier 同口径）。
   * 请求/终态都无分辨率（自适应模型）→ `adaptive` 保留档按次一口价（flat，不乘时长）。
   */
  private pickFixedVideoCharge(
    fixedMap: Map<string, Decimal> | null,
    resolution: string | null | undefined,
    durationSec: number | null | undefined,
    mode?: string | null
  ): {
    creditsPerSec: Decimal
    durationSec: number
    resolution: string
    /** 按次一口价档（flat/adaptive）：durationSec 恒为 1（不乘实际时长） */
    flat: boolean
  } | null {
    if (!fixedMap) return null
    const modeKey = mode?.trim().toLowerCase() ?? ""
    const key = resolution?.trim().toLowerCase()
    if (key) {
      const creditsPerSec = fixedMap.get(`${modeKey}|${key}`) ?? fixedMap.get(`|${key}`)
      if (creditsPerSec) {
        return {
          creditsPerSec,
          durationSec: Math.max(durationSec ?? 0, 1),
          resolution: key,
          flat: false,
        }
      }
      const flat = fixedMap.get(`${modeKey}|flat`) ?? fixedMap.get("|flat")
      if (flat) return { creditsPerSec: flat, durationSec: 1, resolution: "flat", flat: true }
      return null
    }
    const adaptive = fixedMap.get(`${modeKey}|adaptive`) ?? fixedMap.get("|adaptive")
    if (!adaptive) return null
    return { creditsPerSec: adaptive, durationSec: 1, resolution: "adaptive", flat: true }
  }

  private findLocalVideoTask(gatewayTaskId: string) {
    return this.prisma.videoTask.findFirst({
      where: { gatewayTaskId, deletedAt: null },
      select: {
        id: true,
        projectId: true,
        userId: true,
        mode: true,
        model: true,
        salesWorkflowId: true,
        status: true,
        gatewayEventId: true,
        resolution: true,
        durationSec: true,
        generationParams: true,
      },
    })
  }

  private async recoverVideoTaskAssociation(task: VideoTask): Promise<void> {
    const candidates = await this.prisma.videoTask.findMany({
      where: {
        model: task.model,
        status: { in: ["GENERATING", "TIMEOUT"] },
        gatewayTaskId: null,
        providerJobId: null,
        deletedAt: null,
      },
      select: { id: true, generationParams: true, source: true },
      orderBy: { createdAt: "desc" },
    })

    for (const candidate of candidates) {
      const request = this.videoRequest(candidate.generationParams)
      if (!request) continue

      try {
        const recovered = await this.gateway.createVideoTask(
          request,
          `video-task:${candidate.id}`,
          this.keyOwnerOf(candidate.source)
        )
        const linked = await this.prisma.videoTask.updateMany({
          where: {
            id: candidate.id,
            status: { in: ["GENERATING", "TIMEOUT"] },
            gatewayTaskId: null,
            deletedAt: null,
          },
          data: { gatewayTaskId: recovered.id },
        })
        if (linked.count > 0) {
          this.logger.log(
            `[AI Gateway 回调] 恢复任务关联 task=${candidate.id} gatewayTask=${recovered.id}`
          )
        }
        if (recovered.id === task.id) return
      } catch (error) {
        this.logger.warn(
          `[AI Gateway 回调] 恢复任务关联失败 task=${candidate.id}: ${(error as Error).message}`
        )
      }
    }
  }

  private async findStoryboardVideoTask(gatewayTaskId: string) {
    // 不过滤 deletedAt（有意）：软删行的回调仍要路由到这里，由 applyStoryboardVideoTask
    // 的 CAS（deletedAt: null）安静拒绝，避免「已删分镜」事件走 503 陷进网关重试
    const tasks = await this.prisma.$queryRaw<StoryboardVideoCallbackRow[]>`
      SELECT
        video.id,
        video.taskId AS gatewayTaskId,
        video.status,
        video.generationParams,
        video.gatewayEventId,
        video.storyboardId,
        project.id AS projectId,
        customer.userId
      FROM StoryboardVideo video
      JOIN Storyboard storyboard ON storyboard.id = video.storyboardId
      JOIN Production production ON production.id = storyboard.productionId
      JOIN Project project ON project.id = production.projectId
      JOIN Customer customer ON customer.id = project.customerId
      WHERE video.taskId = ${gatewayTaskId}
      LIMIT 1
    `
    return tasks[0] ?? null
  }

  private async recoverStoryboardVideoAssociation(task: VideoTask): Promise<void> {
    // deletedAt IS NULL：已删分镜的席位不参与关联恢复（同 recoverStoryboardVideoTasks）
    const candidates = await this.prisma.$queryRaw<StoryboardVideoRecoveryRow[]>`
      SELECT id, taskId AS gatewayTaskId, generationParams
      FROM StoryboardVideo
      WHERE status IN ('GENERATING', 'TIMEOUT')
        AND taskId IS NULL
        AND generationParams IS NOT NULL
        AND deletedAt IS NULL
      ORDER BY createdAt DESC
    `

    for (const candidate of candidates) {
      const request = this.videoRequest(candidate.generationParams)
      if (!request || request.model !== task.model) continue

      try {
        const recovered = await this.gateway.createVideoTask(
          request,
          `storyboard-video:${candidate.id}`
        )
        await this.prisma.storyboardVideo.updateMany({
          where: {
            id: candidate.id,
            status: { in: ["GENERATING", "TIMEOUT"] },
            gatewayTaskId: null,
            deletedAt: null,
          },
          data: { gatewayTaskId: recovered.id },
        })
        if (recovered.id === task.id) return
      } catch (error) {
        this.logger.warn(
          `[AI Gateway 分镜回调] 恢复任务关联失败 video=${candidate.id}: ${(error as Error).message}`
        )
      }
    }
  }

  private findBeautyVideoTask(gatewayTaskId: string) {
    return this.prisma.$queryRaw<BeautyVideoCallbackRow[]>`
      SELECT id, status, gatewayEventId, projectId, userId, model, durationSec, resolution
      FROM BeautyTask
      WHERE providerJobId = ${gatewayTaskId}
      LIMIT 1
    `.then(tasks => tasks[0] ?? null)
  }

  private async recoverBeautyVideoAssociation(task: VideoTask): Promise<void> {
    const candidates = await this.prisma.$queryRaw<BeautyVideoRecoveryRow[]>`
      SELECT id, providerJobId AS gatewayTaskId, generationParams, submittedAt
      FROM BeautyTask
      WHERE model = ${task.model}
        AND (
          status = 'GENERATING'
          OR (status = 'TIMEOUT' AND submittedAt IS NOT NULL)
        )
        AND providerJobId IS NULL
        AND generationParams IS NOT NULL
        AND gatewayEventId IS NULL
      ORDER BY createdAt DESC
    `

    for (const candidate of candidates) {
      const request = this.videoRequest(candidate.generationParams)
      if (!request) continue

      try {
        if (!(await this.markBeautyTaskSubmitted(candidate))) continue
        const recovered = await this.gateway.createVideoTask(request, `beauty-task:${candidate.id}`)
        await this.prisma.beautyTask.updateMany({
          where: {
            id: candidate.id,
            status: { in: ["GENERATING", "TIMEOUT"] },
            gatewayTaskId: null,
            gatewayEventId: null,
          },
          data: { gatewayTaskId: recovered.id },
        })
        if (recovered.id === task.id) return
      } catch (error) {
        this.logger.warn(
          `[AI Gateway 美妆回调] 恢复任务关联失败 task=${candidate.id}: ${(error as Error).message}`
        )
      }
    }
  }

  private async markBeautyTaskSubmitted(task: BeautyVideoRecoveryRow): Promise<boolean> {
    if (task.submittedAt) return true
    const result = await this.prisma.beautyTask.updateMany({
      where: {
        id: task.id,
        status: { in: ["GENERATING", "TIMEOUT"] },
        gatewayTaskId: null,
        gatewayEventId: null,
        submittedAt: null,
      },
      data: { submittedAt: new Date() },
    })
    return result.count > 0
  }

  /** 管线(imggen: 前缀)图片终态事件审计落库:按幂等键回解业务行,写
   *  GeneratedImage / ImageGenItem 的 gatewayEventId(同图重试覆盖最新终态);
   *  generate 单席位任务(attempt=0 且仅 1 图)同时盖任务行。此列为纯观测 ——
   *  结算幂等闸门仍是执行器 CAS settle + 网关 requestId 幂等键,且 imggen:
   *  回调在 applyImageTask 之前就被吞掉,不会误触老路径的 gatewayEventId 幂等。
   *  非管线事件/非终态事件/形状不符直接 no-op;失败仅记日志,不影响分发。 */
  private async stampPipelineImageEvent(task: ImageTask, eventId: string): Promise<void> {
    try {
      if (task.status === "queued" || task.status === "running") return
      const parsed = task.request_id ? parseImagePipelineIdempotencyKey(task.request_id) : null
      if (!parsed) return
      const { owner, childId, attemptNo } = parsed
      if (/^\d+$/.test(owner)) {
        // generate 管线:owner = GenerationTask.id(数字),child = GeneratedImage.id
        await this.prisma.generatedImage.updateMany({
          where: { id: childId, taskId: Number(owner) },
          data: { gatewayEventId: eventId },
        })
        if (attemptNo === 0) {
          const seats = await this.prisma.generatedImage.count({
            where: { taskId: Number(owner) },
          })
          if (seats === 1) {
            await this.prisma.generationTask.updateMany({
              where: { id: Number(owner) },
              data: { gatewayEventId: eventId },
            })
          }
        }
      } else {
        // t2i/i2i:owner = ImageGenJob.id(UUID),child = ImageGenItem.id
        await this.prisma.imageGenItem.updateMany({
          where: { id: childId, jobId: owner },
          data: { gatewayEventId: eventId },
        })
      }
    } catch (err) {
      this.logger.warn(
        `[AI Gateway 回调] 管线图片事件审计落库失败(不影响分发): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  async applyImageTask(task: ImageTask, eventId?: string): Promise<boolean> {
    const taskUsage = this.gateway.validateImageTask(task)
    if (task.status === "queued" || task.status === "running") return false

    const localTask = await this.prisma.generationTask.findFirst({
      where: {
        gatewayTaskId: task.id,
        deletedAt: null,
      },
      include: {
        generatedImages: {
          where: { deletedAt: null },
          orderBy: [{ order: "asc" }, { id: "asc" }],
        },
      },
    })
    if (!localTask) {
      throw new ServiceUnavailableException("AI Gateway 图片回调任务尚未建立关联")
    }
    // 局部重绘必须由共享执行器交付和扣费，读时恢复不能套用旧人像落图流程。
    if ((localTask.executionSpec as { localRedraw?: unknown } | null)?.localRedraw) return false
    if (localTask.status !== "GENERATING" || localTask.gatewayEventId === eventId) {
      return false
    }

    const artifacts = this.imageArtifacts(task)
    if (artifacts.length > localTask.generatedImages.length) {
      this.logger.warn(
        `[AI Gateway 回调] 图片数量超过本地席位 task=${task.id} outputs=${artifacts.length} slots=${localTask.generatedImages.length}`
      )
    }
    const storedImages = await Promise.all(
      localTask.generatedImages.slice(0, artifacts.length).map((image, index) =>
        this.artifacts.store(
          {
            id: localTask.id,
            userId: localTask.userId,
            projectId: localTask.projectId,
            generationMode: localTask.generationMode,
            deliveryPlan: localTask.deliveryPlan,
            outputFormat: this.promptOutputFormat(localTask.promptConfig),
          },
          image.id,
          artifacts[index]
        )
      )
    )

    const status = {
      succeeded: "SUCCESS",
      failed: "FAILED",
      canceled: "CANCELLED",
      expired: "TIMEOUT",
    }[task.status]
    const errorMessage =
      task.status === "failed"
        ? "AI Gateway 图片生成失败"
        : task.status === "canceled"
          ? "图片生成已取消"
          : task.status === "expired"
            ? "图片生成超时"
            : null
    if ("error" in task) {
      this.logger.warn(
        `[AI Gateway] 图片任务失败 task=${task.id} status=${task.status} code=${task.error.code} type=${task.error.type}: ${task.error.message}`
      )
    }

    // 计费口径：模型目录行配置了固定一口价（fixedCredits，按任务类型取对应类别行，
    // 实时读库改库即生效）→ 按成功张数精确扣费、仅终态 SUCCESS 扣；
    // 未配置 → 现状按量（网关 usage × priceMultiplier，失败也扣已产生成本）
    const pricingCategory =
      localTask.generationMode === "AI_SPLIT"
        ? "AI_SPLIT"
        : localTask.type === "PORTRAIT"
          ? "PORTRAIT"
          : "IMAGE_GENERATION"
    const fixedCredits = await this.usage.gatewayFixedImageCredits(localTask.model, pricingCategory)
    const priceMultiplier =
      !fixedCredits && taskUsage && this.isChargeableAmount(taskUsage.amount)
        ? await this.usage.gatewayPriceMultiplier(localTask.model)
        : new Decimal(1)

    const applied = await this.prisma.$transaction(
      async tx => {
        const deliveryUpdate = this.deliveryPlanUpdate(
          localTask.deliveryPlan,
          storedImages,
          task.adaptation
        )
        const claimed = await tx.generationTask.updateMany({
          where: {
            id: localTask.id,
            gatewayTaskId: task.id,
            status: "GENERATING",
            deletedAt: null,
            ...(eventId ? { gatewayEventId: null } : {}),
          },
          data: {
            status,
            errorMessage,
            ...(localTask.generationMode === "AI_SPLIT" ? { aiSplitStage: status } : {}),
            ...(eventId ? { gatewayEventId: eventId } : {}),
            ...(deliveryUpdate ? { deliveryPlan: deliveryUpdate } : {}),
          },
        })
        if (claimed.count === 0) return false

        for (let index = 0; index < localTask.generatedImages.length; index += 1) {
          const image = localTask.generatedImages[index]
          const storedImage = storedImages[index]
          await tx.generatedImage.updateMany({
            where: { id: image.id, status: "GENERATING", deletedAt: null },
            data: storedImage
              ? {
                  url: storedImage.url,
                  originalUrl: storedImage.originalUrl,
                  status: "SUCCESS",
                  providerJobId: task.id,
                  errorMessage: null,
                  width: storedImage.width,
                  height: storedImage.height,
                  nativeWidth: storedImage.nativeWidth,
                  nativeHeight: storedImage.nativeHeight,
                  deliveryMeta: (task.adaptation
                    ? {
                        ...storedImage.deliveryMeta,
                        gatewayImage: {
                          width: storedImage.nativeWidth,
                          height: storedImage.nativeHeight,
                          adaptation: task.adaptation,
                        },
                      }
                    : storedImage.deliveryMeta) as Prisma.InputJsonValue,
                }
              : {
                  status: this.missingImageStatus(task.status),
                  providerJobId: task.id,
                  errorMessage:
                    task.status === "succeeded" ? "模型返回的图片数量不足" : errorMessage,
                },
          })
        }

        const invokeType = localTask.source === "vidflowos" ? InvokeType.API : InvokeType.PLATFORM
        // source 按任务类型分流：AI拆图组独立计费统计，人像创作与通用生图区分子来源
        const source =
          localTask.generationMode === "AI_SPLIT"
            ? "aicreative.image_generate.ai_split"
            : localTask.type === "PORTRAIT"
              ? "aicreative.image_generate.portrait"
              : "aicreative.image_generate"
        // AI 拆图按张出扣费记录：一次出多张图时每张一条（每条 requestId 以
        // gatewayTaskId:imageId 幂等；重试出图是新的网关任务，不会撞键）；
        // 人像/通用生图维持整任务一笔
        const perImageBilling = localTask.generationMode === "AI_SPLIT"
        if (fixedCredits) {
          // 一口价按实际成功落图张数计费（不打折）：AI 拆图任何终态都如此——
          // 部分失败（终态 FAILED/CANCELLED/TIMEOUT 但落了部分图）只收成功落图
          // 张数的钱，失败/未落图的不收；人像/通用生图维持仅终态 SUCCESS 扣费
          if ((status === "SUCCESS" || perImageBilling) && storedImages.length > 0) {
            if (!perImageBilling) {
              const credits = fixedCredits.mul(storedImages.length)
              await this.usage.chargeModelInTransaction(
                tx,
                localTask.userId,
                credits.div(CREDIT_PER_CNY).toString(),
                {
                  source,
                  invokeType,
                  model: localTask.model,
                  exactCredits: credits.toString(),
                  meta: {
                    gatewayTaskId: task.id,
                    gatewayEventId: eventId,
                    projectId: localTask.projectId,
                    taskId: localTask.id,
                    type: localTask.type,
                    status,
                    pricingMode: "fixed",
                    fixedCredits: fixedCredits.toString(),
                    successCount: storedImages.length,
                    gatewayAmountCny: taskUsage?.amount ?? "0",
                  },
                  requestId: `gateway:${task.id}`,
                  allowOverdraft: true,
                }
              )
            } else {
              // 网关金额按张均分只作对账快照（各条合计=网关实际金额）
              const amountShares = this.splitEvenly(
                new Decimal(taskUsage?.amount ?? "0"),
                storedImages.length
              )
              for (let index = 0; index < storedImages.length; index += 1) {
                const image = localTask.generatedImages[index]
                await this.usage.chargeModelInTransaction(
                  tx,
                  localTask.userId,
                  fixedCredits.div(CREDIT_PER_CNY).toString(),
                  {
                    source,
                    invokeType,
                    model: localTask.model,
                    exactCredits: fixedCredits.toString(),
                    meta: {
                      gatewayTaskId: task.id,
                      gatewayEventId: eventId,
                      projectId: localTask.projectId,
                      taskId: localTask.id,
                      imageId: image.id,
                      order: image.order,
                      type: localTask.type,
                      status,
                      pricingMode: "fixed",
                      fixedCredits: fixedCredits.toString(),
                      gatewayAmountCny: amountShares[index].toString(),
                    },
                    requestId: `gateway:${task.id}:${image.id}`,
                    allowOverdraft: true,
                  }
                )
              }
            }
          }
        } else if (taskUsage && this.isChargeableAmount(taskUsage.amount)) {
          // 按量也按张拆（每张承担等额成本，末张吸收除法余量，合计与整笔一致）；
          // AI 拆图部分失败（落图张数 < 席位）只收成功张数的等比份额，失败张数
          // 的成本平台自担；一张未落时维持一笔全额转嫁兜已产生成本
          const seats = localTask.generatedImages.length
          const delivered = storedImages.length
          const ratio =
            perImageBilling && delivered > 0 && delivered < seats
              ? new Decimal(delivered).div(seats)
              : null
          const billableCost = ratio
            ? new Decimal(taskUsage.amount).mul(priceMultiplier).mul(ratio)
            : new Decimal(taskUsage.amount).mul(priceMultiplier)
          const billableAmount = ratio
            ? new Decimal(taskUsage.amount).mul(ratio)
            : new Decimal(taskUsage.amount)
          const perImage = perImageBilling && delivered > 0
          const chargeCount = perImage ? delivered : 1
          const costShares = this.splitEvenly(billableCost, chargeCount)
          const amountShares = this.splitEvenly(billableAmount, chargeCount)
          for (let index = 0; index < chargeCount; index += 1) {
            const image = perImage ? localTask.generatedImages[index] : null
            await this.usage.chargeModelInTransaction(
              tx,
              localTask.userId,
              costShares[index].toString(),
              {
                source,
                invokeType,
                model: localTask.model,
                meta: {
                  gatewayTaskId: task.id,
                  gatewayEventId: eventId,
                  projectId: localTask.projectId,
                  taskId: localTask.id,
                  ...(image ? { imageId: image.id, order: image.order } : {}),
                  type: localTask.type,
                  status,
                  gatewayAmountCny: amountShares[index].toString(),
                  priceMultiplier: priceMultiplier.toString(),
                },
                requestId: image ? `gateway:${task.id}:${image.id}` : `gateway:${task.id}`,
                allowOverdraft: true,
              }
            )
          }
        }
        await this.recomputeImageProject(tx, localTask.projectId)
        return true
      },
      { timeout: 15_000 }
    )

    if (applied) {
      this.logger.log(
        `[AI Gateway 图片回调] task=${task.id} status=${status} outputs=${storedImages.length} usage=${taskUsage?.amount ?? "0"} CNY`
      )
    }
    return applied
  }

  private imageArtifacts(task: ImageTask): ImageTaskArtifact[] {
    if (task.status === "queued" || task.status === "running") return []
    if (task.status === "succeeded") {
      return "images" in task.result ? task.result.images : task.result.layer_stack.outputs
    }
    return "partial_result" in task ? (task.partial_result?.images ?? []) : []
  }

  /** 读取任务快照里最终生效的 output_format，转存后处理按它编码落盘（人像在 model_params，AI拆图在 generationSettings.modelParams） */
  private promptOutputFormat(promptConfig: Prisma.JsonValue | null): string | null {
    if (!promptConfig || typeof promptConfig !== "object" || Array.isArray(promptConfig))
      return null
    const config = promptConfig as {
      model_params?: unknown
      generationSettings?: { modelParams?: unknown }
    }
    const modelParams = config.model_params ?? config.generationSettings?.modelParams ?? undefined
    if (!modelParams || typeof modelParams !== "object" || Array.isArray(modelParams)) return null
    const format = (modelParams as { output_format?: unknown }).output_format
    return typeof format === "string" && format ? format : null
  }

  private missingImageStatus(status: ImageTask["status"]): string {
    if (status === "canceled") return "CANCELLED"
    if (status === "expired") return "TIMEOUT"
    return "FAILED"
  }

  private deliveryPlanUpdate(
    currentValue: Prisma.JsonValue | null,
    storedImages: StoredImageArtifact[],
    adaptation?: ImageTask["adaptation"]
  ): Prisma.InputJsonValue | null {
    if (!currentValue || typeof currentValue !== "object" || Array.isArray(currentValue))
      return null
    const plan = currentValue as {
      requested?: unknown
      providerApplied?: unknown
      delivery?: Record<string, unknown>
      warnings?: unknown
    }
    const delivered = storedImages.find(item => item.delivery)
    if (!delivered?.delivery) return null
    const baseWarnings = Array.isArray(plan.warnings)
      ? plan.warnings.filter((item): item is string => typeof item === "string")
      : []
    const warnings = [
      ...new Set([
        ...baseWarnings,
        ...(adaptation?.changes ?? []),
        ...storedImages.flatMap(item => item.warnings),
      ]),
    ]
    return {
      ...plan,
      requested: plan.requested ?? null,
      providerApplied: adaptation
        ? {
            size: adaptation.actual.size,
            aspectRatio: adaptation.actual.aspect_ratio ?? null,
            resolutionTier: adaptation.actual.resolution,
            width: delivered.nativeWidth,
            height: delivered.nativeHeight,
          }
        : (plan.providerApplied ?? null),
      delivery: {
        ...plan.delivery,
        // 交付尺寸以实际落图为准（native_cap 下模型实际输出可能与计划折算略有出入）
        width: typeof delivered.width === "number" ? delivered.width : plan.delivery?.width,
        height: typeof delivered.height === "number" ? delivered.height : plan.delivery?.height,
        strategy: delivered.delivery.strategy,
        nativeResolution: delivered.delivery.nativeResolution,
      },
      warnings,
    } as Prisma.InputJsonValue
  }

  private async recomputeImageProject(tx: Prisma.TransactionClient, projectId: number) {
    const [runningTasks, successfulImages] = await Promise.all([
      tx.generationTask.count({
        where: { projectId, status: "GENERATING", deletedAt: null },
      }),
      tx.generatedImage.count({
        where: {
          status: "SUCCESS",
          deletedAt: null,
          task: { projectId, deletedAt: null },
        },
      }),
    ])
    const status = runningTasks > 0 ? "GENERATING" : successfulImages > 0 ? "COMPLETED" : "DRAFT"
    await tx.imageProject.updateMany({
      where: { id: projectId, status: { not: "ARCHIVED" }, deletedAt: null },
      data: { status },
    })
  }

  private videoRequest(value: Prisma.JsonValue | null): VideoGenerationRequest | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    if (typeof value.model !== "string" || typeof value.prompt !== "string") return null
    if (value.callback !== true) return null
    return value as unknown as VideoGenerationRequest
  }
}
