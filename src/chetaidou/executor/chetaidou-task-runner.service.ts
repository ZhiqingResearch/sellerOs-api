import { withAigcUser } from "../../aigc/text-audit"
// 车泰斗素材工作台 — 文本任务执行器（方案 §6/§7）
// BREAKDOWN/IDEATION/REFRESH_GROUP/DIVERGE/COMPOSE 的推进：
// DB 排队扫描 + 状态 CAS + Call 账本（先落库再调模型）+ 校验通过后结算。
// 「不明状态不自动重发」：SUBMITTING 无回执 → UNKNOWN 等对账/人工核对。
import {
  ConflictException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import type { ChatCompletionRequest, ChatMessage } from "@zhiqingresearch/ai-ts-sdk"
import { randomUUID } from "crypto"
import { AiGatewayProvider } from "../../ai-gateway/ai-gateway.provider"
import { PrismaService } from "../../prisma/prisma.service"
import { writeTaskAdjustment } from "../chetaidou-adjustment"
import { ChetaidouBillingService } from "../chetaidou-billing.service"
import { TaskSnapshot } from "../chetaidou-context.service"
import { applyDivergeOutput } from "../chetaidou-draft"
import {
  BREAKDOWN_UNRELATED_MESSAGE,
  COMPOSITION_INVALID_MESSAGE,
  TEXT_TIMEOUT_MESSAGE,
} from "../chetaidou-errors"
import { productHardConstraints } from "../chetaidou-product-constraints"
import { ChetaidouStorageService, stableHash } from "../chetaidou-storage.service"
import {
  CHETAIDOU_CALL_PREFIX,
  CHETAIDOU_SCAN_INTERVAL_MS,
  CHETAIDOU_USAGE_SOURCES,
  chetaidouIdeationStatus,
} from "../chetaidou.constants"
import {
  COMPOSITION_PROMPT,
  DIMENSIONS_PROMPT,
  DIVERGE_PROMPT,
  EXPANSION_PROMPT,
} from "../chetaidou.prompts"
import {
  BREAKDOWN_RESPONSE_SCHEMA,
  ChetaidouGroupDefinition,
  ChetaidouOption,
  ChetaidouSettings,
  compositionScopeKey,
  CompositionValidationContext,
  identifySchemaOf,
  ModelOutputInvalidError,
  parseCompositionJson,
  parseModelJson,
  validateBreakdownResponse,
  validateCompositionOutput,
  validateDivergeOutput,
  validateExpansionOutput,
  validateIdentifyOutput,
} from "../chetaidou.schemas"

import {
  contentSettingsOf,
  dimensionRangeOf,
  IDEATION_BATCH_SIZE,
  IDEATION_BATCH_VERSION,
  optionRangeOf,
} from "../chetaidou-execution"
import { BATCH_EXPANSION_PROMPT } from "../chetaidou.prompts"
import { parseBatchOutput, validateBatchGroupOptions } from "../chetaidou.schemas"

type GroupRow = Prisma.ChetaidouGroupGetPayload<Record<string, never>>
type TaskRow = Prisma.ChetaidouTaskGetPayload<Record<string, never>>

// 已核验的网关 jsonMode 模型；其他模型保留提示词约束。
const JSON_MODE_MODELS = new Set([
  "ZQ-Multimodal-Qwen-3.7-Plus",
  "ZQ-Multimodal-Gemini-3.5-Flash-Lite",
  "gpt-5.5",
])

@Injectable()
export class ChetaidouTaskRunnerService implements OnModuleInit {
  private readonly logger = new Logger(ChetaidouTaskRunnerService.name)
  private scanTimer: NodeJS.Timeout | null = null
  private readonly inFlight = new Set<string>()
  private readonly activeRoots = new Map<string, string>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayProvider,
    private readonly billing: ChetaidouBillingService,
    private readonly storage: ChetaidouStorageService
  ) {}

  onModuleInit(): void {
    this.scanTimer = setInterval(() => {
      void this.scan().catch(err =>
        this.logger.error(`扫描失败：${err instanceof Error ? err.message : String(err)}`)
      )
    }, CHETAIDOU_SCAN_INTERVAL_MS)
    this.scanTimer.unref?.()
    void this.scan().catch(() => undefined)
  }

  /** 只扫描排队任务；运行中断的任务不自动重放模型调用。 */
  async scan(): Promise<void> {
    const candidates = await this.prisma.chetaidouTask.findMany({
      where: { type: { notIn: ["GENERATE", "CROP"] }, status: "QUEUED" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    })
    for (const row of candidates) {
      if (this.inFlight.has(row.id)) continue
      this.inFlight.add(row.id)
      void this.execute(row.id)
        .catch(err => this.logger.error(`任务 ${row.id} 执行异常：${errMessage(err)}`))
        .finally(() => this.inFlight.delete(row.id))
    }
  }

  activeTaskIds(): string[] {
    return [
      ...new Set([...this.inFlight, ...this.activeRoots.keys(), ...this.activeRoots.values()]),
    ]
  }

  /** 只恢复已经落库的回复；无回执的已提交调用不能重发。 */
  async reconcileWaitingTasks(): Promise<void> {
    const tasks = await this.prisma.chetaidouTask.findMany({
      where: { type: { notIn: ["GENERATE", "CROP"] }, status: "WAITING_RECONCILIATION" },
      orderBy: { updatedAt: "asc" },
    })
    for (const task of tasks) {
      if (this.activeTaskIds().includes(task.id)) continue
      const calls = await this.prisma.chetaidouCall.findMany({
        where: { taskId: task.id, kind: "TEXT" },
      })
      const received = calls.filter(call => call.gatewayResponse != null)
      if (!received.length) continue
      if (task.type === "IDEATION") {
        const groups = await this.prisma.chetaidouGroup.findMany({
          where: { taskId: task.rootTaskId },
        })
        if (
          groups.length &&
          !groups.some(
            group =>
              (group.status === "PENDING" && !group.currentCallId) ||
              ((["UNKNOWN", "RUNNING", "SETTLING"].includes(group.status) ||
                group.errorCode === "OUTPUT_APPLY_FAILED") &&
                received.some(call => call.id === group.currentCallId))
          ) &&
          groups.some(group => ["UNKNOWN", "RUNNING", "SETTLING", "PENDING"].includes(group.status))
        )
          continue
      } else if (!received.some(call => call.outcome !== "INVALID")) continue
      this.inFlight.add(task.id)
      void this.execute(task.id, true)
        .catch(error => this.logger.error(`任务 ${task.id} 核对异常：${errMessage(error)}`))
        .finally(() => this.inFlight.delete(task.id))
    }
  }

  /** 状态认领只允许一个执行者；无需租约与心跳。 */
  async execute(taskId: string, reconcile = false): Promise<void> {
    const claimed = await this.prisma.chetaidouTask.updateMany({
      where: {
        id: taskId,
        type: { notIn: ["GENERATE", "CROP"] },
        status: reconcile ? "WAITING_RECONCILIATION" : "QUEUED",
      },
      data: { status: "RUNNING", errorCode: null, errorMessage: null },
    })
    if (claimed.count === 0) return
    const task = await this.prisma.chetaidouTask.findUnique({ where: { id: taskId } })
    if (!task || ["GENERATE", "CROP"].includes(task.type)) return

    this.activeRoots.set(task.id, task.rootTaskId)
    try {
      // 取消标记检查
      if (task.cancelRequestedAt) {
        await this.finishTask(task, "CANCELLED", null, null)
        return
      }
      if (reconcile && task.type !== "IDEATION" && task.output) {
        const accepted = await this.prisma.chetaidouCall.findFirst({
          where: { taskId: task.id, outcome: "ACCEPTED" },
        })
        if (accepted) {
          if (task.type === "DIVERGE") {
            const output = task.output as {
              customDimensionId?: string
              newOptions?: ChetaidouOption[]
            }
            await this.applyDivergeToDraft(task, output.customDimensionId, output.newOptions ?? [])
          }
          await this.settleAcceptedCall(accepted.id, accepted.model)
          await this.finishTask(task, "SUCCEEDED", null, null)
          return
        }
      }
      switch (task.type) {
        case "BREAKDOWN":
          await this.runBreakdown(task)
          break
        case "IDEATION":
          if (
            reconcile &&
            (await this.prisma.chetaidouGroup.count({ where: { taskId: task.rootTaskId } }))
          )
            await this.reconcileIdeation(task)
          else await this.runIdeation(task)
          break
        case "REFRESH_GROUP":
          await this.runRefreshGroup(task)
          break
        case "DIVERGE":
          await this.runDiverge(task)
          break
        case "COMPOSE":
          await this.runCompose(task)
          break
      }
    } catch (error) {
      const message = errMessage(error)
      this.logger.error(`任务 ${task.id}(${task.type}) 失败：${message}`)
      await this.finishTask(
        task,
        error instanceof UnknownCallError ? "WAITING_RECONCILIATION" : "FAILED",
        error instanceof UnknownCallError
          ? "CALL_STATUS_UNKNOWN"
          : error instanceof GatewayTimeoutException
            ? "PROVIDER_TIMEOUT"
            : "PROVIDER_ERROR",
        error instanceof UnknownCallError ? "模型调用状态待核对，请勿重复提交" : message
      ).catch(() => undefined)
    } finally {
      this.activeRoots.delete(task.id)
    }
  }

  // ── Call 账本与 LLM 调用 ────────────────────────────────────────────────

  /** 创建/复用 Call（唯一约束 [taskId,targetKey,attempt]；重试任务尝试次数独立） */
  private async openCall(input: {
    task: TaskRow
    targetKey: string
    kind: "TEXT" | "IMAGE"
    source: string
    model: string
    promptVersion: string
    groupId?: string
    request: unknown
    estimatedCny: number
    singleAttempt?: boolean
  }): Promise<string> {
    let request = input.request
    if (input.kind === "TEXT" && JSON_MODE_MODELS.has(input.model)) {
      const textRequest = input.request as ChatCompletionRequest
      request = {
        ...textRequest,
        response_format: { type: "json_object" },
        // JSON mode 要求消息含 JSON；兼容未带该关键词的旧冻结模板。
        messages: /json/i.test(JSON.stringify(textRequest.messages))
          ? textRequest.messages
          : [
              {
                role: "system",
                content: "请只输出一个完整的 JSON 对象，不要输出 Markdown 或解释文字。",
              },
              ...textRequest.messages,
            ],
      }
    }
    // 找同 targetKey 未终结 Call 复用（进程重启后恢复）
    const pending = await this.prisma.chetaidouCall.findFirst({
      where: { taskId: input.task.id, targetKey: input.targetKey },
      orderBy: { attempt: "desc" },
    })
    // COMPOSE 每个 target 仅一行，包含已完成/未知状态，不能通过重入追加付费调用。
    if (input.singleAttempt && pending) return pending.id
    if (pending?.gatewayResponse !== null && pending?.gatewayResponse !== undefined)
      return pending.id
    const matches =
      pending &&
      (sameRequest(pending.request, input.request) || sameRequest(pending.request, request))
    if (pending && ["PREPARED", "SUBMITTING", "WAITING"].includes(pending.state) && matches) {
      return pending.id
    }
    if (pending && pending.state === "UNKNOWN" && matches) {
      // 不明状态不重发（方案 §6.3）
      throw new UnknownCallError(pending.id)
    }
    const id = randomUUID()
    await this.prisma.chetaidouCall.create({
      data: {
        id,
        taskId: input.task.id,
        rootTaskId: input.task.rootTaskId,
        ownerId: input.task.ownerId,
        targetKey: input.targetKey,
        groupId: input.groupId,
        attempt: (pending?.attempt ?? 0) + 1,
        kind: input.kind,
        source: input.source,
        model: input.model,
        category: (input.task.snapshot as unknown as TaskSnapshot).models.text.category,
        promptVersion: input.promptVersion,
        request: request as object,
        requestHash: stableHash(request),
        providerIdempotencyKey: `${CHETAIDOU_CALL_PREFIX}${id}`,
        state: "PREPARED",
        billingStatus: "PENDING",
        estimatedSaleCny: input.estimatedCny.toFixed(8),
      },
    })
    return id
  }

  /** 发送一次 LLM 调用：CAS PREPARED→SUBMITTING 后只发一次 */
  private async callLlm(callId: string, request: ChatCompletionRequest): Promise<string> {
    const stored = await this.prisma.chetaidouCall.findUnique({ where: { id: callId } })
    if (!stored) throw new Error(`Call 不存在：${callId}`)
    if (stored.gatewayResponse != null) return extractText(stored.gatewayResponse)
    // 恢复已有调用必须使用其原请求；取消上限只作用于新建 Call，不改写历史账本。
    const frozenRequest = (stored.request ?? request) as unknown as ChatCompletionRequest
    const submit = await this.prisma.chetaidouCall.updateMany({
      where: { id: callId, state: "PREPARED" },
      data: { state: "SUBMITTING", submittedAt: new Date() },
    })
    if (submit.count === 0) {
      // 已提交过（重启恢复）：读已有回执
      const call = await this.prisma.chetaidouCall.findUnique({ where: { id: callId } })
      if (!call) throw new Error(`Call 不存在：${callId}`)
      if (call.gatewayResponse !== null && call.gatewayResponse !== undefined)
        return extractText(call.gatewayResponse)
      if (["SUBMITTING", "WAITING", "UNKNOWN"].includes(call.state)) {
        await this.prisma.chetaidouCall.update({
          where: { id: callId },
          data: { state: "UNKNOWN", errorCode: "CALL_STATUS_UNKNOWN" },
        })
        throw new UnknownCallError(callId)
      }
      return extractText(call.gatewayResponse)
    }
    let result: Awaited<ReturnType<AiGatewayProvider["completeMultimodal"]>>
    try {
      result = await withAigcUser(stored.ownerId, () => this.gateway.completeMultimodal(frozenRequest, undefined, true))
    } catch (error) {
      if (error instanceof GatewayTimeoutException) {
        await this.prisma.chetaidouCall.update({
          where: { id: callId },
          data: {
            state: "FINISHED",
            outcome: "PROVIDER_FAILED",
            billingStatus: "REVIEW",
            errorCode: "PROVIDER_TIMEOUT",
            errorMessage: errMessage(error).slice(0, 1000),
            finishedAt: new Date(),
          },
        })
        throw new GatewayTimeoutException(TEXT_TIMEOUT_MESSAGE)
      }
      await this.prisma.chetaidouCall
        .update({
          where: { id: callId },
          data: {
            state: "UNKNOWN",
            errorCode: "CALL_STATUS_UNKNOWN",
            errorMessage: errMessage(error).slice(0, 1000),
          },
        })
        .catch(() => undefined)
      throw new UnknownCallError(callId, errMessage(error))
    }
    const { completion, requestId } = result
    // 回复不可从网关重取，数据库短暂不可用时保留内存中的原结果并继续保存。
    for (;;) {
      try {
        await this.prisma.chetaidouCall.update({
          where: { id: callId },
          data: {
            state: "RECEIVED",
            gatewayRequestId: requestId,
            gatewayResponse: completion as unknown as object,
            usage: completion.usage
              ? {
                  promptTokens: completion.usage.prompt_tokens,
                  completionTokens: completion.usage.completion_tokens,
                  amount: completion.usage.amount,
                }
              : undefined,
            receivedAt: new Date(),
            errorCode: null,
            errorMessage: null,
          },
        })
        return extractText(completion)
      } catch (error) {
        this.logger.warn(`调用 ${callId} 回复保存失败，继续保存原结果：${errMessage(error)}`)
        await new Promise(resolve => setTimeout(resolve, CHETAIDOU_SCAN_INTERVAL_MS))
      }
    }
  }

  private async reconcileIdeation(task: TaskRow): Promise<void> {
    const snapshot = task.snapshot as unknown as TaskSnapshot
    const groupIds = (task.input as { groupIds?: string[] }).groupIds
    const groups = await this.prisma.chetaidouGroup.findMany({
      where: {
        taskId: task.rootTaskId,
        ...(groupIds?.length ? { id: { in: groupIds } } : {}),
      },
    })
    const calls = await this.prisma.chetaidouCall.findMany({
      where: { taskId: task.id, kind: "TEXT" },
    })
    for (const call of calls) {
      const pending = groups.filter(
        group => group.currentCallId === call.id && group.status !== "SUCCEEDED"
      )
      if (call.gatewayResponse == null) continue
      if (!pending.length) {
        const manifest = (
          task.input as { expansionBatches?: { targetKey: string; groupIds: string[] }[] }
        ).expansionBatches
        const ids = manifest?.find(batch => batch.targetKey === call.targetKey)?.groupIds ?? []
        if (
          call.state === "RECEIVED" &&
          ids.length &&
          ids.every(id => groups.some(group => group.id === id && group.status === "SUCCEEDED"))
        )
          await this.settleAndApply(call.id, call.model, async () => {})
        continue
      }
      if (!call.targetKey.startsWith("batch:")) {
        for (const group of pending)
          await this.expandGroup(task, snapshot, group, { isRefresh: false })
        continue
      }
      try {
        const raw = parseBatchOutput(extractText(call.gatewayResponse), call.id)
        const successes = await Promise.all(
          pending.map(group => this.processBatchGroup(task, snapshot, group, raw, call.id))
        )
        if (call.outcome === "INVALID") continue
        if (successes.every(Boolean)) await this.settleAndApply(call.id, call.model, async () => {})
        else await this.markCallInvalid(call.id, "本批部分维度未成功，整批不扣费")
      } catch (error) {
        await this.markCallInvalid(call.id, errMessage(error))
        await Promise.all(pending.map(group => this.failBatchGroup(task, group, error, call.id)))
      }
    }
    const fresh = groups.filter(group => group.status === "PENDING" && !group.currentCallId)
    if (fresh.length) await this.expandIdeationGroups(task, snapshot, fresh)
    await this.aggregateIdeation(task, snapshot)
  }

  /** 先事务保存合格结果与成功标记，再结算；失败不进入补扣队列。 */
  private async settleAndApply(
    callId: string,
    model: string,
    apply: (tx: Prisma.TransactionClient) => Promise<void>
  ): Promise<void> {
    // 正常完成路径先保存结果再扣费；待核对调用由后台按实际账单结算。
    await this.prisma.$transaction(
      async tx => {
        await apply(tx)
        await tx.chetaidouCall.update({
          where: { id: callId },
          data: { state: "FINISHED", outcome: "ACCEPTED", finishedAt: new Date() },
        })
      },
      { timeout: 30_000 }
    )
    await this.settleAcceptedCall(callId, model)
  }

  private async settleAcceptedCall(callId: string, model: string): Promise<void> {
    try {
      const call = await this.prisma.chetaidouCall.findUnique({ where: { id: callId } })
      if (!call || call.outcome !== "ACCEPTED" || ["FREE", "SETTLED"].includes(call.billingStatus))
        return
      const amount = call.gatewayRequestId
        ? await this.billing.lookupTextUsage(call.gatewayRequestId)
        : null
      await this.prisma.$transaction(
        async tx => {
          await this.billing.settleTextInTx(tx, { id: callId, model }, amount)
        },
        { timeout: 60_000 }
      )
    } catch (error) {
      this.logger.warn(`成功调用结算待对账（callId=${callId}）：${errMessage(error)}`)
    }
  }

  // ── BREAKDOWN ───────────────────────────────────────────────────────────

  private async runBreakdown(task: TaskRow): Promise<void> {
    const snapshot = task.snapshot as unknown as TaskSnapshot
    await this.setStage(task, "拆解母版中")
    const imageUrl = await this.storage.signForModel(snapshot.image.fileKey)
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: snapshot.prompt.templateBodies.breakdown,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              facts: snapshot.facts.content,
              outputSchema: BREAKDOWN_RESPONSE_SCHEMA,
            }),
          },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ]
    const request: ChatCompletionRequest = {
      model: snapshot.models.text.publicId,
      messages,
    }
    const callId = await this.openCall({
      task,
      targetKey: "breakdown",
      kind: "TEXT",
      source: CHETAIDOU_USAGE_SOURCES.breakdown,
      model: snapshot.models.text.publicId,
      promptVersion: snapshot.prompt.version,
      request,
      estimatedCny: 1,
    })
    let text: string
    try {
      text = await this.callLlm(callId, request)
    } catch (error) {
      if (error instanceof UnknownCallError) {
        await this.finishTask(
          task,
          "WAITING_RECONCILIATION",
          "CALL_STATUS_UNKNOWN",
          "拆解调用状态待核对"
        )
        return
      }
      throw error
    }
    let response: ReturnType<typeof validateBreakdownResponse>
    try {
      response = validateBreakdownResponse(parseModelJson(text, callId))
    } catch (error) {
      await this.markCallInvalid(callId, errMessage(error))
      await this.finishTask(
        task,
        "FAILED",
        "MODEL_OUTPUT_INVALID",
        `拆解输出不合格：${errMessage(error)}`
      )
      return
    }
    if ("status" in response) {
      await this.markCallInvalid(callId, response.reason, "IMAGE_UNRELATED_TO_SKU")
      await this.finishTask(task, "FAILED", "IMAGE_UNRELATED_TO_SKU", BREAKDOWN_UNRELATED_MESSAGE)
      return
    }

    const payload = response
    const contentHash = stableHash(payload)
    await this.settleAndApply(callId, snapshot.models.text.publicId, async tx => {
      // 追加拆解版本并换当前指针（CAS activeBreakdownTaskId 仍是本任务链）
      const image = await tx.chetaidouImage.findUnique({ where: { id: task.imageId } })
      if (!image) throw new Error("母版不存在")
      const version = (await tx.chetaidouBreakdown.count({ where: { imageId: image.id } })) + 1
      const created = await tx.chetaidouBreakdown.create({
        data: {
          imageId: image.id,
          version,
          factId: snapshot.facts.id,
          source: "AI",
          qualityStatus: "AI_UNREVIEWED",
          payload: payload as unknown as object,
          schemaVersion: 1,
          contentHash,
        },
      })
      const switched = await tx.chetaidouImage.updateMany({
        where: { id: image.id, activeBreakdownTaskId: { in: [task.id, task.rootTaskId] } },
        data: { currentBreakdownId: created.id, activeBreakdownTaskId: null },
      })
      if (switched.count === 0) {
        // 后来的任务已占位：保留版本但不切当前指针
        this.logger.warn(`拆解版本 ${created.id} 未切换当前指针（已有更新的任务）`)
      }
      await tx.chetaidouTask.update({
        where: { id: task.id },
        data: {
          output: { breakdownId: created.id, version: created.version },
          stage: null,
        },
      })
    })
    await this.finishTask(task, "SUCCEEDED", null, null)
  }

  private async markCallInvalid(
    callId: string,
    error: string,
    errorCode = "MODEL_OUTPUT_INVALID"
  ): Promise<void> {
    await this.prisma.chetaidouCall.updateMany({
      where: { id: callId, billingStatus: { not: "SETTLED" } },
      data: {
        outcome: "INVALID",
        state: "FINISHED",
        billingStatus: "FREE",
        chargedCredits: "0",
        errorCode,
        errorMessage: error.slice(0, 1000),
        finishedAt: new Date(),
      },
    })
  }

  private parseTextOutput(snapshot: TaskSnapshot, text: string, callId?: string): unknown {
    try {
      return parseModelJson(text, callId)
    } catch (error) {
      if (snapshot.execution) throw new ModelOutputInvalidError("模型输出不是有效 JSON")
      throw error
    }
  }

  private batchRequest(snapshot: TaskSnapshot, groups: GroupRow[]): ChatCompletionRequest {
    return {
      model: snapshot.models.text.publicId,
      messages: [
        {
          role: "system",
          content: snapshot.prompt.templateBodies.batchExpansion ?? BATCH_EXPANSION_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify({
            dimensions: groups.map(g => ({
              ...(g.definition as unknown as ChetaidouGroupDefinition),
              selectionMode: "single",
            })),
            optionCountRange: optionRangeOf(snapshot.settings),
            facts: snapshot.facts.content,
            breakdown: snapshot.breakdown?.payload ?? null,
            settings: { ...snapshot.settings, locale: localeOf(snapshot.settings) },
          }),
        },
      ],
    }
  }

  private async expandIdeationGroups(
    task: TaskRow,
    snapshot: TaskSnapshot,
    groups: GroupRow[]
  ): Promise<void> {
    if (snapshot.execution?.version !== IDEATION_BATCH_VERSION) {
      await Promise.all(groups.map(g => this.expandGroup(task, snapshot, g, { isRefresh: false })))
      return
    }
    const remaining: GroupRow[] = []
    for (const group of groups) {
      // 收到有效结果但应用失败：仅重放回执，不再次购买模型生成。
      if (group.currentCallId && group.errorCode === "OUTPUT_APPLY_FAILED") {
        const call = await this.prisma.chetaidouCall.findUnique({
          where: { id: group.currentCallId },
        })
        if (
          call &&
          call.rootTaskId === task.rootTaskId &&
          ["RECEIVED", "FINISHED"].includes(call.state)
        ) {
          try {
            const raw = parseBatchOutput(extractText(call.gatewayResponse), call.id)
            const options = validateBatchGroupOptions(
              raw,
              group.definition as unknown as ChetaidouGroupDefinition,
              snapshot.settings,
              optionRangeOf(snapshot.settings),
              call.id
            )
            await this.applyBatchGroup(task, group, options, call.id)
            continue
          } catch (error) {
            await this.failBatchGroup(task, group, error, call.id)
            continue
          }
        }
        // 原回执无法取得时保持可核对状态，不盲目新增模型调用。
        await this.failBatchGroup(
          task,
          group,
          new UnknownCallError(group.currentCallId),
          group.currentCallId
        )
        continue
      }
      remaining.push(group)
    }
    const batches: GroupRow[][] = []
    for (let i = 0; i < remaining.length; i += IDEATION_BATCH_SIZE)
      batches.push(remaining.slice(i, i + IDEATION_BATCH_SIZE))
    const manifest = batches.map(batch => ({
      targetKey: `batch:${stableHash(batch.map(g => g.id))}`,
      groupIds: batch.map(g => g.id),
    }))
    await this.prisma.chetaidouTask.update({
      where: { id: task.id },
      data: { input: { ...(task.input as object), expansionBatches: manifest } },
    })
    await Promise.all(
      batches.map((batch, index) =>
        this.expandBatch(task, snapshot, batch, manifest[index].targetKey)
      )
    )
  }

  private async expandBatch(
    task: TaskRow,
    snapshot: TaskSnapshot,
    groups: GroupRow[],
    targetKey: string
  ): Promise<void> {
    const request = this.batchRequest(snapshot, groups)
    let callId: string | undefined
    try {
      await this.prisma.$transaction(
        async tx => {
          const claimed = await tx.chetaidouGroup.updateMany({
            where: { id: { in: groups.map(g => g.id) }, status: { in: ["PENDING", "FAILED"] } },
            data: { status: "RUNNING" },
          })
          if (claimed.count !== groups.length) throw new ConflictException("批次维度状态已变化")
        },
        { timeout: 30_000 }
      )
      callId = await this.openCall({
        task,
        targetKey,
        singleAttempt: true,
        kind: "TEXT",
        source: CHETAIDOU_USAGE_SOURCES.ideation,
        model: snapshot.models.text.publicId,
        promptVersion: snapshot.prompt.version,
        request,
        estimatedCny: 0,
      })
      await this.prisma.chetaidouGroup.updateMany({
        where: { id: { in: groups.map(g => g.id) }, status: "RUNNING" },
        data: { currentCallId: callId },
      })
      const text = await this.callLlm(callId, request)
      const raw = parseBatchOutput(text, callId)
      const successes = await Promise.all(
        groups.map(group => this.processBatchGroup(task, snapshot, group, raw, callId!))
      )
      if (successes.every(Boolean)) {
        await this.settleAndApply(callId, snapshot.models.text.publicId, async () => {})
      } else {
        // 供应商没有逐维成本；部分失败整批免扣，成功结果仍保留。
        await this.markCallInvalid(callId, "本批部分维度未成功，整批不扣费")
      }
    } catch (error) {
      if (
        callId &&
        !(error instanceof UnknownCallError) &&
        !(error instanceof GatewayTimeoutException)
      )
        await this.markCallInvalid(callId, errMessage(error))
      const unknownId = error instanceof UnknownCallError ? error.callId : callId
      await Promise.all(groups.map(g => this.failBatchGroup(task, g, error, unknownId)))
    }
  }

  private async processBatchGroup(
    task: TaskRow,
    snapshot: TaskSnapshot,
    group: GroupRow,
    raw: ReturnType<typeof parseBatchOutput>,
    callId: string
  ): Promise<boolean> {
    try {
      const options = validateBatchGroupOptions(
        raw,
        group.definition as unknown as ChetaidouGroupDefinition,
        snapshot.settings,
        optionRangeOf(snapshot.settings),
        callId
      )
      await this.applyBatchGroup(task, group, options, callId)
      return true
    } catch (error) {
      await this.failBatchGroup(task, group, error, callId)
      return false
    }
  }

  private async applyBatchGroup(
    task: TaskRow,
    group: GroupRow,
    options: ChetaidouOption[],
    callId: string
  ): Promise<void> {
    try {
      // 先持久化产物 Call 引用，应用失败仍可按原回执恢复。
      await this.prisma.chetaidouGroup.updateMany({
        where: { id: group.id, status: { not: "SUCCEEDED" } },
        data: { currentCallId: callId },
      })
      await this.prisma.$transaction(
        async tx => {
          await this.saveSuccessfulGroup(
            tx,
            task,
            group,
            options.map(o => ({ ...o, selectionId: randomUUID(), origin: "AI" }))
          )
        },
        { timeout: 30_000 }
      )
    } catch (error) {
      throw new OutputApplyError(errMessage(error))
    }
    await this.bumpProgress(task)
  }

  private async failBatchGroup(
    task: TaskRow,
    group: GroupRow,
    error: unknown,
    callId?: string
  ): Promise<void> {
    await this.prisma.chetaidouGroup.updateMany({
      where: { id: group.id, status: { not: "SUCCEEDED" } },
      data: {
        status: error instanceof UnknownCallError ? "UNKNOWN" : "FAILED",
        errorCode:
          error instanceof UnknownCallError
            ? "CALL_STATUS_UNKNOWN"
            : error instanceof GatewayTimeoutException
              ? "PROVIDER_TIMEOUT"
              : error instanceof OutputApplyError
                ? "OUTPUT_APPLY_FAILED"
                : "MODEL_OUTPUT_INVALID",
        errorMessage: errMessage(error).slice(0, 1000),
        ...(callId ? { currentCallId: callId } : {}),
      },
    })
    await this.bumpProgress(task)
  }

  private async runIdeation(task: TaskRow): Promise<void> {
    const snapshot = task.snapshot as unknown as TaskSnapshot
    // 失败重试（根任务已有冻结清单）时跳过识别，直接补跑未成功组
    const existingBefore = await this.prisma.chetaidouGroup.count({
      where: { taskId: task.rootTaskId },
    })
    if (existingBefore > 0) {
      await this.setStage(task, "逐维扩展中")
      const groups = await this.prisma.chetaidouGroup.findMany({
        where: {
          taskId: task.rootTaskId,
          status: { in: ["PENDING", "FAILED"] },
          ...((task.input as { groupIds?: string[] }).groupIds?.length
            ? { id: { in: (task.input as { groupIds: string[] }).groupIds } }
            : {}),
        },
        orderBy: { order: "asc" },
      })
      await this.expandIdeationGroups(task, snapshot, groups)
      await this.aggregateIdeation(task, snapshot)
      return
    }
    await this.setStage(task, "识别维度中")

    // 阶段1：维度识别
    const identifyRequest: ChatCompletionRequest = {
      model: snapshot.models.text.publicId,
      messages: [
        { role: "system", content: snapshot.prompt.templateBodies.dimensions ?? DIMENSIONS_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            ...(snapshot.execution
              ? { dimensionCountRange: dimensionRangeOf(snapshot.settings) }
              : {}),
            outputSchema: identifySchemaOf(snapshot.settings),
            facts: snapshot.facts.content,
            breakdown: snapshot.breakdown?.payload ?? null,
            settings: {
              ...contentSettingsOf(snapshot.settings),
              locale: localeOf(snapshot.settings),
            },
          }),
        },
      ],
    }
    const identifyCallId = await this.openCall({
      task,
      targetKey: "identify",
      kind: "TEXT",
      source: CHETAIDOU_USAGE_SOURCES.ideation,
      model: snapshot.models.text.publicId,
      promptVersion: snapshot.prompt.version,
      request: identifyRequest,
      estimatedCny: 2,
    })
    let identified: { summary: string; groups: ChetaidouGroupDefinition[] }
    let identifyText: string
    try {
      identifyText = await this.callLlm(identifyCallId, identifyRequest)
    } catch (error) {
      if (error instanceof UnknownCallError) {
        await this.finishTask(
          task,
          "WAITING_RECONCILIATION",
          "CALL_STATUS_UNKNOWN",
          "识别调用状态待核对"
        )
        return
      }
      throw error
    }
    try {
      const parsed = validateIdentifyOutput(
        this.parseTextOutput(snapshot, identifyText, identifyCallId),
        {
          breakdown: snapshot.breakdown?.payload ?? null,
          settings: snapshot.settings,
          callId: identifyCallId,
          ...(snapshot.execution ? { countRange: dimensionRangeOf(snapshot.settings) } : {}),
        }
      )
      identified = { summary: parsed.summary, groups: parsed.groups }
    } catch (error) {
      await this.markCallInvalid(identifyCallId, errMessage(error))
      await this.finishTask(
        task,
        "FAILED",
        "MODEL_OUTPUT_INVALID",
        `维度识别不合格：${errMessage(error)}`
      )
      return
    }

    // 冻结维度清单（Group 行）
    const existingGroups = await this.prisma.chetaidouGroup.findMany({
      where: { taskId: task.rootTaskId },
    })
    if (existingGroups.length === 0) {
      // createMany 一次插入全部组（远程库 RTT 高，逐条 create 会超交互事务窗口）
      await this.prisma.$transaction(
        async tx => {
          await tx.chetaidouGroup.createMany({
            data: identified.groups.map((g, i) => ({
              id: randomUUID(),
              taskId: task.rootTaskId,
              key: g.key,
              definition: g as unknown as object,
              status: "PENDING",
              order: i,
            })),
          })
          await tx.chetaidouTask.update({
            where: { id: task.id },
            data: {
              progress: { total: identified.groups.length, processed: 0, succeeded: 0, failed: 0 },
            },
          })
        },
        { timeout: 30_000 }
      )
    }
    const groups = await this.prisma.chetaidouGroup.findMany({
      where: {
        taskId: task.rootTaskId,
        status: { in: ["PENDING", "FAILED"] },
        ...((task.input as { groupIds?: string[] }).groupIds?.length
          ? { id: { in: (task.input as { groupIds: string[] }).groupIds } }
          : {}),
      },
      orderBy: { order: "asc" },
    })
    await this.setStage(task, "逐维扩展中")

    // 阶段2：逐维扩展（单维失败隔离）
    await this.expandIdeationGroups(task, snapshot, groups)

    // 收尾聚合
    await this.aggregateIdeation(task, snapshot)
  }

  /** A5 扩展单个维度（IDEATION 与 REFRESH_GROUP 共用） */
  private async expandGroup(
    task: TaskRow,
    snapshot: TaskSnapshot,
    group: GroupRow,
    opts: { isRefresh: boolean }
  ): Promise<void> {
    try {
      if (snapshot.execution && group.currentCallId && group.errorCode === "OUTPUT_APPLY_FAILED") {
        const call = await this.prisma.chetaidouCall.findUnique({
          where: { id: group.currentCallId },
        })
        if (!call || !["RECEIVED", "FINISHED"].includes(call.state))
          throw new UnknownCallError(group.currentCallId)
        const options = validateExpansionOutput(
          this.parseTextOutput(snapshot, extractText(call.gatewayResponse), call.id),
          {
            definition: group.definition as unknown as ChetaidouGroupDefinition,
            settings: snapshot.settings,
            countRange: optionRangeOf(snapshot.settings),
            callId: call.id,
          }
        )
        await this.settleAndApply(call.id, call.model, async tx => {
          await this.saveSuccessfulGroup(tx, task, group, [
            ...(opts.isRefresh
              ? ((snapshot.refresh?.retainedOptions as ChetaidouOption[]) ?? [])
              : []),
            ...options.map(o => ({ ...o, selectionId: randomUUID(), origin: "AI" as const })),
          ])
        }).catch(error => {
          throw new OutputApplyError(errMessage(error))
        })
        await this.bumpProgress(task)
        return
      }
      await this.expandSingleGroup(task, snapshot, group, opts)
    } catch (error) {
      if (!snapshot.execution) throw error
      await this.failBatchGroup(
        task,
        group,
        error,
        error instanceof UnknownCallError ? error.callId : (group.currentCallId ?? undefined)
      )
    }
  }

  private async expandSingleGroup(
    task: TaskRow,
    snapshot: TaskSnapshot,
    group: Prisma.ChetaidouGroupGetPayload<Record<string, never>>,
    opts: { isRefresh: boolean }
  ): Promise<void> {
    const definition: ChetaidouGroupDefinition = {
      ...(group.definition as unknown as ChetaidouGroupDefinition),
      selectionMode: "single",
    }
    await this.prisma.chetaidouGroup.updateMany({
      where: { id: group.id, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "RUNNING", currentCallId: null },
    })
    const history = opts.isRefresh ? ((snapshot.refresh?.history as ChetaidouOption[]) ?? []) : []
    const retainedKeys = opts.isRefresh
      ? new Set(((snapshot.refresh?.retainedOptions as ChetaidouOption[]) ?? []).map(o => o.key))
      : new Set<string>()
    const maxNew = opts.isRefresh
      ? Math.min(60, 60 + Math.max(0, retainedKeys.size)) // 新增 30–60，保留项不计入
      : undefined
    const request: ChatCompletionRequest = {
      model: snapshot.models.text.publicId,
      messages: [
        { role: "system", content: snapshot.prompt.templateBodies.expansion ?? EXPANSION_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            dimension: definition,
            ...(snapshot.execution ? { optionCountRange: optionRangeOf(snapshot.settings) } : {}),
            facts: snapshot.facts.content,
            breakdown: snapshot.breakdown?.payload ?? null,
            settings: { ...snapshot.settings, locale: localeOf(snapshot.settings) },
            selected: opts.isRefresh ? (snapshot.refresh?.retainedOptions ?? []) : [],
            history: history.map(o => ({ key: o.key, label: o.label })),
          }),
        },
      ],
    }
    const callId = await this.openCall({
      task,
      targetKey: `group:${group.id}`,
      kind: "TEXT",
      source: CHETAIDOU_USAGE_SOURCES.ideation,
      model: snapshot.models.text.publicId,
      promptVersion: snapshot.prompt.version,
      groupId: group.id,
      request,
      estimatedCny: 1,
    })
    await this.prisma.chetaidouGroup.update({
      where: { id: group.id },
      data: { currentCallId: callId },
    })
    let text: string
    try {
      text = await this.callLlm(callId, request)
    } catch (error) {
      const message = error instanceof UnknownCallError ? "扩展调用状态待核对" : errMessage(error)
      const state = error instanceof UnknownCallError ? "UNKNOWN" : "FAILED"
      await this.prisma.chetaidouGroup.update({
        where: { id: group.id },
        data: {
          status: state,
          errorCode:
            error instanceof GatewayTimeoutException ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR",
          errorMessage: message.slice(0, 1000),
        },
      })
      await this.bumpProgress(task)
      return
    }
    let options: ChetaidouOption[]
    try {
      options = validateExpansionOutput(this.parseTextOutput(snapshot, text, callId), {
        definition,
        settings: snapshot.settings,
        callId,
        ...(snapshot.execution
          ? { countRange: optionRangeOf(snapshot.settings) }
          : maxNew
            ? { maxOptions: maxNew }
            : {}),
      })
    } catch (error) {
      await this.markCallInvalid(callId, errMessage(error))
      await this.failBatchGroup(task, group, new ModelOutputInvalidError(errMessage(error)), callId)
      return
    }
    // 服务端规范化：分配 selectionId；刷新场景追加保留项
    const normalized = options.map(o => ({
      ...o,
      key: o.key,
      selectionId: randomUUID(),
      origin: "AI" as const,
    }))
    const finalOptions: ChetaidouOption[] = opts.isRefresh
      ? [...((snapshot.refresh?.retainedOptions as ChetaidouOption[]) ?? []), ...normalized]
      : normalized

    if (snapshot.execution)
      await this.prisma.chetaidouGroup.update({
        where: { id: group.id },
        data: { currentCallId: callId },
      })
    try {
      await this.settleAndApply(callId, snapshot.models.text.publicId, async tx => {
        await this.saveSuccessfulGroup(tx, task, group, finalOptions)
      })
    } catch (error) {
      // 结果保存失败只隔离该组，不扣费；重试优先恢复原回执。
      const message = `结果保存失败（可重试）：${errMessage(error)}`
      this.logger.error(`组 ${group.id} ${message}`)
      await this.prisma.chetaidouGroup
        .update({
          where: { id: group.id },
          data: {
            status: "FAILED",
            errorCode: snapshot.execution ? "OUTPUT_APPLY_FAILED" : "PROVIDER_ERROR",
            errorMessage: message.slice(0, 1000),
          },
        })
        .catch(() => undefined)
      await this.bumpProgress(task)
      return
    }
    await this.bumpProgress(task)
  }

  private async bumpProgress(task: TaskRow): Promise<void> {
    const groups = await this.prisma.chetaidouGroup.findMany({
      where: { taskId: task.rootTaskId },
      select: { status: true },
    })
    const succeeded = groups.filter(g => g.status === "SUCCEEDED").length
    const failed = groups.filter(g => g.status === "FAILED").length
    const processed = succeeded + failed
    await this.prisma.chetaidouTask
      .update({
        where: { id: task.rootTaskId },
        data: { progress: { total: groups.length, processed, succeeded, failed } },
      })
      .catch(() => undefined)
  }

  /** IDEATION 收尾：聚合 + 写回草稿 activeGroupRefs（方案 §4.3） */
  private async aggregateIdeation(task: TaskRow, snapshot: TaskSnapshot): Promise<void> {
    const groups = await this.prisma.chetaidouGroup
      .findMany({ where: { taskId: task.rootTaskId }, orderBy: { order: "asc" } })
      .catch(async () => {
        // 连接抖动退避重试（慢库断连常见），仍失败则向上抛由 execute 收敛待核对
        for (const delay of [2000, 5000, 10000]) {
          await new Promise(r => setTimeout(r, delay))
          try {
            return await this.prisma.chetaidouGroup.findMany({
              where: { taskId: task.rootTaskId },
              orderBy: { order: "asc" },
            })
          } catch {
            continue
          }
        }
        throw new Error("聚合读取维度组连续失败（数据库连接不稳定）")
      })
    const status = chetaidouIdeationStatus(groups)
    const identify = await this.prisma.chetaidouCall.findFirst({
      where: { taskId: task.rootTaskId, targetKey: "identify" },
      orderBy: { attempt: "desc" },
    })
    if (identify && status === "SUCCEEDED") {
      await this.settleAndApply(identify.id, snapshot.models.text.publicId, async () => {})
    } else if (identify && ["FAILED", "PARTIAL"].includes(status)) {
      await this.markCallInvalid(identify.id, "联想未全部成功，维度识别不扣费")
    }
    const taskStatus =
      task.id !== task.rootTaskId && (task.input as { groupIds?: string[] }).groupIds?.length
        ? chetaidouIdeationStatus(
            groups.filter(g => (task.input as { groupIds: string[] }).groupIds.includes(g.id))
          )
        : status
    const timedOut = groups.some(
      group => group.status === "FAILED" && group.errorCode === "PROVIDER_TIMEOUT"
    )
    await this.finishTask(
      task,
      taskStatus,
      taskStatus === "FAILED"
        ? timedOut
          ? "PROVIDER_TIMEOUT"
          : "REQUIRED_DIMENSION_MISSING"
        : null,
      taskStatus === "FAILED" ? (timedOut ? TEXT_TIMEOUT_MESSAGE : "全部维度扩展失败") : null
    )
  }

  // ── REFRESH_GROUP ───────────────────────────────────────────────────────

  private async runRefreshGroup(task: TaskRow): Promise<void> {
    const snapshot = task.snapshot as unknown as TaskSnapshot
    const refresh = snapshot.refresh!
    const group = await this.prisma.chetaidouGroup.findFirst({
      where: { taskId: task.rootTaskId, parentGroupId: refresh.parentGroupId },
    })
    if (!group) {
      await this.finishTask(task, "FAILED", "MODEL_OUTPUT_INVALID", "刷新组行缺失")
      return
    }
    await this.setStage(task, "刷新维度中")
    await this.expandGroup(task, snapshot, group, { isRefresh: true })
    const final = await this.prisma.chetaidouGroup.findUnique({ where: { id: group.id } })
    if (final?.status === "SUCCEEDED") {
      const options = (final.options as unknown as ChetaidouOption[]) ?? []
      const retained = (refresh.retainedOptions as unknown as ChetaidouOption[]) ?? []
      const newCount = options.filter(
        o => o.origin !== "USER" && !retained.some(r => r.key === o.key)
      ).length
      // CAS 写回：草稿未变 + 联想指针未变 + 占位仍是本任务
      const draft = await this.prisma.chetaidouDraft.findUnique({
        where: { ownerId_imageId: { ownerId: task.ownerId, imageId: task.imageId } },
      })
      let applied = false
      let appliedRevision: number | null = null
      if (
        !task.adjustmentId &&
        draft &&
        (!task.workspaceId || draft.workspaceId === task.workspaceId) &&
        draft.pendingRefreshTaskId === task.rootTaskId &&
        draft.activeIdeationTaskId === refresh.sourceIdeationTaskId &&
        (task.acceptedDraftRevision === undefined || draft.revision === task.acceptedDraftRevision)
      ) {
        const refs = (draft.activeGroupRefs as { groupId: string }[]) ?? []
        const updated = await this.prisma.chetaidouDraft.updateMany({
          where: { id: draft.id, revision: draft.revision },
          data: {
            activeGroupRefs: refs.map(r =>
              r.groupId === refresh.parentGroupId ? { groupId: group.id } : r
            ),
            selections: ((draft.selections as { groupId: string }[]) ?? []).map(sel =>
              sel.groupId === refresh.parentGroupId ? { ...sel, groupId: group.id } : sel
            ),
            pendingRefreshTaskId: null,
            activeCompositionTaskId: null,
            revision: { increment: 1 },
          },
        })
        applied = updated.count > 0
        if (applied) {
          const after = await this.prisma.chetaidouDraft.findUniqueOrThrow({
            where: { id: draft.id },
          })
          appliedRevision = after.revision
        }
      }
      if (task.adjustmentId) {
        const result = await this.prisma.$transaction(tx =>
          writeTaskAdjustment(
            tx,
            task,
            state => ({
              activeGroupRefs: ((state.activeGroupRefs ?? []) as { groupId: string }[]).map(ref =>
                ref.groupId === refresh.parentGroupId ? { groupId: group.id } : ref
              ),
              selections: (state.selections as { groupId: string }[]).map(sel =>
                sel.groupId === refresh.parentGroupId ? { ...sel, groupId: group.id } : sel
              ),
              pendingRefreshTaskId: null,
              activeCompositionTaskId: null,
            }),
            { pendingRefreshTaskId: task.rootTaskId }
          )
        )
        applied = result.applied
        appliedRevision = result.revision
      }
      await this.prisma.chetaidouTask.update({
        where: { id: task.id },
        data: {
          output: {
            parentGroupId: refresh.parentGroupId,
            newGroupId: group.id,
            retainedSelectionIds: (
              (refresh.retainedOptions as unknown as ChetaidouOption[]) ?? []
            ).map(o => o.selectionId),
            newOptionCount: newCount,
            applied,
            appliedDraftRevision: appliedRevision,
            canApply: !applied,
          },
          appliedDraftRevision: appliedRevision,
          appliedAt: applied ? new Date() : null,
        },
      })
      if (!task.adjustmentId)
        await this.prisma.chetaidouDraft.updateMany({
          where: {
            pendingRefreshTaskId: task.rootTaskId,
            ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
          },
          data: { pendingRefreshTaskId: null },
        })
      await this.finishTask(task, "SUCCEEDED", null, null)
    } else if (final?.status === "UNKNOWN") {
      await this.finishTask(
        task,
        "WAITING_RECONCILIATION",
        "CALL_STATUS_UNKNOWN",
        "刷新调用状态待核对"
      )
    } else {
      // 失败保持原组选项与选择，释放占位
      if (!task.adjustmentId)
        await this.prisma.chetaidouDraft
          .updateMany({
            where: {
              pendingRefreshTaskId: task.rootTaskId,
              ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
            },
            data: { pendingRefreshTaskId: null },
          })
          .catch(() => undefined)
      if (task.adjustmentId)
        await this.prisma.$transaction(tx =>
          writeTaskAdjustment(
            tx,
            task,
            { pendingRefreshTaskId: null },
            { pendingRefreshTaskId: task.rootTaskId }
          )
        )
      await this.finishTask(
        task,
        "FAILED",
        final?.errorCode ?? "PROVIDER_ERROR",
        final?.errorMessage ?? "刷新失败"
      )
    }
  }

  // ── DIVERGE ─────────────────────────────────────────────────────────────

  private async runDiverge(task: TaskRow): Promise<void> {
    const snapshot = task.snapshot as unknown as TaskSnapshot
    const input = task.input as {
      customDimensionId?: string
      capacity?: number
      history?: ChetaidouOption[]
    }
    const dims =
      (snapshot.customDimensions as {
        id?: string
        label: string
        selectionMode: string
        guidance?: string
        options: { key?: string; text: string }[]
      }[]) ?? []
    const target = dims.find(d => d.id === input.customDimensionId)
    if (!target) {
      await this.finishTask(task, "FAILED", "SETTINGS_CHANGED", "目标自建维度已不存在")
      return
    }
    await this.setStage(task, "维度发散中")
    const capacity = input.capacity ?? 60
    const request: ChatCompletionRequest = {
      model: snapshot.models.text.publicId,
      messages: [
        { role: "system", content: snapshot.prompt.templateBodies.diverge ?? DIVERGE_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            dimension: {
              label: target.label,
              selectionMode: target.selectionMode,
              guidance: target.guidance,
            },
            selected: target.options,
            history: input.history ?? [],
            ...(snapshot.execution
              ? { optionCountRange: optionRangeOf(snapshot.settings) }
              : { remainingCapacity: Math.min(60, capacity) }),
          }),
        },
      ],
    }
    const callId = await this.openCall({
      task,
      targetKey: "diverge",
      kind: "TEXT",
      source: CHETAIDOU_USAGE_SOURCES.diverge,
      model: snapshot.models.text.publicId,
      promptVersion: snapshot.prompt.version,
      request,
      estimatedCny: 1,
    })
    let text: string
    try {
      text = await this.callLlm(callId, request)
    } catch (error) {
      if (error instanceof UnknownCallError) {
        await this.finishTask(
          task,
          "WAITING_RECONCILIATION",
          "CALL_STATUS_UNKNOWN",
          "发散调用状态待核对"
        )
        return
      }
      throw error
    }
    const validateDiverge = (raw: unknown) => {
      const result = validateDivergeOutput(raw, {
        settings: snapshot.settings,
        callId,
        ...(snapshot.execution
          ? { countRange: optionRangeOf(snapshot.settings) }
          : { maxOptions: Math.min(60, capacity) }),
      })
      if (snapshot.execution) {
        const labels = new Set([
          ...target.options.map(o => o.text.trim()),
          ...(input.history ?? []).map(o => o.label.trim()),
        ])
        if (result.some(o => labels.has(o.label.trim())))
          throw new ModelOutputInvalidError("新增选项与保留或历史选项重复")
      }
      return result
    }
    let options: ChetaidouOption[]
    try {
      options = validateDiverge(this.parseTextOutput(snapshot, text, callId))
    } catch (error) {
      await this.markCallInvalid(callId, errMessage(error))
      await this.finishTask(
        task,
        "FAILED",
        "MODEL_OUTPUT_INVALID",
        `发散输出不合格：${errMessage(error)}`
      )
      return
    }
    // 去重追加（与手写项/已选项），不自动选中
    const existingLabels = new Set([
      ...target.options.map(o => o.text.trim()),
      ...(input.history ?? []).map(o => o.label.trim()),
    ])
    const fresh = options
      .filter(o => {
        if (existingLabels.has(o.label.trim())) return false
        existingLabels.add(o.label.trim())
        return true
      })
      .map(o => ({
        ...o,
        key: `ai_${randomUUID()}`,
        selectionId: randomUUID(),
        origin: "AI" as const,
        sourceTaskId: task.id,
      }))
    const output = {
      customDimensionId: target.id,
      newOptions: fresh,
      newOptionCount: fresh.length,
      canApply: fresh.length > 0,
      applied: false,
    }
    await this.settleAndApply(callId, snapshot.models.text.publicId, async tx => {
      await tx.chetaidouTask.update({
        where: { id: task.id },
        data: { output: output as unknown as object },
      })
    })
    // 安全写回草稿（CAS：上下文未变 + 容量不超）
    await this.applyDivergeToDraft(task, target.id, fresh)
    await this.finishTask(task, "SUCCEEDED", null, null)
  }

  private async applyDivergeToDraft(
    task: TaskRow,
    dimensionId: string | undefined,
    fresh: ChetaidouOption[]
  ): Promise<void> {
    if (!dimensionId || !fresh.length || task.acceptedDraftRevision == null) return
    try {
      await applyDivergeOutput(this.prisma, task.ownerId, task.id, task.acceptedDraftRevision, true)
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error
      // 草稿在调用期间变化：保留完整产物，交给用户手动应用或放弃。
    }
  }

  // ── COMPOSE ─────────────────────────────────────────────────────────────

  private async runCompose(task: TaskRow): Promise<void> {
    const snapshot = task.snapshot as unknown as TaskSnapshot
    // 仅兼容旧冻结模板的编号入参，新模板直接使用 facts；不再追加输出门槛。
    const constraints = snapshot.prompt.templateBodies.composition?.includes("hardConstraintChecks")
      ? productHardConstraints(snapshot.facts.content)
      : undefined
    await this.setStage(task, "组织编辑指令中")
    const decisions = (snapshot.decisions ?? []) as (NonNullable<
      CompositionValidationContext["decisions"]
    >[number] & {
      decisionId: string
      conflictId: string
      question?: string
      sources: string[]
      choiceId?: string
      instruction?: string
      customText?: string
      questionVersion?: number
      scopeKey?: string
      compositionTaskId?: string
    })[]
    const request: ChatCompletionRequest = {
      model: snapshot.models.text.publicId,
      messages: [
        {
          role: "system",
          content: snapshot.prompt.templateBodies.composition ?? COMPOSITION_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify({
            facts: snapshot.facts.content,
            ...(constraints ? { productHardConstraints: constraints } : {}),
            breakdown: snapshot.breakdown?.payload ?? null,
            settings: { ...snapshot.settings, locale: localeOf(snapshot.settings) },
            // 旧冻结提示词使用 selected.id；同时提供真实 selectionId 的同值别名。
            selected: (snapshot.resolvedSelections as { selectionId: string }[]).map(s => ({
              ...s,
              id: s.selectionId,
            })),
            customOptions: collectCustomOptions(snapshot),
            resolution: {
              answers: decisions.map(d => ({
                ...d,
                scopeKey: d.scopeKey ?? compositionScopeKey(d.question, d.sources),
                questionVersion: d.questionVersion ?? 1,
                text: d.customText,
              })),
              history: decisions,
            },
          }),
        },
      ],
    }
    const ctx: CompositionValidationContext = {
      settings: snapshot.settings,
      selectionIds: (snapshot.resolvedSelections as { selectionId: string }[]).map(
        s => s.selectionId
      ),
      selections: snapshot.resolvedSelections as CompositionValidationContext["selections"],
      decisions,
      effectiveDecisionIds: decisions.map(d => d.decisionId),
      breakdown: snapshot.breakdown?.payload ?? null,
    }
    const initial = await this.callComposition(task, "compose", request)
    const { callId, text } = initial
    let output: ReturnType<typeof validateCompositionOutput>
    try {
      output = validateCompositionOutput(parseCompositionJson(text, callId), ctx)
    } catch (error) {
      await this.markCallInvalid(callId, errMessage(error))
      await this.failCompositionFormat(task)
      return
    }
    const normalized = this.normalizeComposeOutput(output, decisions, task)
    await this.settleAndApply(callId, snapshot.models.text.publicId, async tx => {
      await tx.chetaidouTask.update({
        where: { id: task.id },
        data: { output: normalized as unknown as object },
      })
      await tx.chetaidouCall.update({
        where: { id: callId },
        data: { state: "FINISHED", outcome: "ACCEPTED", errorCode: null, errorMessage: null },
      })
    })
    await this.finishTask(task, "SUCCEEDED", null, null)
  }

  private async callComposition(task: TaskRow, targetKey: string, request: ChatCompletionRequest) {
    const snapshot = task.snapshot as unknown as TaskSnapshot
    const callId = await this.openCall({
      task,
      targetKey,
      kind: "TEXT",
      source: CHETAIDOU_USAGE_SOURCES.compose,
      model: snapshot.models.text.publicId,
      promptVersion: snapshot.prompt.version,
      request,
      estimatedCny: targetKey === "compose" ? 2 : 1,
      singleAttempt: true,
    })
    const stored = await this.prisma.chetaidouCall.findUnique({ where: { id: callId } })
    // 已创建调用始终使用原请求，升级后不能改写 PREPARED 请求或再创建新 attempt。
    const frozenRequest =
      (stored?.request as unknown as ChatCompletionRequest | undefined) ?? request
    const text = await this.callLlm(callId, frozenRequest)
    return { callId, text, frozenRequest }
  }

  private async failCompositionFormat(task: TaskRow): Promise<void> {
    await this.finishTask(task, "FAILED", "MODEL_OUTPUT_INVALID", COMPOSITION_INVALID_MESSAGE)
  }

  private normalizeComposeOutput(
    output: ReturnType<typeof validateCompositionOutput>,
    decisions: {
      decisionId: string
      conflictId: string
      questionVersion?: number
      compositionTaskId?: string
    }[],
    task: TaskRow
  ) {
    const conflicts = (output.conflicts ?? []).map(c => ({
      ...c,
      questionVersion: 1,
    }))
    return {
      ...output,
      conflicts,
      decisions: decisions.map(d => ({
        ...d,
        compositionTaskId: d.compositionTaskId ?? task.parentTaskId ?? task.id,
      })),
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────────

  /** 成功状态与有效组一起提交，轮询看到成功时即可使用。 */
  private async saveSuccessfulGroup(
    tx: Prisma.TransactionClient,
    task: TaskRow,
    group: GroupRow,
    options: ChetaidouOption[]
  ): Promise<void> {
    if (task.type === "IDEATION" && task.adjustmentId)
      await tx.$queryRaw`SELECT id FROM ChetaidouTask WHERE id = ${task.rootTaskId} FOR UPDATE`
    await tx.chetaidouGroup.updateMany({
      where: { id: group.id, status: { not: "SUCCEEDED" } },
      data: {
        status: "SUCCEEDED",
        options: options as unknown as object,
        errorCode: null,
        errorMessage: null,
        currentCallId: null,
      },
    })
    if (task.type === "IDEATION") await this.publishIdeationGroups(tx, task, [group])
  }

  private async publishIdeationGroups(
    tx: Prisma.TransactionClient,
    task: TaskRow,
    succeeded: GroupRow[]
  ): Promise<void> {
    if (!task.adjustmentId || !succeeded.length) return
    await writeTaskAdjustment(
      tx,
      task,
      async state => {
        const refs = (state.activeGroupRefs ?? []) as { groupId: string }[]
        const added =
          task.id === task.rootTaskId
            ? succeeded
            : succeeded.filter(g =>
                ["FAILED", "PENDING"].includes(
                  (task.input as { previousGroupStates?: Record<string, string> })
                    .previousGroupStates?.[g.id] ?? ""
                )
              )
        const currentGroups = refs.length
          ? await tx.chetaidouGroup.findMany({
              where: { id: { in: refs.map(ref => ref.groupId) } },
            })
          : []
        const fresh = added.filter(
          group => !currentGroups.some(current => current.key === group.key)
        )
        if (!fresh.length) return {}
        const order = new Map([...currentGroups, ...fresh].map(group => [group.id, group.order]))
        return {
          activeGroupRefs: [...refs, ...fresh.map(group => ({ groupId: group.id }))].sort(
            (a, b) => (order.get(a.groupId) ?? 0) - (order.get(b.groupId) ?? 0)
          ),
        }
      },
      { activeIdeationTaskId: task.rootTaskId }
    )
  }

  private async setStage(task: TaskRow, stage: string): Promise<void> {
    await this.prisma.chetaidouTask
      .update({ where: { id: task.id }, data: { stage } })
      .catch(() => undefined)
  }

  private async finishTask(
    task: TaskRow,
    status: "RUNNING" | "WAITING_RECONCILIATION" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "CANCELLED",
    errorCode: string | null,
    errorMessage: string | null
  ): Promise<void> {
    const data = {
      status,
      stage: null,
      errorCode,
      errorMessage,
      finishedAt: ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"].includes(status)
        ? new Date()
        : null,
    }
    if (task.type === "IDEATION") {
      await this.prisma.$transaction(async tx => {
        // 与逐维结果发布共用根任务行锁；模型调用仍并行。
        await tx.$queryRaw`SELECT id FROM ChetaidouTask WHERE id = ${task.rootTaskId} FOR UPDATE`
        const groups = await tx.chetaidouGroup.findMany({ where: { taskId: task.rootTaskId } })
        const snapshot = task.snapshot as unknown as TaskSnapshot
        const succeeded = groups.filter(g => g.status === "SUCCEEDED")

        await this.publishIdeationGroups(tx, task, succeeded)
        if (succeeded.length > 0 && !task.adjustmentId) {
          // 数量或模型设置可在执行期间保存；CAS 冲突后重新读取，避免漏写有效结果。
          for (let attempt = 0; attempt < (snapshot.execution ? 3 : 1); attempt++) {
            const draft = await tx.chetaidouDraft.findUnique({
              where: { ownerId_imageId: { ownerId: task.ownerId, imageId: task.imageId } },
            })
            if (
              draft &&
              (!task.workspaceId || draft.workspaceId === task.workspaceId) &&
              draft.activeIdeationTaskId === task.rootTaskId &&
              (!snapshot.execution ||
                stableHash(
                  contentSettingsOf(draft.settings as unknown as typeof snapshot.settings)
                ) === stableHash(contentSettingsOf(snapshot.settings)))
            ) {
              const applied = await tx.chetaidouDraft
                .updateMany({
                  where: {
                    id: draft.id,
                    revision: snapshot.execution
                      ? draft.revision
                      : (task.acceptedDraftRevision ?? draft.revision),
                    activeIdeationTaskId: task.rootTaskId,
                  },
                  data: {
                    activeGroupRefs:
                      task.id === task.rootTaskId
                        ? succeeded.map(g => ({ groupId: g.id }))
                        : [
                            ...((draft.activeGroupRefs as { groupId: string }[]) ?? []),
                            ...succeeded
                              .filter(g =>
                                ["PENDING", "FAILED"].includes(
                                  (task.input as { previousGroupStates?: Record<string, string> })
                                    .previousGroupStates?.[g.id] ?? ""
                                )
                              )
                              .filter(
                                g =>
                                  !((draft.activeGroupRefs as { groupId: string }[]) ?? []).some(
                                    r => r.groupId === g.id
                                  )
                              )
                              .map(g => ({ groupId: g.id })),
                          ],
                  },
                })
                .catch(() => undefined)
              if (!applied || applied.count > 0) break
            } else break
          }
        }

        if (task.id !== task.rootTaskId)
          await tx.chetaidouTask.update({ where: { id: task.id }, data })
        const rootStatus = groups.length ? chetaidouIdeationStatus(groups) : status
        await tx.chetaidouTask.update({
          where: { id: task.rootTaskId },
          data: {
            ...data,
            status: rootStatus,
            errorCode: rootStatus === "FAILED" ? errorCode : null,
            errorMessage: rootStatus === "FAILED" ? errorMessage : null,
            finishedAt: ["RUNNING", "WAITING_RECONCILIATION"].includes(rootStatus)
              ? null
              : new Date(),
          },
        })
      })
      return
    }
    await this.prisma.chetaidouTask.update({ where: { id: task.id }, data })
    if (task.id !== task.rootTaskId) {
      const completed = await this.prisma.chetaidouTask.findUniqueOrThrow({
        where: { id: task.id },
      })
      await this.prisma.chetaidouTask.update({
        where: { id: task.rootTaskId },
        data: {
          ...data,
          ...(completed.output ? { output: completed.output as Prisma.InputJsonValue } : {}),
          ...(completed.appliedAt
            ? {
                appliedAt: completed.appliedAt,
                appliedDraftRevision: completed.appliedDraftRevision,
              }
            : {}),
        },
      })
    }
  }
}

class OutputApplyError extends Error {}

class UnknownCallError extends Error {
  constructor(
    public readonly callId: string,
    public readonly cause?: string
  ) {
    super(`调用状态未知：${callId}`)
    this.name = "UnknownCallError"
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameRequest(a: unknown, b: unknown): boolean {
  // 部署前的 Call 可能带旧输出上限；仅移除此参数不视作新调用，避免重复提交。
  if (a && b && typeof a === "object" && typeof b === "object" && !("max_output_tokens" in b)) {
    const previous = { ...a } as Record<string, unknown>
    delete previous.max_output_tokens
    return stableHash(previous) === stableHash(b)
  }
  return stableHash(a) === stableHash(b)
}

function extractText(completion: unknown): string {
  const choices = (completion as { choices?: unknown[] })?.choices
  const first = choices?.[0] as { message?: { content?: unknown } } | undefined
  const content = first?.message?.content
  return typeof content === "string" ? content : JSON.stringify(content ?? "")
}

function localeOf(settings: ChetaidouSettings): string | null {
  const table: Record<string, string | null> = {
    original: null,
    amazon_us: "en-US",
    amazon_de: "de-DE",
    amazon_fr: "fr-FR",
    amazon_es: "es-ES",
    amazon_it: "it-IT",
    amazon_jp: "ja-JP",
  }
  return table[settings.site] ?? null
}

function collectCustomOptions(snapshot: TaskSnapshot): { groupKey: string; text: string }[] {
  const out: { groupKey: string; text: string }[] = []
  for (const sel of snapshot.resolvedSelections as {
    origin?: string
    groupKey?: string
    label?: string
  }[]) {
    if (sel.origin === "USER" && sel.groupKey && sel.label) {
      out.push({ groupKey: sel.groupKey, text: sel.label })
    }
  }
  return out
}

export { UnknownCallError }
