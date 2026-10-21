/**
 * 存量修复：宽限期（GRACE）团队被每日任务误回收的套餐/赠送批次恢复（2026-08-29 生命周期 bug）。
 * 背景：修复前 expireLots 不区分个人/团队批次——团队套餐/赠送批次随团队同日到期，
 * 团队一进宽限期批次即被系统回收（source=system.expire），导致宽限期内续费无法完整恢复。
 * 代码修复后每日任务不再清团队批次（归档时由 archiveTeamPool 统一清零），
 * 本脚本把已误回收的批次恢复：remaining 回写、status 回 ACTIVE（expiresAt 维持原到期日——
 * GRACE 期池口径本就不计入；续费恢复时 restoreTeam 会统一顺延到新有效期）。
 * 每批回滚写一条 MANUAL_ADJUST 补偿流水（幂等：仅处理 remaining=0 且 EXPIRED 的批次，重跑不再命中）。
 * 用法：
 *   TS_NODE_TRANSPILE_ONLY=true npx ts-node scripts/restore-grace-team-lots.ts --dry-run   # 先看影响面
 *   TS_NODE_TRANSPILE_ONLY=true npx ts-node scripts/restore-grace-team-lots.ts             # 正式修复
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

async function main() {
  const teams = await prisma.team.findMany({
    where: { status: "GRACE" },
    select: { id: true, name: true, expiresAt: true },
    orderBy: { id: "asc" },
  })
  console.log(`当前 GRACE 团队 ${teams.length} 个`)

  let restoredLots = 0
  let restoredCredits = 0
  for (const team of teams) {
    // 误回收口径：团队批次 + 到期后（含当日）被 system.expire 清零（归档清理走 team.archive，不在此列）
    const wipes = await prisma.creditTransaction.findMany({
      where: {
        teamId: team.id,
        type: "EXPIRE",
        source: "system.expire",
        lotId: { not: null },
        createdAt: { gte: team.expiresAt },
      },
      select: { id: true, lotId: true, amount: true, bucket: true, createdAt: true },
      orderBy: { id: "asc" },
    })
    for (const w of wipes) {
      const lot = await prisma.creditLot.findUnique({
        where: { id: w.lotId! },
        select: { id: true, bucket: true, remaining: true, status: true, expiresAt: true },
      })
      // 幂等闸：批次仍处被清零终态才恢复；桶一致性兜底（异常数据跳过）
      if (
        !lot ||
        lot.status !== "EXPIRED" ||
        Number(lot.remaining) !== 0 ||
        lot.bucket !== w.bucket
      )
        continue
      restoredLots++
      restoredCredits += Number(w.amount)
      console.log(
        `  团队 #${team.id}（${team.name ?? "未命名"}）：批次 #${lot.id} ${lot.bucket} 恢复 ${w.amount.toString()} 积分` +
          `（原到期 ${lot.expiresAt?.toISOString().slice(0, 10)}，回收流水 #${w.id}）`
      )
      if (!dryRun) {
        await prisma.$transaction(async tx => {
          // 条件更新兜底并发：仍 remaining=0 才回写
          const res = await tx.creditLot.updateMany({
            where: { id: lot.id, status: "EXPIRED", remaining: 0 },
            data: { remaining: w.amount, status: "ACTIVE" },
          })
          if (!res.count) return
          // 补偿流水（CREDIT 留痕）；balanceAfter 记池可消费余额——恢复批次已过期不计入池，余额不变
          const poolAgg = await tx.creditLot.aggregate({
            where: {
              teamId: team.id,
              status: "ACTIVE",
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            _sum: { remaining: true },
          })
          await tx.creditTransaction.create({
            data: {
              userId: (
                await tx.team.findUniqueOrThrow({
                  where: { id: team.id },
                  select: { adminId: true },
                })
              ).adminId,
              direction: "CREDIT",
              bucket: lot.bucket,
              type: "MANUAL_ADJUST",
              amount: w.amount,
              balanceAfter: poolAgg._sum.remaining ?? 0,
              lotId: lot.id,
              teamId: team.id,
              source: "script.restore-grace-lots",
              meta: {
                repairOf: w.id,
                reason: "宽限期团队批次被每日任务误回收，回滚恢复（宽限期保留口径）",
              },
            },
          })
        })
      }
    }
  }

  console.log(
    dryRun
      ? `[dry-run] 将恢复 ${restoredLots} 个批次、共 ${restoredCredits} 积分`
      : `完成：恢复 ${restoredLots} 个批次、共 ${restoredCredits} 积分`
  )
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
