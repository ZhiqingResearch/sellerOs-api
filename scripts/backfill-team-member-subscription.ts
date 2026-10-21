/**
 * 存量企业成员个人订阅字段回填：占用中企业（ACTIVE/GRACE）的 ACTIVE/DISABLED 成员，
 * 其个人套餐身份（subscriptionTier / membershipLevel / subscriptionExpiresAt）清零为无等级。
 * 背景：2026-08-26 起「加入企业即终止个人订阅身份」（joinTeam 全清三个字段），
 * 此前加入的成员仍残留个人档位/有效期——用户管理列表会把停用成员显示成「Lv.x 个人计费」，
 * 钱包身份视图也会误判为 SUB_ACTIVE。个人充值积分（RECHARGE）不受影响。
 * 幂等，可随时重跑。用法：
 *   npx ts-node scripts/backfill-team-member-subscription.ts --dry-run   # 先看影响面
 *   npx ts-node scripts/backfill-team-member-subscription.ts             # 正式回填
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

async function main() {
  // 占用中企业的在职/停用成员（已归档企业的成员不在内——其归属已释放，个人订阅本就已终止）
  const members = await prisma.teamMember.findMany({
    where: {
      status: { in: ["ACTIVE", "DISABLED"] },
      team: { status: { in: ["ACTIVE", "GRACE"] } },
      user: {
        OR: [
          { subscriptionTier: { not: null } },
          { membershipLevel: { not: "NONE" } },
          { subscriptionExpiresAt: { not: null } },
        ],
      },
    },
    select: {
      teamId: true,
      userId: true,
      status: true,
      user: {
        select: { username: true, subscriptionTier: true, membershipLevel: true },
      },
    },
    orderBy: { userId: "asc" },
  })
  console.log(`残留个人订阅的企业成员 ${members.length} 个${dryRun ? "（dry-run，不写入）" : ""}`)
  for (const m of members) {
    console.log(
      `  user ${m.userId}（${m.user.username}，team ${m.teamId}，成员 ${m.status}）：` +
        `tier=${m.user.subscriptionTier ?? "-"} level=${m.user.membershipLevel} → 清空`
    )
  }
  if (!dryRun && members.length) {
    const res = await prisma.user.updateMany({
      where: { id: { in: members.map(m => m.userId) } },
      data: { subscriptionTier: null, membershipLevel: "NONE", subscriptionExpiresAt: null },
    })
    console.log(`已清零 ${res.count} 个用户`)
  }
  console.log(dryRun ? "dry-run 完成" : "回填完成")
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
