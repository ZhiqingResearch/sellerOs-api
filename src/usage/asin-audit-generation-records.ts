import { Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { generationUserInput } from "../generation-record/generation-user-input"
import type { AuditPrismaService } from "./audit-prisma.service"

export const ASIN_AUDIT_STAGE_SELECT = {
  id: true,
  userId: true,
  asin: true,
  productTitle: true,
  clientRequestId: true,
  createdAt: true,
  deletedAt: true,
  scoreSnapshot: { select: { createdAt: true } },
  optimizationRevisions: {
    orderBy: { revision: "asc" },
    select: { revision: true, createdAt: true },
  },
} satisfies Prisma.AsinAuditRecordSelect

type AuditRecord = Prisma.AsinAuditRecordGetPayload<{ select: typeof ASIN_AUDIT_STAGE_SELECT }>
export type AuditStage = "score" | "optimize"
type AsinStage = AuditStage | "evidence"
export type AsinGenerationIdentity = {
  recordId: string
  clientRequestId: string
  operation: AsinStage
  events: Date[]
}
export type AuditUsageLog = {
  id: number
  userId: number
  source: string | null
  requestId: string | null
  meta: Prisma.JsonValue | null
  createdAt: Date
}

export function asinUsageFunction(log: Pick<AuditUsageLog, "source" | "meta" | "requestId">) {
  const meta = auditUsageMeta(log)
  if (
    log.source === "asin.audit.evidence" ||
    (log.source === "asin.audit" &&
      (meta.stage === "evidence" ||
        meta.scene === "evidence-module" ||
        /^charge:asin-audit:evidence:/.test(log.requestId ?? "")))
  )
    return "ASIN_EVIDENCE" as const
  return log.source === "asin.audit" ? ("ASIN_AUDIT" as const) : undefined
}

export function auditUsageStage(log: AuditUsageLog): AsinStage | undefined {
  if (asinUsageFunction(log) === "ASIN_EVIDENCE") return "evidence"
  const meta = auditUsageMeta(log)
  const stage = meta.stage ?? meta.action
  if (stage === "score" || stage === "optimize") return stage
  return /^charge:asin-audit:(score|optimize):/.exec(log.requestId ?? "")?.[1] as
    | AuditStage
    | undefined
}

export function auditUsageMeta(log: Pick<AuditUsageLog, "meta">): Prisma.JsonObject {
  return log.meta && typeof log.meta === "object" && !Array.isArray(log.meta) ? log.meta : {}
}

export function asinAuditStageRecords(records: AuditRecord[]) {
  return records.flatMap(record => {
    const revisions = record.optimizationRevisions
    return (["score", ...(revisions.length ? ["optimize"] : [])] as AuditStage[]).map(operation => {
      const events =
        operation === "score"
          ? [record.scoreSnapshot?.createdAt ?? record.createdAt]
          : revisions.map(revision => revision.createdAt)
      return {
        key: `TEXT:ASIN_AUDIT:${record.id}:${operation}`,
        id: `${record.id}:${operation}`,
        recordId: record.id,
        function: "ASIN_AUDIT" as const,
        userId: record.userId,
        operation,
        prompt: generationUserInput("asinAuditRecord", record),
        status: operation === "score" ? "SCORED" : "OPTIMIZED",
        resultLabel: operation === "score" ? "审计打分" : "审计优化",
        createdAt: events[events.length - 1],
        deletedAt: record.deletedAt,
        audit: { recordId: record.id, clientRequestId: record.clientRequestId, operation, events },
        links: [],
      }
    })
  })
}

export type AsinAuditStageRecord = ReturnType<typeof asinAuditStageRecords>[number]

export const ASIN_EVIDENCE_SELECT = {
  id: true,
  userId: true,
  asin: true,
  productTitle: true,
  model: true,
  clientRequestId: true,
  createdAt: true,
  deletedAt: true,
} satisfies Prisma.AsinEvidenceRecordSelect

export function asinEvidenceGenerationRecords(
  records: Prisma.AsinEvidenceRecordGetPayload<{ select: typeof ASIN_EVIDENCE_SELECT }>[]
) {
  return records.map(record => ({
    ...record,
    recordId: record.id,
    key: `TEXT:ASIN_EVIDENCE:${record.id}`,
    function: "ASIN_EVIDENCE" as const,
    operation: "evidence" as const,
    status: "SUCCESS",
    prompt: generationUserInput("asinEvidenceRecord", record),
    audit: {
      recordId: record.id,
      clientRequestId: record.clientRequestId,
      operation: "evidence" as const,
      events: [record.createdAt],
    },
    links: [],
  }))
}

/** 同用户、同阶段优先匹配明确 ID；旧数据仅接受扣费后 10 秒内的双向唯一保存事件。 */
export function linkAsinAuditUsage<T extends { userId: number; audit?: AsinGenerationIdentity }>(
  candidates: T[],
  logs: AuditUsageLog[]
) {
  const stages = candidates.filter(candidate => candidate.audit)
  const matches = new Map<number, T>()
  const legacy: AuditUsageLog[] = []
  for (const log of logs) {
    if (!asinUsageFunction(log)) continue
    const operation = auditUsageStage(log)
    if (!operation) continue
    const meta = auditUsageMeta(log)
    const scoped = stages.filter(
      row => row.userId === log.userId && row.audit!.operation === operation
    )
    const exact = scoped.filter(row =>
      typeof meta.recordId === "string"
        ? row.audit!.recordId === meta.recordId
        : typeof meta.clientRequestId === "string" &&
          row.audit!.clientRequestId === meta.clientRequestId
    )
    if (exact.length === 1) matches.set(log.id, exact[0])
    // 新流水包含结果指纹；保存时尚未建立明确关联的结果不能再凭时间挂到其他报告。
    else if (!exact.length && !meta.recordId && !meta.resultHash) legacy.push(log)
  }

  const events = stages.flatMap(row => row.audit!.events.map(time => ({ row, time })))
  const consumers = new Map<(typeof events)[number], AuditUsageLog[]>()
  const edges = new Map<number, typeof events>()
  for (const log of logs) {
    if (!asinUsageFunction(log)) continue
    const operation = auditUsageStage(log)
    const compatible = events.filter(event => {
      const delay = event.time.getTime() - log.createdAt.getTime()
      return (
        event.row.userId === log.userId &&
        event.row.audit!.operation === operation &&
        delay >= 0 &&
        delay <= 10_000
      )
    })
    edges.set(log.id, compatible)
    for (const event of compatible) consumers.set(event, [...(consumers.get(event) ?? []), log])
  }
  for (const log of legacy) {
    const compatible = edges.get(log.id) ?? []
    if (compatible.length === 1 && consumers.get(compatible[0])?.length === 1) {
      matches.set(log.id, compatible[0].row)
    }
  }
  return matches
}

export async function asinAuditUsageContext(
  audit: AuditPrismaService,
  userId: number,
  fn: "ASIN_AUDIT" | "ASIN_EVIDENCE" = "ASIN_AUDIT"
) {
  const [records, logs] = await Promise.all([
    fn === "ASIN_AUDIT"
      ? audit.asinAuditRecord
          .findMany({ where: { userId }, select: ASIN_AUDIT_STAGE_SELECT })
          .then(asinAuditStageRecords)
      : audit.asinEvidenceRecord
          .findMany({ where: { userId }, select: ASIN_EVIDENCE_SELECT })
          .then(asinEvidenceGenerationRecords),
    audit.usageLog.findMany({
      where: {
        userId,
        source: {
          in: fn === "ASIN_EVIDENCE" ? ["asin.audit.evidence", "asin.audit"] : ["asin.audit"],
        },
      },
      select: {
        id: true,
        userId: true,
        source: true,
        requestId: true,
        meta: true,
        createdAt: true,
        credits: true,
      },
    }),
  ])
  const scopedLogs = logs.filter(log => asinUsageFunction(log) === fn)
  return {
    stages: records,
    logs: scopedLogs,
    matches: linkAsinAuditUsage<
      AsinAuditStageRecord | ReturnType<typeof asinEvidenceGenerationRecords>[number]
    >(records, scopedLogs),
  }
}

export function asinUsageSummary(
  context: Awaited<ReturnType<typeof asinAuditUsageContext>>,
  recordId: string,
  operation: AsinStage
) {
  const logs = context.logs.filter(log => {
    const linked = context.matches.get(log.id)
    return linked?.recordId === recordId && linked.operation === operation
  })
  const amounts = logs.flatMap(log => (log.credits == null ? [] : [log.credits]))
  const models = [
    ...new Set(
      logs.flatMap(log => {
        const model = auditUsageMeta(log).model
        return typeof model === "string" && model ? [model] : []
      })
    ),
  ]
  return {
    credits: amounts.length
      ? amounts.reduce((sum, value) => sum.plus(value), new Decimal(0)).toString()
      : null,
    models,
  }
}
