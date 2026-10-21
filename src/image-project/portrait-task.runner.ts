import {
  BadGatewayException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { buildCenterCropDirective } from "../common/utils/image-crop-safe-prompt"
import { planPortraitSizing, type PortraitDeliveryPlan } from "./portrait-size-planner"
import type { PortraitImageGenerator, PortraitReferenceImage } from "./portrait-image-generator"
import { PORTRAIT_IMAGE_GENERATOR } from "./portrait-image-generator"

@Injectable()
export class PortraitTaskRunner implements OnModuleInit {
  private readonly logger = new Logger(PortraitTaskRunner.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PORTRAIT_IMAGE_GENERATOR)
    private readonly generator: PortraitImageGenerator
  ) {}

  async onModuleInit() {
    if (!this.generator.isAvailable()) return
    const tasks = await this.prisma.generationTask.findMany({
      where: {
        type: "PORTRAIT",
        status: "GENERATING",
        gatewayTaskId: null,
      },
      select: { id: true },
    })
    for (const task of tasks) void this.run(task.id)
  }

  /**
   * 只负责将本地人像任务提交给 AI Gateway 并建立关联。
   * 任务终态完全由 Gateway 回调更新，这里不会查询或轮询远端任务状态。
   */
  async run(taskId: number): Promise<void> {
    try {
      const task = await this.prisma.generationTask.findUnique({
        where: { id: taskId },
        include: {
          generatedImages: {
            where: { deletedAt: null },
            orderBy: [{ order: "asc" }, { id: "asc" }],
          },
        },
      })
      if (!task || task.type !== "PORTRAIT" || task.status !== "GENERATING") return
      // 统一局部重绘由通用执行器认领，启动恢复不能再次提交人像模型。
      if ((task.executionSpec as { localRedraw?: unknown } | null)?.localRedraw) return
      if (task.gatewayTaskId) return

      const generatingImages = task.generatedImages.filter(image => image.status === "GENERATING")
      if (generatingImages.length === 0) return

      const legacyJobIds = [
        ...new Set(generatingImages.map(image => image.providerJobId).filter(Boolean)),
      ] as string[]
      if (legacyJobIds.length > 0) {
        await this.failTask(task.id, "历史人像任务未启用回调，请重新生成")
        return
      }

      const deliveryPlan = task.deliveryPlan as unknown as PortraitDeliveryPlan | null
      const modelParams = this.readModelParams(task.promptConfig, task.aspectRatio)
      const effectiveModelParams = deliveryPlan?.requested?.aspectRatio && deliveryPlan.requested.resolutionTier
        ? planPortraitSizing({ target: deliveryPlan.requested, modelParams }).providerModelParams
        : modelParams
      const prompt = deliveryPlan?.cropAnchor === "centre" && !deliveryPlan.nativeSizing
        ? `${task.prompt}\n\n${buildCenterCropDirective(deliveryPlan.requested.aspectRatio)}`
        : task.prompt
      const result = await this.generator.submit({
        ...(deliveryPlan?.nativeSizing ? { nativeSizing: true } : {}),
        taskId: task.id,
        prompt,
        model: task.model,
        quantity: generatingImages.length,
        referenceImages: this.readReferences(task.promptConfig),
        modelParams: effectiveModelParams,
        idempotencyKey: `portrait-generation-task:${task.id}`,
      })

      if (!result.jobId.trim()) throw new Error("模型未返回任务 ID")
      await this.prisma.$transaction(async tx => {
        const linked = await tx.generationTask.updateMany({
          where: {
            id: task.id,
            status: "GENERATING",
            gatewayTaskId: null,
            deletedAt: null,
          },
          data: { gatewayTaskId: result.jobId },
        })
        if (linked.count === 0) return

        await tx.generatedImage.updateMany({
          where: { taskId: task.id, deletedAt: null, status: "GENERATING" },
          data: { providerJobId: result.jobId },
        })
      })
      this.logger.log(`[人像生成] Gateway 任务已关联 task=${task.id} gatewayTask=${result.jobId}`)
    } catch (error) {
      const message = this.errorMessage(error)
      if (error instanceof BadGatewayException || error instanceof GatewayTimeoutException) {
        this.logger.warn(
          `[人像生成] Gateway 提交结果不确定，保留任务等待回调或启动恢复 task=${taskId}: ${message}`
        )
        return
      }

      this.logger.error(`人像生成任务提交失败 [taskId=${taskId}] ${message}`)
      await this.failTask(taskId, message)
    }
  }

  private async failTask(taskId: number, message: string) {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true },
    })
    if (!task) return

    await this.prisma.$transaction(async tx => {
      await tx.generatedImage.updateMany({
        where: { taskId, deletedAt: null, status: "GENERATING" },
        data: { status: "FAILED", errorMessage: message },
      })
      await tx.generationTask.updateMany({
        where: { id: taskId, status: "GENERATING", deletedAt: null },
        data: { status: "FAILED", errorMessage: message },
      })
      await this.recomputeProject(tx, task.projectId)
    })
  }

  private async recomputeProject(tx: Prisma.TransactionClient, projectId: number) {
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

  private readReferences(value: unknown): PortraitReferenceImage[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    const references = (value as Record<string, unknown>).references
    if (!Array.isArray(references)) return []
    return references.flatMap(reference => {
      if (!reference || typeof reference !== "object" || Array.isArray(reference)) return []
      const row = reference as Record<string, unknown>
      return typeof row.url === "string" && typeof row.purpose === "string"
        ? [{ url: row.url, purpose: row.purpose }]
        : []
    })
  }

  private readModelParams(value: unknown, legacyAspectRatio: string | null) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const modelParams = (value as Record<string, unknown>).model_params
      if (modelParams && typeof modelParams === "object" && !Array.isArray(modelParams)) {
        return { ...(modelParams as Record<string, unknown>) }
      }
    }
    return {
      ...(legacyAspectRatio ? { aspect_ratio: legacyAspectRatio } : {}),
      output_format: "png",
    }
  }

  private errorMessage(error: unknown) {
    if (error instanceof Error) return error.message.slice(0, 2000)
    return "人像生成任务提交失败"
  }
}
