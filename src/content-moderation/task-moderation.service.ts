import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Interval } from "@nestjs/schedule"
import { Prisma } from "@prisma/client"
import { createHash } from "node:crypto"
import { AliyunContentModerationProvider } from "../common/providers/aliyun-content-moderation.provider"
import { PrismaService } from "../prisma/prisma.service"
import { contentInputs } from "./content-inputs"
import { ContentSnapshotService } from "./content-snapshot.service"
import { requestContentInputs } from "./moderation-scope"
import type { ModerationInput, ModerationReceipt, ModerationResult } from "./moderation.types"
import { record } from "./moderation.types"

export const MODERATION_TASKS = {
  VIDEO_TASK: "video-task",
  STORYBOARD_VIDEO: "storyboard-video",
  BEAUTY_TASK: "beauty-task",
} as const
export type ModerationBusinessType = keyof typeof MODERATION_TASKS
type TaskKind = (typeof MODERATION_TASKS)[ModerationBusinessType]
const VIDEO_TECHNICAL_FIELDS = ["mode", "type", "category", "character_orientation"]

type Status = "PENDING" | "PROCESSING" | "PASSED" | "REJECTED" | "FAILED"
interface Item {
  input: ModerationInput
  service: string
  status: "PENDING" | "SUBMITTING" | "PROCESSING" | "COMPLETED" | "FAILED"
  receipt?: ModerationReceipt
  result?: ModerationResult
}
export interface ModerationState {
  businessSubmitting?: boolean
  refreshError?: { code: string; message: string } | null
  preparing?: boolean
  revision: 1
  inputHash: string
  startedAt: string
  items: Item[]
  error: { code: string; message: string } | null
}
export interface ModerationTaskRow {
  moderationPassedAt: Date | null
  id: number
  status: string
  generationParams: Prisma.JsonValue | null
  gatewayTaskId: string | null
  source?: string
  userId?: number
  moderationStatus: string | null
  moderation: Prisma.JsonValue | null
  moderationClaimUntil: Date | null
  moderationNextCheckAt: Date | null
  deletedAt: Date | null
}

// 只登记这三类已有视频任务，不接受客户端指定任意模型/表名。
interface TaskStore {
  findFirst(args: { where: Record<string, unknown> }): Promise<ModerationTaskRow | null>
  findMany(args: Record<string, unknown>): Promise<ModerationTaskRow[]>
  updateMany(args: {
    where: Record<string, unknown>
    data: Record<string, unknown>
  }): Promise<{ count: number }>
}

export class ModerationPendingException extends ServiceUnavailableException {
  constructor() {
    super({ code: "MODERATION_PENDING", message: "任务正在安全审核中" })
  }
}

export function inputHash(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, canonical(child)])
          )
        : item
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")
}

export function moderationSnapshot(row: {
  moderationStatus?: string | null
  moderation?: unknown
}) {
  const state = row.moderation as ModerationState | null | undefined
  return {
    moderationRevision: state?.revision ?? null,
    moderationStatus: row.moderationStatus ?? null,
    results:
      state?.items?.map(item => ({
        itemKey: item.input.key,
        type: item.input.type,
        status: item.status === "SUBMITTING" ? "PROCESSING" : item.status,
        result: item.result ?? null,
      })) ?? [],
    error: state?.error ?? null,
    refreshError: state?.refreshError ?? null,
  }
}

export function moderationBusinessTimeout(cutoff: Date) {
  return {
    OR: [
      { moderationPassedAt: { lte: cutoff } },
      { moderationPassedAt: null, createdAt: { lte: cutoff } },
    ],
  }
}

@Injectable()
export class TaskModerationService {
  private readonly logger = new Logger(TaskModerationService.name)
  private scanning = false
  private continueTask?: (key: string, task: ModerationTaskRow) => Promise<void>

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: AliyunContentModerationProvider,
    private readonly snapshots: ContentSnapshotService
  ) {}

  registerContinuation(continuation: (key: string, task: ModerationTaskRow) => Promise<void>) {
    this.continueTask = continuation
  }

  parse(key: string): { kind: TaskKind; id: number } {
    const match = /^(video-task|storyboard-video|beauty-task):([1-9]\d*)$/.exec(key)
    if (!match || !Number.isSafeInteger(Number(match[2])))
      throw new NotFoundException("审核任务不存在")
    return { kind: match[1] as TaskKind, id: Number(match[2]) }
  }

  private store(kind: TaskKind): TaskStore {
    const delegate =
      kind === "video-task"
        ? this.prisma.videoTask
        : kind === "storyboard-video"
          ? this.prisma.storyboardVideo
          : this.prisma.beautyTask
    const store = delegate as unknown as TaskStore
    const parents:
      | Pick<Prisma.StoryboardVideoWhereInput, "storyboard">
      | Pick<Prisma.VideoTaskWhereInput, "project"> =
      kind === "storyboard-video"
        ? {
            storyboard: {
              deletedAt: null,
              production: {
                deletedAt: null,
                project: { deletedAt: null, customer: { deletedAt: null } },
              },
            },
          }
        : { project: { deletedAt: null } }
    const where = (args: { where?: unknown }) => ({ ...record(args.where), ...parents })
    const safe = <T>(operation: Promise<T>) =>
      operation.catch(() => {
        // Prisma异常可能打印整个JSON参数，不能将审核输入或签名URL传播到请求日志。
        throw new ServiceUnavailableException({
          code: "MODERATION_STORAGE_UNAVAILABLE",
          message: "审核记录暂不可用，请稍后重试",
        })
      })
    return {
      findFirst: args => safe(store.findFirst({ ...args, where: where(args) })),
      findMany: args => safe(store.findMany({ ...args, where: where(args) })),
      updateMany: args => safe(store.updateMany({ ...args, where: where(args) })),
    }
  }

  async requirePassed(key: string, params: unknown): Promise<Prisma.JsonValue> {
    const { kind, id } = this.parse(key)
    const store = this.store(kind)
    let task = await store.findFirst({ where: { id, deletedAt: null } })
    if (!task || !["GENERATING", "WAITING_MODERATION", "TIMEOUT"].includes(task.status)) {
      throw new ConflictException("任务已结束或已取消，不能继续生成")
    }
    if (inputHash(task.generationParams) !== inputHash(params))
      throw new ConflictException("任务输入已变更，请重新创建任务")
    if (!task.moderationStatus && task.status !== "WAITING_MODERATION") {
      const error = {
        code: "BUSINESS_SUBMISSION_UNKNOWN",
        message: "历史任务提交状态待核对，请重新创建任务",
      }
      await store.updateMany({
        where: {
          id,
          moderationStatus: null,
          gatewayTaskId: null,
          deletedAt: null,
          status: { in: ["GENERATING", "TIMEOUT"] },
        },
        data: {
          status: "FAILED",
          moderationStatus: "FAILED",
          errorMessage: error.message,
          moderation: {
            revision: 1,
            inputHash: inputHash(params),
            startedAt: new Date().toISOString(),
            items: [],
            error,
          },
        },
      })
      throw new ConflictException(error.message)
    }
    if (
      task.status === "TIMEOUT" &&
      !(task.moderation as unknown as ModerationState | null)?.businessSubmitting
    ) {
      throw new ConflictException("超时任务尚未提交过业务，不能自动重新生成，请创建新任务")
    }
    if (!task.moderationStatus) {
      const inputs = await requestContentInputs(
        contentInputs(task.generationParams, "generation", VIDEO_TECHNICAL_FIELDS),
        true
      )
      if (!inputs.length) throw new BadRequestException("任务缺少可审核的提示词或素材")
      inputs.forEach(input => this.provider.validate(input))
      const state: ModerationState = {
        revision: 1,
        inputHash: inputHash(params),
        startedAt: new Date().toISOString(),
        error: null,
        items: inputs.map(input => ({
          input,
          service: this.provider.service(input.type),
          status: "PENDING",
        })),
      }
      const claim = new Date(Date.now() + 320_000)
      const initialized = await store.updateMany({
        where: { id, moderationStatus: null, status: task.status, deletedAt: null },
        data: {
          status: "WAITING_MODERATION",
          moderationStatus: "PENDING",
          moderation: { ...state, preparing: true },
          moderationNextCheckAt: new Date(),
          moderationClaimUntil: claim,
        },
      })
      if (initialized.count) {
        state.preparing = true
        await store.updateMany({
          where: { id, moderationClaimUntil: claim, deletedAt: null },
          data: { moderation: state },
        })
        try {
          const { value: frozen, inputs: frozenInputs } = await this.snapshots.freeze(
            params,
            "generation",
            VIDEO_TECHNICAL_FIELDS
          )
          state.inputHash = inputHash(frozen)
          const media = frozenInputs.filter(input => input.type !== "TEXT")
          state.items = [...inputs.filter(input => input.type === "TEXT"), ...media].map(input => ({
            input,
            service: this.provider.service(input.type),
            status: "PENDING",
          }))
          state.preparing = false
          await store.updateMany({
            where: {
              id,
              status: "WAITING_MODERATION",
              moderationClaimUntil: claim,
              deletedAt: null,
            },
            data: {
              generationParams: frozen,
              moderation: state,
              moderationClaimUntil: null,
            },
          })
        } catch {
          state.error = {
            code: "MODERATION_SNAPSHOT_FAILED",
            message: "无法准备审核文件，请重新创建任务",
          }
          await store.updateMany({
            where: {
              id,
              status: "WAITING_MODERATION",
              moderationClaimUntil: claim,
              deletedAt: null,
            },
            data: {
              moderation: state,
              moderationStatus: "FAILED",
              status: "FAILED",
              errorMessage: state.error.message,
              moderationClaimUntil: null,
            },
          })
        }
      }
    }
    task = await this.refresh(key, false, true)
    if (task.moderationStatus !== "PASSED") throw new ModerationPendingException()
    const state = task.moderation as unknown as ModerationState
    if (state.inputHash !== inputHash(task.generationParams)) {
      state.error = {
        code: "MODERATION_INPUT_CHANGED",
        message: "任务输入与审核结果不一致，请重新创建任务",
      }
      await store.updateMany({
        where: {
          id,
          moderationStatus: "PASSED",
          gatewayTaskId: null,
          deletedAt: null,
          status: { in: ["GENERATING", "WAITING_MODERATION", "TIMEOUT"] },
        },
        data: {
          status: "FAILED",
          moderationStatus: "FAILED",
          moderation: state,
          errorMessage: state.error.message,
        },
      })
      throw new ConflictException("任务输入与审核结果不一致")
    }
    // 同一个短占用也用于下游提交；进程中断后仍使用网关原幂等键恢复。
    const claimed = await store.updateMany({
      where: {
        id,
        deletedAt: null,
        moderationStatus: "PASSED",
        gatewayTaskId: null,
        status: { in: ["WAITING_MODERATION", "GENERATING", "TIMEOUT"] },
        OR: [{ moderationClaimUntil: null }, { moderationClaimUntil: { lt: new Date() } }],
      },
      data: {
        status: "GENERATING",
        moderationClaimUntil: new Date(Date.now() + (state.businessSubmitting ? 320_000 : 620_000)),
      },
    })
    if (!claimed.count) throw new ModerationPendingException()
    return task.generationParams
  }

  async beforeBusinessSubmission(key: string, precheck: () => Promise<void>): Promise<void> {
    const { kind, id } = this.parse(key)
    const store = this.store(kind)
    const task = await store.findFirst({
      where: { id, deletedAt: null, status: "GENERATING", moderationStatus: "PASSED" },
    })
    if (!task?.moderationClaimUntil) throw new ConflictException("任务提交占用已失效")
    const state = task.moderation as unknown as ModerationState
    if (state.businessSubmitting) return
    try {
      await precheck()
    } catch (error) {
      await store.updateMany({
        where: {
          id,
          status: "GENERATING",
          gatewayTaskId: null,
          moderationClaimUntil: task.moderationClaimUntil,
          deletedAt: null,
        },
        data: { moderationClaimUntil: null, moderationNextCheckAt: new Date(Date.now() + 30_000) },
      })
      throw error
    }
    const current = await store.findFirst({ where: { id, deletedAt: null } })
    if (!current || inputHash(current.generationParams) !== state.inputHash)
      throw new ConflictException("任务输入已变更")
    const changed = await store.updateMany({
      where: {
        id,
        deletedAt: null,
        status: "GENERATING",
        moderationStatus: "PASSED",
        gatewayTaskId: null,
        moderationClaimUntil: task.moderationClaimUntil,
      },
      data: { moderation: { ...state, businessSubmitting: true } },
    })
    if (!changed.count) throw new ConflictException("任务状态已变更，不能提交")
  }

  async refresh(key: string, resume = true, submitPending = false): Promise<ModerationTaskRow> {
    const { kind, id } = this.parse(key)
    const store = this.store(kind)
    let task = await store.findFirst({ where: { id, deletedAt: null } })
    if (!task) throw new NotFoundException("审核任务不存在")
    if (!["GENERATING", "WAITING_MODERATION"].includes(task.status)) return task
    const preparing = task.moderation as unknown as ModerationState | null
    if (preparing?.preparing && !submitPending) return task
    if (
      submitPending &&
      preparing?.preparing &&
      preparing.inputHash === inputHash(task.generationParams) &&
      task.status === "WAITING_MODERATION" &&
      (!task.moderationClaimUntil || task.moderationClaimUntil < new Date())
    ) {
      // preparing尚未发出审核创建请求，进程中断后可以安全重做文件快照。
      await store.updateMany({
        where: {
          id,
          deletedAt: null,
          status: "WAITING_MODERATION",
          moderationStatus: "PENDING",
          moderationClaimUntil: task.moderationClaimUntil,
        },
        data: { moderationStatus: null, moderation: Prisma.DbNull, moderationClaimUntil: null },
      })
      task = (await store.findFirst({ where: { id, deletedAt: null } })) ?? task
    }
    if (["PENDING", "PROCESSING"].includes(task.moderationStatus || "")) {
      const claim = new Date(Date.now() + 20_000)
      const acquired = await store.updateMany({
        where: {
          id,
          deletedAt: null,
          moderationStatus: { in: ["PENDING", "PROCESSING"] },
          status: { in: ["GENERATING", "WAITING_MODERATION", "TIMEOUT"] },
          OR: [{ moderationClaimUntil: null }, { moderationClaimUntil: { lt: new Date() } }],
        },
        data: { moderationClaimUntil: claim },
      })
      if (acquired.count) {
        const claimedTask = await store.findFirst({
          where: { id, deletedAt: null, moderationClaimUntil: claim },
        })
        if (claimedTask) {
          try {
            await this.advance(store, claimedTask, claim, kind, submitPending)
          } catch (error) {
            if (!(error instanceof ConflictException)) throw error
          }
        }
      }
      task = (await store.findFirst({ where: { id, deletedAt: null } })) ?? task
    }
    if (
      resume &&
      ((submitPending && !task.moderationStatus) || task.moderationStatus === "PASSED") &&
      !task.gatewayTaskId &&
      (!task.moderationClaimUntil || task.moderationClaimUntil < new Date()) &&
      this.continueTask
    ) {
      await this.continueTask(key, task).catch(async error => {
        if (error instanceof ModerationPendingException || error instanceof ConflictException)
          return
        if (error instanceof BadRequestException) {
          await store.updateMany({
            where: {
              id,
              OR: [{ moderationStatus: "PASSED" }, { moderationStatus: null }],
              status: "GENERATING",
              gatewayTaskId: null,
              deletedAt: null,
            },
            data: {
              status: "FAILED",
              errorMessage: "业务提交前置校验未通过，请检查输入、余额或模型配置",
            },
          })
        }
        this.logger.warn(`内容审核后任务推进待重试 kind=${kind} id=${id}`)
      })
      task = (await store.findFirst({ where: { id, deletedAt: null } })) ?? task
    }
    return task
  }

  private async advance(
    store: TaskStore,
    task: ModerationTaskRow,
    claim: Date,
    kind: TaskKind,
    submitPending: boolean
  ): Promise<void> {
    const state = task.moderation as unknown as ModerationState
    state.refreshError = null
    let status: Status = "PROCESSING"
    const save = async (release = false) => {
      const updated = await store.updateMany({
        where: {
          id: task.id,
          deletedAt: null,
          moderationClaimUntil: claim,
          status: { in: ["GENERATING", "WAITING_MODERATION", "TIMEOUT"] },
        },
        data: {
          moderation: state,
          moderationStatus: status,
          ...(status === "PASSED" ? { moderationPassedAt: new Date() } : {}),
          ...(status === "REJECTED" || status === "FAILED"
            ? { status: "FAILED", errorMessage: state.error?.message }
            : {}),
          ...(release
            ? { moderationClaimUntil: null, moderationNextCheckAt: new Date(Date.now() + 30_000) }
            : {}),
        },
      })
      if (!updated.count) throw new ConflictException("任务状态已变更")
    }
    if (state.preparing || state.inputHash !== inputHash(task.generationParams)) {
      status = "FAILED"
      state.error = { code: "MODERATION_INPUT_CHANGED", message: "任务输入已变更，请重新创建任务" }
      await save(true)
      return
    }
    if (
      !Number.isFinite(Date.parse(state.startedAt)) ||
      Date.now() - Date.parse(state.startedAt) > 23 * 3600_000
    ) {
      status = "FAILED"
      state.error = { code: "MODERATION_TIMEOUT", message: "内容审核超时，请重新创建任务" }
      await save(true)
      return
    }
    const deadline = Date.now() + 10_000
    for (const item of state.items) {
      if (deadline - Date.now() < 1000) break
      if (item.status === "COMPLETED") continue
      if (item.status === "PENDING" && !submitPending) continue
      if (item.status === "SUBMITTING") {
        status = "FAILED"
        state.error = {
          code: "MODERATION_SUBMISSION_UNKNOWN",
          message: "审核提交结果待核对，请重新创建任务",
        }
        break
      }
      if (item.input.type === "TEXT" || item.input.type === "IMAGE") {
        try {
          item.result = await this.provider.check(item.input, deadline - Date.now())
          item.status = "COMPLETED"
        } catch {
          status = "FAILED"
          item.status = "FAILED"
          state.error = {
            code: "MODERATION_UNAVAILABLE",
            message: "内容审核失败，请稍后重新创建任务",
          }
        }
      } else if (item.status === "PENDING") {
        item.status = "SUBMITTING"
        await save()
        try {
          item.receipt = await this.provider.submit(
            item.input,
            `${kind}:${task.id}:${state.inputHash}:${item.input.key}`,
            deadline - Date.now()
          )
          item.status = "PROCESSING"
        } catch {
          status = "FAILED"
          item.status = "FAILED"
          state.error = {
            code: "MODERATION_SUBMISSION_UNKNOWN",
            message: "审核提交结果待核对，请重新创建任务",
          }
        }
      } else if (item.receipt) {
        try {
          const result = await this.provider.poll(
            item.input.type,
            item.receipt,
            deadline - Date.now()
          )
          if (result) {
            item.result = result
            item.status = "COMPLETED"
          }
        } catch {
          // 查询失败保留供应商TaskId，下一次轮询继续，绝不重新提交。
          state.refreshError = {
            code: "MODERATION_REFRESH_UNAVAILABLE",
            message: "审核结果暂时无法更新，请稍后重试",
          }
          break
        }
      } else {
        status = "FAILED"
        state.error = { code: "MODERATION_INVALID_STATE", message: "审核状态异常，请重新创建任务" }
      }
      if (item.result) {
        const decision = this.provider.decide(item.result, item.receipt?.service ?? item.service)
        if (decision !== "PASSED") {
          status = decision === "REJECTED" ? "REJECTED" : "FAILED"
          state.error = {
            code: `MODERATION_${decision}`,
            message:
              decision === "REJECTED"
                ? "输入内容未通过安全审核，请修改后重试"
                : "内容审核未能明确判定，请稍后重试",
          }
        }
      }
      if (status === "FAILED" || status === "REJECTED") break
      await save()
    }
    if (
      status === "PROCESSING" &&
      state.items.length &&
      state.items.every(item => item.status === "COMPLETED")
    )
      status = "PASSED"
    await save(true)
  }

  async ownedKey(type: ModerationBusinessType, taskId: string, userId: number): Promise<string> {
    const key = `${MODERATION_TASKS[type]}:${taskId}`
    const { kind, id } = this.parse(key)
    if (kind === "storyboard-video") {
      const task = await this.prisma.storyboardVideo.findFirst({
        where: {
          id,
          storyboard: { production: { project: { customer: { userId } } } },
        },
        select: { id: true },
      })
      if (!task) throw new NotFoundException("审核任务不存在")
    } else if (!(await this.store(kind).findFirst({ where: { id, userId, deletedAt: null } }))) {
      throw new NotFoundException("审核任务不存在")
    }
    return key
  }

  async billingOwner(key: string) {
    const { kind, id } = this.parse(key)
    let userId: number
    let category: string
    let model: string
    if (kind === "storyboard-video") {
      const row = await this.prisma.storyboardVideo.findFirst({
        where: { id },
        include: {
          storyboard: {
            include: { production: { include: { project: { include: { customer: true } } } } },
          },
        },
      })
      if (!row) throw new NotFoundException("任务不存在")
      userId = row.storyboard.production.project.customer.userId
      category = "STORYBOARD"
      model = (row.generationParams as { model: string }).model
    } else if (kind === "beauty-task") {
      const row = await this.prisma.beautyTask.findFirst({ where: { id } })
      if (!row) throw new NotFoundException("任务不存在")
      userId = row.userId
      category = "BEAUTY"
      model = row.model
    } else {
      const row = await this.prisma.videoTask.findFirst({ where: { id } })
      if (!row) throw new NotFoundException("任务不存在")
      userId = row.userId
      category = row.mode
      model = row.model
    }
    const configured = await this.prisma.aiGatewayModel.findFirst({
      where: { publicId: model, category },
      select: { priceMultiplier: true },
    })
    return { userId, category, priceMultiplier: configured?.priceMultiplier }
  }

  @Interval(10_000)
  async scan(): Promise<void> {
    if (this.scanning || !this.continueTask) return
    this.scanning = true
    try {
      for (const kind of Object.values(MODERATION_TASKS)) {
        const rows = await this.store(kind).findMany({
          where: {
            deletedAt: null,
            gatewayTaskId: null,
            status: { in: ["WAITING_MODERATION", "GENERATING"] },
            AND: [
              {
                OR: [
                  { moderationStatus: { in: ["PENDING", "PROCESSING", "PASSED"] } },
                  { moderationStatus: null, status: "WAITING_MODERATION" },
                ],
              },
              {
                OR: [
                  { moderationNextCheckAt: null },
                  { moderationNextCheckAt: { lte: new Date() } },
                ],
              },
              {
                OR: [{ moderationClaimUntil: null }, { moderationClaimUntil: { lt: new Date() } }],
              },
            ],
          },
          orderBy: { moderationNextCheckAt: "asc" },
          take: 20,
        })
        await Promise.all(
          rows.map(row =>
            this.refresh(`${kind}:${row.id}`, true, true).catch(() =>
              this.logger.warn(`内容审核刷新待重试 kind=${kind} id=${row.id}`)
            )
          )
        )
      }
    } catch {
      this.logger.warn("内容审核扫描暂不可用")
    } finally {
      this.scanning = false
    }
  }
}
