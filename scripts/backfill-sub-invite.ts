/**
 * 存量「下级可继续邀请」派生权限回填（2026-09-01 落库制迁移）：
 * 邀请权从「读时派生」（上级 subInviteAllowed 开着、下级读时就算有）改为「落库制」（开关打开时批量写
 * 下级 canInvite=true + 邀请码）。本脚本把存量派生状态落成库：
 *   上级（根分销：canInvite=true、subInviteAllowed=true、本人非被邀请人）的直接下级中
 *   仍 canInvite=false 且未被人工单独关闭（canInviteManualOff=false）的 → 批量打开 + 发邀请码（24h）。
 * 幂等（只处理 canInvite=false），可随时重跑。用法：
 *   npx tsx scripts/backfill-sub-invite.ts --dry-run   # 先看影响面
 *   npx tsx scripts/backfill-sub-invite.ts             # 正式回填
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 与 InviteService 同源（去易混字符）
const CODE_TTL_MS = 24 * 3600 * 1000

async function generateUniqueCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    let code = "OS"
    for (let j = 0; j < 4; j++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    const exists = await prisma.user.findUnique({
      where: { inviteCode: code },
      select: { id: true },
    })
    if (!exists) return code
  }
  throw new Error("邀请码生成失败")
}

async function main() {
  // 开着「下级可继续邀请」的根分销（本人非被邀请人才会向下批量；被邀请用户的开关无效）
  const roots = await prisma.user.findMany({
    where: { canInvite: true, subInviteAllowed: true, invitedById: null },
    select: { id: true, username: true },
    orderBy: { id: "asc" },
  })
  console.log(
    `开着「下级可继续邀请」的根分销 ${roots.length} 个${dryRun ? "（dry-run，不写入）" : ""}`
  )

  let total = 0
  for (const root of roots) {
    const kids = await prisma.user.findMany({
      where: { invitedById: root.id, canInvite: false, canInviteManualOff: false },
      select: { id: true, username: true },
      orderBy: { id: "asc" },
    })
    if (!kids.length) continue
    console.log(`  根 ${root.id}（${root.username}）：待打开 ${kids.length} 个下级`)
    for (const k of kids) {
      console.log(`    user ${k.id}（${k.username}）→ canInvite=true + 邀请码`)
      if (!dryRun) {
        await prisma.user.update({
          where: { id: k.id },
          data: {
            canInvite: true,
            inviteCode: await generateUniqueCode(),
            inviteCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
          },
        })
      }
      total++
    }
  }
  console.log(`${dryRun ? "dry-run 完成，将影响" : "回填完成，已打开"} ${total} 个下级`)
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
