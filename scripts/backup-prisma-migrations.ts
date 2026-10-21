/**
 * 备份 _prisma_migrations 表完整内容到 backups/_prisma_migrations-<env>-<timestamp>.json。
 * 仅元数据表，不涉及业务数据。脚本只读不写，可随时跑。
 *
 * 用法：
 *   npx ts-node scripts/backup-prisma-migrations.ts [env-label]
 *     env-label 可选，默认 "dev"，只用于文件名标识
 */
import * as fs from "fs"
import * as path from "path"
import { PrismaClient } from "@prisma/client"

const envLabel = process.argv[2] ?? "dev"

async function main() {
  const prisma = new PrismaClient()
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      "SELECT id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count FROM _prisma_migrations ORDER BY started_at"
    )

    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const dir = path.resolve(__dirname, "..", "backups")
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `_prisma_migrations-${envLabel}-${ts}.json`)

    // Date 序列化为 ISO 字符串；BigInt 转 Number
    const serialized = rows.map(r => ({
      ...r,
      finished_at: r.finished_at ? r.finished_at.toISOString() : null,
      started_at: r.started_at ? r.started_at.toISOString() : null,
      rolled_back_at: r.rolled_back_at ? r.rolled_back_at.toISOString() : null,
      applied_steps_count: Number(r.applied_steps_count),
    }))

    fs.writeFileSync(file, JSON.stringify(serialized, null, 2))
    console.log(`✅ 备份完成：${rows.length} 行 → ${path.relative(process.cwd(), file)}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
