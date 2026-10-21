import { ConflictException, Injectable, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { createHash } from "crypto"
import { imageMetadata, jsonObject } from "../common/utils/generation-metadata"
import { PrismaService } from "../prisma/prisma.service"
import { createCropUpload, inspectCropPng } from "../spaces/crop-upload"
import { SpacesService } from "../spaces/spaces.service"
import { SaveImageCropDto } from "./image-crop.dto"
import { ImageProjectService } from "./image-project.service"

const CROP_DIRECTORY = "image-project/crops"

@Injectable()
export class ImageCropService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpacesService,
    private readonly projects: ImageProjectService
  ) {}

  uploadUrl(userId: number) {
    return createCropUpload(this.spaces, userId, CROP_DIRECTORY)
  }

  async save(projectId: number, dto: SaveImageCropDto, userId: number) {
    // 复用现有用户/请求/方向唯一索引；前缀与 AI 拆图的请求键隔离。
    const clientRequestId = `crop:${dto.idempotencyKey}`
    const requestHash = createHash("sha256")
      .update(JSON.stringify([projectId, dto.sourceImageId, dto.url]))
      .digest("hex")
    const existingCrop = async () => {
      // 必须查到已软删除记录，旧动作键不能复活图片。
      const [saved] = await this.prisma.$queryRaw<
        Array<{
          id: number
          generationMode: string
          executionSpec: Prisma.JsonValue
          deletedAt: Date | null
          projectDeletedAt: Date | null
        }>
      >`
        SELECT t.id, t.generationMode, t.executionSpec, t.deletedAt,
          p.deletedAt AS projectDeletedAt
        FROM GenerationTask t JOIN ImageProject p ON p.id = t.projectId
        WHERE t.userId = ${userId} AND t.source = 'platform'
          AND t.clientRequestId = ${clientRequestId} AND t.directionIndex = 0
        LIMIT 1
      `
      if (!saved) return null
      if (
        saved.generationMode !== "CROP" ||
        jsonObject(saved.executionSpec).cropRequestHash !== requestHash
      ) {
        throw new ConflictException("保存动作已用于其他图片，请使用新的动作 ID")
      }
      if (saved.deletedAt || saved.projectDeletedAt) {
        throw new ConflictException("已保存的图片已移除，请重新发起保存")
      }
      const task = await this.projects.findOneTask(saved.id, userId)
      if (!task.generatedImages.length) {
        throw new ConflictException("已保存的图片已移除，请重新发起保存")
      }
      return task
    }
    const existing = await existingCrop()
    if (existing) return existing

    const where: Prisma.GeneratedImageWhereInput = {
      id: dto.sourceImageId,
      source: "platform",
      status: "SUCCESS",
      deletedAt: null,
      url: { not: null },
      task: {
        projectId,
        userId,
        source: "platform",
        deletedAt: null,
        project: { userId, source: "platform", deletedAt: null },
      },
    }
    const source = await this.prisma.generatedImage.findFirst({ where })
    if (!source?.url) throw new NotFoundException("来源图片不存在或不可保存")
    const asset = await inspectCropPng(this.spaces, userId, dto.url, CROP_DIRECTORY)
    let taskId: number
    try {
      taskId = await this.prisma.$transaction(async tx => {
        // 锁住来源图、任务和项目，避免删除与新增副本交错。
        const available = await tx.$queryRaw<Array<{ id: number }>>`
          SELECT i.id FROM GeneratedImage i
          JOIN GenerationTask t ON t.id = i.taskId
          JOIN ImageProject p ON p.id = t.projectId
          WHERE i.id = ${dto.sourceImageId} AND i.source = 'platform'
            AND i.deletedAt IS NULL AND i.status = 'SUCCESS' AND i.url IS NOT NULL
            AND t.projectId = ${projectId} AND t.userId = ${userId}
            AND t.source = 'platform' AND t.deletedAt IS NULL
            AND p.userId = ${userId} AND p.source = 'platform' AND p.deletedAt IS NULL
          FOR UPDATE
        `
        if (!available.length) throw new NotFoundException("来源图片不存在或不可保存")
        const image = await tx.generatedImage.findFirst({ where, include: { task: true } })
        if (!image?.url) throw new NotFoundException("来源图片不存在或不可保存")
        const model = imageMetadata(image.task)
        const created = await tx.generationTask.create({
          data: {
            projectId,
            userId,
            source: "platform",
            type: image.task.type,
            generationMode: "CROP",
            clientRequestId,
            directionIndex: 0,
            presetCategory: image.task.presetCategory,
            presetOption: image.task.presetOption,
            model: model.modelPublicId ?? image.task.model,
            prompt: image.task.prompt,
            promptConfig: image.task.promptConfig ?? Prisma.JsonNull,
            viewConfig: image.task.viewConfig ?? Prisma.JsonNull,
            n: 1,
            imageLabelBase: image.task.imageLabelBase,
            status: "SUCCESS",
            executionSpec: {
              kind: "IMAGE_CROP",
              modelPublicId: model.modelPublicId ?? image.task.model,
              cropRequestHash: requestHash,
              derivation: { type: "CROP", sourceImageId: image.id, sourceTaskId: image.taskId },
              sourceGeneration: {
                aspectRatio: image.task.aspectRatio,
                resolutionTier: model.resolutionTier,
              },
            },
            generatedImages: {
              create: {
                source: "platform",
                status: "SUCCESS",
                url: dto.url,
                originalUrl: image.url,
                width: asset.width,
                height: asset.height,
                order: 0,
                deliveryMeta: {
                  derivation: { type: "CROP", sourceImageId: image.id, sourceTaskId: image.taskId },
                },
              },
            },
          },
          select: { id: true },
        })
        return created.id
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const saved = await existingCrop()
        if (saved) return saved
      }
      throw error
    }
    return this.projects.findOneTask(taskId, userId)
  }
}
