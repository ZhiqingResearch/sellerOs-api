/**
 * 对齐 dev 库 _prisma_migrations 表与本地 prisma/migrations 文件。
 *
 * 当前差异（针对 agent-api-dev 库）：
 *   1) 孤儿 20260420085912（本地无对应文件，历史手动 SQL）
 *   2) 20260420153403_drop_user_role_enum checksum: dev 是旧版 44bab8d0，本地/prod 是 2048d16e
 *   3) 20260420200000_storyboard_video_async checksum: dev 是中间版 d4006449，本地/prod 是 de658b2a
 *
 * 执行前已确认：
 *   - dev 当前 schema 与 schema.prisma 一致（业务表不需要改）
 *   - Role(ADMIN/USER) 已存在，User.roleId 无 NULL 行（drop_user_role_enum 旧版 SQL 虽未跑过回填，
 *     但等效状态已经通过其它路径达成）
 *   - 本地新 migration 20260424040000_public_avatars_voices 的 checksum 与 dev 已一致，不用处理
 *
 * ⚠️  严禁对 prod 运行本脚本！prod 已与本地对齐，不需要任何修复。
 *
 * 用法：
 *   npx ts-node scripts/repair-dev-migrations.ts              # DRY-RUN
 *   npx ts-node scripts/repair-dev-migrations.ts --apply      # 真实执行
 *   npx ts-node scripts/repair-dev-migrations.ts --apply --clean-rb  # 一并删掉 rolled_back 历史行
 */
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { PrismaClient } from "@prisma/client"

const APPLY = process.argv.includes("--apply")
const CLEAN_RB = process.argv.includes("--clean-rb")
const MIGS_DIR = path.resolve(__dirname, "..", "prisma", "migrations")

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function localChecksums(): Map<string, string> {
  const out = new Map<string, string>()
  for (const name of fs.readdirSync(MIGS_DIR)) {
    const p = path.join(MIGS_DIR, name, "migration.sql")
    if (fs.existsSync(p)) out.set(name, sha256(p))
  }
  return out
}

async function main() {
  const prisma = new PrismaClient()
  try {
    const local = localChecksums()

    const remote: Array<{
      migration_name: string
      checksum: string
      finished_at: Date | null
      rolled_back_at: Date | null
    }> = await prisma.$queryRawUnsafe(
      "SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name"
    )

    const applied = remote.filter(r => r.rolled_back_at === null && r.finished_at !== null)
    const rolledBack = remote.filter(r => r.rolled_back_at !== null)

    const orphanOnRemote: typeof remote = []
    const checksumMismatch: Array<{ name: string; localSum: string; remoteSum: string }> = []

    for (const r of applied) {
      const lc = local.get(r.migration_name)
      if (!lc) orphanOnRemote.push(r)
      else if (lc !== r.checksum)
        checksumMismatch.push({ name: r.migration_name, localSum: lc, remoteSum: r.checksum })
    }

    console.log("=".repeat(74))
    console.log(`模式：${APPLY ? "APPLY（真实执行）" : "DRY-RUN（仅展示计划）"}`)
    console.log("=".repeat(74))
    console.log(`\n本地 migration 文件：${local.size} 条`)
    console.log(`远端 applied 行：${applied.length} 条`)
    console.log(`远端 rolled-back 行：${rolledBack.length} 条`)

    console.log(`\n❌ 孤儿（远端有、本地无）：${orphanOnRemote.length}`)
    for (const r of orphanOnRemote) console.log(`   - ${r.migration_name}`)

    console.log(`\n❌ Checksum 不一致：${checksumMismatch.length}`)
    for (const m of checksumMismatch)
      console.log(`   - ${m.name}\n       local:  ${m.localSum}\n       remote: ${m.remoteSum}`)

    console.log(`\nℹ️ rolled-back 历史行（Prisma 默认忽略）：${rolledBack.length}`)
    for (const r of rolledBack) console.log(`   - ${r.migration_name}`)

    if (
      orphanOnRemote.length === 0 &&
      checksumMismatch.length === 0 &&
      !(CLEAN_RB && rolledBack.length > 0)
    ) {
      console.log("\n✅ 已完全对齐，无需修复")
      return
    }

    // 业务前置校验（drop_user_role_enum 新版的回填 SQL 是否已生效）
    console.log("\n" + "=".repeat(74))
    console.log("业务前置校验（drop_user_role_enum 补偿 SQL 是否已生效）")
    console.log("=".repeat(74))

    const [adminRow]: any = await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) AS cnt FROM Role WHERE code = 'ADMIN'"
    )
    const [userRow]: any = await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) AS cnt FROM Role WHERE code = 'USER'"
    )
    const [nullRow]: any = await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) AS cnt FROM User WHERE roleId IS NULL"
    )
    console.log(`Role(code='ADMIN') 行数: ${Number(adminRow.cnt)} ${Number(adminRow.cnt) >= 1 ? "✅" : "❗"}`)
    console.log(`Role(code='USER')  行数: ${Number(userRow.cnt)}  ${Number(userRow.cnt) >= 1 ? "✅" : "❗"}`)
    console.log(`User.roleId IS NULL 行数: ${Number(nullRow.cnt)} ${Number(nullRow.cnt) === 0 ? "✅" : "❗"}`)

    console.log("\n" + "=".repeat(74))
    console.log("修复计划")
    console.log("=".repeat(74))

    const plan: Array<{ label: string; run: () => Promise<unknown> }> = []

    // 幂等插入 ADMIN/USER 角色（保险；若已存在则 no-op）
    plan.push({
      label: "[保险] 幂等插入 ADMIN 角色",
      run: () =>
        prisma.$executeRawUnsafe(
          "INSERT INTO `Role` (`code`, `name`, `description`, `isSystem`, `createdAt`, `updatedAt`) " +
            "VALUES ('ADMIN', '管理员', '系统管理员（内置），拥有全部权限', 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)) " +
            "ON DUPLICATE KEY UPDATE `code` = `code`"
        ),
    })
    plan.push({
      label: "[保险] 幂等插入 USER 角色",
      run: () =>
        prisma.$executeRawUnsafe(
          "INSERT INTO `Role` (`code`, `name`, `description`, `isSystem`, `createdAt`, `updatedAt`) " +
            "VALUES ('USER', '普通用户', '普通用户（内置），拥有全部权限', 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)) " +
            "ON DUPLICATE KEY UPDATE `code` = `code`"
        ),
    })
    plan.push({
      label: "[保险] 把 User.roleId IS NULL 的行指向 USER 角色",
      run: () =>
        prisma.$executeRawUnsafe(
          "UPDATE User u JOIN Role r ON r.code = 'USER' SET u.roleId = r.id WHERE u.roleId IS NULL"
        ),
    })

    for (const m of checksumMismatch) {
      plan.push({
        label: `[核心] UPDATE checksum (${m.name})`,
        run: () =>
          prisma.$executeRawUnsafe(
            "UPDATE _prisma_migrations SET checksum = ? WHERE migration_name = ? AND rolled_back_at IS NULL",
            m.localSum,
            m.name
          ),
      })
    }

    for (const o of orphanOnRemote) {
      plan.push({
        label: `[核心] DELETE 孤儿记录 (${o.migration_name})`,
        run: () =>
          prisma.$executeRawUnsafe(
            "DELETE FROM _prisma_migrations WHERE migration_name = ?",
            o.migration_name
          ),
      })
    }

    if (CLEAN_RB && rolledBack.length > 0) {
      plan.push({
        label: `[可选] DELETE rolled-back 历史行 x${rolledBack.length}`,
        run: () =>
          prisma.$executeRawUnsafe(
            "DELETE FROM _prisma_migrations WHERE rolled_back_at IS NOT NULL"
          ),
      })
    }

    for (const step of plan) console.log(`   ${step.label}`)

    if (!APPLY) {
      console.log("\n(DRY-RUN) 未执行。加 --apply 真正执行。")
      return
    }

    console.log("\n执行中...")
    for (const step of plan) {
      process.stdout.write(`   ${step.label} ... `)
      const result = await step.run()
      console.log(`done (rows=${typeof result === "number" ? result : "?"})`)
    }

    // 验证
    const after: Array<{ migration_name: string; checksum: string }> =
      await prisma.$queryRawUnsafe(
        "SELECT migration_name, checksum FROM _prisma_migrations WHERE rolled_back_at IS NULL ORDER BY migration_name"
      )
    const remaining: string[] = []
    for (const r of after) {
      const lc = local.get(r.migration_name)
      if (!lc) remaining.push(`orphan: ${r.migration_name}`)
      else if (lc !== r.checksum) remaining.push(`mismatch: ${r.migration_name}`)
    }
    for (const name of local.keys()) {
      if (!after.find(r => r.migration_name === name))
        remaining.push(`missing on remote: ${name}`)
    }
    console.log("\n修复后剩余问题：", remaining.length === 0 ? "无 ✅" : remaining)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
