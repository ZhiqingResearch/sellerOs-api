/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
// 来源枚举仅由内部成功节点选择；异构 Prisma 委托动态派发，SQL 强制限制实体范围。
import { Prisma } from "@prisma/client"
import { resolveGatewayModel } from "../image-generation/providers/gateway-mapping"
import { PrismaService } from "../prisma/prisma.service"
import { RPA_MODEL_LABELS } from "../rpa-creation/rpa-creation.capabilities"
import { AuditPrismaService } from "../usage/audit-prisma.service"
import { GenerationFunction } from "../usage/dto/query-generation-records.dto"
import { GenerationRecord, GenerationRecordService } from "../usage/generation-record.service"
import { TextGenerationRecordService } from "../usage/text-generation-record.service"
import { projectAsinGenerationEvents } from "./asin-generation-events"
import { projectListingGenerationRecords } from "./listing-generation-snapshot"
import { projectRpaGenerationEvents } from "./rpa-generation-events"

export type RecordClient = Prisma.TransactionClient
export const GENERATION_SOURCES = {
  generationTask: "IMAGE",
  imageGenJob: "IMAGE",
  videoTask: "VIDEO",
  storyboardVideo: "VIDEO",
  beautyTask: "VIDEO",
  rpaCreationTask: "IMAGE",
  inspirationSubscription: "INSPIRATION_RADAR",
  asinEvidenceRecord: "ASIN_EVIDENCE",
  asinAuditRecord: "ASIN_AUDIT",
  competitorAnalysisRecord: "COMPETITOR_ANALYSIS",
  history: "LISTING_GENERATION",
  businessAiRun: "LISTING_SCORING",
  categoryAnalysisRecord: "CATEGORY_ANALYSIS",
  selectionAnalysisRecord: "PRODUCT_SELECTION",
  smartPricingRecord: "SMART_PRICING",
  promotionPlanRecord: "PROMOTION_PLAN",
  videoAnalysisRecord: "VIDEO_ANALYSIS",
  chetaidouTask: "CHETAIDOU_TEXT",
} as const
export type GenerationSource = keyof typeof GENERATION_SOURCES
const TEXT_MODELS = new Set([
  "history",
  "businessAiRun",
  "categoryAnalysisRecord",
  "selectionAnalysisRecord",
  "smartPricingRecord",
  "promotionPlanRecord",
  "videoAnalysisRecord",
  "asinEvidenceRecord",
  "asinAuditRecord",
  "competitorAnalysisRecord",
  "chetaidouTask",
  "chetaidouCall",
])
const MEDIA_MODELS = new Set([
  "generationTask",
  "imageGenJob",
  "videoTask",
  "storyboardVideo",
  "beautyTask",
  "rpaCreationTask",
  "inspirationSubscription",
])
const SUCCESS = new Set(["SUCCESS", "COMPLETED", "SUCCEEDED", "SCORED", "OPTIMIZED"])
const MIN_DATE = "1970-01-01T00:00:00.000Z"
const MAX_DATE = "9999-12-31T23:59:59.999Z"

type SourceRow = Record<string, any>

/** 列表兼容身份；operation 只在 ASIN key 中出现，其余沿旧 key。 */
export function generationIdentity(row: Pick<GenerationRecord, "key" | "operation" | "function">) {
  const separator = row.key.indexOf(":")
  const sourceType = row.key.slice(0, separator)
  let sourceId = row.key.slice(separator + 1)
  const operation = row.operation ?? ""
  if (row.function === "ASIN_AUDIT") sourceId = sourceId.slice(0, -(operation.length + 1))
  return { sourceType, sourceId, operation }
}

// 单实体投影只允许明确引用的台账，历史近邻匹配缺少完整双向上下文时保持未知。
function withoutTimeFallback(value: any): any {
  if (!value || typeof value !== "object" || value instanceof Date) return value
  if (Array.isArray(value)) return value.map(withoutTimeFallback).filter(Boolean)
  const result = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "createdAt")
      .map(([key, child]) => [key, withoutTimeFallback(child)])
  )
  return Object.keys(result).length ? result : undefined
}

/** 复用既有来源映射和严格费用匹配，但根查询在 SQL 中限制为一个实体/拆图组。 */
export async function projectGenerationSource(
  tx: RecordClient,
  source: GenerationSource,
  root: SourceRow,
  options?: { requireSettlement?: boolean }
) {
  if (!eligibleGenerationSource(source, root)) return []
  if (source === "asinAuditRecord")
    return projectAsinGenerationEvents(
      tx,
      root as Parameters<typeof projectAsinGenerationEvents>[1]
    )
  if (source === "history") return projectListingGenerationRecords(tx, root as any)
  if (source === "rpaCreationTask")
    return projectRpaGenerationEvents(tx, root as Parameters<typeof projectRpaGenerationEvents>[1])
  if (source === "chetaidouTask" && root.rootTaskId && root.rootTaskId !== root.id) return []
  if (source === "competitorAnalysisRecord" && root.clientRequestId) {
    const pending = await tx.businessAiRun.findFirst({
      where: {
        userId: root.userId,
        module: "competitor-analysis",
        runId: root.clientRequestId,
        status: { in: ["RUNNING", "READY"] },
      },
      select: { id: true },
    })
    if (pending) return []
  }
  let fn: GenerationFunction = GENERATION_SOURCES[source]
  if (source === "businessAiRun") {
    if (!["listing-score", "competitor-analysis"].includes(root.module)) return []
    fn = root.module === "listing-score" ? "LISTING_SCORING" : "COMPETITOR_ANALYSIS"
  }
  if (!(fn && (TEXT_MODELS.has(source) || MEDIA_MODELS.has(source)))) return []
  const taskIds =
    source === "generationTask" && root.groupId
      ? (
          await tx.generationTask.findMany({
            where: { groupId: root.groupId, userId: root.userId },
            select: { id: true },
          })
        ).map(row => row.id)
      : [root.id]
  const mediaReferences: Prisma.UsageLogWhereInput[] =
    source === "imageGenJob" || root.sourceJobId
      ? [{ meta: { path: "$.jobId", equals: root.sourceJobId ?? root.id } }]
      : taskIds.map(id => ({ meta: { path: "$.taskId", equals: id } }))
  if (source === "generationTask" && root.groupId)
    mediaReferences.push({ meta: { path: "$.groupId", equals: root.groupId } })
  const delegate = tx as any
  const allowed = new Map<string, any>([[source, { id: root.id }]])
  if (source === "generationTask" && root.generationMode === "AI_SPLIT" && root.groupId)
    allowed.set(source, { groupId: root.groupId, userId: root.userId })
  if (source === "chetaidouTask") {
    const attempts = await tx.chetaidouTask.findMany({
      where: { rootTaskId: root.id, ownerId: root.ownerId },
      select: { id: true },
    })
    allowed.set("chetaidouCall", {
      taskId: { in: [...new Set([root.id, ...attempts.map(task => task.id)])] },
    })
  }
  if (source === "competitorAnalysisRecord")
    allowed.set("businessAiRun", {
      userId: root.userId,
      module: "competitor-analysis",
      runId: root.clientRequestId,
    })
  if (["smartPricingRecord", "promotionPlanRecord"].includes(source))
    allowed.set("businessAiRun", { userId: root.userId }) // existing helper further restricts exact run IDs
  if (source === "businessAiRun" && root.module === "competitor-analysis")
    allowed.set("competitorAnalysisRecord", { userId: root.userId, clientRequestId: root.runId })
  const scoped = new Proxy(delegate, {
    get(target, model: string) {
      if (model === "creditTransaction")
        return new Proxy(target[model], {
          get(logs, method: string) {
            if (method !== "findMany") return logs[method].bind(logs)
            return (args: any) =>
              source !== "inspirationSubscription" || !root.lastRefreshedAt
                ? Promise.resolve([])
                : logs.findMany({
                    ...args,
                    where: {
                      ...args.where,
                      type: { in: ["CONSUME", "TEAM_CONSUME"] },
                      AND: [
                        { meta: { path: "$.subscriptionId", equals: root.id } },
                        {
                          meta: {
                            path: "$.refreshedAt",
                            equals: root.lastRefreshedAt.toISOString(),
                          },
                        },
                      ],
                    },
                  })
          },
        })
      if (model === "usageLog")
        return new Proxy(target[model], {
          get(logs, method: string) {
            if (method !== "findMany") return logs[method].bind(logs)
            return (args: any) => {
              // Text initial range query is deliberately empty; relatedLogWhere supplies exact refs.
              if (TEXT_MODELS.has(source) && !args.where?.OR) return Promise.resolve([])
              const where = withoutTimeFallback(args.where)
              if (!where || (Array.isArray(where.OR) && !where.OR.length))
                return Promise.resolve([])
              return logs.findMany({
                ...args,
                where: TEXT_MODELS.has(source) ? where : { AND: [where, { OR: mediaReferences }] },
              })
            }
          },
        })
      if (!TEXT_MODELS.has(model) && !MEDIA_MODELS.has(model)) return target[model]
      return new Proxy(target[model], {
        get(entity, method: string) {
          if (!["findMany", "count", "groupBy"].includes(method)) return entity[method].bind(entity)
          return (args: any) => {
            const restriction = allowed.get(model)
            if (!restriction) return Promise.resolve(method === "count" ? 0 : [])
            const select = args.select ? { ...args.select } : undefined
            for (const child of ["generatedImages", "outputs"]) {
              if (select?.[child])
                select[child] = {
                  ...select[child],
                  where: { ...select[child].where, deletedAt: null },
                }
            }
            const result = entity[method]({
              ...args,
              ...(select ? { select } : {}),
              where: { AND: [args.where ?? {}, restriction] },
            })
            return model === "chetaidouCall" && source === "chetaidouTask"
              ? result.then((calls: any[]) => calls.map(call => ({ ...call, taskId: root.id })))
              : result
          }
        },
      })
    },
  }) as AuditPrismaService
  const text = new TextGenerationRecordService(scoped)
  const legacy = new GenerationRecordService(scoped as unknown as PrismaService, scoped, text)
  const result = await legacy.list(
    { function: fn, page: 1, pageSize: 10000, dateFrom: MIN_DATE, dateTo: MAX_DATE },
    true
  )
  let rows = result.items
    .filter(row => SUCCESS.has(row.status))
    .map(row => ({ ...row, createdAt: new Date(row.createdAt) }))
  if (source === "generationTask" && root.generationMode === "STANDARD") {
    const count = await tx.generatedImage.count({
      where: {
        taskId: root.id,
        source: "platform",
        status: "SUCCESS",
        deletedAt: null,
        url: { not: null },
      },
    })
    rows = rows.map(row => ({ ...row, resultCount: count }))
  }
  if (
    source === "chetaidouTask" ||
    (source === "imageGenJob" && root.businessType === "CHETAIDOU")
  ) {
    const imageItems =
      source === "imageGenJob"
        ? await tx.imageGenItem.findMany({ where: { jobId: root.id }, select: { id: true } })
        : []
    const calls = await tx.chetaidouCall.findMany({
      where:
        source === "chetaidouTask"
          ? { rootTaskId: root.id, kind: "TEXT" }
          : { imageGenItemId: { in: imageItems.map(item => item.id) }, kind: "IMAGE" },
      select: { billingStatus: true, chargedCredits: true },
    })
    const complete =
      calls.length > 0 &&
      calls.every(
        call =>
          call.billingStatus === "FREE" ||
          (call.billingStatus === "SETTLED" && call.chargedCredits != null)
      )
    const credits = complete
      ? calls
          .reduce(
            (sum, call) => sum.plus(call.billingStatus === "FREE" ? 0 : call.chargedCredits!),
            new Prisma.Decimal(0)
          )
          .toString()
      : null
    rows = rows.map(row => ({ ...row, credits }))
  }
  if (source === "chetaidouTask" && root.finishedAt)
    rows = rows.map(row => ({ ...row, createdAt: root.finishedAt }))
  if (source === "inspirationSubscription")
    rows = rows.map(row => ({
      ...row,
      key: `INSPIRATION_RADAR:${root.id}:refresh:${root.lastRefreshedAt.getTime()}`,
    }))
  const settlement = await mediaSettlement(tx, source, root)
  if (options?.requireSettlement && settlement && !settlement.complete) return []
  if (settlement)
    rows = rows.map(row => ({
      ...row,
      credits:
        !settlement.complete || settlement.unknown ? null : settlement.free ? "0" : row.credits,
    }))
  return rows
}

export function eligibleGenerationSource(source: GenerationSource, root: SourceRow): boolean {
  const hasStatus = [
    "generationTask",
    "imageGenJob",
    "videoTask",
    "storyboardVideo",
    "beautyTask",
    "businessAiRun",
    "categoryAnalysisRecord",
    "selectionAnalysisRecord",
    "chetaidouTask",
  ].includes(source)
  if (
    hasStatus &&
    !(source === "generationTask" && root.generationMode === "AI_SPLIT") &&
    !SUCCESS.has(root.status) &&
    !(source === "imageGenJob" && root.businessType === "CHETAIDOU" && root.status === "PARTIAL")
  )
    return false
  if (
    source === "chetaidouTask" &&
    !["BREAKDOWN", "IDEATION", "REFRESH_GROUP", "DIVERGE", "COMPOSE"].includes(root.type)
  )
    return false
  if (source === "history" && !["LISTING_GENERATION", "LISTING_SCORING"].includes(root.type))
    return false
  if (source === "businessAiRun" && !root.outputText?.trim()) return false
  return true
}

export async function lockGenerationSource(
  tx: RecordClient,
  source: GenerationSource,
  id: string | number
) {
  // 拆图所有成员/子项修改与回填先拿同一组最小任务行，避免并发末席位各自读到旧状态。
  if (source === "generationTask") {
    const task = await tx.generationTask.findUnique({
      where: { id: Number(id) },
      select: { groupId: true },
    })
    if (task?.groupId)
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM GenerationTask WHERE groupId = ${task.groupId} ORDER BY id ASC LIMIT 1 FOR UPDATE`
      )
  }
  const table = source[0].toUpperCase() + source.slice(1)
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM ${Prisma.raw("`" + table + "`")} WHERE id = ${id} FOR UPDATE`
  )
  return (tx as any)[source].findUnique({ where: { id } }) as Promise<SourceRow | null>
}

async function mediaSettlement(tx: RecordClient, source: GenerationSource, root: SourceRow) {
  const pipelineJob = source === "imageGenJob" && root.businessType === "IMAGE_CREATIVE"
  const pipelineTask = source === "generationTask" && root.executionSpec?.provider
  if (!pipelineJob && !pipelineTask) return null
  const children = pipelineJob
    ? await tx.imageGenItem.findMany({
        where: { jobId: root.id, status: "SUCCEEDED", deletedAt: null },
        select: { providerJobId: true, gatewayImage: true },
      })
    : await tx.generatedImage.findMany({
        where: { taskId: root.id, status: "SUCCESS", deletedAt: null },
        select: { providerJobId: true, deliveryMeta: true },
      })
  const logs = await tx.usageLog.findMany({
    where: {
      userId: root.userId,
      source: { startsWith: "aicreative.image_generate" },
      meta: { path: pipelineJob ? "$.jobId" : "$.taskId", equals: root.id },
    },
    select: { meta: true, credits: true },
  })
  const gateways = new Set(
    logs
      .filter(log => log.credits != null)
      .flatMap(log => {
        const meta = log.meta as { gatewayTaskId?: unknown } | null
        return typeof meta?.gatewayTaskId === "string" && meta.gatewayTaskId
          ? [meta.gatewayTaskId]
          : []
      })
  )
  const evidence = children.map(child => {
    const data = ("gatewayImage" in child ? child.gatewayImage : child.deliveryMeta) as {
      generationRecordCredits?: unknown
    } | null
    return data?.generationRecordCredits
  })
  const hasLog = (child: (typeof children)[number]) =>
    Boolean(child.providerJobId && gateways.has(child.providerJobId))
  const complete =
    children.length > 0 &&
    children.every(
      (child, index) =>
        evidence[index] === null ||
        (typeof evidence[index] === "string" && /^\d+(?:\.\d+)?$/.test(evidence[index])) ||
        hasLog(child)
    )
  const unknown = children.some((child, index) => evidence[index] === null && !hasLog(child))
  return {
    complete,
    unknown,
    free:
      complete && evidence.every(value => value === "0") && !logs.some(log => log.credits?.gt(0)),
  }
}

export type SuccessfulGenerationSnapshot = {
  sourceType: string
  sourceId: string
  operation?: string
  function: string
  userId: number
  prompt: string
  modelPublicId?: string | null
  credits?: string | Prisma.Decimal | null
  resultUrl?: string | null
  resultCount?: number | null
  occurredAt: Date
}

/** 同一成功业务事件重放只返回首份快照，不改变先前的提示词、模型、费用或时间。 */
export async function saveGenerationSnapshot(
  tx: RecordClient,
  input: SuccessfulGenerationSnapshot
) {
  const { sourceType, sourceId, operation = "", modelPublicId = null, ...rest } = input
  const gateway = modelPublicId
    ? await tx.aiGatewayModel.findFirst({
        where: { publicId: modelPublicId },
        select: { publicId: true, displayName: true },
        orderBy: { id: "asc" },
      })
    : null
  const directory =
    gateway ??
    (input.sourceType.startsWith("RPA_") && modelPublicId && RPA_MODEL_LABELS[modelPublicId]
      ? { publicId: modelPublicId, displayName: RPA_MODEL_LABELS[modelPublicId] }
      : null)
  const identity = { sourceType, sourceId, operation }
  return tx.generationRecord.upsert({
    where: { sourceType_sourceId_operation: identity },
    create: {
      ...identity,
      ...rest,
      modelPublicId: directory?.publicId ?? null,
      modelDisplayName: directory?.displayName ?? null,
      credits: input.credits == null ? null : new Prisma.Decimal(input.credits),
      resultUrl: input.resultUrl ?? null,
      resultCount: input.resultCount ?? null,
      deletedAt: null,
    },
    update: {},
  })
}

/** 必须在源实体锁内重读，在线与回填使用完全相同的映射。 */
export async function syncGenerationSource(
  tx: RecordClient,
  source: GenerationSource,
  id: string | number,
  range?: {
    from?: Date
    to?: Date
    credits?: Prisma.Decimal | string | number
    requireSettlement?: boolean
    modelPublicId?: string
  }
) {
  const root = await lockGenerationSource(tx, source, id)
  if (!root)
    return {
      written: 0,
      unknownCredits: 0,
      snapshots: [] as Array<{ key: string; credits: string | null }>,
    }
  if (!eligibleGenerationSource(source, root)) {
    return {
      written: 0,
      unknownCredits: 0,
      snapshots: [] as Array<{ key: string; credits: string | null }>,
    }
  }
  if (
    source === "generationTask" &&
    root.sourceJobId &&
    (await tx.generationRecord.findFirst({
      where: { sourceType: "IMAGEGEN", sourceId: root.sourceJobId },
    }))
  )
    return {
      written: 0,
      unknownCredits: 0,
      snapshots: [] as Array<{ key: string; credits: string | null }>,
    }
  if (source === "competitorAnalysisRecord" && root.clientRequestId) {
    const run = await tx.businessAiRun.findFirst({
      where: { userId: root.userId, module: "competitor-analysis", runId: root.clientRequestId },
      select: { id: true },
    })
    if (
      run &&
      (await tx.generationRecord.findFirst({
        where: { sourceType: "TEXT_RUN", sourceId: `competitor-analysis:${run.id}` },
      }))
    )
      return {
        written: 0,
        unknownCredits: 0,
        snapshots: [] as Array<{ key: string; credits: string | null }>,
      }
  }
  const rows = (await projectGenerationSource(tx, source, root, range)).filter(
    row =>
      !range ||
      ((!range.from || row.createdAt >= range.from) && (!range.to || row.createdAt <= range.to))
  )
  let unknownCredits = 0
  const snapshots: Array<{ key: string; credits: string | null }> = []
  for (const row of rows) {
    const identity = generationIdentity(row)
    const candidateModel =
      range?.modelPublicId || row.actualModel || (row.model !== "fixed-module" ? row.model : null)
    const model =
      candidateModel && row.function === "IMAGE"
        ? resolveGatewayModel(candidateModel)
        : candidateModel
    const frozen = await saveGenerationSnapshot(tx, {
      ...identity,
      userId: row.userId,
      function: row.function,
      prompt: row.prompt,
      modelPublicId: model,
      credits: range?.credits != null ? new Prisma.Decimal(range.credits) : row.credits,
      resultUrl: row.resultUrl,
      resultCount: row.resultCount ?? (row.resultUrl ? 1 : null),
      occurredAt: row.createdAt,
    })
    if (frozen.credits == null) unknownCredits++
    snapshots.push({ key: row.key, credits: frozen.credits?.toString() ?? null })
  }
  return { written: rows.length, unknownCredits, snapshots }
}
