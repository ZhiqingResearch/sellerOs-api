import { BadRequestException, HttpException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { ModuleRef } from "@nestjs/core"
import { Prisma } from "@prisma/client"
import { AiGatewayWebhookService } from "../ai-gateway/ai-gateway-webhook.service"
import { GenerateService } from "../image-generation/generate.service"
import { readImageUsage } from "../image-generation/image-usage"
import { LocalRedrawPlan } from "../image-generation/local-redraw.constants"
import { imageMetadata, modelDisplayNames } from "../common/utils/generation-metadata"
import { PrismaService } from "../prisma/prisma.service"
import { AiSplitService } from "./ai-split.service"
import { ImageProjectService } from "./image-project.service"
import { InternalCreateAiSplitTaskDto } from "./internal-ai-split.dto"
import { PortraitCreationService } from "./portrait-creation.service"

type JsonIn = Prisma.InputJsonValue

/** VidFlowOS 通用生图提交入参（透传 sellorOs ProductImageGenerateForm） */
export interface InternalCreateImageTaskInput {
  phone: string
  request: Record<string, unknown>
}

/** VidFlowOS 人像提交入参（透传 PortraitCreationService 校验） */
export interface InternalCreatePortraitTaskInput {
  phone: string
  request: Record<string, unknown>
}

/** VidFlowOS 批量改图归档入参（透传 CreateTaskDto 形状，含 sourceJobId/generatedImages） */
export interface InternalArchiveI2IInput {
  phone: string
  request: Record<string, unknown>
}

/**
 * VidFlowOS 内部图片生成代理：三条管线（通用/人像/AI拆图）。
 * 通用生图透传完整表单调 GenerateService 管线（prompt 编译 + 执行器 + 网关）；
 * 共用创建服务在落库时写入 source=vidflowos。
 */
@Injectable()
export class InternalImageGenerationService {
  private readonly logger = new Logger(InternalImageGenerationService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    private readonly gatewayWebhook: AiGatewayWebhookService,
    private readonly imageProject: ImageProjectService,
    private readonly portraitCreation: PortraitCreationService,
    private readonly aiSplit: AiSplitService
  ) {}

  // =========================================================
  // 通用生图（透传表单调 GenerateService 管线）
  // =========================================================

  async createGeneralTask(input: InternalCreateImageTaskInput) {
    const user = await this.mapUser(input.phone)
    const projectId = await this.ensureContainerProject(user.id, "GENERAL")

    // 注入容器项目 ID（GenerateService 要求 projectId 必填）；parseForm 只接受
    // JSON 字符串（与公开 multipart 入口的 form 文本字段同构），对象会被 400 拒绝
    const form = JSON.stringify({ ...input.request, projectId: String(projectId) })

    // GenerateService 在 ImageGenerationModule，用 ModuleRef 懒加载避免循环依赖
    const generateService = this.moduleRef.get(GenerateService, { strict: false })
    if (!generateService) throw new NotFoundException("生图服务不可用")

    const result = await generateService.create({ form }, user.id, "vidflowos")
    if (!result.ok) {
      if (input.request.editMode === "local-redraw") throw new HttpException(result.error, result.status)
      throw new BadRequestException(result.error)
    }

    this.logger.log({
      event: "internal_image.general_submitted",
      taskId: result.taskId,
      userId: user.id,
    })
    return { taskId: result.taskId, status: "GENERATING", ...(result.localRedraw ? { localRedraw: result.localRedraw } : {}) }
  }

  // =========================================================
  // 人像创作（代理 PortraitCreationService）
  // =========================================================

  async createPortraitTask(input: InternalCreatePortraitTaskInput) {
    const user = await this.mapUser(input.phone)
    const projectId = await this.ensureContainerProject(user.id, "PORTRAIT")

    const result = await this.portraitCreation.createTask(
      projectId,
      input.request as never,
      user.id,
      "vidflowos"
    )

    this.logger.log({
      event: "internal_image.portrait_submitted",
      taskId: result.id,
      userId: user.id,
    })
    return { taskId: result.id }
  }

  // =========================================================
  // AI 拆图（代理 AiSplitService）
  // =========================================================

  async createAiSplitTasks(input: InternalCreateAiSplitTaskDto) {
    if (
      input.request.competitorReferences.some(reference => reference.sourceType !== "DIRECT_URL")
    ) {
      throw new BadRequestException(
        "内部拆图竞品引用必须使用 DIRECT_URL，本地素材 ID 不能跨系统查询"
      )
    }
    const user = await this.mapUser(input.phone)
    const projectId = await this.ensureContainerProject(user.id, "ECOMMERCE")

    const result = await this.aiSplit.createTasks(
      projectId,
      input.request,
      user.id,
      input.request.productSnapshot,
      "vidflowos"
    )

    const tasks = (result as { tasks?: Array<{ id: number }> }).tasks ?? []
    const taskIds = tasks.map(t => t.id)
    this.logger.log({
      event: "internal_image.ai_split_submitted",
      userId: user.id,
      taskIds,
    })
    return result
  }

  // =========================================================
  // 批量改图归档（i2i 成品入库快照行，sourceJobId 回链）
  // =========================================================

  async archiveI2I(input: InternalArchiveI2IInput) {
    const user = await this.mapUser(input.phone)
    const sourceJobId =
      typeof input.request.sourceJobId === "string" ? input.request.sourceJobId : null

    let localRedraw: LocalRedrawPlan | undefined
    let resolutionTier: string | null = null
    // 幂等护栏：job 已回写 taskId 说明归档过（vidflowos 侧「源平台成功、本地
    // 建行失败后重试」场景），直接返回原任务，不产生双行
    if (sourceJobId) {
      const job = await this.prisma.imageGenJob.findFirst({
        where: { id: sourceJobId, userId: user.id, source: "vidflowos" },
        select: { taskId: true, request: true },
      })
      if (!job) throw new NotFoundException("改图任务不存在")
      localRedraw = (job.request as { localRedraw?: LocalRedrawPlan } | null)?.localRedraw
      resolutionTier = imageMetadata({ executionSpec: { form: job.request, localRedraw } }).resolutionTier
      if (job.taskId) {
        const task = await this.prisma.generationTask.findFirst({
          where: {
            id: job.taskId,
            userId: user.id,
            source: "vidflowos",
            project: { source: "vidflowos" },
          },
          select: { id: true },
        })
        if (!task) throw new NotFoundException("归档任务不存在")
        return { taskId: task.id, duplicate: true, resolutionTier, ...(localRedraw ? { localRedraw } : {}) }
      }
    }

    const projectId = await this.ensureContainerProject(user.id, "GENERAL")
    // createTask 内部同事务回写 ImageGenJob.taskId（sourceJobId 归属校验内建），
    // 生成记录视图据此隐藏原 IMAGEGEN 行、积分挂到本行
    const task = await this.imageProject.createTask(
      projectId,
      { ...input.request, ...(localRedraw ? { model: localRedraw.provider, aspectRatio: `${localRedraw.generationWidth}:${localRedraw.generationHeight}` } : {}) } as never,
      user.id,
      "vidflowos"
    )

    this.logger.log({
      event: "internal_image.i2i_archived",
      taskId: task.id,
      sourceJobId,
      userId: user.id,
    })
    return { taskId: task.id, duplicate: false, resolutionTier, ...(localRedraw ? { localRedraw } : {}) }
  }

  // =========================================================
  // 查询（读时对账 + UsageLog 留痕）
  // =========================================================

  async getImageTask(taskId: number) {
    let task = await this.prisma.generationTask.findFirst({
      where: { id: taskId, source: "vidflowos", project: { source: "vidflowos" }, deletedAt: null },
      include: {
        generatedImages: {
          where: { source: "vidflowos", deletedAt: null },
          orderBy: { order: "asc" },
        },
      },
    })
    if (!task) throw new NotFoundException("任务不存在")

    if (task.status === "GENERATING" && task.gatewayTaskId) {
      await this.gatewayWebhook.reconcileImageTaskOnRead(task)
      task = (await this.prisma.generationTask.findFirst({
        where: { id: taskId, source: "vidflowos", project: { source: "vidflowos" }, deletedAt: null },
        include: {
          generatedImages: { where: { source: "vidflowos", deletedAt: null }, orderBy: { order: "asc" } },
        },
      })) ?? task
    }

    const { costCny, creditsCharged } = await readImageUsage(this.prisma, task.userId, {
      taskId: task.id,
      jobId: task.sourceJobId,
      gatewayTaskId: task.gatewayTaskId,
    })
    const modelPublicId = imageMetadata(task).modelPublicId ?? task.model
    const names = await modelDisplayNames(this.prisma, [modelPublicId])

    return {
      status: task.status,
      displayName: names.get(modelPublicId) ?? null,
      errorMessage: task.errorMessage,
      aiSplitStage: task.aiSplitStage,
      costCny,
      creditsCharged,
      images: task.generatedImages.map(img => ({
        id: img.id,
        // 席位序号（0 基）：vidflowos 据此对位回填本地席位，id 是全局主键不可作序号
        order: img.order,
        status: img.status,
        url: img.url,
        originalUrl: img.originalUrl,
        width: img.width,
        height: img.height,
      })),
    }
  }

  // =========================================================
  // 私有
  // =========================================================

  private async mapUser(phone: string) {
    const user = await this.prisma.user.findUnique({
      where: { phone: phone.trim() },
      select: { id: true },
    })
    if (!user) throw new NotFoundException({ code: "USER_NOT_FOUND" })
    return user
  }

  private async ensureContainerProject(userId: number, type: string): Promise<number> {
    const existing = await this.prisma.imageProject.findFirst({
      where: { userId, type, source: "vidflowos", deletedAt: null },
      select: { id: true },
      orderBy: { id: "asc" },
    })
    if (existing) return existing.id
    const created = await this.prisma.imageProject.create({
      data: {
        name: `VidFlowOS ${type === "GENERAL" ? "通用" : type === "PORTRAIT" ? "人像" : "拆图"}创作`,
        type,
        source: "vidflowos",
        userId,
      },
      select: { id: true },
    })
    return created.id
  }
}
