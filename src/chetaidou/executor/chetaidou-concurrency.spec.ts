import { Test } from "@nestjs/testing"
import { Prisma } from "@prisma/client"
import { AiGatewayProvider } from "../../ai-gateway/ai-gateway.provider"
import { ChetaidouGatewayReceiptService } from "../../ai-gateway/chetaidou-gateway-receipt.service"
import { PrismaService } from "../../prisma/prisma.service"
import { ChetaidouBillingService } from "../chetaidou-billing.service"
import { ChetaidouStorageService } from "../chetaidou-storage.service"
import { ChetaidouImageRunnerService } from "./chetaidou-image-runner.service"
import { ChetaidouReconciliationService } from "./chetaidou-reconciliation.service"
import { ChetaidouTaskRunnerService } from "./chetaidou-task-runner.service"

describe("车泰斗调度不设置额外的 4/2 并发上限", () => {
  it("五个独立文本调用可同时发出，仍逐次 CAS 认领", async () => {
    let complete!: () => void
    const pending = new Promise<void>(resolve => {
      complete = resolve
    })
    const completeMultimodal = jest.fn(async () => {
      await pending
      return { completion: { choices: [{ message: { content: "ok" } }] }, requestId: "request" }
    })
    const updateMany = jest.fn().mockResolvedValue({ count: 1 })
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChetaidouTaskRunnerService,
        {
          provide: PrismaService,
          useValue: {
            chetaidouCall: {
              updateMany,
              update: jest.fn(),
              findUnique: jest.fn().mockResolvedValue({
                state: "PREPARED",
                request: {
                  model: "configured-model",
                  messages: [{ role: "user", content: "test" }],
                },
              }),
            },
          },
        },
        { provide: AiGatewayProvider, useValue: { completeMultimodal } },
        { provide: ChetaidouBillingService, useValue: {} },
        { provide: ChetaidouStorageService, useValue: {} },
      ],
    }).compile()
    const service = moduleRef.get(ChetaidouTaskRunnerService)
    const calls = Array.from({ length: 5 }, (_, i) =>
      service["callLlm"](`call-${i}`, {
        model: "configured-model",
        messages: [{ role: "user", content: "test" }],
      })
    )
    await new Promise<void>(resolve => setImmediate(resolve))
    const started = completeMultimodal.mock.calls.length
    complete()
    await expect(Promise.all(calls)).resolves.toEqual(Array(5).fill("ok"))
    expect(started).toBe(5)
    expect(updateMany).toHaveBeenCalledTimes(5)
  })

  it("同时调度超过两张图片，重复扫描不重复执行在途图片", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }])
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChetaidouImageRunnerService,
        { provide: PrismaService, useValue: { imageGenItem: { findMany } } },
        { provide: AiGatewayProvider, useValue: {} },
        { provide: ChetaidouGatewayReceiptService, useValue: {} },
        { provide: ChetaidouBillingService, useValue: {} },
        { provide: ChetaidouStorageService, useValue: {} },
      ],
    }).compile()
    const service = moduleRef.get(ChetaidouImageRunnerService)
    let complete!: () => void
    const pending = new Promise<void>(resolve => {
      complete = resolve
    })
    const execute = jest.spyOn(service, "executeItem").mockReturnValue(pending)
    await service.scan()
    await service.scan()
    expect(execute).toHaveBeenCalledTimes(3)
    complete()
    await pending
  })
})

describe("车泰斗轻量状态认领", () => {
  it.each(["成功", "保存失败", "提交失败"])("结果事务%s，未提交前禁止扣费", async scenario => {
    let resultCommitted = false
    const call = {
      id: "call",
      outcome: "ACCEPTED",
      billingStatus: "PENDING",
      gatewayRequestId: "req",
    }
    const db = {
      $transaction: jest.fn(),
      chetaidouCall: {
        update: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(call),
      },
    }
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<void>) => {
      await fn(db)
      if (scenario === "提交失败") throw new Error("事务提交失败")
      resultCommitted = true
    })
    const billing = {
      lookupTextUsage: jest.fn().mockResolvedValue(null),
      settleTextInTx: jest.fn(() => {
        expect(resultCommitted).toBe(true)
        return Promise.resolve()
      }),
    }
    const service = new ChetaidouTaskRunnerService(
      db as unknown as PrismaService,
      {} as AiGatewayProvider,
      billing as unknown as ChetaidouBillingService,
      {} as ChetaidouStorageService
    )
    const result = service["settleAndApply"]("call", "model", () =>
      scenario === "保存失败" ? Promise.reject(new Error("结果保存失败")) : Promise.resolve()
    )
    if (scenario === "成功") {
      await result
      expect(billing.settleTextInTx).toHaveBeenCalledTimes(1)
    } else {
      await expect(result).rejects.toThrow()
      expect(billing.lookupTextUsage).not.toHaveBeenCalled()
      expect(billing.settleTextInTx).not.toHaveBeenCalled()
    }
  })

  it("重复文本执行未取得认领权时，不读取任务或调用模型", async () => {
    const findUnique = jest.fn()
    const completeMultimodal = jest.fn()
    const findMany = jest.fn().mockResolvedValue([])
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChetaidouTaskRunnerService,
        {
          provide: PrismaService,
          useValue: {
            chetaidouTask: {
              updateMany: jest.fn().mockResolvedValue({ count: 0 }),
              findUnique,
              findMany,
            },
          },
        },
        { provide: AiGatewayProvider, useValue: { completeMultimodal } },
        { provide: ChetaidouBillingService, useValue: {} },
        { provide: ChetaidouStorageService, useValue: {} },
      ],
    }).compile()
    const service = moduleRef.get(ChetaidouTaskRunnerService)
    await service.execute("already-running")
    await service.scan()
    expect(findUnique).not.toHaveBeenCalled()
    expect(completeMultimodal).not.toHaveBeenCalled()
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: { notIn: ["GENERATE", "CROP"] }, status: "QUEUED" },
      })
    )
  })

  it("两个图片执行者竞争时，未取得认领权者不建调用、不提交网关", async () => {
    const create = jest.fn()
    const createImageTask = jest.fn()
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      imageGenItem: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      chetaidouCall: { create },
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChetaidouImageRunnerService,
        {
          provide: PrismaService,
          useValue: {
            imageGenItem: {
              findUnique: jest.fn().mockResolvedValue({
                id: 1,
                jobId: "job",
                status: "QUEUED",
                updatedAt: new Date(),
              }),
            },
            imageGenJob: {
              findUnique: jest.fn().mockResolvedValue({
                id: "job",
                businessType: "CHETAIDOU",
                request: {},
              }),
            },
            chetaidouTask: { findFirst: jest.fn().mockResolvedValue({ id: "task", snapshot: {} }) },
            $transaction: (fn: (tx: typeof transaction) => Promise<unknown>) => fn(transaction),
          },
        },
        { provide: AiGatewayProvider, useValue: { createImageTask } },
        { provide: ChetaidouGatewayReceiptService, useValue: {} },
        { provide: ChetaidouBillingService, useValue: {} },
        { provide: ChetaidouStorageService, useValue: {} },
      ],
    }).compile()
    await moduleRef.get(ChetaidouImageRunnerService).executeItem(1)
    expect(create).not.toHaveBeenCalled()
    expect(createImageTask).not.toHaveBeenCalled()
  })

  it("中断任务只标记待核对，不回到排队或重新发送模型请求", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 })
    const findMany = jest.fn().mockResolvedValue([])
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChetaidouReconciliationService,
        {
          provide: PrismaService,
          useValue: {
            chetaidouCall: { findMany },
            chetaidouTask: { updateMany, findMany: jest.fn().mockResolvedValue([]) },
          },
        },
        { provide: ChetaidouBillingService, useValue: {} },
        {
          provide: ChetaidouTaskRunnerService,
          useValue: { activeTaskIds: () => [], reconcileWaitingTasks: jest.fn() },
        },
      ],
    }).compile()
    await moduleRef.get(ChetaidouReconciliationService).reconcile()
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          billingStatus: { in: ["PENDING", "REVIEW"] },
          AND: [
            {
              OR: [
                { kind: "TEXT", gatewayRequestId: { not: null } },
                { kind: "IMAGE", gatewayTaskId: { not: null } },
              ],
            },
            {
              OR: [
                { outcome: "ACCEPTED" },
                {
                  outcome: null,
                  AND: [
                    {
                      OR: [
                        { kind: "IMAGE" },
                        { targetKey: "identify" },
                        { gatewayResponse: { equals: Prisma.DbNull } },
                      ],
                    },
                  ],
                  OR: [{ state: "UNKNOWN" }, { taskId: { in: [] }, submittedAt: { not: null } }],
                },
              ],
            },
          ],
        },
      })
    )
    expect(updateMany).toHaveBeenCalledTimes(1)
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ status: "RUNNING" }) as unknown,
      data: expect.objectContaining({ status: "WAITING_RECONCILIATION" }) as unknown,
    })
  })
})
