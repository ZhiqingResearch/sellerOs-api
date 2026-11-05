import type { AuditPrismaService } from "./audit-prisma.service"

export type ActualGenerationModels = { actualModel: string | null; actualModels: string[] }
const OPERATIONS = ["generate", "extract", "research"] as const

/** 只按同用户的稳定运行号关联；固定模块计费标记不能作为实际调用模型。 */
export async function businessGenerationModels(
  audit: AuditPrismaService,
  records: Array<{ id: string; userId: number; clientRequestId: string }>,
  module: "smart-pricing" | "promotion-plan"
) {
  const scoped = records.filter(record => record.clientRequestId)
  const result = new Map<string, ActualGenerationModels>()
  if (!scoped.length) return result
  const runs = await audit.businessAiRun.findMany({
    where: {
      module,
      status: "COMPLETED",
      userId: { in: [...new Set(scoped.map(record => record.userId))] },
      OR: [
        {
          runId: {
            in: scoped.flatMap(record => [
              record.clientRequestId,
              ...OPERATIONS.map(op => `${record.clientRequestId}-${op}`),
            ]),
          },
        },
        ...(module === "promotion-plan"
          ? scoped.map(record => ({
              runId: { startsWith: `${record.clientRequestId}-competitor-` },
            }))
          : []),
      ],
      operation: { in: [...OPERATIONS] },
    },
    select: { userId: true, runId: true, operation: true, model: true, billing: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  for (const record of scoped) {
    const matched = runs.filter(
      run =>
        run.userId === record.userId &&
        (run.runId === record.clientRequestId ||
          run.runId === `${record.clientRequestId}-${run.operation}` ||
          (module === "promotion-plan" &&
            run.operation === "extract" &&
            run.runId.startsWith(`${record.clientRequestId}-competitor-`) &&
            /^\d+$/.test(run.runId.slice(`${record.clientRequestId}-competitor-`.length))))
    )
    // 最终报告生成模型优先展示，其余已完成步骤的模型一并保留。
    matched.sort((a, b) => Number(b.operation === "generate") - Number(a.operation === "generate"))
    const actualModels = [
      ...new Set(
        matched.flatMap(run => {
          const snapshot = run.billing as { billing?: { model?: unknown } } | null
          const model =
            typeof snapshot?.billing?.model === "string" && snapshot.billing.model.trim()
              ? snapshot.billing.model
              : run.model
          return model && model !== "fixed-module" ? [model] : []
        })
      ),
    ]
    result.set(record.id, { actualModel: actualModels[0] ?? null, actualModels })
  }
  return result
}
