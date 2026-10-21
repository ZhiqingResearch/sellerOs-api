/** 实库验证提交零扣费、模拟数据调用／AI 账单结算和幂等；所有写入强制回滚，无外部请求。 */
import { ConfigService } from "@nestjs/config"
import { Prisma } from "@prisma/client"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import "reflect-metadata"
import { CategoryAnalysisService } from "../src/category-analysis/category-analysis.service"
import { CategoryEvidenceProvider } from "../src/category-analysis/category-evidence.provider"
import type { AiGatewayProvider } from "../src/common/providers/ai-gateway.provider"
import { CreditService } from "../src/membership/credit.service"
import { PricingService } from "../src/pricing/pricing.service"
import { PrismaService } from "../src/prisma/prisma.service"
import { TeamModelConfigService } from "../src/team/team-model-config.service"
import { TeamPoolService } from "../src/team/team-pool.service"
import { TeamQuotaService } from "../src/team/team-quota.service"
import { FeatureRegistryService } from "../src/usage/feature-registry.service"
import { UsageService } from "../src/usage/usage.service"

async function main() {
  const expectedDatabase = process.argv[2]
  const userId = Number(process.argv[3])
  assert.equal(process.env.NODE_ENV, "development", "仅允许开发环境")
  assert.ok(
    expectedDatabase && Number.isInteger(userId) && userId > 0,
    "用法：node --env-file=.env -r ts-node/register scripts/check-category-analysis-database.ts <开发库名> <用户ID>"
  )
  const prisma = new PrismaService()
  const rollbackError = new Error("ROLLBACK_CATEGORY_DATABASE_CHECK")
  const requestId = randomUUID()
  let hasVerifiedTransaction = false
  try {
    const databases = await prisma.$queryRaw<
      { databaseName: string }[]
    >`SELECT DATABASE() AS databaseName`
    assert.equal(databases[0].databaseName, expectedDatabase, "实际库名与指定开发库不一致")
    const readSnapshot = async () => ({
      balance: (await new CreditService(prisma).getConsumableBalance(userId)).toString(),
      lots: await prisma.creditLot.findMany({
        where: { userId },
        orderBy: { id: "asc" },
        select: { id: true, remaining: true, status: true, expiresAt: true, updatedAt: true },
      }),
      categoryRecords: await prisma.categoryAnalysisRecord.count(),
      cacheRecords: await prisma.categoryAnalysisCache.count(),
      creditTransactions: await prisma.creditTransaction.count(),
      usageLogs: await prisma.usageLog.count(),
    })
    const before = await readSnapshot()
    try {
      await prisma.$transaction(
        async tx => {
          // 所有服务共用外层事务，内层不能提交。
          const transactionPrisma = new Proxy(prisma, {
            get(_target, property) {
              if (property === "$transaction") {
                return (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
                  callback(tx)
              }
              const member: unknown = Reflect.get(tx, property)
              return typeof member === "function"
                ? (member as (...args: unknown[]) => unknown).bind(tx)
                : member
            },
          })
          const credit = new CreditService(transactionPrisma)
          const usage = new UsageService(
            transactionPrisma,
            new PricingService(transactionPrisma),
            credit,
            new TeamQuotaService(
              transactionPrisma,
              credit,
              new TeamPoolService(transactionPrisma, credit)
            ),
            new FeatureRegistryService(transactionPrisma),
            new TeamModelConfigService(transactionPrisma)
          )
          const blockedProvider = new Proxy(
            {},
            {
              get() {
                throw new Error("数据库检查禁止调用外部数据或 AI 服务")
              },
            }
          )
          const service = new CategoryAnalysisService(
            transactionPrisma,
            blockedProvider as CategoryEvidenceProvider,
            blockedProvider as AiGatewayProvider,
            usage,
            new ConfigService({ AI_GATEWAY_API_KEY: "database-check-no-external-calls" })
          )
          let hasRequestedQueue = false
          service.processQueue = () => {
            hasRequestedQueue = true
            return Promise.resolve()
          }
          const result = await service.create(userId, {
            requestId,
            marketplace: "US",
            categories: [
              {
                nodeId: "3743981",
                nodeIdPath: "1055398:284507:3743981",
                name: "Kitchen Storage",
                path: "数据库事务回滚验证",
              },
            ],
          })
          const record = await tx.categoryAnalysisRecord.findUniqueOrThrow({
            where: { userId_requestId: { userId, requestId } },
          })
          assert.equal(result.id, record.id)
          assert.equal(record.credits.toNumber(), 0)
          assert.equal(await tx.usageLog.count(), before.usageLogs)
          assert.equal(await tx.creditTransaction.count(), before.creditTransactions)
          assert.equal((await credit.getConsumableBalance(userId)).toString(), before.balance)
          assert.ok(hasRequestedQueue)

          // 新版候选确认与持久缓存使用真实库，仍处于同一个回滚事务。
          await tx.categoryAnalysisRecord.update({
            where: { id: record.id },
            data: {
              status: "AWAITING_SELECTION",
              keywords: ["spice rack"],
              resolution: {
                candidates: [
                  {
                    categoryId: "3743981",
                    categoryName: "Storage",
                    hits: 8,
                    sales: 12000,
                    kws: ["spice rack"],
                    best: 0,
                  },
                ],
                topAsins: [],
                notices: [],
              },
            },
          })
          await service.confirmCandidates(userId, record.id, ["3743981"])
          await service.confirmCandidates(userId, record.id, ["3743981"])
          const confirmed = await service.findOne(userId, record.id)
          assert.equal(confirmed.status, "PENDING")
          assert.equal(confirmed.plan, "kw")
          assert.deepEqual(confirmed.keywords, ["spice rack"])
          assert.equal(confirmed.credits.toNumber(), 0)
          const cacheKey = `sif:rollback-check:${requestId}`
          const cacheProvider = new CategoryEvidenceProvider(new ConfigService(), transactionPrisma)
          const cachePayload = { sampleCount: 30 }
          const cacheStartedAt = Date.now()
          assert.deepEqual(
            await cacheProvider["_cached"](cacheKey, () => Promise.resolve(cachePayload)),
            cachePayload
          )
          const cacheWhere = { cacheKey: createHash("sha256").update(cacheKey).digest("hex") }
          const savedCache = await tx.categoryAnalysisCache.findUniqueOrThrow({ where: cacheWhere })
          assert.ok(savedCache.expiresAt.getTime() >= cacheStartedAt + 14 * 86400000)
          assert.ok(savedCache.expiresAt.getTime() <= Date.now() + 14 * 86400000)
          const restartedProvider = new CategoryEvidenceProvider(
            new ConfigService(),
            transactionPrisma
          )
          assert.deepEqual(
            await restartedProvider["_cached"](cacheKey, () => {
              throw new Error("缓存命中不应再次取数")
            }),
            cachePayload
          )
          const reusedCache = await tx.categoryAnalysisCache.findUniqueOrThrow({
            where: cacheWhere,
          })
          assert.equal(reusedCache.expiresAt.getTime(), savedCache.expiresAt.getTime())
          assert.equal(reusedCache.updatedAt.getTime(), savedCache.updatedAt.getTime())

          // 仅模拟一个已确定金额的 AI 账单，验证真实公共计费；事务结束前强制回滚。
          const leaseToken = randomUUID()
          await tx.categoryAnalysisRecord.update({
            where: { id: record.id },
            data: {
              status: "PROCESSING",
              leaseToken,
              leaseExpiresAt: new Date(Date.now() + 60000),
            },
          })
          const dataUsage = {
            totalCalls: 3,
            callDetail: { sif: 2, keepa: 1 },
            endpointCalls: { "sif:batchAsinDetail": 2, "keepa:product": 1 },
          }
          for (let attempt = 0; attempt < 2; attempt++)
            await service["_recordDataBilling"](
              record.id,
              userId,
              leaseToken,
              requestId,
              "3743981",
              dataUsage
            )
          const dataLogs = await tx.usageLog.findMany({
            where: {
              requestId: createHash("sha256")
                .update(`category-analysis:${record.id}:3743981:data`)
                .digest("hex"),
            },
          })
          assert.equal(dataLogs.length, 1)
          assert.equal(dataLogs[0].type, "MCP")
          assert.equal(dataLogs[0].mcpCalls, 3)
          const unitPrice = await new PricingService(transactionPrisma).getMcpCallPrice()
          assert.equal(dataLogs[0].cost.toString(), unitPrice.mul(3).toString())
          const dataRecord = await tx.categoryAnalysisRecord.findUniqueOrThrow({
            where: { id: record.id },
          })
          assert.equal(dataRecord.credits.toString(), dataLogs[0].credits?.toString())

          const billing = {
            costCny: "0.12",
            currency: "CNY" as const,
            model: "ZQ-Think-Flash",
            requestId,
            requestIds: [requestId],
          }
          await service["_recordBilling"](
            record.id,
            userId,
            leaseToken,
            requestId,
            "3743981",
            1,
            billing
          )
          await service["_recordBilling"](
            record.id,
            userId,
            leaseToken,
            requestId,
            "3743981",
            1,
            billing
          )
          const chargedRecord = await tx.categoryAnalysisRecord.findUniqueOrThrow({
            where: { id: record.id },
          })
          const logs = await tx.usageLog.findMany({
            where: {
              userId,
              source: "category.analysis",
              requestId,
            },
          })
          const transactions = await tx.creditTransaction.findMany({
            where: {
              source: "category.analysis",
              direction: "DEBIT",
              AND: [
                { meta: { path: "$.analysisId", equals: record.id } },
                { meta: { path: "$.businessEventId", equals: requestId } },
              ],
            },
          })
          assert.equal(logs.length, 1)
          assert.ok(chargedRecord.credits.greaterThan(0))
          assert.equal(
            logs[0].credits?.add(dataLogs[0].credits ?? 0).toString(),
            chargedRecord.credits.toString()
          )
          assert.ok(transactions.length > 0)
          assert.ok(transactions.every(item => item.invokeType === "PLATFORM"))
          assert.equal(
            transactions
              .reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0))
              .toNumber(),
            chargedRecord.credits.toNumber()
          )
          hasVerifiedTransaction = true
          // 无条件抛错：即使上述断言全部成功，也绝不提交测试任务或扣费。
          throw rollbackError
        },
        { timeout: 60000, maxWait: 10000 }
      )
    } catch (error) {
      if (error !== rollbackError) throw error
    }
    assert.ok(hasVerifiedTransaction, "事务未完成验证")
    const after = await readSnapshot()
    assert.deepEqual(after, before, "回滚后积分或记录数量发生变化，请检查是否有并发业务")
    assert.equal(await prisma.categoryAnalysisRecord.count({ where: { userId, requestId } }), 0)
    console.log(
      JSON.stringify({
        database: expectedDatabase,
        userId,
        transaction: "passed",
        creationCharge: "0",
        simulatedBillingIdempotency: "passed",
        dataCallBillingIdempotency: "passed",
        rollback: "passed",
        balanceBefore: before.balance,
        balanceAfter: after.balance,
        categoryRecords: after.categoryRecords,
        externalRequests: 0,
      })
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "数据库验证失败")
  process.exitCode = 1
})
