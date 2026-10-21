/**
 * 存量空名团队回填默认名：`name` 为 NULL/空串的团队 → 「{管理员用户名}的团队」。
 * 背景：自助建队 teamName 可选，老数据存在空名（用户管理「企业归属」列只剩来源标签）；
 * 新数据已在 createSelfServeTeam 创建时落默认名，本脚本只处理存量。
 * 幂等，可随时重跑。用法：
 *   npx tsx scripts/backfill-team-names.ts --dry-run   # 先看影响面
 *   npx tsx scripts/backfill-team-names.ts             # 正式回填
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

async function main() {
  const teams = await prisma.team.findMany({
    where: { OR: [{ name: null }, { name: "" }] },
    select: { id: true, adminId: true, admin: { select: { username: true } } },
    orderBy: { id: "asc" },
  })
  console.log(`空名团队 ${teams.length} 个${dryRun ? "（dry-run，不写入）" : ""}`)
  for (const t of teams) {
    const name = `${t.admin.username}的团队`
    console.log(`  team ${t.id}（admin=${t.adminId}）→ ${name}`)
    if (!dryRun) {
      await prisma.team.update({ where: { id: t.id }, data: { name } })
    }
  }
  console.log(dryRun ? "dry-run 完成" : "回填完成")
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
