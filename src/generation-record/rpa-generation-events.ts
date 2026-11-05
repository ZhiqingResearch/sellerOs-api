import { Prisma } from "@prisma/client"
import type { GenerationRecord } from "../usage/generation-record.service"
import type { RecordClient } from "./generation-record-sync"

/** 同一任务的失败重试可以再次成功；明确输出批次绑定真实扣费，不覆盖先前成功批次。 */
export async function projectRpaGenerationEvents(
  tx: RecordClient,
  root: Prisma.RpaCreationTaskGetPayload<Record<string, never>>
): Promise<GenerationRecord[]> {
  if (root.mediaType !== "IMAGE" && root.mediaType !== "VIDEO") return []
  const [outputs, logs, user] = await Promise.all([
    tx.rpaCreationOutput.findMany({
      where: { taskId: root.id, status: "SUCCESS", url: { not: null } },
      orderBy: { order: "asc" },
    }),
    tx.usageLog.findMany({
      where: {
        userId: root.userId,
        source: "rpa-creation.generate",
        meta: { path: "$.taskId", equals: root.id },
      },
      select: { id: true, credits: true, meta: true, createdAt: true },
      orderBy: { id: "asc" },
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
  if (!outputs.length || !user) return []
  const events: GenerationRecord[] = []
  for (const log of logs) {
    const meta = log.meta as { successfulOutputIds?: unknown } | null
    if (!Array.isArray(meta?.successfulOutputIds) || !meta.successfulOutputIds.length) continue
    const ids = meta.successfulOutputIds.filter(
      (id): id is number => typeof id === "number" && Number.isSafeInteger(id)
    )
    const delivered = outputs.filter(output => ids.includes(output.id))
    if (!delivered.length) continue
    events.push({
      key: `RPA_${root.mediaType}:${root.id}:event:${log.id}`,
      id: root.id,
      function: root.mediaType,
      userId: user.id,
      username: user.username,
      phone: user.phone,
      orgs: user.orgs.map(row => row.org.name),
      roles: user.roles.map(row => row.role),
      prompt: root.prompt,
      model: root.model,
      modelLabel: root.model,
      credits: log.credits?.toString() ?? null,
      status: "SUCCESS",
      resultCount: delivered.length,
      resultUrl: delivered[0].url,
      createdAt: log.createdAt,
      deleted: false,
      expired: false,
    })
  }
  if (!events.length && root.status === "SUCCESS")
    events.push({
      key: `RPA_${root.mediaType}:${root.id}`,
      id: root.id,
      function: root.mediaType,
      userId: user.id,
      username: user.username,
      phone: user.phone,
      orgs: user.orgs.map(row => row.org.name),
      roles: user.roles.map(row => row.role),
      prompt: root.prompt,
      model: root.model,
      modelLabel: root.model,
      credits: logs.length === 1 ? (logs[0].credits?.toString() ?? null) : null,
      status: "SUCCESS",
      resultCount: outputs.length,
      resultUrl: outputs[0].url,
      createdAt: root.completedAt ?? root.createdAt,
      deleted: false,
      expired: false,
    })
  return events
}
