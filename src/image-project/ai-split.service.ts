import { imageMetadata, modelDisplayNames } from "../common/utils/generation-metadata"
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { createHash, randomUUID } from "crypto"
import { extname } from "path"
import { AiGatewayWebhookService } from "../ai-gateway/ai-gateway-webhook.service"
import { POOL_IMAGE_KIND } from "../material-pool/pool-image.constants"
import type { CreationSource } from "../common/types/creation-source"
import { PrismaService } from "../prisma/prisma.service"
import { SpacesService } from "../spaces/spaces.service"
import { UsageService } from "../usage/usage.service"
import { AiSplitTaskRunner } from "./ai-split-task.runner"
import {
  AiSplitImageIdsDto,
  AiSplitUploadUrlDto,
  CreateAiSplitTaskDto,
  CreateAiSplitTemplateTaskDto,
  QueryAiSplitCompetitorImagesDto,
  QueryAiSplitTasksDto,
  RetryAiSplitTaskDto,
  SaveAiSplitResultsToTemplateDto,
  ValidateAiSplitReferenceUrlDto,
} from "./ai-split.dto"
import {
  AI_SPLIT_IMAGE_MODEL_CATEGORY,
  AI_SPLIT_STAGES,
  AiSplitPromptSnapshot,
  readAiSplitSnapshot,
} from "./ai-split.types"
import { AiSplitValidator } from "./ai-split.validator"
import type { InternalAiSplitProductSnapshotDto } from "./internal-ai-split.dto"

type SplitTaskWithImages = Prisma.GenerationTaskGetPayload<{
  include: { generatedImages: true }
}>

@Injectable()
export class AiSplitService {
  private readonly logger = new Logger(AiSplitService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: AiSplitValidator,
    private readonly runner: AiSplitTaskRunner,
    private readonly spaces: SpacesService,
    private readonly usage: UsageService,
    private readonly gatewayWebhook: AiGatewayWebhookService
  ) {}

  async createTasks(
    projectId: number,
    dto: CreateAiSplitTaskDto,
    userId: number,
    productSnapshot?: InternalAiSplitProductSnapshotDto,
    source: CreationSource = "platform"
  ) {
    const existing = await this.prisma.generationTask.findFirst({
      where: {
        userId,
        source,
        project: { source },
        clientRequestId: dto.clientRequestId,
        generationMode: "AI_SPLIT",
      },
      select: { groupId: true },
    })
    if (existing?.groupId) return this.getTaskGroup({ groupId: existing.groupId }, userId, source)

    const projectSnapshot = await this.validator.buildProjectSnapshot(
      projectId,
      userId,
      dto.site,
      productSnapshot,
      source
    )
    const [analysisModel, references, imageModel] = await Promise.all([
      this.validator.loadAnalysisModel(),
      this.validator.resolveCompetitorReferences(dto.competitorReferences, projectId, userId),
      this.validator.validateImageModel(dto, projectSnapshot.productImages),
    ])
    // 固定一口价（组合价）预检：AI_SPLIT 行配置 fixedCredits → 按
    // 「组合单价 × 方向数 × 张数」校验余额（不打折口径）；未配置回落现状不预检。
    const fixedCredits = await this.usage.gatewayFixedImageCredits(
      imageModel.publicId,
      AI_SPLIT_IMAGE_MODEL_CATEGORY
    )
    if (fixedCredits) {
      await this.usage.assertExactCreditsAffordable(
        userId,
        fixedCredits.mul(references.length).mul(dto.quantity)
      )
    }
    const groupId = randomUUID()
    this.logger.log(
      `[AI 拆图] 创建任务组 user=${userId} project=${projectId} groupId=${groupId} directions=${references.length}: ${JSON.stringify(dto)}`
    )
    const promptVersions = this.runner.getPromptVersions()
    // 任务行记录用户请求的目标比例（规划后）；实际提交给模型的参数以 modelParams 为准
    const aspectRatio =
      imageModel.deliveryPlan?.requested.aspectRatio ??
      (typeof imageModel.modelParams.aspect_ratio === "string"
        ? imageModel.modelParams.aspect_ratio
        : null)

    let tasks
    try {
      tasks = await this.prisma.$transaction(
        async tx => {
          const created = []
          for (let directionIndex = 0; directionIndex < references.length; directionIndex += 1) {
            const snapshot: AiSplitPromptSnapshot = {
              schemaVersion: "ai-split.v1",
              analysisModel: {
                id: analysisModel.id,
                publicId: analysisModel.publicId,
                displayName: analysisModel.displayName,
                gatewayConfig: analysisModel.gatewayConfig,
              },
              reference: references[directionIndex],
              currentProduct: projectSnapshot.currentProduct,
              currentProductKeys: projectSnapshot.currentProductKeys,
              productImages: projectSnapshot.productImages,
              generationSettings: {
                site: dto.site,
                locale: projectSnapshot.locale,
                language: projectSnapshot.language,
                textAmount: dto.textAmount,
                model: imageModel.publicId,
                quantity: dto.quantity,
                modelParams: imageModel.modelParams,
                supportsNegativePrompt: imageModel.supportsNegativePrompt,
              },
              promptVersions,
              gatewayCalls: {},
            }
            const task = await tx.generationTask.create({
              data: {
                projectId,
                userId,
                source,
                type: "ECOMMERCE",
                generationMode: "AI_SPLIT",
                groupId,
                clientRequestId: dto.clientRequestId,
                directionIndex,
                aiSplitStage: AI_SPLIT_STAGES.QUEUED,
                presetCategory: "AI_SPLIT",
                presetOption: references[directionIndex].sourceType,
                model: imageModel.publicId,
                prompt: "AI 拆图提示词生成中",
                promptConfig: snapshot as unknown as Prisma.InputJsonValue,
                textAmount: dto.textAmount,
                language: projectSnapshot.locale,
                aspectRatio,
                deliveryPlan: (imageModel.deliveryPlan ?? undefined) as unknown as
                  | Prisma.InputJsonValue
                  | undefined,
                n: dto.quantity,
                refImageUrls: projectSnapshot.productImages.map(image => image.url),
                status: "GENERATING",
                generatedImages: {
                  create: Array.from({ length: dto.quantity }, (_, order) => ({
                    source,
                    status: "GENERATING",
                    order,
                  })),
                },
              },
              include: {
                generatedImages: { orderBy: [{ order: "asc" }, { id: "asc" }] },
              },
            })
            created.push(task)
          }
          await tx.imageProject.updateMany({
            where: { id: projectId, userId, status: { not: "ARCHIVED" }, deletedAt: null },
            data: { status: "GENERATING" },
          })
          return created
        },
        { timeout: 15_000 }
      )
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const duplicate = await this.prisma.generationTask.findFirst({
          where: {
            userId,
            source,
            project: { source },
            clientRequestId: dto.clientRequestId,
            generationMode: "AI_SPLIT",
          },
          select: { groupId: true },
        })
        if (duplicate?.groupId)
          return this.getTaskGroup({ groupId: duplicate.groupId }, userId, source)
      }
      throw error
    }

    void this.persistSelectedUploads(projectId, dto, references, userId)
    for (const task of tasks) void this.runner.run(task.id)
    return this.getTaskGroup({ groupId }, userId, source)
  }

  async createTasksFromTemplate(
    projectId: number,
    templateId: number,
    dto: CreateAiSplitTemplateTaskDto,
    userId: number
  ) {
    const existing = await this.prisma.generationTask.findFirst({
      where: {
        userId,
        source: "platform",
        project: { source: "platform" },
        clientRequestId: dto.clientRequestId,
        generationMode: "AI_SPLIT",
      },
      select: { groupId: true },
    })
    if (existing?.groupId) return this.getTaskGroup({ groupId: existing.groupId }, userId)

    const templateItemIds = dto.items.map(item => item.templateItemId)
    const template = await this.prisma.imageTemplate.findFirst({
      where: {
        id: templateId,
        deletedAt: null,
        OR: [{ isSystem: true }, { userId }],
      },
      include: {
        items: {
          where: { id: { in: templateItemIds } },
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        },
      },
    })
    if (!template) throw new NotFoundException("AI 拆图模板不存在或不可访问")
    if (template.items.length !== templateItemIds.length) {
      throw new BadRequestException("部分模板条目不存在或不属于该模板")
    }

    const analysisModel = await this.validator.loadAnalysisModel()
    const promptVersions = this.runner.getPromptVersions()
    const itemById = new Map(template.items.map(item => [item.id, item]))
    const projectSnapshots = new Map<
      string,
      Awaited<ReturnType<AiSplitValidator["buildProjectSnapshot"]>>
    >()
    const prepared: Array<{
      input: (typeof dto.items)[number]
      item: (typeof template.items)[number]
      projectSnapshot: Awaited<ReturnType<AiSplitValidator["buildProjectSnapshot"]>>
      competitorTemplate: Record<string, unknown>
      imageModel: Awaited<ReturnType<AiSplitValidator["validateImageModel"]>>
    }> = []

    for (const input of dto.items) {
      const item = itemById.get(input.templateItemId)!
      if (
        item.promptVersion !== "v3" ||
        !item.prompt ||
        !item.promptHash ||
        createHash("sha256").update(item.prompt).digest("hex") !== item.promptHash
      ) {
        throw new BadRequestException(`模板条目 ${item.id} 的 Prompt 版本或哈希无效`)
      }

      let projectSnapshot = projectSnapshots.get(input.site)
      if (!projectSnapshot) {
        projectSnapshot = await this.validator.buildProjectSnapshot(projectId, userId, input.site)
        projectSnapshots.set(input.site, projectSnapshot)
      }
      const competitorTemplate = this.validator.validateReusableCompetitorTemplate(
        item.competitorTemplate,
        projectSnapshot.currentProductKeys
      )
      const imageModel = await this.validator.validateImageModel(
        {
          model: input.model,
          quantity: input.quantity,
          promptConfig: input.promptConfig,
          deliveryTarget: input.deliveryTarget,
        },
        projectSnapshot.productImages
      )
      prepared.push({ input, item, projectSnapshot, competitorTemplate, imageModel })
    }

    // 固定一口价（组合价）预检（模板链路）：逐条目按其模型组合价 × 张数累加校验
    const fixedByModel = new Map<string, Decimal | null>()
    let fixedCreditsTotal: Decimal | null = null
    for (const { input, imageModel } of prepared) {
      if (!fixedByModel.has(imageModel.publicId)) {
        fixedByModel.set(
          imageModel.publicId,
          await this.usage.gatewayFixedImageCredits(
            imageModel.publicId,
            AI_SPLIT_IMAGE_MODEL_CATEGORY
          )
        )
      }
      const fixed = fixedByModel.get(imageModel.publicId)
      if (fixed) {
        fixedCreditsTotal = (fixedCreditsTotal ?? new Decimal(0)).plus(fixed.mul(input.quantity))
      }
    }
    if (fixedCreditsTotal) {
      await this.usage.assertExactCreditsAffordable(userId, fixedCreditsTotal)
    }

    const groupId = randomUUID()
    this.logger.log(
      `[AI 拆图] 模板复用创建任务组 user=${userId} project=${projectId} groupId=${groupId} template=${templateId} items=${prepared.length}: ${JSON.stringify(dto)}`
    )
    let tasks
    try {
      tasks = await this.prisma.$transaction(
        async tx => {
          const created = []
          for (let directionIndex = 0; directionIndex < prepared.length; directionIndex += 1) {
            const { input, item, projectSnapshot, competitorTemplate, imageModel } =
              prepared[directionIndex]
            const snapshot: AiSplitPromptSnapshot = {
              schemaVersion: "ai-split.v1",
              analysisModel: {
                id: analysisModel.id,
                publicId: analysisModel.publicId,
                displayName: analysisModel.displayName,
                gatewayConfig: analysisModel.gatewayConfig,
              },
              reference: { sourceType: "TEMPLATE", sourceId: item.id },
              currentProduct: projectSnapshot.currentProduct,
              currentProductKeys: projectSnapshot.currentProductKeys,
              productImages: projectSnapshot.productImages,
              competitorTemplate,
              generationSettings: {
                site: input.site,
                locale: projectSnapshot.locale,
                language: projectSnapshot.language,
                textAmount: input.textAmount,
                model: imageModel.publicId,
                quantity: input.quantity,
                modelParams: imageModel.modelParams,
                supportsNegativePrompt: imageModel.supportsNegativePrompt,
              },
              promptVersions,
              gatewayCalls: {},
            }
            const aspectRatio =
              imageModel.deliveryPlan?.requested.aspectRatio ??
              (typeof imageModel.modelParams.aspect_ratio === "string"
                ? imageModel.modelParams.aspect_ratio
                : null)
            const task = await tx.generationTask.create({
              data: {
                projectId,
                userId,
                type: "ECOMMERCE",
                generationMode: "AI_SPLIT",
                groupId,
                clientRequestId: dto.clientRequestId,
                directionIndex,
                aiSplitStage: AI_SPLIT_STAGES.PRODUCT_PLANNING,
                presetCategory: "AI_SPLIT_TEMPLATE",
                presetOption: String(item.id),
                model: imageModel.publicId,
                prompt: "AI 拆图模板复用提示词生成中",
                promptConfig: snapshot as unknown as Prisma.InputJsonValue,
                textAmount: input.textAmount,
                language: projectSnapshot.locale,
                aspectRatio,
                deliveryPlan: (imageModel.deliveryPlan ?? undefined) as unknown as
                  | Prisma.InputJsonValue
                  | undefined,
                n: input.quantity,
                refImageUrls: projectSnapshot.productImages.map(image => image.url),
                status: "GENERATING",
                generatedImages: {
                  create: Array.from({ length: input.quantity }, (_, order) => ({
                    status: "GENERATING",
                    order,
                  })),
                },
              },
              include: {
                generatedImages: { orderBy: [{ order: "asc" }, { id: "asc" }] },
              },
            })
            created.push(task)
          }
          await tx.imageProject.updateMany({
            where: { id: projectId, userId, status: { not: "ARCHIVED" }, deletedAt: null },
            data: { status: "GENERATING" },
          })
          return created
        },
        { timeout: 15_000 }
      )
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const duplicate = await this.prisma.generationTask.findFirst({
          where: {
            userId,
            source: "platform",
            project: { source: "platform" },
            clientRequestId: dto.clientRequestId,
            generationMode: "AI_SPLIT",
          },
          select: { groupId: true },
        })
        if (duplicate?.groupId) return this.getTaskGroup({ groupId: duplicate.groupId }, userId)
      }
      throw error
    }

    for (const task of tasks) void this.runner.run(task.id)
    return this.getTaskGroup({ groupId }, userId)
  }

  async getTaskGroup(
    query: QueryAiSplitTasksDto,
    userId: number,
    source: CreationSource = "platform"
  ) {
    const { groupId, projectId } = query
    if (!groupId && projectId === undefined) {
      throw new BadRequestException("groupId 与 projectId 至少传一个")
    }
    if (!groupId) return this.listProjectGroups(projectId as number, userId, source)

    const tasks = await this.findSplitTasksByGroup(groupId, userId, source)
    if (tasks.length === 0) throw new NotFoundException("AI 拆图任务组不存在")
    // 读时对账：组内有卡在 GENERATING 的网关任务时主动查一次真实状态，回调丢失自愈
    const reconciled = await this.reconcileGeneratingTasks(tasks)
    const fresh = reconciled ? await this.findSplitTasksByGroup(groupId, userId, source) : tasks
    const names = await modelDisplayNames(this.prisma, fresh.map(t => t.model))
    return this.buildTaskGroupSnapshot(fresh, groupId, names)
  }

  /** projectId 维度：返回项目下全部 AI 拆图任务组，按组内最新任务时间倒序，最新组带 isLatest。 */
  private async listProjectGroups(projectId: number, userId: number, source: CreationSource) {
    let tasks = await this.findProjectSplitTasks(projectId, userId, source)
    if (tasks.length === 0) throw new NotFoundException("该项目暂无 AI 拆图任务")
    const reconciled = await this.reconcileGeneratingTasks(tasks)
    if (reconciled) tasks = await this.findProjectSplitTasks(projectId, userId, source)

    // 按组聚合；tasks 已按创建时间倒序，Map 首次插入的组即最新组
    const tasksByGroup = new Map<string, SplitTaskWithImages[]>()
    for (const task of tasks) {
      const groupTasks = tasksByGroup.get(task.groupId!) ?? []
      groupTasks.push(task)
      tasksByGroup.set(task.groupId!, groupTasks)
    }
    const names = await modelDisplayNames(this.prisma, tasks.map(t => t.model))
    const [first] = tasks
    const latestGroupId = first?.groupId ?? null
    const groups = [...tasksByGroup.entries()].map(([groupId, groupTasks]) => {
      const snapshot = this.buildTaskGroupSnapshot(groupTasks, groupId, names)
      return {
        groupId: snapshot.groupId,
        clientRequestId: snapshot.clientRequestId,
        isLatest: groupId === latestGroupId,
        status: snapshot.status,
        directionCount: snapshot.directionCount,
        quantity: snapshot.quantity,
        expectedImageCount: snapshot.expectedImageCount,
        successCount: snapshot.results.filter(image => image.status === "SUCCESS").length,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        coverUrl:
          snapshot.results.find(image => image.status === "SUCCESS" && image.url)?.url ?? null,
        results: snapshot.results,
      }
    })
    return { projectId, groups }
  }

  private findProjectSplitTasks(projectId: number, userId: number, source: CreationSource) {
    return this.prisma.generationTask.findMany({
      where: { userId, generationMode: "AI_SPLIT", projectId, source, project: { source } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: {
        generatedImages: {
          where: { source, deletedAt: null },
          orderBy: [{ order: "asc" }, { id: "asc" }],
        },
      },
    })
  }

  private findSplitTasksByGroup(groupId: string, userId: number, source: CreationSource) {
    return this.prisma.generationTask.findMany({
      where: { userId, generationMode: "AI_SPLIT", groupId, source, project: { source } },
      orderBy: [{ directionIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      include: {
        generatedImages: {
          where: { source, deletedAt: null },
          orderBy: [{ order: "asc" }, { id: "asc" }],
        },
      },
    })
  }

  /** 读时对账入口：卡在 GENERATING 的网关任务主动查真实状态（2 分钟节流）；返回是否有行实际查询过 */
  private async reconcileGeneratingTasks(
    tasks: Array<{ id: number; status: string; gatewayTaskId: string | null }>
  ) {
    const results = await Promise.all(
      tasks.map(task => this.gatewayWebhook.reconcileImageTaskOnRead(task))
    )
    return results.some(reconciled => reconciled)
  }

  private buildTaskGroupSnapshot(tasks: SplitTaskWithImages[], groupId: string, names: Map<string, string> = new Map()) {
    const originals = tasks.filter(task => task.retryOfTaskId === null)
    const running = tasks.some(task => task.status === "GENERATING")
    // 重试任务保留历史记录；逻辑席位优先保留最新成功图，没有成功图时才取最新状态。
    const latestImages = new Map<
      string,
      {
        task: SplitTaskWithImages
        image: SplitTaskWithImages["generatedImages"][number]
      }
    >()
    for (const task of tasks) {
      for (const image of task.generatedImages) {
        const key = `${task.directionIndex ?? -1}:${image.order}`
        const previous = latestImages.get(key)
        if (!previous || image.status === "SUCCESS" || previous.image.status !== "SUCCESS") {
          latestImages.set(key, { task, image })
        }
      }
    }
    const logicalResults = [...latestImages.values()].sort(
      (a, b) =>
        (a.task.directionIndex ?? -1) - (b.task.directionIndex ?? -1) ||
        a.image.order - b.image.order
    )
    const successful = logicalResults.filter(row => row.image.status === "SUCCESS").length
    const terminal = logicalResults.filter(row => row.image.status !== "GENERATING").length
    const groupStatus = running
      ? "GENERATING"
      : successful === logicalResults.length
        ? "SUCCESS"
        : successful > 0
          ? "PARTIAL_SUCCESS"
          : terminal === logicalResults.length
            ? "FAILED"
            : "GENERATING"
    const createdAt = new Date(Math.max(...tasks.map(task => task.createdAt.getTime())))
    const updatedAt = new Date(Math.max(...tasks.map(task => task.updatedAt.getTime())))

    return {
      groupId,
      projectId: originals[0]?.projectId ?? tasks[0].projectId,
      clientRequestId: originals[0]?.clientRequestId ?? tasks[0].clientRequestId,
      status: groupStatus,
      directionCount: new Set(originals.map(task => task.directionIndex)).size,
      quantity: originals[0]?.n ?? tasks[0].n,
      expectedImageCount: originals.reduce((sum, task) => sum + task.n, 0),
      createdAt,
      updatedAt,
      results: logicalResults.map(({ task, image }) => ({
        ...image,
        modelPublicId: task.model,
        displayName: names.get(task.model) ?? task.model,
        resolutionTier: imageMetadata(task).resolutionTier,
        taskId: task.id,
        retryOfTaskId: task.retryOfTaskId,
        directionIndex: task.directionIndex,
      })),
      tasks: tasks.map(task => {
        const snapshot = readAiSplitSnapshot(task.promptConfig)
        return {
          id: task.id,
          retryOfTaskId: task.retryOfTaskId,
          directionIndex: task.directionIndex,
          reference: snapshot.reference,
          status: task.status,
          stage: task.aiSplitStage,
          errorMessage: task.errorMessage,
          model: task.model,
          modelPublicId: task.model,
          displayName: names.get(task.model) ?? task.model,
          resolutionTier: imageMetadata(task).resolutionTier,
          deliveryPlan: task.deliveryPlan,
          prompt: task.prompt,
          competitorTemplate: snapshot.competitorTemplate ?? null,
          generationPlan: snapshot.generationPlan ?? null,
          generatedImages: task.generatedImages,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        }
      }),
    }
  }

  async retryTask(taskId: number, dto: RetryAiSplitTaskDto, userId: number) {
    const source = await this.prisma.generationTask.findFirst({
      where: {
        id: taskId,
        userId,
        generationMode: "AI_SPLIT",
        source: "platform",
        project: { source: "platform" },
      },
      include: {
        generatedImages: {
          where: { id: { in: dto.generatedImageIds }, source: "platform", deletedAt: null },
          orderBy: [{ order: "asc" }, { id: "asc" }],
        },
      },
    })
    if (!source?.groupId || source.directionIndex === null) {
      throw new NotFoundException("AI 拆图任务不存在")
    }
    if (source.generatedImages.length !== dto.generatedImageIds.length) {
      throw new BadRequestException("部分重试图片不属于该任务")
    }
    if (source.generatedImages.some(image => !["FAILED", "TIMEOUT"].includes(image.status))) {
      throw new BadRequestException("只能重试失败或超时的图片")
    }
    const sourceSnapshot = readAiSplitSnapshot(source.promptConfig)
    // 只重试用户选中的失败席位，不能继续沿用原任务的总生成数量。
    const snapshot: AiSplitPromptSnapshot = {
      ...sourceSnapshot,
      generationSettings: {
        ...sourceSnapshot.generationSettings,
        quantity: source.generatedImages.length,
      },
      gatewayCalls: { ...sourceSnapshot.gatewayCalls },
    }
    if (!snapshot.generationPlan) throw new BadRequestException("原任务尚未生成有效生图指令")

    this.logger.log(
      `[AI 拆图] 重试任务 user=${userId} sourceTask=${taskId} groupId=${source.groupId} images=[${dto.generatedImageIds.join(",")}]`
    )

    const duplicate = await this.prisma.generationTask.findFirst({
      where: {
        userId,
        source: "platform",
        project: { source: "platform" },
        generationMode: "AI_SPLIT",
        clientRequestId: dto.clientRequestId,
        directionIndex: source.directionIndex,
      },
    })
    if (duplicate) return this.getTaskGroup({ groupId: source.groupId }, userId)

    let retried
    try {
      retried = await this.prisma.generationTask.create({
        data: {
          projectId: source.projectId,
          userId,
          type: source.type,
          generationMode: "AI_SPLIT",
          groupId: source.groupId,
          clientRequestId: dto.clientRequestId,
          directionIndex: source.directionIndex,
          aiSplitStage: AI_SPLIT_STAGES.IMAGE_SUBMITTING,
          retryOfTaskId: source.id,
          presetCategory: source.presetCategory,
          presetOption: source.presetOption,
          model: source.model,
          prompt: source.prompt,
          promptConfig: snapshot as unknown as Prisma.InputJsonValue,
          textAmount: source.textAmount,
          language: source.language,
          aspectRatio: source.aspectRatio,
          deliveryPlan: (source.deliveryPlan ?? undefined) as unknown as
            | Prisma.InputJsonValue
            | undefined,
          n: source.generatedImages.length,
          refImageUrls: source.refImageUrls ?? Prisma.JsonNull,
          status: "GENERATING",
          generatedImages: {
            create: source.generatedImages.map(image => ({
              status: "GENERATING",
              order: image.order,
            })),
          },
        },
      })
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        return this.getTaskGroup({ groupId: source.groupId }, userId)
      }
      throw error
    }
    await this.prisma.imageProject.updateMany({
      where: { id: source.projectId, status: { not: "ARCHIVED" }, deletedAt: null },
      data: { status: "GENERATING" },
    })
    void this.runner.run(retried.id)
    return this.getTaskGroup({ groupId: source.groupId }, userId)
  }

  async listCompetitorImages(
    projectId: number,
    query: QueryAiSplitCompetitorImagesDto,
    userId: number
  ) {
    await this.assertProjectOwned(projectId, userId)
    const { page = 1, pageSize = 20, keyword } = query
    const where: Prisma.PoolImageWhereInput = {
      userId,
      kind: POOL_IMAGE_KIND.COMPETITOR,
      url: { not: null },
      // 严格项目隔离：只返回当前项目保存的竞品图；
      // projectId 为空的（存量、素材池手动存入、分享码导入）不在拆图选图中返回
      projectId,
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword } },
              { prompt: { contains: keyword } },
              { tags: { array_contains: keyword } },
            ],
          }
        : {}),
    }
    const [total, items] = await Promise.all([
      this.prisma.poolImage.count({ where }),
      this.prisma.poolImage.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          url: true,
          name: true,
          tags: true,
          kind: true,
          sourceLabel: true,
          // 项目归属：null = 公共库，前端可据此标注来源
          projectId: true,
          createdAt: true,
        },
      }),
    ])
    return { total, page, pageSize, items }
  }

  async createUploadUrl(projectId: number, dto: AiSplitUploadUrlDto, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const extension = this.imageExtension(dto.fileName, dto.contentType)
    return this.spaces.generateUploadUrl({
      key: `ai-split-references/${userId}/${projectId}/${randomUUID()}.${extension}`,
      contentType: dto.contentType,
      contentLength: dto.fileSize,
      expiresIn: 3600,
    })
  }

  async validateReferenceUrl(
    projectId: number,
    dto: ValidateAiSplitReferenceUrlDto,
    userId: number
  ) {
    await this.assertProjectOwned(projectId, userId)
    return this.validator.validateDirectImageUrl(dto.url)
  }

  async batchDownload(dto: AiSplitImageIdsDto, userId: number) {
    const images = await this.prisma.generatedImage.findMany({
      where: {
        id: { in: dto.imageIds },
        status: "SUCCESS",
        url: { not: null },
        source: "platform",
        task: {
          userId,
          generationMode: "AI_SPLIT",
          source: "platform",
          project: { source: "platform" },
        },
      },
      include: { task: { select: { directionIndex: true } } },
    })
    if (images.length !== dto.imageIds.length) {
      throw new BadRequestException("部分图片不存在、未生成成功或不属于当前用户")
    }
    const byId = new Map(images.map(image => [image.id, image]))
    return {
      count: images.length,
      items: dto.imageIds.map(id => {
        const image = byId.get(id)!
        return {
          id,
          name: `AI拆图-方向${(image.task.directionIndex ?? 0) + 1}-图${image.order + 1}.${this.urlExtension(image.url!)}`,
          url: image.url,
        }
      }),
    }
  }

  async saveToTemplate(dto: SaveAiSplitResultsToTemplateDto, userId: number) {
    const imageIds = dto.items.map(item => item.generatedImageId)
    const images = await this.prisma.generatedImage.findMany({
      where: {
        id: { in: imageIds },
        status: "SUCCESS",
        url: { not: null },
        source: "platform",
        task: {
          userId,
          generationMode: "AI_SPLIT",
          source: "platform",
          project: { source: "platform" },
        },
      },
      include: { task: true },
    })
    if (images.length !== imageIds.length) {
      throw new BadRequestException("部分图片不存在、未生成成功或不属于当前用户")
    }

    const imageById = new Map(images.map(image => [image.id, image]))
    const items = dto.items.map((input, index) => {
      const image = imageById.get(input.generatedImageId)!
      const snapshot = readAiSplitSnapshot(image.task.promptConfig)
      if (!snapshot.competitorTemplate) {
        throw new BadRequestException(`图片 ${image.id} 缺少可复用的竞品拆解模板`)
      }
      const prompt = input.prompt.trim()
      const generationSettings = {
        site: input.generationSettings.site,
        textAmount: input.generationSettings.textAmount,
        model: input.generationSettings.model,
        quantity: input.generationSettings.quantity,
        model_params: input.generationSettings.model_params,
      }
      return {
        name: input.name.trim(),
        prompt,
        refImageUrl: image.url!,
        aspectRatio:
          typeof generationSettings.model_params.aspect_ratio === "string"
            ? generationSettings.model_params.aspect_ratio
            : null,
        textAmount: generationSettings.textAmount,
        resolutionTier: this.resolutionTier(generationSettings.model_params),
        competitorTemplate: (snapshot.competitorTemplate ?? Prisma.JsonNull) as
          | Prisma.NullableJsonNullValueInput
          | Prisma.InputJsonValue,
        generationSettings: generationSettings as unknown as Prisma.InputJsonValue,
        site: generationSettings.site,
        promptVersion: snapshot.promptVersions.productImageGeneration,
        promptHash: createHash("sha256").update(prompt).digest("hex"),
        sortOrder: index,
      }
    })

    return this.prisma.$transaction(
      async tx => {
        if (dto.mode === "CREATE") {
          if (dto.groupId) {
            const group = await tx.imageTemplateGroup.findFirst({
              where: { id: dto.groupId, userId, isSystem: false },
              select: { id: true },
            })
            if (!group) throw new NotFoundException("个人模板分组不存在")
          }
          return tx.imageTemplate.create({
            data: {
              userId,
              isSystem: false,
              name: dto.templateName!.trim(),
              groupId: dto.groupId,
              tags: ["AI拆图"],
              items: { create: items },
            },
            include: {
              group: { select: { id: true, name: true } },
              items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
            },
          })
        }

        const template = await tx.imageTemplate.findFirst({
          where: {
            id: dto.templateId!,
            userId,
            isSystem: false,
            deletedAt: null,
          },
          select: { id: true },
        })
        if (!template) throw new NotFoundException("个人模板不存在")
        const last = await tx.imageTemplateItem.findFirst({
          where: { templateId: template.id },
          orderBy: [{ sortOrder: "desc" }, { id: "desc" }],
          select: { sortOrder: true },
        })
        const startOrder = (last?.sortOrder ?? -1) + 1
        await tx.imageTemplateItem.createMany({
          data: items.map((item, index) => ({
            ...item,
            templateId: template.id,
            sortOrder: startOrder + index,
          })),
        })
        return tx.imageTemplate.findUnique({
          where: { id: template.id },
          include: {
            group: { select: { id: true, name: true } },
            items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
          },
        })
      },
      { timeout: 15_000 }
    )
  }

  private async persistSelectedUploads(
    projectId: number,
    dto: CreateAiSplitTaskDto,
    references: { sourceType: string; url: string }[],
    userId: number
  ) {
    for (let index = 0; index < dto.competitorReferences.length; index += 1) {
      const input = dto.competitorReferences[index]
      if (input.sourceType !== "UPLOAD" || !input.saveToCompetitorData) continue
      try {
        await this.prisma.poolImage.create({
          data: {
            userId,
            projectId,
            url: references[index].url,
            name: `AI拆图竞品参考-${Date.now()}-${index + 1}`,
            sourceLabel: "AI 拆图上传",
            tags: ["竞品参考"],
            kind: POOL_IMAGE_KIND.COMPETITOR,
          },
        })
      } catch (error) {
        this.logger.warn(`竞品参考图保存到素材池失败：${this.errorMessage(error)}`)
      }
    }
  }

  private async assertProjectOwned(
    projectId: number,
    userId: number,
    source: CreationSource = "platform"
  ) {
    const project = await this.prisma.imageProject.findFirst({
      where: { id: projectId, userId, type: "ECOMMERCE", source },
      select: { id: true },
    })
    if (!project) throw new NotFoundException("电商创作项目不存在")
  }

  private imageExtension(fileName: string, contentType: string) {
    const ext = extname(fileName).slice(1).toLowerCase()
    if (contentType === "image/jpeg") return ext === "jpeg" ? "jpeg" : "jpg"
    if (contentType === "image/webp") return "webp"
    return "png"
  }

  private urlExtension(value: string) {
    try {
      const extension = new URL(value).pathname.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]?.toLowerCase()
      return extension && ["png", "jpg", "jpeg", "webp"].includes(extension) ? extension : "png"
    } catch {
      return "png"
    }
  }

  private resolutionTier(modelParams: Record<string, unknown>) {
    const raw = modelParams.size
    if (typeof raw !== "string") return null
    const normalized = raw.toUpperCase()
    if (/^[124]K$/.test(normalized)) return normalized
    const dimensions = normalized.match(/^(\d{3,5})X(\d{3,5})$/)
    if (!dimensions) return null
    const longest = Math.max(Number(dimensions[1]), Number(dimensions[2]))
    if (longest >= 3500) return "4K"
    if (longest >= 1800) return "2K"
    return "1K"
  }

  private isUniqueViolation(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : "未知错误"
  }
}
