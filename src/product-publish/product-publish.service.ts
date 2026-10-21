import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { Prisma, ProductPublishTaskStatus, ProductPublishType } from "@prisma/client"
import { randomUUID } from "crypto"
import * as path from "path"
import { ZixiaoyunProvider } from "../common/providers/zixiaoyun.provider"
import { PrismaService } from "../prisma/prisma.service"
import { SpacesService } from "../spaces/spaces.service"
import {
  EXPORT_KEY_PREFIX,
  PRODUCT_PUBLISH_CLASSIFICATIONS,
  TEMPLATE_KEY_PREFIX,
} from "./product-publish.constants"
import {
  CompleteProductPublishTaskDto,
  CreateProductPublishTaskDto,
  QueryProductPublishRecordsDto,
  SpreadsheetUploadUrlDto,
  UpdateProductPublishTaskDto,
  WashImageLinksDto,
} from "./product-publish.dto"

export interface ProductPublishImageRecord {
  id?: string
  originalUrl: string
  washedUrl?: string
  washStatus?: "PENDING" | "SUCCESS" | "FAILED"
  errorMessage?: string
}

const PUBLISH_STORE_SELECT = {
  externalStoreId: true,
  name: true,
  shortName: true,
  companyName: true,
  platform: true,
  accountType: true,
} as const

@Injectable()
export class ProductPublishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpacesService,
    private readonly zixiaoyun: ZixiaoyunProvider
  ) {}

  getClassifications() {
    return PRODUCT_PUBLISH_CLASSIFICATIONS.map(item => ({
      ...item,
      templateUrl: this.spaces.getPublicUrl(`${TEMPLATE_KEY_PREFIX}/${item.templateFilename}`),
    }))
  }

  async createTask(dto: CreateProductPublishTaskDto, userId: number) {
    if (dto.imageProjectId) await this.assertAvailableImageProject(dto.imageProjectId, userId)
    const publishStore = await this.resolvePublishStore(dto.storeId, dto.classification)

    const task = await this.prisma.productPublishTask.create({
      data: {
        taskId: randomUUID(),
        userId,
        imageProjectId: dto.imageProjectId,
        productName: dto.productName,
        brand: dto.brand,
        classification: dto.classification,
        category: dto.category,
        data: dto.data as Prisma.InputJsonValue | undefined,
        store: publishStore ? (publishStore.shortName ?? publishStore.name) : dto.store,
        publishStoreId: publishStore?.id,
        type: dto.type as ProductPublishType | undefined,
        productImages: dto.productImages as Prisma.InputJsonValue | undefined,
        progress: dto.progress,
      },
      include: { publishStore: { select: PUBLISH_STORE_SELECT } },
    })
    return this.withClassification(task)
  }

  async updateTask(taskId: string, dto: UpdateProductPublishTaskDto, userId: number) {
    const current = await this.findOwnedTask(taskId, userId)
    if (this.isPublishLocked(current)) {
      throw new ConflictException("上架处理中，暂不能修改任务")
    }
    if (current.publishStoreId && dto.store !== undefined && !dto.storeId) {
      throw new BadRequestException("已关联同步店铺的任务请通过 storeId 修改店铺")
    }
    if (dto.imageProjectId) {
      await this.assertAvailableImageProject(dto.imageProjectId, userId, taskId)
    }
    const storeId =
      dto.storeId ?? (dto.classification ? current.publishStore?.externalStoreId : undefined)
    const publishStore =
      storeId || dto.classification
        ? await this.resolvePublishStore(
            storeId,
            dto.classification ?? (dto.storeId ? current.classification : null)
          )
        : null

    await this.updateTaskWhileNotPublishing(
      taskId,
      userId,
      {
        imageProjectId: dto.imageProjectId,
        productName: dto.productName,
        brand: dto.brand,
        classification: dto.classification,
        category: dto.category,
        data: dto.data as Prisma.InputJsonValue | undefined,
        store: dto.storeId ? (publishStore?.shortName ?? publishStore?.name) : dto.store,
        publishStoreId: dto.storeId ? publishStore?.id : undefined,
        type: dto.type as ProductPublishType | undefined,
        productImages: dto.productImages as Prisma.InputJsonValue | undefined,
        progress: dto.progress,
      },
      "上架处理中，暂不能修改任务"
    )
    const task = await this.findOwnedTask(taskId, userId)
    return this.withClassification(task)
  }

  async findTask(taskId: string, userId: number) {
    const task = await this.findOwnedTask(taskId, userId)
    return this.withClassification(task)
  }

  async countDrafts(userId: number) {
    const count = await this.prisma.productPublishTask.count({
      where: { userId, status: ProductPublishTaskStatus.DRAFT },
    })
    return { count }
  }

  async findDrafts(page: number, pageSize: number, userId: number) {
    const where: Prisma.ProductPublishTaskWhereInput = {
      userId,
      status: ProductPublishTaskStatus.DRAFT,
    }
    const [total, tasks] = await Promise.all([
      this.prisma.productPublishTask.count({ where }),
      this.prisma.productPublishTask.findMany({
        where,
        include: { publishStore: { select: PUBLISH_STORE_SELECT } },
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])
    return { total, page, pageSize, items: await this.toSummaries(tasks) }
  }

  async findRecords(query: QueryProductPublishRecordsDto, userId: number) {
    const {
      page = 1,
      pageSize = 10,
      keyword,
      status,
      store,
      storeId,
      classification,
      category,
      type,
    } = query
    const where: Prisma.ProductPublishTaskWhereInput = {
      userId,
      status: status as ProductPublishTaskStatus | undefined,
      store,
      ...(storeId ? { publishStore: { externalStoreId: storeId } } : {}),
      classification,
      type: type as ProductPublishType | undefined,
      ...(category ? { category: { contains: category } } : {}),
      ...(keyword
        ? {
            OR: [
              { productName: { contains: keyword } },
              { brand: { contains: keyword } },
              { category: { contains: keyword } },
            ],
          }
        : {}),
    }
    const [total, tasks] = await Promise.all([
      this.prisma.productPublishTask.count({ where }),
      this.prisma.productPublishTask.findMany({
        where,
        include: {
          publishStore: {
            select: PUBLISH_STORE_SELECT,
          },
        },
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])
    return { total, page, pageSize, items: await this.toSummaries(tasks) }
  }

  async generateSpreadsheetUploadUrl(taskId: string, dto: SpreadsheetUploadUrlDto, userId: number) {
    const task = await this.findOwnedTask(taskId, userId)
    if (this.isPublishLocked(task)) {
      throw new ConflictException("上架处理中，不能重新生成表格上传地址")
    }
    const ext = path.extname(dto.filename).toLowerCase()
    const contentType =
      ext === ".xlsm"
        ? "application/vnd.ms-excel.sheet.macroEnabled.12"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return this.spaces.generateUploadUrl({
      key: `${EXPORT_KEY_PREFIX}/${userId}/${taskId}/${randomUUID()}${ext}`,
      contentType,
    })
  }

  async completeTask(taskId: string, dto: CompleteProductPublishTaskDto, userId: number) {
    const task = await this.findOwnedTask(taskId, userId)
    if (this.isPublishLocked(task)) {
      throw new ConflictException("上架处理中，不能重新完成任务")
    }
    const expectedPrefix = `${EXPORT_KEY_PREFIX}/${userId}/${taskId}/`
    if (!dto.spreadsheetKey.startsWith(expectedPrefix)) {
      throw new BadRequestException("表格文件不属于当前上架任务")
    }
    if (!(await this.spaces.objectExists(dto.spreadsheetKey))) {
      throw new BadRequestException("表格文件尚未上传成功或不存在")
    }

    await this.updateTaskWhileNotPublishing(
      taskId,
      userId,
      {
        status: ProductPublishTaskStatus.COMPLETED,
        progress: 100,
        spreadsheetKey: dto.spreadsheetKey,
        spreadsheetUrl: this.spaces.getPublicUrl(dto.spreadsheetKey),
        completedAt: new Date(),
      },
      "上架处理中，不能重新完成任务"
    )
    const completed = await this.findOwnedTask(taskId, userId)
    return this.withClassification(completed)
  }

  async washImageLinks(taskId: string, dto: WashImageLinksDto, userId: number) {
    const task = await this.findOwnedTask(taskId, userId)
    if (this.isPublishLocked(task)) {
      throw new ConflictException("上架处理中，不能重新处理图片链接")
    }
    const imageUrls = [...new Set(dto.imageUrls)]
    const results: ProductPublishImageRecord[] = []

    // 官方建议排队请求，避免同时并发上传导致不稳定。
    for (const originalUrl of imageUrls) {
      try {
        const washed = await this.zixiaoyun.washImageUrl(originalUrl)
        results.push({
          originalUrl,
          washedUrl: washed.url,
          washStatus: "SUCCESS",
        })
      } catch (error) {
        results.push({
          originalUrl,
          washStatus: "FAILED",
          errorMessage: this.readErrorMessage(error),
        })
      }
    }

    const existing = this.parseProductImages(task.productImages)
    const updates = new Map(results.map(item => [item.originalUrl, item]))
    const merged = existing.map(item => {
      const update = updates.get(item.originalUrl)
      return update ? { ...item, ...update } : item
    })
    const existingUrls = new Set(existing.map(item => item.originalUrl))
    for (const result of results) {
      if (!existingUrls.has(result.originalUrl)) merged.push(result)
    }

    await this.updateTaskWhileNotPublishing(
      taskId,
      userId,
      { productImages: merged as unknown as Prisma.InputJsonValue },
      "上架处理中，不能重新处理图片链接"
    )
    return {
      total: results.length,
      successCount: results.filter(item => item.washStatus === "SUCCESS").length,
      failedCount: results.filter(item => item.washStatus === "FAILED").length,
      items: results,
    }
  }

  async deleteRecord(taskId: string, userId: number) {
    const task = await this.findOwnedTask(taskId, userId)
    if (this.isPublishLocked(task)) {
      throw new ConflictException("上架处理中，不能删除记录")
    }
    await this.updateTaskWhileNotPublishing(
      taskId,
      userId,
      // 释放 imageProjectId 唯一约束，允许该图片项目后续创建新的上架任务。
      { deletedAt: new Date(), imageProjectId: null },
      "上架处理中，不能删除记录"
    )
    return { message: "上架记录已删除" }
  }

  private isPublishLocked(task: {
    status: ProductPublishTaskStatus
    submitRequestId: string | null
    uploadId: string | null
  }): boolean {
    return (
      task.status === ProductPublishTaskStatus.PUBLISHING ||
      task.submitRequestId !== null ||
      task.uploadId !== null
    )
  }

  private async updateTaskWhileNotPublishing(
    taskId: string,
    userId: number,
    data: Prisma.ProductPublishTaskUncheckedUpdateManyInput,
    conflictMessage: string
  ): Promise<void> {
    const result = await this.prisma.productPublishTask.updateMany({
      where: {
        taskId,
        userId,
        deletedAt: null,
        status: { not: ProductPublishTaskStatus.PUBLISHING },
        submitRequestId: null,
        uploadId: null,
      },
      data,
    })
    if (result.count !== 1) throw new ConflictException(conflictMessage)
  }

  private async findOwnedTask(taskId: string, userId: number) {
    const task = await this.prisma.productPublishTask.findFirst({
      where: { taskId, userId },
      include: { publishStore: { select: PUBLISH_STORE_SELECT } },
    })
    if (!task) throw new NotFoundException("上架任务不存在")
    return task
  }

  private async assertAvailableImageProject(
    imageProjectId: number,
    userId: number,
    currentTaskId?: string
  ) {
    const project = await this.prisma.imageProject.findFirst({
      where: { id: imageProjectId, userId, source: "platform" },
      select: { id: true },
    })
    if (!project) throw new NotFoundException("图片项目不存在")

    const occupied = await this.prisma.productPublishTask.findFirst({
      where: {
        imageProjectId,
        ...(currentTaskId ? { taskId: { not: currentTaskId } } : {}),
      },
      select: { taskId: true },
    })
    if (occupied) throw new ConflictException("该图片项目已关联其他上架任务")
  }

  private async resolvePublishStore(externalStoreId?: string, classification?: string | null) {
    if (!externalStoreId) {
      if (
        classification &&
        !PRODUCT_PUBLISH_CLASSIFICATIONS.some(item => item.code === classification)
      ) {
        throw new BadRequestException("不支持该商品分类")
      }
      return null
    }

    const store = await this.prisma.productPublishStore.findUnique({
      where: { externalStoreId },
      select: { id: true, name: true, shortName: true, platform: true, disabled: true },
    })
    if (!store) throw new NotFoundException("店铺不存在")
    if (store.disabled) throw new BadRequestException("店铺已禁用")
    if (store.platform !== "AMAZON") throw new BadRequestException("当前仅支持 Amazon 店铺")

    if (classification) {
      const storeClassification = await this.prisma.productPublishStoreClassification.findUnique({
        where: { storeId_classification: { storeId: store.id, classification } },
        select: { id: true },
      })
      if (!storeClassification) throw new BadRequestException("该店铺不支持此商品分类")
    }
    return store
  }

  private async withClassification<
    T extends { publishStoreId: number | null; classification: string | null },
  >(task: T) {
    const storeClassification =
      task.publishStoreId && task.classification
        ? await this.prisma.productPublishStoreClassification.findUnique({
            where: {
              storeId_classification: {
                storeId: task.publishStoreId,
                classification: task.classification,
              },
            },
            select: {
              classification: true,
              classificationName: true,
              templateUrl: true,
              templateStatus: true,
              templateSyncedAt: true,
            },
          })
        : null

    return {
      ...task,
      submitCorrelationKey: undefined,
      classificationInfo: this.buildClassificationInfo(
        task.classification,
        storeClassification,
        Boolean(task.publishStoreId)
      ),
    }
  }

  private async toSummaries<
    T extends {
      publishStoreId: number | null
      classification: string | null
      productImages: Prisma.JsonValue
    },
  >(tasks: T[]) {
    const keys = new Map<string, { storeId: number; classification: string }>()
    for (const task of tasks) {
      if (!task.publishStoreId || !task.classification) continue
      keys.set(`${task.publishStoreId}:${task.classification}`, {
        storeId: task.publishStoreId,
        classification: task.classification,
      })
    }
    const storeClassifications = keys.size
      ? await this.prisma.productPublishStoreClassification.findMany({
          where: {
            OR: [...keys.values()].map(({ storeId, classification }) => ({
              storeId,
              classification,
            })),
          },
          select: {
            storeId: true,
            classification: true,
            classificationName: true,
            templateUrl: true,
            templateStatus: true,
            templateSyncedAt: true,
          },
        })
      : []
    const byKey = new Map(
      storeClassifications.map(item => [`${item.storeId}:${item.classification}`, item])
    )

    return tasks.map(task =>
      this.toSummary(
        task,
        task.publishStoreId && task.classification
          ? byKey.get(`${task.publishStoreId}:${task.classification}`)
          : undefined,
        Boolean(task.publishStoreId)
      )
    )
  }

  private toSummary<T extends { classification: string | null; productImages: Prisma.JsonValue }>(
    task: T,
    storeClassification?: {
      classification: string
      classificationName: string
      templateUrl: string | null
      templateStatus: string
      templateSyncedAt: Date | null
    },
    useStoreTemplate = false
  ) {
    const images = this.parseProductImages(task.productImages)
    return {
      ...task,
      data: undefined,
      productImages: undefined,
      submitCorrelationKey: undefined,
      previewImageUrl: images[0]?.washedUrl ?? images[0]?.originalUrl ?? null,
      classificationInfo: this.buildClassificationInfo(
        task.classification,
        storeClassification,
        useStoreTemplate
      ),
    }
  }

  private buildClassificationInfo(
    code: string | null,
    storeClassification?: {
      classification: string
      classificationName: string
      templateUrl: string | null
      templateStatus: string
      templateSyncedAt: Date | null
    } | null,
    useStoreTemplate = false
  ) {
    if (storeClassification) {
      const legacy = this.getClassification(storeClassification.classification)
      return {
        ...(legacy ?? {
          code: storeClassification.classification,
          templateFilename: null,
        }),
        name: storeClassification.classificationName,
        templateUrl: storeClassification.templateUrl,
        templateStatus: storeClassification.templateStatus,
        templateSyncedAt: storeClassification.templateSyncedAt,
      }
    }
    if (useStoreTemplate && code) {
      const legacy = this.getClassification(code)
      return {
        ...(legacy ?? { code, name: code, templateFilename: null }),
        templateUrl: null,
        templateStatus: "PENDING",
        templateSyncedAt: null,
      }
    }
    return this.getClassification(code)
  }

  private getClassification(code: string | null) {
    if (!code) return null
    const item = PRODUCT_PUBLISH_CLASSIFICATIONS.find(candidate => candidate.code === code)
    return item
      ? {
          ...item,
          templateUrl: this.spaces.getPublicUrl(`${TEMPLATE_KEY_PREFIX}/${item.templateFilename}`),
        }
      : null
  }

  private parseProductImages(value: Prisma.JsonValue | null): ProductPublishImageRecord[] {
    if (!Array.isArray(value)) return []
    return value.flatMap(item => {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        typeof item.originalUrl !== "string"
      ) {
        return []
      }
      return [
        {
          ...(typeof item.id === "string" ? { id: item.id } : {}),
          originalUrl: item.originalUrl,
          ...(typeof item.washedUrl === "string" ? { washedUrl: item.washedUrl } : {}),
          ...(item.washStatus === "PENDING" ||
          item.washStatus === "SUCCESS" ||
          item.washStatus === "FAILED"
            ? { washStatus: item.washStatus }
            : {}),
          ...(typeof item.errorMessage === "string" ? { errorMessage: item.errorMessage } : {}),
        },
      ]
    })
  }

  private readErrorMessage(error: unknown): string {
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message
      if (typeof message === "string") return message
    }
    return "图片洗链接失败"
  }
}
