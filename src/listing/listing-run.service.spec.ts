import { Prisma } from "@prisma/client"
import { Decimal } from "@prisma/client/runtime/library"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { ListingAiService } from "./listing-ai.service"
import { ListingRunService } from "./listing-run.service"

describe("Listing 持久化与扣费", () => {
  it.each(["generation", "optimization", "long_title", "category_match", "attribute_analysis"] as const)(
    "一键上架 %s 不创建 Listing 记录或步骤，模型调用仍正常结算",
    async operation => {
      const upsert = jest.fn()
      const create = jest.fn()
      const runs = new ListingRunService({
        listingRun: { upsert }, listingAiStep: { create },
      } as unknown as PrismaService)
      const chargeFixedModule = jest.fn().mockResolvedValue({ duplicate: false })
      const billing = { model: "ZQ-Think-Flash", costCny: "1", currency: "CNY", requestId: "publish-request", requestIds: ["publish-request"] }
      const service = new ListingAiService({
        streamChat: jest.fn(async function* () {
          yield { type: "text", content: '{"title":"耳机","description":"无线耳机描述"}' }
          yield { type: "billing", billing }
        }),
      } as unknown as AiGatewayProvider, {
        assertFixedModuleAffordable: jest.fn(), chargeFixedModule,
      } as unknown as UsageService, runs)
      if (operation === "attribute_analysis") {
        await expect(runs.beginStep(3, { operation, userPrompt: "耳机", shouldSaveHistory: false })).resolves.toBeNull()
      } else {
        await expect(service.complete(3, {
          operation, userPrompt: "耳机", shouldSaveHistory: false,
        })).resolves.toEqual({ text: '{"title":"耳机","description":"无线耳机描述"}' })
        expect(chargeFixedModule).toHaveBeenCalledTimes(["generation", "optimization"].includes(operation) ? 1 : 0)
        if (["generation", "optimization"].includes(operation)) {
          expect(chargeFixedModule).toHaveBeenCalledWith(3, "listing.generate", expect.objectContaining({
            requestId: "publish-request", meta: expect.objectContaining({ operation, actualCostCny: "1" }),
          }), undefined)
          expect(chargeFixedModule.mock.calls[0][2].meta).not.toHaveProperty("listingHistoryId")
        }
      }
      expect(upsert).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    }
  )

  it("关闭独立记录时拒绝混入已有 runId，避免误丢原记录关联", async () => {
    const runs = new ListingRunService({} as PrismaService)
    await expect(runs.beginStep(3, {
      operation: "generation", userPrompt: "耳机", runId: "existing-run", shouldSaveHistory: false,
    })).rejects.toThrow("不可传入 runId")
  })

  it("History 不增加业务列，步骤费用仅关联公共 UsageLog", () => {
    const models = Prisma.dmmf.datamodel.models
    const history = models.find(model => model.name === "History")!
    expect(
      history.fields.filter(field => field.name.startsWith("listing") && field.kind !== "object")
    ).toEqual([])
    const step = models.find(model => model.name === "ListingAiStep")!
    expect(step.fields.some(field => field.name === "credits")).toBe(false)
    expect(step.fields.find(field => field.name === "usageLogId")).toMatchObject({
      type: "Int",
      isUnique: true,
    })
    expect(
      models
        .find(model => model.name === "ListingRun")
        ?.fields.find(field => field.name === "historyId")
    ).toMatchObject({ isUnique: true })
  })

  it("任务和首版报告通过一次嵌套写入原子创建，历史报告不写 Listing 状态", async () => {
    const upsert = jest.fn().mockResolvedValue({ id: 11, historyId: 1, history: { userId: 3 } })
    const runs = new ListingRunService({ listingRun: { upsert } } as unknown as PrismaService)
    await expect(runs.create(3, { runId: "run-1", title: "耳机" })).resolves.toEqual({
      id: 1,
      runId: "run-1",
      taskId: 11,
    })
    const create = upsert.mock.calls[0][0].create
    expect(create.runId).toBe("run-1")
    expect(create.history.create).toMatchObject({
      userId: 3,
      type: "LISTING_GENERATION",
      revisions: { create: { version: 1 } },
    })
    expect(create.history.create).not.toHaveProperty("listingStatus")
    expect(create.history.create).not.toHaveProperty("listingRunId")
  })

  function createUpdateFixture() {
    const current = {
      id: 1,
      version: 2,
      data: { plans: [{ result: { title: "A" }, planIndex: 0 }] },
    }
    const task = {
      id: 11,
      attempts: { "1": { attemptId: "attempt-new", status: "RUNNING" } },
    }
    const tx = {
      listingGenerationTask: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
      history: { findUniqueOrThrow: jest.fn().mockResolvedValue(current), update: jest.fn() },
      listingRun: {
        findFirst: jest.fn().mockResolvedValue({ id: 11, historyId: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(task),
        update: jest.fn(),
      },
      historyRevision: { create: jest.fn() },
    }
    const prisma = { $transaction: jest.fn(fn => fn(tx)) }
    return { current, task, tx, runs: new ListingRunService(prisma as unknown as PrismaService) }
  }

  it("迟到的旧任务不能覆盖新任务；不写记录、不重复扣费", async () => {
    const { tx, runs } = createUpdateFixture()
    await expect(
      runs.update(3, "run", {
        attemptId: "attempt-old",
        planIndex: 1,
        status: "COMPLETED",
        stage: "completed",
        data: { plans: [{ result: { title: "old" } }] },
      })
    ).rejects.toThrow("已有新的生成任务")
    expect(tx.history.update).not.toHaveBeenCalled()
  })

  it("只更新任务进度时不修改公共 History，也不创建报告版本", async () => {
    const { tx, runs } = createUpdateFixture()
    await runs.update(3, "run", { status: "RUNNING", stage: "generation" })
    expect(tx.listingRun.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { status: "RUNNING", stage: "generation", error: null },
    })
    expect(tx.history.update).not.toHaveBeenCalled()
    expect(tx.historyRevision.create).not.toHaveBeenCalled()
    expect(tx.listingRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: "run", history: { userId: 3 } } })
    )
  })

  it.each([
    { cost: "1", duplicate: false, expectedLogId: 81 },
    { cost: "1", duplicate: true, expectedLogId: null },
    { cost: "0", duplicate: false, expectedLogId: 81 },
  ])(
    "模型结果在同一事务关联实扣账单 $expectedLogId（成本 $cost，幂等 $duplicate）",
    async ({ cost, duplicate, expectedLogId }) => {
      const tx = {
        listingAiStep: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn() },
        usageLog: { findFirst: jest.fn().mockResolvedValue({ id: 81 }) },
      }
      const runs = new ListingRunService({
        listingAiStep: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        $transaction: jest.fn(fn => fn(tx)),
      } as unknown as PrismaService)
      jest.spyOn(runs, "beginStep").mockResolvedValue({ id: 9, historyId: 1 } as never)
      const generateJson = jest.fn().mockResolvedValue({
        data: { title: "耳机", description: "无线耳机描述" },
        billing: {
          model: "ZQ-Think-Flash",
          costCny: cost,
          requestId: "req-1",
          requestIds: ["req-1"],
        },
      })
      const chargeFixedModule = jest.fn().mockResolvedValue({ duplicate })
      const service = new ListingAiService(
        { generateJson } as unknown as AiGatewayProvider,
        {
          chargeFixedModule,
          assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined), gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal("4")),
        } as unknown as UsageService,
        runs
      )
      await expect(
        service.complete(3, {
          operation: "generation",
          userPrompt: "耳机",
          responseFormat: "json_object",
        })
      ).resolves.toEqual({ text: '{"title":"耳机","description":"无线耳机描述"}' })
      expect(tx.listingAiStep.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { usageLogId: expectedLogId },
      })
      expect(chargeFixedModule).toHaveBeenCalledWith(3, "listing.generate", expect.objectContaining({ meta: expect.objectContaining({ listingStepId: 9, listingHistoryId: 1, actualCostCny: cost }) }), tx)
      if (expectedLogId)
        expect(tx.usageLog.findFirst).toHaveBeenCalledWith({
          where: {
            userId: 3,
            requestId: "req-1",
            source: "listing.generate",
            meta: { path: "$.listingStepId", equals: 9 },
          },
          select: { id: true },
        })
      else expect(tx.usageLog.findFirst).not.toHaveBeenCalled()
    }
  )

  it("同一方案已有任务时拒绝再次启动，避免断线重试重复调用模型", async () => {
    const { tx, runs } = createUpdateFixture()
    await expect(
      runs.update(3, "run", {
        attemptId: "attempt-duplicate",
        planIndex: 1,
        status: "RUNNING",
        stage: "generation",
      })
    ).rejects.toThrow("仍在生成中")
    expect(tx.history.update).not.toHaveBeenCalled()
  })

  it("保存 B 方案不覆盖 A；重复保存已完成尝试不新增版本", async () => {
    const { task, tx, runs } = createUpdateFixture()
    const dto = {
      attemptId: "attempt-new",
      planIndex: 1,
      status: "COMPLETED" as const,
      stage: "completed",
      data: { plans: [{ result: { title: "B" } }] },
    }
    await runs.update(3, "run", dto)
    expect(tx.history.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          data: {
            plans: [
              { result: { title: "A" }, planIndex: 0 },
              { result: { title: "B" }, planIndex: 1 },
            ],
          },
        }),
      })
    )
    task.attempts["1"].status = "COMPLETED"
    await runs.update(3, "run", dto)
    expect(tx.historyRevision.create).toHaveBeenCalledTimes(1)
    expect(tx.history.update).toHaveBeenCalledTimes(1)
  })

  it("后台评分完成即在同一事务保存列表分数，无需浏览器补存", async () => {
    const { tx, runs } = createUpdateFixture()
    const persistGeneration = jest.fn()
    await runs.update(3, "run", {
      attemptId: "attempt-new", planIndex: 1, status: "COMPLETED", stage: "completed",
      data: { plans: [{ result: { title: "B" }, scoreResult: { total: 94.5 } }] },
    }, persistGeneration)
    expect(persistGeneration).toHaveBeenCalledWith(tx)
    expect(tx.history.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ score: 94.5, data: { plans: [
        { result: { title: "A" }, planIndex: 0 },
        { result: { title: "B" }, scoreResult: { total: 94.5 }, planIndex: 1 },
      ] } }),
    }))
  })

  it("输出落库和扣费使用同一个事务；已完成步骤不会重复扣费", async () => {
    const tx = {
      listingAiStep: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
        update: jest.fn(),
      },
    }
    const prisma = {
      listingAiStep: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(fn => fn(tx)),
    }
    const runs = new ListingRunService(prisma as unknown as PrismaService)
    const charge = jest.fn().mockResolvedValue(123)
    await runs.completeStep(1, '{"title":"耳机","description":"无线耳机描述"}', "req-1", "ZQ-Think-Pro", charge)
    expect(charge).toHaveBeenCalledWith(tx)
    expect(tx.listingAiStep.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outputText: '{"title":"耳机","description":"无线耳机描述"}', requestId: "req-1" }),
      })
    )
    expect(tx.listingAiStep.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { usageLogId: 123 },
    })
    await runs.completeStep(1, "duplicate", "req-1", "ZQ-Think-Pro", charge)
    expect(charge).toHaveBeenCalledTimes(1)
  })

  it("扣费事务超时仍保留唯一正文，不重试模型或扣费", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 })
    const transaction = jest.fn().mockRejectedValue(new Error("transaction timeout"))
    const runs = new ListingRunService({
      listingAiStep: { updateMany },
      $transaction: transaction,
    } as unknown as PrismaService)
    const charge = jest.fn()
    await expect(
      runs.completeStep(9, "saved body", "req-9", "ZQ-Think-Flash", charge)
    ).rejects.toThrow("transaction timeout")
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 9, status: "RUNNING" },
      data: { outputText: "saved body", requestId: "req-9", model: "ZQ-Think-Flash" },
    })
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10000,
      timeout: 60000,
    })
    expect(charge).not.toHaveBeenCalled()
  })

  it("记录创建失败时不调用模型、不扣费", async () => {
    const streamChat = jest.fn()
    const chargeFixedModule = jest.fn()
    const runs = { beginStep: jest.fn().mockRejectedValue(new Error("database unavailable")) }
    const service = new ListingAiService(
      { streamChat } as unknown as AiGatewayProvider,
      {
        chargeFixedModule,
        assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined), gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal("4")),
      } as unknown as UsageService,
      runs as unknown as ListingRunService
    )
    await expect(
      service.complete(3, { operation: "generation", userPrompt: "耳机" })
    ).rejects.toThrow("database unavailable")
    expect(streamChat).not.toHaveBeenCalled()
    expect(chargeFixedModule).not.toHaveBeenCalled()
  })

  it("主调用失败仍保留失败步骤，不执行扣费", async () => {
    const streamChat = jest.fn(async function* () {
      yield await Promise.reject(new Error("HTTP 400"))
    })
    const runs = {
      beginStep: jest.fn().mockResolvedValue({ id: 9, historyId: 2 }),
      failStep: jest.fn(),
      completeStep: jest.fn(),
    }
    const service = new ListingAiService(
      { streamChat } as unknown as AiGatewayProvider,
      { assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined) } as unknown as UsageService,
      runs as unknown as ListingRunService
    )
    await expect(
      service.complete(3, { operation: "generation", userPrompt: "耳机" })
    ).rejects.toThrow("HTTP 400")
    expect(runs.failStep).toHaveBeenCalledWith(9, expect.any(Error))
    expect(runs.completeStep).not.toHaveBeenCalled()
  })

  it("仅返回思考或账单但没有正文时，保留失败记录且不扣费", async () => {
    const streamChat = jest.fn(async function* () {
      yield { type: "thinking", content: "thinking" }
      yield {
        type: "billing",
        billing: { requestId: "req-empty", model: "ZQ-Think-Flash", costCny: "1" },
      }
    })
    const runs = {
      beginStep: jest.fn().mockResolvedValue({ id: 10, historyId: 2 }),
      failStep: jest.fn(),
      completeStep: jest.fn(),
    }
    const chargeFixedModule = jest.fn()
    const service = new ListingAiService(
      { streamChat } as unknown as AiGatewayProvider,
      {
        chargeFixedModule,
        assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined), gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal("4")),
      } as unknown as UsageService,
      runs as unknown as ListingRunService
    )
    await expect(
      service.complete(3, { operation: "generation", userPrompt: "耳机" })
    ).rejects.toThrow("模型未返回正文")
    expect(runs.failStep).toHaveBeenCalled()
    expect(runs.completeStep).not.toHaveBeenCalled()
    expect(chargeFixedModule).not.toHaveBeenCalled()
  })

  it("并行子步骤迟到失败不会覆盖已生成的历史状态", async () => {
    const prisma = {
      listingAiStep: {
        update: jest.fn().mockResolvedValue({ listingRunId: 7, operation: "long_title" }),
      },
      listingRun: { updateMany: jest.fn() },
    }
    await new ListingRunService(prisma as unknown as PrismaService).failStep(
      9,
      new Error("timeout")
    )
    expect(prisma.listingRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7, status: { in: ["ANALYZING", "FAILED"] } } })
    )
  })

  it("同名 runId 不允许跨用户读写", async () => {
    const prisma = {
      listingRun: {
        upsert: jest.fn().mockResolvedValue({ id: 7, historyId: 2, history: { userId: 4 } }),
      },
    }
    await expect(
      new ListingRunService(prisma as unknown as PrismaService).create(3, {
        runId: "uuid",
        title: "耳机",
      })
    ).rejects.toThrow("生成记录不存在")
  })
})
