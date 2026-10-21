/**
 * 存量回填：批量改图等 t2i/i2i「成品入库」快照行 ↔ 源 ImageGenJob 的双向链接
 * （2026-09-11，方案「入库行挂积分 + 去重」）。链接建立后：
 *   - GenerationTask.sourceJobId = 源 job id → 生成记录视图把扣费积分（UsageLog
 *     盖 meta.jobId）挂到入库行；
 *   - ImageGenJob.taskId = 入库行 id → 视图隐藏已归档的原始 IMAGEGEN 行（不双计）。
 * 新数据由 createTask(dto.sourceJobId) 同事务写入，本脚本只补存量。
 *
 * 匹配口径：入库快照行特征（STANDARD + SUCCESS + 无 executionSpec + 创建后零更新
 * ——真生成必经 GENERATING→PATCH，updatedAt 必然后移）× 图片 URL 与 ImageGenItem.url
 * 精确相等（归档 rehost 只处理 data: 图，http 产物 URL 原样入库，已实测逐字节一致）
 * × 归属用户一致。不满足的保守跳过。
 * 幂等：sourceJobId 已有值不再改写；重复执行无副作用。用法：
 *   npx tsx scripts/backfill-archived-task-links.ts --dry-run
 *   npx tsx scripts/backfill-archived-task-links.ts
 */
import { Prisma, PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

async function main() {
  const stats = { candidates: 0, linked: 0, skippedNoMatch: 0, skippedAmbiguous: 0 }

  // 候选入库快照行：创建即终态且从未被更新（执行器 CAS/PATCH 都会动 updatedAt）。
  // executionSpec 是 Json?，where 判空需 DbNull（数据库层面的 NULL）
  const tasks = await prisma.generationTask.findMany({
    where: {
      generationMode: "STANDARD",
      status: "SUCCESS",
      executionSpec: { equals: Prisma.DbNull },
      sourceJobId: null,
      deletedAt: null,
    },
    select: {
      id: true,
      userId: true,
      createdAt: true,
      updatedAt: true,
      generatedImages: { where: { deletedAt: null }, select: { url: true } },
    },
    take: 5000,
  })

  // url → jobId 索引（表为迁移后新表，量级小，全量拉取）
  const items = await prisma.imageGenItem.findMany({
    where: { url: { not: null }, job: { is: {} } },
    select: { url: true, jobId: true, job: { select: { userId: true } } },
  })
  const jobIdsByUrl = new Map<string, Set<string>>()
  for (const it of items) {
    if (!it.url) continue
    const set = jobIdsByUrl.get(it.url) ?? new Set<string>()
    set.add(it.jobId)
    jobIdsByUrl.set(it.url, set)
  }
  const jobOwners = new Map<string, number>()
  for (const it of items) jobOwners.set(it.jobId, it.job.userId)

  for (const task of tasks) {
    // 零更新校验（任务行本身；图片行的 URL 匹配已隐含一致性）
    if (task.updatedAt.getTime() !== task.createdAt.getTime()) continue
    stats.candidates += 1

    const urls = task.generatedImages.map(g => g.url).filter((u): u is string => !!u)
    if (urls.length === 0) {
      stats.skippedNoMatch += 1
      continue
    }
    // 命中集合：本任务所有 URL 都能定位到的、同用户的唯一 job
    const hits = new Set<string>()
    for (const u of urls) {
      for (const j of jobIdsByUrl.get(u) ?? []) {
        if (jobOwners.get(j) === task.userId) hits.add(j)
      }
    }
    if (hits.size === 0) {
      stats.skippedNoMatch += 1
      continue
    }
    if (hits.size > 1) {
      stats.skippedAmbiguous += 1
      continue
    }
    const jobId = [...hits][0]
    if (!dryRun) {
      await prisma.$transaction([
        prisma.generationTask.update({
          where: { id: task.id },
          data: { sourceJobId: jobId },
        }),
        prisma.imageGenJob.updateMany({
          where: { id: jobId, taskId: null },
          data: { taskId: task.id },
        }),
      ])
    }
    stats.linked += 1
  }

  console.log(`[backfill-archived-task-links] dryRun=${dryRun}`)
  console.log(JSON.stringify(stats, null, 2))
  console.log(
    "说明：skippedNoMatch 含老 BFF 时代的入库行（源 job 已被旧 Cron 清理，无从链接，" +
      "积分保持为空）；skippedAmbiguous 为 URL 多 job 命中的保守跳过。"
  )
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
