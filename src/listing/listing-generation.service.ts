import { DomesticBusinessGateway } from "../common/business-ai/domestic-business-gateway"
import { prepareListingScoreDelivery } from "./listing-score-delivery"
import { buildListingScoreSystemPrompt } from "./listing-score-prompt"
import { parseListingScoreSource } from "./listing-score-evidence"
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"
import { Prisma, type ListingGenerationTask } from "@prisma/client"
import { jsonrepair } from "jsonrepair"
import {
  AiGatewayProvider,
  type AiGatewayBillingUsage,
  type AiGatewayTokenUsage,
} from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import type { ListingAiInvocationDto } from "./dto/listing-ai.dto"
import {
  CreateListingGenerationDto,
  FinishListingGenerationDto,
} from "./dto/listing-generation.dto"
import { ListingAiService } from "./listing-ai.service"
import { parseListingJsonObject } from "./listing-result-parser"
import { ListingRunService } from "./listing-run.service"

const LEASE_MS = 120_000
const POLL_MS = 2_000
const MAX_CONCURRENT_TASKS = 2
type SavedBilling = { billing?: AiGatewayBillingUsage; usage?: AiGatewayTokenUsage }
type ScoringInput = CreateListingGenerationDto & {
  autoScore?: ListingAiInvocationDto
  autoScoreStepId?: number
  result?: Record<string, unknown>
}
type GenerationBilling = SavedBilling & { score?: SavedBilling; isScoreComplete?: boolean }
const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : "生成任务执行失败").slice(0, 1000)

/** 模型调用至多一次；服务重启只处理已有响应，不把 RUNNING 任务重新排队。 */
@Injectable()
export class ListingGenerationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ListingGenerationService.name)
  private timer?: NodeJS.Timeout
  private isPolling = false
  private activeCount = 0
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DomesticBusinessGateway) private readonly gateway: AiGatewayProvider,
    private readonly ai: ListingAiService,
    private readonly runs: ListingRunService
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.poll(), POLL_MS)
    this.timer.unref()
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
  }

  async submit(userId: number, dto: CreateListingGenerationDto) {
    if (
      dto.main?.operation !== "generation" ||
      dto.main.images?.length ||
      (dto.longTitle && (dto.longTitle.operation !== "long_title" || dto.longTitle.images?.length))
    )
      throw new BadRequestException("生成任务仅支持主生成及可选长标题文本调用")
    if (Buffer.byteLength(JSON.stringify(dto), "utf8") > 4_000_000)
      throw new BadRequestException("生成上下文过大")
    const params = dto.context.params as
      | { keyword?: string; documentContent?: string; market?: string }
      | undefined
    if (
      !params ||
      typeof params.market !== "string" ||
      !(
        /^amazon_[a-z]{2}$/.test(params.market) ||
        ["walmart_us", "ebay_us", "ozon_ru", "wildberries_ru", "tiktok_us", "tiktok_mx"].includes(
          params.market
        )
      ) ||
      !(
        (typeof params.keyword === "string" && params.keyword.trim()) ||
        (typeof params.documentContent === "string" && params.documentContent.trim())
      )
    )
      throw new BadRequestException("缺少有效的产品内容或目标市场，尚未调用模型")
    await this.runs.create(userId, {
      runId: dto.runId,
      title: String(params?.keyword || "产品文档").slice(0, 450),
    })
    const existing = await this.prisma.listingGenerationTask.findUnique({
      where: { attemptId: dto.attemptId },
      include: { listingRun: { include: { history: { select: { userId: true } } } } },
    })
    if (existing) {
      if (
        existing.listingRun.history.userId !== userId ||
        existing.listingRun.runId !== dto.runId ||
        existing.planIndex !== dto.planIndex
      )
        throw new NotFoundException("生成任务不存在")
      return { attemptId: existing.attemptId, runId: dto.runId }
    }
    await this.ai.assertAffordable(userId, "generation", dto.generationBillingId ?? dto.runId)
    await this.runs.update(
      userId,
      dto.runId,
      {
        attemptId: dto.attemptId,
        planIndex: dto.planIndex,
        status: "RUNNING",
        stage: "generation",
      },
      async tx => {
        const run = await tx.listingRun.findUniqueOrThrow({ where: { runId: dto.runId } })
        const pending = await tx.listingGenerationTask.findFirst({
          where: {
            listingRunId: run.id,
            planIndex: dto.planIndex,
            status: { in: ["QUEUED", "RUNNING", "READY", "SCORE_QUEUED", "SCORING", "SCORE_READY"] },
          },
          select: { id: true },
        })
        if (pending)
          throw new ConflictException("该方案已有后台任务，请先在生成记录取回结果，不要重复提交")
        // 同一 run 的并发提交已经由报告锁串行化；跨 run 仍由 attemptId 唯一键保护。
        const main = await tx.listingAiStep.create({
          data: {
            listingRunId: run.id,
            operation: "generation",
            model: dto.main.model,
          },
        })
        const longTitle = dto.longTitle
          ? await tx.listingAiStep.create({
              data: {
                listingRunId: run.id,
                operation: "long_title",
                model: dto.longTitle.model,
              },
            })
          : null
        await tx.listingGenerationTask.create({
          data: {
            attemptId: dto.attemptId,
            listingRunId: run.id,
            planIndex: dto.planIndex,
            mainStepId: main.id,
            longTitleStepId: longTitle?.id,
            input: jsonValue(dto),
          },
        })
      }
    )
    return { attemptId: dto.attemptId, runId: dto.runId }
  }

  /** 仅供有权限的本人服务端恢复；账单快照不下发。终态无需反复传 Prompt/正文。 */
  async read(userId: number, runId: string) {
    const run = await this.prisma.listingRun.findFirst({
      where: { runId, history: { userId } },
      select: { id: true },
    })
    if (!run) throw new NotFoundException("生成记录不存在")
    const tasks = await this.prisma.listingGenerationTask.findMany({
      where: { listingRunId: run.id },
      orderBy: { id: "asc" },
      // 排序仅携带摘要，避免 input/billing 大 JSON 占用 MySQL sort_buffer。
      select: { id: true, attemptId: true, status: true, planIndex: true },
    })
    return Promise.all(
      tasks.map(async task => {
        const summary = {
          attemptId: task.attemptId,
          status: task.status,
          planIndex: task.planIndex,
        }
        if (task.status !== "READY") return summary
        const detail = await this.prisma.listingGenerationTask.findUnique({
          where: { id: task.id },
          select: {
            status: true,
            input: true,
            isModelComplete: true,
            error: true,
            mainStepId: true,
            longTitleStepId: true,
          },
        })
        if (!detail) throw new NotFoundException("生成任务不存在")
        if (detail.status !== "READY") return { ...summary, status: detail.status }
        const steps = await this.prisma.listingAiStep.findMany({
          where: {
            id: { in: [detail.mainStepId, ...(detail.longTitleStepId ? [detail.longTitleStepId] : [])] },
          },
          select: { id: true, outputText: true },
        })
        return {
          ...summary,
          context: (detail.input as Prisma.JsonObject).context,
          isModelComplete: detail.isModelComplete,
          outputText: steps.find(step => step.id === detail.mainStepId)?.outputText ?? "",
          longTitleText: steps.find(step => step.id === detail.longTitleStepId)?.outputText ?? "",
          error: detail.error,
        }
      })
    )
  }

  async finish(userId: number, attemptId: string, dto: FinishListingGenerationDto) {
    const task = await this.prisma.listingGenerationTask.findFirst({
      where: { attemptId, listingRun: { history: { userId } } },
      include: { listingRun: true },
    })
    if (!task) throw new NotFoundException("生成任务不存在")
    if (["COMPLETED", "PARTIAL", "FAILED"].includes(task.status))
      return { attemptId, status: task.status }
    if (["SCORE_QUEUED", "SCORING", "SCORE_READY"].includes(task.status))
      return { attemptId, status: task.status }
    if (task.status !== "READY") throw new ConflictException("模型仍在运行，请继续查询原任务")
    if (dto.autoScore && (dto.autoScore.operation !== "score" || dto.autoScore.images?.length))
      throw new BadRequestException("自动评分仅支持当前生成正文的文本评分")
    const step = await this.prisma.listingAiStep.findUniqueOrThrow({
      where: { id: task.mainStepId },
    })
    const input = task.input as unknown as CreateListingGenerationDto
    if (dto.status === "COMPLETED") this.validateComplete(task, step.outputText ?? "", dto.result)
    if (dto.status === "COMPLETED" && !dto.autoScore)
      throw new BadRequestException("完整生成必须包含自动评分，请刷新页面后从原生成记录恢复，不要重新生成")
    const isComplete = dto.status === "COMPLETED"
    const hasAutoScore = isComplete && !!dto.autoScore
    const message = isComplete
      ? undefined
      : dto.error || task.error || "模型内容未通过完整性校验，主生成未扣费"
    // 部分输出只作为普通文本保存，不伪造闭合 JSON 或自动评分。
    const plan = isComplete
      ? { result: dto.result }
      : { partialText: step.outputText ?? "", partialError: message }
    await this.runs.update(
      userId,
      task.listingRun.runId,
      {
        attemptId,
        planIndex: task.planIndex,
        status: hasAutoScore ? "RUNNING" : dto.status,
        stage: hasAutoScore ? "auto_score" : isComplete ? "completed" : "partial_result",
        error: message,
        data: { params: input.context.params, plans: [plan] },
      },
      async tx => {
        const claimed = await tx.listingGenerationTask.updateMany({
          where: { id: task.id, status: "READY" },
          data: { status: hasAutoScore ? "SCORE_QUEUED" : dto.status, error: message ?? null },
        })
        if (!claimed.count) throw new ConflictException("任务已完成保存，请刷新查看结果")
        // 正文先保留；完整生成（含自动评分）成功时统一结算。
        const usageLogId = null
        await tx.listingAiStep.update({
          where: { id: task.mainStepId },
          data: { status: isComplete ? "COMPLETED" : "FAILED", error: message ?? null, usageLogId },
        })
        if (hasAutoScore) {
          const scoreStep = await tx.listingAiStep.create({
            data: { listingRunId: task.listingRunId, operation: "score", model: dto.autoScore!.model },
          })
          await tx.listingGenerationTask.update({
            where: { id: task.id },
            data: { input: jsonValue({ ...input, result: dto.result, autoScore: dto.autoScore, autoScoreStepId: scoreStep.id }) },
          })
        }
      }
    )
    return { attemptId, status: hasAutoScore ? "SCORE_QUEUED" : dto.status }
  }

  /** 评分输出已持久化后，仅重试解析和同一扣费事务，不再请求模型。 */
  async finalizeScore(task: ListingGenerationTask) {
    const input = task.input as unknown as ScoringInput
    if (!input.autoScoreStepId) throw new Error("自动评分步骤缺失")
    const step = await this.prisma.listingAiStep.findUniqueOrThrow({ where: { id: input.autoScoreStepId } })
    const saved = task.billing as unknown as GenerationBilling
    let scoreResult: Record<string, unknown> | undefined
    let scoreError: string | undefined
    try {
      const market = String((input.context.params as { market?: string })?.market ?? "")
      const deliveryText = prepareListingScoreDelivery(step.outputText ?? "", market || undefined, {
        sourceFacts: parseListingScoreSource(input.autoScore?.userPrompt ?? ""),
      })
      if (!deliveryText) throw new Error(task.error || "自动评分未返回内容，正文已保留")
      scoreResult = JSON.parse(deliveryText)
    } catch (error) { scoreError = errorMessage(error) }
    const run = await this.prisma.listingRun.findUniqueOrThrow({
      where: { id: task.listingRunId }, include: { history: { select: { userId: true } } },
    })
    await this.runs.update(run.history.userId, run.runId, {
      attemptId: task.attemptId, planIndex: task.planIndex,
      status: scoreResult ? "COMPLETED" : "PARTIAL", stage: scoreResult ? "completed" : "auto_score_failed", error: scoreError,
      data: { params: input.context.params, plans: [{ result: input.result, ...(scoreResult ? { scoreResult, score: scoreResult.total } : { scoreError }) }] },
    }, async tx => {
      const claimed = await tx.listingGenerationTask.updateMany({
        where: { id: task.id, status: "SCORE_READY" },
        data: { status: scoreResult ? "COMPLETED" : "PARTIAL", error: scoreError ?? null, leaseUntil: null },
      })
      if (!claimed.count) throw new ConflictException("评分结果已保存，请刷新查看")
      const usageLogId = scoreResult && typeof scoreResult.total === "number" && saved.isScoreComplete && saved.billing
        ? await this.ai.chargeSavedOutput(run.history.userId, "generation", saved.billing, saved.usage, tx, run.historyId, task.mainStepId, run.runId, input.generationBillingId ?? run.runId)
        : null
      if (usageLogId) await tx.listingAiStep.update({ where: { id: task.mainStepId }, data: { usageLogId } })
      await tx.listingAiStep.update({ where: { id: step.id }, data: {
        status: scoreResult ? "COMPLETED" : "FAILED", error: scoreError ?? null, usageLogId: null,
      } })
    })
  }

  async executeScore(task: ListingGenerationTask) {
    const input = task.input as unknown as ScoringInput
    const heartbeat = setInterval(() => {
      void this.prisma.listingGenerationTask.updateMany({
        where: { id: task.id, status: "SCORING" }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
      }).catch(error => this.logger.warn(errorMessage(error)))
    }, 20_000)
    heartbeat.unref()
    try {
      let score: SavedBilling | undefined
      let scoreError: string | undefined
      try {
        if (!input.autoScoreStepId || !input.autoScore) throw new Error("自动评分配置缺失")
        score = await this.consume(input.autoScoreStepId, {
          ...input.autoScore,
          systemPrompt: buildListingScoreSystemPrompt(input.autoScore.systemPrompt, input.autoScore.userPrompt),
          temperature: 0,
        })
      } catch (error) { scoreError = errorMessage(error) }
      // 原始正文已由 consume 留存；账单与终态另存，事务失败只重试下面的 finalizeScore。
      await this.prisma.listingGenerationTask.updateMany({
        where: { id: task.id, status: "SCORING" },
        data: { status: "SCORE_READY", leaseUntil: null, error: scoreError ?? null,
          billing: jsonValue({ ...(task.billing as object), score, isScoreComplete: !scoreError }) },
      })
    } finally { clearInterval(heartbeat) }
  }

  validateComplete(
    task: Pick<ListingGenerationTask, "isModelComplete">,
    outputText: string,
    result?: Record<string, unknown>
  ) {
    if (!task.isModelComplete)
      throw new BadRequestException("模型响应未完整结束，不能按完整报告扣费")
    if (
      !result ||
      typeof result.title !== "string" ||
      !result.title.trim() ||
      typeof result.description !== "string" ||
      !result.description.trim()
    )
      throw new BadRequestException("缺少有效标题或描述，主生成未扣费")
    // 账单提交前再次核验原始响应存在，而不是仅凭客户端声称成功。
    try {
      const raw = parseListingJsonObject(outputText)
      if (typeof raw.title !== "string" || !raw.title.trim()) throw new Error("missing title")
      const requiredArrays: Record<string, string[]> = {
        amazon: ["bullets"],
        walmart: ["keyFeatures", "productAttributes"],
        ebay: ["itemSpecifics"],
        ozon: ["highlights", "characteristics", "hashtags"],
        wildberries: ["highlights", "characteristics"],
        tiktok: ["productHighlights", "modules"],
      }
      const fields = requiredArrays[String(result.platform ?? "amazon")]
      if (
        !fields ||
        fields.some(field => !Array.isArray(result[field]) || !(result[field] as unknown[]).length)
      )
        throw new Error("missing platform fields")
    } catch {
      throw new BadRequestException("正文不完整或缺少平台必需内容，主生成未扣费")
    }
  }

  private async _recoverScores() {
    await this.prisma.listingGenerationTask.updateMany({
      where: { status: "SCORING", leaseUntil: { lt: new Date() } },
      data: {
        status: "SCORE_READY",
        error: "自动评分执行连接中断，正文已保留，不会重复请求模型",
      },
    })
    // Prisma 的 take 会隐式按主键排序；先取 ID，再按主键加载 JSON，避免宽行 filesort。
    const scores = await this.prisma.listingGenerationTask.findMany({
      where: { status: "SCORE_READY" },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 20,
    })
    for (const score of scores) {
      try {
        const task = await this.prisma.listingGenerationTask.findUnique({ where: { id: score.id } })
        if (!task || task.status !== "SCORE_READY") continue
        await this.finalizeScore(task)
      } catch (error) {
        this.logger.warn(`Listing score persist task=${score.id}: ${errorMessage(error)}`)
      }
    }
  }

  async poll() {
    if (this.isPolling) return
    this.isPolling = true
    try {
      try {
        await this._recoverScores()
      } catch (error) {
        // 评分扫描或恢复失败不能阻断主生成队列，下一轮仍可重试已有评分响应。
        this.logger.error(`Listing score recovery: ${errorMessage(error)}`)
      }
      // 模型是否已经收到请求无法由进程重启判断：过期任务绝不重新调用 AI。
      const expiredAt = new Date()
      const expired = await this.prisma.listingGenerationTask.findMany({
        where: { status: "RUNNING", leaseUntil: { lt: expiredAt } },
        select: { id: true, longTitleStepId: true },
        take: 20,
      })
      for (const task of expired) {
        const claimed = await this.prisma.listingGenerationTask.updateMany({
          where: { id: task.id, status: "RUNNING", leaseUntil: { lt: expiredAt } },
          data: { status: "READY", error: "执行连接中断，已保留收到的内容；不会再次请求 AI" },
        })
        if (claimed.count && task.longTitleStepId) {
          await this.prisma.listingAiStep.updateMany({
            where: { id: task.longTitleStepId, status: "RUNNING", usageLogId: null },
            data: { status: "FAILED", error: "执行连接中断，已保留正文，未扣费；不会重新请求 AI" },
          })
        }
      }
      while (this.activeCount < MAX_CONCURRENT_TASKS) {
        const candidate = await this.prisma.listingGenerationTask.findFirst({
          where: { status: { in: ["QUEUED", "SCORE_QUEUED"] } },
          orderBy: { id: "asc" },
          select: { id: true, status: true },
        })
        if (!candidate) break
        // 在认领前读取完整输入；读失败时任务仍留在队列，不会误进入过期恢复。
        const task = await this.prisma.listingGenerationTask.findUnique({
          where: { id: candidate.id },
        })
        if (!task || task.status !== candidate.status) continue
        const claimed = await this.prisma.listingGenerationTask.updateMany({
          where: { id: task.id, status: task.status },
          data: { status: task.status === "SCORE_QUEUED" ? "SCORING" : "RUNNING", leaseUntil: new Date(Date.now() + LEASE_MS) },
        })
        if (!claimed.count) continue
        this.activeCount++
        void (task.status === "SCORE_QUEUED" ? this.executeScore(task) : this.execute(task))
          .catch(error => this.logger.error(`Listing task=${task.id}: ${errorMessage(error)}`))
          .finally(() => this.activeCount--)
      }
    } catch (error) {
      this.logger.error(`Listing worker: ${errorMessage(error)}`)
    } finally {
      this.isPolling = false
    }
  }

  async execute(task: ListingGenerationTask) {
    const input = task.input as unknown as CreateListingGenerationDto
    const heartbeat = setInterval(() => {
      void this.prisma.listingGenerationTask
        .updateMany({
          where: { id: task.id, status: "RUNNING" },
          data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
        })
        .catch(error => this.logger.warn(errorMessage(error)))
    }, 20_000)
    heartbeat.unref()
    try {
      const run = await this.prisma.listingRun.findUniqueOrThrow({
        where: { id: task.listingRunId },
        include: { history: { select: { userId: true } } },
      })
      const longTitle =
        input.longTitle && task.longTitleStepId
          ? (async () => {
              try {
                const saved = await this.consume(task.longTitleStepId!, input.longTitle!)
                const step = await this.prisma.listingAiStep.findUniqueOrThrow({
                  where: { id: task.longTitleStepId! },
                })
                const match = /\{[\s\S]*\}/.exec(step.outputText ?? "")
                if (!match || !String(JSON.parse(jsonrepair(match[0])).longTitle ?? "").trim())
                  throw new Error("长标题未返回可用内容，本步骤未扣费")
                await this.runs.completeStep(
                  step.id,
                  step.outputText!,
                  saved.billing?.requestId,
                  saved.billing?.model,
                  tx =>
                    saved.billing
                      ? this.ai.chargeSavedOutput(
                          run.history.userId,
                          "long_title",
                          saved.billing,
                          saved.usage,
                          tx,
                          run.historyId,
                          step.id,
                          run.runId
                        )
                      : Promise.resolve(null)
                )
              } catch (error) {
                await this.runs.failStep(task.longTitleStepId!, error)
              }
            })()
          : Promise.resolve()
      // 并行调用仅各执行一次；即使其中一项失败，也等待另一项落存。
      try {
        const saved = await this.consume(task.mainStepId, input.main)
        await this.prisma.listingGenerationTask.updateMany({
          where: { id: task.id, status: "RUNNING" },
          data: { billing: jsonValue(saved), isModelComplete: true },
        })
      } catch (error) {
        await this.prisma.listingGenerationTask.updateMany({
          where: { id: task.id, status: "RUNNING" },
          data: { error: errorMessage(error) },
        })
      }
      await longTitle
      await this.prisma.listingGenerationTask.updateMany({
        where: { id: task.id, status: "RUNNING" },
        data: { status: "READY", leaseUntil: null },
      })
    } finally {
      clearInterval(heartbeat)
    }
  }

  async consume(stepId: number, dto: ListingAiInvocationDto): Promise<SavedBilling> {
    let outputText = ""
    let lastSavedAt = 0
    const saved: SavedBilling = {}
    try {
      for await (const event of this.gateway.streamChat(dto.systemPrompt ?? "", dto.userPrompt, {
        model: dto.model,
        temperature: dto.temperature,
        maxOutputTokens: dto.maxOutputTokens,
        resolveBilling: true,
        operationName: `Listing ${dto.operation}`,
      })) {
        if (event.type === "text") outputText += event.content
        if (event.billing) saved.billing = event.billing
        if (event.usage) saved.usage = event.usage
        if (outputText && Date.now() - lastSavedAt >= 1_000) {
          await this.prisma.listingAiStep.update({ where: { id: stepId }, data: { outputText } })
          lastSavedAt = Date.now()
        }
      }
      if (!outputText.trim()) throw new Error("模型未返回正文，主生成未扣费")
      return saved
    } finally {
      // 包括断流时已收到的片段；只重试数据库写入，绝不重试网关调用。
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.prisma.listingAiStep.update({
            where: { id: stepId },
            data: { outputText, requestId: saved.billing?.requestId, model: saved.billing?.model },
          })
          lastError = undefined
          break
        } catch (error) {
          lastError = error
        }
      }
      if (lastError) throw lastError
    }
  }
}
