/**
 * 一次性数据修复（2026-08-29，QA 回归10）：TEAM_PLAN 结算时 packChoice=inject 未生效期间，
 * 个人 RECHARGE 存量滞留在个人户的，按 transferRechargeLotsToTeam 同口径补注入企业共享池：
 * 个人批次清零（EXHAUSTED）+ 合并一条 DEBIT 流水；池侧新建 RECHARGE 批次 + 一条 CREDIT 流水（balanceAfter=池余额）。
 * 幂等：个人侧无可转批次时直接跳过。用法：
 *   npx tsx scripts/fix-teamplan-inject.ts --dry-run -- --user 108 --team 32 --order SR20260829082606197
 *   npx tsx scripts/fix-teamplan-inject.ts --user 108 --team 32 --order SR20260829082606197
 */
import { PrismaClient } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")
const argOf = (k: string) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : null
}
const USER_ID = Number(argOf("user"))
const TEAM_ID = Number(argOf("team"))
const ORDER_NO = argOf("order")
if (!USER_ID || !TEAM_ID || !ORDER_NO) {
  console.error(
    "用法: npx tsx scripts/fix-teamplan-inject.ts [--dry-run] --user <id> --team <id> --order <orderNo>"
  )
  process.exit(1)
}

async function main() {
  // timeout 15s：远程库高延迟，默认 5s 不够（同 createCustomTeam 的处理）
  await prisma.$transaction(
    async tx => {
      const lots = await tx.creditLot.findMany({
        where: {
          userId: USER_ID,
          teamId: null,
          bucket: "RECHARGE",
          status: "ACTIVE",
          remaining: { gt: 0 },
        },
        orderBy: { id: "asc" },
        select: { id: true, remaining: true },
      })
      const total = lots.reduce((s, l) => s.plus(l.remaining), new Decimal(0))
      if (lots.length === 0 || total.lessThanOrEqualTo(0)) {
        console.log(`用户 ${USER_ID} 个人 RECHARGE 无可转批次，跳过（幂等）`)
        return
      }
      console.log(
        `用户 ${USER_ID} → 团队 ${TEAM_ID}：注入 ${total.toString()}（批次 ${lots.map(l => l.id).join("/")}）${dryRun ? "（dry-run，不写入）" : ""}`
      )
      if (dryRun) return

      for (const lot of lots) {
        await tx.creditLot.update({
          where: { id: lot.id },
          data: { remaining: 0, status: "EXHAUSTED" },
        })
      }
      // 个人侧余额（清零后个人 RECHARGE 合计）
      const personalAgg = await tx.creditLot.aggregate({
        where: { userId: USER_ID, teamId: null, bucket: "RECHARGE", status: "ACTIVE" },
        _sum: { remaining: true },
      })
      await tx.creditTransaction.create({
        data: {
          userId: USER_ID,
          direction: "DEBIT",
          bucket: "RECHARGE",
          type: "MANUAL_ADJUST",
          amount: total,
          balanceAfter: personalAgg._sum.remaining ?? 0,
          source: "billing.order",
          meta: { orderNo: ORDER_NO, injectToTeamId: TEAM_ID, repair: "fix-teamplan-inject" },
        },
      })
      // 池侧：新建 RECHARGE 批次 + CREDIT 流水（balanceAfter=池余额）
      await tx.creditLot.create({
        data: {
          userId: USER_ID,
          teamId: TEAM_ID,
          bucket: "RECHARGE",
          amount: total,
          remaining: total,
          expiresAt: null,
          sourceType: "TEAM_RECHARGE",
          status: "ACTIVE",
        },
      })
      const poolAgg = await tx.creditLot.aggregate({
        where: {
          teamId: TEAM_ID,
          status: "ACTIVE",
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        _sum: { remaining: true },
      })
      await tx.creditTransaction.create({
        data: {
          userId: USER_ID,
          direction: "CREDIT",
          bucket: null,
          type: "TEAM_RECHARGE",
          amount: total,
          balanceAfter: poolAgg._sum.remaining ?? 0,
          source: "billing.order",
          teamId: TEAM_ID,
          meta: { orderNo: ORDER_NO, injectedFromPersonal: true, repair: "fix-teamplan-inject" },
        },
      })
      console.log(`完成：池余额 ${poolAgg._sum.remaining?.toString()}`)
    },
    { timeout: 15000 }
  )
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
