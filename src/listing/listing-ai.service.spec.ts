import { Decimal } from "@prisma/client/runtime/library"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  AiGatewayProvider,
  type AiGatewayJsonOptions,
  type AiGatewayStreamOptions,
} from "../common/providers/ai-gateway.provider"
import { UsageService } from "../usage/usage.service"
import { ListingAiService } from "./listing-ai.service"
import { ListingRunService } from "./listing-run.service"
const records = { beginStep: jest.fn().mockResolvedValue(null) } as unknown as ListingRunService

describe("ListingAiService", () => {
  describe.each(["json", "stream"] as const)("带runId的%s评分入口", mode => {
    it.each([false, true])("CDQ规则差异和缺少细则均正常交付 incomplete=%s", async isIncomplete => {
      const incident = JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-summary-28-20260917.json"), "utf8"))
      const report = JSON.parse(incident.primary)
      if (isIncomplete) report.dimensions[0].criteria.pop()
      const billing = { costCny: "1", currency: "CNY", model: "ZQ-Think-Flash", requestId: "cdq-compat", requestIds: ["cdq-compat"] }
      const generateJson = jest.fn().mockResolvedValue({ data: report, billing })
      const streamChat = jest.fn(async function* () {
        yield { type: "text", content: JSON.stringify(report) }
        yield { type: "billing", billing }
      })
      const chargeFixedModule = jest.fn().mockResolvedValue({})
      const completeStep = jest.fn(async (_id, _text, _requestId, _model, charge) => charge())
      const failStep = jest.fn()
      const service = new ListingAiService(
        { generateJson, streamChat } as unknown as AiGatewayProvider,
        { chargeFixedModule, assertFixedModuleAffordable: jest.fn() } as unknown as UsageService,
        {
          beginStep: jest.fn().mockResolvedValue({ id: 3, historyId: 4, runId: "generation-run" }),
          completeStep, failStep,
        } as unknown as ListingRunService,
      )
      const result = service.complete(7, {
        operation: "score", runId: "generation-run", scoreMarket: "amazon_us",
        userPrompt: "mode：standard\n<listing-scoring-source>" + JSON.stringify(incident.sourceFacts) + "</listing-scoring-source>",
        ...(mode === "json" ? { responseFormat: "json_object" } : {}),
      })
      const delivered = JSON.parse((await result).text)
      expect(delivered).toMatchObject({ total: isIncomplete ? null : 84.4286, validationStatus: "BEST_EFFORT" })
      if (isIncomplete) expect(delivered.dimensions[0].criteria[5]).toMatchObject({ score: null, status: "PENDING" })
      else expect(delivered.dimensions[0].criteria).toEqual(report.dimensions[0].criteria)
      expect(completeStep).toHaveBeenCalledTimes(1)
      expect(chargeFixedModule).toHaveBeenCalledTimes(isIncomplete ? 0 : 1)
      expect(failStep).not.toHaveBeenCalled()
      expect(mode === "json" ? generateJson : streamChat).toHaveBeenCalledTimes(1)
    })
  })
  it("两个方案使用同一扣费标识，重新生成使用新的标识", async () => {
    const chargeFixedModule = jest.fn().mockResolvedValue({})
    const service = new ListingAiService({} as AiGatewayProvider, { chargeFixedModule } as unknown as UsageService, records)
    for (const [requestId, batch] of [["seo", "batch"], ["scenario", "batch"], ["regenerate", "new-batch"]]) {
      await service.chargeSavedOutput(7, "generation", { model: "model", costCny: "9", currency: "CNY", requestId, requestIds: [requestId] }, undefined, undefined, undefined, undefined, "run", batch)
    }
    const calls = chargeFixedModule.mock.calls as unknown as Array<[number, string, { requestId: string }]>
    expect(calls.map(call => call[2].requestId)).toEqual([
      "listing-generation:7:batch", "listing-generation:7:batch", "listing-generation:7:new-batch",
    ])
  })

  it("余额不足在模型与步骤创建之前拒绝", async () => {
    const generateJson = jest.fn()
    const beginStep = jest.fn()
    const service = new ListingAiService({ generateJson } as unknown as AiGatewayProvider, {
      assertFixedModuleAffordable: jest.fn().mockRejectedValue(new Error("积分余额不足")),
    } as unknown as UsageService, { beginStep } as unknown as ListingRunService)
    await expect(service.complete(7, { operation: "optimization", userPrompt: "优化", responseFormat: "json_object" })).rejects.toThrow("积分余额不足")
    expect(generateJson).not.toHaveBeenCalled()
    expect(beginStep).not.toHaveBeenCalled()
  })

  it("优化返回不完整结果不扣费", async () => {
    const chargeFixedModule = jest.fn()
    const service = new ListingAiService({
      generateJson: jest.fn().mockResolvedValue({ data: { title: "只有标题" }, billing: { requestId: "bad" } }),
    } as unknown as AiGatewayProvider, {
      assertFixedModuleAffordable: jest.fn(), chargeFixedModule,
    } as unknown as UsageService, records)
    await expect(service.complete(7, { operation: "optimization", userPrompt: "优化", responseFormat: "json_object" })).rejects.toThrow("本次未扣积分")
    expect(chargeFixedModule).not.toHaveBeenCalled()
  })

  it("优化附属长标题不按25积分再次预检", async () => {
    const assertFixedModuleAffordable = jest.fn()
    const service = new ListingAiService({} as AiGatewayProvider, { assertFixedModuleAffordable } as unknown as UsageService, records)
    await service.assertAffordable(7, "optimization")
    await service.assertAffordable(7, "long_title")
    expect(assertFixedModuleAffordable).toHaveBeenCalledTimes(1)
    expect(assertFixedModuleAffordable).toHaveBeenCalledWith(7, "listing.generate", "optimization", undefined)
  })

  it("优化缺少平台必需内容不扣费", async () => {
    const chargeFixedModule = jest.fn()
    const service = new ListingAiService({
      generateJson: jest.fn().mockResolvedValue({ data: { title: "耳机", description: "描述" }, billing: { requestId: "bad" } }),
    } as unknown as AiGatewayProvider, {
      assertFixedModuleAffordable: jest.fn(), chargeFixedModule,
    } as unknown as UsageService, records)
    await expect(service.complete(7, { operation: "optimization", listingMarket: "amazon_us", userPrompt: "优化", responseFormat: "json_object" })).rejects.toThrow("本次未扣积分")
    expect(chargeFixedModule).not.toHaveBeenCalled()
  })
  it.each([{ historyId: 10, source: "listing.score" }, { historyId: undefined, source: "listing.score" }])(
    "手动评分归属 $source，是否关联生成记录均按次计费",
    async ({ historyId, source }) => {
      const chargeFixedModule = jest.fn().mockResolvedValue({})
      const service = new ListingAiService({} as AiGatewayProvider, {
        chargeFixedModule, assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined), gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal(1)),
      } as unknown as UsageService, records)
      await service.chargeSavedOutput(7, "score", {
        costCny: "1", currency: "CNY", model: "ZQ-Think-Flash", requestId: "score-request", requestIds: ["score-request"],
      }, undefined, undefined, historyId, undefined, historyId ? "run" : undefined)
      expect(chargeFixedModule).toHaveBeenCalledWith(7, source, expect.objectContaining({ model: "ZQ-Think-Flash" }), undefined)
    },
  )
  it("独立评分走固定扣分且不返回旧 token 待扣费用", async () => {
    const invocations: Array<{
      systemPrompt: string
      userPrompt: string
      options?: AiGatewayStreamOptions
    }> = []
    const streamChat = jest.fn(
      (systemPrompt: string, userPrompt: string, options?: AiGatewayStreamOptions) => {
        invocations.push({ systemPrompt, userPrompt, options })
        return (async function* () {
          await Promise.resolve()
          yield { type: "thinking" as const, content: "分析中" }
          yield { type: "text" as const, content: '{"total":2,' }
          yield { type: "text" as const, content: '"dimensions":[{"criteria":[{"score":2,"maxScore":2,"deductions":[]}]}]}' }
          yield {
            type: "usage" as const,
            content: "",
            usage: {
              promptTokens: 10,
              completionTokens: 5,
              thinkingTokens: 2,
              totalTokens: 17,
            },
          }
          yield {
            type: "billing" as const,
            content: "",
            billing: {
              costCny: "0.123456",
              currency: "CNY" as const,
              model: "ZQ-Think-Pro",
              requestId: "req-listing-1",
              requestIds: ["req-listing-1"],
            },
          }
        })()
      }
    )
    const chargeFixedModule = jest.fn().mockResolvedValue({})
    const service = new ListingAiService(
      { streamChat } as unknown as AiGatewayProvider,
      {
        chargeFixedModule, assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined),
        gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal("4")),
      } as unknown as UsageService,
      records
    )

    const result = await service.complete(7, {
      operation: "score",
      model: "ZQ-Think-Pro",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0,
    })

    expect(JSON.parse(result.text)).toMatchObject({ total: 2 })
    expect(chargeFixedModule).toHaveBeenCalledWith(7, "listing.score", {
      model: "ZQ-Think-Pro",
      requestId: "req-listing-1",
      meta: {
        operation: "score",
        actualCostCny: "0.123456",
        gatewayRequestIds: ["req-listing-1"],
        tokenUsage: {
          promptTokens: 10,
          completionTokens: 5,
          thinkingTokens: 2,
          totalTokens: 17,
        },
      },
    }, undefined)
    expect(invocations[0]?.systemPrompt).toContain("system")
    expect(invocations[0]?.systemPrompt).toContain("没有扣分时 score=maxScore")
    expect(invocations[0]?.userPrompt).toBe("user")
    expect(invocations[0]?.options).toMatchObject({
      model: "ZQ-Think-Pro",

      temperature: 0,
      resolveBilling: true,
    })
  })

  it("结构化属性分析校验成功但不单独扣费", async () => {
    const streamChat = jest.fn()
    let capturedOptions: AiGatewayJsonOptions<Record<string, unknown>> | undefined
    const generateJson = jest.fn(
      (
        _systemPrompt: string,
        _userPrompt: string,
        options?: AiGatewayJsonOptions<Record<string, unknown>>
      ) => {
        capturedOptions = options
        return Promise.resolve({
          data: {
            questions: [
              {
                id: "material",
                title: "产品材质？",
                hint: "请选择主要材质",
                multiSelect: true,
                options: [{ emoji: "🔩", label: "金属", value: "金属" }],
              },
            ],
          },
          model: "ZQ-Think-Flash",
          requestId: "req-attribute-1",
          tokenUsage: {
            promptTokens: 12,
            completionTokens: 8,
            thinkingTokens: 0,
          },
          billing: {
            costCny: "0.1",
            currency: "CNY" as const,
            model: "ZQ-Think-Flash",
            requestId: "req-attribute-1",
            requestIds: ["req-attribute-1"],
          },
        })
      }
    )
    const chargeFixedModule = jest.fn().mockResolvedValue({})
    const service = new ListingAiService(
      { generateJson, streamChat } as unknown as AiGatewayProvider,
      {
        chargeFixedModule, assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined),
        gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal("4")),
      } as unknown as UsageService,
      records
    )

    const result = await service.complete(7, {
      operation: "attribute_analysis",
      model: "ZQ-Think-Flash",
      userPrompt: "生成属性问题",
      temperature: 0.2,
      responseFormat: "json_object",
    })

    expect(JSON.parse(result.text)).toMatchObject({
      questions: [{ id: "material" }],
    })
    expect(streamChat).not.toHaveBeenCalled()
    expect(generateJson).toHaveBeenCalledWith(
      "",
      "生成属性问题",
      expect.objectContaining({
        model: "ZQ-Think-Flash",

        temperature: 0.2,
        resolveBilling: true,
      })
    )
    expect(capturedOptions?.isDataValid?.({ questions: [] })).toBe(false)
    expect(capturedOptions?.isDataValid?.(JSON.parse(result.text))).toBe(true)
    expect(chargeFixedModule).not.toHaveBeenCalled()
  })
})
