import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import {
  Prisma,
  ProductPublishOutcome,
  ProductPublishRpaLogSource,
  ProductPublishRpaLogStatus,
  ProductPublishRpaOperation,
  ProductPublishRpaRunStatus,
  ProductPublishTaskStatus,
  ProductPublishTemplateStatus,
} from "@prisma/client"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import {
  YingdaoProvider,
  YingdaoRequestError,
  YingdaoStartTaskResult,
} from "../common/providers/yingdao.provider"
import { PrismaService } from "../prisma/prisma.service"
import {
  type AmazonFeedStatus,
  ProductPublishEventsService,
} from "./product-publish-events.service"
import {
  buildProductPublishRpaRequest,
  ProductPublishRpaRequest,
} from "./product-publish-rpa.contract"
import { ProductPublishRpaCallbackDto } from "./product-publish.dto"
import { ProductPublishService } from "./product-publish.service"

const DEFAULT_PARAM_NAME = "paramsFile"
const DEFAULT_RUN_TIMEOUT_SECONDS = 3_600
const DEFAULT_CALLBACK_TIMEOUT_SECONDS = 4_200
const POLL_INTERVAL_MS = 5 * 60 * 1_000
const CALLBACK_PROCESSING_STALE_MS = 5 * 60 * 1_000
const DEFAULT_MAX_POLL_ATTEMPTS = 288
const POLL_BATCH_SIZE = 100
const TEMPLATE_REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1_000
const TEMPLATE_FORCE_RETRY_WAIT_MS = 500
const CALLBACK_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 30_000 } as const
const PRODUCT_PUBLISH_PROFILES = ["dev", "dev1", "uat", "prod"] as const

const RPA_STORE_SELECT = {
  id: true,
  externalStoreId: true,
  name: true,
  disabled: true,
  platform: true,
} as const

const RPA_TASK_SELECT = {
  id: true,
  taskId: true,
  userId: true,
  status: true,
  publishStoreId: true,
  classification: true,
  submitRequestId: true,
  resultRequestId: true,
  submittedFileUrl: true,
  spreadsheetUrl: true,
  skus: true,
  uploadId: true,
  rpaTaskUuid: true,
  publishOutcome: true,
  nextPollAt: true,
  pollAttempts: true,
  publishStore: { select: RPA_STORE_SELECT },
} satisfies Prisma.ProductPublishTaskSelect

type RpaTask = Prisma.ProductPublishTaskGetPayload<{ select: typeof RPA_TASK_SELECT }>
type RpaData = Record<string, unknown>

interface DispatchInput {
  operation: ProductPublishRpaOperation
  source: ProductPublishRpaLogSource
  requestId: string
  request: ProductPublishRpaRequest
  runId?: number
  taskId?: number
  storeId?: number
  classification?: string | null
  uploadId?: string | null
}

interface DispatchFailureTarget {
  operation: ProductPublishRpaOperation
  requestId: string
  taskId?: number
  classificationId?: number
}

interface RunCounts {
  total: number
  success: number
  failed: number
  skipped: number
  errors: string[]
}

interface TemplateResult {
  templateUrl: string
}

interface SubmitResult {
  uploadId: string
}

interface QueryResult {
  status: AmazonFeedStatus
  successCount: number
  failedCount: number
  resultFileUrl: string | null
  skuAsinMapping: Array<Record<string, unknown>>
}

interface CallbackClaim {
  duplicate: boolean
  logId?: number
}

@Injectable()
export class ProductPublishRpaService {
  private readonly logger = new Logger(ProductPublishRpaService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly yingdao: YingdaoProvider,
    private readonly productPublishService: ProductPublishService,
    private readonly eventsService: ProductPublishEventsService
  ) {}

  /**
   * 只调起 upload_listing 脚本。Amazon upload_id 由 RPA 后续调用内部结果接口回传。
   * submitRequestId 一旦占用就永久保留，调度或业务失败也不允许重新上架。
   */
  async submitPublish(taskId: string, fileUrl: string, skus: string[], userId: number) {
    this.assertConfigured()
    const normalizedFileUrl = this.requireHttpsUrl(fileUrl, "上架文件 URL")
    const normalizedSkus = this.normalizeSubmittedSkus(skus)
    const task = await this.findOwnedTask(taskId, userId)
    this.assertTaskCanSubmit(task)
    if (!task.spreadsheetUrl) {
      throw new BadRequestException("任务缺少已完成的上架表格 URL")
    }
    const spreadsheetUrl = this.requireHttpsUrl(task.spreadsheetUrl, "任务表格 URL")
    if (this.canonicalFileUrl(normalizedFileUrl) !== this.canonicalFileUrl(spreadsheetUrl)) {
      throw new BadRequestException("fileUrl 必须指向当前任务已完成的上架表格")
    }

    const requestId = randomUUID()
    const now = new Date()
    let claimed: { count: number }
    try {
      claimed = await this.prisma.productPublishTask.updateMany({
        where: {
          id: task.id,
          userId,
          deletedAt: null,
          status: ProductPublishTaskStatus.COMPLETED,
          submitRequestId: null,
          uploadId: null,
        },
        data: {
          submitRequestId: requestId,
          submitCorrelationKey: this.submitCorrelationKey(
            task.publishStore!.externalStoreId,
            normalizedFileUrl
          ),
          skus: this.toJsonValue(normalizedSkus),
          submittedFileUrl: normalizedFileUrl,
          publishSubmittedAt: now,
          publishCompletedAt: null,
          publishOutcome: null,
          successCount: 0,
          failedCount: 0,
          resultFileUrl: null,
          skuAsinMapping: Prisma.DbNull,
          publishErrorMessage: null,
          lastPolledAt: null,
          nextPollAt: null,
          pollAttempts: 0,
        },
      })
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException("该店铺和表格文件已提交过，不允许重复上架")
      }
      throw error
    }
    if (claimed.count !== 1) {
      throw new ConflictException("该任务已提交，不允许重新上架")
    }

    const request = this.buildTaskRequest(task, "upload_listing", {
      file_url: normalizedFileUrl,
    })

    let transport: YingdaoStartTaskResult | null
    try {
      transport = await this.dispatch({
        operation: ProductPublishRpaOperation.SUBMIT_PUBLISH,
        source: ProductPublishRpaLogSource.API,
        requestId,
        request,
        taskId: task.id,
        storeId: task.publishStore!.id,
        classification: task.classification,
      })
    } catch (error: unknown) {
      const message = this.errorMessage(error)
      const recorded = await this.failDispatchAndBusiness(
        {
          operation: ProductPublishRpaOperation.SUBMIT_PUBLISH,
          requestId,
          taskId: task.id,
        },
        message
      )
      if (!recorded) {
        transport = null
      } else {
        throw new BadGatewayException(
          `上架脚本调度失败且任务已锁定，禁止重新提交，请通过日志排查：${message}`
        )
      }
    }

    if (transport) {
      try {
        await this.prisma.productPublishTask.updateMany({
          where: { id: task.id, submitRequestId: requestId, uploadId: null },
          data: {
            rpaTaskUuid: transport.taskUuid,
            rpaJobUuidList: this.toJsonValue(transport.jobUuidList),
          },
        })
      } catch (error: unknown) {
        this.logger.error(
          `上架脚本已调起，但任务调度标识保存失败 taskId=${task.taskId}: ${this.errorMessage(error)}`
        )
      }
    }

    return {
      success: true,
      accepted: true,
      requestId,
      message: transport
        ? "上架脚本已调起，等待 RPA 回传 Amazon 文件批次 ID"
        : "影刀启动结果未知，已锁定任务并等待可能到达的 RPA 回调",
      task: await this.productPublishService.findTask(task.taskId, userId),
    }
  }

  /** 前端主动触发 check_feed_status 脚本；结果由 RPA 异步回传。 */
  async refreshPublishResult(taskId: string, userId: number) {
    this.assertConfigured()
    const task = await this.findOwnedTask(taskId, userId)
    const skus = this.assertTaskCanQuery(task)
    this.assertPollDue(task)

    const requestId = randomUUID()
    await this.claimPoll(task, requestId)
    const request = this.buildTaskRequest(task, "check_feed_status", {
      upload_id: task.uploadId!,
      skus,
    })

    let transport: YingdaoStartTaskResult | null
    try {
      transport = await this.dispatch({
        operation: ProductPublishRpaOperation.QUERY_RESULT,
        source: ProductPublishRpaLogSource.API,
        requestId,
        request,
        taskId: task.id,
        storeId: task.publishStore!.id,
        classification: task.classification,
        uploadId: task.uploadId,
      })
    } catch (error: unknown) {
      const message = this.errorMessage(error)
      const recorded = await this.failDispatchAndBusiness(
        {
          operation: ProductPublishRpaOperation.QUERY_RESULT,
          requestId,
          taskId: task.id,
        },
        message
      )
      if (recorded) throw new BadGatewayException(`刷新脚本调度失败：${message}`)
      transport = null
    }

    return {
      success: true,
      accepted: true,
      requestId,
      message: transport
        ? "查询脚本已调起，等待 RPA 回传处理结果"
        : "影刀启动结果未知，已保留查询锁并等待可能到达的 RPA 回调",
      task: await this.productPublishService.findTask(task.taskId, userId),
    }
  }

  /** 每天为到期的启用 Amazon 店铺分类调起 download_listing 脚本。 */
  async refreshTemplates() {
    return this.refreshTemplateBatch(false, ProductPublishRpaLogSource.CRON)
  }

  /** 手动强制刷新全部启用 Amazon 店铺的全部分类，不受最近同步时间限制。 */
  async refreshAllTemplatesOnce() {
    return this.refreshTemplateBatch(true, ProductPublishRpaLogSource.API)
  }

  private async refreshTemplateBatch(forceAll: boolean, source: ProductPublishRpaLogSource) {
    const startedAt = new Date()
    const run = await this.createRun(ProductPublishRpaOperation.FETCH_TEMPLATE, startedAt)
    const counts = this.emptyRunCounts()

    try {
      this.assertConfigured()
      await this.expirePendingCallbacks()
      const templates = await this.prisma.productPublishStoreClassification.findMany({
        where: { store: { disabled: false, platform: "AMAZON" } },
        select: {
          id: true,
          storeId: true,
          classification: true,
          templateRequestId: true,
          templateSyncedAt: true,
          store: { select: RPA_STORE_SELECT },
        },
        orderBy: [{ storeId: "asc" }, { sortOrder: "asc" }],
      })
      counts.total = templates.length

      const refreshBefore = new Date(Date.now() - TEMPLATE_REFRESH_INTERVAL_MS)
      for (const template of templates) {
        const requestId = await this.claimTemplateRefresh(template.id, forceAll, refreshBefore)
        if (!requestId) {
          counts.skipped++
          continue
        }

        const request = buildProductPublishRpaRequest({
          businessId: template.store.externalStoreId,
          taskType: "download_listing",
          taskParam: { category: template.classification },
        })

        let transport: YingdaoStartTaskResult | null
        try {
          transport = await this.dispatch({
            operation: ProductPublishRpaOperation.FETCH_TEMPLATE,
            source,
            runId: run.id,
            requestId,
            request,
            storeId: template.storeId,
            classification: template.classification,
          })
        } catch (error: unknown) {
          const message = this.errorMessage(error)
          const recorded = await this.failDispatchAndBusiness(
            {
              operation: ProductPublishRpaOperation.FETCH_TEMPLATE,
              requestId,
              classificationId: template.id,
            },
            message
          )
          if (!recorded) {
            counts.skipped++
            continue
          }
          counts.failed++
          counts.errors.push(
            `${template.store.externalStoreId}/${template.classification}: ${message}`
          )
          this.logger.warn(
            `店铺模板脚本调度失败 store=${template.store.externalStoreId} category=${template.classification}: ${message}`
          )
          continue
        }

        if (transport) {
          counts.success++
          this.logger.log(
            `店铺模板脚本已调起 [${counts.success + counts.failed + counts.skipped}/${counts.total}] store=${template.store.externalStoreId} category=${template.classification}`
          )
          try {
            await this.prisma.productPublishStoreClassification.updateMany({
              where: { id: template.id, templateRequestId: requestId },
              data: { rpaTaskUuid: transport.taskUuid },
            })
          } catch (error: unknown) {
            this.logger.error(
              `模板脚本已调起，但调度标识保存失败 store=${template.store.externalStoreId} category=${template.classification}: ${this.errorMessage(error)}`
            )
          }
        } else {
          counts.failed++
          counts.errors.push(
            `${template.store.externalStoreId}/${template.classification}: 影刀启动结果未知，保留请求等待回调`
          )
        }
      }

      await this.finishRun(run.id, startedAt, counts)
      return this.runResult(run.id, counts)
    } catch (error: unknown) {
      await this.failRun(run.id, startedAt, counts, error)
      throw error
    }
  }

  /**
   * Cron 只尝试一次并跳过已有请求；手动全量同步必须等到旧回调事务结束、释放旧请求并取得新锁。
   */
  private async claimTemplateRefresh(
    classificationId: number,
    forceAll: boolean,
    refreshBefore: Date
  ): Promise<string | null> {
    do {
      const current = await this.prisma.productPublishStoreClassification.findUnique({
        where: { id: classificationId },
        select: { templateRequestId: true },
      })
      if (!current) throw new NotFoundException("店铺分类不存在")

      if (current.templateRequestId) {
        if (!forceAll) return null
        const released = await this.releaseTemplateRequestForRetry(
          classificationId,
          current.templateRequestId
        )
        if (!released) {
          await delay(TEMPLATE_FORCE_RETRY_WAIT_MS)
          await this.expirePendingCallbacks()
          continue
        }
      }

      const requestId = randomUUID()
      const claimed = await this.prisma.productPublishStoreClassification.updateMany({
        where: {
          id: classificationId,
          templateRequestId: null,
          ...(forceAll
            ? {}
            : {
                OR: [{ templateSyncedAt: null }, { templateSyncedAt: { lte: refreshBefore } }],
              }),
        },
        data: {
          templateRequestId: requestId,
          templateStatus: ProductPublishTemplateStatus.PENDING,
          lastSyncError: null,
        },
      })
      if (claimed.count === 1) return requestId
      if (!forceAll) return null

      await delay(TEMPLATE_FORCE_RETRY_WAIT_MS)
    } while (forceAll)

    return null
  }

  /** 每 5 分钟为待查询任务调起 check_feed_status 脚本。 */
  async pollPublishingTasks() {
    const startedAt = new Date()
    const run = await this.createRun(ProductPublishRpaOperation.QUERY_RESULT, startedAt)
    const counts = this.emptyRunCounts()

    try {
      this.assertConfigured()
      await this.expirePendingCallbacks()
      const now = new Date()
      const tasks = await this.prisma.productPublishTask.findMany({
        where: {
          status: ProductPublishTaskStatus.PUBLISHING,
          uploadId: { not: null },
          publishOutcome: null,
          resultRequestId: null,
          OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }],
        },
        select: RPA_TASK_SELECT,
        orderBy: [{ nextPollAt: "asc" }, { id: "asc" }],
        take: POLL_BATCH_SIZE,
      })
      counts.total = tasks.length

      for (const task of tasks) {
        if (
          !task.publishStore ||
          task.publishStore.disabled ||
          task.publishStore.platform !== "AMAZON"
        ) {
          const message = "任务关联的 Amazon 店铺不存在或已禁用"
          counts.failed++
          counts.errors.push(`${task.taskId}: ${message}`)
          await this.failPublishingTask(task, message)
          continue
        }
        if (task.pollAttempts >= this.maxPollAttempts()) {
          if (await this.markPollTimedOut(task)) {
            counts.failed++
            counts.errors.push(`${task.taskId}: 超过最大查询次数`)
          } else {
            counts.skipped++
          }
          continue
        }

        let skus: string[]
        try {
          skus = this.requireTaskSkus(task.skus)
        } catch (error: unknown) {
          const message = this.errorMessage(error)
          counts.failed++
          counts.errors.push(`${task.taskId}: ${message}`)
          await this.failPublishingTask(task, message)
          continue
        }

        const requestId = randomUUID()
        if (!(await this.tryClaimPoll(task, requestId))) {
          counts.skipped++
          continue
        }
        const request = this.buildTaskRequest(task, "check_feed_status", {
          upload_id: task.uploadId!,
          skus,
        })

        try {
          const transport = await this.dispatch({
            operation: ProductPublishRpaOperation.QUERY_RESULT,
            source: ProductPublishRpaLogSource.CRON,
            runId: run.id,
            requestId,
            request,
            taskId: task.id,
            storeId: task.publishStore.id,
            classification: task.classification,
            uploadId: task.uploadId,
          })
          if (transport) {
            counts.success++
          } else {
            counts.failed++
            counts.errors.push(`${task.taskId}: 影刀启动结果未知，保留请求等待回调`)
          }
        } catch (error: unknown) {
          const message = this.errorMessage(error)
          const recorded = await this.failDispatchAndBusiness(
            {
              operation: ProductPublishRpaOperation.QUERY_RESULT,
              requestId,
              taskId: task.id,
            },
            message
          )
          if (!recorded) {
            counts.skipped++
            continue
          }
          counts.failed++
          counts.errors.push(`${task.taskId}: ${message}`)
          this.logger.warn(`上架结果查询脚本调度失败 taskId=${task.taskId}: ${message}`)
        }
      }

      await this.finishRun(run.id, startedAt, counts)
      return this.runResult(run.id, counts)
    } catch (error: unknown) {
      await this.failRun(run.id, startedAt, counts, error)
      throw error
    }
  }

  /** RPA 脚本执行结束后，使用 X-API-Key 主动提交业务结果。 */
  async handleCallback(apiKey: string | undefined, dto: ProductPublishRpaCallbackDto) {
    this.authenticateCallback(apiKey)
    this.validateCallbackEnvelope(dto)
    const data = this.requireRecord(dto.data, "RPA 回调 data 必须是对象")
    const taskType = this.requireString(data, "task_type", 50)

    if (taskType === "download_listing") return this.handleTemplateCallback(dto, data)
    if (taskType === "upload_listing") return this.handleSubmitCallback(dto, data)
    if (taskType === "check_feed_status") return this.handleQueryCallback(dto, data)
    throw new BadRequestException("RPA 回调 task_type 不受支持")
  }

  private async handleTemplateCallback(dto: ProductPublishRpaCallbackDto, data: RpaData) {
    const businessId = this.requireBusinessId(data)
    const category = this.requireString(data, "category", 100)
    const template = await this.prisma.productPublishStoreClassification.findFirst({
      where: {
        classification: category,
        store: { externalStoreId: businessId },
      },
      select: {
        id: true,
        templateRequestId: true,
        templateUrl: true,
        templateStatus: true,
      },
    })
    if (!template) throw new NotFoundException("RPA 回调对应的店铺分类不存在")

    const result = dto.ok ? this.parseTemplateResult(data, businessId, category) : null
    const requestId = this.resolveCallbackRequestId(template.templateRequestId, dto.request_id)
    if (!requestId) {
      return this.duplicateCallback("download_listing")
    }

    const claim = await this.beginCallback(
      requestId,
      ProductPublishRpaOperation.FETCH_TEMPLATE,
      dto
    )
    if (claim.duplicate) return this.duplicateCallback("download_listing", requestId)

    try {
      const errorMessage = dto.ok ? null : this.callbackErrorMessage(dto.error)
      await this.prisma.$transaction(async tx => {
        const updated = await tx.productPublishStoreClassification.updateMany({
          where: { id: template.id, templateRequestId: requestId },
          data: dto.ok
            ? {
                templateRequestId: null,
                templateUrl: result!.templateUrl,
                templateStatus: ProductPublishTemplateStatus.SUCCESS,
                templateSyncedAt: new Date(),
                lastSyncError: null,
              }
            : {
                templateRequestId: null,
                templateStatus: ProductPublishTemplateStatus.FAILED,
                lastSyncError: errorMessage,
              },
        })
        if (updated.count !== 1) {
          throw new ConflictException("模板请求状态已变化，回调未覆盖")
        }
        await this.finishCallback(tx, claim.logId!, dto, dto.ok, errorMessage)
      }, CALLBACK_TRANSACTION_OPTIONS)
      return this.callbackResult("download_listing", requestId, dto.ok)
    } catch (error: unknown) {
      await this.releaseCallback(claim.logId!, error)
      throw error
    }
  }

  private async handleSubmitCallback(dto: ProductPublishRpaCallbackDto, data: RpaData) {
    const businessId = this.requireBusinessId(data)
    const fileUrl = this.requireHttpsUrl(
      this.requireString(data, "file_url", 1_000),
      "RPA 回调 file_url"
    )
    const result = dto.ok ? this.parseSubmitResult(data, businessId) : null
    const correlationKey = this.submitCorrelationKey(businessId, fileUrl)
    const tasks = await this.prisma.productPublishTask.findMany({
      where: {
        submitCorrelationKey: correlationKey,
        publishStore: { externalStoreId: businessId },
      },
      select: RPA_TASK_SELECT,
      orderBy: { id: "desc" },
      take: 10,
    })
    if (tasks.length === 0) throw new NotFoundException("RPA 回调对应的上架任务不存在")

    let candidates = tasks.filter(
      task => task.submitRequestId && task.uploadId === null && task.publishOutcome === null
    )
    if (dto.request_id) {
      candidates = tasks.filter(task => task.submitRequestId === dto.request_id)
    }
    if (candidates.length === 0) {
      if (result && tasks.some(task => task.uploadId === result.uploadId)) {
        return this.duplicateCallback("upload_listing", dto.request_id)
      }
      await this.assertTerminalCallbackIfSupplied(
        dto.request_id,
        ProductPublishRpaOperation.SUBMIT_PUBLISH
      )
      return this.duplicateCallback("upload_listing", dto.request_id)
    }
    if (candidates.length > 1) {
      throw new ConflictException("同一店铺和文件 URL 存在多个待回调任务，无法安全关联")
    }

    const task = candidates[0]
    const requestId = this.resolveCallbackRequestId(task.submitRequestId, dto.request_id)
    if (!requestId) return this.duplicateCallback("upload_listing")
    const claim = await this.beginCallback(
      requestId,
      ProductPublishRpaOperation.SUBMIT_PUBLISH,
      dto
    )
    if (claim.duplicate) return this.duplicateCallback("upload_listing", requestId)

    try {
      const errorMessage = dto.ok ? null : this.callbackErrorMessage(dto.error)
      try {
        await this.prisma.$transaction(async tx => {
          const updated = await tx.productPublishTask.updateMany({
            where: {
              id: task.id,
              submitRequestId: requestId,
              uploadId: null,
              publishOutcome: null,
            },
            data: dto.ok
              ? {
                  status: ProductPublishTaskStatus.PUBLISHING,
                  uploadId: result!.uploadId,
                  nextPollAt: new Date(),
                  publishCompletedAt: null,
                  publishErrorMessage: null,
                }
              : {
                  status: ProductPublishTaskStatus.COMPLETED,
                  publishOutcome: ProductPublishOutcome.FAILED,
                  publishCompletedAt: new Date(),
                  nextPollAt: null,
                  publishErrorMessage: errorMessage,
                },
          })
          if (updated.count !== 1) {
            throw new ConflictException("上架请求状态已变化，回调未覆盖")
          }
          await this.finishCallback(tx, claim.logId!, dto, dto.ok, errorMessage, result?.uploadId)
        }, CALLBACK_TRANSACTION_OPTIONS)
      } catch (error: unknown) {
        if (this.isUniqueConstraintError(error)) {
          throw new ConflictException("Amazon upload_id 已关联其他上架任务")
        }
        throw error
      }
      return this.callbackResult("upload_listing", requestId, dto.ok)
    } catch (error: unknown) {
      await this.releaseCallback(claim.logId!, error)
      throw error
    }
  }

  private async handleQueryCallback(dto: ProductPublishRpaCallbackDto, data: RpaData) {
    const businessId = this.requireBusinessId(data)
    const uploadId = this.requireUploadId(data)
    const task = await this.prisma.productPublishTask.findFirst({
      where: { uploadId },
      select: RPA_TASK_SELECT,
    })
    if (!task || !task.publishStore) {
      throw new NotFoundException("RPA 回调对应的 Amazon 文件批次不存在")
    }
    if (task.publishStore.externalStoreId !== businessId) {
      throw new BadRequestException("RPA 回调 business_id 与文件批次所属店铺不匹配")
    }
    const result = dto.ok ? this.parseQueryResult(data, businessId, uploadId) : null
    if (result) {
      const requestedSkus = this.readOptionalTaskSkus(task.skus)
      if (requestedSkus) {
        this.assertSkuMappingMatchesRequested(result.skuAsinMapping, requestedSkus)
      }
    }
    const requestId = this.resolveCallbackRequestId(task.resultRequestId, dto.request_id)
    if (!requestId) {
      await this.assertTerminalCallbackIfSupplied(
        dto.request_id,
        ProductPublishRpaOperation.QUERY_RESULT
      )
      return this.duplicateCallback("check_feed_status", dto.request_id)
    }

    const claim = await this.beginCallback(requestId, ProductPublishRpaOperation.QUERY_RESULT, dto)
    if (claim.duplicate) return this.duplicateCallback("check_feed_status", requestId)

    try {
      const errorMessage = dto.ok ? null : this.callbackErrorMessage(dto.error)
      await this.prisma.$transaction(async tx => {
        const updated = dto.ok
          ? await this.applyQueryResult(tx, task, requestId, result!)
          : await tx.productPublishTask.updateMany({
              where: {
                id: task.id,
                status: ProductPublishTaskStatus.PUBLISHING,
                uploadId,
                resultRequestId: requestId,
                publishOutcome: null,
              },
              data: {
                resultRequestId: null,
                publishErrorMessage: errorMessage,
                nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS),
              },
            })
        if (updated.count !== 1) {
          throw new ConflictException("查询请求状态已变化，回调未覆盖")
        }
        await this.finishCallback(tx, claim.logId!, dto, dto.ok, errorMessage, uploadId)
      }, CALLBACK_TRANSACTION_OPTIONS)
      const terminal = result
        ? (["SUCCESS", "PARTIAL_SUCCESS", "FAILED"] as AmazonFeedStatus[]).includes(result.status)
        : false
      this.eventsService.publishRefreshCompleted(task.userId, {
        taskId: task.taskId,
        requestId,
        callbackOk: dto.ok,
        amazonStatus: result?.status ?? null,
        taskStatus: terminal
          ? ProductPublishTaskStatus.COMPLETED
          : ProductPublishTaskStatus.PUBLISHING,
        publishOutcome: terminal ? (result!.status as ProductPublishOutcome) : null,
        receivedAt: new Date().toISOString(),
      })
      return this.callbackResult("check_feed_status", requestId, dto.ok)
    } catch (error: unknown) {
      await this.releaseCallback(claim.logId!, error)
      throw error
    }
  }

  /** 调度接口只负责启动脚本；业务结果不在 startTask 响应中读取。 */
  private async dispatch(input: DispatchInput): Promise<YingdaoStartTaskResult | null> {
    const startedAt = Date.now()
    const log = await this.prisma.productPublishRpaLog.create({
      data: {
        operation: input.operation,
        source: input.source,
        runId: input.runId,
        taskId: input.taskId,
        storeId: input.storeId,
        classification: input.classification,
        requestId: input.requestId,
        idempotentUuid: input.requestId,
        uploadId: input.uploadId,
        requestPayload: this.toJsonValue(this.sanitizeRequest(input.request)),
        status: ProductPublishRpaLogStatus.DISPATCHING,
        expiresAt: new Date(startedAt + this.callbackTimeoutSeconds() * 1_000),
        success: false,
      },
      select: { id: true },
    })

    const fileContent = Buffer.from(JSON.stringify(input.request), "utf8")
    const uploaded = await this.yingdao.uploadFile(
      fileContent,
      `product-publish-${input.requestId}.txt`
    )
    const fileKey = uploaded.fileKey

    let response: YingdaoStartTaskResult
    try {
      response = await this.yingdao.startTask({
        scheduleUuid: this.requiredConfig("YINGDAO_PRODUCT_PUBLISH_TASK_UUID"),
        idempotentUuid: input.requestId,
        scheduleRelaParams: [
          {
            robotUuid: this.requiredConfig("YINGDAO_PRODUCT_PUBLISH_APP_ID"),
            runTimeout: this.runTimeoutSeconds(),
            params: [
              {
                name: this.paramName(),
                value: fileKey,
                type: "file",
              },
              {
                name: "profile",
                value: this.profile(),
                type: "string",
              },
            ],
          },
        ],
      })
    } catch (error: unknown) {
      if (this.isAmbiguousDispatchError(error)) {
        const message = `影刀启动请求结果未知，保留业务锁等待回调：${this.errorMessage(error)}`
        try {
          await this.prisma.productPublishRpaLog.updateMany({
            where: { id: log.id, status: ProductPublishRpaLogStatus.DISPATCHING },
            data: {
              status: ProductPublishRpaLogStatus.WAITING_CALLBACK,
              success: false,
              durationMs: Date.now() - startedAt,
              dispatchDurationMs: Date.now() - startedAt,
              errorMessage: message,
            },
          })
        } catch (logError: unknown) {
          this.logger.error(
            `RPA 未知调度状态日志更新失败 logId=${log.id}: ${this.errorMessage(logError)}`
          )
        }
        this.logger.warn(`RPA ${message} requestId=${input.requestId}`)
        return null
      }

      throw error
    }

    try {
      const dispatchedAt = new Date()
      const transportLogData = {
        rpaTaskUuid: response.taskUuid,
        rpaJobUuidList: this.toJsonValue(response.jobUuidList),
        dispatchResponsePayload: this.toJsonValue(response),
        dispatchedAt,
        httpStatus: 200,
        dispatchDurationMs: dispatchedAt.getTime() - startedAt,
      }
      const dispatchLogData = {
        ...transportLogData,
        durationMs: dispatchedAt.getTime() - startedAt,
        errorMessage: null,
      }
      const updated = await this.prisma.productPublishRpaLog.updateMany({
        where: { id: log.id, status: ProductPublishRpaLogStatus.DISPATCHING },
        data: {
          ...dispatchLogData,
          status: ProductPublishRpaLogStatus.WAITING_CALLBACK,
        },
      })
      // 极快的脚本可能在 startTask 返回后立刻回调；此时只补调度字段，不回退日志状态。
      if (updated.count === 0) {
        await this.prisma.productPublishRpaLog.updateMany({
          where: { id: log.id },
          data: transportLogData,
        })
      }
    } catch (error: unknown) {
      this.logger.error(`RPA 调度成功日志更新失败 logId=${log.id}: ${this.errorMessage(error)}`)
    }
    return response
  }

  /**
   * 确定性调度失败时，在同一短事务中终结审计日志并处理业务锁。
   * 如果回调已抢先进入处理或终态，则不覆盖回调结果，由调用方按已受理处理。
   */
  private async failDispatchAndBusiness(
    target: DispatchFailureTarget,
    message: string
  ): Promise<boolean> {
    const now = new Date()
    return this.prisma.$transaction(async tx => {
      const log = await tx.productPublishRpaLog.findUnique({
        where: { requestId: target.requestId },
        select: { id: true, status: true, createdAt: true },
      })
      const activeStatuses: ProductPublishRpaLogStatus[] = [
        ProductPublishRpaLogStatus.DISPATCHING,
        ProductPublishRpaLogStatus.WAITING_CALLBACK,
      ]
      if (log && !activeStatuses.includes(log.status)) return false

      if (log) {
        const failedLog = await tx.productPublishRpaLog.updateMany({
          where: { id: log.id, status: { in: activeStatuses } },
          data: {
            status: ProductPublishRpaLogStatus.FAILED,
            success: false,
            durationMs: now.getTime() - log.createdAt.getTime(),
            dispatchDurationMs: now.getTime() - log.createdAt.getTime(),
            errorMessage: message,
          },
        })
        if (failedLog.count !== 1) return false
      }

      let businessUpdate: { count: number }
      if (target.operation === ProductPublishRpaOperation.FETCH_TEMPLATE) {
        if (target.classificationId === undefined) throw new Error("模板调度失败缺少分类 ID")
        businessUpdate = await tx.productPublishStoreClassification.updateMany({
          where: {
            id: target.classificationId,
            templateRequestId: target.requestId,
          },
          data: {
            templateRequestId: null,
            templateStatus: ProductPublishTemplateStatus.FAILED,
            lastSyncError: message,
          },
        })
      } else if (target.operation === ProductPublishRpaOperation.SUBMIT_PUBLISH) {
        if (target.taskId === undefined) throw new Error("上架调度失败缺少任务 ID")
        businessUpdate = await tx.productPublishTask.updateMany({
          where: {
            id: target.taskId,
            submitRequestId: target.requestId,
            uploadId: null,
          },
          data: {
            status: ProductPublishTaskStatus.COMPLETED,
            publishOutcome: ProductPublishOutcome.FAILED,
            publishCompletedAt: now,
            nextPollAt: null,
            publishErrorMessage: message,
          },
        })
      } else {
        if (target.taskId === undefined) throw new Error("查询调度失败缺少任务 ID")
        businessUpdate = await tx.productPublishTask.updateMany({
          where: {
            id: target.taskId,
            status: ProductPublishTaskStatus.PUBLISHING,
            resultRequestId: target.requestId,
            publishOutcome: null,
          },
          data: {
            resultRequestId: null,
            publishErrorMessage: message,
            nextPollAt: new Date(now.getTime() + POLL_INTERVAL_MS),
          },
        })
      }

      if (businessUpdate.count !== 1) {
        if (!log) return false
        throw new ConflictException("RPA 调度失败时业务状态已变化，已回滚日志终态")
      }
      return true
    }, CALLBACK_TRANSACTION_OPTIONS)
  }

  private isAmbiguousDispatchError(error: unknown): boolean {
    if (error instanceof YingdaoRequestError) {
      if (error.operation !== "启动影刀任务") return false
      if (error.httpStatus === undefined) return true
      if (error.httpStatus === 408 || error.httpStatus === 429) return true
      if (error.httpStatus >= 500) return true
      return false
    }
    const message = this.errorMessage(error).toLowerCase()
    return [
      "timeout",
      "timed out",
      "econnaborted",
      "etimedout",
      "econnreset",
      "socket hang up",
      "network error",
      "超时",
      "连接重置",
    ].some(keyword => message.includes(keyword))
  }

  private async beginCallback(
    requestId: string,
    operation: ProductPublishRpaOperation,
    dto: ProductPublishRpaCallbackDto
  ): Promise<CallbackClaim> {
    const log = await this.prisma.productPublishRpaLog.findUnique({
      where: { requestId },
      select: {
        id: true,
        operation: true,
        status: true,
        createdAt: true,
        callbackReceivedAt: true,
      },
    })
    if (!log) throw new NotFoundException("RPA 回调关联请求不存在")
    if (log.operation !== operation) {
      throw new ConflictException("RPA 回调 task_type 与原调度操作不匹配")
    }
    if (this.isTerminalLogStatus(log.status)) return { duplicate: true }

    const now = new Date()
    if (
      log.status === ProductPublishRpaLogStatus.PROCESSING_CALLBACK &&
      log.callbackReceivedAt &&
      log.callbackReceivedAt.getTime() <= now.getTime() - CALLBACK_PROCESSING_STALE_MS
    ) {
      const reclaimed = await this.prisma.productPublishRpaLog.updateMany({
        where: {
          id: log.id,
          status: ProductPublishRpaLogStatus.PROCESSING_CALLBACK,
          callbackReceivedAt: log.callbackReceivedAt,
        },
        data: {
          callbackReceivedAt: now,
          responsePayload: this.toJsonValue(this.sanitizeCallback(dto)),
          durationMs: now.getTime() - log.createdAt.getTime(),
          errorMessage: "检测到上次回调处理中断，已由本次重试接管",
        },
      })
      if (reclaimed.count === 1) return { duplicate: false, logId: log.id }
    }

    const claimed = await this.prisma.productPublishRpaLog.updateMany({
      where: {
        id: log.id,
        status: {
          in: [ProductPublishRpaLogStatus.DISPATCHING, ProductPublishRpaLogStatus.WAITING_CALLBACK],
        },
      },
      data: {
        status: ProductPublishRpaLogStatus.PROCESSING_CALLBACK,
        callbackReceivedAt: now,
        responsePayload: this.toJsonValue(this.sanitizeCallback(dto)),
        durationMs: now.getTime() - log.createdAt.getTime(),
      },
    })
    if (claimed.count === 1) return { duplicate: false, logId: log.id }

    const latest = await this.prisma.productPublishRpaLog.findUnique({
      where: { requestId },
      select: { status: true },
    })
    if (latest && this.isTerminalLogStatus(latest.status)) return { duplicate: true }
    throw new ConflictException("该 RPA 回调正在处理中，请勿并发重复提交")
  }

  private async finishCallback(
    tx: Prisma.TransactionClient,
    logId: number,
    dto: ProductPublishRpaCallbackDto,
    success: boolean,
    errorMessage: string | null,
    uploadId?: string
  ): Promise<void> {
    const now = new Date()
    const updated = await tx.productPublishRpaLog.updateMany({
      where: { id: logId, status: ProductPublishRpaLogStatus.PROCESSING_CALLBACK },
      data: {
        status: success ? ProductPublishRpaLogStatus.SUCCESS : ProductPublishRpaLogStatus.FAILED,
        responsePayload: this.toJsonValue(this.sanitizeCallback(dto)),
        callbackReceivedAt: now,
        ...(uploadId ? { uploadId } : {}),
        success,
        errorMessage,
      },
    })
    if (updated.count !== 1) {
      throw new ConflictException("RPA 回调日志状态已变化，业务结果未提交")
    }
  }

  private async releaseCallback(logId: number, error: unknown): Promise<void> {
    try {
      await this.prisma.productPublishRpaLog.updateMany({
        where: { id: logId, status: ProductPublishRpaLogStatus.PROCESSING_CALLBACK },
        data: {
          status: ProductPublishRpaLogStatus.WAITING_CALLBACK,
          success: false,
          errorMessage: `回调落库失败，可重试：${this.errorMessage(error)}`,
        },
      })
    } catch (logError: unknown) {
      this.logger.error(`RPA 回调失败日志恢复失败 logId=${logId}: ${this.errorMessage(logError)}`)
    }
  }

  private async assertTerminalCallbackIfSupplied(
    requestId: string | undefined,
    operation: ProductPublishRpaOperation
  ): Promise<void> {
    if (!requestId) return
    const log = await this.prisma.productPublishRpaLog.findUnique({
      where: { requestId },
      select: { operation: true, status: true },
    })
    if (!log) throw new NotFoundException("RPA 回调关联请求不存在")
    if (log.operation !== operation) throw new ConflictException("RPA 回调操作与原请求不匹配")
    if (!this.isTerminalLogStatus(log.status)) {
      throw new ConflictException("RPA 回调对应业务记录不再处于待处理状态")
    }
  }

  private async expirePendingCallbacks(): Promise<number> {
    const now = new Date()
    const processingBefore = new Date(now.getTime() - CALLBACK_PROCESSING_STALE_MS)
    const logs = await this.prisma.productPublishRpaLog.findMany({
      where: {
        OR: [
          {
            expiresAt: { lte: now },
            status: {
              in: [
                ProductPublishRpaLogStatus.DISPATCHING,
                ProductPublishRpaLogStatus.WAITING_CALLBACK,
              ],
            },
          },
          {
            status: ProductPublishRpaLogStatus.PROCESSING_CALLBACK,
            callbackReceivedAt: { lte: processingBefore },
          },
        ],
      },
      select: {
        id: true,
        requestId: true,
        operation: true,
        status: true,
        taskId: true,
        callbackReceivedAt: true,
        expiresAt: true,
      },
      take: 500,
    })

    let expired = 0
    for (const log of logs) {
      if (!log.requestId) continue
      if (
        log.status === ProductPublishRpaLogStatus.PROCESSING_CALLBACK &&
        log.expiresAt &&
        log.expiresAt.getTime() > now.getTime()
      ) {
        await this.prisma.productPublishRpaLog.updateMany({
          where: {
            id: log.id,
            status: ProductPublishRpaLogStatus.PROCESSING_CALLBACK,
            callbackReceivedAt: log.callbackReceivedAt,
          },
          data: {
            status: ProductPublishRpaLogStatus.WAITING_CALLBACK,
            callbackReceivedAt: null,
            success: false,
            errorMessage: "回调处理租约超时，已释放等待 RPA 重试",
          },
        })
        continue
      }
      const message = `等待 RPA 业务回调超过 ${this.callbackTimeoutSeconds()} 秒`
      const didExpire = await this.prisma.$transaction(async tx => {
        const claimed = await tx.productPublishRpaLog.updateMany({
          where: { id: log.id, status: log.status },
          data: {
            status: ProductPublishRpaLogStatus.TIMEOUT,
            success: false,
            errorMessage: message,
          },
        })
        if (claimed.count !== 1) return false

        if (log.operation === ProductPublishRpaOperation.FETCH_TEMPLATE) {
          await tx.productPublishStoreClassification.updateMany({
            where: { templateRequestId: log.requestId },
            data: {
              templateRequestId: null,
              templateStatus: ProductPublishTemplateStatus.FAILED,
              lastSyncError: message,
            },
          })
        } else if (log.operation === ProductPublishRpaOperation.SUBMIT_PUBLISH) {
          await tx.productPublishTask.updateMany({
            where: { submitRequestId: log.requestId, uploadId: null },
            data: {
              status: ProductPublishTaskStatus.COMPLETED,
              publishOutcome: ProductPublishOutcome.TIMEOUT,
              publishCompletedAt: now,
              nextPollAt: null,
              publishErrorMessage: message,
            },
          })
        } else {
          await tx.productPublishTask.updateMany({
            where: {
              resultRequestId: log.requestId,
              status: ProductPublishTaskStatus.PUBLISHING,
              publishOutcome: null,
            },
            data: {
              resultRequestId: null,
              nextPollAt: now,
              publishErrorMessage: message,
            },
          })
        }
        return true
      })
      if (didExpire) expired++
    }
    return expired
  }

  /**
   * download_listing 是只读模板获取操作，手动全量同步可安全重试。
   * 若旧回调正在事务处理中则不抢占；其余等待/孤儿锁统一终结审计并释放业务锁。
   */
  private async releaseTemplateRequestForRetry(
    classificationId: number,
    requestId: string
  ): Promise<boolean> {
    const message = "手动全量模板同步重新运行，旧等待请求已终止并重新调度"
    return this.prisma.$transaction(async tx => {
      const log = await tx.productPublishRpaLog.findUnique({
        where: { requestId },
        select: { id: true, operation: true, status: true },
      })
      if (log) {
        if (log.operation !== ProductPublishRpaOperation.FETCH_TEMPLATE) return false
        if (log.status === ProductPublishRpaLogStatus.PROCESSING_CALLBACK) return false
        if (!this.isTerminalLogStatus(log.status)) {
          const ended = await tx.productPublishRpaLog.updateMany({
            where: { id: log.id, status: log.status },
            data: {
              status: ProductPublishRpaLogStatus.TIMEOUT,
              success: false,
              errorMessage: message,
            },
          })
          if (ended.count !== 1) return false
        }
      }

      const released = await tx.productPublishStoreClassification.updateMany({
        where: { id: classificationId, templateRequestId: requestId },
        data: {
          templateRequestId: null,
          templateStatus: ProductPublishTemplateStatus.FAILED,
          lastSyncError: message,
        },
      })
      return released.count === 1
    }, CALLBACK_TRANSACTION_OPTIONS)
  }

  private parseTemplateResult(
    data: RpaData,
    expectedBusinessId: string,
    expectedCategory: string
  ): TemplateResult {
    this.assertTaskType(data, "download_listing")
    this.assertBusinessId(data, expectedBusinessId)
    if (this.requireString(data, "category", 100) !== expectedCategory) {
      throw new BadRequestException("RPA 模板结果 category 与请求不匹配")
    }
    return {
      templateUrl: this.requireHttpsUrl(
        this.requireString(data, "template_url", 1_000),
        "模板 URL"
      ),
    }
  }

  private parseSubmitResult(data: RpaData, expectedBusinessId: string): SubmitResult {
    this.assertTaskType(data, "upload_listing")
    this.assertBusinessId(data, expectedBusinessId)
    return { uploadId: this.requireUploadId(data) }
  }

  private parseQueryResult(
    data: RpaData,
    expectedBusinessId: string,
    expectedUploadId: string
  ): QueryResult {
    this.assertTaskType(data, "check_feed_status")
    this.assertBusinessId(data, expectedBusinessId)
    if (this.requireUploadId(data) !== expectedUploadId) {
      throw new BadRequestException("RPA 查询结果 upload_id 与请求不匹配")
    }

    const status = this.requireString(data, "status", 30)
    const statuses = ["ACCEPTED", "PROCESSING", "SUCCESS", "PARTIAL_SUCCESS", "FAILED"] as const
    if (!(statuses as readonly string[]).includes(status)) {
      throw new BadRequestException("Amazon 处理状态不受支持")
    }
    const totalCount = this.requireNonNegativeInteger(data, "total_count")
    const successCount = this.requireNonNegativeInteger(data, "success_count")
    const failedCount = this.requireNonNegativeInteger(data, "failed_count")
    if (successCount + failedCount > totalCount) {
      throw new BadRequestException("成功数量与失败数量不能超过总数量")
    }

    return {
      status: status as QueryResult["status"],
      successCount,
      failedCount,
      resultFileUrl: this.readNullableHttpsUrl(data.result_file_url, "结果文件 URL"),
      skuAsinMapping: this.validateSkuAsinMapping(data.sku_asin_mapping),
    }
  }

  private async applyQueryResult(
    tx: Prisma.TransactionClient,
    task: RpaTask,
    requestId: string,
    result: QueryResult
  ): Promise<{ count: number }> {
    const terminal = ["SUCCESS", "PARTIAL_SUCCESS", "FAILED"].includes(result.status)
    const outcome = terminal ? (result.status as ProductPublishOutcome) : null
    return tx.productPublishTask.updateMany({
      where: {
        id: task.id,
        status: ProductPublishTaskStatus.PUBLISHING,
        uploadId: task.uploadId,
        resultRequestId: requestId,
        publishOutcome: null,
      },
      data: {
        resultRequestId: null,
        successCount: result.successCount,
        failedCount: result.failedCount,
        resultFileUrl: result.resultFileUrl,
        skuAsinMapping: this.toJsonValue(result.skuAsinMapping),
        publishErrorMessage: null,
        ...(terminal
          ? {
              status: ProductPublishTaskStatus.COMPLETED,
              publishOutcome: outcome,
              publishCompletedAt: new Date(),
              nextPollAt: null,
            }
          : { nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS) }),
      },
    })
  }

  private async claimPoll(task: RpaTask, requestId: string): Promise<void> {
    if (!(await this.tryClaimPoll(task, requestId))) {
      throw new ConflictException("该任务的处理结果正在刷新，请稍后重试")
    }
  }

  private async tryClaimPoll(task: RpaTask, requestId: string): Promise<boolean> {
    const now = new Date()
    const claimed = await this.prisma.productPublishTask.updateMany({
      where: {
        id: task.id,
        status: ProductPublishTaskStatus.PUBLISHING,
        uploadId: task.uploadId,
        publishOutcome: null,
        resultRequestId: null,
        nextPollAt: task.nextPollAt,
        AND: [{ OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }] }],
      },
      data: {
        resultRequestId: requestId,
        lastPolledAt: now,
        nextPollAt: new Date(now.getTime() + POLL_INTERVAL_MS),
        pollAttempts: { increment: 1 },
        publishErrorMessage: null,
      },
    })
    return claimed.count === 1
  }

  private assertPollDue(task: RpaTask): void {
    if (task.resultRequestId) throw new ConflictException("该任务正在等待 RPA 查询结果")
    if (task.nextPollAt && task.nextPollAt.getTime() > Date.now()) {
      throw new ConflictException("距上次查询未满 5 分钟，请稍后刷新")
    }
  }

  private async failPublishingTask(task: RpaTask, message: string): Promise<void> {
    await this.prisma.productPublishTask.updateMany({
      where: {
        id: task.id,
        status: ProductPublishTaskStatus.PUBLISHING,
        uploadId: task.uploadId,
        publishOutcome: null,
      },
      data: {
        status: ProductPublishTaskStatus.COMPLETED,
        resultRequestId: null,
        publishOutcome: ProductPublishOutcome.FAILED,
        publishCompletedAt: new Date(),
        nextPollAt: null,
        publishErrorMessage: message,
      },
    })
  }

  private async markPollTimedOut(task: RpaTask): Promise<boolean> {
    const now = new Date()
    const updated = await this.prisma.productPublishTask.updateMany({
      where: {
        id: task.id,
        status: ProductPublishTaskStatus.PUBLISHING,
        uploadId: task.uploadId,
        publishOutcome: null,
        resultRequestId: null,
        pollAttempts: task.pollAttempts,
        nextPollAt: task.nextPollAt,
        AND: [{ OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }] }],
      },
      data: {
        status: ProductPublishTaskStatus.COMPLETED,
        publishOutcome: ProductPublishOutcome.TIMEOUT,
        publishCompletedAt: new Date(),
        nextPollAt: null,
        publishErrorMessage: `超过最大查询次数 ${this.maxPollAttempts()}，已停止自动轮询`,
      },
    })
    return updated.count === 1
  }

  private async createRun(operation: ProductPublishRpaOperation, startedAt: Date) {
    return this.prisma.productPublishRpaRun.create({
      data: { operation, status: ProductPublishRpaRunStatus.RUNNING, startedAt },
      select: { id: true },
    })
  }

  private async finishRun(runId: number, startedAt: Date, counts: RunCounts): Promise<void> {
    const finishedAt = new Date()
    await this.prisma.productPublishRpaRun.update({
      where: { id: runId },
      data: {
        status: this.runStatus(counts),
        totalCount: counts.total,
        successCount: counts.success,
        failedCount: counts.failed,
        skippedCount: counts.skipped,
        errorMessage: counts.errors.length ? counts.errors.slice(0, 20).join("；") : null,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      },
    })
  }

  private async failRun(
    runId: number,
    startedAt: Date,
    counts: RunCounts,
    error: unknown
  ): Promise<void> {
    const message = this.errorMessage(error)
    counts.errors.push(message)
    const finishedAt = new Date()
    try {
      await this.prisma.productPublishRpaRun.update({
        where: { id: runId },
        data: {
          status: ProductPublishRpaRunStatus.FAILED,
          totalCount: counts.total,
          successCount: counts.success,
          failedCount: counts.failed,
          skippedCount: counts.skipped,
          errorMessage: counts.errors.slice(0, 20).join("；"),
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        },
      })
    } catch (logError: unknown) {
      this.logger.error(
        `RPA 定时任务失败日志写入失败 runId=${runId}: ${this.errorMessage(logError)}`
      )
    }
  }

  private runStatus(counts: RunCounts): ProductPublishRpaRunStatus {
    if (counts.total === 0) return ProductPublishRpaRunStatus.SKIPPED
    if (counts.success === 0 && counts.failed === 0) return ProductPublishRpaRunStatus.SKIPPED
    if (counts.failed === 0) return ProductPublishRpaRunStatus.SUCCESS
    if (counts.success > 0 || counts.skipped > 0) {
      return ProductPublishRpaRunStatus.PARTIAL_FAILED
    }
    return ProductPublishRpaRunStatus.FAILED
  }

  private runResult(runId: number, counts: RunCounts) {
    return {
      runId,
      status: this.runStatus(counts),
      total: counts.total,
      success: counts.success,
      failed: counts.failed,
      skipped: counts.skipped,
    }
  }

  private emptyRunCounts(): RunCounts {
    return { total: 0, success: 0, failed: 0, skipped: 0, errors: [] }
  }

  private buildTaskRequest(
    task: RpaTask,
    taskType: "upload_listing" | "check_feed_status",
    taskParam: { file_url: string } | { upload_id: string; skus: string[] }
  ): ProductPublishRpaRequest {
    if (!task.publishStore) throw new BadRequestException("上架任务未关联店铺")
    if (taskType === "upload_listing" && "file_url" in taskParam) {
      return buildProductPublishRpaRequest({
        businessId: task.publishStore.externalStoreId,
        taskType,
        taskParam,
      })
    }
    if (taskType === "check_feed_status" && "upload_id" in taskParam) {
      return buildProductPublishRpaRequest({
        businessId: task.publishStore.externalStoreId,
        taskType,
        taskParam,
      })
    }
    throw new BadRequestException("RPA 请求参数与任务类型不匹配")
  }

  private async findOwnedTask(taskId: string, userId: number): Promise<RpaTask> {
    const task = await this.prisma.productPublishTask.findFirst({
      where: { taskId, userId },
      select: RPA_TASK_SELECT,
    })
    if (!task) throw new NotFoundException("上架任务不存在")
    return task
  }

  private assertTaskCanSubmit(task: RpaTask): void {
    if (
      task.submitRequestId ||
      task.uploadId ||
      task.status === ProductPublishTaskStatus.PUBLISHING
    ) {
      throw new ConflictException("该任务已提交，不允许重新上架")
    }
    if (task.status !== ProductPublishTaskStatus.COMPLETED) {
      throw new BadRequestException("只有已完成 Excel 的任务才能提交上架")
    }
    this.assertAmazonStore(task)
  }

  private assertTaskCanQuery(task: RpaTask): string[] {
    if (task.status !== ProductPublishTaskStatus.PUBLISHING || task.publishOutcome) {
      throw new ConflictException("该任务当前不在上架处理中")
    }
    if (!task.uploadId) throw new ConflictException("任务缺少 Amazon 文件批次 ID")
    this.assertAmazonStore(task)
    return this.requireTaskSkus(task.skus)
  }

  private assertAmazonStore(task: RpaTask): void {
    if (!task.publishStore) throw new BadRequestException("上架任务未关联店铺")
    if (task.publishStore.disabled) throw new BadRequestException("任务关联店铺已禁用")
    if (task.publishStore.platform !== "AMAZON") {
      throw new BadRequestException("当前仅支持 Amazon 店铺")
    }
  }

  private validateCallbackEnvelope(dto: ProductPublishRpaCallbackDto): void {
    if (dto.contract_version !== "1.0") {
      throw new BadRequestException("RPA 回调协议版本必须为 1.0")
    }
    if (dto.ok && dto.error !== null && dto.error !== undefined) {
      throw new BadRequestException("RPA 成功回调不能携带 error")
    }
    if (!dto.ok && (dto.error === null || dto.error === undefined)) {
      throw new BadRequestException("RPA 失败回调必须携带 error")
    }
  }

  private authenticateCallback(apiKey: string | undefined): void {
    const expected = this.config.get<string>("YINGDAO_PRODUCT_PUBLISH_CALLBACK_API_KEY", "").trim()
    if (!expected) throw new ServiceUnavailableException("一键上架 RPA 回调密钥未配置")
    const actualBuffer = Buffer.from(apiKey ?? "", "utf8")
    const expectedBuffer = Buffer.from(expected, "utf8")
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException("X-API-Key 不正确")
    }
  }

  private resolveCallbackRequestId(
    activeRequestId: string | null,
    suppliedRequestId: string | undefined
  ): string | null {
    if (activeRequestId && suppliedRequestId && activeRequestId !== suppliedRequestId) {
      throw new ConflictException("RPA 回调 request_id 与当前待处理请求不匹配")
    }
    return activeRequestId ?? suppliedRequestId ?? null
  }

  private isTerminalLogStatus(status: ProductPublishRpaLogStatus): boolean {
    return (
      status === ProductPublishRpaLogStatus.SUCCESS ||
      status === ProductPublishRpaLogStatus.FAILED ||
      status === ProductPublishRpaLogStatus.TIMEOUT
    )
  }

  private callbackResult(taskType: string, requestId: string, businessSuccess: boolean) {
    return { success: true, duplicate: false, taskType, requestId, businessSuccess }
  }

  private duplicateCallback(taskType: string, requestId?: string) {
    return { success: true, duplicate: true, taskType, ...(requestId ? { requestId } : {}) }
  }

  private requireBusinessId(data: RpaData): string {
    const businessId = this.requireString(data, "business_id", 32)
    if (!/^\d{1,32}$/.test(businessId)) {
      throw new BadRequestException("RPA 回调 business_id 必须是纯数字店铺 ID")
    }
    return businessId
  }

  private requireUploadId(data: RpaData): string {
    const uploadId = this.requireString(data, "upload_id", 100)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(uploadId)) {
      throw new BadRequestException("Amazon upload_id 格式错误")
    }
    return uploadId
  }

  private assertTaskType(data: RpaData, expected: string): void {
    if (data.task_type !== expected) {
      throw new BadRequestException(`RPA 结果 task_type 应为 ${expected}`)
    }
  }

  private assertBusinessId(data: RpaData, expected: string): void {
    if (this.requireBusinessId(data) !== expected) {
      throw new BadRequestException("RPA 结果 business_id 与请求店铺不匹配")
    }
  }

  private normalizeSubmittedSkus(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new BadRequestException("skus 必须是非空字符串数组")
    }
    if (value.length > 100_000) throw new BadRequestException("skus 不能超过 100000 个")

    const normalized: string[] = []
    const seen = new Set<string>()
    for (const rawSku of value) {
      if (typeof rawSku !== "string") throw new BadRequestException("SKU 必须是字符串")
      const sku = rawSku.trim()
      if (!sku || sku.length > 200) {
        throw new BadRequestException("SKU 不能为空且不能超过 200 个字符")
      }
      if (seen.has(sku)) throw new BadRequestException(`SKU 重复：${sku}`)
      seen.add(sku)
      normalized.push(sku)
    }
    return normalized
  }

  private readOptionalTaskSkus(value: Prisma.JsonValue | null): string[] | null {
    if (value === null) return null
    try {
      return this.normalizeSubmittedSkus(value)
    } catch (error: unknown) {
      throw new ConflictException(`任务 SKU 列表无效：${this.errorMessage(error)}`)
    }
  }

  private requireTaskSkus(value: Prisma.JsonValue | null): string[] {
    const skus = this.readOptionalTaskSkus(value)
    if (!skus) throw new ConflictException("任务缺少提交时冻结的 SKU 列表，无法查询处理结果")
    return skus
  }

  private assertSkuMappingMatchesRequested(
    mapping: Array<Record<string, unknown>>,
    requestedSkus: string[]
  ): void {
    const requested = new Set(requestedSkus)
    for (const item of mapping) {
      const sku = item.sku as string
      if (!requested.has(sku)) {
        throw new BadRequestException(`sku_asin_mapping 包含未请求的 SKU：${sku}`)
      }
    }
  }

  private validateSkuAsinMapping(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) throw new BadRequestException("sku_asin_mapping 必须是数组")
    if (value.length > 100_000) throw new BadRequestException("sku_asin_mapping 数量过多")
    const seenSkus = new Set<string>()
    return value.map((item, index) => {
      const row = this.requireRecord(item, `sku_asin_mapping 第 ${index + 1} 项格式错误`)
      const sku = this.requireString(row, "sku", 200)
      if (seenSkus.has(sku)) {
        throw new BadRequestException(`sku_asin_mapping SKU 重复：${sku}`)
      }
      seenSkus.add(sku)
      const asin = row.asin === null ? null : this.requireString(row, "asin", 50)
      const status = this.requireString(row, "status", 20)
      if (!["SUCCESS", "FAILED"].includes(status)) {
        throw new BadRequestException(`sku_asin_mapping 第 ${index + 1} 项状态无效`)
      }
      return {
        sku,
        asin,
        status,
        ...(typeof row.error_code === "string" ? { error_code: row.error_code } : {}),
        ...(typeof row.error_message === "string" ? { error_message: row.error_message } : {}),
      }
    })
  }

  private requireNonNegativeInteger(data: RpaData, key: string): number {
    const value = data[key]
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new BadRequestException(`${key} 必须是大于等于 0 的整数`)
    }
    return value
  }

  private requireString(data: RpaData, key: string, maxLength: number): string {
    const value = data[key]
    if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
      throw new BadRequestException(`${key} 必须是长度不超过 ${maxLength} 的非空字符串`)
    }
    return value.trim()
  }

  private requireRecord(value: unknown, message: string): RpaData {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new BadRequestException(message)
    }
    return value as RpaData
  }

  private requireHttpsUrl(value: string, label: string): string {
    if (value.length > 1_000) throw new BadRequestException(`${label}不能超过 1000 个字符`)
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new BadRequestException(`${label}格式错误`)
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new BadRequestException(`${label}必须是无凭证的 HTTPS 地址`)
    }
    return url.toString()
  }

  private canonicalFileUrl(value: string): string {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  }

  private submitCorrelationKey(businessId: string, fileUrl: string): string {
    return createHash("sha256")
      .update(`${businessId}\n${this.canonicalFileUrl(fileUrl)}`, "utf8")
      .digest("hex")
  }

  private readNullableHttpsUrl(value: unknown, label: string): string | null {
    if (value === null || value === undefined || value === "") return null
    if (typeof value !== "string") throw new BadRequestException(`${label}格式错误`)
    return this.requireHttpsUrl(value, label)
  }

  private callbackErrorMessage(error: unknown): string {
    const record = this.requireRecord(error, "RPA 失败回调缺少 error")
    const code =
      typeof record.code === "string" && record.code.trim() ? record.code.trim() : "RPA_ERROR"
    const message =
      typeof record.message === "string" && record.message.trim()
        ? record.message.trim()
        : "RPA 执行失败"
    return `${code}: ${message}`.slice(0, 2_000)
  }

  private assertConfigured(): void {
    const names = [
      "YINGDAO_ACCESS_KEY_ID",
      "YINGDAO_ACCESS_KEY_SECRET",
      "YINGDAO_PRODUCT_PUBLISH_TASK_UUID",
      "YINGDAO_PRODUCT_PUBLISH_APP_ID",
      "YINGDAO_PRODUCT_PUBLISH_PROFILE",
      "YINGDAO_PRODUCT_PUBLISH_CALLBACK_API_KEY",
    ]
    const missing = names.filter(name => !this.config.get<string>(name, "").trim())
    if (missing.length) {
      throw new ServiceUnavailableException(`一键上架 RPA 配置不完整：${missing.join(", ")}`)
    }
    this.profile()
    if (this.callbackTimeoutSeconds() < this.runTimeoutSeconds() + 60) {
      throw new ServiceUnavailableException("一键上架 RPA 回调超时必须至少比脚本运行超时多 60 秒")
    }
  }

  private requiredConfig(name: string): string {
    const value = this.config.get<string>(name, "").trim()
    if (!value) throw new ServiceUnavailableException(`缺少环境变量 ${name}`)
    return value
  }

  private paramName(): string {
    const value = this.config
      .get<string>("YINGDAO_PRODUCT_PUBLISH_PARAM_NAME", DEFAULT_PARAM_NAME)
      .trim()
    return value || DEFAULT_PARAM_NAME
  }

  private profile(): (typeof PRODUCT_PUBLISH_PROFILES)[number] {
    const value = this.requiredConfig("YINGDAO_PRODUCT_PUBLISH_PROFILE")
    if (!PRODUCT_PUBLISH_PROFILES.includes(value as (typeof PRODUCT_PUBLISH_PROFILES)[number])) {
      throw new ServiceUnavailableException(
        "YINGDAO_PRODUCT_PUBLISH_PROFILE 只允许 dev、dev1、uat、prod"
      )
    }
    return value as (typeof PRODUCT_PUBLISH_PROFILES)[number]
  }

  private runTimeoutSeconds(): number {
    const raw = this.config.get<string>(
      "YINGDAO_PRODUCT_PUBLISH_RUN_TIMEOUT_SECONDS",
      String(DEFAULT_RUN_TIMEOUT_SECONDS)
    )
    const value = Number(raw)
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_RUN_TIMEOUT_SECONDS
  }

  private callbackTimeoutSeconds(): number {
    const raw = this.config.get<string>(
      "YINGDAO_PRODUCT_PUBLISH_CALLBACK_TIMEOUT_SECONDS",
      String(DEFAULT_CALLBACK_TIMEOUT_SECONDS)
    )
    const value = Number(raw)
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_CALLBACK_TIMEOUT_SECONDS
  }

  private maxPollAttempts(): number {
    const raw = this.config.get<string>(
      "YINGDAO_PRODUCT_PUBLISH_MAX_POLL_ATTEMPTS",
      String(DEFAULT_MAX_POLL_ATTEMPTS)
    )
    const value = Number(raw)
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_POLL_ATTEMPTS
  }

  private sanitizeRequest(request: ProductPublishRpaRequest): ProductPublishRpaRequest {
    return request.map(item => ({
      ...item,
      tasks_info: item.tasks_info.map(task => {
        if (task.task_type !== "upload_listing") return task
        const url = new URL(task.task_param.file_url)
        return { ...task, task_param: { file_url: `${url.origin}${url.pathname}` } }
      }),
    }))
  }

  private sanitizeCallback(dto: ProductPublishRpaCallbackDto): Record<string, unknown> {
    const data = { ...dto.data }
    if (data.task_type === "upload_listing" && typeof data.file_url === "string") {
      try {
        data.file_url = this.canonicalFileUrl(data.file_url)
      } catch {
        data.file_url = "[INVALID_URL]"
      }
    }
    if (data.task_type === "check_feed_status") {
      if (typeof data.result_file_url === "string") {
        try {
          data.result_file_url = this.canonicalFileUrl(data.result_file_url)
        } catch {
          data.result_file_url = "[INVALID_URL]"
        }
      }
      if (Array.isArray(data.sku_asin_mapping)) {
        const mappingJson = JSON.stringify(data.sku_asin_mapping)
        data.sku_asin_mapping = {
          count: data.sku_asin_mapping.length,
          sha256: createHash("sha256").update(mappingJson, "utf8").digest("hex"),
        }
      }
    }
    return {
      contract_version: dto.contract_version,
      ...(dto.request_id ? { request_id: dto.request_id } : {}),
      ok: dto.ok,
      data,
      ...(dto.error ? { error: dto.error } : {}),
    }
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message.slice(0, 2_000)
    return String(error).slice(0, 2_000)
  }
}
