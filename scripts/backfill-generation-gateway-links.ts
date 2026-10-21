/**
 * 存量回填：通用生图管线（generate / t2i / i2i）的基座网关任务关联（2026-09-11，方案 Part C3）。
 * 数据源 = UsageLog（source 前缀 aicreative.image_generate、requestId 形如
 * charge:imggen:{owner}:{child}:{attempt}），回写三处：
 *   1. generate：meta.taskId 数字 → 聚合写 GenerationTask.gatewayTaskIds（读-合-写，
 *      恰好 1 个网关任务时同步补单值 gatewayTaskId）；meta.gatewayTaskId →
 *      GeneratedImage.providerJobId（仅空值补，不覆盖）。
 *   2. t2i/i2i：meta.jobId(UUID) → ImageGenItem.providerJobId（仅空值补；job 已被
 *      Cron 清理的行匹配 0 条，计入 skipped）。
 *   3. UsageLog.meta 缺 gatewayAmountCny 的用 cost 列补（对账口径与老 webhook 路径统一）。
 * 明确不回填：priceMultiplier（credits 含个人/企业折扣，无法从流水反推）；
 * gatewayEventId（从未持久化，无源可回）。
 * 幂等：全部空值守卫/按 gatewayTaskId 去重，重复执行无副作用。用法：
 *   npx tsx scripts/backfill-generation-gateway-links.ts --dry-run
 *   npx tsx scripts/backfill-generation-gateway-links.ts
 */
import { PrismaClient } from "@prisma/client"
import { parseImagePipelineIdempotencyKey } from "../src/ai-gateway/ai-gateway-image-callbacks.service"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

const CHARGE_PREFIX = "charge:"
const PAGE = 500

type Link = { gatewayTaskId: string; imageId: number | null; attemptNo: number | null }

function parseLinks(value: unknown): Link[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (it): it is Link =>
      !!it &&
      typeof it === "object" &&
      typeof (it as { gatewayTaskId?: unknown }).gatewayTaskId === "string"
  )
}

async function main() {
  const stats = {
    scanned: 0,
    skippedNoParse: 0,
    skippedNoGatewayTaskId: 0,
    tasksUpdated: 0,
    imagesUpdated: 0,
    itemsUpdated: 0,
    itemsGone: 0,
    metaUpdated: 0,
  }
  // generate 维度按任务聚合后再写;t2i/i2i 逐行即时写
  const linksByTask = new Map<number, Link[]>()

  let cursor = 0
  for (;;) {
    const logs = await prisma.usageLog.findMany({
      where: {
        source: { startsWith: "aicreative.image_generate" },
        requestId: { startsWith: `${CHARGE_PREFIX}imggen:` },
      },
      orderBy: { id: "asc" },
      take: PAGE,
      skip: 1,
      cursor: cursor ? { id: cursor } : undefined,
      select: { id: true, cost: true, meta: true, requestId: true },
    })
    if (logs.length === 0) break
    cursor = logs[logs.length - 1].id

    for (const log of logs) {
      stats.scanned += 1
      const parsed = parseImagePipelineIdempotencyKey(
        (log.requestId ?? "").slice(CHARGE_PREFIX.length)
      )
      if (!parsed) {
        stats.skippedNoParse += 1
        continue
      }
      const meta = (log.meta ?? {}) as {
        gatewayTaskId?: unknown
        gatewayAmountCny?: unknown
        taskId?: unknown
        jobId?: unknown
      }
      const gatewayTaskId =
        typeof meta.gatewayTaskId === "string" && meta.gatewayTaskId ? meta.gatewayTaskId : null

      if (gatewayTaskId && /^\d+$/.test(parsed.owner)) {
        // generate 管线流水
        const links = linksByTask.get(Number(parsed.owner)) ?? []
        if (!links.some(l => l.gatewayTaskId === gatewayTaskId)) {
          links.push({
            gatewayTaskId,
            imageId: parsed.childId,
            attemptNo: parsed.attemptNo,
          })
        }
        linksByTask.set(Number(parsed.owner), links)
      } else if (gatewayTaskId) {
        // t2i/i2i 流水：item 可能已被清理（更新前保留期 30 分钟硬删），匹配 0 条计入 gone
        if (!dryRun) {
          const r = await prisma.imageGenItem.updateMany({
            where: { id: parsed.childId, jobId: parsed.owner, providerJobId: null },
            data: { providerJobId: gatewayTaskId },
          })
          if (r.count > 0) stats.itemsUpdated += r.count
          else stats.itemsGone += 1
        } else {
          stats.itemsUpdated += 1
        }
      } else {
        stats.skippedNoGatewayTaskId += 1
      }

      // 对账快照：meta 缺 gatewayAmountCny 的用 cost 补
      if (typeof meta.gatewayAmountCny !== "string" && log.cost != null) {
        if (!dryRun) {
          await prisma.usageLog.update({
            where: { id: log.id },
            data: {
              meta: { ...meta, gatewayAmountCny: log.cost.toString() } as object,
            },
          })
        }
        stats.metaUpdated += 1
      }
    }
    if (logs.length < PAGE) break
  }

  for (const [taskId, fresh] of linksByTask) {
    if (dryRun) {
      stats.tasksUpdated += 1
      stats.imagesUpdated += fresh.filter(l => l.imageId != null).length
      continue
    }
    const current = await prisma.generationTask.findUnique({
      where: { id: taskId },
      select: { gatewayTaskIds: true, gatewayTaskId: true },
    })
    if (!current) continue
    const merged = parseLinks(current.gatewayTaskIds)
    for (const link of fresh) {
      if (!merged.some(l => l.gatewayTaskId === link.gatewayTaskId)) merged.push(link)
    }
    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        gatewayTaskIds: JSON.parse(JSON.stringify(merged)),
        ...(merged.length === 1 && !current.gatewayTaskId
          ? { gatewayTaskId: merged[0].gatewayTaskId }
          : {}),
      },
    })
    stats.tasksUpdated += 1
    for (const link of fresh) {
      if (link.imageId == null) continue
      const r = await prisma.generatedImage.updateMany({
        where: { id: link.imageId, taskId, providerJobId: null },
        data: { providerJobId: link.gatewayTaskId },
      })
      stats.imagesUpdated += r.count
    }
  }

  console.log(`[backfill-generation-gateway-links] dryRun=${dryRun}`)
  console.log(JSON.stringify(stats, null, 2))
  console.log(
    "说明：priceMultiplier 无法从流水反推（credits 含个人/企业折扣），未回填；" +
      "gatewayEventId 从未持久化，无源可回；已被清理的 t2i/i2i 业务行计入 itemsGone。"
  )
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
