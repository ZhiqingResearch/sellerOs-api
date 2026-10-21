import { Test } from "@nestjs/testing"
import { Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { AiGatewayProvider } from "../ai-gateway/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { ChetaidouBillingService } from "./chetaidou-billing.service"
import { ChetaidouContextService } from "./chetaidou-context.service"
import { CHETAIDOU_IMAGE_CATEGORY } from "./chetaidou.constants"

describe("车泰斗生图模型计费一致性", () => {
  const usage = {
    gatewayPriceMultiplier: jest.fn(),
    chargeModelInTransaction: jest.fn(),
  }
  const resolveModels = jest.fn()
  let service: ChetaidouBillingService
  const call = {
    id: "call-1",
    taskId: "task-1",
    rootTaskId: "task-1",
    ownerId: 1,
    imageGenItemId: 2,
    model: "submitted-image",
    category: CHETAIDOU_IMAGE_CATEGORY,
    billingStatus: "PENDING",
    outcome: "ACCEPTED",
  }
  const tx = {
    $queryRaw: jest.fn(),
    chetaidouCall: { findUnique: jest.fn(), update: jest.fn() },
    chetaidouTask: { findUnique: jest.fn() },
    aiGatewayModel: { findUnique: jest.fn() },
  }

  beforeEach(async () => {
    jest.resetAllMocks()
    tx.$queryRaw.mockResolvedValue([{ ...call }])
    tx.chetaidouTask.findUnique.mockResolvedValue({ status: "RUNNING" })
    usage.chargeModelInTransaction.mockResolvedValue({ creditsCharged: new Decimal(7) })
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChetaidouBillingService,
        { provide: PrismaService, useValue: {} },
        { provide: AiGatewayProvider, useValue: {} },
        { provide: UsageService, useValue: usage },
        { provide: ChetaidouContextService, useValue: { resolveModels } },
      ],
    }).compile()
    service = moduleRef.get(ChetaidouBillingService)
  })

  it("模型切换后仍按旧调用分类的一口价结算，不受旧模型停用影响", async () => {
    tx.aiGatewayModel.findUnique.mockResolvedValue({ fixedCredits: new Decimal(7) })
    await service.settleImageInTx(tx as unknown as Prisma.TransactionClient, call, null, true)
    expect(tx.aiGatewayModel.findUnique).toHaveBeenCalledWith({
      where: { publicId_category: { publicId: call.model, category: call.category } },
      select: { fixedCredits: true },
    })
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(
      tx,
      1,
      expect.any(String),
      expect.objectContaining({ model: call.model, exactCredits: "7" })
    )
    expect(resolveModels).not.toHaveBeenCalled()
  })

  it("按量结算也使用调用记录中的模型倍率及模型标识", async () => {
    tx.aiGatewayModel.findUnique.mockResolvedValue({ fixedCredits: null })
    usage.gatewayPriceMultiplier.mockResolvedValue(new Decimal(3))
    await service.settleImageInTx(
      tx as unknown as Prisma.TransactionClient,
      call,
      new Decimal(2),
      true
    )
    expect(usage.gatewayPriceMultiplier).toHaveBeenCalledWith(call.model)
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(
      tx,
      1,
      "6",
      expect.objectContaining({ model: call.model })
    )
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ creditMultiplier: expect.anything() as unknown })
    )
    expect(resolveModels).not.toHaveBeenCalled()
  })

  it.each(["SETTLED", "FREE"])("已结算状态 %s 重复通知不再扣费", async billingStatus => {
    tx.$queryRaw.mockResolvedValue([{ ...call, billingStatus }])
    await service.settleImageInTx(
      tx as unknown as Prisma.TransactionClient,
      call,
      new Decimal(2),
      true
    )
    await service.settleTextInTx(tx as unknown as Prisma.TransactionClient, call, new Decimal(2))
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
    expect(tx.chetaidouCall.update).not.toHaveBeenCalled()
  })

  it("扣费失败向外抛出，禁止提前落 SETTLED", async () => {
    tx.aiGatewayModel.findUnique.mockResolvedValue({ fixedCredits: new Decimal(7) })
    usage.chargeModelInTransaction.mockRejectedValue(new Error("事务回滚"))
    await expect(
      service.settleImageInTx(tx as unknown as Prisma.TransactionClient, call, null, true)
    ).rejects.toThrow("事务回滚")
    expect(tx.chetaidouCall.update).not.toHaveBeenCalled()
  })

  it.each([null, "INVALID", "PROVIDER_FAILED", "CANCELLED"])(
    "文本结果 %s 即使网关已有账单也不得扣费",
    async outcome => {
      tx.$queryRaw.mockResolvedValue([
        { ...call, outcome, state: outcome ? "UNKNOWN" : "RECEIVED" },
      ])
      await service.settleTextInTx(tx as unknown as Prisma.TransactionClient, call, new Decimal(2))
      expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
      expect(tx.chetaidouCall.update).not.toHaveBeenCalled()
    }
  )

  it.each(["PENDING", "REVIEW"])("待核对文本 %s 有实际账单则扣费", async billingStatus => {
    tx.$queryRaw.mockResolvedValue([{ ...call, outcome: null, state: "UNKNOWN", billingStatus }])
    await service.settleTextInTx(tx as unknown as Prisma.TransactionClient, call, new Decimal(2))
    expect(usage.chargeModelInTransaction).toHaveBeenCalledWith(
      tx,
      1,
      "2",
      expect.objectContaining({ requestId: `chetaidou:charge:${call.id}` })
    )
    expect(tx.chetaidouCall.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ billingStatus: "SETTLED" }) as unknown,
      })
    )
  })

  it.each(["WAITING_RECONCILIATION", "RUNNING", "FAILED"])(
    "中断任务 %s 的已提交回执按当前状态决定是否扣费",
    async status => {
      tx.$queryRaw.mockResolvedValue([
        { ...call, outcome: null, state: "RECEIVED", submittedAt: new Date() },
      ])
      tx.chetaidouTask.findUnique.mockResolvedValue({ status })
      await service.settleTextInTx(tx as unknown as Prisma.TransactionClient, call, new Decimal(2))
      expect(usage.chargeModelInTransaction).toHaveBeenCalledTimes(
        status === "WAITING_RECONCILIATION" ? 1 : 0
      )
    }
  )

  it("待核对文本没有账单时继续待结算，不记免费或估算扣费", async () => {
    tx.$queryRaw.mockResolvedValue([{ ...call, outcome: null, state: "UNKNOWN" }])
    expect(
      await service.settleTextInTx(tx as unknown as Prisma.TransactionClient, call, null)
    ).toBe("PENDING")
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
    expect(tx.chetaidouCall.update).toHaveBeenCalledWith({
      where: { id: call.id },
      data: { billingStatus: "PENDING" },
    })
  })

  it.each([null, new Decimal(2)])("待核对图片仅在有实际账单时收费：%s", async amount => {
    tx.$queryRaw.mockResolvedValue([{ ...call, outcome: null, state: "UNKNOWN" }])
    tx.aiGatewayModel.findUnique.mockResolvedValue({ fixedCredits: new Decimal(7) })
    const result = await service.settleImageInTx(
      tx as unknown as Prisma.TransactionClient,
      call,
      amount,
      "UNKNOWN"
    )
    expect(result).toBe(amount === null ? "PENDING" : "SETTLED")
    expect(usage.chargeModelInTransaction).toHaveBeenCalledTimes(amount === null ? 0 : 1)
  })

  it.each([null, new Decimal(2)])("失败图片即使按量产生费用也免扣：%s", async amount => {
    await service.settleImageInTx(tx as unknown as Prisma.TransactionClient, call, amount, false)
    expect(usage.chargeModelInTransaction).not.toHaveBeenCalled()
    expect(tx.aiGatewayModel.findUnique).not.toHaveBeenCalled()
    expect(tx.chetaidouCall.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ billingStatus: "FREE", chargedCredits: "0" }) as unknown,
      })
    )
  })

  it.each(["TEXT", "IMAGE"])("%s 的两个结算事务竞争同一行锁，只扣一次", async kind => {
    let persisted = { ...call }
    let previousLock = Promise.resolve()
    const charge = jest.fn().mockResolvedValue({ creditsCharged: new Decimal(7) })
    usage.chargeModelInTransaction.mockImplementation(charge)
    const settle = async () => {
      let unlock: (() => void) | undefined
      let current = { ...persisted }
      const transaction = {
        $queryRaw: async (sql: TemplateStringsArray) => {
          expect(sql.join("?")).toContain("FOR UPDATE")
          const previous = previousLock
          previousLock = new Promise<void>(resolve => {
            unlock = resolve
          })
          await previous
          current = { ...persisted }
          return [current]
        },
        chetaidouCall: {
          update: ({ data }: { data: Partial<typeof call> }) => {
            current = { ...current, ...data }
            return Promise.resolve(current)
          },
        },
        aiGatewayModel: { findUnique: () => Promise.resolve({ fixedCredits: new Decimal(7) }) },
      }
      try {
        if (kind === "TEXT") {
          usage.gatewayPriceMultiplier.mockResolvedValue(new Decimal(1))
          await service.settleTextInTx(
            transaction as unknown as Prisma.TransactionClient,
            call,
            new Decimal(2)
          )
        } else {
          await service.settleImageInTx(
            transaction as unknown as Prisma.TransactionClient,
            call,
            null,
            true
          )
        }
        persisted = current
      } finally {
        unlock?.()
      }
    }
    await Promise.all([settle(), settle()])
    expect(charge).toHaveBeenCalledTimes(1)
    expect(charge).toHaveBeenCalledWith(
      expect.anything(),
      1,
      expect.any(String),
      expect.objectContaining({ requestId: `chetaidou:charge:${call.id}` })
    )
    expect(persisted.billingStatus).toBe("SETTLED")
  })
})

describe("车泰斗批次调用计费", () => {
  it("按冻结分类查模型倍率，一次三维 Call 只收费一次，重复结算直接返回", async () => {
    const row = {
      id: "batch-call",
      ownerId: 7,
      source: "chetaidou.ideation",
      model: "ZQ-Think-Ultra",
      category: "CHETAIDOU_MULTIMODAL",
      billingStatus: "PENDING",
      outcome: "ACCEPTED",
    }
    const chargeModelInTransaction = jest.fn().mockResolvedValue({ creditsCharged: 40 })
    const gatewayPriceMultiplier = jest.fn().mockResolvedValue(new Decimal(99))
    const tx = {
      $queryRaw: jest.fn().mockImplementation(() => Promise.resolve([row])),
      aiGatewayModel: {
        findUnique: jest.fn().mockResolvedValue({ priceMultiplier: new Decimal(2) }),
      },
      chetaidouCall: {
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve(Object.assign(row, data))),
      },
    }
    const service = new ChetaidouBillingService(
      {} as never,
      {} as never,
      { chargeModelInTransaction, gatewayPriceMultiplier } as never,
      {} as never
    )
    const call = { id: row.id, model: row.model }
    await service.settleTextInTx(tx as never, call, new Decimal(2))
    await service.settleTextInTx(tx as never, call, new Decimal(2))
    expect(tx.aiGatewayModel.findUnique).toHaveBeenCalledWith({
      where: { publicId_category: { publicId: row.model, category: row.category } },
      select: { priceMultiplier: true },
    })
    expect(gatewayPriceMultiplier).not.toHaveBeenCalled()
    expect(chargeModelInTransaction).toHaveBeenCalledTimes(1)
    const charge = chargeModelInTransaction.mock.calls[0] as unknown as [
      unknown,
      number,
      string,
      { requestId: string; model: string },
    ]
    expect(charge[2]).toBe("4")
    expect(charge[3]).toMatchObject({
      requestId: "chetaidou:charge:batch-call",
      model: row.model,
    })
  })
})
