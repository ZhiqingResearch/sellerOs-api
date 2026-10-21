import { Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { PrismaService } from "../../prisma/prisma.service"
import { ChetaidouBillingService } from "../chetaidou-billing.service"
import { ChetaidouReconciliationService } from "./chetaidou-reconciliation.service"
import { ChetaidouTaskRunnerService } from "./chetaidou-task-runner.service"

describe("车泰斗待核对调用按实际账单结算", () => {
  function setup(kind: "TEXT" | "IMAGE") {
    const call = {
      id: "call",
      taskId: "task",
      kind,
      model: "frozen-model",
      state: "UNKNOWN",
      outcome: null,
      billingStatus: "REVIEW",
      gatewayRequestId: "request",
      gatewayTaskId: "image-task",
      submittedAt: new Date(Date.now() - 60 * 60_000),
    }
    const tx = {} as Prisma.TransactionClient
    const db = {
      $transaction: jest.fn((work: (tx: Prisma.TransactionClient) => Promise<void>) => work(tx)),
      chetaidouTask: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([{ id: "task" }]),
      },
      chetaidouCall: {
        findMany: jest.fn().mockResolvedValue([call]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const billing = {
      lookupTextUsage: jest.fn().mockResolvedValue(new Decimal(2)),
      lookupImageUsage: jest.fn().mockResolvedValue({ status: "running", amount: new Decimal(2) }),
      settleTextInTx: jest.fn(),
      settleImageInTx: jest.fn(),
    }
    const runner = {
      activeTaskIds: jest.fn().mockReturnValue(["slow-task"]),
      reconcileWaitingTasks: jest.fn().mockResolvedValue(undefined),
    }
    const service = new ChetaidouReconciliationService(
      db as unknown as PrismaService,
      billing as unknown as ChetaidouBillingService,
      runner as unknown as ChetaidouTaskRunnerService
    )
    return { call, db, billing, service, tx, runner }
  }

  it("定时核对同时恢复产物，在途慢任务不被超时扫描中断", async () => {
    const { service, runner, db } = setup("TEXT")
    await service.reconcile()
    expect(runner.reconcileWaitingTasks).toHaveBeenCalledTimes(1)
    expect(db.chetaidouTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "RUNNING",
          id: { notIn: ["slow-task"] },
        }) as unknown,
      })
    )
  })

  it("文本账单迟到仍继续查账，拿到金额后结算，不把待核对当作免费", async () => {
    const { service, billing, db, tx } = setup("TEXT")
    billing.lookupTextUsage.mockResolvedValueOnce(null)
    await service.reconcile()
    expect(billing.settleTextInTx).not.toHaveBeenCalled()
    expect(db.chetaidouCall.updateMany).toHaveBeenCalledWith({
      where: { id: "call", billingStatus: { in: ["PENDING", "REVIEW"] } },
      data: { billingStatus: "REVIEW", updatedAt: expect.any(Date) as unknown },
    })
    await service.reconcile()
    expect(billing.lookupTextUsage).toHaveBeenNthCalledWith(2, "request")
    expect(billing.settleTextInTx).toHaveBeenCalledTimes(1)
    expect(billing.settleTextInTx).toHaveBeenCalledWith(
      tx,
      { id: "call", model: "frozen-model" },
      new Decimal(2)
    )
  })

  it.each(["running", "succeeded", "failed", "canceled"])(
    "查询原图片任务状态为 %s，失败免扣，其余待核对按账单结算",
    async status => {
      const { service, billing, call, tx } = setup("IMAGE")
      billing.lookupImageUsage.mockResolvedValue({ status, amount: new Decimal(2) })
      await service.reconcile()
      expect(billing.lookupImageUsage).toHaveBeenCalledWith("image-task")
      expect(billing.lookupTextUsage).not.toHaveBeenCalled()
      expect(billing.settleImageInTx).toHaveBeenCalledWith(
        tx,
        call,
        new Decimal(2),
        ["failed", "canceled"].includes(status) ? false : "UNKNOWN"
      )
    }
  )
})
