import { CreditLot, CreditTransaction, Prisma } from "@prisma/client"
import {
  parseRefundOptions,
  refundCategoryAnalysis,
  validateRefundEnvironment,
} from "../../scripts/refund-category-analysis"
import { CreditService } from "../membership/credit.service"
import { PrismaService } from "../prisma/prisma.service"

function setup() {
  const meta = { analysisId: 3, requestId: "original-request", pricing: "fixed_20" }
  const original: CreditTransaction = {
    id: 922,
    userId: 3,
    direction: "DEBIT",
    bucket: "RECHARGE",
    type: "CONSUME",
    amount: new Prisma.Decimal(20),
    balanceAfter: new Prisma.Decimal("5285.867"),
    source: "category.analysis",
    invokeType: "PLATFORM",
    lotId: null,
    relatedUserId: null,
    teamId: null,
    meta,
    createdAt: new Date("2026-09-16T05:50:28Z"),
  }
  const state = {
    record: {
      id: 3,
      userId: 3,
      requestId: "original-request",
      status: "FAILED",
      credits: new Prisma.Decimal(20),
      error: "数据服务配额已用完",
      result: [] as unknown[],
      deletedAt: null,
    },
    usage: {
      id: 2625,
      userId: 3,
      source: "category.analysis",
      meta: meta as Prisma.JsonValue,
      credits: new Prisma.Decimal(20),
      cost: new Prisma.Decimal(0),
      promptTokens: null as number | null,
      completionTokens: null,
      thinkingTokens: null,
    },
    transactions: [original],
    lots: [] as CreditLot[],
  }
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ databaseName: "agent-api-dev3" }]),
    categoryAnalysisRecord: {
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(state.record)),
      update: jest.fn().mockImplementation(({ data }: { data: { credits: number } }) => {
        state.record = { ...state.record, credits: new Prisma.Decimal(data.credits) }
        return Promise.resolve(state.record)
      }),
    },
    usageLog: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve([state.usage])),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: { credits: number; meta: Prisma.JsonValue } }) => {
          state.usage = {
            ...state.usage,
            credits: new Prisma.Decimal(data.credits),
            meta: data.meta,
          }
          return Promise.resolve(state.usage)
        }),
    },
    creditLot: {
      aggregate: jest.fn().mockImplementation(() =>
        Promise.resolve({
          _sum: {
            remaining: state.lots.reduce(
              (sum, lot) => sum.plus(lot.remaining),
              new Prisma.Decimal("5285.867")
            ),
          },
        })
      ),
      create: jest.fn().mockImplementation(({ data }: { data: CreditLot }) => {
        const lot = {
          ...data,
          id: 1001,
          amount: new Prisma.Decimal(data.amount),
          remaining: new Prisma.Decimal(data.remaining),
          createdAt: new Date(),
          updatedAt: new Date(),
          grantedAt: new Date(),
        } as CreditLot
        state.lots = [...state.lots, lot]
        return Promise.resolve(lot)
      }),
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(state.lots[0])),
    },
    creditTransaction: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(state.transactions)),
      create: jest.fn().mockImplementation(({ data }: { data: CreditTransaction }) => {
        const transaction = {
          ...data,
          id: 1002,
          amount: new Prisma.Decimal(data.amount),
          balanceAfter: data.balanceAfter === null ? null : new Prisma.Decimal(data.balanceAfter),
          relatedUserId: null,
          invokeType: "PLATFORM",
          createdAt: new Date(),
        } as CreditTransaction
        state.transactions = [...state.transactions, transaction]
        return Promise.resolve(transaction)
      }),
      findFirstOrThrow: jest
        .fn()
        .mockImplementation(() => Promise.resolve(state.transactions.find(row => row.id === 1002))),
      update: jest
        .fn()
        .mockImplementation(
          ({ data }: { data: { type: CreditTransaction["type"]; meta: Prisma.JsonValue } }) => {
            state.transactions = state.transactions.map(row =>
              row.id === 922 ? { ...row, ...data } : row
            )
            return Promise.resolve(state.transactions[0])
          }
        ),
    },
  }
  // 模拟事务回滚和数据库任务行锁的串行语义，测试业务幂等分支；真实行锁由 MySQL 提供。
  let previousTransaction = Promise.resolve()
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      const waiting = previousTransaction
      let finish: () => void = () => undefined
      previousTransaction = new Promise<void>(resolve => {
        finish = resolve
      })
      await waiting
      const before = { ...state }
      try {
        return await callback(tx)
      } catch (error) {
        Object.assign(state, before)
        throw error
      } finally {
        finish()
      }
    }),
  } as unknown as PrismaService
  const credit = new CreditService(prisma)
  const grant = jest.spyOn(credit, "grant")
  const run = (shouldApply = true) =>
    refundCategoryAnalysis(prisma, credit, { analysisId: 3, shouldApply })
  return { state, tx, prisma, credit, grant, run, original }
}

describe("类目分析已知错误预扣的精准修复", () => {
  it("默认 dry-run，严格限制任务编号及显式 apply", () => {
    expect(parseRefundOptions(["--analysis-id", "3"]).shouldApply).toBe(false)
    expect(parseRefundOptions(["--analysis-id", "3", "--apply"]).shouldApply).toBe(true)
    expect(() => parseRefundOptions(["--analysis-id", "4", "--apply"])).toThrow("仅支持")
    expect(() => parseRefundOptions(["--analysis-id", "3", "--apply", "--dry-run"])).toThrow(
      "不可同时"
    )
    expect(() =>
      validateRefundEnvironment({ NODE_ENV: "production", DATABASE_URL: "mysql://localhost/prod" })
    ).toThrow("development")
    expect(() =>
      validateRefundEnvironment({ NODE_ENV: "development", DATABASE_URL: "mysql://localhost/prod" })
    ).toThrow("仅允许开发库")
  })

  it("dry-run 只核查，任何钱包、流水、净扣费均不写入", async () => {
    const { run, state, tx, grant } = setup()
    expect((await run(false)).status).toBe("dry-run")
    expect(grant).not.toHaveBeenCalled()
    expect(tx.creditTransaction.update).not.toHaveBeenCalled()
    expect(tx.usageLog.update).not.toHaveBeenCalled()
    expect(tx.categoryAnalysisRecord.update).not.toHaveBeenCalled()
    expect(state.record.credits.toString()).toBe("20")
  })

  it.each(["数据库", "企业", "邀请共享", "赠送桶", "AI成本", "报告", "返利"])(
    "%s 与已核实范围不符时拒绝，绝不发放积分",
    async situation => {
      const { state, tx, run, grant, original } = setup()
      if (situation === "数据库") tx.$queryRaw.mockResolvedValue([{ databaseName: "prod" }])
      if (situation === "企业") state.transactions[0].teamId = 2
      if (situation === "邀请共享") state.transactions[0].relatedUserId = 3
      if (situation === "赠送桶") state.transactions[0].bucket = "GIFT"
      if (situation === "AI成本") state.usage.cost = new Prisma.Decimal("0.01")
      if (situation === "报告") state.record.result = [{ report: "已生成" }]
      if (situation === "返利")
        state.transactions.push({ ...original, id: 923, direction: "CREDIT", type: "REBATE_IN" })
      await expect(run()).rejects.toThrow("拒绝退款")
      expect(grant).not.toHaveBeenCalled()
      expect(state.lots).toHaveLength(0)
    }
  )

  it("原用户原 RECHARGE 桶到账20，保留原金额/方向/余额/时间并净清零消费统计", async () => {
    const { run, state, original } = setup()
    const result = await run()
    expect(result.status).toBe("refunded")
    expect(result.balanceAfter).toBe("5305.867")
    expect(state.lots).toHaveLength(1)
    expect(state.lots[0]).toMatchObject({
      userId: 3,
      teamId: null,
      bucket: "RECHARGE",
      expiresAt: null,
    })
    expect(state.lots[0].amount.toString()).toBe("20")
    expect({ ...state.transactions[0], type: original.type, meta: original.meta }).toEqual(original)
    expect(state.transactions[0].type).toBe("MANUAL_ADJUST")
    expect(state.transactions[0].meta).toMatchObject({
      originalType: "CONSUME",
      refundTransactionId: 1002,
    })
    expect(state.transactions[1]).toMatchObject({
      userId: 3,
      direction: "CREDIT",
      type: "MANUAL_ADJUST",
      bucket: "RECHARGE",
    })
    expect(state.transactions[1].meta).toMatchObject({
      refundOfTransactionId: 922,
      refundedCredits: "20",
    })
    expect(state.transactions.filter(row => row.type === "CONSUME")).toHaveLength(0)
    expect(state.record.credits.toString()).toBe("0")
    expect(state.usage.credits.toString()).toBe("0")
    expect(state.usage.meta).toMatchObject({ originalCredits: "20", refundedCredits: "20" })
  })

  it("两次并发调用经过任务行锁后仅一次退款", async () => {
    const { run, state, grant } = setup()
    const results = await Promise.all([run(), run()])
    expect(results.map(result => result.status)).toEqual(["refunded", "already-refunded"])
    expect(grant).toHaveBeenCalledTimes(1)
    expect(state.lots).toHaveLength(1)
    expect(state.transactions).toHaveLength(2)
  })

  it("净扣费更新失败时钱包入账和流水修正全部回滚", async () => {
    const { run, state, tx } = setup()
    tx.usageLog.update.mockRejectedValueOnce(new Error("模拟写入失败"))
    await expect(run()).rejects.toThrow("模拟写入失败")
    expect(state.lots).toHaveLength(0)
    expect(state.transactions).toHaveLength(1)
    expect(state.transactions[0].type).toBe("CONSUME")
    expect(state.record.credits.toString()).toBe("20")
    expect(state.usage.credits.toString()).toBe("20")
  })
})
