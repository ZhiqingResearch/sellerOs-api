/**
 * 存量团队回填 nameFilled（企业名是否被显式设置过）：
 * 非空名且 ≠ 「{管理员用户名}的团队」默认名 → true；空名/等于默认名 → 保持 false。
 * 只把 false→true 单向翻转（不动已为 true 的行），幂等，可随时重跑。
 * 新数据已在建队（SELF/CUSTOM）与改名（控制台/平台编辑）时落 nameFilled，本脚本只处理存量。
 * 用法：
 *   npx tsx scripts/backfill-team-name-filled.ts --dry-run   # 先看影响面
 *   npx tsx scripts/backfill-team-name-filled.ts             # 正式回填
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

async function main() {
  const teams = await prisma.team.findMany({
    where: { nameFilled: false, name: { not: null } },
    select: { id: true, name: true, adminId: true, admin: { select: { username: true } } },
    orderBy: { id: "asc" },
  })
  let toFill = 0
  let skipped = 0
  for (const t of teams) {
    const trimmed = t.name?.trim()
    if (!trimmed || trimmed === `${t.admin.username}的团队`) {
      skipped++ // 空名/系统默认名 → 视为未命名，保持 false
      continue
    }
    toFill++
    console.log(`  team ${t.id}（admin=${t.adminId}）name=「${t.name}」→ nameFilled=true`)
    if (!dryRun) {
      await prisma.team.update({ where: { id: t.id }, data: { nameFilled: true } })
    }
  }
  console.log(
    `共 ${teams.length} 个待判团队：置 true ${toFill} 个，保持 false ${skipped} 个${dryRun ? "（dry-run，未写入）" : ""}`
  )
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
