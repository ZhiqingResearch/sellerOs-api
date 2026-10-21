import { modelDisplayNames, jsonObject } from "../common/utils/generation-metadata"
// 车泰斗素材工作台 — C 端读写服务（方案 §4/§5/§7）
// 职责：资料读取、上传登记、草稿 CAS、任务创建（幂等+快照冻结）、
// 任务/组合/结果投影。执行与结算在 executor/。
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { randomUUID } from "crypto"
import { PrismaService as PrismaService2 } from "../prisma/prisma.service"
import {
  adjustmentState,
  assertWorkspace,
  forkAdjustment,
  lockAdjustmentDraft,
  ownedAdjustment,
  prepareAdjustment,
  saveDraftAdjustment,
  workspaceChanged,
  writeTaskAdjustment,
} from "./chetaidou-adjustment"
import { ChetaidouBillingService } from "./chetaidou-billing.service"
import { ChetaidouContextService, TaskSnapshot } from "./chetaidou-context.service"
import {
  applyDivergeOutput,
  CustomDimensionInput,
  normalizeCustomDimensions,
} from "./chetaidou-draft"
import { groupErrorMessage, taskErrorMessage } from "./chetaidou-errors"
import {
  ChetaidouImageOptionsService,
  generationCanvasPrompt,
  imageModelFingerprint,
  imageSelectionHashFields,
  planChetaidouImage,
} from "./chetaidou-image-options.service"
import { ChetaidouStorageService, originalImageOf, stableHash } from "./chetaidou-storage.service"
import {
  CHETAIDOU_BUSINESS_TYPE,
  CHETAIDOU_ERROR_CODES,
  CHETAIDOU_IMAGE_CATEGORY,
  CHETAIDOU_MAX_CUSTOM_DIMENSIONS,
  CHETAIDOU_SITES,
  chetaidouEnabled,
  chetaidouIdeationStatus,
  chetaidouImageJobStatus,
} from "./chetaidou.constants"
import {
  ChetaidouBreakdownPayload,
  ChetaidouComposeOutput,
  ChetaidouGroupDefinition,
  ChetaidouOption,
  ChetaidouSettings,
  compositionScopeKey,
  validateSettings,
} from "./chetaidou.schemas"
import { CreateTaskDto, SelectionRefDto } from "./dto/chetaidou.dto"

import { contentSettingsOf, IDEATION_BATCH_VERSION } from "./chetaidou-execution"

type TaskRow = Prisma.ChetaidouTaskGetPayload<Record<string, never>>
type GroupRow = Prisma.ChetaidouGroupGetPayload<Record<string, never>>
type DraftRow = Prisma.ChetaidouDraftGetPayload<Record<string, never>>
type BreakdownRow = Prisma.ChetaidouBreakdownGetPayload<Record<string, never>>
type ImageRow = Prisma.ChetaidouImageGetPayload<Record<string, never>>
type SkuRow = Prisma.ChetaidouSkuGetPayload<Record<string, never>>
type FactRow = Prisma.ChetaidouFactCardGetPayload<Record<string, never>>

@Injectable()
export class ChetaidouService {
  private readonly logger = new Logger(ChetaidouService.name)

  constructor(
    private readonly prisma: PrismaService2,
    private readonly context: ChetaidouContextService,
    private readonly storage: ChetaidouStorageService,
    private readonly billing: ChetaidouBillingService,
    private readonly imageOptions: ChetaidouImageOptionsService
  ) {}

  // ── 功能开关/配置 ───────────────────────────────────────────────────────

  async getConfig() {
    const modelsReady = await this.billing
      .assertModelsReady()
      .then(() => this.context.resolveBreakdownModels())
      .then(() => true)
      .catch(() => false)
    return {
      enabled: chetaidouEnabled(),
      capabilities: {
        upload: process.env.CHETAIDOU_UPLOAD_ENABLED !== "false",
        diverge: process.env.CHETAIDOU_DIVERGE_ENABLED !== "false",
        refreshGroup: true,
        targetedRetry: process.env.CHETAIDOU_TARGETED_RETRY_ENABLED !== "false",
      },
      sites: Object.keys(CHETAIDOU_SITES),
      siteLocales: CHETAIDOU_SITES,
      textModes: ["keep", "hide", "translate", "show"],
      personModes: ["keep", "replace"],
      generateCounts: [1, 2, 4, 8],
      limits: {
        ideationBatchSize: 3,
        executionVersion: IDEATION_BATCH_VERSION,
        maxCustomDimensions: CHETAIDOU_MAX_CUSTOM_DIMENSIONS,
        maxCustomTextLength: 1000,
      },
      models: { ready: modelsReady },
    }
  }

  // ── SKU / 母版 ──────────────────────────────────────────────────────────

  async listSkus(): Promise<{ items: SkuRow[] }> {
    return {
      items: await this.prisma.chetaidouSku.findMany({
        where: { enabled: true },
        orderBy: { id: "asc" },
      }),
    }
  }

  async listImages(
    userId: number,
    skuId: number,
    query: { keyword?: string; page: number; pageSize: number }
  ) {
    const sku = await this.requireSku(skuId)
    void sku
    const visibility: Prisma.ChetaidouImageWhereInput[] = [
      { sourceType: "PRESET" },
      { sourceType: "USER_UPLOAD", ownerId: userId },
    ]
    const where: Prisma.ChetaidouImageWhereInput = {
      skuId,
      enabled: true,
      AND: [
        { OR: visibility },
        ...(query.keyword
          ? [
              {
                OR: [
                  { number: { contains: query.keyword } },
                  { title: { contains: query.keyword } },
                ],
              },
            ]
          : []),
      ],
    }
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.chetaidouImage.count({ where }),
      this.prisma.chetaidouImage.findMany({
        where,
        orderBy: { id: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ])
    // 一次性批量取当前拆解（远程库 RTT 高，逐图 findUnique 的 N+1 不可接受）
    const breakdownIds = rows.map(r => r.currentBreakdownId).filter((v): v is number => v != null)
    const breakdowns = breakdownIds.length
      ? await this.prisma.chetaidouBreakdown.findMany({
          where: { id: { in: breakdownIds } },
          select: { id: true, version: true, qualityStatus: true, source: true },
        })
      : []
    const breakdownById = new Map(breakdowns.map(b => [b.id, b]))
    const taskIds = rows.flatMap(r => (r.activeBreakdownTaskId ? [r.activeBreakdownTaskId] : []))
    const tasks = taskIds.length
      ? await this.prisma.chetaidouTask.findMany({
          where: { id: { in: taskIds } },
          select: { id: true, status: true, stage: true, errorCode: true, errorMessage: true },
        })
      : []
    const tasksById = new Map(tasks.map(t => [t.id, t]))
    const items = await Promise.all(
      rows.map(async img =>
        this.projectImageSummary(img, breakdownById.get(img.currentBreakdownId ?? -1) ?? null).then(
          summary => ({
            ...summary,
            activeBreakdownTask: tasksById.get(img.activeBreakdownTaskId ?? "") ?? null,
          })
        )
      )
    )
    return { total, page: query.page, pageSize: query.pageSize, items }
  }

  private async projectImageSummary(
    img: ImageRow,
    breakdown?: { id: number; version: number; qualityStatus: string; source: string } | null
  ) {
    const previewUrl = await this.storage.signDownload(img.fileKey, 3600).catch(() => null)
    let unavailable: string | null = null
    if (!breakdown) unavailable = "该母版还没有可用拆解"
    else if (breakdown.qualityStatus === "INVALID") unavailable = "拆解已失效，等待重新准备"
    return {
      id: img.id,
      skuId: img.skuId,
      sourceType: img.sourceType,
      title: img.title,
      number: img.number,
      mime: img.mime,
      width: img.width,
      height: img.height,
      previewUrl,
      thumbnailUrl: await this.storage.thumbnailUrl(img.sourceMetadata, previewUrl),
      breakdown: breakdown
        ? {
            id: breakdown.id,
            version: breakdown.version,
            qualityStatus: breakdown.qualityStatus,
            source: breakdown.source,
          }
        : null,
      available: !unavailable,
      unavailableReason: unavailable,
      createdAt: img.createdAt,
    }
  }

  async getImage(userId: number, imageId: number) {
    const { image, breakdown, fact } = await this.requireAccessibleImage(userId, imageId)
    const previewUrl = await this.storage.signDownload(image.fileKey, 3600).catch(() => null)
    const task = image.activeBreakdownTaskId
      ? await this.prisma.chetaidouTask.findUnique({ where: { id: image.activeBreakdownTaskId } })
      : null
    return {
      image: {
        id: image.id,
        skuId: image.skuId,
        sourceType: image.sourceType,
        title: image.title,
        number: image.number,
        mime: image.mime,
        width: image.width,
        height: image.height,
        previewUrl,
        thumbnailUrl: await this.storage.thumbnailUrl(image.sourceMetadata, previewUrl),
        createdAt: image.createdAt,
      },
      facts: { id: fact.id, version: fact.version, content: fact.content },
      breakdown: breakdown
        ? {
            id: breakdown.id,
            version: breakdown.version,
            qualityStatus: breakdown.qualityStatus,
            source: breakdown.source,
            payload: {
              ...(breakdown.payload as object),
              pets: (breakdown.payload as unknown as ChetaidouBreakdownPayload).pets ?? [],
              props: (breakdown.payload as unknown as ChetaidouBreakdownPayload).props ?? [],
              baskets: (breakdown.payload as unknown as ChetaidouBreakdownPayload).baskets ?? [],
            },
          }
        : null,
      activeBreakdownTask: task
        ? {
            id: task.id,
            status: task.status,
            stage: task.stage,
            errorCode: task.errorCode,
            errorMessage: taskErrorMessage(task),
          }
        : null,
    }
  }

  /** 只隐藏本人上传母版；原文件与历史快照保留，已提交任务可继续执行。 */
  async removeImage(userId: number, imageId: number): Promise<{ imageId: number; removed: true }> {
    // 不走 requireAccessibleImage，保证已移除图片可重复移除，资料缺失也不影响清理。
    const image = await this.prisma.chetaidouImage.findUnique({ where: { id: imageId } })
    if (!image || (image.sourceType === "USER_UPLOAD" && image.ownerId !== userId)) {
      throw new NotFoundException({ code: "IMAGE_NOT_FOUND", message: "图片不存在或无权移除" })
    }
    if (image.sourceType !== "USER_UPLOAD") {
      throw new BadRequestException({
        code: "IMAGE_REMOVE_NOT_ALLOWED",
        message: "只能移除自己上传的图片，系统母版不可移除",
      })
    }
    await this.prisma.chetaidouImage.updateMany({
      where: { id: imageId, sourceType: "USER_UPLOAD", ownerId: userId, enabled: true },
      data: { enabled: false, revision: { increment: 1 } },
    })
    return { imageId, removed: true }
  }

  // ── 上传（F03） ─────────────────────────────────────────────────────────

  async uploadImage(
    userId: number,
    skuId: number,
    file: { buffer: Buffer },
    body: { idempotencyKey: string; title?: string }
  ): Promise<{ imageId: number; taskId: string }> {
    assertModuleEnabled()
    const sku = await this.requireSku(skuId)
    if (!sku.currentFactId) {
      throw new BadRequestException({
        message: "该 SKU 资料未就绪，暂不可上传",
        code: CHETAIDOU_ERROR_CODES.MODEL_NOT_READY,
      })
    }
    const asset = await this.storage.validateImage(file.buffer)
    const title = body.title?.trim() || `上传母版 ${new Date().toISOString().slice(0, 10)}`

    // 幂等：同 checksum+skuId+title+动作 的 hash 查已有任务
    const requestHash = stableHash({
      action: "upload",
      skuId,
      title,
      checksum: asset.checksum,
    })
    const existing = await this.prisma.chetaidouTask.findFirst({
      where: { ownerId: userId, idempotencyKey: body.idempotencyKey },
    })
    if (existing) {
      if (existing.requestHash !== requestHash) throw idempotencyConflict()
      return { imageId: existing.imageId, taskId: existing.id }
    }

    await this.context.resolveBreakdownModels()

    const scopeKey = this.storage.masterFileKey(skuId, `u${userId}`, "pending")
    // 临时 key 防并发重复上传覆盖；DB 成功后不 move（key 含随机段）
    const imageRef = randomUUID()
    const fileKey = scopeKey.replace("/pending", `/${imageRef}`)

    const thumbnailKey = await this.storage.uploadMaster(asset, fileKey)

    try {
      const created = await this.createBreakdownInTransaction({
        userId,
        skuId,
        sourceType: "USER_UPLOAD",
        ownerId: userId,
        title,
        fileKey,
        asset,
        factId: sku.currentFactId,
        idempotencyKey: body.idempotencyKey,
        requestHash,
        createdBy: userId,
        sourceMetadata: thumbnailKey ? { thumbnailKey } : undefined,
      })
      return created
    } catch (error) {
      // 存储成功但 DB 失败：补偿删除自己未被引用的对象
      await this.storage.deleteObject(fileKey).catch(() => undefined)
      if (thumbnailKey) await this.storage.deleteObject(thumbnailKey).catch(() => undefined)
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const retryRow = await this.prisma.chetaidouTask.findFirst({
          where: { ownerId: userId, idempotencyKey: body.idempotencyKey },
        })
        if (retryRow) {
          return { imageId: retryRow.imageId, taskId: retryRow.id }
        }
      }
      throw error
    }
  }

  /** 上传/重拆共用的「Image + BREAKDOWN Task + 初始草稿」创建事务 */
  async createBreakdownInTransaction(input: {
    userId: number
    skuId: number
    sourceType: "PRESET" | "USER_UPLOAD"
    ownerId: number | null
    title: string
    fileKey: string
    asset: { mime: string; width: number; height: number; checksum: string }
    factId: number
    idempotencyKey: string
    requestHash: string
    createdBy: number
    number?: string
    importKey?: string
    sourceMetadata?: unknown
    operation?: "PRIMARY" | "RETRY"
    retryOfTaskId?: string
  }): Promise<{ imageId: number; taskId: string }> {
    const snapshot = await this.context.buildSnapshot({
      image: {
        id: 0, // 占位：imageId 创建后回填（事务内）
        skuId: input.skuId,
        fileKey: input.fileKey,
        checksum: input.asset.checksum,
        width: input.asset.width,
        height: input.asset.height,
        mime: input.asset.mime,
      },
      fact: { id: 0, version: 0, content: {}, contentHash: "" }, // 事务内回填
      breakdown: null,
      settings: defaultSettings(),
      models: await this.context.resolveBreakdownModels(),
      resolvedSelections: [],
      customDimensions: [],
      decisions: [],
    })
    return this.prisma.$transaction(
      async tx => {
        const fact = await tx.chetaidouFactCard.findUnique({ where: { id: input.factId } })
        if (!fact) throw new BadRequestException("事实卡缺失")
        const image = await tx.chetaidouImage.create({
          data: {
            skuId: input.skuId,
            sourceType: input.sourceType,
            ownerId: input.ownerId,
            createdBy: input.createdBy,
            title: input.title,
            number: input.number,
            fileKey: input.fileKey,
            mime: input.asset.mime,
            width: input.asset.width,
            height: input.asset.height,
            checksum: input.asset.checksum,
            importKey: input.importKey,
            sourceMetadata: (input.sourceMetadata as object) ?? undefined,
          },
        })
        snapshot.image.id = image.id
        snapshot.facts = {
          id: fact.id,
          version: fact.version,
          content: fact.content,
          contentHash: fact.contentHash,
        }
        const taskId = randomUUID()
        const task = await tx.chetaidouTask.create({
          data: {
            id: taskId,
            rootTaskId: taskId,
            retryOfTaskId: input.retryOfTaskId,
            ownerId: input.userId,
            skuId: input.skuId,
            imageId: image.id,
            type: "BREAKDOWN",
            site: snapshot.settings.site,
            operation: input.operation ?? "PRIMARY",
            status: "QUEUED",
            stage: "排队中",
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            contextHash: this.context.contextHash("ideation", snapshot),
            snapshot: snapshot as unknown as object,
            input: { action: "breakdown" },
          },
        })
        await tx.chetaidouImage.update({
          where: { id: image.id },
          data: { activeBreakdownTaskId: taskId },
        })
        // 初始草稿（幂等：已存在则跳过）
        await tx.chetaidouDraft.upsert({
          where: { ownerId_imageId: { ownerId: input.userId, imageId: image.id } },
          create: {
            ownerId: input.userId,
            imageId: image.id,
            settings: defaultSettings() as unknown as object,
            selections: [],
            customDimensions: [],
          },
          update: {},
        })
        void task
        return { imageId: image.id, taskId }
      },
      { timeout: 45_000 }
    )
  }

  async retryBreakdown(userId: number, imageId: number, idempotencyKey: string) {
    assertModuleEnabled()
    const { image } = await this.requireAccessibleImage(userId, imageId, { requireOwnership: true })
    if (image.sourceType !== "USER_UPLOAD") {
      throw new BadRequestException("预置母版的重新拆解走管理接口")
    }
    if (image.activeBreakdownTaskId) {
      const active = await this.prisma.chetaidouTask.findUnique({
        where: { id: image.activeBreakdownTaskId },
      })
      if (active && ["QUEUED", "RUNNING", "WAITING_RECONCILIATION"].includes(active.status ?? "")) {
        throw new ConflictException({
          message: "该图已有拆解任务进行中",
          code: CHETAIDOU_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        })
      }
    }
    const requestHash = stableHash({ action: "breakdown-retry", imageId })
    const existing = await this.prisma.chetaidouTask.findFirst({
      where: { ownerId: userId, idempotencyKey },
    })
    if (existing) {
      if (existing.requestHash !== requestHash) throw idempotencyConflict()
      return { taskId: existing.id }
    }
    await this.context.resolveBreakdownModels()
    const { fact } = await this.requireAccessibleImage(userId, imageId)
    const taskId = randomUUID()
    const snapshot = await this.context.buildSnapshot({
      image: {
        id: image.id,
        skuId: image.skuId,
        fileKey: image.fileKey,
        checksum: image.checksum,
        width: image.width,
        height: image.height,
        mime: image.mime,
      },
      fact: {
        id: fact.id,
        version: fact.version,
        content: fact.content,
        contentHash: fact.contentHash,
      },
      breakdown: null,
      settings: {
        ...draftSettingsOf(
          await this.prisma.chetaidouDraft.findUnique({
            where: { ownerId_imageId: { ownerId: userId, imageId } },
          })
        ),
      },
      models: await this.context.resolveBreakdownModels(),
      resolvedSelections: [],
      customDimensions: [],
      decisions: [],
    })
    await this.prisma.$transaction(async tx => {
      await tx.chetaidouTask.create({
        data: {
          id: taskId,
          rootTaskId: taskId,
          ownerId: userId,
          skuId: image.skuId,
          imageId,
          type: "BREAKDOWN",
          site: snapshot.settings.site,
          status: "QUEUED",
          stage: "排队中",
          idempotencyKey: idempotencyKey,
          requestHash,
          contextHash: this.context.contextHash("ideation", snapshot),
          snapshot: snapshot as unknown as object,
          input: { action: "breakdown-retry" },
        },
      })
      const claimed = await tx.chetaidouImage.updateMany({
        where: { id: image.id, activeBreakdownTaskId: image.activeBreakdownTaskId },
        data: { activeBreakdownTaskId: taskId },
      })
      if (claimed.count === 0) throw new ConflictException("该图已有新的拆解任务，请勿重复提交")
    })
    return { taskId }
  }

  // ── 拆解确认 / 草稿 ────────────────────────────────────────────────────

  async acknowledge(userId: number, imageId: number, breakdownId: number, draftRevision?: number) {
    const { breakdown } = await this.requireAccessibleImage(userId, imageId)
    if (!breakdown || breakdown.id !== breakdownId) {
      throw new BadRequestException("拆解版本不存在或不是当前版本")
    }
    if (breakdown.qualityStatus !== "AI_UNREVIEWED") {
      throw new BadRequestException("仅 AI 未确认稿需要已读确认")
    }
    const updated = await this.prisma.chetaidouDraft.updateMany({
      where: {
        ownerId: userId,
        imageId,
        ...(draftRevision !== undefined ? { revision: draftRevision } : {}),
      },
      data: { acknowledgedBreakdownId: breakdownId },
    })
    if (updated.count === 0) throw settingsChanged()
    const draft = await this.requireDraft(userId, imageId)
    return { revision: draft.revision, acknowledgedBreakdownId: breakdownId }
  }

  async getDraft(userId: number, imageId: number) {
    await this.requireAccessibleImage(userId, imageId)
    const draft =
      (await this.prisma.chetaidouDraft.findUnique({
        where: { ownerId_imageId: { ownerId: userId, imageId } },
      })) ??
      (await this.prisma.chetaidouDraft.upsert({
        where: { ownerId_imageId: { ownerId: userId, imageId } },
        create: {
          ownerId: userId,
          imageId,
          settings: defaultSettings() as unknown as object,
          selections: [],
          customDimensions: [],
        },
        update: {},
      }))
    if (draft.workspaceId === null) {
      await this.prisma.chetaidouDraft.updateMany({
        where: { id: draft.id, revision: draft.revision, workspaceId: null },
        data: { workspaceId: randomUUID(), revision: { increment: 1 } },
      })
      return this.projectDraft(await this.requireDraft(userId, imageId))
    }
    return this.projectDraft(draft)
  }

  async resetDraft(
    userId: number,
    imageId: number,
    dto: { workspaceId: string; revision: number }
  ) {
    await this.requireAccessibleImage(userId, imageId)
    const before = await this.requireDraft(userId, imageId)
    assertWorkspace(before, dto.workspaceId, dto.revision)
    await this.prisma.$transaction(async tx => {
      await lockAdjustmentDraft(tx, before)
      const changed = await tx.chetaidouDraft.updateMany({
        where: { id: before.id, workspaceId: dto.workspaceId, revision: dto.revision },
        data: {
          workspaceId: randomUUID(),
          activeAdjustmentId: null,
          restoredFromAdjustmentId: null,
          settings: defaultSettings() as unknown as Prisma.InputJsonValue,
          selections: [],
          customDimensions: [],
          activeGroupRefs: [],
          activeIdeationTaskId: null,
          activeCompositionTaskId: null,
          pendingRefreshTaskId: null,
          revision: { increment: 1 },
        },
      })
      if (!changed.count) throw workspaceChanged()
    })
    return this.projectDraft(await this.requireDraft(userId, imageId))
  }

  async listAdjustments(
    userId: number,
    imageId: number,
    query: { page: number; pageSize: number }
  ) {
    await this.requireAccessibleImage(userId, imageId)
    const where = { ownerId: userId, imageId }
    const [total, items] = await this.prisma.$transaction([
      this.prisma.chetaidouAdjustment.count({ where }),
      this.prisma.chetaidouAdjustment.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ])
    return { total, page: query.page, pageSize: query.pageSize, items }
  }

  async getAdjustment(userId: number, imageId: number, id: string) {
    await this.requireAccessibleImage(userId, imageId)
    const record = await ownedAdjustment(this.prisma, userId, imageId, id)
    const tasks = await this.prisma.chetaidouTask.findMany({
      where: { ownerId: userId, imageId, adjustmentId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })
    const batch = await this.batchProjectContext(tasks)
    return { ...record, tasks: await Promise.all(tasks.map(t => this.projectTask(t, batch))) }
  }

  async restoreAdjustment(
    userId: number,
    imageId: number,
    id: string,
    dto: { workspaceId: string; revision: number }
  ) {
    const { sku } = await this.requireAccessibleImage(userId, imageId)
    const before = await this.requireDraft(userId, imageId)
    assertWorkspace(before, dto.workspaceId, dto.revision)
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ChetaidouAdjustment WHERE id = ${id} FOR UPDATE`
      const record = await ownedAdjustment(tx, userId, imageId, id)
      if (record.skuId !== sku.id) throw new NotFoundException("调整记录不存在")
      await tx.$queryRaw`SELECT id FROM ChetaidouDraft WHERE id = ${before.id} FOR UPDATE`
      const state = record.state as unknown as ReturnType<typeof adjustmentState>
      const executed =
        !!state.activeIdeationTaskId ||
        !!state.activeCompositionTaskId ||
        !!(await tx.chetaidouTask.findFirst({
          where: { adjustmentId: id, type: { in: ["IDEATION", "COMPOSE"] } },
          select: { id: true },
        }))
      const { facts, breakdown, ...content } = state
      void facts
      void breakdown
      const updated = await tx.chetaidouDraft.updateMany({
        where: { id: before.id, workspaceId: dto.workspaceId, revision: dto.revision },
        data: {
          ...content,
          workspaceId: randomUUID(),
          activeAdjustmentId: executed ? null : id,
          restoredFromAdjustmentId: executed ? id : null,
          revision: { increment: 1 },
        } as Prisma.ChetaidouDraftUpdateManyMutationInput,
      })
      if (!updated.count) throw workspaceChanged()
    })
    return this.projectDraft(await this.requireDraft(userId, imageId))
  }

  async putDraft(
    userId: number,
    imageId: number,
    dto: {
      revision: number
      workspaceId?: string
      settings: ChetaidouSettings
      selections: SelectionRefDto[]
      customDimensions: unknown[]
    }
  ) {
    const { sku, fact, breakdown } = await this.requireAccessibleImage(userId, imageId)
    validateSettings(
      dto.settings,
      (breakdown?.payload as unknown as ChetaidouBreakdownPayload) ?? null
    )
    validateCustomDimensions(dto.customDimensions as CustomDimensionInput[])
    const before = await this.requireDraft(userId, imageId)
    assertWorkspace(before, dto.workspaceId, dto.revision)
    const dimensions = normalizeCustomDimensions(
      dto.customDimensions as CustomDimensionInput[],
      before.customDimensions as unknown as CustomDimensionInput[]
    )
    const requirementsChanged =
      stableHash(contentSettingsOf(dto.settings)) !==
      stableHash(contentSettingsOf(before.settings as unknown as ChetaidouSettings))
    const changed =
      requirementsChanged ||
      stableHash({
        selections: dto.selections,
        customDimensions: dimensions,
      }) !==
        stableHash({
          selections: before.selections,
          customDimensions: before.customDimensions,
        })
    const save = async (tx: Prisma.TransactionClient) => {
      if (before.workspaceId) await lockAdjustmentDraft(tx, before)
      const createHistory =
        !!before.workspaceId &&
        requirementsChanged &&
        (!before.activeAdjustmentId ||
          !!before.activeIdeationTaskId ||
          !!before.activeCompositionTaskId ||
          !!(await tx.chetaidouTask.findFirst({
            where: {
              adjustmentId: before.activeAdjustmentId,
              type: { in: ["IDEATION", "COMPOSE"] },
            },
            select: { id: true },
          })))
      // 已组织记录的选择先留在工作副本，重新组织时再分叉，原记录保留原选择。
      const detachSelections =
        !!before.workspaceId &&
        !requirementsChanged &&
        changed &&
        !!before.activeAdjustmentId &&
        (!!before.activeCompositionTaskId ||
          !!(await tx.chetaidouTask.findFirst({
            where: { adjustmentId: before.activeAdjustmentId, type: "COMPOSE" },
            select: { id: true },
          })))
      const result = await tx.chetaidouDraft.updateMany({
        where: {
          ownerId: userId,
          imageId,
          revision: dto.revision,
          ...(dto.workspaceId ? { workspaceId: dto.workspaceId } : {}),
        },
        data: {
          settings: dto.settings as unknown as object,
          selections: dto.selections as unknown as object,
          customDimensions: dimensions as unknown as object,
          // 影响结果的草稿变更 → 旧组合失效（方案 §7.4）
          ...(changed ? { activeCompositionTaskId: null } : {}),
          ...(before.workspaceId && requirementsChanged
            ? {
                activeIdeationTaskId: null,
                pendingRefreshTaskId: null,
                ...(!createHistory ? { workspaceId: randomUUID() } : {}),
              }
            : {}),
          ...(detachSelections
            ? {
                workspaceId: randomUUID(),
                activeAdjustmentId: null,
                restoredFromAdjustmentId: before.activeAdjustmentId,
                pendingRefreshTaskId: null,
              }
            : {}),
          revision: { increment: 1 },
        },
      })
      if (result.count && createHistory) {
        const after = await tx.chetaidouDraft.findUniqueOrThrow({ where: { id: before.id } })
        await forkAdjustment(
          tx,
          after,
          adjustmentState(after, {
            facts: factSnapshotOf(fact),
            breakdown: breakdownSnapshotOf(breakdown),
          }),
          sku.id
        )
      } else if (
        result.count &&
        !detachSelections &&
        before.activeAdjustmentId &&
        !before.restoredFromAdjustmentId
      )
        await saveDraftAdjustment(tx, before.id)
      return result
    }
    const updated = before.workspaceId
      ? await this.prisma.$transaction(save)
      : await save(this.prisma)
    if (updated.count === 0) {
      const current = await this.requireDraft(userId, imageId)
      throw new ConflictException({
        message: "草稿已被其他操作更新，请刷新后重试",
        code: CHETAIDOU_ERROR_CODES.SETTINGS_CHANGED,
        details: {
          retryable: false,
          currentRevision: current.revision,
          currentDraft: await this.projectDraft(current),
        },
      })
    }
    const draft = await this.requireDraft(userId, imageId)
    return this.projectDraft(draft)
  }

  private async projectDraft(draft: DraftRow) {
    const refs = (draft.activeGroupRefs as { groupId: string }[] | null) ?? []
    const groups =
      draft.workspaceId && refs.length
        ? await this.prisma.chetaidouGroup.findMany({
            where: { id: { in: refs.map(ref => ref.groupId) } },
          })
        : []
    return {
      ideationStale: false,
      staleReason: null,
      revision: draft.revision,
      workspaceId: draft.workspaceId,
      activeAdjustmentId: draft.activeAdjustmentId,
      restoredFromAdjustmentId: draft.restoredFromAdjustmentId,
      settings: draft.settings,
      selections: draft.selections,
      customDimensions: draft.customDimensions as unknown as object,
      acknowledgedBreakdownId: draft.acknowledgedBreakdownId,
      activeIdeationTaskId: draft.activeIdeationTaskId,
      activeCompositionTaskId: draft.activeCompositionTaskId,
      activeGroupRefs: draft.activeGroupRefs ?? [],
      activeGroups: refs.flatMap(ref => {
        const group = groups.find(row => row.id === ref.groupId)
        return group
          ? [
              {
                groupId: group.id,
                producerTaskId: group.taskId,
                key: group.key,
                status: group.status,
              },
            ]
          : []
      }),
      pendingRefreshTaskId: draft.pendingRefreshTaskId,
    }
  }

  private async taskContextCurrent(
    task: TaskRow,
    draft: DraftRow,
    stage: "ideation" | "compose"
  ): Promise<boolean> {
    const snapshot = task.snapshot as unknown as TaskSnapshot
    try {
      const { image, fact, breakdown } = await this.requireAccessibleImage(
        task.ownerId,
        task.imageId
      )
      const current: TaskSnapshot = {
        ...snapshot,
        image: imageSnapshotOf(image),
        facts: factSnapshotOf(fact),
        breakdown: breakdownSnapshotOf(breakdown),
        settings: draftSettingsOf(draft),
        customDimensions: draft.customDimensions as unknown as unknown[],
      }
      if (stage === "compose")
        current.resolvedSelections = (
          await this.resolveSelections(
            task.ownerId,
            task.imageId,
            draft,
            current.breakdown?.payload ?? null
          )
        ).selections
      return this.context.contextHash(stage, snapshot) === this.context.contextHash(stage, current)
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) return false
      throw error
    }
  }

  // ── 任务创建 ────────────────────────────────────────────────────────────

  async createTask(userId: number, dto: CreateTaskDto) {
    assertModuleEnabled()
    if (
      dto.type !== "GENERATE" &&
      [
        dto.aspectRatio,
        dto.resolutionTier,
        dto.customAspectW,
        dto.customAspectH,
        dto.quality,
        dto.imageModel,
      ].some(value => value !== undefined)
    ) {
      throw new BadRequestException({
        code: "IMAGE_GENERATION_PARAM_INVALID",
        message: "比例、尺寸与质量参数仅可用于 GENERATE 任务",
      })
    }
    const requestHash = this.context.requestHash({
      type: dto.type,
      imageId: dto.imageId,
      groupId: dto.groupId,
      customDimensionId: dto.customDimensionId,
      compositionTaskId: dto.compositionTaskId,
      count: dto.count,
      allowPartialIdeation: dto.allowPartialIdeation,
      ...(dto.workspaceId
        ? { workspaceId: dto.workspaceId, draftRevision: dto.draftRevision }
        : {}),
      ...(dto.imageModel !== undefined ? { imageModel: dto.imageModel.trim() } : {}),
      ...(dto.type === "GENERATE" ? imageSelectionHashFields(dto) : {}),
    })
    const existing = await this.prisma.chetaidouTask.findFirst({
      where: { ownerId: userId, idempotencyKey: dto.idempotencyKey },
    })
    if (existing) {
      if (existing.requestHash !== requestHash) throw idempotencyConflict()
      return this.getTask(userId, existing.id)
    }
    try {
      const currentDraft = await this.requireDraft(userId, dto.imageId)
      assertWorkspace(currentDraft, dto.workspaceId, dto.draftRevision)
      switch (dto.type) {
        case "IDEATION":
          return await this.createIdeation(userId, dto, requestHash)
        case "REFRESH_GROUP":
          return await this.createRefreshGroup(userId, dto, requestHash)
        case "DIVERGE":
          return await this.createDiverge(userId, dto, requestHash)
        case "COMPOSE":
          return await this.createCompose(userId, dto, requestHash)
        case "GENERATE":
          return await this.createGenerate(userId, dto, requestHash)
        default:
          throw new BadRequestException("未知任务类型")
      }
    } catch (error) {
      if (
        error instanceof ConflictException ||
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      ) {
        const saved = await this.prisma.chetaidouTask.findFirst({
          where: { ownerId: userId, idempotencyKey: dto.idempotencyKey },
        })
        if (saved) {
          if (saved.requestHash !== requestHash) throw idempotencyConflict()
          return this.getTask(userId, saved.id)
        }
      }
      throw error
    }
  }

  private async createIdeation(userId: number, dto: CreateTaskDto, requestHash: string) {
    const { sku, fact, image, breakdown } = await this.requireIdeationReady(userId, dto.imageId)
    const draft = await this.requireDraft(userId, dto.imageId)
    const settings = draftSettingsOf(draft)
    validateSettings(settings, breakdown?.payload as unknown as ChetaidouBreakdownPayload | null)
    await this.billing.assertModelsReady()

    const snapshot = await this.context.buildSnapshot({
      image: imageSnapshotOf(image),
      fact: factSnapshotOf(fact),
      breakdown: breakdownSnapshotOf(breakdown),
      settings,
      resolvedSelections: [],
      customDimensions: draft.customDimensions,
      decisions: [],
    })
    const taskId = randomUUID()
    const created = await this.prisma.$transaction(
      async tx => {
        const binding = await prepareAdjustment(tx, draft, snapshot, "IDEATION")
        snapshot.workflow = binding
        await tx.chetaidouTask.create({
          data: {
            ...binding,
            site: snapshot.settings.site,
            id: taskId,
            rootTaskId: taskId,
            ownerId: userId,
            skuId: sku.id,
            imageId: image.id,
            type: "IDEATION",
            status: "QUEUED",
            stage: "排队中",
            idempotencyKey: dto.idempotencyKey,
            requestHash,
            contextHash: this.context.contextHash("ideation", snapshot),
            snapshot: snapshot as unknown as object,
            input: { type: "IDEATION", allowPartialIdeation: dto.allowPartialIdeation ?? false },
          },
        })
        const updated = await tx.chetaidouDraft.updateMany({
          where: { id: draft.id, revision: dto.draftRevision ?? draft.revision },
          data: {
            activeIdeationTaskId: taskId,
            activeGroupRefs: [],
            selections: [],
            activeCompositionTaskId: null,
            pendingRefreshTaskId: null,
            revision: { increment: 1 },
          },
        })
        if (updated.count === 0) throw settingsChanged()
        const after = await tx.chetaidouDraft.findUniqueOrThrow({ where: { id: draft.id } })
        await tx.chetaidouTask.update({
          where: { id: taskId },
          data: { acceptedDraftRevision: after.revision },
        })
        if (binding.adjustmentId) await saveDraftAdjustment(tx, draft.id, snapshot)
        return taskId
      },
      { timeout: 45_000 }
    )
    return { taskId: created, status: "QUEUED" as const }
  }

  private async requireIdeationReady(userId: number, imageId: number) {
    const ctx = await this.requireAccessibleImage(userId, imageId)
    const { sku, image, breakdown } = ctx
    if (!breakdown) {
      throw new BadRequestException({
        message: "该母版还没有可用拆解",
        code: CHETAIDOU_ERROR_CODES.BREAKDOWN_UNCONFIRMED,
      })
    }
    if (breakdown.qualityStatus === "INVALID") {
      throw new BadRequestException({
        message: "当前拆解已失效，请等待重新准备",
        code: CHETAIDOU_ERROR_CODES.BREAKDOWN_UNCONFIRMED,
      })
    }
    return { ...ctx, sku, image, breakdown }
  }

  private async createRefreshGroup(userId: number, dto: CreateTaskDto, requestHash: string) {
    const { fact, image, breakdown } = await this.requireIdeationReady(userId, dto.imageId)
    if (!dto.groupId) throw new BadRequestException("REFRESH_GROUP 需要 groupId")
    const draft = await this.requireDraft(userId, dto.imageId)
    if (draft.pendingRefreshTaskId) {
      const pending = await this.prisma.chetaidouTask.findUnique({
        where: { id: draft.pendingRefreshTaskId },
      })
      if (pending && ["QUEUED", "RUNNING"].includes(pending.status ?? "")) {
        throw new ConflictException({
          message: "该草稿已有进行中的维度刷新",
          code: CHETAIDOU_ERROR_CODES.IDEMPOTENCY_CONFLICT,
        })
      }
    }
    const refs = (draft.activeGroupRefs as { groupId: string }[]) ?? []
    if (!refs.some(r => r.groupId === dto.groupId)) {
      throw new BadRequestException("目标维度不在当前有效联想中")
    }
    const oldGroup = await this.prisma.chetaidouGroup.findUnique({ where: { id: dto.groupId } })
    if (!oldGroup || oldGroup.status !== "SUCCEEDED") {
      throw new BadRequestException("仅成功维度可刷新")
    }
    await this.billing.assertModelsReady()

    // 冻结刷新上下文：保留选择 + 历史去重样本
    const selections = (draft.selections as unknown as SelectionRefDto[]) ?? []
    const selForGroup = selections.find(s => s.groupId === dto.groupId)
    const oldOptions = (oldGroup.options as unknown as ChetaidouOption[]) ?? []
    const retained = oldOptions.filter(o => selForGroup?.optionKeys.includes(o.key))
    // 同组谱系历史选项（parentGroupId 链）
    const historyOptions = await this.collectGroupHistory(oldGroup)
    const definition = {
      ...(oldGroup.definition as unknown as ChetaidouGroupDefinition),
      selectionMode: "single",
    }
    const settings = draftSettingsOf(draft)
    validateSettings(settings, breakdown?.payload as unknown as ChetaidouBreakdownPayload | null)

    const snapshot = await this.context.buildSnapshot({
      image: imageSnapshotOf(image),
      fact: factSnapshotOf(fact),
      breakdown: breakdownSnapshotOf(breakdown),
      settings,
      resolvedSelections: [],
      customDimensions: draft.customDimensions,
      activeGroupRefs: refs,
      refresh: {
        parentGroupId: oldGroup.id,
        definition,
        retainedOptions: retained,
        history: historyOptions,
        sourceIdeationTaskId: draft.activeIdeationTaskId ?? oldGroup.taskId,
      },
      decisions: [],
    })
    const taskId = randomUUID()
    const created = await this.prisma.$transaction(
      async tx => {
        const binding = await prepareAdjustment(tx, draft, snapshot, "REFRESH_GROUP")
        snapshot.workflow = binding
        const newGroup = await tx.chetaidouGroup.create({
          data: {
            id: randomUUID(),
            taskId,
            parentGroupId: oldGroup.id,
            key: oldGroup.key,
            definition,
            status: "PENDING",
            order: oldGroup.order,
          },
        })
        await tx.chetaidouTask.create({
          data: {
            ...binding,
            site: snapshot.settings.site,
            id: taskId,
            rootTaskId: taskId,
            ownerId: userId,
            skuId: image.skuId,
            imageId: image.id,
            type: "REFRESH_GROUP",
            status: "QUEUED",
            stage: "排队中",
            idempotencyKey: dto.idempotencyKey,
            requestHash,
            contextHash: this.context.contextHash("refresh", snapshot),
            snapshot: snapshot as unknown as object,
            input: { type: "REFRESH_GROUP", groupId: dto.groupId },
          },
        })
        const updated = await tx.chetaidouDraft.updateMany({
          where: {
            id: draft.id,
            revision: dto.draftRevision ?? draft.revision,
            pendingRefreshTaskId: null,
          },
          data: {
            pendingRefreshTaskId: taskId,
            activeCompositionTaskId: null,
            revision: { increment: 1 },
          },
        })
        if (updated.count === 0) throw settingsChanged()
        const after = await tx.chetaidouDraft.findUniqueOrThrow({ where: { id: draft.id } })
        await tx.chetaidouTask.update({
          where: { id: taskId },
          data: { acceptedDraftRevision: after.revision },
        })
        void newGroup
        if (binding.adjustmentId) await saveDraftAdjustment(tx, draft.id)
        return taskId
      },
      { timeout: 45_000 }
    )
    return { taskId: created, status: "QUEUED" as const, acceptedDraftRevision: undefined }
  }

  private async collectGroupHistory(group: GroupRow): Promise<ChetaidouOption[]> {
    const chain: ChetaidouOption[] = []
    let current: GroupRow | null = group
    const guard = new Set<string>()
    while (current && !guard.has(current.id)) {
      guard.add(current.id)
      chain.push(...((current.options as unknown as ChetaidouOption[]) ?? []))
      if (!current.parentGroupId) break
      current = await this.prisma.chetaidouGroup.findUnique({
        where: { id: current.parentGroupId },
      })
    }
    return chain
  }

  private async createDiverge(userId: number, dto: CreateTaskDto, requestHash: string) {
    const { fact, image, breakdown } = await this.requireIdeationReady(userId, dto.imageId)
    if (!dto.customDimensionId) throw new BadRequestException("DIVERGE 需要 customDimensionId")
    const draft = await this.requireDraft(userId, dto.imageId)
    const dims = (draft.customDimensions as unknown as CustomDimensionInput[]) ?? []
    const target = dims.find(d => d.id === dto.customDimensionId)
    if (!target) throw new BadRequestException("自建维度不存在")
    const settings = draftSettingsOf(draft)
    validateSettings(settings, breakdown?.payload as unknown as ChetaidouBreakdownPayload | null)
    await this.billing.assertModelsReady()

    const snapshot = await this.context.buildSnapshot({
      image: imageSnapshotOf(image),
      fact: factSnapshotOf(fact),
      breakdown: breakdownSnapshotOf(breakdown),
      settings,
      resolvedSelections: [],
      customDimensions: dims,
      decisions: [],
    })
    const past = await this.prisma.chetaidouTask.findMany({
      where: { ownerId: userId, imageId: image.id, type: "DIVERGE" },
      select: { input: true, output: true },
    })
    const history = past
      .filter(t => (t.input as { customDimensionId?: string }).customDimensionId === target.id)
      .flatMap(t => (t.output as { newOptions?: ChetaidouOption[] } | null)?.newOptions ?? [])
    const taskId = randomUUID()
    if (dto.draftRevision !== undefined && dto.draftRevision !== draft.revision)
      throw settingsChanged()
    await this.prisma.$transaction(async tx => {
      const binding = await prepareAdjustment(tx, draft, snapshot, "DIVERGE")
      snapshot.workflow = binding
      await tx.chetaidouTask.create({
        data: {
          ...binding,
          site: snapshot.settings.site,
          id: taskId,
          rootTaskId: taskId,
          ownerId: userId,
          skuId: image.skuId,
          imageId: image.id,
          type: "DIVERGE",
          status: "QUEUED",
          stage: "排队中",
          idempotencyKey: dto.idempotencyKey,
          requestHash,
          contextHash: this.context.contextHash("diverge", snapshot),
          snapshot: snapshot as unknown as object,
          input: {
            type: "DIVERGE",
            customDimensionId: dto.customDimensionId,
            sourceCompositionTaskId: draft.activeCompositionTaskId ?? null,
            history: history as unknown as Prisma.InputJsonValue,
          },
          acceptedDraftRevision: dto.draftRevision ?? draft.revision,
        },
      })
      if (binding.adjustmentId) await saveDraftAdjustment(tx, draft.id)
    })
    return { taskId, status: "QUEUED" as const }
  }

  private async createCompose(userId: number, dto: CreateTaskDto, requestHash: string) {
    const { sku, fact, image, breakdown } = await this.requireIdeationReady(userId, dto.imageId)
    const draft = await this.requireDraft(userId, dto.imageId)
    const settings = draftSettingsOf(draft)
    validateSettings(settings, breakdown?.payload as unknown as ChetaidouBreakdownPayload | null)

    // 解析真实选择（服务端不信客户端文本）
    const resolved = await this.resolveSelections(
      userId,
      image.id,
      draft,
      breakdown?.payload as unknown as ChetaidouBreakdownPayload | null
    )

    // 继承上一组合的有效决策（answers 语义）
    const decisions = await this.inheritDecisions(draft, resolved)

    await this.billing.assertModelsReady()

    const snapshot = await this.context.buildSnapshot({
      image: imageSnapshotOf(image),
      fact: factSnapshotOf(fact),
      breakdown: breakdownSnapshotOf(breakdown),
      settings,
      resolvedSelections: resolved.selections,
      customDimensions: draft.customDimensions,
      activeGroupRefs: (draft.activeGroupRefs as unknown as { groupId: string }[]) ?? [],
      decisions,
    })
    const taskId = randomUUID()
    await this.prisma.$transaction(async tx => {
      const binding = await prepareAdjustment(tx, draft, snapshot, "COMPOSE")
      snapshot.workflow = binding
      await tx.chetaidouTask.create({
        data: {
          ...binding,
          site: snapshot.settings.site,
          id: taskId,
          rootTaskId: taskId,
          ownerId: userId,
          skuId: sku.id,
          imageId: image.id,
          type: "COMPOSE",
          status: "QUEUED",
          stage: "排队中",
          idempotencyKey: dto.idempotencyKey,
          requestHash,
          contextHash: this.context.contextHash("compose", snapshot),
          snapshot: snapshot as unknown as object,
          input: { type: "COMPOSE", allowPartialIdeation: dto.allowPartialIdeation ?? false },
        },
      })
      const claimed = await tx.chetaidouDraft.updateMany({
        where: {
          id: draft.id,
          revision: dto.draftRevision ?? draft.revision,
          activeCompositionTaskId: draft.activeCompositionTaskId,
        },
        data: { activeCompositionTaskId: taskId, revision: { increment: 1 } },
      })
      if (!claimed.count) throw settingsChanged()
      if (binding.adjustmentId) await saveDraftAdjustment(tx, draft.id, snapshot)
    })
    return { taskId, status: "QUEUED" as const, acceptedDraftRevision: draft.revision + 1 }
  }

  /** 从草稿 selections + customDimensions 解析出服务端验证的完整选择清单 */
  async resolveSelections(
    userId: number,
    imageId: number,
    draft: DraftRow,
    breakdown: ChetaidouBreakdownPayload | null
  ) {
    const refs = (draft.activeGroupRefs as { groupId: string }[]) ?? []
    const refIds = new Set(refs.map(r => r.groupId))
    const groups = await this.prisma.chetaidouGroup.findMany({
      where: { id: { in: [...refIds] } },
    })
    const sourceIds = [...new Set(groups.map(g => g.taskId))]
    const sources =
      draft.workspaceId && sourceIds.length
        ? await this.prisma.chetaidouTask.findMany({
            where: { id: { in: sourceIds }, ownerId: userId, imageId },
            select: { id: true },
          })
        : []
    const allowed = new Set(sources.map(t => t.id))
    if (draft.workspaceId && groups.some(g => !allowed.has(g.taskId)))
      throw new BadRequestException("维度不属于当前用户或母版")
    const groupById = new Map(groups.map(g => [g.id, g]))
    const selections: Record<string, unknown>[] = []

    for (const sel of (draft.selections as unknown as SelectionRefDto[]) ?? []) {
      const group = groupById.get(sel.groupId)
      if (!group) {
        throw new BadRequestException({
          message: "选择引用了不在当前有效联想中的维度，请刷新页面重新选择",
          code: CHETAIDOU_ERROR_CODES.SETTINGS_CHANGED,
        })
      }
      if (draft.workspaceId && group.status !== "SUCCEEDED")
        throw new BadRequestException("维度尚未成功，不可使用")
      const definition = group.definition as unknown as ChetaidouGroupDefinition
      const options = (group.options as unknown as ChetaidouOption[]) ?? []
      if (sel.optionKeys.some(key => !options.some(o => o.key === key)))
        throw new BadRequestException("所选方案不存在")
      const selected = options.filter(o => sel.optionKeys.includes(o.key))
      // 自动联想维度（含历史记录）统一单选。
      if (selected.length + (sel.customText?.trim() ? 1 : 0) > 1) {
        throw new BadRequestException(`维度「${definition.label}」是单选，不可选择多项`)
      }
      for (const opt of selected) {
        if (opt.requiresEvidence) {
          throw new BadRequestException({
            message: `选项「${opt.label}」需要补充证据，当前不可选用`,
            code: CHETAIDOU_ERROR_CODES.INVALID_INPUT,
          })
        }
        selections.push({
          selectionId: opt.selectionId,
          groupId: group.id,
          groupKey: definition.key,
          optionKey: opt.key,
          origin: opt.origin ?? "AI",
          label: opt.label,
          changeInstruction: opt.changeInstruction,
          preserveInstruction: opt.preserveInstruction,
          kind: definition.kind,
          purpose: definition.purpose,
          targetText: opt.targetText,
          targetLocale: opt.targetLocale,
          meaningCn: opt.meaningCn,
        })
      }
      if (sel.customText?.trim()) {
        selections.push({
          selectionId: `${group.id}:custom`,
          groupId: group.id,
          groupKey: definition.key,
          optionKey: "__custom__",
          origin: "USER",
          label: sel.customText.trim(),
          changeInstruction: sel.customText.trim(),
          kind: definition.kind,
        })
      }
    }

    // 自建维度的手写选择
    for (const dim of (draft.customDimensions as unknown as CustomDimensionInput[]) ?? []) {
      const selectedKeys = new Set(dim.selectedKeys ?? [])
      if (definition_isSingle(dim) && selectedKeys.size > 1) {
        throw new BadRequestException(`自建维度「${dim.label}」是单选，不可选择多项`)
      }
      for (const opt of dim.options ?? []) {
        if (!selectedKeys.has(opt.key ?? opt.text)) continue
        selections.push({
          selectionId: `${dim.id}:${opt.key ?? opt.text}`,
          groupId: dim.id,
          groupKey: dim.id,
          optionKey: opt.key ?? opt.text,
          origin: opt.origin ?? "USER",
          label: opt.text,
          changeInstruction: opt.text,
          kind: "visual",
        })
      }
    }
    void breakdown
    return { selections }
  }

  /** 问答后创建新 COMPOSE（parentTaskId 指向被回答的旧根任务） */
  async submitAnswers(
    userId: number,
    compositionTaskId: string,
    dto: {
      idempotencyKey: string
      draftRevision: number
      workspaceId?: string
      answers: { conflictId: string; questionVersion: number; choiceId?: string; text?: string }[]
    }
  ) {
    assertModuleEnabled()
    const requestHash = this.context.requestHash({
      action: "answers",
      compositionTaskId,
      answers: dto.answers,
      ...(dto.workspaceId
        ? { workspaceId: dto.workspaceId, draftRevision: dto.draftRevision }
        : {}),
    })
    const existing = await this.prisma.chetaidouTask.findFirst({
      where: { ownerId: userId, idempotencyKey: dto.idempotencyKey },
    })
    if (existing) {
      if (existing.requestHash !== requestHash) throw idempotencyConflict()
      return { taskId: existing.id }
    }

    try {
      const parent = await this.requireOwnedTask(userId, compositionTaskId)
      if (parent.type !== "COMPOSE" || parent.rootTaskId !== parent.id) {
        throw new BadRequestException("该任务不是组合根任务")
      }
      const parentOutput = parent.output as unknown as ChetaidouComposeOutput | null
      if (!parentOutput || parentOutput.status !== "NEEDS_RESOLUTION") {
        throw new BadRequestException("该组合不在待回答状态")
      }
      const draft = await this.requireDraft(userId, parent.imageId)
      assertWorkspace(draft, dto.workspaceId, dto.draftRevision)
      if (draft.activeCompositionTaskId !== parent.id) {
        throw new ConflictException({
          message: "当前组合已变化，请基于最新组合回答",
          code: CHETAIDOU_ERROR_CODES.SETTINGS_CHANGED,
        })
      }
      if (!(await this.taskContextCurrent(parent, draft, "compose"))) throw settingsChanged()
      if (new Set(dto.answers.map(a => a.conflictId)).size !== dto.answers.length)
        throw new BadRequestException("同一问题不可重复作答")
      // 校验答案：全部非阻断问题都有且仅有一个答案；阻断问题拒绝提交
      const conflicts = parentOutput.conflicts ?? []
      if (conflicts.some(c => c.blocking)) {
        throw new BadRequestException("该组合存在阻断问题，请先调整选择或核实资料")
      }
      const answered = new Map(dto.answers.map(a => [a.conflictId, a]))
      for (const c of conflicts) {
        if (c.blocking) {
          if (answered.has(c.id)) {
            throw new BadRequestException(`问题 ${c.id} 为阻断问题，不可作答（需调整选择）`)
          }
          continue
        }
        const a = answered.get(c.id)
        if (!a) throw new BadRequestException(`问题 ${c.id} 缺少答案（需一次提交全部答案）`)
        if (a.questionVersion !== (c.questionVersion ?? 1)) {
          throw new ConflictException({
            message: "问题版本已变化，请重新加载",
            code: CHETAIDOU_ERROR_CODES.SOURCE_VERSION_CHANGED,
          })
        }
        if (!a.choiceId && !a.text?.trim()) {
          throw new BadRequestException(`问题 ${c.id} 的答案需要选项或文字`)
        }
        if (a.choiceId) {
          const choiceValid = (c.choices ?? []).some(ch => ch.id === a.choiceId)
          if (!choiceValid) throw new BadRequestException(`问题 ${c.id} 的选项不存在`)
        }
      }
      for (const a of dto.answers) {
        if (!conflicts.some(c => c.id === a.conflictId)) {
          throw new BadRequestException(`答案 ${a.conflictId} 不属于当前组合问题`)
        }
      }

      // 合并决策：仅原问题及作用范围一致时替换；模型可能在新问题上复用同名 ID。
      const previousDecisions = (parentOutput.decisions as unknown as EffectiveDecisionRow[]) ?? []
      const answeredScopes = new Set(
        conflicts
          .filter(c => answered.has(c.id))
          .map(c => compositionScopeKey(c.question, c.sources))
      )
      const newDecisions: EffectiveDecisionRow[] = previousDecisions.filter(d => {
        const original = d.originalConflict as { question?: string; sources?: string[] } | undefined
        const scope = compositionScopeKey(
          original?.question ?? d.question,
          original?.sources ?? d.sources
        )
        return !scope || !answeredScopes.has(scope)
      })
      for (const c of conflicts) {
        const a = answered.get(c.id)
        if (!a || c.blocking) continue
        newDecisions.push({
          decisionId: randomUUID(),
          compositionTaskId: parent.id,
          conflictId: c.id,
          questionVersion: a.questionVersion,
          sources: c.sources,
          question: c.question,
          scopeKey: compositionScopeKey(c.question, c.sources)!,
          choiceId: a.choiceId,
          instruction: c.choices.find(choice => choice.id === a.choiceId)?.instruction,
          originalConflict: c,
          customText: a.text?.trim() || undefined,
        })
      }

      // 冻结新 COMPOSE 快照：以 parent 快照为基础叠加新决策
      const parentSnapshot = parent.snapshot as unknown as TaskSnapshot
      const snapshot: TaskSnapshot = {
        ...parentSnapshot,
        decisions: newDecisions,
        prompt: parentSnapshot.prompt, // 模板随原快照
      }
      await this.billing.assertModelsReady(snapshot.models)

      const taskId = randomUUID()
      await this.prisma.$transaction(async tx => {
        // 冲突问答延续本轮，区别于用户主动重新组织。
        const binding = await prepareAdjustment(tx, draft, snapshot, "ANSWERS")
        snapshot.workflow = binding
        await tx.chetaidouTask.create({
          data: {
            ...binding,
            site: snapshot.settings.site,
            id: taskId,
            rootTaskId: taskId,
            parentTaskId: parent.id,
            ownerId: userId,
            skuId: parent.skuId,
            imageId: parent.imageId,
            type: "COMPOSE",
            status: "QUEUED",
            stage: "排队中",
            idempotencyKey: dto.idempotencyKey,
            requestHash,
            contextHash: this.context.contextHash("compose", snapshot),
            snapshot: snapshot as unknown as object,
            input: { type: "COMPOSE", answers: dto.answers },
          },
        })
        // 草稿指针指向新组合任务（旧组合保留只读）
        const updated = await tx.chetaidouDraft.updateMany({
          where: {
            id: draft.id,
            revision: dto.draftRevision,
            activeCompositionTaskId: parent.id,
          },
          data: { activeCompositionTaskId: taskId, revision: { increment: 1 } },
        })
        if (updated.count === 0) throw settingsChanged()
        if (binding.adjustmentId) await saveDraftAdjustment(tx, draft.id)
      })
      return { taskId, acceptedDraftRevision: draft.revision + 1 }
    } catch (error) {
      if (
        error instanceof ConflictException ||
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      ) {
        const saved = await this.prisma.chetaidouTask.findFirst({
          where: { ownerId: userId, idempotencyKey: dto.idempotencyKey },
        })
        if (saved) {
          if (saved.requestHash !== requestHash) throw idempotencyConflict()
          return { taskId: saved.id }
        }
      }
      throw error
    }
  }

  private async inheritDecisions(draft: DraftRow, resolved: { selections: unknown[] }) {
    void resolved
    if (!draft.activeCompositionTaskId) return []
    const prev = await this.prisma.chetaidouTask.findUnique({
      where: { id: draft.activeCompositionTaskId },
    })
    if (!prev || prev.type !== "COMPOSE") return []
    const output = prev.output as unknown as ChetaidouComposeOutput | null
    return (output?.decisions as unknown as EffectiveDecisionRow[]) ?? []
  }

  private async createGenerate(userId: number, dto: CreateTaskDto, requestHash: string) {
    if (!dto.compositionTaskId || !dto.count) {
      throw new BadRequestException("GENERATE 需要 compositionTaskId 与 count")
    }
    const composeTask = await this.requireOwnedTask(userId, dto.compositionTaskId)
    if (composeTask.type !== "COMPOSE" || composeTask.rootTaskId !== composeTask.id) {
      throw new BadRequestException("该任务不是组合根任务")
    }
    const output = composeTask.output as unknown as ChetaidouComposeOutput | null
    if (
      composeTask.status !== "SUCCEEDED" ||
      !output ||
      output.status !== "READY" ||
      !output.editPromptEn
    ) {
      throw new BadRequestException({
        message: "组合未就绪（READY），不能生图",
        code: CHETAIDOU_ERROR_CODES.NEEDS_RESOLUTION,
      })
    }
    const draft = await this.requireDraft(userId, dto.imageId)
    if (draft.activeCompositionTaskId !== composeTask.id) {
      throw new ConflictException({
        message: "草稿当前组合与请求不一致，请重新组织提示词",
        code: CHETAIDOU_ERROR_CODES.SETTINGS_CHANGED,
      })
    }
    const { image } = await this.requireAccessibleImage(userId, dto.imageId)
    const composeSnapshot = composeTask.snapshot as unknown as TaskSnapshot
    if (!(await this.taskContextCurrent(composeTask, draft, "compose"))) throw settingsChanged()

    const models = await this.billing.assertModelsReady()
    const imageModel = await this.imageOptions.resolveModel(undefined, dto.imageModel?.trim())
    models.image = { publicId: imageModel.publicId, category: CHETAIDOU_IMAGE_CATEGORY }
    const gatewayConfig = await this.imageOptions.fetchCapabilities(imageModel.publicId)
    const planningModel = { ...imageModel, gatewayConfig }
    const generation = planChetaidouImage(planningModel, dto, dto.count, output.editPromptEn)
    const effectivePrompt = generationCanvasPrompt(
      output.editPromptEn,
      generation.aspectRatio,
      generation.normalizationMode !== "NONE"
    )
    // 校验真实生效提示词（包含画布指令），与执行请求一致。
    planChetaidouImage(planningModel, dto, dto.count, effectivePrompt)
    const fingerprint = imageModelFingerprint(imageModel)

    const snapshot: TaskSnapshot = {
      ...composeSnapshot,
      models,
      composition: { taskId: composeTask.id, editPromptEn: output.editPromptEn },
      generation,
    }
    const taskId = randomUUID()
    const jobId = randomUUID()
    const request = {
      schemaVersion: 1,
      businessType: CHETAIDOU_BUSINESS_TYPE,
      workflowTaskId: taskId,
      compositionTaskId: composeTask.id,
      sourceImageId: image.id,
      skuId: image.skuId,
      sourceFileKey: image.fileKey,
      sourceChecksum: image.checksum,
      prompt: effectivePrompt,
      model: snapshot.models.image.publicId,
      category: snapshot.models.image.category,
      generation,
      resolution: generation.resolution,
      count: dto.count,
    }
    const created = await this.prisma.$transaction(
      async tx => {
        const binding = await prepareAdjustment(tx, draft, snapshot, "GENERATE")
        snapshot.workflow = binding
        await this.imageOptions.assertUnchanged(tx, fingerprint, imageModel.publicId)
        const claimed = await tx.chetaidouDraft.updateMany({
          where: {
            id: draft.id,
            revision: dto.draftRevision ?? draft.revision,
            activeCompositionTaskId: composeTask.id,
            pendingRefreshTaskId: null,
          },
          data: { activeCompositionTaskId: composeTask.id },
        })
        if (!claimed.count) throw settingsChanged()
        const job = await tx.imageGenJob.create({
          data: {
            id: jobId,
            userId,
            kind: "IMAGE_TO_IMAGE",
            status: "QUEUED",
            businessType: CHETAIDOU_BUSINESS_TYPE,
            businessTaskId: taskId,
            request: request as unknown as object,
            model: request.model,
            prompt: request.prompt,
            expiresAt: null,
            items: {
              create: Array.from({ length: dto.count! }, (_, idx) => ({
                idx,
                status: "QUEUED",
              })),
            },
          },
          include: { items: true },
        })
        await tx.chetaidouTask.create({
          data: {
            ...binding,
            site: snapshot.settings.site,
            id: taskId,
            rootTaskId: taskId,
            ownerId: userId,
            skuId: image.skuId,
            imageId: image.id,
            type: "GENERATE",
            idempotencyKey: dto.idempotencyKey,
            requestHash,
            contextHash: this.context.contextHash("generate", snapshot),
            snapshot: snapshot as unknown as object,
            input: {
              type: "GENERATE",
              compositionTaskId: dto.compositionTaskId,
              count: dto.count,
              ...imageSelectionHashFields(dto),
              aspectRatio: generation.requestedAspectRatio,
            },
            imageGenJobId: jobId,
          },
        })
        if (binding.adjustmentId) await saveDraftAdjustment(tx, draft.id)
        return { job }
      },
      { timeout: 45_000 }
    )
    return {
      taskId,
      imageGenJobId: jobId,
      status: "QUEUED" as const,
      items: created.job.items
        .slice()
        .sort((a, b) => a.idx - b.idx)
        .map(item => ({ resultId: item.id, index: item.idx + 1, status: item.status })),
    }
  }

  // ── 任务读取/取消/重试/应用 ─────────────────────────────────────────────

  async listTasks(
    userId: number,
    query: {
      status?: string
      type?: string
      skuId?: number
      site?: string
      imageId?: number
      page: number
      pageSize: number
    }
  ) {
    // 先在查询层合并文本 Task 状态与关联 Job 状态，不能分页后过滤（方案 §3.3）
    const rows = await this.prisma.chetaidouTask.findMany({
      where: {
        ownerId: userId,
        type: query.type === "CROP" ? { in: [] } : (query.type ?? { not: "CROP" }),
        ...(query.skuId ? { skuId: query.skuId } : {}),
        ...(query.imageId ? { imageId: query.imageId } : {}),
        ...taskSiteWhere(query.site),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, rootTaskId: true, type: true, status: true, imageGenJobId: true },
    })
    const rootTasks = rows.filter(r => r.rootTaskId === r.id)
    let filtered = rootTasks
    if (query.status) {
      const jobs = await this.prisma.imageGenJob.findMany({
        where: { id: { in: rootTasks.flatMap(t => (t.imageGenJobId ? [t.imageGenJobId] : [])) } },
        select: { id: true, status: true },
      })
      const jobsById = new Map(jobs.map(j => [j.id, j]))
      const withStatus = await Promise.all(
        rootTasks.map(async r => ({ r, status: await this.projectTaskStatus(r, jobsById) }))
      )
      const statuses = query.status.split(",").map(value => value.trim())
      if (
        statuses.some(
          value =>
            ![
              "QUEUED",
              "RUNNING",
              "SUCCEEDED",
              "PARTIAL",
              "FAILED",
              "CANCELLED",
              "WAITING_RECONCILIATION",
            ].includes(value)
        )
      )
        throw new BadRequestException("任务状态筛选不合法")
      filtered = withStatus.filter(x => statuses.includes(x.status)).map(x => x.r)
    }
    const total = filtered.length
    const pageIds = filtered
      .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
      .map(row => row.id)
    const fullRows = pageIds.length
      ? await this.prisma.chetaidouTask.findMany({
          where: { id: { in: pageIds }, ownerId: userId },
        })
      : []
    const byId = new Map(fullRows.map(row => [row.id, row]))
    const pageRows = pageIds.flatMap(id => (byId.has(id) ? [byId.get(id)!] : []))
    const batch = await this.batchProjectContext(pageRows)
    const items = await Promise.all(pageRows.map(r => this.projectTask(r, batch)))
    return { total, page: query.page, pageSize: query.pageSize, items }
  }

  async tasksStatus(userId: number, ids: string[]) {
    const rows = await this.prisma.chetaidouTask.findMany({
      where: { id: { in: ids }, ownerId: userId },
    })
    const batch = await this.batchProjectContext(rows)
    const items = await Promise.all(
      rows.map(async row => {
        const projected = await this.projectTask(row, batch, false)
        const {
          id,
          type,
          status,
          stage,
          progress,
          errorCode,
          errorMessage,
          finishedAt,
          updatedAt,
          target,
          imageTitle,
          imageNumber,
          workspaceId,
          adjustmentId,
          site,
        } = projected
        const resultItems =
          "items" in projected
            ? projected.items.map(item => ({
                resultId: item.resultId,
                index: item.index,
                status: item.status,
              }))
            : undefined
        return {
          id,
          type,
          status,
          stage,
          progress,
          errorCode,
          errorMessage,
          finishedAt,
          updatedAt,
          target,
          imageTitle,
          imageNumber,
          workspaceId,
          adjustmentId,
          site,
          ...(resultItems ? { resultItems } : {}),
        }
      })
    )
    return { items }
  }

  async getTask(userId: number, taskId: string) {
    const task = await this.requireOwnedTask(userId, taskId)
    return this.projectTask(task)
  }

  /**
   * 批量预取投影上下文（高 RTT 库下逐任务查 Job/Group 的 N+1 是接口延迟主因）：
   * 两次查询覆盖一批任务的全部生图批次与维度组。
   */
  private async batchProjectContext(tasks: TaskRow[]): Promise<{
    jobsById: Map<string, Prisma.ImageGenJobGetPayload<{ include: { items: true } }>>
    groupsByTaskId: Map<string, Prisma.ChetaidouGroupGetPayload<Record<string, never>>[]>
    modelNames?: Map<string, string>
    imagesById: Map<number, { title: string; number: string | null }>
  }> {
    const jobIds = [
      ...new Set(
        tasks
          .filter(t => ["GENERATE", "CROP"].includes(t.type) && t.imageGenJobId)
          .map(t => t.imageGenJobId!)
      ),
    ]
    const rootIds = [
      ...new Set(tasks.filter(t => !["GENERATE", "CROP"].includes(t.type)).map(t => t.rootTaskId)),
    ]
    const [jobs, groups, images] = await Promise.all([
      jobIds.length
        ? this.prisma.imageGenJob.findMany({
            where: { id: { in: jobIds }, businessType: CHETAIDOU_BUSINESS_TYPE },
            include: { items: { orderBy: { idx: "asc" } } },
          })
        : Promise.resolve([]),
      rootIds.length
        ? this.prisma.chetaidouGroup.findMany({ where: { taskId: { in: rootIds } } })
        : Promise.resolve([]),
      this.prisma.chetaidouImage.findMany({
        where: { id: { in: [...new Set(tasks.map(t => t.imageId))] } },
        select: { id: true, title: true, number: true },
      }),
    ])
    const groupsByTaskId = new Map<
      string,
      Prisma.ChetaidouGroupGetPayload<Record<string, never>>[]
    >()
    for (const g of groups) {
      const list = groupsByTaskId.get(g.taskId) ?? []
      list.push(g)
      groupsByTaskId.set(g.taskId, list)
    }
    return {
      modelNames: await modelDisplayNames(this.prisma, tasks.filter(t => t.type === "GENERATE").map(t => (t.snapshot as unknown as TaskSnapshot)?.models?.image?.publicId)),
      jobsById: new Map(jobs.map(j => [j.id, j])),
      groupsByTaskId,
      imagesById: new Map(images.map(img => [img.id, img])),
    }
  }

  async projectTaskStatus(
    task: Pick<TaskRow, "type" | "status" | "imageGenJobId" | "id">,
    jobsById?: Map<string, { status: string }>
  ): Promise<string> {
    if (task.type !== "GENERATE") return task.status ?? "QUEUED"
    if (!task.imageGenJobId) return "FAILED"
    const job =
      jobsById?.get(task.imageGenJobId) ??
      (await this.prisma.imageGenJob.findUnique({
        where: { id: task.imageGenJobId },
        select: { status: true },
      }))
    if (!job) return "FAILED"
    // COMPLETED → SUCCEEDED（工作台 DTO 映射，方案 §6.2）
    return job.status === "COMPLETED" ? "SUCCEEDED" : job.status
  }

  async projectTask(
    task: TaskRow,
    ctx?: {
      jobsById: Map<string, Prisma.ImageGenJobGetPayload<{ include: { items: true } }>>
      groupsByTaskId: Map<string, Prisma.ChetaidouGroupGetPayload<Record<string, never>>[]>
      modelNames?: Map<string, string>
    imagesById: Map<number, { title: string; number: string | null }>
    },
    includeUrls = true
  ) {
    ctx ??= await this.batchProjectContext([task])
    const status = await this.projectTaskStatus(task, ctx.jobsById)
    const input = (task.input ?? {}) as { customDimensionId?: string; groupId?: string }
    const target =
      task.type === "DIVERGE"
        ? { customDimensionId: input.customDimensionId }
        : task.type === "REFRESH_GROUP"
          ? { groupId: input.groupId }
          : null
    const image = ctx.imagesById.get(task.imageId)
    const base = {
      id: task.id,
      rootTaskId: task.rootTaskId,
      parentTaskId: task.parentTaskId,
      type: task.type,
      operation: task.operation,
      status,
      stage: task.stage,
      progress: task.progress,
      imageId: task.imageId,
      skuId: task.skuId,
      site: task.site ?? (task.snapshot as unknown as TaskSnapshot)?.settings?.site,
      adjustmentId: task.adjustmentId,
      workspaceId: task.workspaceId,
      errorCode: task.errorCode,
      errorMessage: taskErrorMessage(task),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      target,
      executionSettings: {
        model: (task.snapshot as unknown as TaskSnapshot | undefined)?.models?.text?.publicId,
        imageModel: (task.snapshot as unknown as TaskSnapshot | undefined)?.models?.image?.publicId,
        dimensionCountRange: (task.snapshot as unknown as TaskSnapshot | undefined)?.settings
          ?.dimensionCountRange ?? { min: 10, max: 20 },
        optionCountRange: (task.snapshot as unknown as TaskSnapshot | undefined)?.settings
          ?.optionCountRange ?? { min: 30, max: 60 },
      },
      imageTitle: image?.title ?? null,
      imageNumber: image?.number ?? null,
      finishedAt: task.finishedAt,
      cancelRequestedAt: task.cancelRequestedAt,
      imageGenJobId: task.imageGenJobId,
      intent: (task.snapshot as unknown as TaskSnapshot)?.edit ? "INPAINT" : task.type === "GENERATE" ? "GENERATE" : null,
      sourceResultId: (task.snapshot as unknown as TaskSnapshot)?.edit?.sourceResultId ?? null,
      displayName: ctx.modelNames?.get((task.snapshot as unknown as TaskSnapshot)?.models?.image?.publicId) ?? (task.snapshot as unknown as TaskSnapshot)?.models?.image?.publicId ?? null,
    }
    if (["GENERATE", "CROP"].includes(task.type) && task.imageGenJobId) {
      const job =
        ctx?.jobsById.get(task.imageGenJobId) ??
        (await this.prisma.imageGenJob.findUnique({
          where: { id: task.imageGenJobId },
          include: { items: { orderBy: { idx: "asc" } } },
        }))
      const items = []
      for (const item of job?.items ?? []) {
        items.push({
          resultId: item.id,
          index: item.idx + 1,
          status: item.status,
          errorCode: item.errorCode,
          errorMessage: item.errorMessage,
          deletedAt: item.deletedAt ?? null,
          ...(includeUrls && (item.fileKey || item.url) && !item.deletedAt
            ? {
                url: item.url ?? (await this.storage.signDownload(item.fileKey!).catch(() => null)),
              }
            : { url: null }),
          originalUrl:
            includeUrls && !item.deletedAt ? await this.originalResultUrl(item.gatewayImage) : null,
          width: item.width,
          height: item.height,
          generationMeta: projectGenerationMeta(item.gatewayImage),
          derivation: cropDerivationOf(item.gatewayImage),
        })
      }
      const resultItems = job?.items ?? []
      const succeeded = resultItems.filter(i => i.status === "SUCCEEDED").length
      const failed = resultItems.filter(i => i.status === "FAILED").length
      const cancelled = resultItems.filter(i => i.status === "CANCELLED").length
      return {
        ...base,
        generation:
          task.type === "CROP" ? null : projectGeneration(task.snapshot as unknown as TaskSnapshot),
        updatedAt: latestDate(task.updatedAt, job?.updatedAt, ...resultItems.map(i => i.updatedAt)),
        progress: {
          total: resultItems.length,
          processed: succeeded + failed + cancelled,
          succeeded,
          failed,
          cancelled,
        },
        items,
      }
    }
    if (task.type === "IDEATION" || task.type === "REFRESH_GROUP") {
      const fromCtx = ctx?.groupsByTaskId.get(task.rootTaskId)
      const groups =
        fromCtx && fromCtx.length > 0
          ? fromCtx.slice().sort((a, b) => a.order - b.order)
          : await this.prisma.chetaidouGroup.findMany({
              where: { taskId: task.rootTaskId },
              orderBy: { order: "asc" },
            })
      return {
        ...base,
        updatedAt: latestDate(task.updatedAt, ...groups.map(g => g.updatedAt)),
        progress: {
          total: groups.length,
          processed: groups.filter(g => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(g.status))
            .length,
          succeeded: groups.filter(g => g.status === "SUCCEEDED").length,
          failed: groups.filter(g => g.status === "FAILED").length,
        },
        groups: groups.map(g => ({
          groupId: g.id,
          parentGroupId: g.parentGroupId,
          key: (g.definition as unknown as ChetaidouGroupDefinition).key,
          label: (g.definition as unknown as ChetaidouGroupDefinition).label,
          selectionMode: "single" as const,
          status: g.status,
          errorCode: g.errorCode,
          errorMessage: groupErrorMessage(g),
          optionCount: ((g.options as unknown as ChetaidouOption[]) ?? []).length,
        })),
      }
    }
    return base
  }

  async getTaskOutput(userId: number, taskId: string) {
    const task = await this.requireOwnedTask(userId, taskId)
    if (task.type === "COMPOSE") {
      return { compositionTaskId: task.id, output: task.output }
    }
    if (task.type === "REFRESH_GROUP") {
      return task.output
    }
    if (task.type === "DIVERGE") {
      return task.output
    }
    if (task.type === "BREAKDOWN") {
      return { breakdownId: (task.output as { breakdownId?: number })?.breakdownId ?? null }
    }
    if (["GENERATE", "CROP"].includes(task.type) && task.imageGenJobId) {
      return this.projectTask(task).then(p => ({ items: (p as { items?: unknown[] }).items ?? [] }))
    }
    return task.output
  }

  async getTaskGroup(userId: number, taskId: string, groupId: string) {
    const task = await this.requireOwnedTask(userId, taskId)
    const group = await this.prisma.chetaidouGroup.findUnique({ where: { id: groupId } })
    if (!group || group.taskId !== task.rootTaskId) {
      throw new NotFoundException("维度不存在")
    }
    return {
      groupId: group.id,
      parentGroupId: group.parentGroupId,
      producerTaskId: group.taskId,
      definition: {
        ...(group.definition as unknown as ChetaidouGroupDefinition),
        selectionMode: "single",
      },
      options: group.options,
      status: group.status,
      order: group.order,
    }
  }

  async cancelTask(userId: number, taskId: string) {
    const task = await this.requireOwnedTask(userId, taskId)
    if (task.type === "CROP") throw new BadRequestException("裁剪图片无需取消生成")
    const now = new Date()
    if (task.type === "GENERATE") {
      if (!task.imageGenJobId) throw new BadRequestException("任务无生图批次")
      const job = await this.prisma.imageGenJob.findUnique({
        where: { id: task.imageGenJobId },
        include: { items: true },
      })
      if (!job || job.businessType !== CHETAIDOU_BUSINESS_TYPE) throw new NotFoundException()
      return this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM ImageGenJob WHERE id = ${job.id} FOR UPDATE`
        const cancelled = await tx.imageGenItem.updateMany({
          where: { jobId: job.id, status: "QUEUED" },
          data: { status: "CANCELLED" },
        })
        const items = await tx.imageGenItem.findMany({ where: { jobId: job.id } })
        await tx.imageGenJob.update({
          where: { id: job.id },
          data: { cancelRequestedAt: now, status: chetaidouImageJobStatus(items) },
        })
        const pending = items.filter(i =>
          ["RUNNING", "SETTLING", "DELIVERY_PENDING", "UNKNOWN"].includes(i.status)
        ).length
        return {
          cancelled: cancelled.count,
          pending,
          note: pending ? "已提交供应商的图片无法保证终止，可能仍会产生费用" : null,
        }
      })
    }
    await this.prisma.$transaction(async tx => {
      const cancelled = await tx.chetaidouTask.updateMany({
        where: { id: task.id, status: "QUEUED" },
        data: { status: "CANCELLED", cancelRequestedAt: now, finishedAt: now },
      })
      if (!cancelled.count) throw new ConflictException("仅排队中的文本任务可取消")
      if (task.type === "REFRESH_GROUP") {
        if (task.adjustmentId)
          await writeTaskAdjustment(
            tx,
            task,
            { pendingRefreshTaskId: null },
            { pendingRefreshTaskId: task.rootTaskId }
          )
        else
          await tx.chetaidouDraft.updateMany({
            where: {
              pendingRefreshTaskId: task.rootTaskId,
              ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
            },
            data: { pendingRefreshTaskId: null },
          })
      }
    })
    if (task.id !== task.rootTaskId) {
      await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM ChetaidouTask WHERE id = ${task.rootTaskId} FOR UPDATE`
        const groupIds = (task.input as { groupIds?: string[] }).groupIds
        await tx.chetaidouGroup.updateMany({
          where: {
            taskId: task.rootTaskId,
            status: "PENDING",
            ...(groupIds?.length ? { id: { in: groupIds } } : {}),
          },
          data: { status: "FAILED", errorMessage: "重试已取消" },
        })
        const groups = await tx.chetaidouGroup.findMany({
          where: { taskId: task.rootTaskId },
        })
        const status = groups.length ? chetaidouIdeationStatus(groups) : "CANCELLED"
        await tx.chetaidouTask.update({
          where: { id: task.rootTaskId },
          data: {
            status,
            stage: null,
            finishedAt: ["RUNNING", "WAITING_RECONCILIATION"].includes(status) ? null : now,
          },
        })
      })
    }
    return { cancelled: 1, pending: 0, note: null }
  }

  async retryTask(
    userId: number,
    taskId: string,
    dto: {
      idempotencyKey: string
      draftRevision?: number
      groupIds?: string[]
      resultIds?: number[]
    }
  ) {
    assertModuleEnabled()
    const root = await this.requireOwnedTask(userId, taskId)
    if (root.type === "CROP") throw new BadRequestException("裁剪图片请通过保存接口重试")
    const requestHash = this.context.requestHash({ action: "retry", taskId, ...dto })
    const existing = await this.prisma.chetaidouTask.findFirst({
      where: { ownerId: userId, idempotencyKey: dto.idempotencyKey },
    })
    if (existing) {
      if (existing.requestHash !== requestHash) throw idempotencyConflict()
      return { taskId: existing.id }
    }
    if (root.type === "GENERATE") {
      return this.imageRetry(
        userId,
        root,
        { ...dto, idempotencyKey: dto.idempotencyKey },
        requestHash
      )
    }
    const targetedIdeationRetry = root.type === "IDEATION" && !!dto.groupIds?.length
    const retryableStatuses = targetedIdeationRetry
      ? ["FAILED", "PARTIAL", "WAITING_RECONCILIATION", "RUNNING"]
      : ["FAILED", "PARTIAL"]
    if (!retryableStatuses.includes(root.status ?? "")) {
      throw new ConflictException("仅失败或部分失败任务可重试；进行中或待核对任务请先核对结果")
    }
    // 文本任务：重试失败目标
    const failedGroups = await this.prisma.chetaidouGroup.findMany({
      where: {
        ...(dto.groupIds?.length ? { id: { in: dto.groupIds } } : {}),
        taskId: root.rootTaskId,
        status: "FAILED",
      },
    })
    if (dto.groupIds?.length && failedGroups.length !== dto.groupIds.length) {
      throw new BadRequestException("仅失败维度可重试（成功/运行中/未知不可重试）")
    }
    const retrySnapshot = structuredClone(root.snapshot as unknown as TaskSnapshot)
    if (root.type === "BREAKDOWN") {
      retrySnapshot.models.text = (await this.context.resolveBreakdownModels()).text
      retrySnapshot.settings.model = retrySnapshot.models.text.publicId
    }
    await this.billing.assertModelsReady(retrySnapshot.models)
    const retryDraft = await this.requireDraft(userId, root.imageId)
    if (dto.draftRevision !== undefined && dto.draftRevision !== retryDraft.revision)
      throw settingsChanged()
    const retryTaskId = randomUUID()
    await this.prisma.$transaction(async tx => {
      const claimed = await tx.chetaidouTask.updateMany({
        where: { id: root.rootTaskId, status: { in: retryableStatuses } },
        data: {
          status: "RUNNING",
          stage: "重试中",
          finishedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      })
      if (claimed.count === 0) throw new ConflictException("任务已在重试中，请勿重复提交")
      // 定向联想只检查所选失败维度，其他维度的未知调用仍保留原状态。
      const currentGroups = targetedIdeationRetry
        ? await tx.chetaidouGroup.findMany({
            where: { id: { in: dto.groupIds }, taskId: root.rootTaskId, status: "FAILED" },
          })
        : failedGroups
      if (targetedIdeationRetry && currentGroups.length !== dto.groupIds?.length)
        throw new ConflictException("维度状态已变化，请刷新后重试")
      const uncertainCalls = await tx.chetaidouCall.count({
        where: {
          rootTaskId: root.rootTaskId,
          state: { in: ["SUBMITTING", "WAITING", "UNKNOWN"] },
          ...(targetedIdeationRetry
            ? { id: { in: currentGroups.flatMap(g => (g.currentCallId ? [g.currentCallId] : [])) } }
            : {}),
        },
      })
      if (uncertainCalls > 0) throw new ConflictException("存在未确认的模型调用，请先核对后重试")
      await tx.chetaidouTask.create({
        data: {
          id: retryTaskId,
          rootTaskId: root.rootTaskId,
          workspaceId: root.workspaceId,
          adjustmentId: root.adjustmentId,
          site: root.site,
          retryOfTaskId: root.rootTaskId,
          ownerId: userId,
          skuId: root.skuId,
          imageId: root.imageId,
          type: root.type,
          operation: "RETRY",
          status: "QUEUED",
          stage: "排队中",
          idempotencyKey: dto.idempotencyKey,
          requestHash,
          contextHash: root.contextHash,
          snapshot: retrySnapshot as unknown as object,
          input: {
            ...(root.input as object),
            action: "retry",
            groupIds: dto.groupIds,
            previousGroupStates: Object.fromEntries(failedGroups.map(g => [g.id, g.status])),
            retryOfTaskId: root.rootTaskId,
          },
          acceptedDraftRevision: retryDraft.revision,
        },
      })
      if (failedGroups.length) {
        const claimedGroups = await tx.chetaidouGroup.updateMany({
          where: { id: { in: failedGroups.map(g => g.id) }, status: "FAILED" },
          data: {
            status: "PENDING",
            ...((root.snapshot as unknown as TaskSnapshot).execution
              ? {}
              : { errorCode: null, errorMessage: null }),
          },
        })
        if (claimedGroups.count !== failedGroups.length)
          throw new ConflictException("维度状态已变化，请刷新后重试")
      }
      if (root.type === "REFRESH_GROUP") {
        const refresh = (root.snapshot as unknown as TaskSnapshot).refresh
        if (root.adjustmentId) {
          await writeTaskAdjustment(
            tx,
            root,
            { pendingRefreshTaskId: root.rootTaskId, activeCompositionTaskId: null },
            { pendingRefreshTaskId: null }
          )
        } else if (
          refresh &&
          retryDraft.activeIdeationTaskId === refresh.sourceIdeationTaskId &&
          ((retryDraft.activeGroupRefs as { groupId: string }[]) ?? []).some(
            ref => ref.groupId === refresh.parentGroupId
          )
        ) {
          const claimedDraft = await tx.chetaidouDraft.updateMany({
            where: {
              id: retryDraft.id,
              revision: retryDraft.revision,
              pendingRefreshTaskId: null,
              ...(root.workspaceId ? { workspaceId: root.workspaceId } : {}),
            },
            data: { pendingRefreshTaskId: root.rootTaskId, activeCompositionTaskId: null },
          })
          if (!claimedDraft.count) throw settingsChanged()
        }
      }
      if (root.type === "BREAKDOWN") {
        await tx.chetaidouImage.update({
          where: { id: root.imageId },
          data: { activeBreakdownTaskId: retryTaskId },
        })
      }
    })
    return { taskId: retryTaskId }
  }

  private async imageRetry(
    userId: number,
    root: TaskRow,
    dto: { idempotencyKey: string; draftRevision?: number; resultIds?: number[] },
    requestHash: string
  ) {
    if (!root.imageGenJobId) throw new BadRequestException("任务无生图批次")
    const job = await this.prisma.imageGenJob.findUnique({
      where: { id: root.imageGenJobId },
      include: { items: { orderBy: { idx: "asc" } } },
    })
    if (!job || job.businessType !== CHETAIDOU_BUSINESS_TYPE) throw new NotFoundException()
    if (
      dto.resultIds &&
      (new Set(dto.resultIds).size !== dto.resultIds.length ||
        dto.resultIds.some(id => !job.items.some(i => i.id === id)))
    )
      throw new BadRequestException("重试图片不存在或重复")
    if (dto.resultIds?.some(id => job.items.some(i => i.id === id && i.deletedAt)))
      throw new BadRequestException({ code: "RESULT_REMOVED", message: "已删除的图片不可重试" })
    const targets = dto.resultIds?.length
      ? job.items.filter(i => dto.resultIds!.includes(i.id))
      : job.items.filter(i => i.status === "FAILED" && !i.deletedAt)
    if (targets.length === 0) throw new BadRequestException("没有可重试的失败图片")
    for (const t of targets) {
      if (t.status !== "FAILED") {
        throw new BadRequestException("仅失败图片可重试（成功/运行中/未知不可重试）")
      }
    }
    if (!(root.snapshot as unknown as TaskSnapshot).edit) await this.billing.assertModelsReady((root.snapshot as unknown as TaskSnapshot).models)
    const retryTaskId = randomUUID()
    await this.prisma.$transaction(async tx => {
      await this.imageOptions.assertRetryModel(
        tx,
        (root.snapshot as unknown as TaskSnapshot).models.image
      )
      await tx.$queryRaw`SELECT id FROM ImageGenJob WHERE id = ${job.id} FOR UPDATE`
      const claimed = await tx.imageGenItem.updateMany({
        where: { id: { in: targets.map(t => t.id) }, status: "FAILED", deletedAt: null },
        data: { status: "QUEUED", errorMessage: null, errorCode: null },
      })
      if (claimed.count !== targets.length)
        throw new ConflictException("图片已在重试中，请勿重复提交")
      await tx.chetaidouTask.create({
        data: {
          id: retryTaskId,
          rootTaskId: root.rootTaskId,
          workspaceId: root.workspaceId,
          adjustmentId: root.adjustmentId,
          site: root.site,
          retryOfTaskId: root.rootTaskId,
          ownerId: userId,
          skuId: root.skuId,
          imageId: root.imageId,
          type: "GENERATE",
          operation: "RETRY",
          idempotencyKey: dto.idempotencyKey,
          requestHash,
          contextHash: root.contextHash,
          snapshot: root.snapshot as unknown as object,
          input: {
            action: "retry",
            resultIds: targets.map(t => t.id),
            retryOfTaskId: root.rootTaskId,
          },
          imageGenJobId: job.id,
        },
      })
      await tx.imageGenJob.update({
        where: { id: job.id },
        data: { status: "RUNNING", cancelRequestedAt: null },
      })
    })
    return { taskId: retryTaskId }
  }

  /** 应用有效 REFRESH_GROUP/DIVERGE/COMPOSE 输出到草稿（不重新调用模型） */
  async applyTask(userId: number, taskId: string, draftRevision: number, workspaceId?: string) {
    const task = await this.requireOwnedTask(userId, taskId)
    if (task.type === "CROP") throw new BadRequestException("裁剪图片无需应用到草稿")
    if (task.type === "DIVERGE")
      return applyDivergeOutput(this.prisma, userId, taskId, draftRevision, false, workspaceId)
    if (task.status !== "SUCCEEDED") throw new BadRequestException("任务未成功，不可应用")
    if (task.type === "REFRESH_GROUP") {
      const output = task.output as {
        newGroupId?: string
        parentGroupId?: string
        applied?: boolean
        appliedDraftRevision?: number | null
      } | null
      if (!output?.newGroupId) throw new BadRequestException("刷新任务无新组产物")
      const draft = await this.requireDraft(userId, task.imageId)
      assertWorkspace(draft, workspaceId, draftRevision)
      const refs = (draft.activeGroupRefs as { groupId: string }[]) ?? []
      if (refs.some(r => r.groupId === output.newGroupId))
        return { applied: true, alreadyApplied: true, revision: draft.revision }
      if (!refs.some(r => r.groupId === output.parentGroupId))
        throw new ConflictException("目标旧组已不在当前调整中，不可应用")
      const newGroup = await this.prisma.chetaidouGroup.findUnique({
        where: { id: output.newGroupId },
      })
      if (!newGroup || newGroup.taskId !== task.rootTaskId || newGroup.status !== "SUCCEEDED")
        throw new BadRequestException("新组不存在或不可应用")
      return this.prisma.$transaction(async tx => {
        const binding = await prepareAdjustment(
          tx,
          draft,
          task.snapshot as unknown as TaskSnapshot,
          "REFRESH_GROUP"
        )
        const updated = await tx.chetaidouDraft.updateMany({
          where: {
            id: draft.id,
            revision: draftRevision,
            ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
          },
          data: {
            activeGroupRefs: refs.map(r =>
              r.groupId === output.parentGroupId ? { groupId: output.newGroupId! } : r
            ),
            selections: ((draft.selections as { groupId: string }[]) ?? []).map(sel =>
              sel.groupId === output.parentGroupId ? { ...sel, groupId: output.newGroupId! } : sel
            ),
            activeCompositionTaskId: null,
            pendingRefreshTaskId: null,
            revision: { increment: 1 },
          },
        })
        if (!updated.count) throw workspaceChanged()
        if (binding.adjustmentId) await saveDraftAdjustment(tx, draft.id)
        await tx.chetaidouTask.update({
          where: { id: task.id },
          data: {
            output: { ...output, applied: true, appliedDraftRevision: draftRevision + 1 },
            appliedDraftRevision: draftRevision + 1,
            appliedAt: new Date(),
          },
        })
        return { applied: true, revision: draftRevision + 1 }
      })
    }
    throw new BadRequestException("该任务类型无需应用")
  }

  async discardTask(userId: number, taskId: string) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ChetaidouTask WHERE id = ${taskId} FOR UPDATE`
      const task = await tx.chetaidouTask.findUnique({ where: { id: taskId } })
      if (!task || task.ownerId !== userId) throw new NotFoundException("任务不存在")
      if (task.type !== "DIVERGE" || task.status !== "SUCCEEDED")
        throw new BadRequestException("仅成功且未应用的发散结果可放弃")
      const output = (task.output ?? {}) as Record<string, any>
      if (output.applied) throw new ConflictException("结果已应用，请在草稿中删除方案")
      if (!output.discarded)
        await tx.chetaidouTask.update({
          where: { id: task.id },
          data: { output: { ...output, discarded: true, canApply: false } },
        })
      return { discarded: true }
    })
  }

  // ── 组合读取 ────────────────────────────────────────────────────────────

  async getComposition(userId: number, compositionTaskId: string) {
    const task = await this.requireOwnedTask(userId, compositionTaskId)
    if (task.type !== "COMPOSE" || task.rootTaskId !== task.id) {
      throw new NotFoundException("组合不存在")
    }
    const output = task.output as unknown as ChetaidouComposeOutput | null
    const draft = await this.prisma.chetaidouDraft.findUnique({
      where: { ownerId_imageId: { ownerId: userId, imageId: task.imageId } },
    })
    const isStale =
      !draft ||
      draft.activeCompositionTaskId !== task.id ||
      !(await this.taskContextCurrent(task, draft, "compose"))
    return {
      compositionTaskId: task.id,
      status: task.status,
      output,
      isStale,
      staleReason: isStale ? "草稿已变化或已生成新组合，该组合仅供查看" : null,
    }
  }

  async getCompositionPrompt(userId: number, compositionTaskId: string) {
    const task = await this.requireOwnedTask(userId, compositionTaskId)
    if (task.type !== "COMPOSE" || task.rootTaskId !== task.id) throw new NotFoundException()
    const output = task.output as unknown as ChetaidouComposeOutput | null
    return { editPromptEn: output?.editPromptEn ?? null }
  }

  // ── 预览墙 / 下载 ──────────────────────────────────────────────────────

  async filterOptions(userId: number, skuId: number) {
    await this.requireSku(skuId)
    const images = await this.prisma.chetaidouImage.findMany({
      where: {
        skuId,
        enabled: true,
        OR: [{ sourceType: "PRESET" }, { sourceType: "USER_UPLOAD", ownerId: userId }],
      },
      select: { id: true, title: true, number: true },
      orderBy: { id: "asc" },
    })
    return { sites: Object.keys(CHETAIDOU_SITES), images }
  }

  async cropUploadUrl(userId: number) {
    assertModuleEnabled()
    return this.storage.createCropUpload(userId)
  }

  async saveCrop(userId: number, resultId: number, url: string, idempotencyKey: string) {
    assertModuleEnabled()
    if (!Number.isSafeInteger(resultId) || resultId < 1)
      throw new BadRequestException("结果 ID 必须为正整数")
    const requestHash = stableHash({ action: "save-crop", resultId, url })
    const existingCrop = async () => {
      const saved = await this.prisma.chetaidouTask.findFirst({
        where: { ownerId: userId, idempotencyKey },
      })
      if (!saved) return null
      if (saved.type !== "CROP" || saved.requestHash !== requestHash) throw idempotencyConflict()
      return saved
    }
    const existing = await existingCrop()
    if (existing) return this.savedCropResult(userId, existing)
    const source = await this.prisma.imageGenItem.findFirst({
      where: {
        id: resultId,
        deletedAt: null,
        status: "SUCCEEDED",
        fileKey: { not: null },
        job: { userId, businessType: CHETAIDOU_BUSINESS_TYPE },
      },
    })
    if (!source?.fileKey) throw new NotFoundException("来源图片不存在或不可保存")
    const sourceTask = await this.prisma.chetaidouTask.findFirst({
      where: {
        ownerId: userId,
        imageGenJobId: source.jobId,
        type: { in: ["GENERATE", "CROP"] },
        operation: "PRIMARY",
      },
    })
    if (!sourceTask) throw new NotFoundException("来源图片不存在")
    await this.requireSku(sourceTask.skuId)
    const taskId = randomUUID()
    const jobId = randomUUID()
    const asset = await this.storage.inspectCropPng(userId, url)
    let saved: TaskRow
    try {
      saved = await this.prisma.$transaction(async tx => {
        // 与结果删除持同一 Job 行锁，避免来源删除后再新增归档。
        await tx.$queryRaw`SELECT id FROM ImageGenJob WHERE id = ${source.jobId} FOR UPDATE`
        const available = await tx.imageGenItem.findFirst({
          where: { id: resultId, jobId: source.jobId, deletedAt: null, status: "SUCCEEDED" },
        })
        if (!available) throw new NotFoundException("来源图片已移除")
        const original = originalImageOf(source.gatewayImage)
        const task = await tx.chetaidouTask.create({
          data: {
            id: taskId,
            rootTaskId: taskId,
            imageGenJobId: jobId,
            ownerId: userId,
            skuId: sourceTask.skuId,
            imageId: sourceTask.imageId,
            adjustmentId: sourceTask.adjustmentId,
            site: sourceTask.site,
            type: "CROP",
            operation: "PRIMARY",
            status: "SUCCEEDED",
            finishedAt: new Date(),
            idempotencyKey,
            requestHash,
            snapshot: sourceTask.snapshot as Prisma.InputJsonValue,
            input: {
              sourceResultId: resultId,
              url,
              compositionTaskId: compositionTaskIdOf(sourceTask),
            },
          },
        })
        await tx.imageGenJob.create({
          data: {
            id: jobId,
            userId,
            businessType: CHETAIDOU_BUSINESS_TYPE,
            businessTaskId: taskId,
            kind: "CROP",
            status: "COMPLETED",
            items: {
              create: {
                idx: 0,
                status: "SUCCEEDED",
                url,
                fileKey: asset.fileKey,
                mime: asset.mime,
                width: asset.width,
                height: asset.height,
                gatewayImage: {
                  actual: { width: asset.width, height: asset.height, format: "png" },
                  derivation: { type: "CROP", sourceResultId: resultId },
                  ...(original ? { original: { ...original } } : {}),
                },
              },
            },
          },
        })
        return task
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await existingCrop()
        if (existing) return this.savedCropResult(userId, existing)
      }
      throw error
    }
    return this.savedCropResult(userId, saved)
  }

  private async savedCropResult(userId: number, task: TaskRow) {
    const item = await this.prisma.imageGenItem.findFirst({ where: { jobId: task.imageGenJobId! } })
    if (!item || item.deletedAt) throw new ConflictException("已保存的图片已移除，请重新发起保存")
    const result = await this.listResults(userId, task.skuId, {
      page: 1,
      pageSize: 1,
      resultId: item.id,
    })
    const saved = result.items[0]
    if (!saved) throw new ConflictException("已保存的图片不可用")
    if (!saved.url)
      throw new ServiceUnavailableException("图片签名暂时不可用，请使用原动作 ID 重试")
    return saved
  }

  async listResults(
    userId: number,
    skuId: number,
    query: { page: number; pageSize: number; site?: string; imageId?: number; resultId?: number }
  ) {
    await this.requireSku(skuId)
    const generationTasks = await this.prisma.chetaidouTask.findMany({
      where: {
        ownerId: userId,
        skuId,
        type: { in: ["GENERATE", "CROP"] },
        operation: "PRIMARY",
        imageGenJobId: { not: null },
        ...taskSiteWhere(query.site),
        ...(query.imageId ? { imageId: query.imageId } : {}),
      },
      select: { id: true, imageGenJobId: true },
    })
    const candidateTasksByJob = new Map(generationTasks.map(t => [t.imageGenJobId, t]))
    const where: Prisma.ImageGenItemWhereInput = {
      ...(query.resultId ? { id: query.resultId } : {}),
      jobId: { in: generationTasks.flatMap(t => (t.imageGenJobId ? [t.imageGenJobId] : [])) },
      deletedAt: null,
      job: { userId, businessType: CHETAIDOU_BUSINESS_TYPE },
    }
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.imageGenItem.count({ where }),
      this.prisma.imageGenItem.findMany({
        where,
        orderBy: [{ job: { createdAt: "desc" } }, { jobId: "desc" }, { idx: "asc" }, { id: "asc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ])
    const taskIds = [...new Set(rows.map(item => candidateTasksByJob.get(item.jobId)!.id))]
    const pageTasks = taskIds.length
      ? await this.prisma.chetaidouTask.findMany({
          where: { id: { in: taskIds }, ownerId: userId },
          select: {
            id: true,
            skuId: true,
            imageId: true,
            type: true,
            imageGenJobId: true,
            snapshot: true,
            input: true,
            site: true,
            adjustmentId: true,
          },
        })
      : []
    const names = await modelDisplayNames(this.prisma, pageTasks.map(t => (t.snapshot as unknown as TaskSnapshot)?.models?.image?.publicId))
    const tasksByJob = new Map(pageTasks.map(task => [task.imageGenJobId, task]))
    const imageIds = [...new Set(pageTasks.map(t => t.imageId))]
    const images = imageIds.length
      ? await this.prisma.chetaidouImage.findMany({
          where: { id: { in: imageIds }, skuId },
          select: { id: true, number: true, title: true, fileKey: true },
        })
      : []
    const masters = new Map(
      await Promise.all(
        images.map(
          async image =>
            [
              image.id,
              {
                id: image.id,
                number: image.number,
                title: image.title,
                previewUrl: image.fileKey
                  ? await this.storage.signDownload(image.fileKey).catch(() => null)
                  : null,
              },
            ] as const
        )
      )
    )
    const compositionIds = [
      ...new Set(pageTasks.flatMap(t => (compositionTaskIdOf(t) ? [compositionTaskIdOf(t)!] : []))),
    ]
    const compositions = compositionIds.length
      ? await this.prisma.chetaidouTask.findMany({
          where: { id: { in: compositionIds }, ownerId: userId },
          select: { id: true, output: true },
        })
      : []
    const summaries = new Map(
      compositions.map(c => [
        c.id,
        (c.output as unknown as ChetaidouComposeOutput | null)?.summaryCn ?? null,
      ])
    )
    const items = await Promise.all(
      rows.map(async item => {
        const task = tasksByJob.get(item.jobId)!
        return {
          resultId: item.id,
          index: item.idx + 1,
          status: item.status,
          taskId: task.id,
          site: task.site ?? (task.snapshot as unknown as TaskSnapshot)?.settings?.site,
          adjustmentId: task.adjustmentId,
          imageModel: (task.snapshot as unknown as TaskSnapshot)?.models?.image?.publicId,
          displayName: names.get((task.snapshot as unknown as TaskSnapshot)?.models?.image?.publicId) ?? (task.snapshot as unknown as TaskSnapshot)?.models?.image?.publicId ?? null,
          intent: (task.snapshot as unknown as TaskSnapshot)?.edit ? "INPAINT" : "GENERATE",
          sourceResultId: (task.snapshot as unknown as TaskSnapshot)?.edit?.sourceResultId ?? null,
          compositionTaskId: compositionTaskIdOf(task),
          summaryCn: (task.snapshot as unknown as TaskSnapshot)?.edit ? jsonObject(task.input).prompt || "局部重绘" : summaries.get(compositionTaskIdOf(task) ?? "") ?? null,
          imageGenJobId: item.jobId,
          masterImage: masters.get(task.imageId) ?? null,
          url:
            item.url ??
            (item.fileKey ? await this.storage.signDownload(item.fileKey).catch(() => null) : null),
          originalUrl: await this.originalResultUrl(item.gatewayImage),
          width: item.width,
          height: item.height,
          generation:
            task.type === "CROP"
              ? null
              : projectGeneration(task.snapshot as unknown as TaskSnapshot),
          generationMeta: projectGenerationMeta(item.gatewayImage),
          derivation: cropDerivationOf(item.gatewayImage),
          errorMessage: item.errorMessage,
          createdAt: item.createdAt,
        }
      })
    )
    return { total, page: query.page, pageSize: query.pageSize, items }
  }

  private async originalResultUrl(metadata: Prisma.JsonValue | null) {
    const original = originalImageOf(metadata)
    return original ? this.storage.signDownload(original.fileKey).catch(() => null) : null
  }

  async downloadResult(userId: number, resultId: number) {
    const item = await this.prisma.imageGenItem.findUnique({ where: { id: resultId } })
    if (!item || item.deletedAt) throw new NotFoundException("结果不存在")
    const job = await this.prisma.imageGenJob.findUnique({ where: { id: item.jobId } })
    if (!job || job.businessType !== CHETAIDOU_BUSINESS_TYPE || job.userId !== userId) {
      throw new NotFoundException("结果不存在")
    }
    if (item.status !== "SUCCEEDED" || !item.fileKey) {
      throw new BadRequestException("该图片尚未成功生成")
    }
    const task = await this.prisma.chetaidouTask.findFirst({
      where: { imageGenJobId: job.id, type: { in: ["GENERATE", "CROP"] } },
      select: { skuId: true },
    })
    const sku = task
      ? await this.prisma.chetaidouSku.findUnique({ where: { id: task.skuId } })
      : null
    const image = await this.prisma.chetaidouImage.findFirst({
      where: {
        id: (
          await this.prisma.chetaidouTask.findFirst({
            where: { imageGenJobId: job.id, type: { in: ["GENERATE", "CROP"] } },
            select: { imageId: true },
          })
        )?.imageId,
      },
      select: { number: true },
    })
    const filename = this.storage.downloadFilename({
      skuCode: sku?.code ?? "chetaidou",
      imageNumber: image?.number,
      taskId: job.businessTaskId ?? job.id,
      index: item.idx + 1,
      mime: item.mime ?? "image/png",
    })
    const url = await this.storage.signDownload(item.fileKey, 600, filename)
    return { url, expiresAt: new Date(Date.now() + 600_000).toISOString(), filename }
  }

  async batchDownloadResults(userId: number, skuId: number, resultIds: number[]) {
    const { items, tasksByJob } = await this.loadSelectedResults(
      this.prisma,
      userId,
      skuId,
      resultIds
    )
    if (items.some(item => item.deletedAt)) throw resultNotFound()
    if (items.some(item => item.status !== "SUCCEEDED" || !item.fileKey)) {
      throw new BadRequestException({
        code: "RESULT_NOT_DOWNLOADABLE",
        message: "仅可下载成功生成的图片，请重新选择",
      })
    }
    const [sku, images] = await Promise.all([
      this.prisma.chetaidouSku.findUnique({ where: { id: skuId } }),
      this.prisma.chetaidouImage.findMany({
        where: { id: { in: [...new Set([...tasksByJob.values()].map(task => task.imageId))] } },
        select: { id: true, number: true },
      }),
    ])
    const imagesById = new Map(images.map(image => [image.id, image]))
    const expiresAt = new Date(Date.now() + 600_000).toISOString()
    const downloads = await Promise.all(
      items.map(async item => {
        const task = tasksByJob.get(item.jobId)!
        const filename = this.storage.downloadFilename({
          skuCode: sku?.code ?? "chetaidou",
          imageNumber: imagesById.get(task.imageId)?.number,
          taskId: item.job.businessTaskId ?? task.id,
          index: item.idx + 1,
          mime: item.mime ?? "image/png",
        })
        const url = await this.storage.signDownload(item.fileKey!, 600, filename)
        return { resultId: item.id, url, filename, expiresAt }
      })
    )
    return { count: downloads.length, expiresAt, items: downloads }
  }

  async batchDeleteResults(userId: number, skuId: number, resultIds: number[]) {
    const selected = await this.loadSelectedResults(this.prisma, userId, skuId, resultIds)
    // 与取消/重试/执行认领统一持 Job 行锁；固定顺序避免跨批次删除互相死锁。
    const jobIds = [...new Set(selected.items.map(item => item.jobId))].sort()
    return this.prisma.$transaction(async tx => {
      for (const jobId of jobIds) {
        await tx.$queryRaw`SELECT id FROM ImageGenJob WHERE id = ${jobId} FOR UPDATE`
      }
      const { items } = await this.loadSelectedResults(tx, userId, skuId, resultIds)
      const remaining = items.filter(item => !item.deletedAt)
      const terminalStatuses = ["SUCCEEDED", "FAILED", "CANCELLED"]
      if (remaining.some(item => !terminalStatuses.includes(item.status))) {
        throw resultNotRemovable()
      }
      if (remaining.length) {
        const unsettled = await tx.chetaidouCall.count({
          where: {
            imageGenItemId: { in: remaining.map(item => item.id) },
            state: { not: "FINISHED" },
          },
        })
        if (unsettled) throw resultNotRemovable()
        const removed = await tx.imageGenItem.updateMany({
          where: {
            id: { in: remaining.map(item => item.id) },
            deletedAt: null,
            status: { in: terminalStatuses },
            job: { userId, businessType: CHETAIDOU_BUSINESS_TYPE, id: { in: jobIds } },
          },
          data: { deletedAt: new Date() },
        })
        if (removed.count !== remaining.length) {
          throw new ConflictException({
            code: "RESULT_STATE_CHANGED",
            message: "图片状态已变化，请刷新后重试",
          })
        }
      }
      return {
        success: true,
        requestedCount: resultIds.length,
        removedCount: remaining.length,
        alreadyRemovedCount: items.length - remaining.length,
        resultIds,
      }
    })
  }

  private async loadSelectedResults(
    db: Prisma.TransactionClient,
    userId: number,
    skuId: number,
    resultIds: number[]
  ) {
    if (
      !Array.isArray(resultIds) ||
      !resultIds.length ||
      new Set(resultIds).size !== resultIds.length ||
      resultIds.some(id => !Number.isSafeInteger(id) || id < 1)
    ) {
      throw new BadRequestException({
        code: "RESULT_IDS_INVALID",
        message: "请选择图片，结果 ID 必须为不重复的正整数",
      })
    }
    const items = await db.imageGenItem.findMany({
      where: {
        id: { in: resultIds },
        job: { userId, businessType: CHETAIDOU_BUSINESS_TYPE },
      },
      include: { job: { select: { id: true, businessTaskId: true } } },
    })
    if (items.length !== resultIds.length) throw resultNotFound()
    const tasks = await db.chetaidouTask.findMany({
      where: {
        imageGenJobId: { in: [...new Set(items.map(item => item.jobId))] },
        ownerId: userId,
        skuId,
        type: { in: ["GENERATE", "CROP"] },
        operation: "PRIMARY",
      },
      select: { id: true, imageGenJobId: true, imageId: true },
    })
    const tasksByJob = new Map(tasks.map(task => [task.imageGenJobId, task]))
    if (items.some(item => !tasksByJob.has(item.jobId))) throw resultNotFound()
    const itemsById = new Map(items.map(item => [item.id, item]))
    return { items: resultIds.map(id => itemsById.get(id)!), tasksByJob }
  }

  // ── 内部工具 ────────────────────────────────────────────────────────────

  async requireSku(skuId: number): Promise<SkuRow> {
    if (!Number.isSafeInteger(skuId) || skuId < 1)
      throw new BadRequestException("SKU ID 必须为正整数")
    const sku = await this.prisma.chetaidouSku.findUnique({ where: { id: skuId } })
    if (!sku || !sku.enabled) {
      throw new BadRequestException({
        message: "SKU 不存在或未开放",
        code: CHETAIDOU_ERROR_CODES.PERMISSION_DENIED,
      })
    }
    return sku
  }

  async requireAccessibleImage(
    userId: number,
    imageId: number,
    opts: { requireOwnership?: boolean } = {}
  ) {
    const image = await this.prisma.chetaidouImage.findUnique({ where: { id: imageId } })
    if (!image || !image.enabled) throw new NotFoundException("母版不存在")
    if (image.sourceType === "USER_UPLOAD" && image.ownerId !== userId) {
      throw new NotFoundException("母版不存在")
    }
    if (opts.requireOwnership && image.sourceType !== "USER_UPLOAD") {
      throw new NotFoundException("资源不存在")
    }
    const sku = await this.requireSku(image.skuId)
    const fact = sku.currentFactId
      ? await this.prisma.chetaidouFactCard.findUnique({ where: { id: sku.currentFactId } })
      : null
    if (!fact) {
      throw new BadRequestException({
        message: "SKU 事实卡缺失",
        code: CHETAIDOU_ERROR_CODES.MODEL_NOT_READY,
      })
    }
    const breakdown = image.currentBreakdownId
      ? await this.prisma.chetaidouBreakdown.findUnique({
          where: { id: image.currentBreakdownId },
        })
      : null
    return { sku, fact, image, breakdown } as {
      sku: SkuRow
      fact: FactRow
      image: ImageRow
      breakdown: BreakdownRow | null
    }
  }

  async requireDraft(userId: number, imageId: number): Promise<DraftRow> {
    const draft = await this.prisma.chetaidouDraft.findUnique({
      where: { ownerId_imageId: { ownerId: userId, imageId } },
    })
    if (!draft) throw new NotFoundException("草稿不存在")
    return draft
  }

  async requireOwnedTask(userId: number, taskId: string): Promise<TaskRow> {
    const task = await this.prisma.chetaidouTask.findUnique({ where: { id: taskId } })
    if (!task || task.ownerId !== userId) throw new NotFoundException("任务不存在")
    return task
  }
}

// ── 局部类型与工具 ─────────────────────────────────────────────────────────

interface EffectiveDecisionRow {
  decisionId: string
  compositionTaskId: string
  conflictId: string
  questionVersion: number
  sources: string[]
  question?: string
  choiceId?: string
  customText?: string
  instruction?: string
  originalConflict?: unknown
  scopeKey?: string
}

function taskSiteWhere(site?: string): Prisma.ChetaidouTaskWhereInput {
  if (!site) return {}
  // 旧任务未填写站点列，筛选与响应均回退到生成时的冻结快照。
  return {
    OR: [{ site }, { site: null, snapshot: { path: "$.settings.site", equals: site } }],
  }
}

export function defaultSettings(): ChetaidouSettings {
  return {
    site: "original",
    textMode: "keep",
    personMode: "keep",
    personText: "",
    customText: "",
  }
}

function draftSettingsOf(draft: DraftRow | null): ChetaidouSettings {
  const raw = (draft?.settings as ChetaidouSettings | null) ?? null
  return { ...defaultSettings(), ...(raw ?? {}) }
}

function imageSnapshotOf(image: ImageRow): TaskSnapshot["image"] {
  return {
    id: image.id,
    skuId: image.skuId,
    fileKey: image.fileKey,
    checksum: image.checksum,
    width: image.width,
    height: image.height,
    mime: image.mime,
  }
}

function factSnapshotOf(fact: FactRow): TaskSnapshot["facts"] {
  return {
    id: fact.id,
    version: fact.version,
    content: fact.content,
    contentHash: fact.contentHash,
  }
}

function breakdownSnapshotOf(breakdown: BreakdownRow | null): TaskSnapshot["breakdown"] {
  if (!breakdown) return null
  return {
    id: breakdown.id,
    version: breakdown.version,
    payload: breakdown.payload as unknown as ChetaidouBreakdownPayload,
    contentHash: breakdown.contentHash,
  }
}

function validateCustomDimensions(dims: CustomDimensionInput[]) {
  if (dims.length > CHETAIDOU_MAX_CUSTOM_DIMENSIONS) {
    throw new BadRequestException(`自建维度最多 ${CHETAIDOU_MAX_CUSTOM_DIMENSIONS} 个`)
  }
  for (const dim of dims) {
    if (!dim.label?.trim() || dim.label.length > 60) {
      throw new BadRequestException("自建维度名称必填且 ≤60 字")
    }
    if (dim.selectionMode !== "single" && dim.selectionMode !== "multi") {
      throw new BadRequestException("自建维度 selectionMode 非法")
    }
    for (const opt of dim.options ?? []) {
      if (!opt.text?.trim() || opt.text.length > 1000) {
        throw new BadRequestException("自建选项必填且 ≤1000 字")
      }
    }
  }
}

function definition_isSingle(dim: CustomDimensionInput): boolean {
  return dim.selectionMode === "single"
}

function idempotencyConflict(): ConflictException {
  return new ConflictException({
    message: "幂等键已用于不同请求",
    code: CHETAIDOU_ERROR_CODES.IDEMPOTENCY_CONFLICT,
  })
}

function settingsChanged(): ConflictException {
  return new ConflictException({
    message: "草稿已更新，请刷新后重试",
    code: CHETAIDOU_ERROR_CODES.SETTINGS_CHANGED,
    details: { retryable: false },
  })
}

function assertModuleEnabled() {
  if (!chetaidouEnabled()) {
    throw new BadRequestException({
      message: "车泰斗工作台未开放",
      code: CHETAIDOU_ERROR_CODES.PERMISSION_DENIED,
    })
  }
}

function latestDate(...dates: (Date | null | undefined)[]): Date {
  return new Date(
    Math.max(
      0,
      ...dates.filter((date): date is Date => date instanceof Date).map(date => date.getTime())
    )
  )
}

/** 历史生图快照未写 composition 时，从原命令回解，不能取当前草稿。 */
function compositionTaskIdOf(task: {
  snapshot: Prisma.JsonValue
  input: Prisma.JsonValue
}): string | null {
  return (
    (task.snapshot as unknown as TaskSnapshot).composition?.taskId ??
    (task.input as { compositionTaskId?: string }).compositionTaskId ??
    null
  )
}

function resultNotFound() {
  return new NotFoundException({
    code: "RESULT_NOT_FOUND",
    message: "部分图片不存在或不属于当前 SKU",
  })
}

function resultNotRemovable() {
  return new ConflictException({
    code: "RESULT_NOT_REMOVABLE",
    message: "生成中、交付中或待核对的图片不可删除，请等待处理完成",
  })
}

function projectGeneration(snapshot: TaskSnapshot) {
  const generation = snapshot?.generation
  if (!generation) return null
  const publicFields = { ...generation }
  delete publicFields.providerDefaults
  return { model: snapshot.models?.image?.publicId ?? null, ...publicFields }
}

function projectGenerationMeta(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const {
    nativeWidth,
    nativeHeight,
    actual,
    providerApplied,
    normalized,
    sizingAdjusted,
    adaptation,
    warnings,
    original,
  } = value
  const asset = originalImageOf({ original })
  return {
    nativeWidth,
    nativeHeight,
    actual,
    providerApplied,
    normalized,
    sizingAdjusted,
    adaptation,
    warnings,
    original: asset ? { width: asset.width, height: asset.height, mime: asset.mime } : null,
  }
}

function cropDerivationOf(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const derivation = value.derivation
  if (!derivation || typeof derivation !== "object" || Array.isArray(derivation)) return null
  return derivation.type === "CROP" && typeof derivation.sourceResultId === "number"
    ? { type: "CROP" as const, sourceResultId: derivation.sourceResultId }
    : null
}
