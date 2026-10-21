/**
 * 一次性迁移：把 2026-08-25「续费立即生效」改版前遗留的排队续费单（ScheduledPlan PENDING）
 * 全部**立即激活**——个人单：有效期在「当前到期（已过期则 now）」上顺延、积分立即到账、
 * 立即切档（与 CreditService.renewImmediateInTx 同口径）；团队单：团队有效期顺延、池积分
 * 立即入账、graceUntil/dataKeepUntil 按新到期日重算（与 TeamService.renewTeamImmediateInTx 同口径，
 * GRACE/ARCHIVED 团队以 now 为基准恢复新起一期）。
 *
 * 执行后新产生的续费不再排队；脚本幂等（条件抢占 PENDING→ACTIVATED，重复执行无 PENDING 即无操作）。
 *
 * 用法：
 *   TS_NODE_TRANSPILE_ONLY=true npx ts-node -r tsconfig-paths/register scripts/activate-pending-renewals.ts --dry-run
 *   TS_NODE_TRANSPILE_ONLY=true npx ts-node -r tsconfig-paths/register scripts/activate-pending-renewals.ts
 */
import { PrismaClient, ScheduledPlanStatus, TeamStatus } from "@prisma/client"
import "dotenv/config"
import { CreditService } from "../src/membership/credit.service"
import { PrismaService } from "../src/prisma/prisma.service"
import { dataKeepUntilOf, graceUntilOf } from "../src/team/team.constants"

const DAY_MS = 24 * 60 * 60 * 1000
const dryRun = process.argv.includes("--dry-run")

async function main() {
  const prisma = new PrismaClient()
  const now = new Date()

  const pending = await prisma.scheduledPlan.findMany({
    where: { status: ScheduledPlanStatus.PENDING },
    orderBy: { activateAt: "asc" },
  })
  console.log(
    `共 ${pending.length} 笔 PENDING 排队单（个人 ${pending.filter(p => p.teamId == null).length} / 团队 ${pending.filter(p => p.teamId != null).length}）`
  )
  if (!pending.length) {
    await prisma.$disconnect()
    return
  }
  for (const p of pending) {
    console.log(
      `  #${p.id} ${p.teamId != null ? `团队${p.teamId}` : `用户${p.userId}`} ${p.planName}(LV${p.tier}) activateAt=${p.activateAt.toISOString()}`
    )
  }
  if (dryRun) {
    console.log("--dry-run：不落库。")
    await prisma.$disconnect()
    return
  }

  // CreditService 仅依赖 PrismaService，不依赖 Nest 容器，可直接实例化
  const credit = new CreditService(prisma as unknown as PrismaService)

  let personalDone = 0
  let teamDone = 0

  // ---- 个人排队单：直接复用 renewImmediateInTx（与线上一致的顺延/到账/切档口径）----
  for (const plan of pending.filter(p => p.teamId == null)) {
    await prisma.$transaction(
      async tx => {
        // 条件抢占，幂等防重
        const claimed = await tx.scheduledPlan.updateMany({
          where: { id: plan.id, status: ScheduledPlanStatus.PENDING },
          data: { status: ScheduledPlanStatus.ACTIVATED, activatedAt: now },
        })
        if (claimed.count !== 1) return
        await credit.renewImmediateInTx(
          tx,
          plan.userId,
          {
            tier: plan.tier,
            planName: plan.planName,
            priceCny: plan.priceCny,
            packageCredits: plan.packageCredits,
            giftCredits: plan.giftCredits,
            periodDays: plan.periodDays,
          },
          now,
          {
            source: "migrate.renewal",
            sourceRef: `scheduledPlan:${plan.id}`,
            meta: { migratedFrom: "scheduledPlan", scheduledPlanId: plan.id },
            allowTierDowngrade: true, // 改版前已付款的排队单按原顺序激活，不做禁降档拦截
          }
        )
      },
      { timeout: 60000 } // 远程库高延迟：放宽交互事务超时（默认 5s 不够）
    )
    personalDone++
    console.log(`个人排队单 #${plan.id}（用户 ${plan.userId} ${plan.planName}）已立即激活`)
  }

  // ---- 团队排队单：与 renewTeamImmediateInTx 同口径手工展开（避免拉起 TeamService 依赖树）----
  for (const plan of pending.filter(p => p.teamId != null)) {
    const teamId = plan.teamId!
    await prisma.$transaction(
      async tx => {
        const claimed = await tx.scheduledPlan.updateMany({
          where: { id: plan.id, status: ScheduledPlanStatus.PENDING },
          data: { status: ScheduledPlanStatus.ACTIVATED, activatedAt: now },
        })
        if (claimed.count !== 1) return
        const team = await tx.team.findUnique({ where: { id: teamId } })
        if (!team) throw new Error(`团队 ${teamId} 不存在`)
        // 顺延基准：团队仍在有效期 = 当前到期日；GRACE/ARCHIVED = now（恢复新起一期）
        const base =
          team.status === TeamStatus.ACTIVE && team.expiresAt > now ? team.expiresAt : now
        const newExpiry = new Date(base.getTime() + plan.periodDays * DAY_MS)
        // 池积分入账（与 TeamPoolService.grantPool 同口径：PACKAGE+GIFT 两批次一条流水）
        const lots = [
          { bucket: "PACKAGE" as const, amount: plan.packageCredits },
          { bucket: "GIFT" as const, amount: plan.giftCredits },
        ].filter(l => l.amount > 0)
        let total = 0
        for (const lot of lots) {
          await tx.creditLot.create({
            data: {
              userId: team.adminId,
              teamId,
              bucket: lot.bucket,
              amount: lot.amount,
              remaining: lot.amount,
              expiresAt: newExpiry,
              sourceType: "RECHARGE_PLAN",
              sourceRef: `scheduledPlan:${plan.id}`,
              status: "ACTIVE",
            },
          })
          total += lot.amount
        }
        if (total > 0) {
          await tx.creditTransaction.create({
            data: {
              userId: team.adminId,
              teamId,
              direction: "CREDIT",
              bucket: null,
              type: "TEAM_RECHARGE",
              amount: total,
              source: "migrate.renewal",
              meta: {
                tier: plan.tier,
                planName: plan.planName,
                migratedFrom: "scheduledPlan",
                scheduledPlanId: plan.id,
              },
            },
          })
        }
        await tx.team.update({
          where: { id: teamId },
          data: {
            status: TeamStatus.ACTIVE,
            tier: plan.tier,
            expiresAt: newExpiry,
            graceUntil: graceUntilOf(newExpiry),
            dataKeepUntil: dataKeepUntilOf(newExpiry),
            archivedAt: null,
          },
        })
      },
      { timeout: 60000 } // 远程库高延迟：放宽交互事务超时
    )
    teamDone++
    console.log(`团队排队单 #${plan.id}（团队 ${teamId} ${plan.planName}）已立即激活`)
  }

  console.log(`完成：个人 ${personalDone} 笔、团队 ${teamDone} 笔。`)
  await prisma.$disconnect()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
