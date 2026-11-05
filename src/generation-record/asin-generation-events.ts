import { Prisma } from "@prisma/client"
import { hashJson } from "../common/utils/canonical-json"
import { auditUsageStage } from "../usage/asin-audit-generation-records"
import type { GenerationRecord } from "../usage/generation-record.service"
import type { RecordClient } from "./generation-record-sync"

/** 一个成功保存的评分/优化版本是一笔业务事件；正文、积分绝不跟随后续版本覆盖。 */
export async function projectAsinGenerationEvents(
  tx: RecordClient,
  root: Prisma.AsinAuditRecordGetPayload<Record<string, never>>
): Promise<GenerationRecord[]> {
  const [snapshot, revisions, user] = await Promise.all([
    tx.asinAuditScoreSnapshot.findUnique({ where: { recordId: root.id } }),
    tx.asinAuditOptimizationRevision.findMany({
      where: { recordId: root.id },
      orderBy: { revision: "asc" },
    }),
    tx.user.findUnique({
      where: { id: root.userId },
      select: {
        id: true,
        username: true,
        phone: true,
        orgs: { select: { org: { select: { name: true } } } },
        roles: { select: { role: { select: { name: true, color: true } } } },
      },
    }),
  ])
  if (!user) return []
  const events = [
    ...(snapshot
      ? [
          {
            operation: "score" as const,
            id: root.id,
            createdAt: snapshot.createdAt,
            hash: hashJson(snapshot.scoreResult),
          },
        ]
      : []),
    ...revisions.map(revision => ({
      operation: "optimize" as const,
      id: revision.id,
      createdAt: revision.createdAt,
      hash: hashJson(revision.optimizationResult),
    })),
  ]
  if (!events.length) return []
  const logs = await tx.usageLog.findMany({
    where: {
      userId: root.userId,
      source: "asin.audit",
      OR: [
        { meta: { path: "$.recordId", equals: root.id } },
        { meta: { path: "$.clientRequestId", equals: root.clientRequestId } },
        ...events.map(event => ({ meta: { path: "$.resultHash", equals: event.hash } })),
        ...events.map(event => ({
          createdAt: { gte: new Date(event.createdAt.getTime() - 10000), lte: event.createdAt },
        })),
      ],
    },
    select: {
      id: true,
      userId: true,
      source: true,
      requestId: true,
      meta: true,
      credits: true,
      createdAt: true,
    },
    orderBy: { id: "asc" },
  })
  const assigned = new Map<(typeof events)[number], typeof logs>()
  const weak = new Map<(typeof events)[number], typeof logs>()
  for (const log of logs) {
    const meta =
      log.meta && typeof log.meta === "object" && !Array.isArray(log.meta) ? log.meta : {}
    const stage = auditUsageStage(log)
    if (stage !== "score" && stage !== "optimize") continue
    if (typeof meta.recordId === "string" && meta.recordId !== root.id) continue
    const sameStage = events.filter(event => event.operation === stage)
    const exact = sameStage.filter(event => {
      if (typeof meta.revisionId === "number")
        return stage === "optimize" && meta.revisionId === event.id
      if (typeof meta.resultHash === "string") return meta.resultHash === event.hash
      if (stage === "score")
        return meta.recordId === root.id || meta.clientRequestId === root.clientRequestId
      return meta.recordId === root.id && sameStage.length === 1
    })
    if (exact.length === 1) {
      assigned.set(exact[0], [...(assigned.get(exact[0]) ?? []), log])
      continue
    }
    if (
      meta.revisionId ||
      (meta.resultHash && exact.length === 0) ||
      (!meta.resultHash && (meta.recordId || meta.clientRequestId))
    )
      continue
    const candidates = sameStage.filter(
      event =>
        event.createdAt >= log.createdAt &&
        event.createdAt.getTime() - log.createdAt.getTime() <= 10000
    )
    if (candidates.length !== 1) continue
    // 近邻只在全用户同阶段的保存窗口内双向唯一时使用，不把单报告局部唯一当全局唯一。
    const others =
      stage === "score"
        ? await tx.asinAuditScoreSnapshot.findMany({
            where: {
              record: { userId: root.userId },
              createdAt: { gte: log.createdAt, lte: new Date(log.createdAt.getTime() + 10000) },
            },
            select: { recordId: true },
          })
        : await tx.asinAuditOptimizationRevision.findMany({
            where: {
              record: { userId: root.userId },
              createdAt: { gte: log.createdAt, lte: new Date(log.createdAt.getTime() + 10000) },
            },
            select: { id: true },
          })
    if (others.length === 1) weak.set(candidates[0], [...(weak.get(candidates[0]) ?? []), log])
  }
  return events.flatMap(event => {
    const matched = assigned.get(event) ?? (weak.get(event)?.length === 1 ? weak.get(event)! : [])
    const operations =
      event.operation === "optimize" && matched.length > 1 ? matched.map(log => [log]) : [matched]
    return operations.map((operationLogs, index) => {
      const amounts = operationLogs.flatMap(log => (log.credits == null ? [] : [log.credits]))
      const meta = operationLogs.at(-1)?.meta as { model?: unknown } | null
      const model =
        typeof meta?.model === "string" && meta.model !== "fixed-module" ? meta.model : ""
      const extraEvent =
        event.operation === "optimize" &&
        operationLogs[0] &&
        (index > 0 || operationLogs[0].createdAt > event.createdAt)
      const id =
        event.operation === "score"
          ? `${root.id}:score`
          : `${root.id}:revision:${event.id}${extraEvent ? `:event:${operationLogs[0].id}` : ""}:optimize`
      return {
        key: `TEXT:ASIN_AUDIT:${id}`,
        id,
        recordId: root.id,
        operation: event.operation,
        function: "ASIN_AUDIT" as const,
        contentType: "TEXT" as const,
        userId: user.id,
        username: user.username,
        phone: user.phone,
        orgs: user.orgs.map(row => row.org.name),
        roles: user.roles.map(row => row.role),
        prompt: `${root.asin} ${root.productTitle}`,
        model,
        modelLabel: model,
        credits: amounts.length
          ? amounts.reduce((sum, amount) => sum.plus(amount), new Prisma.Decimal(0)).toString()
          : null,
        status: event.operation === "score" ? "SCORED" : "OPTIMIZED",
        createdAt: extraEvent ? operationLogs[0].createdAt : event.createdAt,
        resultUrl: null,
        deleted: false,
        expired: false,
      }
    })
  })
}
