/**
 * 一次性回填：历史 UsageLog 行的「积分 credits」字段（积分 = 人民币成本 cost × 10，向上取整）。
 *
 * 背景：credits 列是「积分体系」上线后才加的，旧数据 credits=null（schema 注释亦有说明）。
 *       所有积分看板（usage/stats-by-user、/sources、/stats-summary）都按 credits 聚合，
 *       导致老用户/老 source 的 totalConsumed 恒为 0。本脚本把历史消耗换算成积分补上。
 *
 * 口径：credits = CEIL(cost × 10)，与实时扣费 ceil(cost_cny × 10 × discount) 对齐
 *       （历史无折扣，discount 视为 1；每条调用各自向上取整，和实时一致）。
 *       不动 balanceAfter（历史快照，看板不依赖）。
 *
 * 用法：
 *   npx ts-node scripts/backfill-usagelog-credits.ts --dry-run   # 预览，不写库（强烈建议先跑）
 *   npx ts-node scripts/backfill-usagelog-credits.ts             # 实际执行
 *
 * 幂等：只更新 credits IS NULL 的行；已回填/新写入的行不受影响，可安全重复执行。
 * ⚠️ 前置：先 npx prisma db push 应用新字段；建议先备份。
 */
import { PrismaClient } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"

const prisma = new PrismaClient()

const CREDIT_PER_CNY = 10

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  console.log(`=== UsageLog 积分回填${dryRun ? "（DRY-RUN 预览，不写库）" : ""} ===`)

  const [pending, agg] = await Promise.all([
    prisma.usageLog.count({ where: { credits: null } }),
    prisma.usageLog.aggregate({ where: { credits: null }, _sum: { cost: true } }),
  ])
  const approxCredits = new Decimal(agg._sum.cost ?? 0).mul(CREDIT_PER_CNY)
  console.log(
    `待回填行数（credits 为 null）：${pending}｜这些行人民币成本合计：${(agg._sum.cost ?? new Decimal(0)).toString()}｜约合积分：${approxCredits.toString()}（未计逐行向上取整）`
  )

  if (pending === 0) {
    console.log("没有需要回填的行，结束。")
    return
  }

  if (dryRun) {
    console.log("（DRY-RUN：未写入任何数据，去掉 --dry-run 正式执行）")
    return
  }

  // 单条 SQL 逐行换算：credits = CEIL(cost × 10)，只动 credits 为 null 的行。
  const affected = await prisma.$executeRaw`
    UPDATE \`UsageLog\` SET \`credits\` = CEIL(\`cost\` * ${CREDIT_PER_CNY}) WHERE \`credits\` IS NULL
  `
  console.log(`\n完成：回填 ${affected} 行。`)
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => void prisma.$disconnect())
