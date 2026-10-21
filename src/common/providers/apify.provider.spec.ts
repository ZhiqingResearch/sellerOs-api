import { Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import { Country } from "../../audit/audit.marketplace"
import { ApifyProvider } from "./apify.provider"

jest.mock("axios")
const http = jest.mocked(axios)
const target = {
  url: "https://www.amazon.co.uk/dp/B012345678",
  asin: "B012345678",
  country: Country.UK,
}
const makeProvider = (token = "test-secret") =>
  new ApifyProvider(
    new ConfigService({
      APIFY_API_TOKEN: token,
      APIFY_MAX_RETRIES: 3,
      APIFY_RETRY_BASE_DELAY_MS: 0,
    })
  )

describe("Apify Amazon 兜底", () => {
  beforeEach(() => jest.clearAllMocks())
  afterEach(() => jest.restoreAllMocks())

  it("单商品 UK→GB，成功后限量补评论；两次调用均限制运行和等待", async () => {
    http.post
      .mockResolvedValueOnce({
        data: [{ asin: target.asin, url: target.url, title: "测试商品" }],
      })
      .mockResolvedValueOnce({ data: [{ productAsin: target.asin, reviewDescription: "正文" }] })
    const result = await makeProvider().fetchAmazonAuditProduct(target)
    expect(http.post.mock.calls).toHaveLength(2)
    expect(http.post.mock.calls[0]).toEqual([
      "https://api.apify.com/v2/actors/junglee~amazon-crawler/run-sync-get-dataset-items",
      {
        categoryOrProductUrls: [{ url: target.url }],
        maxItemsPerStartUrl: 1,
        maxProductVariantsAsSeparateResults: 0,
        maxOffers: 0,
        scrapeSellers: false,
        scrapeProductVariantPrices: false,
        scrapeProductDetails: true,
        proxyCountry: "GB",
      },
      {
        params: { timeout: 120 },
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
        timeout: 130_000,
      },
    ])
    expect(result.title).toBe("测试商品")
    expect(result.review).toMatchObject({ comment_list: [{ comment: "正文" }] })
    expect(http.post.mock.calls[1]).toEqual([
      "https://api.apify.com/v2/actors/junglee~amazon-reviews-scraper/run-sync-get-dataset-items",
      {
        productUrls: [{ url: target.url }],
        maxReviews: 20,
        includeGdprSensitive: false,
        sort: "helpful",
        reviewsUseProductVariantFilter: true,
        scrapeProductDetails: false,
      },
      {
        params: { timeout: 60 },
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
        timeout: 70_000,
      },
    ])
  })

  it.each([undefined, 408, 429, 500, 402])(
    "评论失败 %s 不重试、不丢商品、不泄漏凭证",
    async status => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {})
      http.isAxiosError.mockReturnValue(true)
      http.post
        .mockResolvedValueOnce({ data: [{ asin: target.asin, title: "商品" }] })
        .mockRejectedValueOnce({
          message: "test-secret",
          response: { status, data: "test-secret" },
        })
      const result = await makeProvider().fetchAmazonAuditProduct(target)
      expect(result).toMatchObject({ title: "商品", review: { comment_list: [] } })
      expect(http.post.mock.calls).toHaveLength(2)
      expect(JSON.stringify(warn.mock.calls)).not.toContain("test-secret")
    }
  )

  it.each([[], { unexpected: true }, [{ error: "no_results_found" }]])(
    "评论空结果保留商品 %#",
    async data => {
      http.post
        .mockResolvedValueOnce({ data: [{ asin: target.asin, title: "商品" }] })
        .mockResolvedValueOnce({ data })
      expect(await makeProvider().fetchAmazonAuditProduct(target)).toMatchObject({
        title: "商品",
        review: { comment_list: [] },
      })
    }
  )

  it("上游超量返回时仅保留 20 条正文", async () => {
    http.post
      .mockResolvedValueOnce({ data: [{ asin: target.asin, title: "商品", reviewsCount: 192 }] })
      .mockResolvedValueOnce({
        data: Array.from({ length: 25 }, (_, i) => ({
          productAsin: target.asin,
          reviewDescription: `正文${i}`,
        })),
      })
    const result = await makeProvider().fetchAmazonAuditProduct(target)
    expect((result.review as { comment_list: unknown[] }).comment_list).toHaveLength(20)
    expect(result.reviewCount).toBe(192)
  })

  it.each([undefined, 408, 429, 500, 402])(
    "网络/上游失败 %s 只启动一次且不泄漏响应",
    async status => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {})
      http.isAxiosError.mockReturnValue(true)
      http.post.mockRejectedValue({
        message: "test-secret",
        response: status ? { status, data: "test-secret" } : undefined,
      })
      await expect(makeProvider().fetchAmazonAuditProduct(target)).rejects.toThrow(
        "备用商品数据源暂不可用"
      )
      expect(http.post.mock.calls).toHaveLength(1)
      expect(JSON.stringify(warn.mock.calls)).not.toContain("test-secret")
    }
  )

  it.each([[], { unexpected: true }, [{ error: "product_not_found" }]])(
    "HTTP 200 空/错误结果不当成成功 %p",
    async data => {
      http.post.mockResolvedValue({ data })
      await expect(makeProvider().fetchAmazonAuditProduct(target)).rejects.toThrow("未获取到匹配")
      expect(http.post.mock.calls).toHaveLength(1)
    }
  )

  it("无 Token 或目标冲突不调用付费接口", async () => {
    await expect(makeProvider("").fetchAmazonAuditProduct(target)).rejects.toThrow(
      "备用商品数据源暂不可用"
    )
    await expect(
      makeProvider().fetchAmazonAuditProduct({ ...target, country: Country.US })
    ).rejects.toThrow("不支持该商品地址")
    expect(http.post.mock.calls).toHaveLength(0)
  })

  it.each(["pinterest", "instagram", "tiktok", "shop"])(
    "其他 Actor %s 保留默认重试和超时",
    async kind => {
      http.isAxiosError.mockReturnValue(true)
      http.post.mockRejectedValueOnce({ message: "network" }).mockResolvedValue({ data: [] })
      const provider = makeProvider()
      if (kind === "pinterest") await provider.searchPinterest(["test"], 1)
      if (kind === "instagram") await provider.searchInstagram(["test"], 1)
      if (kind === "tiktok") await provider.searchTikTok(["test"], 1)
      if (kind === "shop")
        await expect(provider.fetchTikTokShopProduct("123")).rejects.toThrow("未抓取到")
      expect(http.post.mock.calls).toHaveLength(2)
      expect(http.post.mock.calls[0][2]).toMatchObject({
        params: { token: "test-secret" },
        timeout: 120_000,
      })
    }
  )
})
