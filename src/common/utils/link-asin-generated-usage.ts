import { Prisma } from "@prisma/client"
import { hashJson, isJsonObject } from "./canonical-json"

/** 用生成结果指纹/生成请求号归属流水，金额和扣费幂等键保持原样。 */
export async function linkAsinGeneratedUsage(
  tx: Prisma.TransactionClient,
  userId: number,
  recordId: string,
  stage: "score" | "optimize" | "evidence",
  result: Prisma.InputJsonValue,
  generationRequestId?: string,
  revisionId?: number
) {
  const logs = await tx.usageLog.findMany({
    where: {
      userId,
      source: stage === "evidence" ? "asin.audit.evidence" : "asin.audit",
      AND: [
        {
          OR: [
            { meta: { path: "$.resultHash", equals: hashJson(result) } },
            ...(generationRequestId
              ? [{ meta: { path: "$.clientRequestId", equals: generationRequestId } }]
              : []),
          ],
        },
        ...(stage === "evidence"
          ? []
          : [
              {
                OR: [
                  { meta: { path: "$.stage", equals: stage } },
                  { meta: { path: "$.action", equals: stage } },
                ],
              },
            ]),
      ],
    },
    select: { id: true, meta: true },
  })
  const unlinked = logs.filter(log => isJsonObject(log.meta) && !log.meta.recordId)
  if (unlinked.length !== 1) return
  const log = unlinked[0]
  // CAS 防止并发保存把同一笔积分挂到两份报告。
  await tx.usageLog.updateMany({
    where: { id: log.id, meta: { equals: log.meta as Prisma.InputJsonObject } },
    data: { meta: { ...(log.meta as Prisma.JsonObject), recordId, ...(revisionId != null ? { revisionId } : {}) } },
  })
}
