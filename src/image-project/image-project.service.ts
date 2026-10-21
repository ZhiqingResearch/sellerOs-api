import { gatewayImageDimensions, gatewayOriginalUrl, imageMetadata, modelDisplayNames, jsonObject } from "../common/utils/generation-metadata"
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { AiGatewayWebhookService } from "../ai-gateway/ai-gateway-webhook.service"
import type { CreationSource } from "../common/types/creation-source"
import { PrismaService } from "../prisma/prisma.service"
import {
  CreateImageProjectDto,
  CreateProductImageDto,
  CreateTaskDto,
  ProductProfileLocalizationContentDto,
  QueryImageProjectDto,
  QueryTaskDto,
  UpdateGeneratedImageDto,
  UpdateImageProjectDto,
  UpdateProductImageDto,
  UpdateTaskDto,
  UpsertBrandIdentityDto,
  UpsertProductProfileDto,
} from "./image-project.dto"

// Prisma 的 update / create 会忽略 undefined 字段，因此 DTO 字段可以直接透传，
// 不需要 `dto.x !== undefined ? { x: dto.x } : {}` 这种 spread 样板。
type Json = Prisma.InputJsonValue

// 图库（任务中心 / 项目页）可见的生成模式；AI 拆图任务自 2026-08-31 起并入统一图库
const GALLERY_GENERATION_MODES = ["STANDARD", "AI_SPLIT", "CROP"]

@Injectable()
export class ImageProjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gatewayWebhook: AiGatewayWebhookService
  ) {}

  // ==================== 项目 ====================

  createProject(dto: CreateImageProjectDto, userId: number) {
    return this.prisma.imageProject.create({
      data: {
        name: dto.name,
        type: dto.type ?? "ECOMMERCE",
        status: dto.status ?? "DRAFT",
        userId,
      },
    })
  }

  async findAllProjects(query: QueryImageProjectDto, userId: number) {
    const { page = 1, pageSize = 10, type, status, name } = query
    const where: Prisma.ImageProjectWhereInput = {
      source: "platform",
      userId,
      type,
      status,
      ...(name ? { name: { contains: name } } : {}),
    }

    const [total, items] = await Promise.all([
      this.prisma.imageProject.count({ where }),
      this.prisma.imageProject.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          _count: { select: { productImages: true, tasks: { where: { source: "platform" } } } },
        },
      }),
    ])

    return { total, page, pageSize, items }
  }

  async findOneProject(id: number, userId: number) {
    const project = await this.prisma.imageProject.findUnique({
      where: { id, source: "platform" },
      include: {
        productProfile: { include: { localizations: { orderBy: { locale: "asc" } } } },
        brandIdentity: true,
        productImages: { orderBy: [{ isPrimary: "desc" }, { order: "asc" }, { id: "asc" }] },
      },
    })
    if (!project) throw new NotFoundException("项目不存在")
    this.ensureOwner(project.userId, userId)
    return {
      ...project,
      productProfile: project.productProfile
        ? withLocalizationFallback(project.productProfile)
        : null,
    }
  }

  async updateProject(id: number, dto: UpdateImageProjectDto, userId: number) {
    await this.assertProjectOwned(id, userId)
    return this.prisma.imageProject.update({
      where: { id },
      data: { name: dto.name, status: dto.status },
    })
  }

  async deleteProject(id: number, userId: number) {
    const project = await this.assertProjectOwned(id, userId)
    if (project.type === "PORTRAIT") {
      const runningTasks = await this.prisma.generationTask.count({
        where: { projectId: id, status: "GENERATING" },
      })
      if (runningTasks > 0) throw new BadRequestException("项目仍有生成中的人像任务，暂不能删除")

      const deletedAt = new Date()
      await this.prisma.$transaction([
        this.prisma.generatedImage.updateMany({
          where: { task: { projectId: id }, deletedAt: null },
          data: { deletedAt },
        }),
        this.prisma.generationTask.updateMany({
          where: { projectId: id, deletedAt: null },
          data: { deletedAt },
        }),
        this.prisma.imageProject.update({ where: { id }, data: { deletedAt } }),
      ])
    } else {
      await this.prisma.imageProject.update({
        where: { id },
        data: { deletedAt: new Date() },
      })
    }
    return { success: true }
  }

  // ==================== 产品资料（1:1 upsert） ====================

  async getProductProfile(projectId: number, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const profile = await this.prisma.productProfile.findUnique({
      where: { projectId },
      include: { localizations: { orderBy: { locale: "asc" } } },
    })
    return profile ? withLocalizationFallback(profile) : null
  }

  async upsertProductProfile(projectId: number, dto: UpsertProductProfileDto, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const data = {
      productName: dto.productName,
      sku: dto.sku,
      brandName: dto.brandName,
      categoryL1: dto.categoryL1,
      categoryL2: dto.categoryL2,
      categoryL3: dto.categoryL3,
      targetCountries: dto.targetCountries as Json | undefined,
      ecommercePlatforms: dto.ecommercePlatforms as Json | undefined,
      commerce: dto.commerce as Json | undefined,
      attributes: dto.attributes as Json | undefined,
      sellingPoints: dto.sellingPoints as Json | undefined,
      certifications: dto.certifications as Json | undefined,
      audience: dto.audience as Json | undefined,
      extra: dto.extra,
      manualPdfUrl: dto.manualPdfUrl,
      sourceUrl: dto.sourceUrl,
      sourceLocale: dto.sourceLocale ? normalizeLocale(dto.sourceLocale) : undefined,
      defaultLocale: dto.defaultLocale ? normalizeLocale(dto.defaultLocale) : undefined,
    }

    const profile = await this.prisma.$transaction(
      async tx => {
        const existingProfile = await tx.productProfile.findUnique({
          where: { projectId },
          include: { localizations: { select: { locale: true } } },
        })
        const saved = await tx.productProfile.upsert({
          where: { projectId },
          update: data,
          create: {
            projectId,
            ...data,
            defaultLocale: data.defaultLocale ?? data.sourceLocale,
          },
        })

        const explicitLocalizations = dto.localizations?.map(item => ({
          locale: normalizeLocale(item.locale),
          content: item.content,
          translatedFrom: item.translatedFrom ? normalizeLocale(item.translatedFrom) : undefined,
        }))
        const legacyContent = toLocalizedContent(dto)
        const localizationWrites =
          explicitLocalizations ??
          (Object.keys(legacyContent).length > 0
            ? [{ locale: saved.defaultLocale, content: dto, translatedFrom: undefined }]
            : [])
        const legacyLocale = existingProfile?.defaultLocale ?? saved.defaultLocale

        const hasLegacyLocalization = existingProfile?.localizations.some(
          localization => localization.locale === legacyLocale
        )
        const writesLegacyLocalization = localizationWrites.some(
          localization => localization.locale === legacyLocale
        )
        if (
          explicitLocalizations &&
          existingProfile &&
          !hasLegacyLocalization &&
          !writesLegacyLocalization
        ) {
          await tx.productProfileLocalization.upsert({
            where: {
              productProfileId_locale: {
                productProfileId: saved.id,
                locale: legacyLocale,
              },
            },
            update: {},
            create: {
              productProfileId: saved.id,
              locale: legacyLocale,
              content: toLegacyLocalizedContent(existingProfile) as Json,
            },
          })
        }

        for (const localization of localizationWrites) {
          const current = await tx.productProfileLocalization.findUnique({
            where: {
              productProfileId_locale: {
                productProfileId: saved.id,
                locale: localization.locale,
              },
            },
          })
          const content = {
            ...(current
              ? toJsonRecord(current.content)
              : localization.locale === legacyLocale
                ? toLegacyLocalizedContent(saved)
                : {}),
            ...toLocalizedContent(localization.content),
          } as Json
          const translatedAt = localization.translatedFrom ? new Date() : undefined

          await tx.productProfileLocalization.upsert({
            where: {
              productProfileId_locale: {
                productProfileId: saved.id,
                locale: localization.locale,
              },
            },
            update: {
              content,
              translatedFrom: localization.translatedFrom,
              translatedAt,
            },
            create: {
              productProfileId: saved.id,
              locale: localization.locale,
              content,
              translatedFrom: localization.translatedFrom,
              translatedAt,
            },
          })
        }

        const defaultLocale = data.defaultLocale ?? saved.defaultLocale
        const shouldSyncDefault =
          dto.defaultLocale !== undefined ||
          localizationWrites.some(item => item.locale === defaultLocale)

        if (shouldSyncDefault) {
          const defaultLocalization = await tx.productProfileLocalization.findUnique({
            where: {
              productProfileId_locale: {
                productProfileId: saved.id,
                locale: defaultLocale,
              },
            },
          })
          if (!defaultLocalization && dto.defaultLocale !== undefined) {
            throw new BadRequestException("默认语言对应的商品资料不存在")
          }
          if (defaultLocalization) {
            await tx.productProfile.update({
              where: { id: saved.id },
              data: localizedContentToProfileData(defaultLocalization.content),
            })
          }
        }

        return tx.productProfile.findUniqueOrThrow({
          where: { id: saved.id },
          include: { localizations: { orderBy: { locale: "asc" } } },
        })
      },
      { timeout: 15_000 }
    )

    return withLocalizationFallback(profile)
  }

  // ==================== 品牌基因（1:1 upsert） ====================

  async getBrandIdentity(projectId: number, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    return this.prisma.brandIdentity.findUnique({ where: { projectId } })
  }

  async upsertBrandIdentity(projectId: number, dto: UpsertBrandIdentityDto, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const data = {
      brandNameZh: dto.brandNameZh,
      brandNameEn: dto.brandNameEn,
      primaryColors: dto.primaryColors as Json | undefined,
      applyBrandColor: dto.applyBrandColor,
      designStyles: dto.designStyles as Json | undefined,
      patterns: dto.patterns as Json | undefined,
      font: dto.font,
      logoUrl: dto.logoUrl,
      brandImageUrl: dto.brandImageUrl,
      tone: dto.tone,
    }
    return this.prisma.brandIdentity.upsert({
      where: { projectId },
      update: data,
      create: { projectId, ...data },
    })
  }

  // ==================== 产品图 ====================

  async createProductImage(projectId: number, dto: CreateProductImageDto, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    if (dto.isPrimary) await this.clearPrimaryFlag(projectId)
    return this.prisma.productImage.create({
      data: {
        projectId,
        url: dto.url,
        tag: dto.tag,
        purpose: dto.purpose,
        note: dto.note,
        isPrimary: dto.isPrimary ?? false,
        order: dto.order ?? 0,
      },
    })
  }

  async findAllProductImages(projectId: number, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    return this.prisma.productImage.findMany({
      where: { projectId },
      orderBy: [{ isPrimary: "desc" }, { order: "asc" }, { id: "asc" }],
    })
  }

  async updateProductImage(imageId: number, dto: UpdateProductImageDto, userId: number) {
    const image = await this.prisma.productImage.findUnique({
      where: { id: imageId },
      select: { id: true, projectId: true, project: { select: { userId: true } } },
    })
    if (!image) throw new NotFoundException("产品图不存在")
    this.ensureOwner(image.project.userId, userId)

    if (dto.isPrimary) await this.clearPrimaryFlag(image.projectId, imageId)

    return this.prisma.productImage.update({
      where: { id: imageId },
      data: {
        url: dto.url,
        tag: dto.tag,
        purpose: dto.purpose,
        note: dto.note,
        isPrimary: dto.isPrimary,
        order: dto.order,
      },
    })
  }

  async deleteProductImage(imageId: number, userId: number) {
    await this.assertProductImageOwned(imageId, userId)
    await this.prisma.productImage.update({
      where: { id: imageId },
      data: { deletedAt: new Date() },
    })
    return { success: true }
  }

  // ==================== 任务 ====================

  async createTask(
    projectId: number,
    dto: CreateTaskDto,
    userId: number,
    source: CreationSource = "platform",
    localRedrawTask?: {
      executionSpec: Prisma.InputJsonObject
      deadlineAt: Date
      portrait?: {
        promptConfig: Prisma.InputJsonObject
        viewConfig?: Prisma.InputJsonValue
        presetOption?: string
      }
    }
  ) {
    // 任务的 type 从所属项目继承，保证与项目一致（项目是创作类型的唯一来源）
    const project = await this.assertProjectOwned(projectId, userId, source)
    if (project.type === "PORTRAIT" && !localRedrawTask?.portrait) {
      throw new BadRequestException("人像项目请使用人像生成任务接口")
    }

    // 局部重绘归档使用实际模型和逐图生成尺寸，不把原图尺寸当成品尺寸。
    const redrawDimensions = new Map<string, { width: number; height: number }>()
    if (dto.sourceJobId) {
      const job = await this.prisma.imageGenJob.findFirst({
        where: { id: dto.sourceJobId, userId, source },
        include: { items: { select: { url: true, gatewayImage: true } } },
      })
      const request = job?.request as
        | { localRedraw?: { provider: string; generationWidth: number; generationHeight: number } }
        | undefined
      if (request?.localRedraw) {
        for (const item of job?.items ?? []) {
          const dimensions = item.gatewayImage as { width?: number; height?: number } | null
          if (item.url && dimensions?.width && dimensions.height)
            redrawDimensions.set(item.url, { width: dimensions.width, height: dimensions.height })
        }
        const first = (dto.generatedImages ?? []).find(
          item => item.status === "SUCCESS" && item.url
        )
        const dimensions = first?.url ? redrawDimensions.get(first.url) : undefined
        dto = {
          ...dto,
          model: request.localRedraw.provider,
          aspectRatio: `${dimensions?.width ?? request.localRedraw.generationWidth}:${dimensions?.height ?? request.localRedraw.generationHeight}`,
        }
      }
    }

    const children = (dto.generatedImages ?? []).map((item, idx) => ({
      source,
      url: item.url,
      status: item.status,
      providerJobId: item.providerJobId,
      errorMessage: item.errorMessage,
      order: item.order ?? idx,
      ...(item.url ? redrawDimensions.get(item.url) : undefined),
    }))

    // 成品入库快照行（批量改图等 t2i/i2i 归档）：记 sourceJobId 供生成记录视图
    // 挂扣费积分（流水盖 meta.jobId）；同事务回写 ImageGenJob.taskId 让视图隐藏
    // 已归档的原始 IMAGEGEN 行（同一笔消费只出一行，不双计）。该列本就是为
    // 「i2i 关联 image-project 任务」设计的，迁移后链路断在这里接回。
    const linkSourceJob = async (tx: Prisma.TransactionClient, taskId: number) => {
      if (!dto.sourceJobId) return
      const linked = await tx.imageGenJob.updateMany({
        where: { id: dto.sourceJobId, userId, source },
        data: { taskId },
      })
      if (linked.count !== 1) throw new BadRequestException("改图任务不存在或不属于当前来源")
    }

    const task = await this.prisma.$transaction(async tx => {
      let archiveSpec: Prisma.InputJsonValue | undefined
      if (dto.sourceJobId) {
        await tx.$queryRaw`SELECT id FROM ImageGenJob WHERE id = ${dto.sourceJobId} FOR UPDATE`
        const job = await tx.imageGenJob.findFirst({ where: { id: dto.sourceJobId, userId, source, businessType: "IMAGE_CREATIVE" }, include: { items: true } })
        if (!job || job.taskId != null || !children.length) throw new BadRequestException("改图任务不存在、已归档或没有可归档图片")
        const request = jsonObject(job.request)
        const seen = new Set<number>()
        for (const child of children) {
          const matched = job.items.filter(i => i.status === "SUCCEEDED" && i.deletedAt == null && i.url && i.url === child.url)
          if (matched.length !== 1 || seen.has(matched[0].id)) throw new BadRequestException("归档图片与源任务成功结果不一致")
          const item = matched[0]; seen.add(item.id)
          const dimensions = gatewayImageDimensions(item.gatewayImage)
          Object.assign(child, { status: "SUCCESS", width: item.width ?? dimensions.width ?? null, height: item.height ?? dimensions.height ?? null,
            originalUrl: gatewayOriginalUrl(item.gatewayImage),
            nativeWidth: dimensions.nativeWidth, nativeHeight: dimensions.nativeHeight,
            providerJobId: item.providerJobId, deliveryMeta: item.gatewayImage ? { gatewayImage: item.gatewayImage } : undefined })
        }
        archiveSpec = { kind: "ARCHIVED_IMAGEGEN", modelPublicId: request.modelPublicId ?? jsonObject(job.items.find(i => i.status === "SUCCEEDED")?.gatewayImage).modelPublicId ?? job.model,
          ...(request.localRedraw ? { localRedraw: request.localRedraw } : {}),
          form: { resolutionTier: request.resolutionTier ?? null, aspectRatio: request.aspectRatio ?? null }, sourceJobId: job.id }
      }
      const task = await tx.generationTask.create({
        data: {
          projectId,
          userId,
          source,
          type: project.type,
          presetCategory: dto.presetCategory,
          presetOption: dto.presetOption,
          model: dto.model,
          prompt: dto.prompt,
          textAmount: dto.textAmount,
          language: dto.language,
          aspectRatio: dto.aspectRatio,
          n: dto.n ?? children.length,
          imageLabelBase: dto.imageLabelBase?.trim() || null,
          refImageUrls: (dto.refImageUrls ?? Prisma.JsonNull) as
            | Prisma.NullableJsonNullValueInput
            | Json,
          status: archiveSpec ? "SUCCESS" : dto.status,
          errorMessage: dto.errorMessage,
          sourceJobId: dto.sourceJobId,
          ...(archiveSpec ? { executionSpec: archiveSpec } : {}),
          ...(localRedrawTask
            ? {
                executionSpec: localRedrawTask.executionSpec,
                deadlineAt: localRedrawTask.deadlineAt,
                ...(localRedrawTask.portrait
                  ? {
                      presetCategory: "PORTRAIT",
                      presetOption: localRedrawTask.portrait.presetOption,
                      promptConfig: localRedrawTask.portrait.promptConfig,
                      viewConfig: localRedrawTask.portrait.viewConfig,
                    }
                  : {}),
              }
            : {}),
          ...(children.length > 0 ? { generatedImages: { create: children } } : {}),
        },
        include: {
          generatedImages: { where: { source, deletedAt: null }, orderBy: { order: "asc" } },
        },
      })
      if (localRedrawTask?.portrait)
        await tx.imageProject.updateMany({
          where: { id: projectId, status: { not: "ARCHIVED" }, deletedAt: null },
          data: { status: "GENERATING" },
        })
      await linkSourceJob(tx, task.id)
      return task
    })
    return (await this.publicTasks([task]))[0]
  }

  async findAllTasks(query: QueryTaskDto, userId: number) {
    const { page = 1, pageSize = 10, type, projectId, status, model } = query
    const where: Prisma.GenerationTaskWhereInput = {
      source: "platform",
      project: { source: "platform" },
      userId,
      generationMode: { in: GALLERY_GENERATION_MODES },
      type,
      projectId,
      status,
      model,
      // AI 拆图的重试任务是席位的重跑记录，图片并入原任务展示，不单独成卡；
      // 原任务被清掉后（如图片全部移除）重试任务顶上，避免席位凭空消失
      OR: [{ retryOfTaskId: null }, { retryOfTask: { is: { deletedAt: { not: null } } } }],
    }

    let [total, items] = await this.fetchTaskPage(where, page, pageSize)
    // 读时对账：页内有卡在 GENERATING 的网关任务时主动查一次真实状态，回调丢失自愈
    const reconciled = await this.reconcileGeneratingImageTasks(items)
    if (reconciled) [total, items] = await this.fetchTaskPage(where, page, pageSize)
    await this.mergeSplitRetrySeats(items)

    return { total, page, pageSize, items: await this.publicTasks(items) }
  }

  private async publicTasks<
    T extends {
      model: string
      executionSpec?: unknown
      deliveryPlan?: unknown
      generatedImages?: Array<{
        width?: number | null
        height?: number | null
        nativeWidth?: number | null
        nativeHeight?: number | null
        originalUrl?: string | null
        deliveryMeta?: unknown
      }>
    }
  >(items: T[]) {
    const names = await modelDisplayNames(this.prisma, items.map(t => imageMetadata(t).modelPublicId))
    return items.map(task => {
      const meta = imageMetadata(task)
      const generatedImages = task.generatedImages?.map(image => {
        const dimensions = gatewayImageDimensions(jsonObject(image.deliveryMeta).gatewayImage)
        return {
          ...image,
          originalUrl: image.originalUrl ?? gatewayOriginalUrl(jsonObject(image.deliveryMeta).gatewayImage),
          width: image.width ?? dimensions.width ?? null,
          height: image.height ?? dimensions.height ?? null,
          nativeWidth: image.nativeWidth ?? dimensions.nativeWidth ?? null,
          nativeHeight: image.nativeHeight ?? dimensions.nativeHeight ?? null,
        }
      }) as T["generatedImages"]
      return {
        ...task,
        ...meta,
        displayName: names.get(meta.modelPublicId!) ?? task.model,
        ...(generatedImages ? { generatedImages } : {}),
      }
    })
  }

  private fetchTaskPage(where: Prisma.GenerationTaskWhereInput, page: number, pageSize: number) {
    return Promise.all([
      this.prisma.generationTask.count({ where }),
      this.prisma.generationTask.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          generatedImages: {
            where: { source: "platform", deletedAt: null },
            orderBy: { order: "asc" },
          },
          project: { select: { id: true, name: true } },
        },
      }),
    ])
  }

  /** 页内 GENERATING 且已关联网关任务的行主动查网关（2 分钟节流）；返回是否有行实际查询过 */
  private async reconcileGeneratingImageTasks(
    items: Array<{ id: number; status: string; gatewayTaskId: string | null }>
  ) {
    const results = await Promise.all(
      items.map(item => this.gatewayWebhook.reconcileImageTaskOnRead(item))
    )
    return results.some(reconciled => reconciled)
  }

  /**
   * AI 拆图任务的重试图片按席位并入原任务：同一 (groupId, directionIndex, order) 席位
   * 成功图优先、同为成功取最新，与拆图面板 /ai-split/tasks 的逻辑席位口径一致。
   * 任务展示状态随之按席位推导（重试成功不会回写原任务状态，否则图库会挂着
   * FAILED 徽标展示成功图片）；沿用任务中心枚举，部分成功归 FAILED，图片自身状态可见。
   */
  private async mergeSplitRetrySeats(
    items: Array<
      Prisma.GenerationTaskGetPayload<{
        include: {
          generatedImages: true
          project: { select: { id: true; name: true } }
        }
      }>
    >
  ) {
    const groupIds = [
      ...new Set(
        items
          .filter(item => item.generationMode === "AI_SPLIT" && item.groupId)
          .map(item => item.groupId!)
      ),
    ]
    if (groupIds.length === 0) return

    const groupTasks = await this.prisma.generationTask.findMany({
      where: {
        groupId: { in: groupIds },
        source: "platform",
        project: { source: "platform" },
        deletedAt: null,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: {
        generatedImages: {
          where: { source: "platform", deletedAt: null },
          orderBy: [{ order: "asc" }, { id: "asc" }],
        },
      },
    })

    for (const item of items) {
      if (item.generationMode !== "AI_SPLIT" || !item.groupId) continue
      const seatTasks = groupTasks.filter(
        task => task.groupId === item.groupId && task.directionIndex === item.directionIndex
      )
      const seats = new Map<number, (typeof seatTasks)[number]["generatedImages"][number]>()
      let running = false
      for (const task of seatTasks) {
        if (task.status === "GENERATING") running = true
        for (const image of task.generatedImages) {
          const previous = seats.get(image.order)
          if (!previous || image.status === "SUCCESS" || previous.status !== "SUCCESS") {
            seats.set(image.order, image)
          }
        }
      }
      const images = [...seats.values()].sort((a, b) => a.order - b.order)
      if (images.length === 0) continue
      item.generatedImages = images
      const successful = images.filter(image => image.status === "SUCCESS").length
      item.status = running ? "GENERATING" : successful === images.length ? "SUCCESS" : "FAILED"
    }
  }

  async findOneTask(taskId: number, userId: number) {
    const include: Prisma.GenerationTaskInclude = {
      generatedImages: {
        where: { source: "platform", deletedAt: null },
        orderBy: { order: "asc" },
      },
      project: { select: { id: true, name: true } },
    }
    let task = await this.prisma.generationTask.findUnique({
      where: { id: taskId, source: "platform", project: { source: "platform" } },
      include,
    })
    if (!task || !GALLERY_GENERATION_MODES.includes(task.generationMode)) {
      throw new NotFoundException("任务不存在")
    }
    this.ensureOwner(task.userId, userId)
    // 读时对账：卡在 GENERATING 时主动查网关真实状态，有权威结论则重读后再返回
    const reconciled = await this.gatewayWebhook.reconcileImageTaskOnRead({
      id: task.id,
      status: task.status,
      gatewayTaskId: task.gatewayTaskId,
    })
    if (reconciled) {
      task =
        (await this.prisma.generationTask.findUnique({
          where: { id: taskId, source: "platform", project: { source: "platform" } },
          include,
        })) ?? task
    }
    return (await this.publicTasks([task]))[0]
  }

  async updateTask(taskId: number, dto: UpdateTaskDto, userId: number) {
    await this.assertTaskOwned(taskId, userId)
    return this.prisma.generationTask.update({
      where: { id: taskId, source: "platform", project: { source: "platform" } },
      data: { status: dto.status, errorMessage: dto.errorMessage },
      include: {
        generatedImages: {
          where: { source: "platform", deletedAt: null },
          orderBy: { order: "asc" },
        },
      },
    })
  }

  async deleteTask(taskId: number, userId: number) {
    await this.assertTaskOwned(taskId, userId)
    await this.prisma.generationTask.update({
      where: { id: taskId, source: "platform", project: { source: "platform" } },
      data: { deletedAt: new Date() },
    })
    return { success: true }
  }

  /** 按项目一键清理无效图片（取消 / 失败 / 超时，软删除），并清掉已无有效图片的空任务 */
  async clearInvalidImages(projectId: number, userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const now = new Date()
    const invalidImageStatuses = ["CANCELLED", "CANCELED", "FAILED", "TIMEOUT"]

    const result = await this.prisma.$transaction(async tx => {
      const invalidImages = await tx.generatedImage.findMany({
        where: {
          deletedAt: null,
          source: "platform",
          status: { in: invalidImageStatuses },
          task: {
            projectId,
            userId,
            source: "platform",
            project: { source: "platform" },
            generationMode: { in: GALLERY_GENERATION_MODES },
            deletedAt: null,
          },
        },
        select: { taskId: true, status: true },
      })

      const deletedCancelled = invalidImages.filter(i =>
        ["CANCELLED", "CANCELED"].includes(i.status)
      ).length
      const deletedFailed = invalidImages.filter(i => i.status === "FAILED").length
      const deletedTimeout = invalidImages.filter(i => i.status === "TIMEOUT").length
      const affectedTaskIds = [...new Set(invalidImages.map(i => i.taskId))]

      const deletedImages = await tx.generatedImage.updateMany({
        where: {
          deletedAt: null,
          source: "platform",
          status: { in: invalidImageStatuses },
          task: {
            projectId,
            userId,
            source: "platform",
            project: { source: "platform" },
            generationMode: { in: GALLERY_GENERATION_MODES },
            deletedAt: null,
          },
        },
        data: { deletedAt: now },
      })

      const taskCleanupOr: Prisma.GenerationTaskWhereInput[] = [{ status: { not: "GENERATING" } }]
      if (affectedTaskIds.length > 0) taskCleanupOr.push({ id: { in: affectedTaskIds } })

      const emptyTasks = await tx.generationTask.findMany({
        where: {
          projectId,
          userId,
          source: "platform",
          project: { source: "platform" },
          generationMode: { in: GALLERY_GENERATION_MODES },
          deletedAt: null,
          OR: taskCleanupOr,
          generatedImages: { none: { deletedAt: null } },
        },
        select: { id: true },
      })

      const deletedTasks = emptyTasks.length
        ? await tx.generationTask.updateMany({
            where: { id: { in: emptyTasks.map(t => t.id) }, deletedAt: null },
            data: { deletedAt: now },
          })
        : { count: 0 }

      return {
        deletedTotal: deletedImages.count,
        deletedCancelled,
        deletedFailed,
        deletedTimeout,
        deletedTasks: deletedTasks.count,
      }
    })

    return { success: true, ...result }
  }

  /**
   * 兼容旧接口名：clear-failed-tasks。
   * 实际已升级为清理取消/失败/超时图片，避免前端改路径前行为不一致。
   */
  async clearFailedTasks(projectId: number, userId: number) {
    return this.clearInvalidImages(projectId, userId)
  }

  /** 按生成图片 ID 批量软删除；生成中的席位禁止移除。 */
  async removeImages(projectId: number, imageIds: number[], userId: number) {
    await this.assertProjectOwned(projectId, userId)
    const ids = [...new Set(imageIds)]
    const now = new Date()

    const result = await this.prisma.$transaction(async tx => {
      const images = await tx.generatedImage.findMany({
        where: {
          id: { in: ids },
          source: "platform",
          deletedAt: null,
          task: {
            projectId,
            userId,
            source: "platform",
            project: { source: "platform" },
            generationMode: { in: GALLERY_GENERATION_MODES },
            deletedAt: null,
          },
        },
        select: { id: true, taskId: true, status: true },
      })
      if (images.length !== ids.length) {
        throw new BadRequestException("部分图片不存在、已被移除或不属于当前项目")
      }
      if (images.some(image => image.status === "GENERATING")) {
        throw new BadRequestException("生成中的图片不可移除，请等待生成完成")
      }

      const removed = await tx.generatedImage.updateMany({
        where: { id: { in: ids }, deletedAt: null, status: { not: "GENERATING" } },
        data: { deletedAt: now },
      })
      if (removed.count !== ids.length) {
        throw new BadRequestException("部分图片状态已变化，请刷新后重试")
      }
      const taskIds = [...new Set(images.map(image => image.taskId))]
      const emptyTasks = await tx.generationTask.findMany({
        where: {
          id: { in: taskIds },
          projectId,
          userId,
          source: "platform",
          project: { source: "platform" },
          generationMode: { in: GALLERY_GENERATION_MODES },
          deletedAt: null,
          status: { not: "GENERATING" },
          generatedImages: { none: { deletedAt: null } },
        },
        select: { id: true },
      })
      const removedTasks = emptyTasks.length
        ? await tx.generationTask.updateMany({
            where: { id: { in: emptyTasks.map(task => task.id) }, deletedAt: null },
            data: { deletedAt: now },
          })
        : { count: 0 }

      return { removedCount: removed.count, removedEmptyTasks: removedTasks.count }
    })

    return { success: true, requestedCount: ids.length, ...result }
  }

  // ==================== 生成图席位 ====================

  async updateGeneratedImage(imageId: number, dto: UpdateGeneratedImageDto, userId: number) {
    await this.assertGeneratedImageOwned(imageId, userId)
    return this.prisma.generatedImage.update({
      where: { id: imageId },
      data: {
        url: dto.url,
        status: dto.status,
        providerJobId: dto.providerJobId,
        errorMessage: dto.errorMessage,
        adopted: dto.adopted,
        order: dto.order,
      },
    })
  }

  async deleteGeneratedImage(imageId: number, userId: number) {
    await this.assertGeneratedImageOwned(imageId, userId)
    await this.prisma.generatedImage.update({
      where: { id: imageId },
      data: { deletedAt: new Date() },
    })
    return { success: true }
  }

  // ==================== 私有工具 ====================

  private ensureOwner(ownerId: number, userId: number) {
    if (ownerId !== userId) throw new ForbiddenException("无权访问该资源")
  }

  private async assertProjectOwned(
    projectId: number,
    userId: number,
    source: CreationSource = "platform"
  ) {
    const row = await this.prisma.imageProject.findUnique({
      where: { id: projectId, source },
      select: { userId: true, type: true },
    })
    if (!row) throw new NotFoundException("项目不存在")
    this.ensureOwner(row.userId, userId)
    return row
  }

  private async assertProductImageOwned(imageId: number, userId: number) {
    const row = await this.prisma.productImage.findUnique({
      where: { id: imageId, project: { source: "platform" } },
      select: { project: { select: { userId: true } } },
    })
    if (!row) throw new NotFoundException("产品图不存在")
    this.ensureOwner(row.project.userId, userId)
  }

  private async assertTaskOwned(taskId: number, userId: number) {
    const row = await this.prisma.generationTask.findUnique({
      where: { id: taskId, source: "platform", project: { source: "platform" } },
      select: { userId: true, generationMode: true },
    })
    if (!row || !GALLERY_GENERATION_MODES.includes(row.generationMode)) {
      throw new NotFoundException("任务不存在")
    }
    this.ensureOwner(row.userId, userId)
  }

  private async assertGeneratedImageOwned(imageId: number, userId: number) {
    const row = await this.prisma.generatedImage.findUnique({
      where: {
        id: imageId,
        source: "platform",
        task: { source: "platform", project: { source: "platform" } },
      },
      select: { task: { select: { userId: true, generationMode: true } } },
    })
    if (!row || !GALLERY_GENERATION_MODES.includes(row.task.generationMode)) {
      throw new NotFoundException("生成图不存在")
    }
    this.ensureOwner(row.task.userId, userId)
  }

  /** 把指定项目其它图的 isPrimary 取消（可排除某一张） */
  private clearPrimaryFlag(projectId: number, exceptId?: number) {
    return this.prisma.productImage.updateMany({
      where: {
        projectId,
        isPrimary: true,
        deletedAt: null,
        ...(exceptId !== undefined ? { NOT: { id: exceptId } } : {}),
      },
      data: { isPrimary: false },
    })
  }
}

type ProductProfileWithLocalizations = Prisma.ProductProfileGetPayload<{
  include: { localizations: true }
}>

function normalizeLocale(locale: string): string {
  return locale
    .split("-")
    .map((part, index) => {
      if (index === 0) return part.toLowerCase()
      if (part.length === 2) return part.toUpperCase()
      if (part.length === 4) return `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`
      return part
    })
    .join("-")
}

function toLocalizedContent(value: ProductProfileLocalizationContentDto): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      productName: value.productName,
      categoryL1: value.categoryL1,
      categoryL2: value.categoryL2,
      categoryL3: value.categoryL3,
      attributes: value.attributes,
      sellingPoints: value.sellingPoints,
      certifications: value.certifications,
      audience: value.audience,
      extra: value.extra,
    }).filter(([, field]) => field !== undefined)
  )
}

function toJsonRecord(value: Prisma.JsonValue | undefined): Record<string, Prisma.JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined)
  ) as Record<string, Prisma.JsonValue>
}

function localizedContentToProfileData(value: Prisma.JsonValue): Prisma.ProductProfileUpdateInput {
  const content = toJsonRecord(value)
  return {
    productName: toOptionalString(content.productName),
    categoryL1: toOptionalString(content.categoryL1),
    categoryL2: toOptionalString(content.categoryL2),
    categoryL3: toOptionalString(content.categoryL3),
    attributes: toOptionalJson(content.attributes),
    sellingPoints: toOptionalJson(content.sellingPoints),
    certifications: toOptionalJson(content.certifications),
    audience: toOptionalJson(content.audience),
    extra: toOptionalString(content.extra),
  }
}

function toOptionalString(value: Prisma.JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function toOptionalJson(value: Prisma.JsonValue | undefined): Json | undefined {
  return value === null || value === undefined ? undefined : (value as Json)
}

function withLocalizationFallback(profile: ProductProfileWithLocalizations) {
  if (profile.localizations.length > 0) {
    return {
      ...profile,
      localizations: profile.localizations.map(localization => ({
        ...localization,
        isLegacy: false,
      })),
    }
  }

  return {
    ...profile,
    localizations: [
      {
        id: null,
        productProfileId: profile.id,
        locale: profile.defaultLocale,
        content: toLegacyLocalizedContent(profile),
        translatedFrom: null,
        translatedAt: null,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        isLegacy: true,
      },
    ],
  }
}

interface LegacyLocalizedProfile {
  productName: string | null
  categoryL1: string | null
  categoryL2: string | null
  categoryL3: string | null
  attributes: Prisma.JsonValue | null
  sellingPoints: Prisma.JsonValue | null
  certifications: Prisma.JsonValue | null
  audience: Prisma.JsonValue | null
  extra: string | null
}

function toLegacyLocalizedContent(
  profile: LegacyLocalizedProfile
): Record<string, Prisma.JsonValue> {
  return Object.fromEntries(
    Object.entries({
      productName: profile.productName,
      categoryL1: profile.categoryL1,
      categoryL2: profile.categoryL2,
      categoryL3: profile.categoryL3,
      attributes: profile.attributes,
      sellingPoints: profile.sellingPoints,
      certifications: profile.certifications,
      audience: profile.audience,
      extra: profile.extra,
    }).filter(([, value]) => value !== null)
  ) as Record<string, Prisma.JsonValue>
}
