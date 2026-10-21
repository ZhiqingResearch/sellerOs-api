import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { randomUUID } from "crypto"
import { jsonObject } from "../common/utils/generation-metadata"
import { PrismaService } from "../prisma/prisma.service"
import { SpacesService } from "../spaces/spaces.service"
import { TaskSnapshot } from "./chetaidou-context.service"
import {
  ChetaidouImageOptionsService,
  imageModelFingerprint,
  planChetaidouImage,
} from "./chetaidou-image-options.service"
import { ChetaidouStorageService, stableHash } from "./chetaidou-storage.service"
import {
  CHETAIDOU_BUSINESS_TYPE,
  CHETAIDOU_IMAGE_CATEGORY,
  chetaidouEnabled,
} from "./chetaidou.constants"
import {
  InpaintResultDto,
  SaveResultMaterialDto,
  SaveResultTemplateDto,
} from "./dto/chetaidou-result.dto"

type Db = Prisma.TransactionClient
type UploadedImage = { buffer: Buffer }

@Injectable()
export class ChetaidouResultService {
  private readonly logger = new Logger(ChetaidouResultService.name)
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpacesService,
    private readonly storage: ChetaidouStorageService,
    private readonly imageOptions: ChetaidouImageOptionsService
  ) {}

  private async source(db: Db, ownerId: number, resultId: number) {
    const item = await db.imageGenItem.findFirst({
      where: {
        id: resultId,
        deletedAt: null,
        job: { userId: ownerId, businessType: CHETAIDOU_BUSINESS_TYPE },
      },
    })
    if (!item) throw new NotFoundException("结果不存在")
    if (item.status !== "SUCCEEDED" || !item.fileKey)
      throw new ConflictException("图片尚未成功或文件未就绪")
    const task = await db.chetaidouTask.findFirst({
      where: { ownerId, imageGenJobId: item.jobId, type: "GENERATE", operation: "PRIMARY" },
    })
    if (!task) throw new NotFoundException("结果任务不存在")
    return { item, task, snapshot: task.snapshot as unknown as TaskSnapshot }
  }

  private checkHash(saved: { requestHash: string }, requestHash: string) {
    if (saved.requestHash !== requestHash) throw new ConflictException("幂等键已用于不同请求")
  }

  private async createdTask(
    task: { id: string; imageGenJobId: string | null },
    sourceResultId: number
  ) {
    const job = await this.prisma.imageGenJob.findUniqueOrThrow({
      where: { id: task.imageGenJobId! },
      include: { items: { orderBy: { idx: "asc" } } },
    })
    return {
      taskId: task.id,
      status: job.status,
      imageGenJobId: job.id,
      intent: "INPAINT",
      sourceResultId,
      items: job.items.map(i => ({ resultId: i.id, index: i.idx + 1, status: i.status })),
    }
  }

  async inpaint(
    ownerId: number,
    resultId: number,
    dto: InpaintResultDto,
    annotated: UploadedImage,
    references: UploadedImage[] = []
  ) {
    if (!chetaidouEnabled()) throw new BadRequestException("车泰斗功能已关闭")
    if (!annotated?.buffer) throw new BadRequestException("请上传标注图")
    const marked = await this.storage.validateImage(annotated.buffer)
    if (marked.mime !== "image/png") throw new BadRequestException("标注图必须是 PNG")
    const refs = await Promise.all(references.map(file => this.storage.validateImage(file.buffer)))
    const boxes = dto.annotatedBoxes.map(box => ({
      ...box,
      instruction: box.instruction.trim(),
      refImageNumbers: box.refImageNumbers ?? [],
    }))
    if (
      new Set(boxes.map(b => b.n)).size !== boxes.length ||
      boxes.some(
        b =>
          !b.instruction ||
          b.x + b.w > 1 ||
          b.y + b.h > 1 ||
          b.refImageNumbers.some(n => n > refs.length)
      )
    )
      throw new BadRequestException("标注范围、编号或参考图编号不合法")
    const requestHash = stableHash({
      action: "inpaint",
      resultId,
      ...dto,
      annotatedBoxes: boxes,
      annotatedChecksum: marked.checksum,
      referenceChecksums: refs.map(r => r.checksum),
    })
    const saved = await this.prisma.chetaidouTask.findFirst({
      where: { ownerId, idempotencyKey: dto.idempotencyKey },
    })
    if (saved) {
      this.checkHash(saved, requestHash)
      return this.createdTask(saved, resultId)
    }
    const { item, task, snapshot: original } = await this.source(this.prisma, ownerId, resultId)
    const source = await this.storage.validateImage(await this.spaces.downloadBuffer(item.fileKey!))
    if (
      source.width !== dto.sourceWidth ||
      source.height !== dto.sourceHeight ||
      marked.width !== source.width ||
      marked.height !== source.height
    )
      throw new ConflictException({
        code: "EDIT_SOURCE_MISMATCH",
        message: "源图或标注尺寸不一致，请重新加载图片",
      })
    if (dto.imageModel !== undefined && !dto.imageModel.trim())
      throw new BadRequestException("图片模型不能为空")
    const publicId = dto.imageModel?.trim() || original.models?.image?.publicId
    if (!publicId) throw new BadRequestException("来源模型未记录，请选择图片模型")
    const model = await this.imageOptions.resolveModel(undefined, publicId)
    const prompt = [
      "Edit image 1 only. Image 2 marks numbered rectangles on image 1; do not render these marks. Additional references start at image 3. Preserve all unrequested content, product identity and text. Keep the source canvas dimensions.",
      dto.prompt?.trim() ?? "",
      ...boxes.map(
        b =>
          `Region ${b.n} (${b.x},${b.y},${b.w},${b.h}): ${b.instruction}${b.refImageNumbers.length ? `; reference images ${b.refImageNumbers.map(n => n + 2).join(",")}` : ""}`
      ),
    ].join("\n")
    const generation = planChetaidouImage(
      model,
      {
        aspectRatio: "custom",
        customAspectW: source.width,
        customAspectH: source.height,
        resolutionTier: original.generation?.resolutionTier,
        quality: original.generation?.quality,
      },
      1,
      prompt,
      { width: source.width, height: source.height, referenceCount: refs.length + 2 }
    )
    if (!original.generation?.resolutionTier)
      delete (generation as Partial<typeof generation>).resolutionTier
    const taskId = randomUUID(),
      jobId = randomUUID()
    const keys = [marked, ...refs].map(
      (a, i) => `chetaidou/edits/${taskId}/${i}.${a.mime.split("/")[1]}`
    )
    const snapshot: TaskSnapshot = {
      ...original,
      models: {
        ...original.models,
        image: { publicId: model.publicId, category: CHETAIDOU_IMAGE_CATEGORY },
      },
      generation,
      edit: {
        sourceResultId: resultId,
        sourceTaskId: task.id,
        width: source.width,
        height: source.height,
      },
    }
    let transactionStarted = false
    try {
      for (const [i, asset] of [marked, ...refs].entries())
        await this.storage.hostArtifact(asset.buffer, keys[i], asset.mime)
      transactionStarted = true
      await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM ImageGenItem WHERE id = ${resultId} FOR UPDATE`
        await this.source(tx, ownerId, resultId)
        await this.imageOptions.assertUnchanged(tx, imageModelFingerprint(model), publicId)
        await tx.imageGenJob.create({
          data: {
            id: jobId,
            userId: ownerId,
            kind: "IMAGE_TO_IMAGE",
            businessType: CHETAIDOU_BUSINESS_TYPE,
            businessTaskId: taskId,
            model: publicId,
            prompt,
            request: {
              intent: "INPAINT",
              sourceResultId: resultId,
              sourceFileKey: item.fileKey!,
              sourceChecksum: source.checksum,
              referenceFileKeys: keys,
              prompt,
              generation,
              model: publicId,
              count: 1,
            } as unknown as Prisma.InputJsonValue,
            items: { create: { idx: 0, status: "QUEUED" } },
          },
        })
        await tx.chetaidouTask.create({
          data: {
            id: taskId,
            rootTaskId: taskId,
            ownerId,
            skuId: task.skuId,
            imageId: task.imageId,
            workspaceId: task.workspaceId,
            adjustmentId: task.adjustmentId,
            site: task.site ?? original.settings.site,
            type: "GENERATE",
            imageGenJobId: jobId,
            idempotencyKey: dto.idempotencyKey,
            requestHash,
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
            input: {
              intent: "INPAINT",
              sourceResultId: resultId,
              prompt: dto.prompt ?? "",
              annotatedBoxes: boxes,
            },
          },
        })
      })
    } catch (error) {
      const existing = await this.prisma.chetaidouTask.findFirst({
        where: { ownerId, idempotencyKey: dto.idempotencyKey },
      })
      if (existing?.id === taskId) {
        this.checkHash(existing, requestHash)
        return this.createdTask(existing, resultId)
      }
      if (
        !transactionStarted ||
        existing ||
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          ["P2002", "P2034", "P2025"].includes(error.code)) ||
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
        await Promise.all(keys.map(key => this.storage.deleteObject(key).catch(() => undefined)))
      }
      if (existing) {
        this.checkHash(existing, requestHash)
        return this.createdTask(existing, resultId)
      }
      throw error
    }
    return this.createdTask({ id: taskId, imageGenJobId: jobId }, resultId)
  }

  saveTemplate(ownerId: number, resultId: number, dto: SaveResultTemplateDto) {
    if (dto.mode === "CREATE" && (!dto.name?.trim() || dto.templateId != null))
      throw new BadRequestException("新建模板请填写名称，不传 templateId")
    if (
      dto.mode === "APPEND" &&
      (!dto.templateId ||
        dto.name !== undefined ||
        dto.groupName !== undefined ||
        dto.tags !== undefined ||
        dto.note !== undefined)
    )
      throw new BadRequestException("追加模式只传 templateId 与幂等键")
    return this.save(ownerId, resultId, "TEMPLATE", dto)
  }

  saveMaterial(ownerId: number, resultId: number, dto: SaveResultMaterialDto) {
    if (!dto.name.trim()) throw new BadRequestException("素材名称不能为空")
    return this.save(ownerId, resultId, "MATERIAL", dto)
  }

  private async target(
    db: Db,
    ownerId: number,
    dto: SaveResultTemplateDto | SaveResultMaterialDto
  ) {
    if (
      "mode" in dto &&
      dto.mode === "APPEND" &&
      !(await db.imageTemplate.findFirst({
        where: { id: dto.templateId, userId: ownerId, isSystem: false, deletedAt: null },
      }))
    )
      throw new NotFoundException("个人模板不存在")
    if (
      "groupId" in dto &&
      dto.groupId != null &&
      !(await db.poolGroup.findFirst({ where: { id: dto.groupId, userId: ownerId } }))
    )
      throw new NotFoundException("素材分组不存在")
  }

  private async save(
    ownerId: number,
    resultId: number,
    action: "TEMPLATE" | "MATERIAL",
    dto: SaveResultTemplateDto | SaveResultMaterialDto
  ) {
    if (!chetaidouEnabled()) throw new BadRequestException("车泰斗功能已关闭")
    const requestHash = stableHash({ action, resultId, ...dto })
    const existing = await this.prisma.chetaidouResultImport.findUnique({
      where: { ownerId_idempotencyKey: { ownerId, idempotencyKey: dto.idempotencyKey } },
    })
    if (existing) {
      this.checkHash(existing, requestHash)
      return existing.response
    }
    const { item, task, snapshot } = await this.source(this.prisma, ownerId, resultId)
    await this.target(this.prisma, ownerId, dto)
    const asset = await this.storage.validateImage(await this.spaces.downloadBuffer(item.fileKey!))
    const key = `chetaidou-imports/${ownerId}/${randomUUID()}.${asset.mime.split("/")[1]}`
    const url = await this.spaces.uploadBuffer(asset.buffer, key, asset.mime)
    const sourceMeta = {
      type: "CHETAIDOU",
      resultId,
      taskId: task.id,
      modelPublicId: snapshot.models?.image?.publicId ?? null,
      resolutionTier: snapshot.generation?.resolutionTier ?? null,
      width: asset.width,
      height: asset.height,
    }
    try {
      const response = await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM ImageGenItem WHERE id = ${resultId} FOR UPDATE`
        await this.source(tx, ownerId, resultId)
        await this.target(tx, ownerId, dto)
        let result: Prisma.InputJsonObject
        if (action === "MATERIAL") {
          const records = await tx.chetaidouResultImport.findMany({
            where: { ownerId, sourceResultId: resultId, action },
            orderBy: { id: "desc" },
          })
          for (const record of records) {
            const id: unknown = jsonObject(record.response).poolImageId
            if (
              typeof id === "number" &&
              (await tx.poolImage.findFirst({ where: { id, userId: ownerId, deletedAt: null } }))
            ) {
              throw new ConflictException("已在素材池中")
            }
          }
          const d = dto as SaveResultMaterialDto
          const poolImageId = (
            await tx.poolImage.create({
              data: {
                userId: ownerId,
                name: d.name.trim(),
                groupId: d.groupId,
                tags: d.tags ?? [],
                url,
                sourceLabel: "车泰斗",
                sourceMeta,
              },
            })
          ).id
          result = { resultId, poolImageId }
        } else {
          const d = dto as SaveResultTemplateDto
          let templateId = d.templateId
          if (d.mode === "CREATE") {
            const groupName = d.groupName?.trim()
            const group = groupName
              ? await tx.imageTemplateGroup.upsert({
                  where: { userId_name: { userId: ownerId, name: groupName } },
                  create: { userId: ownerId, name: groupName, isSystem: false },
                  update: {},
                })
              : null
            templateId = (
              await tx.imageTemplate.create({
                data: {
                  userId: ownerId,
                  isSystem: false,
                  name: d.name!.trim(),
                  groupId: group?.id,
                  tags: d.tags ?? [],
                  note: d.note,
                },
              })
            ).id
          }
          await tx.$queryRaw`SELECT id FROM ImageTemplate WHERE id = ${templateId!} FOR UPDATE`
          const last = await tx.imageTemplateItem.findFirst({
            where: { templateId },
            orderBy: { sortOrder: "desc" },
          })
          const templateItem = await tx.imageTemplateItem.create({
            data: {
              templateId: templateId!,
              name: "车泰斗生成图",
              refImageUrl: url,
              resolutionTier: snapshot.generation?.resolutionTier,
              aspectRatio: snapshot.generation?.aspectRatio,
              sourceMeta,
              sortOrder: (last?.sortOrder ?? -1) + 1,
            },
          })
          result = { resultId, templateId: templateId!, templateItemId: templateItem.id }
        }
        await tx.chetaidouResultImport.create({
          data: {
            ownerId,
            idempotencyKey: dto.idempotencyKey,
            action,
            sourceResultId: resultId,
            requestHash,
            response: result,
          },
        })
        return result
      })
      return response
    } catch (error) {
      const saved = await this.prisma.chetaidouResultImport.findUnique({
        where: { ownerId_idempotencyKey: { ownerId, idempotencyKey: dto.idempotencyKey } },
      })
      // 提交结果不明时先查目标是否引用本次副本，再决定是否清理。
      const referenced =
        action === "MATERIAL"
          ? await this.prisma.poolImage.findFirst({ where: { userId: ownerId, url } })
          : await this.prisma.imageTemplateItem.findFirst({
              where: { refImageUrl: url, template: { userId: ownerId } },
            })
      const rolledBack =
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException ||
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          ["P2002", "P2034", "P2025"].includes(error.code))
      if (!referenced && rolledBack)
        await this.storage
          .deleteObject(key)
          .catch(e => this.logger.warn(`清理导入副本失败：${String(e)}`))
      if (saved) {
        this.checkHash(saved, requestHash)
        return saved.response
      }
      throw error
    }
  }
}
