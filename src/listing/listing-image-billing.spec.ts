import { BadGatewayException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/library"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { UsageService } from "../usage/usage.service"
import { ListingAiService } from "./listing-ai.service"
import { ListingRunService } from "./listing-run.service"
import * as imageTools from "./listing-score-images"
const records = { beginStep: jest.fn().mockResolvedValue(null) } as unknown as ListingRunService

describe("图片评分模型与扣费", () => {
  afterEach(() => jest.restoreAllMocks())
  it.each(["ZQ-Think-Flash", "ZQ-Think-Pro"] as const)(
    "%s 收到实际图片且仍只扣一次费用",
    async model => {
      const userContent = [
        {
          type: "image_url" as const,
          image_url: { url: "data:image/jpeg;base64,test", detail: "high" as const },
        },
      ]
      jest.spyOn(imageTools, "prepareListingScoreImages").mockResolvedValue(userContent)
      const streamChat = jest.fn().mockImplementation(async function* () {
        await Promise.resolve()
        yield { type: "text", content: '{"total":2,"dimensions":[{"criteria":[{"score":2,"maxScore":2,"deductions":[]}]}]}' }
        yield { type: "usage", usage: { promptTokens: 10, completionTokens: 5, thinkingTokens: 0 } }
        yield {
          type: "billing",
          billing: {
            model,
            costCny: "0.2",
            requestId: "image-score-1",
            requestIds: ["image-score-1"],
          },
        }
      })
      const chargeFixedModule = jest.fn().mockResolvedValue({})
      const service = new ListingAiService(
        { streamChat } as unknown as AiGatewayProvider,
        {
          chargeFixedModule,
          assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined), gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal("4")),
        } as unknown as UsageService,
        records
      )
      const result = await service.complete(7, {
        operation: "score",
        model,
        systemPrompt: "原评分规则",
        userPrompt: "文字",
        images: [{ url: "https://m.media-amazon.com/images/I/a.jpg", role: "main" }],
      })
      // 交付层会补齐展示字段；仍须保留模型的有效得分，并且只结算一次。
      expect(JSON.parse(result.text)).toMatchObject({
        total: 2,
        dimensions: [{
          score: 2,
          criteria: [{ score: 2, maxScore: 2, deductions: [] }],
        }],
        suggestions: [],
        potential: "",
      })
      expect(streamChat).toHaveBeenCalledWith(
        expect.stringContaining("CDQ采用当前提示词标准"),
        "文字",
        expect.objectContaining({ model, userContent, resolveBilling: true })
      )
      expect(chargeFixedModule).toHaveBeenCalledTimes(1)
      expect(chargeFixedModule).toHaveBeenCalledWith(
        7,
        "listing.score",
        expect.objectContaining({ model, requestId: "image-score-1" }), undefined
      )
    }
  )

  it("读图失败时不调用模型也不扣费", async () => {
    jest.spyOn(imageTools, "prepareListingScoreImages").mockRejectedValue(new Error("图片读取失败"))
    const streamChat = jest.fn(),
      chargeFixedModule = jest.fn()
    const service = new ListingAiService(
      { streamChat } as unknown as AiGatewayProvider,
      {
        chargeFixedModule,
        assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined), gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal("4")),
      } as unknown as UsageService,
      records
    )
    await expect(
      service.complete(7, {
        operation: "score",
        userPrompt: "文字",
        model: "ZQ-Think-Pro",
        images: [{ url: "https://m.media-amazon.com/images/I/a.jpg", role: "main" }],
      })
    ).rejects.toThrow("图片读取失败")
    expect(streamChat).not.toHaveBeenCalled()
    expect(chargeFixedModule).not.toHaveBeenCalled()
  })

  it.each([400, 503])("上游返回%s时不伪造结果、不改模型、不扣评分积分", async status => {
    jest.spyOn(imageTools, "prepareListingScoreImages").mockResolvedValue(undefined)
    const streamChat = jest.fn().mockImplementation(async function* () {
      yield await Promise.reject(new BadGatewayException(`AI 中转站调用失败（HTTP ${status}）`))
    })
    const chargeFixedModule = jest.fn()
    const service = new ListingAiService(
      { streamChat } as unknown as AiGatewayProvider,
      {
        chargeFixedModule,
        assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined), gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal("4")),
      } as unknown as UsageService,
      records
    )
    await expect(
      service.complete(7, {
        operation: "score",
        model: "ZQ-Think-Pro",
        userPrompt: "文字",
      })
    ).rejects.toThrow(`HTTP ${status}`)
    expect(streamChat).toHaveBeenCalledTimes(1)
    expect(streamChat).toHaveBeenCalledWith(
      expect.any(String),
      "文字",
      expect.objectContaining({ model: "ZQ-Think-Pro" })
    )
    expect(chargeFixedModule).not.toHaveBeenCalled()
  })

  it("不把图片送给 Lite 或其他业务", async () => {
    const prepare = jest.spyOn(imageTools, "prepareListingScoreImages")
    const service = new ListingAiService({} as AiGatewayProvider, { assertFixedModuleAffordable: jest.fn().mockResolvedValue(undefined) } as unknown as UsageService, records)
    const images = [{ url: "https://m.media-amazon.com/images/I/a.jpg", role: "main" as const }]
    await expect(
      service.complete(7, {
        operation: "score",
        model: "ZQ-Think-Lite",
        userPrompt: "文字",
        images,
      })
    ).rejects.toThrow("不支持图片评分")
    await expect(
      service.complete(7, { operation: "generation", userPrompt: "文字", images })
    ).rejects.toThrow("图片输入仅用于")
    expect(prepare).not.toHaveBeenCalled()
  })
})
