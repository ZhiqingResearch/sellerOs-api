import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { randomUUID } from "crypto"
import { getListingHistoryScore } from "../history/listing-history-score"
import { PrismaService } from "../prisma/prisma.service"
import { ListingAiInvocationDto } from "./dto/listing-ai.dto"
import { CreateListingRunDto, UpdateListingRunDto } from "./dto/listing-run.dto"

const LISTING_TRANSACTION_MAX_WAIT_MS = 10_000
const LISTING_TRANSACTION_TIMEOUT_MS = 60_000

export const LISTING_STEP_LABELS: Record<string, string> = {
  category_match: "类目匹配",
  attribute_analysis: "属性分析",
  long_title: "长标题生成",
  generation: "Listing 主生成",
  optimization: "Listing 优化",
  qa_rewrite: "问答改写",
  score: "Listing 评分",
}

@Injectable()
export class ListingRunService {
  private readonly logger = new Logger(ListingRunService.name)
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: number, dto: CreateListingRunDto) {
    // UUID 唯一索引兜并发；冲突后必须再验证归属，不泄露其他用户的记录。
    const data = { params: { keyword: dto.title }, plans: [] }
    let record: { id: number; historyId: number; history: { userId: number } }
    try {
      record = await this.prisma.listingRun.upsert({
        where: { runId: dto.runId },
        update: {},
        create: {
          runId: dto.runId,
          history: {
            create: {
              userId,
              title: `Listing 生成 · ${dto.title}`.slice(0, 500),
              type: "LISTING_GENERATION",
              data,
              revisions: { create: { version: 1, data } },
            },
          },
        },
        select: { id: true, historyId: true, history: { select: { userId: true } } },
      })
    } catch (error: unknown) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002")
        throw error
      const existing = await this.prisma.listingRun.findUnique({
        where: { runId: dto.runId },
        select: { id: true, historyId: true, history: { select: { userId: true } } },
      })
      if (!existing) throw error
      record = existing
    }
    if (record.history.userId !== userId) throw new NotFoundException("生成记录不存在")
    return { id: record.historyId, runId: dto.runId, taskId: record.id }
  }

  async update(
    userId: number,
    runId: string,
    dto: UpdateListingRunDto,
    persistGeneration?: (tx: Prisma.TransactionClient) => Promise<void>
  ) {
    return this.prisma.$transaction(
      async tx => {
        // 先锁公共报告，再锁任务，与通用编辑及另一方案保存按相同顺序串行。
        const run = await tx.listingRun.findFirst({
          where: { runId, history: { userId } },
          select: { id: true, historyId: true },
        })
        if (!run) throw new NotFoundException("生成记录不存在")
        if (
          !persistGeneration &&
          (await tx.listingGenerationTask.findFirst({
            where: { listingRunId: run.id },
            select: { id: true },
          }))
        )
          throw new ConflictException("后台任务的终态只能通过生成任务接口保存")
        const rows = await tx.$queryRaw<
          { id: number }[]
        >`SELECT id FROM History WHERE id = ${run.historyId} AND userId = ${userId} FOR UPDATE`
        if (!rows.length) throw new NotFoundException("生成记录不存在")
        const id = rows[0].id
        await tx.$queryRaw`SELECT id FROM ListingRun WHERE id = ${run.id} FOR UPDATE`
        const task = await tx.listingRun.findUniqueOrThrow({ where: { id: run.id } })
        const current = await tx.history.findUniqueOrThrow({ where: { id } })
        const attempts =
          task.attempts && typeof task.attempts === "object" && !Array.isArray(task.attempts)
            ? { ...task.attempts }
            : {}
        if (dto.attemptId && dto.planIndex !== undefined) {
          const previousAttempt = attempts[String(dto.planIndex)] as Prisma.JsonObject | undefined
          if (dto.status === "RUNNING" && previousAttempt?.status === "RUNNING") {
            if (previousAttempt.attemptId === dto.attemptId && !persistGeneration) return { id, runId }
            const startedAt =
              typeof previousAttempt.startedAt === "number"
                ? previousAttempt.startedAt
                : (task.updatedAt?.getTime() ?? Date.now())
            if (previousAttempt.attemptId !== dto.attemptId && Date.now() - startedAt < 30 * 60_000)
              throw new ConflictException("该方案仍在生成中，请到生成记录查看进度，勿重复提交")
          }
          if (dto.status !== "RUNNING" && previousAttempt?.attemptId !== dto.attemptId) {
            throw new ConflictException("该方案已有新的生成任务，旧任务结果仍保留在分步记录中")
          }
          // 网络重试不能把同一次已完成任务改回运行中或失败。
          if (
            previousAttempt?.attemptId === dto.attemptId &&
            previousAttempt.status === "COMPLETED"
          )
            return { id, runId }
          attempts[String(dto.planIndex)] = {
            attemptId: dto.attemptId,
            status: dto.status,
            stage: dto.stage,
            error: dto.error ?? null,
            startedAt:
              dto.status === "RUNNING" ? Date.now() : (previousAttempt?.startedAt ?? Date.now()),
          }
        }
        let report = dto.data as Prisma.InputJsonValue | undefined
        if (report && dto.planIndex !== undefined) {
          const previous =
            current.data && typeof current.data === "object" && !Array.isArray(current.data)
              ? current.data
              : {}
          const incoming = dto.data!
          const plans = Array.isArray(previous.plans) ? [...previous.plans] : []
          while (plans.length <= dto.planIndex) plans.push(null)
          const incomingPlan = (incoming.plans as Prisma.JsonArray)?.[0]
          plans[dto.planIndex] =
            incomingPlan && typeof incomingPlan === "object"
              ? { ...incomingPlan, planIndex: dto.planIndex }
              : null
          report = { ...previous, ...incoming, plans } as Prisma.InputJsonValue
        }
        const isReportChanged =
          report !== undefined && JSON.stringify(report) !== JSON.stringify(current.data)
        // 后台任务认领、报告与扣费共用当前事务，任一步失败全部回滚。
        if (persistGeneration) await persistGeneration(tx)
        const planAttempts = Object.values(attempts).filter(
          (value): value is Prisma.JsonObject =>
            !!value && typeof value === "object" && !Array.isArray(value)
        )
        const hasRunningPlan = planAttempts.some(attempt => attempt.status === "RUNNING")
        const hasPartialPlan = planAttempts.some(attempt => attempt.status === "PARTIAL")
        const hasCompletedPlan = planAttempts.some(attempt => attempt.status === "COMPLETED")
        const hasFailedPlan = planAttempts.some(attempt => attempt.status === "FAILED")
        const status = hasRunningPlan
          ? "RUNNING"
          : hasPartialPlan || (hasCompletedPlan && hasFailedPlan)
            ? "PARTIAL"
            : dto.status
        await tx.listingRun.update({
          where: { id: run.id },
          data: {
            status,
            stage: hasRunningPlan && dto.status !== "RUNNING" ? "generation" : dto.stage,
            error: dto.error?.slice(0, 1000) ?? null,
            ...(dto.attemptId ? { attempts: attempts as Prisma.InputJsonValue } : {}),
          },
        })
        if (isReportChanged) {
          await tx.history.update({
            where: { id },
            data: { data: report, score: getListingHistoryScore(report), version: { increment: 1 } },
          })
          await tx.historyRevision.create({
            data: { historyId: id, version: current.version + 1, data: report! },
          })
        }
        this.logger.log(
          `Listing run=${runId} history=${id} user=${userId} stage=${dto.stage} status=${dto.status}${dto.error ? ` error=${dto.error.slice(0, 1000)}` : ""}`
        )
        return { id, runId }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: LISTING_TRANSACTION_MAX_WAIT_MS,
        timeout: LISTING_TRANSACTION_TIMEOUT_MS,
      }
    )
  }

  async beginStep(userId: number, dto: ListingAiInvocationDto) {
    // 一键上架由 ProductPublishTask 保存报告；模型输出校验与扣费仍走 ListingAiService。
    if (dto.shouldSaveHistory === false) {
      if (dto.runId) throw new BadRequestException("关闭独立 Listing 记录时不可传入 runId")
      return null
    }
    // 独立评分沿用评分模块；旧 Listing 客户端也先落记录，防止升级期间仍出现孤立扣费。
    if (dto.operation === "score" && !dto.runId) return null
    const run = await this.create(userId, {
      runId: dto.runId ?? randomUUID(),
      title: LISTING_STEP_LABELS[dto.operation],
    })
    const step = await this.prisma.listingAiStep.create({
      data: {
        listingRunId: run.taskId,
        operation: dto.operation,
        model: dto.model,
      },
    })
    return { ...step, historyId: run.id, runId: run.runId }
  }

  async completeStep(
    id: number,
    outputText: string,
    requestId: string | undefined,
    model: string | undefined,
    charge: (tx: Prisma.TransactionClient) => Promise<number | null>
  ) {
    // 正文先单独留存；扣费事务回滚时不能把唯一的模型结果一起丢掉。
    // 此时仍为 RUNNING，不表示扣费/业务生成已经完成。
    await this.prisma.listingAiStep.updateMany({
      where: { id, status: "RUNNING" },
      data: { outputText, requestId, ...(model ? { model } : {}) },
    })
    return this.prisma.$transaction(
      async tx => {
        const claimed = await tx.listingAiStep.updateMany({
          where: { id, status: "RUNNING" },
          data: { status: "COMPLETED", outputText, requestId, ...(model ? { model } : {}) },
        })
        if (!claimed.count) return
        const usageLogId = await charge(tx)
        await tx.listingAiStep.update({ where: { id }, data: { usageLogId } })
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: LISTING_TRANSACTION_MAX_WAIT_MS,
        timeout: LISTING_TRANSACTION_TIMEOUT_MS,
      }
    )
  }

  async failStep(id: number, error: unknown) {
    const message = error instanceof Error ? error.message : "模型调用失败"
    const step = await this.prisma.listingAiStep.update({
      where: { id },
      data: { status: "FAILED", error: message.slice(0, 1000) },
    })
    this.logger.error(
      `Listing task=${step.listingRunId} step=${id} operation=${step.operation} error=${message.slice(0, 1000)}`
    )
    // 晚到的并行失败不能抹掉已保存的结果。
    await this.prisma.listingRun.updateMany({
      where: { id: step.listingRunId, status: { in: ["ANALYZING", "FAILED"] } },
      data: {
        status: "FAILED",
        stage: step.operation,
        error: message.slice(0, 1000),
      },
    })
  }
}
