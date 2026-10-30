import { labelImage } from "../aigc/image-label"
import { deliverVideo, objectAigcMetadata } from "../aigc/media-delivery"
import { retryDelivery, AigcDeliveryError, contentId } from "../aigc/aigc-metadata"
import { modelDisplayNames, jsonObject } from "../common/utils/generation-metadata"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Cron, CronExpression } from "@nestjs/schedule"
import { Prisma, type RpaCreationOutput, type RpaCreationTask } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import axios from "axios"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { YingdaoProvider } from "../common/providers/yingdao.provider"
import { ContentModerationService } from "../content-moderation/content-moderation.service"
import { PrismaService } from "../prisma/prisma.service"
import { SpacesService } from "../spaces/spaces.service"
import { UsageService } from "../usage/usage.service"
import {
  RPA_CREATION_CAPABILITIES,
  RPA_IMAGE_MODELS,
  RPA_MODEL_LABELS,
  RPA_TASK_STATUSES,
  RPA_TERMINAL_STATUSES,
  RpaMediaType,
  RpaTaskStatus,
} from "./rpa-creation.capabilities"
import {
  CompleteRpaTaskDto,
  CreateRpaCreationProjectDto,
  CreateRpaCreationTaskDto,
  QueryRpaCreationProjectDto,
  QueryRpaCreationTaskDto,
  RpaCreationTaskStatsDto,
  UpdateRpaCreationProjectDto,
} from "./rpa-creation.dto"

const INPUT_KEY_PREFIX = "rpa-inputs/"
const RESULT_KEY_PREFIX = "rpa-results/"
// 已停用：RPA 输入和结果文件改为永久保留。保留原配置便于将来恢复。
// const RETENTION_DAYS = 7
const TASK_TIMEOUT_MS = 60 * 60 * 1000
const MAX_IMAGE_SIZE = 20 * 1024 * 1024
const MAX_VIDEO_SIZE = 200 * 1024 * 1024
const MAX_RESULT_VIDEO_SIZE = 500 * 1024 * 1024
const RESULT_DOWNLOAD_TIMEOUT_MS = 120_000
const GOOGLE_FLOW_CREDIT_CNY = new Decimal("0.032")
const GOOGLE_FLOW_VIDEO_CREDITS_PER_10_SECONDS = new Decimal(15)
const RPA_PLATFORM_MARKUP = new Decimal(2)
const PLATFORM_CREDITS_PER_CNY = new Decimal(10)
const RPA_IMAGE_CREDITS_PER_OUTPUT = new Decimal(1)
const ACTIVE_OUTPUTS_QUERY = {
  where: { deletedAt: null },
  orderBy: { order: "asc" as const },
}
const PROVIDER_NAME_PATTERN = /rpa|影刀|yingdao|flow/i

type Json = Prisma.InputJsonValue

interface RpaPayload {
  schemaVersion: 2
  requestId: string
  mediaType: "image" | "video"
  inputMode?: string
  prompt: string
  model: string
  modelCode: string
  aspectRatio: string
  quantity: number
  duration?: number
  resolution?: string
  referenceImageUrls: string[]
  referenceVideoUrls: string[]
  callback: {
    completeUrl: string
  }
}

@Injectable()
export class RpaCreationService implements OnModuleInit {
  private readonly logger = new Logger(RpaCreationService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly spaces: SpacesService,
    private readonly yingdao: YingdaoProvider,
    private readonly usage: UsageService,
    private readonly moderation: ContentModerationService
  ) {}

  async onModuleInit() {
    // 已停用：RPA 输入和结果文件改为永久保留，不再创建 7 天自动删除规则。
    // 注意：部署前/后仍需在 Spaces 控制台禁用或删除历史规则
    // rpa-inputs-7day-expire、rpa-results-7day-expire；仅注释此处不会移除 bucket 中已有规则。
    // Spaces 生命周期配置是对整个 Bucket 的读改写操作，必须串行，避免彼此覆盖。
    // await this.ensureRetentionRule(INPUT_KEY_PREFIX, "rpa-inputs-7day-expire")
    // await this.ensureRetentionRule(RESULT_KEY_PREFIX, "rpa-results-7day-expire")

    const preparing = await this.prisma.rpaCreationTask.findMany({
      where: {
        status: "PENDING",
        yingdaoTaskUuid: null,
      },
      select: { id: true },
    })
    for (const task of preparing) this.dispatchTask(task.id)

    await this.expireTimedOutTasks()
  }

  getCapabilities() {
    return RPA_CREATION_CAPABILITIES
  }

  async createProject(dto: CreateRpaCreationProjectDto, userId: number) {
    const name = dto.name?.trim() || "未命名项目"
    return this.prisma.$transaction(async tx => {
      await this.lockUserProjectNames(tx, userId)
      await this.assertProjectNameAvailable(tx, userId, name)
      return tx.rpaCreationProject.create({
        data: { name, userId },
      })
    })
  }

  async findAllProjects(query: QueryRpaCreationProjectDto, userId: number) {
    const { page, pageSize, keyword } = query
    const where: Prisma.RpaCreationProjectWhereInput = {
      userId,
      ...(keyword?.trim() ? { name: { contains: keyword.trim() } } : {}),
    }

    const [total, projects] = await Promise.all([
      this.prisma.rpaCreationProject.count({ where }),
      this.prisma.rpaCreationProject.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    const counts = await this.getProjectCounts(
      projects.map(project => project.id),
      userId
    )
    return {
      total,
      page,
      pageSize,
      items: projects.map(project => ({ ...project, ...counts.get(project.id)! })),
    }
  }

  async findOneProject(id: number, userId: number) {
    const project = await this.assertProjectOwned(id, userId)
    const counts = await this.getProjectCounts([id], userId)
    return { ...project, ...counts.get(id)! }
  }

  async updateProject(id: number, dto: UpdateRpaCreationProjectDto, userId: number) {
    await this.assertProjectOwned(id, userId)
    const name = dto.name.trim()
    return this.prisma.$transaction(async tx => {
      await this.lockUserProjectNames(tx, userId)
      await this.assertProjectNameAvailable(tx, userId, name, id)
      const updated = await tx.rpaCreationProject.updateMany({
        where: { id, userId, deletedAt: null },
        data: { name },
      })
      if (updated.count !== 1) throw new NotFoundException("创作项目不存在")
      return tx.rpaCreationProject.findUniqueOrThrow({ where: { id } })
    })
  }

  async deleteProject(id: number, userId: number) {
    await this.assertProjectOwned(id, userId)
    const activeTask = await this.prisma.rpaCreationTask.findFirst({
      where: {
        projectId: id,
        OR: [
          { status: { notIn: [...RPA_TERMINAL_STATUSES] } },
          { outputs: { some: { status: "GENERATING", deletedAt: null } } },
        ],
      },
      select: { id: true },
    })
    if (activeTask) throw new ConflictException("项目中仍有运行任务，请等待任务完成或超时")
    const now = new Date()
    const tasks = await this.prisma.rpaCreationTask.findMany({
      where: { projectId: id },
      select: { id: true },
    })
    const taskIds = tasks.map(task => task.id)

    await this.prisma.$transaction([
      this.prisma.rpaCreationOutput.updateMany({
        where: { taskId: { in: taskIds }, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.rpaCreationTask.updateMany({
        where: { projectId: id },
        data: { deletedAt: now, clientRequestId: null },
      }),
      this.prisma.rpaCreationProject.update({ where: { id }, data: { deletedAt: now } }),
    ])
    return { success: true }
  }

  async clearInvalidResults(projectId: number, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const now = new Date()

    const result = await this.prisma.$transaction(async tx => {
      await this.lockProjectTasks(tx, projectId, userId)
      const invalidOutputs = await tx.rpaCreationOutput.findMany({
        where: {
          deletedAt: null,
          task: { projectId, userId, deletedAt: null },
          OR: [
            { status: "FAILED" },
            { status: { not: "GENERATING" }, task: { status: "TIMEOUT" } },
            { task: { status: "CANCELLED" } },
            // 已停用：永久保留后，不再将超过 7 天的结果作为无效结果软删除。
            // { status: { not: "GENERATING" }, task: { expiresAt: { lte: now } } },
          ],
        },
        select: {
          id: true,
          taskId: true,
          task: { select: { mediaType: true, status: true, expiresAt: true } },
        },
      })

      const outputIds = invalidOutputs.map(output => output.id)
      const deletedOutputs = outputIds.length
        ? await tx.rpaCreationOutput.updateMany({
            where: { id: { in: outputIds }, deletedAt: null },
            data: { deletedAt: now },
          })
        : { count: 0 }

      const emptyTasks = await tx.rpaCreationTask.findMany({
        where: {
          projectId,
          userId,
          deletedAt: null,
          status: { in: ["SUCCESS", "TIMEOUT", "CANCELLED"] },
          outputs: { none: { deletedAt: null } },
        },
        select: { id: true },
      })
      const deletedTasks = emptyTasks.length
        ? await tx.rpaCreationTask.updateMany({
            where: { id: { in: emptyTasks.map(task => task.id) }, deletedAt: null },
            data: { deletedAt: now, clientRequestId: null },
          })
        : { count: 0 }

      const deletedImages = invalidOutputs.filter(
        output => output.task.mediaType === "IMAGE"
      ).length
      const deletedVideos = invalidOutputs.length - deletedImages
      const deletedCancelled = invalidOutputs.filter(
        output => output.task.status === "CANCELLED"
      ).length
      const deletedTimeout = invalidOutputs.filter(
        output => output.task.status === "TIMEOUT"
      ).length
      // 已停用：永久保留后不再统计或清理过期结果，字段保留为 0 以兼容前端。
      const deletedExpired = 0
      // 原 7 天过期统计逻辑：
      // const deletedExpired = invalidOutputs.filter(
      //   output =>
      //     output.task.status !== "CANCELLED" &&
      //     output.task.status !== "TIMEOUT" &&
      //     !!output.task.expiresAt &&
      //     output.task.expiresAt <= now
      // ).length
      const deletedFailed = invalidOutputs.length - deletedCancelled - deletedTimeout
      // 原 7 天过期统计口径：
      // const deletedFailed =
      //   invalidOutputs.length - deletedCancelled - deletedTimeout - deletedExpired

      return {
        deletedTotal: deletedOutputs.count,
        deletedImages,
        deletedVideos,
        deletedFailed,
        deletedTimeout,
        deletedCancelled,
        deletedExpired,
        deletedTasks: deletedTasks.count,
      }
    })

    this.logger.log(
      `清理 RPA 无效结果 project=${projectId} user=${userId} total=${result.deletedTotal} images=${result.deletedImages} videos=${result.deletedVideos} tasks=${result.deletedTasks}`
    )
    return { success: true, ...result }
  }

  /** 按输出席位 ID 批量软删除；等待中或生成中的输出禁止移除。 */
  async removeResults(projectId: number, outputIds: number[], userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const ids = [...new Set(outputIds)]
    const now = new Date()

    const result = await this.prisma.$transaction(async tx => {
      await this.lockProjectTasks(tx, projectId, userId)
      const outputs = await tx.rpaCreationOutput.findMany({
        where: {
          id: { in: ids },
          deletedAt: null,
          task: { projectId, userId, deletedAt: null },
        },
        select: {
          id: true,
          taskId: true,
          status: true,
          task: { select: { mediaType: true, status: true } },
        },
      })
      if (outputs.length !== ids.length) {
        throw new BadRequestException("部分结果不存在、已被移除或不属于当前项目")
      }
      if (
        outputs.some(
          output =>
            ["PENDING", "GENERATING"].includes(output.status) || output.task.status === "PENDING"
        )
      ) {
        throw new BadRequestException("等待中或生成中的结果不可移除，请等待任务结束")
      }

      const removed = await tx.rpaCreationOutput.updateMany({
        where: {
          id: { in: ids },
          deletedAt: null,
          status: { notIn: ["PENDING", "GENERATING"] },
          task: { projectId, userId, deletedAt: null, status: { not: "PENDING" } },
        },
        data: { deletedAt: now },
      })
      if (removed.count !== ids.length) {
        throw new BadRequestException("部分结果状态已变化，请刷新后重试")
      }
      const taskIds = [...new Set(outputs.map(output => output.taskId))]
      const emptyTasks = await tx.rpaCreationTask.findMany({
        where: {
          id: { in: taskIds },
          projectId,
          userId,
          deletedAt: null,
          status: { in: ["SUCCESS", "TIMEOUT", "CANCELLED"] },
          outputs: { none: { deletedAt: null } },
        },
        select: { id: true },
      })
      const removedTasks = emptyTasks.length
        ? await tx.rpaCreationTask.updateMany({
            where: { id: { in: emptyTasks.map(task => task.id) }, deletedAt: null },
            data: { deletedAt: now, clientRequestId: null },
          })
        : { count: 0 }

      return {
        removedCount: removed.count,
        removedImages: outputs.filter(output => output.task.mediaType === "IMAGE").length,
        removedVideos: outputs.filter(output => output.task.mediaType === "VIDEO").length,
        removedEmptyTasks: removedTasks.count,
      }
    })

    this.logger.log(
      `批量移除 RPA 结果 project=${projectId} user=${userId} requested=${ids.length} removed=${result.removedCount}`
    )
    return { success: true, requestedCount: ids.length, ...result }
  }

  async createTask(
    projectId: number,
    dto: CreateRpaCreationTaskDto,
    userId: number,
    idempotencyKey: string | undefined
  ) {
    await this.assertProjectOwned(projectId, userId)
    const clientRequestId = this.normalizeIdempotencyKey(idempotencyKey)
    const existing = await this.prisma.rpaCreationTask.findFirst({
      where: { userId, clientRequestId },
      include: { outputs: ACTIVE_OUTPUTS_QUERY },
    })
    if (existing) return this.toPublicTask(existing)

    const normalized = this.validateTask(dto)
    await this.verifyReferenceFiles(userId, normalized)
    const requestId = randomUUID()

    try {
      const task = await this.prisma.rpaCreationTask.create({
        data: {
          requestId,
          clientRequestId,
          projectId,
          userId,
          mediaType: dto.mediaType,
          inputMode: dto.mediaType === "VIDEO" ? "INGREDIENTS" : null,
          prompt: dto.prompt.trim(),
          model: dto.model,
          aspectRatio: dto.aspectRatio,
          quantity: dto.quantity,
          durationSec: dto.mediaType === "VIDEO" ? dto.durationSec : null,
          resolution: normalized.resolution,
          referenceImageUrls: normalized.referenceImageUrls as Json,
          referenceVideoUrls: normalized.referenceVideoUrls as Json,
          status: "PENDING",
          outputs: {
            create: Array.from({ length: dto.quantity }, (_, order) => ({ order })),
          },
        },
        include: { outputs: ACTIVE_OUTPUTS_QUERY },
      })

      this.dispatchTask(task.id)
      return this.toPublicTask(task)
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        const duplicate = await this.prisma.rpaCreationTask.findFirst({
          where: { userId, clientRequestId },
          include: { outputs: ACTIVE_OUTPUTS_QUERY },
        })
        if (duplicate) return this.toPublicTask(duplicate)
      }
      throw error
    }
  }

  async findAllTasks(query: QueryRpaCreationTaskDto, userId: number) {
    const { page, pageSize, projectId, mediaType, status } = query
    const where: Prisma.RpaCreationTaskWhereInput = {
      userId,
      projectId,
      mediaType,
      status,
    }
    const [total, tasks] = await Promise.all([
      this.prisma.rpaCreationTask.count({ where }),
      this.prisma.rpaCreationTask.findMany({
        where,
        include: {
          project: { select: { id: true, name: true } },
          outputs: ACTIVE_OUTPUTS_QUERY,
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])
    return { total, page, pageSize, items: await this.publicTasks(tasks) }
  }

  async getTaskStats(query: RpaCreationTaskStatsDto, userId: number) {
    const grouped = await this.prisma.rpaCreationTask.groupBy({
      by: ["status"],
      where: { userId, projectId: query.projectId },
      _count: { _all: true },
    })
    const statuses = Object.fromEntries(RPA_TASK_STATUSES.map(status => [status, 0])) as Record<
      RpaTaskStatus,
      number
    >
    for (const item of grouped) {
      if (this.isTaskStatus(item.status)) statuses[item.status] += item._count._all
    }

    return {
      total: grouped.reduce((sum, item) => sum + item._count._all, 0),
      pending: statuses.PENDING,
      success: statuses.SUCCESS,
      timeout: statuses.TIMEOUT,
      cancelled: statuses.CANCELLED,
      statuses,
    }
  }

  async findOneTask(id: number, userId: number) {
    const task = await this.prisma.rpaCreationTask.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        outputs: ACTIVE_OUTPUTS_QUERY,
      },
    })
    if (!task) throw new NotFoundException("任务不存在")
    this.ensureOwner(task.userId, userId)
    return this.toPublicTask(task)
  }

  async retryTask(id: number, userId: number) {
    const reserved = await this.prisma.$transaction(async tx => {
      await this.lockTask(tx, id)
      const task = await tx.rpaCreationTask.findUnique({
        where: { id },
        include: { outputs: ACTIVE_OUTPUTS_QUERY },
      })
      if (!task) throw new NotFoundException("任务不存在")
      this.ensureOwner(task.userId, userId)
      if (task.status === "CANCELLED") throw new BadRequestException("已取消的任务不能重试")
      if (task.status === "PENDING") throw new ConflictException("任务仍在生成中，请稍后再试")
      if (task.outputs.some(output => output.status === "GENERATING")) {
        throw new ConflictException("任务正在重试中，请勿重复提交")
      }

      const failedOutputs = task.outputs.filter(output => output.status === "FAILED")
      if (!failedOutputs.length) throw new BadRequestException("当前没有可重试的失败结果")

      if (task.mediaType === "VIDEO") {
        this.validateVideoSettings(task.model, task.durationSec, task.resolution)
      }

      const outputIds = failedOutputs.map(output => output.id)
      const updated = await tx.rpaCreationOutput.updateMany({
        where: { id: { in: outputIds }, status: "FAILED", deletedAt: null },
        data: { status: "GENERATING", errorMessage: null },
      })
      if (updated.count !== outputIds.length) {
        throw new ConflictException("任务状态已发生变化，请刷新后重试")
      }

      await tx.rpaCreationTask.update({
        where: { id: task.id },
        data: { progressMessage: `正在重试 ${outputIds.length} 个失败结果` },
      })
      return { task, outputIds }
    })

    try {
      await this.runRetry(reserved.task, reserved.outputIds.length)
    } catch (error: unknown) {
      this.logger.error(`RPA 重试提交异常 taskId=${id}: ${this.errorMessage(error)}`)
      await this.prisma.$transaction(async tx => {
        await this.lockTask(tx, reserved.task.id)
        await tx.rpaCreationOutput.updateMany({
          where: { id: { in: reserved.outputIds }, status: "GENERATING", deletedAt: null },
          data: { status: "FAILED", errorMessage: "提交失败，请稍后重试" },
        })
        await tx.rpaCreationTask.update({
          where: { id: reserved.task.id },
          data: { progressMessage: null },
        })
      })
      throw new ServiceUnavailableException("提交失败，请稍后重试")
    }

    return this.findOneTask(id, userId)
  }

  async completeTask(
    requestId: string,
    authorization: string | undefined,
    dto: CompleteRpaTaskDto
  ) {
    const task = await this.assertInternalTask(requestId, authorization)
    this.logger.log(`RPA 原始输出 requestId=${requestId}: ${JSON.stringify(dto)}`)
    if (task.status === "CANCELLED") {
      const existing = await this.prisma.rpaCreationTask.findUniqueOrThrow({
        where: { id: task.id },
        include: { outputs: ACTIVE_OUTPUTS_QUERY },
      })
      return this.toPublicTask(existing)
    }

    const callbackState = await this.prisma.rpaCreationOutput.findMany({
      where: { taskId: task.id, deletedAt: null },
      orderBy: { order: "asc" },
    })
    if (
      task.status !== "PENDING" &&
      !callbackState.some(output => ["GENERATING", "FAILED"].includes(output.status))
    ) {
      const existing = await this.prisma.rpaCreationTask.findUniqueOrThrow({
        where: { id: task.id },
        include: { outputs: ACTIVE_OUTPUTS_QUERY },
      })
      return this.toPublicTask(existing)
    }
    const validatedOutputs = await this.validateReportedOutputs(task, dto)

    const result = await this.prisma.$transaction(async tx => {
      await this.lockTask(tx, task.id)
      const current = await tx.rpaCreationTask.findUnique({ where: { id: task.id } })
      if (!current) throw new NotFoundException("任务不存在")
      if (current.status === "CANCELLED") {
        return tx.rpaCreationTask.findUniqueOrThrow({
          where: { id: current.id },
          include: { outputs: ACTIVE_OUTPUTS_QUERY },
        })
      }

      const outputs = await tx.rpaCreationOutput.findMany({
        where: { taskId: current.id, deletedAt: null },
        orderBy: { order: "asc" },
      })
      const generatingOutputs = outputs.filter(output => output.status === "GENERATING")
      const pendingOutputs = outputs.filter(output => output.status === "PENDING")
      const failedOutputs = outputs.filter(output => output.status === "FAILED")
      const activeOutputs = generatingOutputs.length ? generatingOutputs : pendingOutputs
      const isActiveCallback = activeOutputs.length > 0
      const isFullLateCallback = !isActiveCallback && dto.outputs.length === current.quantity
      const targetOutputs = isActiveCallback ? activeOutputs : failedOutputs

      if (!targetOutputs.length) {
        return tx.rpaCreationTask.findUniqueOrThrow({
          where: { id: current.id },
          include: { outputs: ACTIVE_OUTPUTS_QUERY },
        })
      }
      if (!isFullLateCallback && dto.outputs.length > targetOutputs.length) {
        throw new BadRequestException(`本次最多回填 ${targetOutputs.length} 个输出`)
      }

      const assignments = targetOutputs
        .map((output, index) => ({
          output,
          itemIndex: isFullLateCallback ? output.order : index,
        }))
        .filter(({ itemIndex }) => itemIndex < dto.outputs.length)

      const successfulOutputIds: number[] = []
      for (const { output, itemIndex } of assignments) {
        const item = dto.outputs[itemIndex]
        const validation = validatedOutputs[itemIndex]
        const success = item.status === "SUCCESS" && validation?.success === true
        if (success) successfulOutputIds.push(output.id)
        await tx.rpaCreationOutput.update({
          where: { id: output.id, deletedAt: null },
          data: {
            status: success ? "SUCCESS" : "FAILED",
            deliveryMeta: success ? validation?.deliveryMeta : undefined,
            url: success ? (validation?.url ?? null) : null,
            errorMessage: success ? null : "生成失败，请重试",
          },
        })
      }

      if (successfulOutputIds.length) {
        const charge = this.quoteSuccessfulOutputs(current, successfulOutputIds.length)
        await this.usage.chargeExactCreditsInTransaction(tx, current.userId, {
          credits: charge.platformCredits,
          costCny: charge.platformPriceCny,
          source: "rpa-creation.generate",
          allowOverdraft: true,
          meta: {
            requestId: current.requestId,
            taskId: current.id,
            projectId: current.projectId,
            mediaType: current.mediaType,
            model: current.model,
            durationSec: current.durationSec,
            successfulOutputIds,
            successfulOutputCount: successfulOutputIds.length,
            googleFlowCredits: charge.googleFlowCredits.toString(),
            googleFlowCostCny: charge.googleFlowCostCny.toString(),
            markup: RPA_PLATFORM_MARKUP.toString(),
            pricingRule: charge.pricingRule,
          },
        })
      }

      if (isActiveCallback) {
        const assignedIds = assignments.map(({ output }) => output.id)
        await tx.rpaCreationOutput.updateMany({
          where: {
            id: {
              in: targetOutputs.map(output => output.id).filter(id => !assignedIds.includes(id)),
            },
            status: { in: ["PENDING", "GENERATING"] },
            deletedAt: null,
          },
          data: {
            status: "FAILED",
            errorMessage: "生成失败，请重试",
          },
        })
      }

      const now = new Date()
      return tx.rpaCreationTask.update({
        where: { id: current.id },
        data: {
          status: "SUCCESS",
          progressMessage: null,
          errorMessage: null,
          completedAt: now,
          expiresAt: null,
          // 原 7 天过期逻辑：
          // expiresAt: new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
        },
        include: { outputs: ACTIVE_OUTPUTS_QUERY },
      })
    })
    return this.toPublicTask(result)
  }

  private quoteSuccessfulOutputs(task: RpaCreationTask, outputCount: number) {
    const count = new Decimal(outputCount)
    if (task.mediaType === "IMAGE") {
      const platformCredits = RPA_IMAGE_CREDITS_PER_OUTPUT.mul(count)
      return {
        googleFlowCredits: new Decimal(0),
        googleFlowCostCny: new Decimal(0),
        platformCredits,
        platformPriceCny: platformCredits.div(PLATFORM_CREDITS_PER_CNY),
        pricingRule: "rpa_image_fixed_credits_per_success_output",
      }
    }

    const durationSec = new Decimal(task.durationSec ?? 0)
    const googleFlowCredits = GOOGLE_FLOW_VIDEO_CREDITS_PER_10_SECONDS.mul(durationSec)
      .div(10)
      .mul(count)
    const googleFlowCostCny = googleFlowCredits.mul(GOOGLE_FLOW_CREDIT_CNY)
    const platformPriceCny = googleFlowCostCny.mul(RPA_PLATFORM_MARKUP)
    return {
      googleFlowCredits,
      googleFlowCostCny,
      platformCredits: platformPriceCny.mul(PLATFORM_CREDITS_PER_CNY),
      platformPriceCny,
      pricingRule: "rpa_video_google_flow_credits_duration_markup",
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async expireTimedOutTasks() {
    const cutoff = new Date(Date.now() - TASK_TIMEOUT_MS)
    const tasks = await this.prisma.rpaCreationTask.findMany({
      where: {
        status: "PENDING",
        updatedAt: { lt: cutoff },
      },
      select: { id: true, status: true },
    })

    const now = new Date()
    let transitionedCount = 0
    for (const task of tasks) {
      const transitioned = await this.prisma.$transaction(async tx => {
        // 先以任务行为 CAS 锁点，只有仍满足状态和截止时间的任务才能进入终态。
        const updated = await tx.rpaCreationTask.updateMany({
          where: { id: task.id, status: task.status, updatedAt: { lt: cutoff } },
          data: {
            status: "TIMEOUT",
            progressMessage: null,
            errorMessage: "生成超时，请重试",
            completedAt: now,
          },
        })
        if (updated.count !== 1) return false

        await tx.rpaCreationOutput.updateMany({
          where: {
            taskId: task.id,
            status: { in: ["PENDING", "GENERATING"] },
            deletedAt: null,
          },
          data: {
            status: "FAILED",
            errorMessage: "生成超时，请重试",
          },
        })
        return true
      })
      if (transitioned) transitionedCount++
    }
    if (transitionedCount > 0) {
      this.logger.warn(`已处理 ${transitionedCount} 条超时 RPA 任务`)
    }

    const retryingOutputs = await this.prisma.rpaCreationOutput.findMany({
      where: {
        status: "GENERATING",
        deletedAt: null,
        updatedAt: { lt: cutoff },
        task: { status: { in: ["SUCCESS", "TIMEOUT"] }, deletedAt: null },
      },
      select: { taskId: true },
      distinct: ["taskId"],
    })
    let timedOutRetryCount = 0
    for (const { taskId } of retryingOutputs) {
      const transitioned = await this.prisma.$transaction(async tx => {
        await this.lockTask(tx, taskId)
        const updated = await tx.rpaCreationOutput.updateMany({
          where: { taskId, status: "GENERATING", deletedAt: null, updatedAt: { lt: cutoff } },
          data: { status: "FAILED", errorMessage: "生成超时，请重试" },
        })
        if (!updated.count) return false
        await tx.rpaCreationTask.update({
          where: { id: taskId },
          data: { progressMessage: null },
        })
        return true
      })
      if (transitioned) timedOutRetryCount++
    }
    if (timedOutRetryCount > 0) {
      this.logger.warn(`已处理 ${timedOutRetryCount} 条超时 RPA 重试任务`)
    }
  }

  // 已停用：RPA 输入和结果文件改为永久保留。保留原定时清理代码便于将来恢复。
  // @Cron(CronExpression.EVERY_DAY_AT_4AM)
  // async pruneExpiredFiles() {
  //   try {
  //     const [inputs, results] = await Promise.all([
  //       this.spaces.pruneExpiredObjects(INPUT_KEY_PREFIX, RETENTION_DAYS),
  //       this.spaces.pruneExpiredObjects(RESULT_KEY_PREFIX, RETENTION_DAYS),
  //     ])
  //     if (inputs + results > 0) {
  //       this.logger.log(`清理 RPA 过期文件完成，输入 ${inputs} 个，结果 ${results} 个`)
  //     }
  //   } catch (error: unknown) {
  //     this.logger.error(`清理 RPA 过期文件失败：${this.errorMessage(error)}`)
  //   }
  // }

  private dispatchTask(taskId: number) {
    void this.runDispatch(taskId).catch(error => {
      this.logger.error(`RPA 任务提交异常 taskId=${taskId}: ${this.errorMessage(error)}`)
    })
  }

  private async runDispatch(taskId: number) {
    const task = await this.prisma.rpaCreationTask.findUnique({ where: { id: taskId } })
    if (!task || task.status !== "PENDING" || task.yingdaoTaskUuid) return

    try {
      const payload = this.buildRpaPayload(task)
      const rawParams = await this.moderation.assertContent([payload], "rpa", [
        "mediaType",
        "inputMode",
      ])
      const fileContent = Buffer.from(JSON.stringify(rawParams, null, 2), "utf8")
      const fileName = `rpa-creation-${task.requestId}.txt`
      const { fileKey } = await this.yingdao.uploadFile(fileContent, fileName)

      const saved = await this.prisma.rpaCreationTask.updateMany({
        where: { id: task.id, status: task.status, yingdaoTaskUuid: null },
        data: {
          paramsSnapshot: this.buildParamsSnapshot(payload),
          paramsFileKey: fileKey,
          progressMessage: "参数已准备，正在提交生成任务",
        },
      })

      if (saved.count !== 1) return

      const latest = await this.prisma.rpaCreationTask.findUnique({ where: { id: task.id } })
      if (!latest || latest.status !== "PENDING" || latest.yingdaoTaskUuid) return

      const result = await this.yingdao.startTask({
        scheduleUuid: this.requiredConfig("YINGDAO_SCHEDULE_UUID"),
        idempotentUuid: task.requestId,
        scheduleRelaParams: [
          {
            robotUuid: this.requiredConfig("YINGDAO_APP_ID"),
            runTimeout: TASK_TIMEOUT_MS / 1000,
            params: [{ name: "paramsFile", value: fileKey, type: "file" }],
          },
        ],
      })

      const started = await this.prisma.rpaCreationTask.updateMany({
        where: {
          id: task.id,
          status: "PENDING",
          yingdaoTaskUuid: null,
        },
        data: {
          yingdaoTaskUuid: result.taskUuid,
          yingdaoJobUuidList: result.jobUuidList as Json,
          startedAt: new Date(),
          progressMessage: "已提交，排队生成中",
        },
      })
      if (started.count === 1) {
        this.logger.log(`RPA 任务提交成功 taskId=${task.id} taskUuid=${result.taskUuid}`)
      }
    } catch (error: unknown) {
      this.logger.error(`RPA 任务提交异常 taskId=${task.id}: ${this.errorMessage(error)}`)
      await this.prisma.$transaction(async tx => {
        const transitioned = await tx.rpaCreationTask.updateMany({
          where: { id: task.id, status: "PENDING" },
          data: {
            status: "TIMEOUT",
            progressMessage: null,
            errorMessage: "提交失败，请稍后重试",
            completedAt: new Date(),
          },
        })
        if (transitioned.count !== 1) return
        await tx.rpaCreationOutput.updateMany({
          where: {
            taskId: task.id,
            status: { in: ["PENDING", "GENERATING"] },
            deletedAt: null,
          },
          data: { status: "FAILED", errorMessage: "提交失败，请稍后重试" },
        })
      })
      throw error
    }
  }

  private async runRetry(task: RpaCreationTask, quantity: number) {
    const payload = this.buildRpaPayload(task, quantity)
    const rawParams = await this.moderation.assertContent([payload], "rpa", [
      "mediaType",
      "inputMode",
    ])
    const fileContent = Buffer.from(JSON.stringify(rawParams, null, 2), "utf8")
    const fileName = `rpa-creation-${task.requestId}-retry.txt`
    const { fileKey } = await this.yingdao.uploadFile(fileContent, fileName)
    const result = await this.yingdao.startTask({
      scheduleUuid: this.requiredConfig("YINGDAO_SCHEDULE_UUID"),
      idempotentUuid: randomUUID(),
      scheduleRelaParams: [
        {
          robotUuid: this.requiredConfig("YINGDAO_APP_ID"),
          runTimeout: TASK_TIMEOUT_MS / 1000,
          params: [{ name: "paramsFile", value: fileKey, type: "file" }],
        },
      ],
    })

    await this.prisma.rpaCreationTask.update({
      where: { id: task.id },
      data: {
        paramsFileKey: fileKey,
        yingdaoTaskUuid: result.taskUuid,
        yingdaoJobUuidList: result.jobUuidList as Json,
        startedAt: new Date(),
      },
    })
    this.logger.log(
      `RPA 失败结果重试提交成功 taskId=${task.id} quantity=${quantity} taskUuid=${result.taskUuid}`
    )
  }

  private buildRpaPayload(task: RpaCreationTask, quantity = task.quantity): RpaPayload {
    const baseUrl = this.requiredConfig("API_BASE_URL").replace(/\/$/, "")
    const resolution =
      task.mediaType === "VIDEO"
        ? this.validateVideoSettings(task.model, task.durationSec, task.resolution)
        : null
    return {
      schemaVersion: 2,
      requestId: task.requestId,
      mediaType: task.mediaType === "IMAGE" ? "image" : "video",
      ...(task.inputMode ? { inputMode: task.inputMode } : {}),
      prompt: task.prompt,
      model: RPA_MODEL_LABELS[task.model],
      modelCode: task.model,
      aspectRatio: task.aspectRatio,
      quantity,
      ...(task.durationSec ? { duration: task.durationSec } : {}),
      ...(resolution ? { resolution } : {}),
      referenceImageUrls: this.toStringArray(task.referenceImageUrls),
      referenceVideoUrls: this.toStringArray(task.referenceVideoUrls),
      callback: {
        completeUrl: `${baseUrl}/api/rpa-creation/internal/tasks/${task.requestId}/complete`,
      },
    }
  }

  private buildParamsSnapshot(payload: RpaPayload): Json {
    return payload as unknown as Json
  }

  private validateTask(dto: CreateRpaCreationTaskDto) {
    let resolution: string | null = null
    const referenceImageUrls = (dto.referenceImageUrls ?? []).map(url => url.trim())
    const referenceVideoUrls = (dto.referenceVideoUrls ?? []).map(url => url.trim())
    if (referenceImageUrls.length > RPA_CREATION_CAPABILITIES.IMAGE.reference.image.max) {
      throw new BadRequestException("参考图片数量超过限制")
    }
    if (referenceVideoUrls.length > RPA_CREATION_CAPABILITIES.VIDEO.reference.video.max) {
      throw new BadRequestException("参考视频最多只能传一个")
    }
    if (dto.mediaType === "IMAGE") {
      if (!(RPA_IMAGE_MODELS as readonly string[]).includes(dto.model)) {
        throw new BadRequestException("图片模型不受支持")
      }
      if (
        !(RPA_CREATION_CAPABILITIES.IMAGE.aspectRatios as readonly string[]).includes(
          dto.aspectRatio
        )
      ) {
        throw new BadRequestException("图片比例不受支持")
      }
      if (referenceVideoUrls.length) throw new BadRequestException("图片生成不能传参考视频")
      if (
        dto.durationSec !== undefined ||
        dto.inputMode !== undefined ||
        dto.resolution !== undefined
      ) {
        throw new BadRequestException("图片生成不能传视频模式、时长或分辨率")
      }
    } else {
      resolution = this.validateVideoSettings(dto.model, dto.durationSec, dto.resolution)
      if (
        !(RPA_CREATION_CAPABILITIES.VIDEO.aspectRatios as readonly string[]).includes(
          dto.aspectRatio
        )
      ) {
        throw new BadRequestException("视频比例不受支持")
      }
      if (dto.inputMode && dto.inputMode !== "INGREDIENTS") {
        throw new BadRequestException("视频当前仅支持素材模式")
      }
    }
    return { referenceImageUrls, referenceVideoUrls, resolution }
  }

  private validateVideoSettings(
    model: string,
    durationSec: number | null | undefined,
    resolution: string | null | undefined
  ) {
    const limits = RPA_CREATION_CAPABILITIES.VIDEO.models.find(item => item.value === model)
    if (!limits) throw new BadRequestException("视频模型不受支持")
    if (durationSec == null || !(limits.durations as readonly number[]).includes(durationSec)) {
      throw new BadRequestException(
        `${limits.label} 视频时长仅支持 ${limits.durations.join("、")} 秒`
      )
    }
    const selectedResolution = resolution ?? RPA_CREATION_CAPABILITIES.VIDEO.defaultResolution
    if (!(limits.resolutions as readonly string[]).includes(selectedResolution)) {
      throw new BadRequestException(
        `${limits.label} 视频分辨率仅支持 ${limits.resolutions.join("、")}`
      )
    }
    return selectedResolution
  }

  private async verifyReferenceFiles(
    userId: number,
    refs: { referenceImageUrls: string[]; referenceVideoUrls: string[] }
  ) {
    await Promise.all([
      ...refs.referenceImageUrls.map(url => this.verifyReferenceFile(userId, url, "IMAGE")),
      ...refs.referenceVideoUrls.map(url => this.verifyReferenceFile(userId, url, "VIDEO")),
    ])
  }

  private async verifyReferenceFile(userId: number, url: string, mediaType: RpaMediaType) {
    try {
      const metadata = await this.spaces.getPublicObjectMetadata(url)
      if (!metadata.key.startsWith(`${INPUT_KEY_PREFIX}${userId}/`)) {
        throw new BadRequestException("只能使用当前用户在内部创作中上传的素材")
      }
      const expectedType = mediaType === "IMAGE" ? "image/" : "video/"
      const maxSize = mediaType === "IMAGE" ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE
      if (!metadata.contentType?.startsWith(expectedType) || metadata.contentLength > maxSize) {
        await this.spaces.deleteObject(metadata.key)
        throw new BadRequestException(
          `${mediaType === "IMAGE" ? "参考图片" : "参考视频"}的真实类型或大小不符合要求`
        )
      }
    } catch (error: unknown) {
      if (error instanceof BadRequestException) throw error
      this.logger.error(`读取 RPA 参考素材失败 user=${userId}: ${this.errorMessage(error)}`)
      throw new BadRequestException("参考素材尚未上传完成或无法读取，请重新上传")
    }
  }

  private async validateReportedOutputs(task: RpaCreationTask, dto: CompleteRpaTaskDto) {
    if (dto.outputs.length > task.quantity) {
      throw new BadRequestException(`输出数量不能超过 ${task.quantity}`)
    }

    const validations: Array<{ success: boolean; url?: string; deliveryMeta?: Prisma.InputJsonObject; errorMessage?: string }> = []
    for (const [order, item] of dto.outputs.entries()) {
      if (item.status === "FAILED") {
        validations.push({ success: false })
        continue
      }

      if (!item.url) {
        validations.push({ success: false })
        continue
      }

      try {
        const transferred = await this.transferResult(task, item.url, order)
        validations.push({
          success: true,
          ...transferred,
        })
      } catch (error: unknown) {
        if (error instanceof AigcDeliveryError)
          throw new ServiceUnavailableException({ code: error.code, message: error.message })
        this.logger.error(
          `转存 RPA 结果失败 taskId=${task.id} order=${order}: ${this.errorMessage(error)}`
        )
        validations.push({ success: false })
      }
    }
    return validations
  }

  private async transferResult(task: RpaCreationTask, sourceUrl: string, order: number) {
    const source = new URL(sourceUrl)
    const expectedType = task.mediaType === "IMAGE" ? "image/" : "video/"
    const maxSize = expectedType === "image/" ? MAX_IMAGE_SIZE : MAX_RESULT_VIDEO_SIZE
    const apiKey = this.config.get<string>("GEMINI_API_KEY", "").trim()
    if (task.mediaType === "VIDEO") {
      return { url: await deliverVideo(this.spaces, sourceUrl,
        `rpa:${task.requestId}:${order}:${contentId(`${source.origin}${source.pathname}`)}`, {
          maxBytes: MAX_RESULT_VIDEO_SIZE,
          ...(this.matchesHostSuffix(source.hostname, "googleapis.com") && apiKey
            ? { headers: { "x-goog-api-key": apiKey } } : {}),
        }) }
    }
    const response = await axios.get<ArrayBuffer>(source.toString(), {
      responseType: "arraybuffer",
      timeout: RESULT_DOWNLOAD_TIMEOUT_MS,
      maxContentLength: maxSize,
      maxRedirects: 5,
      ...(this.matchesHostSuffix(source.hostname, "googleapis.com") && apiKey
        ? { headers: { "x-goog-api-key": apiKey } }
        : {}),
    })

    const buffer = Buffer.from(response.data)
    if (!buffer.length) throw new Error("结果地址返回了空文件")
    if (buffer.length > maxSize) {
      throw new Error(`结果文件不能超过 ${Math.floor(maxSize / 1024 / 1024)}MB`)
    }

    const rawContentType = response.headers["content-type"]
    const reportedContentType =
      typeof rawContentType === "string" ? rawContentType.split(";")[0].trim().toLowerCase() : ""
    if (
      reportedContentType &&
      reportedContentType !== "application/octet-stream" &&
      !reportedContentType.startsWith(expectedType)
    ) {
      throw new Error(`结果文件类型不正确：${reportedContentType}`)
    }

    const key = `${RESULT_KEY_PREFIX}${task.requestId}/${Date.now()}-${order}`
    const labeled = await retryDelivery(() => labelImage(buffer, `rpa:${task.requestId}:${order}:${contentId(buffer)}`))
    return { url: await this.spaces.uploadBuffer(labeled.buffer, key, labeled.mime, "public-read", objectAigcMetadata(labeled.metadata)),
      deliveryMeta: { width: labeled.width, height: labeled.height } }
  }

  private matchesHostSuffix(hostname: string, suffix: string) {
    return hostname === suffix || hostname.endsWith(`.${suffix}`)
  }

  private async getProjectCounts(projectIds: number[], userId: number) {
    const counts = new Map<number, { taskCount: number; imageCount: number; videoCount: number }>()
    for (const id of projectIds) counts.set(id, { taskCount: 0, imageCount: 0, videoCount: 0 })
    if (!projectIds.length) return counts

    const [generatingTasks, completedTasks] = await Promise.all([
      this.prisma.rpaCreationTask.groupBy({
        by: ["projectId"],
        where: {
          userId,
          projectId: { in: projectIds },
          OR: [
            { status: "PENDING" },
            { outputs: { some: { status: "GENERATING", deletedAt: null } } },
          ],
        },
        _count: { _all: true },
      }),
      this.prisma.rpaCreationTask.groupBy({
        by: ["projectId", "mediaType"],
        where: {
          status: "SUCCESS",
          userId,
          projectId: { in: projectIds },
          outputs: { none: { status: "GENERATING", deletedAt: null } },
        },
        _count: { _all: true },
      }),
    ])
    for (const item of completedTasks) {
      const count = counts.get(item.projectId)!
      if (item.mediaType === "IMAGE") count.imageCount += item._count._all
      else count.videoCount += item._count._all
      count.taskCount += item._count._all
    }
    for (const item of generatingTasks) counts.get(item.projectId)!.taskCount += item._count._all
    return counts
  }

  private async assertProjectOwned(id: number, userId: number) {
    const project = await this.prisma.rpaCreationProject.findUnique({ where: { id } })
    if (!project) throw new NotFoundException("创作项目不存在")
    this.ensureOwner(project.userId, userId)
    return project
  }

  private async assertProjectNameAvailable(
    tx: Prisma.TransactionClient,
    userId: number,
    name: string,
    excludeId?: number
  ) {
    const duplicate = await tx.rpaCreationProject.findFirst({
      where: {
        userId,
        name,
        deletedAt: null,
        ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
      },
      select: { id: true },
    })
    if (duplicate) throw new ConflictException("项目名称已存在")
  }

  private async lockUserProjectNames(tx: Prisma.TransactionClient, userId: number) {
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM \`User\` WHERE id = ${userId} FOR UPDATE
    `
    if (!rows.length) throw new NotFoundException("用户不存在")
  }

  private ensureOwner(ownerId: number, userId: number) {
    if (ownerId !== userId) throw new ForbiddenException("无权访问该资源")
  }

  private async assertInternalTask(requestId: string, authorization: string | undefined) {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) throw new UnauthorizedException("缺少回调凭证")
    const expected = this.requiredConfig("RPA_CALLBACK_TOKEN")
    const receivedBuffer = Buffer.from(token)
    const expectedBuffer = Buffer.from(expected)
    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException("回调凭证无效")
    }
    const task = await this.prisma.rpaCreationTask.findUnique({ where: { requestId } })
    if (!task) throw new NotFoundException("任务不存在")
    return task
  }

  private normalizeIdempotencyKey(value: string | undefined) {
    const key = value?.trim()
    if (!key) throw new BadRequestException("缺少 Idempotency-Key 请求头")
    if (key.length > 100) throw new BadRequestException("Idempotency-Key 不能超过 100 个字符")
    return key
  }

  private isTerminal(status: string) {
    return (RPA_TERMINAL_STATUSES as readonly string[]).includes(status)
  }

  private isTaskStatus(status: string): status is RpaTaskStatus {
    return (RPA_TASK_STATUSES as readonly string[]).includes(status)
  }

  private async publicTasks<T extends RpaCreationTask>(tasks: T[]) {
    const names = await modelDisplayNames(this.prisma, tasks.map(t => t.model))
    return Promise.all(tasks.map(t => this.toPublicTask(t, names)))
  }

  private async toPublicTask<T extends RpaCreationTask & { outputs?: RpaCreationOutput[] }>(
    task: T,
    names?: Map<string, string>
  ) {
    names ??= await modelDisplayNames(this.prisma, [task.model])
    const safe: Partial<T> = { ...task }
    delete safe.paramsSnapshot
    delete safe.paramsFileKey
    delete safe.yingdaoTaskUuid
    delete safe.yingdaoJobUuidList
    return {
      ...safe,
      displayName: names.get(task.model) ?? task.model,
      requestedDurationSec: task.mediaType === "VIDEO" ? task.durationSec : null,
      requestedResolution: task.mediaType === "VIDEO" ? task.resolution : null,
      // 历史任务可能保留旧供应商文案，只在返回时映射，不改原始记录。
      progressMessage:
        task.progressMessage && PROVIDER_NAME_PATTERN.test(task.progressMessage)
          ? "已提交，排队生成中"
          : task.progressMessage,
      errorMessage: this.toPublicErrorMessage(task.errorMessage),
      ...(task.outputs
        ? {
            outputs: task.outputs.map(output => ({
              ...output,
              errorMessage: this.toPublicErrorMessage(output.errorMessage),
              width: jsonObject(output.deliveryMeta).width ?? null,
              height: jsonObject(output.deliveryMeta).height ?? null,
            })),
          }
        : {}),
      resolution:
        task.mediaType === "VIDEO"
          ? (task.resolution ?? RPA_CREATION_CAPABILITIES.VIDEO.defaultResolution)
          : null,
      // 永久保留后继续返回 isExpired 字段以兼容前端，但固定为 false。
      isExpired: false,
      // 原 7 天过期逻辑：
      // isExpired: !!task.expiresAt && task.expiresAt.getTime() <= Date.now(),
    }
  }

  private toPublicErrorMessage(message: string | null) {
    if (!message || !PROVIDER_NAME_PATTERN.test(message)) return message
    return /超时|超过.*小时|timeout|timed?\s*out/i.test(message)
      ? "生成超时，请重试"
      : "生成失败，请重试"
  }

  private async lockTask(tx: Prisma.TransactionClient, taskId: number) {
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM RpaCreationTask WHERE id = ${taskId} AND deletedAt IS NULL FOR UPDATE
    `
    if (!rows.length) throw new NotFoundException("任务不存在")
  }

  private async lockProjectTasks(tx: Prisma.TransactionClient, projectId: number, userId: number) {
    await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM RpaCreationTask
      WHERE projectId = ${projectId} AND userId = ${userId} AND deletedAt IS NULL
      ORDER BY id FOR UPDATE
    `
  }

  private toStringArray(value: Prisma.JsonValue): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : []
  }

  private requiredConfig(name: string) {
    const value = this.config.get<string>(name, "").trim()
    if (!value) {
      this.logger.error(`未配置 ${name}`)
      throw new ServiceUnavailableException("生成服务暂不可用，请稍后重试")
    }
    return value
  }

  private isUniqueConstraintError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000)
  }

  // 已停用：RPA 文件改为永久保留。保留原生命周期配置方法便于将来恢复。
  // private async ensureRetentionRule(prefix: string, ruleId: string) {
  //   try {
  //     await this.spaces.ensureExpirationRule(prefix, RETENTION_DAYS, ruleId)
  //   } catch (error: unknown) {
  //     this.logger.error(`设置 ${prefix} 生命周期失败：${this.errorMessage(error)}`)
  //   }
  // }
}
