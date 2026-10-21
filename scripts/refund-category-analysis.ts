/**
 * 精准修复 2026-09-16 类目分析 #3 在调用 AI 前失败却预扣 20 积分的问题。
 * 默认只读；仅允许 agent-api-dev3 的已核实个人 RECHARGE 流水 #922。
 *
 * node --env-file=.env -r ts-node/register scripts/refund-category-analysis.ts --analysis-id 3
 * node --env-file=.env -r ts-node/register scripts/refund-category-analysis.ts --analysis-id 3 --apply
 *
 * 不推广为通用退款：旧消费没有逐批次映射，套餐/赠送到期时间不能从流水推测。
 */
import { CreditBucket, CreditDirection, CreditTxnType, Prisma } from "@prisma/client"
import { CreditService } from "../src/membership/credit.service"
import { PrismaService } from "../src/prisma/prisma.service"

const DATABASE_NAME = "agent-api-dev3"
const ANALYSIS_ID = 3
const USER_ID = 3
const TRANSACTION_ID = 922
const USAGE_LOG_ID = 2625
const SOURCE = "category.analysis"
const REFUND_ID = "category-analysis:3:922"
const REFUND_CREDITS = new Prisma.Decimal(20)
const REFUND_REASON = "类目分析在调用 AI 前因数据服务配额耗尽失败，返还误预扣积分"

interface RefundOptions {
  analysisId: number
  shouldApply: boolean
}

interface RefundResult {
  database: string
  analysisId: number
  userId: number
  originalTransactionId: number
  usageLogId: number
  refundedCredits: string
  status: "dry-run" | "refunded" | "already-refunded"
  refundTransactionId?: number
  balanceAfter?: string
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`拒绝退款：${message}`)
}

function readMeta(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

export function parseRefundOptions(args: string[]): RefundOptions {
  const hasApply = args.includes("--apply")
  const hasDryRun = args.includes("--dry-run")
  requireCondition(!(hasApply && hasDryRun), "--apply 与 --dry-run 不可同时使用")
  const remainingArgs = args.filter(arg => arg !== "--apply" && arg !== "--dry-run")
  requireCondition(
    remainingArgs.length === 2 && remainingArgs[0] === "--analysis-id" && remainingArgs[1] === "3",
    "仅支持 --analysis-id 3 [--dry-run | --apply]"
  )
  return { analysisId: ANALYSIS_ID, shouldApply: hasApply }
}

export function validateRefundEnvironment(environment: NodeJS.ProcessEnv): void {
  requireCondition(environment.NODE_ENV === "development", "NODE_ENV 必须为 development")
  let databaseName: string | undefined
  try {
    databaseName = new URL(environment.DATABASE_URL ?? "").pathname.slice(1)
  } catch {
    // 不输出连接字符串或底层 URL 异常，避免泄露连接凭据。
  }
  requireCondition(databaseName === DATABASE_NAME, `仅允许开发库 ${DATABASE_NAME}`)
}

export async function refundCategoryAnalysis(
  prisma: PrismaService,
  credit: CreditService,
  options: RefundOptions
): Promise<RefundResult> {
  requireCondition(options.analysisId === ANALYSIS_ID, "仅支持已核实的任务 #3")
  return prisma.$transaction(
    async tx => {
      const databases = await tx.$queryRaw<Array<{ databaseName: string }>>`
        SELECT DATABASE() AS databaseName
      `
      requireCondition(databases[0]?.databaseName === DATABASE_NAME, "实际连接的库不是指定开发库")
      if (options.shouldApply) {
        // 同一任务的并发修复串行化；后续核验使用 ReadCommitted 当前状态。
        await tx.$queryRaw`SELECT id FROM CategoryAnalysisRecord WHERE id = ${ANALYSIS_ID} FOR UPDATE`
        await tx.$queryRaw`SELECT id FROM User WHERE id = ${USER_ID} FOR UPDATE`
        await tx.$queryRaw`SELECT id FROM CreditTransaction WHERE id = ${TRANSACTION_ID} FOR UPDATE`
        await tx.$queryRaw`SELECT id FROM UsageLog WHERE id = ${USAGE_LOG_ID} FOR UPDATE`
      }

      const record = await tx.categoryAnalysisRecord.findUnique({ where: { id: ANALYSIS_ID } })
      requireCondition(
        record?.userId === USER_ID && !record.deletedAt,
        "任务所属用户或可见状态不符"
      )
      requireCondition(record.status === "FAILED", "任务未处于失败状态")
      requireCondition(Array.isArray(record.result) && record.result.length === 0, "任务已有报告")
      requireCondition(record.error === "数据服务配额已用完", "失败原因与已核实记录不符")

      const transactions = await tx.creditTransaction.findMany({
        where: {
          OR: [
            { id: TRANSACTION_ID },
            { source: SOURCE, meta: { path: "$.analysisId", equals: ANALYSIS_ID } },
            { meta: { path: "$.refundId", equals: REFUND_ID } },
            { meta: { path: "$.refundOfTransactionId", equals: TRANSACTION_ID } },
          ],
        },
        orderBy: { id: "asc" },
      })
      const original = transactions.find(transaction => transaction.id === TRANSACTION_ID)
      requireCondition(original, "原扣费流水不存在")
      const originalMeta = readMeta(original.meta)
      requireCondition(
        original.userId === USER_ID && original.relatedUserId === null && original.teamId === null,
        "原扣费不是用户本人的个人账户"
      )
      requireCondition(
        original.source === SOURCE &&
          originalMeta.analysisId === ANALYSIS_ID &&
          originalMeta.requestId === record.requestId &&
          originalMeta.pricing === "fixed_20" &&
          original.direction === CreditDirection.DEBIT &&
          original.bucket === CreditBucket.RECHARGE &&
          original.amount.equals(REFUND_CREDITS) &&
          original.invokeType === "PLATFORM",
        "原扣费来源、金额、桶或请求标识不符"
      )

      const logs = await tx.usageLog.findMany({
        where: {
          OR: [
            { id: USAGE_LOG_ID },
            { source: SOURCE, meta: { path: "$.analysisId", equals: ANALYSIS_ID } },
          ],
        },
      })
      requireCondition(logs.length === 1 && logs[0].id === USAGE_LOG_ID, "用量记录不唯一或编号不符")
      const usageLog = logs[0]
      const usageMeta = readMeta(usageLog.meta)
      requireCondition(
        usageLog.userId === USER_ID &&
          usageLog.source === SOURCE &&
          usageMeta.analysisId === ANALYSIS_ID &&
          usageMeta.requestId === record.requestId &&
          usageMeta.pricing === "fixed_20" &&
          usageLog.cost.isZero() &&
          (usageLog.promptTokens ?? 0) === 0 &&
          (usageLog.completionTokens ?? 0) === 0 &&
          (usageLog.thinkingTokens ?? 0) === 0,
        "用量所属用户、请求或实际 AI 成本不符"
      )

      const result: RefundResult = {
        database: DATABASE_NAME,
        analysisId: ANALYSIS_ID,
        userId: USER_ID,
        originalTransactionId: TRANSACTION_ID,
        usageLogId: USAGE_LOG_ID,
        refundedCredits: REFUND_CREDITS.toString(),
        status: "dry-run",
      }
      const refunds = transactions.filter(transaction => transaction.id !== TRANSACTION_ID)
      if (record.credits.isZero()) {
        requireCondition(refunds.length === 1, "已清零任务的退款审计不唯一")
        const refund = refunds[0]
        const refundMeta = readMeta(refund.meta)
        requireCondition(
          usageLog.credits?.isZero() &&
            usageMeta.refundId === REFUND_ID &&
            usageMeta.refundedCredits === "20" &&
            usageMeta.refundTransactionId === refund.id &&
            original.type === CreditTxnType.MANUAL_ADJUST &&
            originalMeta.originalType === CreditTxnType.CONSUME &&
            originalMeta.refundId === REFUND_ID &&
            originalMeta.refundTransactionId === refund.id &&
            refund.userId === USER_ID &&
            refund.teamId === null &&
            refund.relatedUserId === null &&
            refund.direction === CreditDirection.CREDIT &&
            refund.type === CreditTxnType.MANUAL_ADJUST &&
            refund.bucket === CreditBucket.RECHARGE &&
            refund.amount.equals(REFUND_CREDITS) &&
            refund.source === SOURCE &&
            refundMeta.operation === "refund" &&
            refundMeta.refundId === REFUND_ID &&
            refundMeta.refundOfTransactionId === TRANSACTION_ID &&
            refund.lotId !== null,
          "已有退款的流水、净扣费或幂等标识不一致"
        )
        const lot = await tx.creditLot.findUnique({ where: { id: refund.lotId } })
        requireCondition(
          lot?.userId === USER_ID &&
            lot.teamId === null &&
            lot.bucket === CreditBucket.RECHARGE &&
            lot.expiresAt === null &&
            lot.amount.equals(REFUND_CREDITS) &&
            lot.sourceRef === REFUND_ID,
          "退款批次所属账户或原桶不符"
        )
        return { ...result, status: "already-refunded", refundTransactionId: refund.id }
      }

      requireCondition(
        record.credits.equals(REFUND_CREDITS) &&
          usageLog.credits?.equals(REFUND_CREDITS) &&
          original.type === CreditTxnType.CONSUME &&
          !originalMeta.refundId &&
          !usageMeta.refundId,
        "当前净扣费或原流水状态不符"
      )
      // 仅支持这次确定的个人充值桶误扣。任何返利、共享、企业分段或已有补偿均拒绝自动处理。
      requireCondition(refunds.length === 0, "存在其它关联流水（返利、共享、企业扣费或已有退款）")
      if (!options.shouldApply) return result

      await credit.lockPersonalBalancesInTx(tx, USER_ID)
      const balanceBefore = await credit.consumableBalance(tx, USER_ID)
      const refundedAt = new Date().toISOString()
      const refundMeta = {
        analysisId: ANALYSIS_ID,
        requestId: record.requestId,
        refundId: REFUND_ID,
        refundOfTransactionId: TRANSACTION_ID,
        originalCredits: "20",
        refundedCredits: "20",
        refundedAt,
        refundReason: REFUND_REASON,
        operation: "refund",
      }
      const lot = await credit.grant(
        USER_ID,
        CreditBucket.RECHARGE,
        REFUND_CREDITS,
        {
          type: CreditTxnType.MANUAL_ADJUST,
          expiresAt: null,
          sourceRef: REFUND_ID,
          source: SOURCE,
          meta: refundMeta,
        },
        tx
      )
      const refund = await tx.creditTransaction.findFirstOrThrow({
        where: { lotId: lot.id, source: SOURCE, direction: CreditDirection.CREDIT },
      })
      const balanceAfter = await credit.consumableBalance(tx, USER_ID)
      requireCondition(
        balanceAfter.minus(balanceBefore).equals(REFUND_CREDITS),
        "实际到账积分不是 20"
      )
      const repairMeta = { ...refundMeta, refundTransactionId: refund.id }

      // 金额/方向/时间/原扣后余额不改。取消误扣的消费分类，避免现有按 CONSUME 聚合的累计消耗仍计 20。
      await tx.creditTransaction.update({
        where: { id: TRANSACTION_ID },
        data: {
          type: CreditTxnType.MANUAL_ADJUST,
          meta: {
            ...originalMeta,
            ...repairMeta,
            operation: "reversed-precharge",
            originalType: CreditTxnType.CONSUME,
          },
        },
      })
      await tx.usageLog.update({
        where: { id: USAGE_LOG_ID },
        data: {
          credits: 0,
          meta: { ...usageMeta, ...repairMeta, operation: "refunded-precharge" },
        },
      })
      await tx.categoryAnalysisRecord.update({
        where: { id: ANALYSIS_ID },
        data: { credits: 0 },
      })
      return {
        ...result,
        status: "refunded",
        refundTransactionId: refund.id,
        balanceAfter: balanceAfter.toString(),
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30000 }
  )
}

async function main() {
  const options = parseRefundOptions(process.argv.slice(2))
  validateRefundEnvironment(process.env)
  const prisma = new PrismaService()
  try {
    console.log(
      JSON.stringify(await refundCategoryAnalysis(prisma, new CreditService(prisma), options))
    )
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    // Prisma 的底层连接异常可能带主机/用户名；只输出本脚本的固定校验原因。
    console.error(
      error instanceof Error && error.message.startsWith("拒绝退款：")
        ? error.message
        : "退款脚本未能确认完成，请重新运行只读检查确认状态。"
    )
    process.exitCode = 1
  })
}
