/**
 * 存量取证流水 source 订正：asin.audit → asin.audit.evidence（label「ASIN 取证」）。
 *
 * 背景：取证模块（scene=evidence-module）上线初期与审计共用扣费 source "asin.audit"，
 * 使用记录/积分流水一律显示「ASIN 审计」。取证固定价扣费 meta 必带 stage="evidence"
 * 且 scene="evidence-module"（审计链取证不扣费，判据无歧义），据此单向订正两张表；
 * 新数据已在扣费时直接写新 source，本脚本只处理存量；幂等，可随时重跑。
 *
 * 边界：无 scene/stage 标记的按量 review-analysis 存量流水无法区分审计/取证来源，保守不动。
 * 用法：
 *   npx tsx scripts/backfill-asin-evidence-source.ts --dry-run   # 先看影响面
 *   npx tsx scripts/backfill-asin-evidence-source.ts             # 正式回填
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

const FROM = "asin.audit"
const TO = "asin.audit.evidence"
const MATCH = `source = '${FROM}' AND (
  JSON_UNQUOTE(JSON_EXTRACT(meta, '$.stage')) = 'evidence'
  OR JSON_UNQUOTE(JSON_EXTRACT(meta, '$.scene')) = 'evidence-module'
)`

async function main() {
  for (const table of ["CreditTransaction", "UsageLog"] as const) {
    const pending = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
      `SELECT id FROM ${table} WHERE ${MATCH} ORDER BY id`
    )
    console.log(`${table} 待订正行数：${pending.length}${dryRun ? "（dry-run，未写入）" : ""}`)
    for (const r of pending.slice(0, 20)) console.log(`  ${table} ${r.id}`)
    if (pending.length > 20) console.log(`  … 其余 ${pending.length - 20} 行省略`)
    if (dryRun || pending.length === 0) continue
    const updated = await prisma.$executeRawUnsafe(
      `UPDATE ${table} SET source = '${TO}' WHERE ${MATCH}`
    )
    console.log(`${table} 已订正 ${updated} 行 → source=${TO}`)
  }
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
