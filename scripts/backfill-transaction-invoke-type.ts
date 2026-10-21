/**
 * 存量 CreditTransaction 回填 invokeType=API（调用方式：平台使用/开放平台扣费）：
 * 两个开放平台扣费入口（/api/open/credit/deduct、/api/open/keyb/credit/deduct）写出的消费行
 * meta 必带 appId（KeyB 另带 keybCharge），平台行不带 → 按 meta.appId 单向订正 PLATFORM→API。
 * 新数据已在扣费时显式落 invokeType，本脚本只处理存量；幂等，可随时重跑。
 * 用法：
 *   npx tsx scripts/backfill-transaction-invoke-type.ts --dry-run   # 先看影响面
 *   npx tsx scripts/backfill-transaction-invoke-type.ts             # 正式回填
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

async function main() {
  const pending = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM CreditTransaction
    WHERE invokeType = 'PLATFORM' AND JSON_EXTRACT(meta, '$.appId') IS NOT NULL
    ORDER BY id
  `
  console.log(`待订正行数：${pending.length}${dryRun ? "（dry-run，未写入）" : ""}`)
  for (const r of pending.slice(0, 20)) console.log(`  txn ${r.id}`)
  if (pending.length > 20) console.log(`  … 其余 ${pending.length - 20} 行省略`)
  if (dryRun || pending.length === 0) return
  const updated = await prisma.$executeRaw`
    UPDATE CreditTransaction SET invokeType = 'API'
    WHERE invokeType = 'PLATFORM' AND JSON_EXTRACT(meta, '$.appId') IS NOT NULL
  `
  console.log(`已订正 ${updated} 行 → invokeType=API`)
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
