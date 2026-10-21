/**
 * 将所有「运营专员（内部）」用户（role.code = OPS_SPECIALIST）的总额度统一调整为 10000。
 *
 * 总额度 = balance(剩余) + totalSpent(已花费)，故 new balance = 10000 - totalSpent。
 * 若某人 totalSpent 已超过 10000，balance 钳制为 0 并打印警告（不出现负余额）。
 *
 * 用法：
 *   npx ts-node scripts/set-internal-ops-balance.ts            # dry-run，只打印将要改的人
 *   npx ts-node scripts/set-internal-ops-balance.ts --apply    # 真正写库
 *   npx ts-node scripts/set-internal-ops-balance.ts --apply --include-inactive
 *
 * 安全护栏：
 *   - 范围限定到 roleRef.code = "OPS_SPECIALIST"，不会动其他角色
 *   - 默认 dry-run；写库前打印每一个 user 的 username/phone 与 spent/balance 变化
 *   - 只动 balance，不动 totalSpent；totalSpent 是历史花费的事实，不可篡改
 *   - 已停用用户（isActive=false）默认跳过；--include-inactive 才一起改
 */
import { Prisma, PrismaClient } from "@prisma/client"

const TARGET_ROLE_CODE = "OPS_SPECIALIST"
const TOTAL_QUOTA = new Prisma.Decimal(10000)
const ZERO = new Prisma.Decimal(0)

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes("--apply")
  const includeInactive = args.includes("--include-inactive")

  const prisma = new PrismaClient()
  try {
    const users = await prisma.user.findMany({
      where: {
        roleRef: { code: TARGET_ROLE_CODE },
        ...(includeInactive ? {} : { isActive: true }),
      },
      select: {
        id: true,
        username: true,
        phone: true,
        balance: true,
        totalSpent: true,
        isActive: true,
      },
      orderBy: { id: "asc" },
    })

    if (users.length === 0) {
      console.log(`未找到角色为 ${TARGET_ROLE_CODE} 的用户。`)
      return
    }

    console.log(
      `匹配到 ${users.length} 个 ${TARGET_ROLE_CODE} 用户${
        includeInactive ? "（含已停用）" : "（仅 isActive=true）"
      }，目标总额度 = ${TOTAL_QUOTA.toString()}：`
    )

    const updates: { id: number; newBalance: Prisma.Decimal }[] = []
    let overspentCount = 0

    for (const u of users) {
      const spent = new Prisma.Decimal(u.totalSpent.toString())
      const before = new Prisma.Decimal(u.balance.toString())
      let newBalance = TOTAL_QUOTA.minus(spent)
      let overspentTag = ""
      if (newBalance.lt(ZERO)) {
        overspentCount += 1
        overspentTag = `  ⚠ 已花费 ${spent.toString()} > 总额度，balance 钳制为 0`
        newBalance = ZERO
      }
      const changed = !before.equals(newBalance)
      console.log(
        `  #${u.id} ${u.username} (${u.phone}) spent=${spent.toString()}  balance ${before.toString()} → ${newBalance.toString()}${
          changed ? "" : "  [无变化]"
        }${u.isActive ? "" : "  [已停用]"}${overspentTag}`
      )
      if (changed) updates.push({ id: u.id, newBalance })
    }

    console.log(
      `\n汇总：将改 ${updates.length} 行；保持不变 ${users.length - updates.length} 行；超花告警 ${overspentCount} 行。`
    )

    if (!apply) {
      console.log("[dry-run] 未写库。加 --apply 真正执行。")
      return
    }

    // 用 raw SQL 单条原子更新，避免「读快照与写之间业务在花钱」的并发问题。
    // GREATEST(..., 0) 钳制负数，与 dry-run 显示逻辑一致。
    // 10000 作为常量直接内联（不走参数绑定，避免 Decimal 类型尴尬）。
    // 表名 User / Role 与 migrations 一致（init migration 创建为 PascalCase）。
    const sql = includeInactive
      ? Prisma.sql`UPDATE \`User\` u
                   JOIN \`Role\` r ON r.id = u.roleId
                   SET u.balance = GREATEST(10000 - u.totalSpent, 0)
                   WHERE r.code = ${TARGET_ROLE_CODE}`
      : Prisma.sql`UPDATE \`User\` u
                   JOIN \`Role\` r ON r.id = u.roleId
                   SET u.balance = GREATEST(10000 - u.totalSpent, 0)
                   WHERE r.code = ${TARGET_ROLE_CODE}
                     AND u.isActive = TRUE`
    const affected = await prisma.$executeRaw(sql)
    console.log(`✓ UPDATE 影响 ${affected} 行（MySQL 默认只数实际变更行）。`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
