import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common"
import type { AdCleaningTask } from "@prisma/client"
import { randomUUID } from "crypto"
import { readdir, stat, unlink } from "fs/promises"
import { basename, extname, join } from "path"
import { Worker } from "worker_threads"
import { PrismaService } from "../prisma/prisma.service"
import { SpacesService } from "../spaces/spaces.service"
import {
  AD_CLEANING_MAX_FILE_SIZE,
  AD_CLEANING_MAX_QUEUED_TASKS,
  AD_CLEANING_TEMP_DIR,
  AD_CLEANING_TEMP_FILE_TTL_MS,
  AD_CLEANING_WORKER_TIMEOUT_MS,
  AD_CLEANING_XLSX_MIME,
} from "./ad-cleaning.constants"
import { AdCleaningProcessor } from "./ad-cleaning.processor"
import type {
  AdCleaningSheetPreview,
  AdCleaningStats,
  AdCleaningTaskPublic,
  AdCleaningTaskStatus,
  AdCleaningWorkerMessage,
} from "./ad-cleaning.types"
import { QueryAdCleaningTasksDto } from "./dto/query-ad-cleaning-tasks.dto"

/** Multer 保存到本地临时目录后的上传文件信息。 */
export interface UploadedAdSpreadsheet {
  originalname: string
  mimetype: string
  path: string
  size: number
}

/**
 * 只在当前进程中存在的运行时数据。
 * 原文件路径和结果文件路径只用于当前 Worker，任务完成后立即删除。
 */
interface AdCleaningTaskRuntime {
  taskId: string
  userId: number
  originalFilename: string
  inputPath: string
  outputPath: string
  outputFilename: string
}

@Injectable()
export class AdCleaningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdCleaningService.name)

  /** MySQL 是任务状态的持久化来源；Map 只保存正在排队或处理的临时文件。 */
  private readonly runtimes = new Map<string, AdCleaningTaskRuntime>()
  private readonly queue: string[] = []
  private activeTaskId: string | null = null
  private activeWorker: Worker | null = null
  private isShuttingDown = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly spaces: SpacesService
  ) {}

  /**
   * 原始文件不持久化，因此进程重启后无法恢复旧 Worker。
   * 启动时把遗留的等待中/处理中任务明确标记为失败，避免状态永久卡住。
   */
  async onModuleInit(): Promise<void> {
    await this.cleanupStaleFiles()
    const recovered = await this.prisma.adCleaningTask.updateMany({
      where: { status: { in: ["PENDING", "PROCESSING"] } },
      data: {
        status: "FAILED",
        progress: 100,
        stage: "清洗失败",
        errorMessage: "服务重启导致临时原文件失效，请重新上传文件",
        completedAt: new Date(),
      },
    })
    if (recovered.count > 0) {
      this.logger.warn(`已终止 ${recovered.count} 个服务重启前未完成的广告清洗任务`)
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true
    if (this.activeWorker) await this.activeWorker.terminate()
    await Promise.all(
      [...this.runtimes.values()].flatMap(runtime => [
        this.safeUnlink(runtime.inputPath),
        this.safeUnlink(runtime.outputPath),
      ])
    )
    this.runtimes.clear()
  }

  /** 创建数据库任务，并把本地临时原文件交给单 Worker 队列处理。 */
  async createTask(
    file: UploadedAdSpreadsheet | undefined,
    userId: number
  ): Promise<AdCleaningTaskPublic> {
    if (!file) throw new BadRequestException("请上传 Excel 文件")
    try {
      this.validateUpload(file)
      const pendingCount = await this.prisma.adCleaningTask.count({
        where: { status: { in: ["PENDING", "PROCESSING"] } },
      })
      if (pendingCount >= AD_CLEANING_MAX_QUEUED_TASKS) {
        throw new ServiceUnavailableException("当前清洗任务较多，请稍后重试")
      }

      const taskId = randomUUID()
      const originalFilename = this.normalizeOriginalFilename(file.originalname)
      const outputFilename = this.outputFilenameOf(originalFilename)
      const runtime: AdCleaningTaskRuntime = {
        taskId,
        userId,
        originalFilename,
        inputPath: file.path,
        outputPath: join(AD_CLEANING_TEMP_DIR, `${taskId}-result.xlsx`),
        outputFilename,
      }
      const task = await this.prisma.adCleaningTask.create({
        data: {
          taskId,
          userId,
          status: "PENDING",
          progress: 0,
          stage: "等待处理",
          originalFilename,
        },
      })

      this.runtimes.set(taskId, runtime)
      this.queue.push(taskId)
      this.logger.log(`广告清洗任务已创建 [taskId=${taskId}, size=${file.size}B]`)
      void this.runNext()
      return this.toPublic(task)
    } catch (error) {
      await this.safeUnlink(file.path)
      throw error
    }
  }

  /**
   * 查询当前用户的持久化任务状态。
   * 成功任务每次都从 resultFileUrl 实时读取 Excel 并生成预览，不使用内存缓存。
   */
  async getTask(taskId: string, userId: number): Promise<AdCleaningTaskPublic> {
    const task = await this.findOwnedTask(taskId, userId)
    if (task.status !== "SUCCESS" || !task.resultFileUrl) return this.toPublic(task)

    try {
      const buffer = await this.spaces.downloadBufferByUrl(task.resultFileUrl)
      const inspected = AdCleaningProcessor.inspectResultBuffer(buffer)
      return this.toPublic(task, inspected.stats, inspected.sheetPreviews)
    } catch (error) {
      this.logger.error(`实时读取广告清洗预览失败 [taskId=${taskId}] ${this.errorMessage(error)}`)
      throw new ServiceUnavailableException("清洗任务已完成，但结果预览读取失败，请稍后重试")
    }
  }

  /**
   * 分页查询当前用户的清洗任务（按创建时间倒序）。
   * 列表轻量返回，不读取 stats/sheetPreviews，需要详情时走单个任务接口。
   */
  async listTasks(userId: number, query: QueryAdCleaningTasksDto) {
    const where = { userId, ...(query.status && { status: query.status }) }
    const [tasks, total] = await Promise.all([
      this.prisma.adCleaningTask.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.adCleaningTask.count({ where }),
    ])
    return {
      items: tasks.map(task => this.toPublic(task)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
    }
  }

  /** 获取清洗结果 URL，下载接口使用该地址重定向到文件服务器。 */
  async getResultUrl(taskId: string, userId: number): Promise<string> {
    const task = await this.findOwnedTask(taskId, userId)
    if (task.status !== "SUCCESS") {
      throw new ConflictException(
        task.status === "FAILED" ? "清洗任务失败，无法下载结果" : "清洗任务尚未完成"
      )
    }
    if (!task.resultFileUrl) throw new NotFoundException("清洗结果 URL 不存在")
    return task.resultFileUrl
  }

  private validateUpload(file: UploadedAdSpreadsheet): void {
    if (extname(file.originalname).toLowerCase() !== ".xlsx") {
      throw new BadRequestException("第一版仅支持 .xlsx 文件")
    }
    if (file.size <= 0) throw new BadRequestException("上传文件不能为空")
    if (file.size > AD_CLEANING_MAX_FILE_SIZE) {
      throw new BadRequestException("Excel 文件不能超过 50 MB")
    }
  }

  private normalizeOriginalFilename(filename: string): string {
    const plain = basename(filename || "广告搜索词.xlsx")
    try {
      const decoded = Buffer.from(plain, "latin1").toString("utf8")
      return decoded.includes("�") ? plain : decoded
    } catch {
      return plain
    }
  }

  private outputFilenameOf(originalFilename: string): string {
    const safeBaseName = [...basename(originalFilename, extname(originalFilename))]
      .map(character => (character.charCodeAt(0) < 32 ? "_" : character))
      .join("")
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 120)
    return `${safeBaseName || "广告搜索词"}-清洗结果.xlsx`
  }

  private async findOwnedTask(taskId: string, userId: number): Promise<AdCleaningTask> {
    const task = await this.prisma.adCleaningTask.findFirst({ where: { taskId, userId } })
    if (!task) throw new NotFoundException("广告清洗任务不存在")
    return task
  }

  /** 从内存队列中串行启动下一个任务，避免多个大 Excel 同时占用内存。 */
  private async runNext(): Promise<void> {
    if (this.isShuttingDown || this.activeTaskId) return
    const taskId = this.queue.shift()
    if (!taskId) return
    const runtime = this.runtimes.get(taskId)
    if (!runtime) {
      await this.runNext()
      return
    }

    this.activeTaskId = taskId
    try {
      await this.prisma.adCleaningTask.update({
        where: { taskId },
        data: {
          status: "PROCESSING",
          progress: 1,
          stage: "正在启动清洗任务",
          startedAt: new Date(),
          errorMessage: null,
        },
      })
      this.startWorker(runtime)
    } catch (error) {
      await this.failTask(runtime, this.errorMessage(error, "清洗任务启动失败"))
      await this.releaseRuntime(runtime)
    }
  }

  private startWorker(runtime: AdCleaningTaskRuntime): void {
    let settled = false
    const worker = new Worker(join(__dirname, "ad-cleaning.worker.js"), {
      workerData: {
        inputPath: runtime.inputPath,
        outputPath: runtime.outputPath,
        originalFilename: runtime.originalFilename,
      },
    })
    this.activeWorker = worker

    const workerTimeout = setTimeout(() => {
      if (settled) return
      settled = true
      void worker.terminate()
      void this.finalizeFailure(runtime, "清洗任务超过 10 分钟，已自动终止，请拆分文件后重试")
    }, AD_CLEANING_WORKER_TIMEOUT_MS)
    workerTimeout.unref()

    worker.on("message", (message: AdCleaningWorkerMessage) => {
      if (settled) return
      if (message.type === "progress") {
        const progress = Math.min(90, Math.max(1, message.progress))
        const stage = message.progress >= 100 ? "Excel 已生成，正在准备上传" : message.stage
        void this.updateTaskProgress(runtime.taskId, progress, stage)
        return
      }

      settled = true
      clearTimeout(workerTimeout)
      if (message.type === "success") {
        void this.finalizeSuccess(runtime, message.stats)
      } else {
        void this.finalizeFailure(runtime, message.message)
      }
    })

    worker.once("error", error => {
      if (settled) return
      settled = true
      clearTimeout(workerTimeout)
      void this.finalizeFailure(runtime, error.message)
    })

    worker.once("exit", code => {
      clearTimeout(workerTimeout)
      if (settled) return
      settled = true
      const message = code === 0 ? "清洗 Worker 未返回结果" : `清洗 Worker 异常退出（code=${code}）`
      void this.finalizeFailure(runtime, message)
    })
  }

  /**
   * 上传完整清洗结果，只把文件服务器返回的 URL 写入 MySQL。
   * 统计和 Sheet 预览不缓存，状态接口需要时从结果 Excel 实时还原。
   */
  private async finalizeSuccess(
    runtime: AdCleaningTaskRuntime,
    stats: AdCleaningStats
  ): Promise<void> {
    const resultKey = this.resultObjectKey(runtime)
    let uploaded = false
    try {
      await this.updateTaskProgress(runtime.taskId, 95, "正在上传清洗结果")
      const resultFileUrl = await this.spaces.uploadFile(
        runtime.outputPath,
        resultKey,
        AD_CLEANING_XLSX_MIME
      )
      uploaded = true
      const task = await this.prisma.adCleaningTask.update({
        where: { taskId: runtime.taskId },
        data: {
          status: "SUCCESS",
          progress: 100,
          stage: "清洗完成",
          resultFileUrl,
          errorMessage: null,
          completedAt: new Date(),
        },
      })
      this.logger.log(
        `广告清洗完成 [taskId=${task.taskId}, rows=${stats.effectiveRows}, terms=${stats.aggregatedSearchTerms}]`
      )
    } catch (error) {
      if (uploaded) {
        try {
          await this.spaces.deleteObject(resultKey)
        } catch (deleteError) {
          this.logger.warn(
            `删除未入库的清洗结果失败 [key=${resultKey}] ${this.errorMessage(deleteError)}`
          )
        }
      }
      await this.failTask(runtime, this.errorMessage(error, "清洗结果上传失败"))
    } finally {
      await this.releaseRuntime(runtime)
    }
  }

  private async finalizeFailure(runtime: AdCleaningTaskRuntime, message: string): Promise<void> {
    try {
      await this.failTask(runtime, message)
    } finally {
      await this.releaseRuntime(runtime)
    }
  }

  private async updateTaskProgress(taskId: string, progress: number, stage: string): Promise<void> {
    try {
      // 仅处理中任务允许更新进度，防止迟到的 Worker 消息覆盖 SUCCESS/FAILED。
      await this.prisma.adCleaningTask.updateMany({
        where: { taskId, status: "PROCESSING" },
        data: { progress, stage },
      })
    } catch (error) {
      this.logger.warn(`更新广告清洗进度失败 [taskId=${taskId}] ${this.errorMessage(error)}`)
    }
  }

  private async failTask(runtime: AdCleaningTaskRuntime, message: string): Promise<void> {
    const errorMessage = message || "广告数据清洗失败"
    try {
      await this.prisma.adCleaningTask.update({
        where: { taskId: runtime.taskId },
        data: {
          status: "FAILED",
          progress: 100,
          stage: "清洗失败",
          resultFileUrl: null,
          errorMessage,
          completedAt: new Date(),
        },
      })
    } catch (error) {
      this.logger.error(
        `写入广告清洗失败状态失败 [taskId=${runtime.taskId}] ${this.errorMessage(error)}`
      )
    }
    this.logger.error(`广告清洗失败 [taskId=${runtime.taskId}] ${errorMessage}`)
  }

  /** 删除本地文件和运行时记录；不保留结果文件或 Sheet 预览缓存。 */
  private async releaseRuntime(runtime: AdCleaningTaskRuntime): Promise<void> {
    await Promise.all([this.safeUnlink(runtime.inputPath), this.safeUnlink(runtime.outputPath)])
    if (this.activeTaskId === runtime.taskId) {
      this.activeWorker = null
      this.activeTaskId = null
    }

    this.runtimes.delete(runtime.taskId)
    await this.runNext()
  }

  private resultObjectKey(runtime: AdCleaningTaskRuntime): string {
    const now = new Date()
    const year = String(now.getUTCFullYear())
    const month = String(now.getUTCMonth() + 1).padStart(2, "0")
    const day = String(now.getUTCDate()).padStart(2, "0")
    return `ad-cleaning/${runtime.userId}/${year}/${month}/${day}/${runtime.taskId}.xlsx`
  }

  private toPublic(
    task: AdCleaningTask,
    stats: AdCleaningStats | null = null,
    sheetPreviews: AdCleaningSheetPreview[] | null = null
  ): AdCleaningTaskPublic {
    const status = task.status as AdCleaningTaskStatus
    return {
      taskId: task.taskId,
      status,
      progress: task.progress,
      stage: task.stage,
      originalFilename: task.originalFilename,
      outputFilename: status === "SUCCESS" ? this.outputFilenameOf(task.originalFilename) : null,
      resultFileUrl: task.resultFileUrl,
      stats,
      sheetPreviews,
      errorMessage: task.errorMessage,
      createdAt: task.createdAt.toISOString(),
      startedAt: task.startedAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      downloadPath: status === "SUCCESS" ? `/api/ad-cleaning/tasks/${task.taskId}/download` : null,
    }
  }

  private async cleanupStaleFiles(): Promise<void> {
    try {
      const files = await readdir(AD_CLEANING_TEMP_DIR)
      const cutoff = Date.now() - AD_CLEANING_TEMP_FILE_TTL_MS
      await Promise.all(
        files.map(async filename => {
          const path = join(AD_CLEANING_TEMP_DIR, filename)
          const metadata = await stat(path)
          if (metadata.isFile() && metadata.mtimeMs < cutoff) await this.safeUnlink(path)
        })
      )
    } catch (error) {
      this.logger.warn(`清理历史广告清洗临时文件失败：${this.errorMessage(error)}`)
    }
  }

  private async safeUnlink(path: string): Promise<void> {
    try {
      await unlink(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") this.logger.warn(`删除临时文件失败 [path=${path}, code=${code}]`)
    }
  }

  private errorMessage(error: unknown, fallback = "未知错误"): string {
    return error instanceof Error && error.message ? error.message : fallback
  }
}
