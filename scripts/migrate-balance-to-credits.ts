/**
 * 一次性迁移：存量用户「人民币余额 balance」→「充值积分 RECHARGE 批次」（积分 = 金额 × 10，永不过期）。
 *
 * 用法：
 *   npx ts-node scripts/migrate-balance-to-credits.ts --dry-run   # 预览，不写库（强烈建议先跑）
 *   npx ts-node scripts/migrate-balance-to-credits.ts             # 实际执行
 *
 * 规则（见 temp/会员充值后端实现方案.md §8）：
 *   - 每个 balance≠0 的用户建一个 RECHARGE 批次 = balance×10，并写一条 MANUAL_ADJUST 迁移流水
 *     （balance<0 → 负批次，结转旧系统无透支保护扣成的欠账，需充值填平才可用；balance=0 跳过）。
 *   - 不补发 200 体验积分（仅新注册送）；不处理邀请关系（等级 NONE / canInvite=false 由 db push 默认值就位）。
 *   - 不改写 user.balance（保留为历史事实，contract 阶段再删列）。
 *   - 幂等：已迁移过的用户（存在 sourceRef=MIGRATE_REF 的批次）跳过，可安全重复执行。
 *
 * ⚠️ 前置：先执行 npx prisma db push 应用新表/字段；建议先在库上做好备份再跑本脚本。
 */
import {
  CreditBucket,
  CreditDirection,
  CreditLotStatus,
  CreditTxnType,
  PrismaClient,
} from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"

const prisma = new PrismaClient()

const CREDIT_PER_CNY = 10
const MIGRATE_SOURCE = "migrate.balance"
const MIGRATE_REF = "migrate:balance-to-credits"

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  console.log(`=== 余额→积分迁移${dryRun ? "（DRY-RUN 预览，不写库）" : ""} ===`)

  const users = await prisma.user.findMany({ select: { id: true, username: true, balance: true } })
  console.log(`用户总数：${users.length}`)

  let migrated = 0
  let skipped = 0
  let zero = 0
  let negative = 0
  let totalCredits = new Decimal(0)

  for (const u of users) {
    const already = await prisma.creditLot.findFirst({
      where: { userId: u.id, sourceRef: MIGRATE_REF },
      select: { id: true },
    })
    if (already) {
      skipped++
      continue
    }

    const credits = new Decimal(u.balance).mul(CREDIT_PER_CNY)
    if (credits.isZero()) {
      zero++ // 余额正好为 0：无可迁移，跳过
      continue
    }
    // 负余额（旧系统无透支保护、可扣成负）也结转：建一个负 RECHARGE 批次（欠账），需充值填平才可用。
    // 扣费引擎已支持负批次——主消费只扣 remaining>0、调减显式「跳过欠账负批次」，但总额校验会算上它。
    const isNeg = credits.isNegative()

    if (!dryRun) {
      await prisma.$transaction(async tx => {
        const lot = await tx.creditLot.create({
          data: {
            userId: u.id,
            bucket: CreditBucket.RECHARGE,
            amount: credits,
            remaining: credits, // 负余额 → remaining 为负（欠账）
            expiresAt: null,
            sourceType: CreditTxnType.MANUAL_ADJUST,
            sourceRef: MIGRATE_REF,
            status: CreditLotStatus.ACTIVE,
          },
        })
        await tx.creditTransaction.create({
          data: {
            userId: u.id,
            direction: isNeg ? CreditDirection.DEBIT : CreditDirection.CREDIT,
            bucket: CreditBucket.RECHARGE,
            type: CreditTxnType.MANUAL_ADJUST,
            amount: credits.abs(), // amount 存正向量级，正负由 direction 表达（与 grant/consume 一致）
            balanceAfter: credits, // 迁移前无积分批次，故迁移后 RECHARGE 余额 = credits（负余额则为负）
            source: MIGRATE_SOURCE,
            lotId: lot.id,
            meta: { migratedFromBalanceCny: u.balance.toString() },
          },
        })
      })
    }

    migrated++
    if (isNeg) negative++
    totalCredits = totalCredits.plus(credits)
  }

  console.log(
    `\n结果：迁移 ${migrated} 人（合计 ${totalCredits.toString()} 积分${negative ? `，含负余额结转 ${negative} 人` : ""}）｜跳过(已迁移) ${skipped} 人｜余额=0 跳过 ${zero} 人`
  )
  if (dryRun) console.log("（DRY-RUN：未写入任何数据，去掉 --dry-run 正式执行）")
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => void prisma.$disconnect())
