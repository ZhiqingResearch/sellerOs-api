import { Prisma } from "@prisma/client"
import type { PrismaService } from "../prisma/prisma.service"

/** 只读已有流水；同一任务的多图、多次调用累加，不依赖扣费幂等键格式。 */
export async function readImageUsage(
  prisma: Pick<PrismaService, "usageLog">,
  userId: number,
  reference: { taskId?: number; jobId?: string | null; gatewayTaskId?: string | null }
) {
  const links: Prisma.UsageLogWhereInput[] = []
  if (reference.taskId != null) {
    links.push(
      { meta: { path: "$.taskId", equals: reference.taskId } },
      { meta: { path: "$.taskId", equals: String(reference.taskId) } }
    )
  }
  if (reference.jobId) links.push({ meta: { path: "$.jobId", equals: reference.jobId } })
  if (reference.gatewayTaskId) {
    links.push(
      { requestId: `gateway:${reference.gatewayTaskId}` },
      { requestId: { startsWith: `gateway:${reference.gatewayTaskId}:` } }
    )
  }
  if (!links.length) return { costCny: null, creditsCharged: null }
  const totals = await prisma.usageLog.aggregate({
    where: {
      userId,
      AND: [
        {
          OR: [
            { source: { startsWith: "aicreative.image_generate" } },
            { source: "aicreative.ai_split" },
          ],
        },
        { OR: links },
      ],
    },
    _sum: { cost: true, credits: true },
  })
  return {
    costCny: totals._sum.cost?.toString() ?? null,
    creditsCharged: totals._sum.credits?.toString() ?? null,
  }
}
