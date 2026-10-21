import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import type { CreationSource } from "../common/types/creation-source"
import { imageMetadata, modelDisplayNames } from "../common/utils/generation-metadata"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import {
  CreatePortraitTaskDto,
  PortraitImageIdsDto,
  SavePortraitTemplateDto,
} from "./portrait-creation.dto"
import type { PortraitImageGenerator } from "./portrait-image-generator"
import { PORTRAIT_IMAGE_GENERATOR } from "./portrait-image-generator"
import { PortraitTaskRunner } from "./portrait-task.runner"
import { PortraitTaskValidator } from "./portrait-task.validator"

const TEMPLATE_INCLUDE = {
  items: { orderBy: [{ sortOrder: "asc" as const }, { id: "asc" as const }] },
  group: { select: { id: true, name: true } },
} satisfies Prisma.ImageTemplateInclude

@Injectable()
export class PortraitCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: PortraitTaskValidator,
    private readonly runner: PortraitTaskRunner,
    private readonly usage: UsageService,
    @Inject(PORTRAIT_IMAGE_GENERATOR)
    private readonly generator: PortraitImageGenerator
  ) {}

  async createTask(
    projectId: number,
    dto: CreatePortraitTaskDto,
    userId: number,
    source: CreationSource = "platform"
  ) {
    const project = await this.assertPortraitProject(projectId, userId, source)
    if (project.status === "ARCHIVED") throw new BadRequestException("已归档项目不能创建生成任务")
    if (!dto.prompt.trim()) throw new BadRequestException("最终提示词不能为空")
    if (!dto.model.trim()) throw new BadRequestException("模型编码不能为空")
    if (!this.generator.isAvailable()) {
      throw new ServiceUnavailableException("人像生图能力尚未接入")
    }

    const quantity = dto.quantity ?? 1
    const validated = await this.validator.validateTask(dto, userId)
    // 固定一口价预检：模型目录行配置 fixedCredits → 按「单价 × 张数」校验余额
    //（不打折口径，与终态扣费同源）；未配置回落现状不预检。实时读库，改库即时生效。
    const fixedCredits = await this.usage.gatewayFixedImageCredits(dto.model, "PORTRAIT")
    if (fixedCredits) {
      await this.usage.assertExactCreditsAffordable(userId, fixedCredits.mul(quantity))
    }
    const promptConfig = {
      ...dto.promptConfig,
      model_params: validated.modelParams,
    }
    const aspectRatio =
      validated.deliveryPlan?.requested.aspectRatio ??
      (typeof validated.modelParams.aspect_ratio === "string"
        ? validated.modelParams.aspect_ratio
        : undefined)
    const task = await this.prisma.$transaction(async tx => {
      const created = await tx.generationTask.create({
        data: {
          projectId,
          userId,
          source,
          type: "PORTRAIT",
          presetCategory: "PORTRAIT",
          presetOption: validated.creationType,
          model: dto.model,
          prompt: dto.prompt,
          promptConfig: promptConfig as Prisma.InputJsonValue,
          viewConfig: dto.viewConfig as Prisma.InputJsonValue,
          ...(validated.deliveryPlan
            ? {
                deliveryPlan: validated.deliveryPlan as unknown as Prisma.InputJsonValue,
              }
            : {}),
          aspectRatio,
          n: quantity,
          refImageUrls: validated.references.map(reference => reference.url),
          status: "GENERATING",
          generatedImages: {
            create: Array.from({ length: quantity }, (_, order) => ({
              source,
              status: "GENERATING",
              order,
            })),
          },
        },
        include: { generatedImages: { orderBy: [{ order: "asc" }, { id: "asc" }] } },
      })
      await tx.imageProject.update({ where: { id: projectId }, data: { status: "GENERATING" } })
      return created
    })

    void this.runner.run(task.id)
    const meta = imageMetadata(task)
    const names = await modelDisplayNames(this.prisma, [meta.modelPublicId])
    return { ...task, ...meta, displayName: names.get(meta.modelPublicId!) ?? task.model }
  }

  async findImageContext(imageId: number, userId: number) {
    const image = await this.prisma.generatedImage.findUnique({
      where: {
        id: imageId,
        source: "platform",
        task: { source: "platform", project: { source: "platform" } },
      },
      include: {
        task: {
          include: {
            project: {
              select: {
                id: true,
                name: true,
                type: true,
                status: true,
                userId: true,
                deletedAt: true,
              },
            },
          },
        },
      },
    })
    if (!image || image.task.deletedAt || image.task.project.deletedAt) {
      throw new NotFoundException("生成图片不存在")
    }
    if (image.task.userId !== userId || image.task.project.userId !== userId) {
      throw new NotFoundException("生成图片不存在")
    }
    if (image.task.type !== "PORTRAIT" || image.task.project.type !== "PORTRAIT") {
      throw new BadRequestException("该图片不是人像创作结果")
    }

    const task = image.task
    return {
      image: {
        id: image.id,
        url: image.url,
        status: image.status,
        order: image.order,
        createdAt: image.createdAt,
      },
      project: task.project,
      task: {
        id: task.id,
        prompt: task.prompt,
        promptConfig: task.promptConfig,
        viewConfig: task.viewConfig,
        model: task.model,
        aspectRatio: task.aspectRatio,
        quantity: task.n,
        refImageUrls: task.refImageUrls,
        status: task.status,
        createdAt: task.createdAt,
      },
    }
  }

  async batchDownload(projectId: number, dto: PortraitImageIdsDto, userId: number) {
    const project = await this.assertPortraitProject(projectId, userId)
    const images = await this.loadSelectedImages(projectId, dto.imageIds, userId)
    return {
      count: images.length,
      items: images.map((image, index) => ({
        id: image.id,
        name: `${this.safeName(image.task.imageLabelBase || project.name)}-人像-${index + 1}.${this.urlExtension(image.url!)}`,
        url: image.url,
      })),
    }
  }

  async saveToTemplate(projectId: number, dto: SavePortraitTemplateDto, userId: number) {
    const project = await this.assertPortraitProject(projectId, userId)

    return this.prisma.$transaction(async tx => {
      const images = await this.loadSelectedImages(projectId, dto.imageIds, userId, tx)
      const items = images.map((image, index) => ({
        name: `${this.safeName(image.task.imageLabelBase || project.name)}-${index + 1}`.slice(
          0,
          100
        ),
        prompt: image.task.prompt,
        refImageUrl: image.url,
        aspectRatio: image.task.aspectRatio,
      }))

      let templateId: number
      if (dto.mode === "CREATE") {
        const templateName = dto.templateName?.trim()
        if (!templateName) throw new BadRequestException("新建模板时必须填写模板名称")
        const groupId = await this.resolvePersonalGroup(tx, userId, dto.groupName)
        const template = await tx.imageTemplate.create({
          data: {
            userId,
            isSystem: false,
            name: templateName,
            groupId,
            tags: ["人像创作"],
            note: `来自人像项目：${project.name}`.slice(0, 500),
            items: {
              create: items.map((item, sortOrder) => ({ ...item, sortOrder })),
            },
          },
          select: { id: true },
        })
        templateId = template.id
      } else {
        if (!dto.templateId) throw new BadRequestException("追加模式必须传 templateId")
        const template = await tx.imageTemplate.findFirst({
          where: { id: dto.templateId, userId, isSystem: false, deletedAt: null },
          select: { id: true },
        })
        if (!template) throw new NotFoundException("个人模板不存在")
        const last = await tx.imageTemplateItem.findFirst({
          where: { templateId: template.id },
          orderBy: { sortOrder: "desc" },
          select: { sortOrder: true },
        })
        const startOrder = (last?.sortOrder ?? -1) + 1
        await tx.imageTemplateItem.createMany({
          data: items.map((item, index) => ({
            templateId: template.id,
            ...item,
            sortOrder: startOrder + index,
          })),
        })
        templateId = template.id
      }

      return tx.imageTemplate.findUnique({ where: { id: templateId }, include: TEMPLATE_INCLUDE })
    })
  }

  private async loadSelectedImages(
    projectId: number,
    imageIds: number[],
    userId: number,
    client: Pick<Prisma.TransactionClient, "generatedImage"> = this.prisma
  ) {
    const rows = await client.generatedImage.findMany({
      where: {
        id: { in: imageIds },
        deletedAt: null,
        status: "SUCCESS",
        url: { not: null },
        source: "platform",
        task: {
          projectId,
          userId,
          source: "platform",
          project: { source: "platform" },
          type: "PORTRAIT",
          deletedAt: null,
        },
      },
      include: {
        task: {
          select: {
            id: true,
            prompt: true,
            aspectRatio: true,
            imageLabelBase: true,
          },
        },
      },
    })
    if (rows.length !== imageIds.length) {
      throw new BadRequestException("所选图片中存在无效、生成中、已删除或不属于当前项目的图片")
    }
    const byId = new Map(rows.map(image => [image.id, image]))
    return imageIds.map(id => byId.get(id)!)
  }

  private async assertPortraitProject(
    projectId: number,
    userId: number,
    source: CreationSource = "platform"
  ) {
    const project = await this.prisma.imageProject.findUnique({ where: { id: projectId, source } })
    if (!project || project.userId !== userId) throw new NotFoundException("人像项目不存在")
    if (project.type !== "PORTRAIT") throw new BadRequestException("该项目不是人像创作项目")
    return project
  }

  private async resolvePersonalGroup(
    tx: Prisma.TransactionClient,
    userId: number,
    groupName?: string
  ) {
    if (groupName === undefined) return null
    const name = groupName.trim()
    if (!name) throw new BadRequestException("模板分组名称不能为空")
    const existing = await tx.imageTemplateGroup.findUnique({
      where: { userId_name: { userId, name } },
      select: { id: true },
    })
    if (existing) return existing.id
    const created = await tx.imageTemplateGroup.create({
      data: { userId, isSystem: false, name },
      select: { id: true },
    })
    return created.id
  }

  private safeName(value: string) {
    return (
      value
        .replace(/[\\/:*?"<>|]/g, "-")
        .trim()
        .slice(0, 80) || "人像"
    )
  }

  private urlExtension(value: string) {
    try {
      const match = new URL(value).pathname.match(/\.([a-zA-Z0-9]{2,5})$/)
      const extension = match?.[1]?.toLowerCase()
      return extension && ["png", "jpg", "jpeg", "webp", "gif"].includes(extension)
        ? extension
        : "png"
    } catch {
      return "png"
    }
  }
}
