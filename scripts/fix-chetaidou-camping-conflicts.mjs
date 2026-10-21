/** node --env-file-if-exists=.env scripts/fix-chetaidou-camping-conflicts.mjs [--dry-run] */
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { jsonHash } from "./chetaidou/data.mjs"

export const CAMPING_CHECKSUM = "096a21ad1b8209c634c802011019c7e0de65654f5cf3ecab833550a0c0b7f64c"
export const FALSE_CONFLICTS = [
  "历史提示词要求画面中为“一家四口”背景人物；当前成品实际可见为前景1名骑手加背景4人，总计5人出现在画面中。该差异是与历史稿要求的场景人数不一致，不是SKU硬件冲突。",
  "历史提示词写明“No logo”，但当前成品车架前部可见一个小型蓝色图形标记；若该标记属于实物标识，则不应因历史文字要求被擦除。由于这是旧稿要求与现图观察的差异，不构成已确认SKU硬冲突。",
]

export async function fixCampingConflicts(db, { dryRun = false } = {}) {
  const sku = await db.chetaidouSku.findUnique({ where: { code: "CS1plus" } })
  if (!sku) return []
  const images = await db.chetaidouImage.findMany({
    where: { skuId: sku.id, sourceType: "PRESET", checksum: CAMPING_CHECKSUM },
    select: { id: true },
  })
  const results = []
  for (const { id } of images) {
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ChetaidouImage WHERE id = ${id} FOR UPDATE`
      const image = await tx.chetaidouImage.findUniqueOrThrow({ where: { id } })
      assert(image.currentBreakdownId, "母版缺少当前拆解")
      const source = await tx.chetaidouBreakdown.findUniqueOrThrow({ where: { id: image.currentBreakdownId } })
      assert.equal(source.imageId, id, "当前拆解归属不正确")
      assert(Array.isArray(source.payload.conflicts), "当前拆解 conflicts 不是数组")
      const conflicts = source.payload.conflicts.filter(value => !FALSE_CONFLICTS.includes(value))
      const removed = source.payload.conflicts.length - conflicts.length
      if (!removed) return { imageId: id, removed: 0, breakdownId: source.id }
      assert(!image.activeBreakdownTaskId, "母版有拆解任务执行中，请完成后重试")
      const payload = { ...source.payload, conflicts }
      if (dryRun) return { imageId: id, removed, breakdownId: source.id }
      const latest = await tx.chetaidouBreakdown.findFirstOrThrow({ where: { imageId: id }, orderBy: { version: "desc" } })
      // 拆解只追加版本，旧稿及其原始错误保留作审计。
      const created = await tx.chetaidouBreakdown.create({ data: {
        imageId: id, version: latest.version + 1, factId: source.factId,
        source: source.source, qualityStatus: source.qualityStatus,
        schemaVersion: source.schemaVersion, payload, contentHash: jsonHash(payload),
        confirmedBy: source.confirmedBy, confirmedAt: source.confirmedAt,
        sourceMetadata: {
          ...source.sourceMetadata,
          correction: "2026-10-13-camping-false-conflicts",
          correctedFromBreakdownId: source.id,
          removedConflicts: source.payload.conflicts.filter(value => FALSE_CONFLICTS.includes(value)),
        },
      } })
      await tx.chetaidouImage.update({ where: { id }, data: { currentBreakdownId: created.id, revision: { increment: 1 } } })
      return { imageId: id, removed, breakdownId: created.id, version: created.version }
    }, { timeout: 30_000 })
    results.push(result)
  }
  return results
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean" } } })
  const { PrismaClient } = await import("@prisma/client")
  const db = new PrismaClient({ errorFormat: "minimal" })
  try {
    console.log(JSON.stringify({ dryRun: !!values["dry-run"], results: await fixCampingConflicts(db, { dryRun: !!values["dry-run"] }) }, null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}
