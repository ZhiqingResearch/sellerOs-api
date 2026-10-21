import { CompetitorEvidenceProvider } from "../competitor-analysis/competitor-evidence.provider"
import {
  OperationPlanProductService,
  parseOperationProductUrl,
} from "./operation-plan-product.service"

describe("单链接商品解析", () => {
  it("从各站点链接解析ASIN并剔除追踪参数", () => {
    expect(
      parseOperationProductUrl("https://amazon.co.uk/name/gp/product/b09vljjpl6?tag=x")
    ).toEqual({
      country: "UK",
      market: "amazon_uk",
      asin: "B09VLJJPL6",
      url: "https://www.amazon.co.uk/dp/B09VLJJPL6",
    })
    expect(parseOperationProductUrl("https://www.amazon.co.jp/gp/aw/d/B09VLJJPL6")).toMatchObject({
      country: "JP",
      market: "amazon_jp",
    })
  })
  it.each([
    "http://localhost/dp/B09VLJJPL6",
    "https://amazon.com@evil.test/dp/B09VLJJPL6",
    "https://www.amazon.com:1234/dp/B09VLJJPL6",
    "https://amzn.to/short",
    "https://www.amazon.com/search?q=abc",
  ])("不访问非完整商品链接：%s", url => {
    expect(() => parseOperationProductUrl(url)).toThrow()
  })
  it("复用真实画像数据，缺失价格不造价，不将本品冒充竞品", async () => {
    const collectModuleEvidence = jest.fn().mockResolvedValue({
      asins: ["B09VLJJPL6"],
      country: "US",
      collectedAt: "2026-09-22T00:00:00Z",
      sif: {
        profile: [
          { asin: "B09VLJJPL6", title: "真实商品", featureDescriptions: ["特点"], price: 0 },
        ],
      },
      keepa: null,
      sellerSprite: null,
      sources: [],
      callDetail: {},
    })
    const service = new OperationPlanProductService({
      collectModuleEvidence,
    } as unknown as CompetitorEvidenceProvider)
    const result = await service.resolve(
      parseOperationProductUrl("https://www.amazon.com/dp/B09VLJJPL6"),
      "request"
    )
    expect(result.currentPrice).toBeNull()
    expect(result.competitors).toEqual([])
    expect(result.sourceProduct).toMatchObject({ title: "真实商品", price: null })
    expect(collectModuleEvidence).toHaveBeenCalledWith("US", ["B09VLJJPL6"], "profile")
    collectModuleEvidence.mockResolvedValueOnce({
      asins: ["B09VLJJPL6"],
      sif: {},
      keepa: null,
      sources: [],
    })
    await expect(
      service.resolve(parseOperationProductUrl("https://www.amazon.com/dp/B09VLJJPL6"), "request")
    ).rejects.toThrow("有效商品资料")
  })
})
