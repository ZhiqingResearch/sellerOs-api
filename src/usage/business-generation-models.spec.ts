import { businessGenerationModels } from "./business-generation-models"

const record = { id: "report-1", userId: 74, clientRequestId: "client-1" }

it("新品推广的竞品提取只认数字索引，最终生成模型优先，智能定价不套用竞品运行号", async () => {
  const audit = {
    businessAiRun: {
      findMany: jest.fn().mockResolvedValue([
        {
          userId: 74,
          runId: "client-1-competitor-0",
          operation: "extract",
          model: "extract-model",
        },
        {
          userId: 74,
          runId: "client-1-competitor-other",
          operation: "extract",
          model: "wrong-model",
        },
        {
          userId: 74,
          runId: "client-1-competitor-1",
          operation: "research",
          model: "wrong-operation",
        },
        { userId: 74, runId: "client-1", operation: "generate", model: "generate-model" },
      ]),
    },
  }
  expect(
    (await businessGenerationModels(audit as never, [record], "promotion-plan")).get(record.id)
  ).toEqual({ actualModel: "generate-model", actualModels: ["generate-model", "extract-model"] })
  expect(
    (await businessGenerationModels(audit as never, [record], "smart-pricing")).get(record.id)
  ).toEqual({ actualModel: "generate-model", actualModels: ["generate-model"] })
})

describe.each(["smart-pricing", "promotion-plan"] as const)("%s 实际调用模型", module => {
  it("网关账单模型优先，生成步骤优先，保留多个步骤模型并去重", async () => {
    const audit = {
      businessAiRun: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 74,
            runId: "client-1-extract",
            operation: "extract",
            model: "extract-model",
            billing: null,
          },
          {
            userId: 74,
            runId: "client-1-generate",
            operation: "generate",
            model: "requested-alias",
            billing: { billing: { model: "actual-model", secret: "never-return" } },
          },
          {
            userId: 74,
            runId: "client-1-research",
            operation: "research",
            model: "actual-model",
            billing: null,
          },
        ]),
      },
    }
    const result = await businessGenerationModels(audit as never, [record], module)
    expect(result.get(record.id)).toEqual({
      actualModel: "actual-model",
      actualModels: ["actual-model", "extract-model"],
    })
    expect(JSON.stringify([...result])).not.toContain("never-return")
    expect(audit.businessAiRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          module,
          status: "COMPLETED",
          userId: { in: [74] },
          OR: [
            {
              runId: {
                in: ["client-1", "client-1-generate", "client-1-extract", "client-1-research"],
              },
            },
            ...(module === "promotion-plan"
              ? [{ runId: { startsWith: "client-1-competitor-" } }]
              : []),
          ],
          operation: { in: ["generate", "extract", "research"] },
        },
      })
    )
  })

  it("同运行号的其他用户、相似前缀和计费占位不能冒充实际模型", async () => {
    const audit = {
      businessAiRun: {
        findMany: jest.fn().mockResolvedValue([
          { userId: 75, runId: "client-1-generate", operation: "generate", model: "another-user" },
          {
            userId: 74,
            runId: "client-10-generate",
            operation: "generate",
            model: "similar-prefix",
          },
          {
            userId: 74,
            runId: "client-1-extract",
            operation: "generate",
            model: "wrong-operation",
          },
          { userId: 74, runId: "client-1-generate", operation: "generate", model: "fixed-module" },
        ]),
      },
    }
    expect(
      (await businessGenerationModels(audit as never, [record], module)).get(record.id)
    ).toEqual({
      actualModel: null,
      actualModels: [],
    })
  })

  it("无运行记录返回空值，不按时间猜测，也不使用当前默认模型填历史", async () => {
    const audit = { businessAiRun: { findMany: jest.fn().mockResolvedValue([]) } }
    expect(
      (await businessGenerationModels(audit as never, [record], module)).get(record.id)
    ).toEqual({
      actualModel: null,
      actualModels: [],
    })
    audit.businessAiRun.findMany.mockClear()
    expect((await businessGenerationModels(audit as never, [], module)).size).toBe(0)
    expect(audit.businessAiRun.findMany).not.toHaveBeenCalled()
  })
})
