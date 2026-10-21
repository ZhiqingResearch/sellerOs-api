/**
 * 一次性迁移：取消 LV4(FOUNDER)/LV5(INVITER) 等级（2026-08-20 新口径：邀请只是关系，等级只按订阅档）。
 *
 * 用法：
 *   npx ts-node scripts/migrate-lv4-lv5.ts --dry-run   # 预览报告 + 不写库（务必先跑）
 *   npx ts-node scripts/migrate-lv4-lv5.ts             # 实际执行（先自动导出受影响行 JSON 备份）
 *
 * 行为：
 *   - membershipLevel ∈ {FOUNDER, INVITER} 的用户 → 按当前 subscriptionTier 重算为 LV1/LV2/LV3/NONE。
 *   - FOUNDER（被邀请人）：invitedById 关系保留（返利上溯链不断）；RECHARGE 批次不动。
 *   - INVITER（邀请人）：canInvite / 邀请码 / rebateRate 全部保留（邀请人可同时是 LV1-3 会员）。
 *
 * 边界（R4 口径：显式处理并输出报告，不盲改）：
 *   - RECHARGE 负批次（欠账）：保留不动，仅报告笔数。
 *   - 共享额度链路（shareCreditsWithInvitees）：功能保留，报告开启人数。
 *   - 待生效个人排队单（ScheduledPlan PENDING & teamId=null）：保留；到期激活时 resolveLevel
 *     按新口径给档（activateDuePlans 已切新逻辑）。
 *
 * 幂等：已是目标等级的行跳过，可安全重复执行。建议：先备份库 → --dry-run 核对报告 → 再正式执行。
 */
import { CreditBucket, MembershipLevel, PrismaClient, ScheduledPlanStatus } from "@prisma/client"
import * as fs from "node:fs"
import * as path from "node:path"

const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes("--dry-run")

/** 与 membership.constants.resolveLevel 新口径一致：等级只按订阅档 */
function levelOf(subscriptionTier: number | null): MembershipLevel {
  if (subscriptionTier === 1) return MembershipLevel.LV1
  if (subscriptionTier === 2) return MembershipLevel.LV2
  if (subscriptionTier === 3) return MembershipLevel.LV3
  return MembershipLevel.NONE
}

async function main() {
  console.log(DRY_RUN ? "=== DRY RUN（不写库）===" : "=== 正式执行 ===")

  const affected = await prisma.user.findMany({
    where: { membershipLevel: { in: [MembershipLevel.FOUNDER, MembershipLevel.INVITER] } },
    select: {
      id: true,
      username: true,
      phone: true,
      membershipLevel: true,
      canInvite: true,
      invitedById: true,
      subscriptionTier: true,
      subscriptionExpiresAt: true,
      shareCreditsWithInvitees: true,
    },
    orderBy: { id: "asc" },
  })
  const founder = affected.filter(u => u.membershipLevel === MembershipLevel.FOUNDER)
  const inviter = affected.filter(u => u.membershipLevel === MembershipLevel.INVITER)
  console.log(
    `受影响用户：${affected.length}（FOUNDER ${founder.length} / INVITER ${inviter.length}）`
  )
  if (!affected.length) {
    console.log("无需迁移。")
    return
  }

  const ids = affected.map(u => u.id)
  const [debtLots, pendingPlans] = await Promise.all([
    prisma.creditLot.count({
      where: { userId: { in: ids }, bucket: CreditBucket.RECHARGE, remaining: { lt: 0 } },
    }),
    prisma.scheduledPlan.count({
      where: { userId: { in: ids }, status: ScheduledPlanStatus.PENDING, teamId: null },
    }),
  ])
  const sharing = affected.filter(u => u.shareCreditsWithInvitees).length
  console.log(
    `边界：RECHARGE 负批次 ${debtLots} 笔（保留不动）；共享额度开启 ${sharing} 人（保留）；` +
      `待生效个人排队单 ${pendingPlans} 笔（保留，激活按新口径给档）`
  )
  // 异常行提示：FOUNDER 但无邀请人（关系缺失，等级照算但提示人工核对）
  const orphan = founder.filter(u => u.invitedById == null)
  if (orphan.length) {
    console.warn(
      `⚠️ FOUNDER 但 invitedById 为空 ${orphan.length} 行：${orphan.map(u => u.id).join(",")}`
    )
  }

  if (!DRY_RUN) {
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
    const backupPath = path.join(__dirname, "data", `lv4-lv5-backup-${ts}.json`)
    fs.mkdirSync(path.dirname(backupPath), { recursive: true })
    fs.writeFileSync(backupPath, JSON.stringify(affected, null, 2), "utf8")
    console.log(`受影响行已备份 → ${backupPath}`)
  }

  const changes = affected
    .map(u => ({ id: u.id, from: u.membershipLevel, to: levelOf(u.subscriptionTier) }))
    .filter(c => c.from !== c.to)
  const counter = new Map<string, number>()
  for (const c of changes) {
    const key = `${c.from} → ${c.to}`
    counter.set(key, (counter.get(key) ?? 0) + 1)
    if (!DRY_RUN) {
      await prisma.user.update({ where: { id: c.id }, data: { membershipLevel: c.to } })
    }
  }
  for (const [k, n] of counter) console.log(`  ${k}：${n} 行`)
  console.log(
    `${DRY_RUN ? "（预览）将重算" : "已重算"} ${changes.length} 行；已是目标等级 ${affected.length - changes.length} 行跳过。`
  )
}

main()
  .catch(e => {
    console.error("迁移失败：", e)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
