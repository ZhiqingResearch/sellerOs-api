/**
 * 存量池段返利行补 teamId（2026-09-01 树卷起配套回填）：
 * 2026-09-01 起企业池段返利结算时 REBATE_IN 行落 teamId（consumeTeamInTx 透传），分销关系树据此把
 * 池返利卷起到企业管理员节点。此前的存量池返利行 teamId=null，树卷起会漏掉它们。
 * 识别口径：REBATE_IN（teamId 为空）的 relatedUserId（消费者）在同一秒级窗口（±5s）内有 TEAM_CONSUME
 * 行 → 该返利即这笔池消费产生，回填其 teamId。窗口内有多支不同企业的池消费则跳过（不猜）。
 * 幂等（只处理 teamId=null）。
 *
 * 性能说明（2026-09-01 二版）：识别/计数/回填全部下推数据库——窗口匹配用一次 JOIN+GROUP BY
 * （c 侧走 (userId, createdAt) 索引），回填用单条 UPDATE...JOIN（子查询同识别口径，HAVING 去歧义，
 * 外层 teamId IS NULL 护栏保证幂等）。全程 3 条 SQL，与数据量无关；此前逐行查询版本在
 * 1.9 万行返利的环境要近 2 万次往返。
 * 用法：
 *   npx tsx scripts/backfill-rebate-team-id.ts --dry-run   # 先看影响面
 *   npx tsx scripts/backfill-rebate-team-id.ts             # 正式回填
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

// 识别子查询：窗口内仅 1 支企业池消费（HAVING 去歧义）的待回填返利行
const MATCH_SUBQUERY = `
  SELECT r2.id, MIN(c.teamId) AS teamId
  FROM CreditTransaction r2
  JOIN CreditTransaction c
    ON c.userId = r2.relatedUserId
   AND c.type = 'TEAM_CONSUME'
   AND c.teamId IS NOT NULL
   AND c.createdAt BETWEEN r2.createdAt - INTERVAL 5 SECOND AND r2.createdAt + INTERVAL 5 SECOND
  WHERE r2.type = 'REBATE_IN'
    AND r2.teamId IS NULL
    AND r2.relatedUserId IS NOT NULL
  GROUP BY r2.id
  HAVING COUNT(DISTINCT c.teamId) = 1
`

// dry-run 展示 / 正式回填的日志来源（带子查询结果字段）
const MATCH_SELECT = `
  SELECT r.id, r.userId, r.relatedUserId, r.amount, m.teamId
  FROM (${MATCH_SUBQUERY}) m
  JOIN CreditTransaction r ON r.id = m.id
  ORDER BY r.id
`

// 正式回填：单条 UPDATE...JOIN（外层 teamId IS NULL 护栏，幂等可重跑）
const BACKFILL_UPDATE = `
  UPDATE CreditTransaction r
  JOIN (${MATCH_SUBQUERY}) m ON m.id = r.id
  SET r.teamId = m.teamId
  WHERE r.teamId IS NULL
`

interface MatchedRow {
  id: number
  userId: number
  relatedUserId: number
  amount: unknown
  teamId: number | bigint
}

async function main() {
  // 待甄别总数（含跳过项，用于「跳过」计数）
  const totalRows = await prisma.$queryRaw<{ cnt: bigint }[]>`
    SELECT COUNT(*) AS cnt FROM CreditTransaction
    WHERE type = 'REBATE_IN' AND teamId IS NULL AND relatedUserId IS NOT NULL
  `
  const total = Number(totalRows[0]?.cnt ?? 0)
  console.log(`待甄别 REBATE_IN（teamId=null）${total} 条${dryRun ? "（dry-run，不写入）" : ""}`)
  if (!total) {
    console.log("无待处理行，完成")
    return
  }

  const matched = await prisma.$queryRawUnsafe<MatchedRow[]>(MATCH_SELECT)
  for (const r of matched) {
    console.log(
      `  #${r.id} 返利 ${String(r.amount)} → 收款人 ${r.userId}，消费者 ${r.relatedUserId}，回填 teamId=${Number(r.teamId)}`
    )
  }

  let written = 0
  if (!dryRun && matched.length) {
    written = await prisma.$executeRawUnsafe(BACKFILL_UPDATE)
  }
  console.log(
    `${dryRun ? "dry-run 完成" : "回填完成"}：匹配 ${matched.length} 条` +
      (dryRun ? "" : `（实写 ${written} 条）`) +
      `，跳过 ${total - matched.length} 条（个人段或歧义）`
  )
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
