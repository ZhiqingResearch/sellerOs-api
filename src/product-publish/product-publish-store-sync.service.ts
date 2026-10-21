import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import {
  ProductPublishFeishuSyncAction,
  ProductPublishFeishuSyncRecordStatus,
  ProductPublishFeishuSyncStatus,
  ProductPublishFeishuSyncTrigger,
} from "@prisma/client"
import { FeishuBitableRecord, FeishuProvider } from "../common/providers/feishu.provider"
import { PrismaService } from "../prisma/prisma.service"
import { PRODUCT_PUBLISH_CLASSIFICATIONS } from "./product-publish.constants"

export interface ProductPublishStoreSyncResult {
  runId: number
  configured: boolean
  status: ProductPublishFeishuSyncStatus
  total: number
  created: number
  updated: number
  failed: number
  skipped: number
}

interface NormalizedStoreRecord {
  externalStoreId: string
  feishuRecordId: string
  sourceUuid: string | null
  name: string
  shortName: string | null
  companyName: string | null
  platform: string
  storeType: string | null
  accountType: string | null
  childStore: string | null
  site: string | null
  remark: string | null
  disabled: boolean
  sourceUpdatedAt: Date | null
}

interface ClassificationDefinition {
  code: string
  name: string
  sortOrder: number
}

type NormalizationResult =
  | { value: NormalizedStoreRecord; reason?: never }
  | { value: null; reason: string }

@Injectable()
export class ProductPublishStoreSyncService implements OnModuleInit {
  private readonly logger = new Logger(ProductPublishStoreSyncService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly feishu: FeishuProvider
  ) {}

  /**
   * 兼容仓库当前仍使用 prisma db push 的容器启动方式：只补齐缺失的初始分类，
   * 不覆盖导入脚本或人工维护过的名称、排序和启停状态。
   */
  async onModuleInit(): Promise<void> {
    const result = await this.prisma.productPublishClassificationCatalog.createMany({
      data: PRODUCT_PUBLISH_CLASSIFICATIONS.map((classification, sortOrder) => ({
        code: classification.code,
        name: classification.name,
        sortOrder,
      })),
      skipDuplicates: true,
    })
    if (result.count > 0) {
      this.logger.log(`一键上架初始分类目录已补齐 ${result.count} 条`)
    }
  }

  async syncFromFeishu(
    trigger: ProductPublishFeishuSyncTrigger = ProductPublishFeishuSyncTrigger.MANUAL
  ): Promise<ProductPublishStoreSyncResult> {
    const startedAt = new Date()
    const run = await this.prisma.productPublishFeishuSyncRun.create({
      data: {
        trigger,
        status: ProductPublishFeishuSyncStatus.RUNNING,
        startedAt,
      },
      select: { id: true },
    })

    if (!this.feishu.isConfigured()) {
      const message = "飞书店铺同步未启用：缺少 FEISHU_* 配置"
      this.logger.warn(message)
      await this.finishRun(run.id, startedAt, {
        status: ProductPublishFeishuSyncStatus.SKIPPED,
        totalCount: 0,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
        errorMessage: message,
      })
      return {
        runId: run.id,
        configured: false,
        status: ProductPublishFeishuSyncStatus.SKIPPED,
        total: 0,
        created: 0,
        updated: 0,
        failed: 0,
        skipped: 0,
      }
    }

    let records: FeishuBitableRecord[] = []
    let classifications: ClassificationDefinition[] = []
    try {
      const [loadedRecords, loadedClassifications] = await Promise.all([
        this.feishu.searchStoreRecords(),
        this.prisma.productPublishClassificationCatalog.findMany({
          where: { active: true },
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          select: { code: true, name: true, sortOrder: true },
        }),
      ])
      records = loadedRecords
      classifications = loadedClassifications
      if (classifications.length === 0) {
        throw new Error("一键上架分类目录为空，请先导入分类")
      }
    } catch (error: unknown) {
      const message = this.readErrorMessage(error)
      await this.finishRun(run.id, startedAt, {
        status: ProductPublishFeishuSyncStatus.FAILED,
        totalCount: 0,
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
        errorMessage: message,
      })
      throw error
    }

    const seenStoreIds = new Set<string>()
    const failedMessages: string[] = []
    let created = 0
    let updated = 0
    let failed = 0
    let skipped = 0

    for (const record of records) {
      const recordStartedAt = Date.now()
      const normalized = this.normalizeRecord(record)
      if (!normalized.value) {
        const logged = await this.tryLogSkippedRecord(
          run.id,
          record,
          null,
          normalized.reason,
          recordStartedAt
        )
        if (logged) skipped++
        else failed++
        continue
      }

      const store = normalized.value
      if (seenStoreIds.has(store.externalStoreId)) {
        const message = "飞书视图中店铺ID重复，已跳过后续记录"
        const logged = await this.tryLogSkippedRecord(
          run.id,
          record,
          store.externalStoreId,
          message,
          recordStartedAt,
          store.sourceUpdatedAt
        )
        if (logged) skipped++
        else failed++
        this.logger.warn(
          `${message} [storeId=${store.externalStoreId}, recordId=${record.recordId}]`
        )
        continue
      }
      try {
        const action = await this.syncRecord(run.id, store, classifications, recordStartedAt)
        seenStoreIds.add(store.externalStoreId)
        if (action === ProductPublishFeishuSyncAction.CREATED) created++
        else updated++
      } catch (error: unknown) {
        failed++
        const message = this.readErrorMessage(error)
        failedMessages.push(
          `recordId=${record.recordId}, storeId=${store.externalStoreId}: ${message}`
        )
        await this.tryLogFailedRecord(run.id, store, message, recordStartedAt)
      }
    }

    const successful = created + updated
    const status = failed
      ? created + updated > 0
        ? ProductPublishFeishuSyncStatus.PARTIAL_FAILED
        : ProductPublishFeishuSyncStatus.FAILED
      : records.length > 0 && successful === 0 && skipped === records.length
        ? ProductPublishFeishuSyncStatus.SKIPPED
        : ProductPublishFeishuSyncStatus.SUCCESS
    const errorMessage = failed
      ? `共有 ${failed} 条记录同步失败${
          failedMessages.length ? `；${failedMessages.slice(0, 10).join("；")}` : ""
        }`
      : status === ProductPublishFeishuSyncStatus.SKIPPED
        ? "本次飞书视图记录全部被跳过，请检查逐行审计日志"
        : null

    await this.finishRun(run.id, startedAt, {
      status,
      totalCount: records.length,
      successCount: successful,
      failedCount: failed,
      skippedCount: skipped,
      errorMessage,
    })

    const result = {
      runId: run.id,
      configured: true,
      status,
      total: records.length,
      created,
      updated,
      failed,
      skipped,
    }
    this.logger.log(
      `飞书店铺同步完成 [runId=${run.id}, status=${status}, total=${result.total}, created=${created}, updated=${updated}, failed=${failed}, skipped=${skipped}]`
    )
    return result
  }

  private async syncRecord(
    runId: number,
    normalized: NormalizedStoreRecord,
    classifications: ClassificationDefinition[],
    startedAt: number
  ): Promise<ProductPublishFeishuSyncAction> {
    // 飞书数据已在进入循环前完整拉取。这里不用 Prisma 交互式事务，避免远程
    // MySQL 上多次顺序写入超过默认 5 秒事务时限并触发 Query Engine panic。
    // 所有写入均为幂等操作；中途失败会记录 FAILED，下次同步自动补齐。
    const existing = await this.prisma.productPublishStore.findUnique({
      where: { externalStoreId: normalized.externalStoreId },
      select: { id: true },
    })
    const now = new Date()
    const store = await this.prisma.productPublishStore.upsert({
      where: { externalStoreId: normalized.externalStoreId },
      create: { ...normalized, lastSyncedAt: now },
      update: { ...normalized, lastSyncedAt: now },
      select: { id: true },
    })

    await this.prisma.productPublishStoreClassification.createMany({
      data: classifications.map(classification => ({
        storeId: store.id,
        classification: classification.code,
        classificationName: classification.name,
        sortOrder: classification.sortOrder,
      })),
      skipDuplicates: true,
    })

    const action = existing
      ? ProductPublishFeishuSyncAction.UPDATED
      : ProductPublishFeishuSyncAction.CREATED
    await this.prisma.productPublishFeishuSyncRecord.create({
      data: {
        runId,
        feishuRecordId: normalized.feishuRecordId,
        externalStoreId: normalized.externalStoreId,
        status: ProductPublishFeishuSyncRecordStatus.SUCCESS,
        action,
        durationMs: Date.now() - startedAt,
        sourceUpdatedAt: normalized.sourceUpdatedAt,
      },
    })
    return action
  }

  private async tryLogSkippedRecord(
    runId: number,
    record: FeishuBitableRecord,
    externalStoreId: string | null,
    message: string,
    startedAt: number,
    sourceUpdatedAt: Date | null = this.readSourceUpdatedAt(record)
  ): Promise<boolean> {
    try {
      await this.prisma.productPublishFeishuSyncRecord.create({
        data: {
          runId,
          feishuRecordId: record.recordId || null,
          externalStoreId,
          status: ProductPublishFeishuSyncRecordStatus.SKIPPED,
          action: ProductPublishFeishuSyncAction.SKIPPED,
          message,
          durationMs: Date.now() - startedAt,
          sourceUpdatedAt,
        },
      })
      return true
    } catch (error: unknown) {
      this.logger.error(
        `飞书同步跳过记录日志写入失败 [runId=${runId}, recordId=${record.recordId}]: ${this.readErrorMessage(error)}`
      )
      return false
    }
  }

  private async tryLogFailedRecord(
    runId: number,
    normalized: NormalizedStoreRecord,
    message: string,
    startedAt: number
  ): Promise<void> {
    try {
      await this.prisma.productPublishFeishuSyncRecord.create({
        data: {
          runId,
          feishuRecordId: normalized.feishuRecordId,
          externalStoreId: normalized.externalStoreId,
          status: ProductPublishFeishuSyncRecordStatus.FAILED,
          action: null,
          message,
          durationMs: Date.now() - startedAt,
          sourceUpdatedAt: normalized.sourceUpdatedAt,
        },
      })
    } catch (error: unknown) {
      this.logger.error(
        `飞书同步失败记录日志写入失败 [runId=${runId}, recordId=${normalized.feishuRecordId}]: ${this.readErrorMessage(error)}`
      )
    }
  }

  private async finishRun(
    runId: number,
    startedAt: Date,
    data: {
      status: ProductPublishFeishuSyncStatus
      totalCount: number
      successCount: number
      failedCount: number
      skippedCount: number
      errorMessage: string | null
    }
  ): Promise<void> {
    const finishedAt = new Date()
    await this.prisma.productPublishFeishuSyncRun.update({
      where: { id: runId },
      data: {
        ...data,
        finishedAt,
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      },
    })
  }

  private normalizeRecord(record: FeishuBitableRecord): NormalizationResult {
    const rawStoreId = record.fields["店铺ID"]
    if (typeof rawStoreId === "number" && !Number.isSafeInteger(rawStoreId)) {
      const reason = "飞书店铺ID超过 JavaScript 安全整数范围，请将该列改为文本后重试"
      this.logger.warn(`${reason} [recordId=${record.recordId}]`)
      return { value: null, reason }
    }
    const storeId = this.readText(rawStoreId)?.replace(/\s+/g, "")
    if (!storeId || !/^\d{1,32}$/.test(storeId)) {
      const reason = "飞书店铺记录缺少合法店铺ID，已跳过"
      this.logger.warn(`${reason} [recordId=${record.recordId}]`)
      return { value: null, reason }
    }

    const shortName = this.readText(record.fields["店铺简称"])
    const childStore = this.readText(record.fields["子店铺"])
    const name =
      this.readText(record.fields["紫鸟店铺"]) || childStore || shortName || `店铺${storeId}`

    return {
      value: {
        externalStoreId: storeId,
        feishuRecordId: record.recordId,
        sourceUuid: this.readText(record.fields.UUID),
        name,
        shortName,
        companyName: this.readText(record.fields["公司"]),
        platform: this.normalizePlatform(this.readText(record.fields["平台"])),
        storeType: this.readText(record.fields["店铺类型"]),
        accountType: this.readText(record.fields["账号类型"]),
        childStore,
        site: this.readText(record.fields["站点"]),
        remark: this.readText(record.fields["备注"]),
        disabled: this.readBoolean(record.fields["是否禁用"]),
        sourceUpdatedAt: this.readSourceUpdatedAt(record),
      },
    }
  }

  private readSourceUpdatedAt(record: FeishuBitableRecord): Date | null {
    if (typeof record.lastModifiedTime !== "number" || !Number.isFinite(record.lastModifiedTime)) {
      return null
    }
    const timestamp = new Date(record.lastModifiedTime)
    return Number.isNaN(timestamp.getTime()) ? null : timestamp
  }

  private normalizePlatform(value: string | null): string {
    if (!value) return "AMAZON"
    const normalized = value.trim().toUpperCase()
    return normalized === "亚马逊" ? "AMAZON" : normalized
  }

  private readText(value: unknown): string | null {
    if (typeof value === "string") return value.trim() || null
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    if (Array.isArray(value)) {
      const items = value
        .map(item => this.readText(item))
        .filter((item): item is string => item !== null)
      return items.length ? items.join(",") : null
    }
    if (!value || typeof value !== "object") return null

    const record = value as Record<string, unknown>
    for (const key of ["text", "name", "value", "link"]) {
      const text = this.readText(record[key])
      if (text) return text
    }
    return null
  }

  private readBoolean(value: unknown): boolean {
    if (typeof value === "boolean") return value
    if (typeof value === "number") return value !== 0
    const text = this.readText(value)?.trim().toLowerCase()
    if (!text) return false
    return ["true", "1", "yes", "是", "禁用", "已禁用"].includes(text)
  }

  private readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
