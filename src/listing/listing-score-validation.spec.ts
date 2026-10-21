import { ListingAiService } from "./listing-ai.service"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { UsageService } from "../usage/usage.service"
import { ListingRunService } from "./listing-run.service"
import { validateListingScoreOutput } from "./listing-score-validation"

const buildScore = (score = 2, deductions: unknown[] = []) => ({
  total: score, dimensions: [{ score, criteria: [{ name: "Bullet", score, maxScore: 2, deductions }] }],
})

describe("Listing 评分一致性及扣费前校验", () => {
  it.each([
    buildScore(0),
    buildScore(0, [{ points: 0, reason: "无明显堆砌" }]),
    buildScore(1, [{ points: 0.5, reason: "缺失" }]),
    buildScore(1, [{ points: 1, reason: " " }]),
    buildScore(2, [{ points: -1, reason: "加分" }]),
  ])("拒绝不一致评分而非补满分", result => {
    expect(() => validateListingScoreOutput(JSON.stringify(result))).toThrow("得分与扣分依据不一致")
  })

  it("合法小数扣分保留且清除无意义零扣分", () => {
    const result = buildScore(1.5, [{ points: 0.5, reason: "缺少依据" }, { points: 0, reason: "无问题" }])
    expect(JSON.parse(validateListingScoreOutput(JSON.stringify(result))).dimensions[0].criteria[0])
      .toMatchObject({ score: 1.5, deductions: [{ points: 0.5, reason: "缺少依据" }] })
  })

  it("仅修复闭合 JSON 的格式，不补写截断评分", () => {
    expect(JSON.parse(validateListingScoreOutput("```json\n" + JSON.stringify(buildScore()) + "\n```"))).toEqual(buildScore())
    expect(() => validateListingScoreOutput('{"total":2,"dimensions":[')).toThrow("完整 JSON")
    expect(() => validateListingScoreOutput("这是分析过程而非评分结果")).toThrow("完整 JSON")
  })

  it.each([JSON.stringify(buildScore(0)), '{"total":', "没有 JSON"])("流式已有返回正常展示，可用评分或暂未评分均不被校验拦截", async output => {
    const streamChat = jest.fn(async function* () {
      yield { type: "text", content: output }
      yield { type: "billing", billing: { costCny: "1", currency: "CNY", model: "ZQ-Think-Flash", requestId: "test" } }
    })
    const chargeFixedModule = jest.fn()
    const completeStep = jest.fn()
    const failStep = jest.fn()
    const service = new ListingAiService({ streamChat } as unknown as AiGatewayProvider,
      { chargeFixedModule, assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined) } as unknown as UsageService,
      { beginStep: jest.fn().mockResolvedValue({ id: 1 }), completeStep, failStep } as unknown as ListingRunService)
    const events: unknown[] = []
    for await (const event of service.stream(1, { operation: "score", userPrompt: "score" })) events.push(event)
    expect(events).toEqual([expect.objectContaining({ type: "text", content: expect.any(String) })])
    expect(chargeFixedModule).not.toHaveBeenCalled()
    expect(completeStep).toHaveBeenCalledTimes(1)
    expect(failStep).not.toHaveBeenCalled()
    expect(streamChat).toHaveBeenCalledTimes(1)
  })

  it("非流式 JSON 评分无效分值正常交付未评分，不扣费", async () => {
    const chargeFixedModule = jest.fn()
    const service = new ListingAiService({ generateJson: jest.fn().mockResolvedValue({ data: buildScore(-1), billing: {} }) } as unknown as AiGatewayProvider,
      { chargeFixedModule, assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined) } as unknown as UsageService,
      { beginStep: jest.fn().mockResolvedValue(null) } as unknown as ListingRunService)
    const delivered = JSON.parse((await service.complete(1, { operation: "score", userPrompt: "score", responseFormat: "json_object" })).text)
    expect(delivered.total).toBeNull()
    expect(chargeFixedModule).not.toHaveBeenCalled()
  })
})
