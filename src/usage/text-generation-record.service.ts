import { Injectable } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import {
  ASIN_AUDIT_STAGE_SELECT,
  ASIN_EVIDENCE_SELECT,
  AsinGenerationIdentity,
  asinAuditStageRecords,
  asinEvidenceGenerationRecords,
  asinUsageFunction,
  linkAsinAuditUsage,
} from "./asin-audit-generation-records"
import { AuditPrismaService } from "./audit-prisma.service"
import { businessGenerationModels } from "./business-generation-models"
import {
  GENERATION_FUNCTION_LABELS,
  QueryGenerationRecordModelOptionsDto,
  TextGenerationFunction,
} from "./dto/query-generation-records.dto"
import { GENERATION_RECORD_WINDOW_MS, recentGenerationQuery } from "./generation-record-time-window"
import type { GenerationRecord } from "./generation-record.service"

export const SOURCE_FUNCTIONS: Record<string, TextGenerationFunction> = {
  "asin.audit.evidence": "ASIN_EVIDENCE",
  "asin.audit": "ASIN_AUDIT",
  "competitor.research": "COMPETITOR_ANALYSIS",
  "listing.generate": "LISTING_GENERATION",
  "listing.score": "LISTING_SCORING",
  "category.analysis": "CATEGORY_ANALYSIS",
  "flow.workbench": "PRODUCT_SELECTION",
  "pricing.quote": "SMART_PRICING",
  "launch.plan": "PROMOTION_PLAN",
  "video.analysis": "VIDEO_ANALYSIS",
  "chetaidou.breakdown": "CHETAIDOU_TEXT",
  "chetaidou.ideation": "CHETAIDOU_TEXT",
  "chetaidou.diverge": "CHETAIDOU_TEXT",
  "chetaidou.compose": "CHETAIDOU_TEXT",
}

type Link = [string, string | number | null | undefined]
const USER_SELECT = {
  id: true,
  username: true,
  phone: true,
  orgs: { select: { org: { select: { name: true } } } },
  roles: { select: { role: { select: { name: true, color: true } } } },
} satisfies Prisma.UserSelect

type Candidate = {
  key?: string
  function: TextGenerationFunction
  id: number | string
  userId: number
  prompt: string
  status: string
  createdAt: Date
  deletedAt?: Date | null
  model?: string | null
  resultLabel?: string
  resultUrl?: string | null
  operation?: string
  links: Link[]
  models?: string[]
  recordId?: string
  audit?: AsinGenerationIdentity
  actualModel?: string | null
  actualModels?: string[]
}

function object(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function text(value: Prisma.JsonValue | undefined): string {
  return typeof value === "string" ? value : ""
}

function linkKey(fn: TextGenerationFunction, userId: number, [kind, value]: Link) {
  return value == null ? null : `${fn}:${userId}:${kind}:${typeof value}:${value}`
}

@Injectable()
export class TextGenerationRecordService {
  constructor(private readonly audit: AuditPrismaService) {}

  /** 先关联完整结果集与台账，再统一筛选，避免日期/模型筛选拆开正文和费用。 */
  async list(
    query: QueryGenerationRecordModelOptionsDto & { model?: string },
    now = new Date(),
    projection = false
  ): Promise<GenerationRecord[]> {
    if (!projection) query = recentGenerationQuery(query, now)
    const from = new Date(query.dateFrom!).getTime()
    const to = new Date(query.dateTo!).getTime()
    if (from > to) return []
    // 10 秒边界余量用于历史 ASIN 流水与保存事件的双向唯一关联，最终展示仍严格为近 14 天。
    const createdAt = {
      gte: projection
        ? new Date(query.dateFrom!)
        : new Date(now.getTime() - GENERATION_RECORD_WINDOW_MS - 10_000),
      lte: projection ? new Date(query.dateTo!) : now,
    }
    const sources = Object.keys(SOURCE_FUNCTIONS).filter(
      source => !query.function || SOURCE_FUNCTIONS[source] === query.function
    )
    if (query.function === "ASIN_EVIDENCE") sources.push("asin.audit")
    if (!sources.length) return []
    const scopedUsers =
      query.orgId || query.roleId
        ? await this.audit.user.findMany({
            where: {
              ...(query.orgId ? { orgs: { some: { orgId: query.orgId } } } : {}),
              ...(query.roleId ? { roles: { some: { roleId: query.roleId } } } : {}),
            },
            select: USER_SELECT,
          })
        : null
    if (scopedUsers && !scopedUsers.length) return []
    const userIds = scopedUsers?.map(user => user.id)
    const logSelect = {
      id: true,
      userId: true,
      source: true,
      credits: true,
      meta: true,
      requestId: true,
      createdAt: true,
    } as const
    const recentLogs = await this.audit.usageLog.findMany({
      where: {
        userId: userIds ? { in: userIds } : undefined,
        source: { in: sources },
        createdAt,
      },
      select: logSelect,
      orderBy: { id: "asc" },
    })
    // 近期流水可能迟于报告归档；按明确引用补入旧报告上下文，防止误显示成新的孤立扣费行。
    const candidates = await this.candidates(query, createdAt, recentLogs, userIds)
    const related = this.relatedLogWhere(
      candidates.filter(row => row.createdAt.getTime() >= from && row.createdAt.getTime() <= to)
    )
    const olderLogs = related.length
      ? await this.audit.usageLog.findMany({
          where: { createdAt: { lt: createdAt.gte }, OR: related },
          select: logSelect,
          orderBy: { id: "asc" },
        })
      : []
    const allLogs = [
      ...new Map([...recentLogs, ...olderLogs].map(log => [log.id, log])).values(),
    ].sort((a, b) => a.id - b.id)
    const logs = allLogs.filter(
      log =>
        !query.function ||
        (asinUsageFunction(log) ?? SOURCE_FUNCTIONS[log.source!]) === query.function
    )
    const ownerIds = [
      ...new Set([...candidates.map(row => row.userId), ...logs.map(row => row.userId)]),
    ]
    const users =
      scopedUsers ??
      (ownerIds.length
        ? await this.audit.user.findMany({
            where: { id: { in: ownerIds } },
            select: USER_SELECT,
          })
        : [])
    const index = new Map<string, Candidate | null>()
    for (const candidate of candidates) {
      candidate.models = [
        ...new Set([...(candidate.models ?? []), ...(candidate.model ? [candidate.model] : [])]),
      ]
      for (const link of candidate.links) {
        const key = linkKey(candidate.function, candidate.userId, link)
        if (!key) continue
        const previous = index.get(key)
        // 同一个关联键指向不同报告时保持待关联，不能随查询顺序把费用挂到其中一份。
        index.set(key, previous === undefined || previous === candidate ? candidate : null)
      }
    }
    const amounts = new Map<Candidate, Decimal>()
    const auditMatches = linkAsinAuditUsage(candidates, logs)
    for (const log of logs) {
      const fn = asinUsageFunction(log) ?? SOURCE_FUNCTIONS[log.source!]
      const meta = object(log.meta)
      const links: Link[] = [
        ["usageLogId", log.id],
        ["requestId", log.requestId],
        ...[
          "recordId",
          "analysisId",
          "listingHistoryId",
          "listingStepId",
          "taskId",
          "clientRequestId",
          "businessEventId",
          "listingRunId",
        ].map<Link>(kind => [
          kind,
          typeof meta[kind] === "string" || typeof meta[kind] === "number" ? meta[kind] : null,
        ]),
      ]
      let candidate: Candidate | undefined = auditMatches.get(log.id)
      for (const link of asinUsageFunction(log) ? [] : links) {
        const key = linkKey(fn, log.userId, link)
        const hit = key ? index.get(key) : null
        if (hit) {
          candidate = hit
          break
        }
      }
      if (!candidate) {
        candidate = {
          function: fn,
          id: `usage:${log.id}`,
          userId: log.userId,
          prompt:
            text(meta.prompt) ||
            text(meta.productName) ||
            text(meta.title) ||
            text(meta.videoUrl) ||
            GENERATION_FUNCTION_LABELS[fn],
          status: "BILLED",
          createdAt: log.createdAt,
          links: [],
          models: [],
          operation: text(meta.operation) || text(meta.action) || text(meta.stage) || undefined,
          resultLabel: "已扣费，暂无关联报告",
        }
        candidates.push(candidate)
      }
      const model = text(meta.model)
      if (model && !candidate.models!.includes(model)) candidate.models!.push(model)
      if (log.credits != null) {
        // 以台账 credits 为准；退款修复会回写该列，不能再按 meta.refundedCredits 二次扣减。
        amounts.set(candidate, (amounts.get(candidate) ?? new Decimal(0)).plus(log.credits))
      }
    }
    const userMap = new Map(users.map(user => [user.id, user]))
    const keyword = query.keyword?.toLocaleLowerCase()
    return candidates.flatMap(candidate => {
      const user = userMap.get(candidate.userId)
      if (!user) return []
      const time = candidate.createdAt.getTime()
      if (time < from || time > to) return []
      if (
        query.model &&
        ![...candidate.models!, ...(candidate.actualModels ?? [])].includes(query.model)
      )
        return []
      if (
        keyword &&
        ![user.username, user.phone, candidate.prompt].some(value =>
          value.toLocaleLowerCase().includes(keyword)
        )
      )
        return []
      const model =
        query.model && candidate.models!.includes(query.model)
          ? query.model
          : (candidate.models![0] ?? "")
      const fixedBusiness = ["SMART_PRICING", "PROMOTION_PLAN"].includes(candidate.function)
      return [
        {
          key: candidate.key ?? `TEXT:${candidate.function}:${candidate.id}`,
          function: candidate.function,
          contentType: "TEXT" as const,
          id: candidate.id,
          userId: user.id,
          username: user.username,
          phone: user.phone,
          orgs: user.orgs.map(row => row.org.name),
          roles: user.roles.map(row => ({ name: row.role.name, color: row.role.color })),
          prompt: candidate.prompt,
          model,
          models: candidate.models,
          ...(candidate.actualModels
            ? { actualModel: candidate.actualModel ?? null, actualModels: candidate.actualModels }
            : {}),
          modelLabel:
            candidate.actualModel ??
            (fixedBusiness && (!model || model === "fixed-module")
              ? "—"
              : model === "fixed-module"
                ? "按功能计费"
                : model),
          credits: amounts.get(candidate)?.toString() ?? null,
          status: candidate.status,
          resultUrl: candidate.deletedAt ? null : (candidate.resultUrl ?? null),
          resultLabel: candidate.resultLabel ?? GENERATION_FUNCTION_LABELS[candidate.function],
          operation: candidate.operation,
          ...(candidate.recordId ? { recordId: candidate.recordId } : {}),
          expired: false,
          deleted: candidate.deletedAt != null,
          createdAt: candidate.createdAt,
        },
      ]
    })
  }

  private async candidates(
    query: QueryGenerationRecordModelOptionsDto,
    createdAt: { gte: Date; lte: Date },
    logs: Array<{
      id: number
      userId: number
      source: string | null
      requestId: string | null
      meta: Prisma.JsonValue | null
    }>,
    userIds?: number[]
  ): Promise<Candidate[]> {
    const wanted = (fn: TextGenerationFunction) => !query.function || query.function === fn
    const userId = userIds ? { in: userIds } : undefined
    const values = (fn: TextGenerationFunction, field: string) =>
      logs
        .filter(log => (asinUsageFunction(log) ?? SOURCE_FUNCTIONS[log.source!]) === fn)
        .map(log => object(log.meta)[field])
    const strings = (fn: TextGenerationFunction, field = "recordId") =>
      values(fn, field).filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0 && value.length <= 191
      )
    const numbers = (fn: TextGenerationFunction, field: string) =>
      values(fn, field).filter(
        (value): value is number =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value > 0 &&
          value <= 2_147_483_647
      )
    const withIds = <Id extends string | number>(ids: Id[]) =>
      ids.length ? { OR: [{ createdAt }, { id: { in: ids } }] } : { createdAt }
    const usageIds = logs.map(log => log.id)
    const requestIds = logs.flatMap(log => (log.requestId ? [log.requestId] : []))
    const historyRefs = [
      ...numbers("LISTING_GENERATION", "listingHistoryId"),
      ...numbers("LISTING_SCORING", "listingHistoryId"),
    ]
    const stepIds = [
      ...numbers("LISTING_GENERATION", "listingStepId"),
      ...numbers("LISTING_SCORING", "listingStepId"),
    ]
    const listingRunIds = [
      ...strings("LISTING_GENERATION", "businessEventId"),
      ...strings("LISTING_SCORING", "businessEventId"),
      ...strings("LISTING_GENERATION", "listingRunId"),
      ...strings("LISTING_SCORING", "listingRunId"),
    ]
    const businessRunIds = [
      ...strings("LISTING_SCORING", "businessEventId"),
      ...strings("COMPETITOR_ANALYSIS", "businessEventId"),
    ]
    const callPrefix = "chetaidou:charge:"
    const callIds = requestIds
      .filter(id => id.startsWith(callPrefix))
      .map(id => id.slice(callPrefix.length))
    const [
      histories,
      runs,
      categories,
      selections,
      pricing,
      promotions,
      videos,
      evidence,
      audits,
      competitors,
      tasks,
      calls,
    ] = await Promise.all([
      wanted("LISTING_GENERATION") || wanted("LISTING_SCORING")
        ? this.audit.history.findMany({
            where: {
              userId,
              ...(usageIds.length
                ? {
                    OR: [
                      { createdAt },
                      { id: { in: historyRefs } },
                      {
                        listingRun: {
                          OR: [
                            { runId: { in: listingRunIds } },
                            {
                              steps: {
                                some: {
                                  OR: [{ usageLogId: { in: usageIds } }, { id: { in: stepIds } }],
                                },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  }
                : { createdAt }),
              type: {
                in: [
                  ...(wanted("LISTING_GENERATION") ? ["LISTING_GENERATION" as const] : []),
                  ...(wanted("LISTING_SCORING") ? ["LISTING_SCORING" as const] : []),
                ],
              },
            },
            select: {
              id: true,
              userId: true,
              title: true,
              type: true,
              createdAt: true,
              listingRun: {
                select: {
                  runId: true,
                  status: true,
                  steps: { select: { id: true, model: true, usageLogId: true, operation: true } },
                },
              },
            },
          })
        : [],
      wanted("LISTING_SCORING") || wanted("COMPETITOR_ANALYSIS")
        ? this.audit.businessAiRun.findMany({
            where: {
              userId,
              ...(usageIds.length
                ? {
                    OR: [
                      { createdAt },
                      { usageLogId: { in: usageIds } },
                      { requestId: { in: requestIds } },
                      { runId: { in: businessRunIds } },
                    ],
                  }
                : { createdAt }),
              module: {
                in: [
                  ...(wanted("LISTING_SCORING") ? ["listing-score"] : []),
                  ...(wanted("COMPETITOR_ANALYSIS") ? ["competitor-analysis"] : []),
                ],
              },
            },
            select: {
              id: true,
              userId: true,
              runId: true,
              module: true,
              operation: true,
              model: true,
              status: true,
              usageLogId: true,
              requestId: true,
              createdAt: true,
            },
          })
        : [],
      wanted("CATEGORY_ANALYSIS")
        ? this.audit.categoryAnalysisRecord.findMany({
            where: { userId, ...withIds(numbers("CATEGORY_ANALYSIS", "analysisId")) },
            select: {
              id: true,
              userId: true,
              title: true,
              status: true,
              createdAt: true,
              deletedAt: true,
            },
          })
        : [],
      wanted("PRODUCT_SELECTION")
        ? this.audit.selectionAnalysisRecord.findMany({
            where: {
              userId,
              entry: "PRODUCT",
              ...withIds(strings("PRODUCT_SELECTION", "analysisId")),
            },
            select: {
              id: true,
              userId: true,
              primaryCategoryName: true,
              status: true,
              createdAt: true,
              deletedAt: true,
            },
          })
        : [],
      wanted("SMART_PRICING")
        ? this.audit.smartPricingRecord.findMany({
            where: { userId, ...withIds(strings("SMART_PRICING")) },
            select: {
              id: true,
              userId: true,
              clientRequestId: true,
              productName: true,
              createdAt: true,
              deletedAt: true,
            },
          })
        : [],
      wanted("PROMOTION_PLAN")
        ? this.audit.promotionPlanRecord.findMany({
            where: { userId, ...withIds(strings("PROMOTION_PLAN")) },
            select: {
              id: true,
              userId: true,
              clientRequestId: true,
              productName: true,
              createdAt: true,
            },
          })
        : [],
      wanted("VIDEO_ANALYSIS")
        ? this.audit.videoAnalysisRecord.findMany({
            where: {
              userId,
              OR: [
                { createdAt },
                {
                  chargeRequestId: {
                    in: requestIds.filter(id => id.startsWith("charge:")).map(id => id.slice(7)),
                  },
                },
              ],
            },
            select: {
              id: true,
              userId: true,
              title: true,
              focus: true,
              model: true,
              chargeRequestId: true,
              createdAt: true,
              deletedAt: true,
            },
          })
        : [],
      wanted("ASIN_EVIDENCE")
        ? this.audit.asinEvidenceRecord.findMany({
            where: {
              userId,
              OR: [
                { createdAt },
                { id: { in: strings("ASIN_EVIDENCE") } },
                { clientRequestId: { in: strings("ASIN_EVIDENCE", "clientRequestId") } },
              ],
            },
            select: ASIN_EVIDENCE_SELECT,
          })
        : [],
      wanted("ASIN_AUDIT")
        ? this.audit.asinAuditRecord.findMany({
            where: {
              userId,
              OR: [
                { createdAt },
                { optimizationRevisions: { some: { createdAt } } },
                { id: { in: strings("ASIN_AUDIT") } },
                { clientRequestId: { in: strings("ASIN_AUDIT", "clientRequestId") } },
              ],
            },
            select: ASIN_AUDIT_STAGE_SELECT,
          })
        : [],
      wanted("COMPETITOR_ANALYSIS")
        ? this.audit.competitorAnalysisRecord.findMany({
            where: {
              userId,
              OR: [
                { createdAt },
                { id: { in: strings("COMPETITOR_ANALYSIS") } },
                { clientRequestId: { in: strings("COMPETITOR_ANALYSIS", "businessEventId") } },
              ],
            },
            select: {
              id: true,
              userId: true,
              title: true,
              clientRequestId: true,
              reportPdfUrl: true,
              createdAt: true,
              deletedAt: true,
            },
          })
        : [],
      wanted("CHETAIDOU_TEXT")
        ? this.audit.chetaidouTask.findMany({
            where: {
              ownerId: userId,
              type: { not: "GENERATE" },
              ...withIds(strings("CHETAIDOU_TEXT", "taskId")),
            },
            select: { id: true, ownerId: true, type: true, status: true, createdAt: true },
          })
        : [],
      wanted("CHETAIDOU_TEXT")
        ? this.audit.chetaidouCall.findMany({
            where: {
              ownerId: userId,
              kind: "TEXT",
              OR: [
                { createdAt },
                { taskId: { in: strings("CHETAIDOU_TEXT", "taskId") } },
                { id: { in: callIds } },
              ],
            },
            select: { id: true, taskId: true, model: true },
          })
        : [],
    ])
    const linkedTasks = [...tasks]
    const taskIds = new Set(linkedTasks.map(task => task.id))
    const missingTaskIds = [
      ...new Set(calls.map(call => call.taskId).filter(id => !taskIds.has(id))),
    ]
    if (missingTaskIds.length)
      linkedTasks.push(
        ...(await this.audit.chetaidouTask.findMany({
          where: { id: { in: missingTaskIds }, ownerId: userId, type: { not: "GENERATE" } },
          select: { id: true, ownerId: true, type: true, status: true, createdAt: true },
        }))
      )
    const candidates: Candidate[] = []
    for (const row of histories) {
      const fn = row.type as "LISTING_GENERATION" | "LISTING_SCORING"
      candidates.push({
        function: fn,
        id: row.id,
        userId: row.userId,
        prompt: row.title,
        status: row.listingRun?.status ?? "SUCCESS",
        createdAt: row.createdAt,
        model: row.listingRun?.steps.find(
          step => step.operation === "generation" || step.operation === "score"
        )?.model,
        models: row.listingRun?.steps.map(step => step.model),
        links: [
          ["listingHistoryId", row.id],
          ["businessEventId", row.listingRun?.runId],
          ["listingRunId", row.listingRun?.runId],
          ...(row.listingRun?.steps.flatMap(
            step =>
              [
                ["usageLogId", step.usageLogId],
                ["listingStepId", step.id],
              ] as Link[]
          ) ?? []),
        ],
      })
    }
    const competitorByRun = new Map(
      competitors.map(row => [`${row.userId}:${row.clientRequestId}`, row])
    )
    for (const row of competitors)
      candidates.push({
        ...row,
        function: "COMPETITOR_ANALYSIS",
        prompt: row.title,
        status: "SUCCESS",
        resultUrl: row.reportPdfUrl,
        links: [
          ["recordId", row.id],
          ["businessEventId", row.clientRequestId],
        ],
      })
    for (const row of runs) {
      const report =
        row.module === "competitor-analysis"
          ? competitorByRun.get(`${row.userId}:${row.runId}`)
          : null
      if (report) {
        const candidate = candidates.find(
          item => item.function === "COMPETITOR_ANALYSIS" && item.id === report.id
        )!
        candidate.model = row.model
        candidate.links.push(["usageLogId", row.usageLogId], ["requestId", row.requestId])
      } else
        candidates.push({
          ...row,
          key: `TEXT_RUN:${row.module}:${row.id}`,
          function: row.module === "listing-score" ? "LISTING_SCORING" : "COMPETITOR_ANALYSIS",
          prompt: row.module === "listing-score" ? "Listing 独立打分" : "竞品分析总结",
          operation: row.operation,
          links: [
            ["usageLogId", row.usageLogId],
            ["requestId", row.requestId],
            ["businessEventId", row.runId],
          ],
        })
    }
    for (const row of categories)
      candidates.push({
        ...row,
        function: "CATEGORY_ANALYSIS",
        prompt: row.title,
        links: [["analysisId", row.id]],
      })
    for (const row of selections)
      candidates.push({
        ...row,
        function: "PRODUCT_SELECTION",
        prompt: row.primaryCategoryName ?? "产品验证",
        operation: "product_validation",
        links: [["analysisId", row.id]],
      })
    const [pricingModels, promotionModels] = await Promise.all([
      businessGenerationModels(this.audit, pricing, "smart-pricing"),
      businessGenerationModels(this.audit, promotions, "promotion-plan"),
    ])
    for (const row of pricing)
      candidates.push({
        ...row,
        ...(pricingModels.get(row.id) ?? { actualModel: null, actualModels: [] }),
        function: "SMART_PRICING",
        prompt: row.productName,
        status: "SUCCESS",
        links: [["recordId", row.id]],
      })
    for (const row of promotions)
      candidates.push({
        ...row,
        ...(promotionModels.get(row.id) ?? { actualModel: null, actualModels: [] }),
        function: "PROMOTION_PLAN",
        prompt: row.productName,
        status: "SUCCESS",
        links: [["recordId", row.id]],
      })
    for (const row of videos)
      candidates.push({
        ...row,
        function: "VIDEO_ANALYSIS",
        prompt: [row.title, row.focus].filter(Boolean).join(" · "),
        status: "SUCCESS",
        links: [["requestId", `charge:${row.chargeRequestId}`]],
      })
    candidates.push(...asinEvidenceGenerationRecords(evidence))
    candidates.push(...asinAuditStageRecords(audits))
    const taskLabels: Record<string, string> = {
      BREAKDOWN: "母版拆解",
      IDEATION: "联想扩展",
      REFRESH_GROUP: "联想刷新",
      DIVERGE: "维度发散",
      COMPOSE: "指令组合",
    }
    const callsByTask = new Map<string, Array<{ id: string; model: string }>>()
    for (const call of calls) {
      const group = callsByTask.get(call.taskId) ?? []
      group.push(call)
      callsByTask.set(call.taskId, group)
    }
    for (const row of linkedTasks) {
      const taskCalls = callsByTask.get(row.id) ?? []
      candidates.push({
        ...row,
        function: "CHETAIDOU_TEXT",
        userId: row.ownerId,
        prompt: `车泰斗 · ${taskLabels[row.type] ?? row.type}`,
        status: row.status ?? "GENERATING",
        operation: row.type,
        model: taskCalls[0]?.model,
        models: taskCalls.map(call => call.model),
        links: [
          ["taskId", row.id],
          ...taskCalls.map(call => ["requestId", `chetaidou:charge:${call.id}`] as Link),
        ],
      })
    }
    return candidates
  }

  /** 只补查当前候选记录明确引用的旧流水，不加载整段历史台账。 */
  private relatedLogWhere(candidates: Candidate[]): Prisma.UsageLogWhereInput[] {
    return candidates.flatMap(candidate => {
      const links: Link[] = candidate.audit
        ? [
            ["recordId", candidate.audit.recordId],
            ["clientRequestId", candidate.audit.clientRequestId],
          ]
        : candidate.links
      const OR = links.flatMap<Prisma.UsageLogWhereInput>(([kind, value]) => {
        if (value == null || value === "") return []
        if (kind === "usageLogId") return typeof value === "number" ? [{ id: value }] : []
        if (kind === "requestId") return typeof value === "string" ? [{ requestId: value }] : []
        return [{ meta: { path: `$.${kind}`, equals: value } }]
      })
      // 历史 ASIN 无共同 ID 时，沿已加载报告的保存事件查前 10 秒；仍由双向唯一规则核对。
      for (const event of candidate.audit?.events ?? [])
        OR.push({
          createdAt: { gte: new Date(event.getTime() - 10_000), lte: event },
        })
      if (!OR.length) return []
      const sources = Object.keys(SOURCE_FUNCTIONS).filter(
        source => SOURCE_FUNCTIONS[source] === candidate.function
      )
      if (candidate.function === "ASIN_EVIDENCE") sources.push("asin.audit")
      return [{ userId: candidate.userId, source: { in: sources }, OR }]
    })
  }
}
