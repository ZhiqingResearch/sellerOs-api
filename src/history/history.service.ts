import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { Prisma, type ListingAiStep, type ListingRun } from "@prisma/client"
import { PaginationDto } from "../common/dto/pagination.dto"
import { PrismaService } from "../prisma/prisma.service"
import { CreateHistoryDto } from "./dto/create-history.dto"
import { UpdateHistoryDto } from "./dto/update-history.dto"
import { getListingHistoryScore } from "./listing-history-score"

const LISTING_STEP_SUMMARY_SELECT = {
  id: true,
  listingRunId: true,
  operation: true,
  model: true,
  status: true,
  usageLogId: true,
  error: true,
  requestId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ListingAiStepSelect

type ListingStepSummary = Omit<ListingAiStep, "outputText"> & { outputText?: string | null }
type ListingRunSummary = ListingRun & { steps?: ListingStepSummary[] }

@Injectable()
export class HistoryService {
  private readonly logger = new Logger(HistoryService.name)

  constructor(private readonly prisma: PrismaService) {}

  async findByUser(userId: number, pagination: PaginationDto) {
    const { page, pageSize } = pagination
    const skip = (page - 1) * pageSize
    const emptyListingHistoryIds = await this._findEmptyListingHistoryIds(userId)
    const where: Prisma.HistoryWhereInput = {
      userId,
      ...(emptyListingHistoryIds.length ? { id: { notIn: emptyListingHistoryIds } } : {}),
    }

    const [items, total] = await Promise.all([
      this.prisma.history.findMany({
        where,
        select: {
          id: true,
          type: true,
          title: true,
          score: true,
          createdAt: true,
          updatedAt: true,
          listingRun: {
            include: { steps: { select: LISTING_STEP_SUMMARY_SELECT, orderBy: { id: "asc" } } },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.history.count({ where }),
    ])

    return {
      items: await this._attachListingDetails(items, userId),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  private async _findEmptyListingHistoryIds(userId: number): Promise<number[]> {
    // 任务必须先落库才能恢复/幂等；没有产出和消费的任务不作为用户生成记录展示。
    // 属性分析/类目匹配只是准备步骤，其原始响应不算 Listing 生成结果。
    const candidates = await this.prisma.listingRun.findMany({
      where: {
        history: { userId, type: "LISTING_GENERATION", score: null },
        steps: {
          none: {
            operation: { in: ["generation", "optimization"] },
            outputText: { not: null },
            NOT: { outputText: "" },
          },
        },
      },
      select: {
        runId: true,
        historyId: true,
        history: { select: { data: true } },
        steps: { select: { usageLogId: true } },
      },
    })
    const emptyCandidates = candidates.filter(candidate => {
      const data = candidate.history.data as Prisma.JsonObject | null
      // 已保存的报告不能因任务状态滞后或旧步骤缺失而消失。
      return !data?.result && !(Array.isArray(data?.plans) && data.plans.some(plan =>
        plan && typeof plan === "object" && !Array.isArray(plan) &&
        (plan.result || (typeof plan.partialText === "string" && plan.partialText.trim()))
      ))
    })
    if (!emptyCandidates.length) return []

    const usageLogIds = emptyCandidates.flatMap(candidate =>
      (candidate.steps ?? []).flatMap(step => step.usageLogId ? [step.usageLogId] : [])
    )
    // 关联了零积分用量日志不代表发生扣费；MCP 同时兼容新旧工作流关联键。
    const logs = await this.prisma.usageLog.findMany({
      where: {
        userId,
        credits: { gt: 0 },
        OR: [
          ...(usageLogIds.length ? [{ id: { in: usageLogIds } }] : []),
          ...emptyCandidates.flatMap(candidate => [
            { meta: { path: "$.listingRunId", equals: candidate.runId } },
            { meta: { path: "$.businessEventId", equals: candidate.runId } },
          ]),
        ],
      },
      select: { id: true, meta: true },
    })
    const billedLogIds = new Set(logs.map(log => log.id))
    const billedRunIds = new Set(logs.flatMap(log => {
      const meta = log.meta as Prisma.JsonObject | null
      return [meta?.listingRunId, meta?.businessEventId].filter((id): id is string => typeof id === "string")
    }))
    return emptyCandidates.filter(candidate =>
      !billedRunIds.has(candidate.runId) &&
      !(candidate.steps ?? []).some(step => step.usageLogId && billedLogIds.has(step.usageLogId))
    ).map(candidate => candidate.historyId)
  }

  async findById(id: number, userId: number) {
    const record = await this.prisma.history.findFirst({
      where: { id, userId },
      include: { listingRun: { include: { steps: { orderBy: { id: "asc" } } } } },
    })

    if (!record) {
      throw new NotFoundException("历史记录不存在")
    }

    return (await this._attachListingDetails([record], userId))[0]
  }

  async findByRunId(runId: string, userId: number) {
    // 轮询不重复传输完整原始模型正文；正文只在记录详情中按需查看。
    const record = await this.prisma.history.findFirst({
      where: { userId, listingRun: { runId } },
      include: { listingRun: true },
    })
    if (!record) throw new NotFoundException("生成记录不存在")
    return (await this._attachListingDetails([record], userId, false))[0]
  }

  private async _attachListingDetails<
    T extends { listingRun?: ListingRunSummary | null; updatedAt?: Date },
  >(items: T[], userId: number, hasStepDetails = true) {
    const runIds = items.flatMap(item => (item.listingRun ? [item.listingRun.runId] : []))
    const usageLogIds = items.flatMap(item =>
      (item.listingRun?.steps ?? []).flatMap(step => (step.usageLogId ? [step.usageLogId] : []))
    )
    const [logs, mcpSteps] = await Promise.all([
      usageLogIds.length
        ? this.prisma.usageLog.findMany({
            where: {
              id: { in: usageLogIds },
              userId,
              source: { in: ["listing.generate", "listing.score"] },
            },
            select: { id: true, credits: true },
          })
        : Promise.resolve([]),
      this._findListingMcpSteps(userId, hasStepDetails ? runIds : []),
    ])
    const creditsByLogId = new Map(logs.map(log => [log.id, log.credits]))
    return items.map(item => {
      const { listingRun: run, ...record } = item
      // 保留现有接口字段，数据库职责拆分不改变页面交互或旧报告结构。
      const details = run
        ? {
            updatedAt: new Date(Math.max(run.updatedAt.getTime(), item.updatedAt?.getTime() ?? 0)),
            listingRunId: run.runId,
            listingStatus: run.status,
            listingStage: run.stage,
            listingError: run.error,
            listingAttempts: run.attempts,
            listingSteps: hasStepDetails
              ? [
                  ...(run.steps ?? []).map(({ usageLogId, ...step }) => ({
                    ...step,
                    credits:
                      (usageLogId && creditsByLogId.get(usageLogId)) || new Prisma.Decimal(0),
                  })),
                  ...(mcpSteps.get(run.runId) ?? []),
                ]
              : undefined,
          }
        : undefined
      return { ...record, ...details }
    })
  }

  private async _findListingMcpSteps(userId: number, runIds: string[]) {
    const steps = new Map<
      string,
      Array<{
        id: number
        operation: string
        model: string
        status: string
        credits: Prisma.Decimal
        createdAt: Date
        requestId: string | null
      }>
    >()
    if (!runIds.length) return steps
    // 只关联本人、本工作流实际产生的 MCP 账单，不估算次数或再次扣费。
    const logs = await this.prisma.usageLog.findMany({
      where: {
        userId,
        source: "listing.generate",
        type: "MCP",
        OR: runIds.map(runId => ({ meta: { path: "$.listingRunId", equals: runId } })),
      },
      select: { id: true, credits: true, createdAt: true, meta: true, requestId: true },
    })
    for (const log of logs) {
      const runId = (log.meta as Prisma.JsonObject | null)?.listingRunId
      if (typeof runId !== "string") continue
      const group = steps.get(runId) ?? []
      group.push({
        id: -log.id,
        operation: "mcp",
        model: "数据服务",
        status: "COMPLETED",
        credits: log.credits ?? new Prisma.Decimal(0),
        createdAt: log.createdAt,
        requestId: log.requestId,
      })
      steps.set(runId, group)
    }
    return steps
  }

  async create(userId: number, dto: CreateHistoryDto) {
    const reportScore = dto.type === "LISTING_GENERATION" ? getListingHistoryScore(dto.data) : undefined
    // 创建即落首版 revision(v1)，保证「History.data == 最新 revision.data」从一开始成立
    const record = await this.prisma.history.create({
      data: {
        title: dto.title,
        type: dto.type,
        score: reportScore !== undefined ? reportScore : dto.score,
        data: dto.data as Prisma.InputJsonValue,
        userId,
        version: 1,
        revisions: { create: { version: 1, data: dto.data as Prisma.InputJsonValue } },
      },
    })
    this.logger.log(`History created: id=${record.id}, user=${userId}`)
    return record
  }

  /**
   * 通用编辑：title / score / data 都可改。
   * 传了 data（且非 null）就留档一个新版本（version 自增 + 新建 revision）；
   * 没传 data（或为 null）只改 title / score，不产生新版本。
   */
  async update(id: number, userId: number, dto: UpdateHistoryDto) {
    if (dto.title === undefined && dto.score === undefined && dto.data === undefined) {
      throw new BadRequestException("请至少提供一个待修改的字段")
    }

    const dataProvided = dto.data !== undefined && dto.data !== null
    const incoming = dto.data as Record<string, unknown> | undefined
    const isListingReportUpdate = dataProvided && Array.isArray(incoming?.plans)

    return this.prisma.$transaction(async tx => {
      if (isListingReportUpdate) {
        // 只有 Listing 报告需要与后台任务串行合并；其他历史类型保持原更新路径。
        await tx.$queryRaw`SELECT id FROM History WHERE id = ${id} AND userId = ${userId} FOR UPDATE`
      }
      const current = await tx.history.findFirst({
        where: { id, userId },
        include: { listingRun: { select: { id: true } } },
      })
      if (!current) {
        throw new NotFoundException("历史记录不存在")
      }
      let report = dto.data as Prisma.InputJsonValue
      if (dataProvided && current.listingRun && Array.isArray(incoming?.plans)) {
        const previous = current.data as Prisma.JsonObject
        const plans = Array.isArray(previous.plans) ? [...previous.plans] : []
        for (const [index, plan] of incoming.plans.entries()) {
          // 浏览器评分补充尚未拿到另一方案时，不能用 null 覆盖服务端已经保存的结果。
          if (plan && typeof plan === "object" && (plan as Record<string, unknown>).result) {
            const explicitIndex = (plan as Record<string, unknown>).planIndex
            const targetIndex = explicitIndex === 0 || explicitIndex === 1 ? explicitIndex : index
            while (plans.length <= targetIndex) plans.push(null)
            plans[targetIndex] = plan as Prisma.JsonValue
          }
        }
        report = { ...previous, ...dto.data, plans } as Prisma.InputJsonValue
      }

      // 没传 data（或为 null）：只改 title / score，不留档
      if (!dataProvided) {
        return tx.history.update({
          where: { id },
          data: {
            ...(dto.title !== undefined && { title: dto.title }),
            ...(dto.score !== undefined && { score: dto.score }),
          },
        })
      }

      // 老数据兜底：历史遗留记录（本功能上线前创建，从未留档）首次改 data 时，
      // 先把当前（改动前）data 补成 v1，避免丢失原始版本
      const revCount = await tx.historyRevision.count({ where: { historyId: id } })
      if (revCount === 0) {
        await tx.historyRevision.create({
          data: { historyId: id, version: 1, data: current.data as Prisma.InputJsonValue },
        })
      }

      // 以事务内合并后的报告为准，避免前端单方案快照覆盖另一方案的最高分。
      const reportScore = current.type === "LISTING_GENERATION" ? getListingHistoryScore(report) : undefined
      const score = reportScore !== undefined ? reportScore : dto.score
      const updated = await tx.history.update({
        where: { id },
        data: {
          version: { increment: 1 },
          data: report,
          ...(dto.title !== undefined && { title: dto.title }),
          ...(score !== undefined && { score }),
        },
      })

      await tx.historyRevision.create({
        data: { historyId: id, version: updated.version, data: report },
      })

      this.logger.log(`History updated: id=${id}, user=${userId}, version=${updated.version}`)
      return updated
    }, isListingReportUpdate ? {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 60_000,
    } : undefined)
  }
}
