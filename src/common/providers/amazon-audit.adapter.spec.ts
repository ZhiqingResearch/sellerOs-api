import {
  adaptAuditDetail,
  extractReviewComments,
  extractReviewRows,
  extractReviewSamples,
} from "../../asin-audit/evidence/adapt-audit-detail"
import { hasAuditContent } from "../../audit/audit-data"
import { Country, parseAmazonAuditTarget } from "../../audit/audit.marketplace"
import {
  adaptAmazonAuditResults,
  adaptAmazonReviewResults,
  amazonStarPercent,
} from "./amazon-audit.adapter"

const target = {
  url: "https://www.amazon.com/dp/B012345678",
  asin: "B012345678",
  country: Country.US,
}
const product = { asin: target.asin, url: target.url, title: "商品" }

describe("Amazon 评论适配", () => {
  const review = {
    productAsin: target.asin,
    variantAsin: target.asin,
    input: target.url,
    reviewId: "R123",
    reviewDescription: "  原始正文\n第二行  ",
    reviewTitle: "标题",
    date: "2026-09-01",
    ratingScore: 4,
    isVerified: true,
    reviewReaction: "1",
    variant: "Black",
  }

  it("原文保留，贯通分析、抽样及下载；评论样本数不覆盖评分总数", () => {
    const data = adaptAmazonAuditResults([{ ...product, reviewsCount: 192 }], target)
    data.review = { star_percent: [], comment_list: adaptAmazonReviewResults([review], target) }
    const response = {
      id: 1,
      asin: target.asin,
      url: target.url,
      platform: "amazon",
      country: "US",
      name: "商品",
      data,
      fetchedAt: "2026-09-29T00:00:00Z",
      createdAt: "",
      updatedAt: "",
    }
    expect(extractReviewComments(response)).toMatchObject({
      reviewCount: 192,
      commentList: [{ comment: review.reviewDescription }],
    })
    expect(extractReviewSamples(response)).toEqual([
      { title: "标题", date: "2026-09-01", rating: 4, text: review.reviewDescription },
    ])
    expect(extractReviewRows(response)).toEqual([
      ["", "2026-09-01", "4", "标题", review.reviewDescription.trim(), "是", "1", "Black"],
    ])
  })

  it("丢弃错 ASIN、错变体、错站点、错误和无正文；按评论 ID 去重", () => {
    const rows = adaptAmazonReviewResults(
      [
        review,
        { ...review, reviewDescription: "重复 ID" },
        { ...review, productAsin: "B099999999", productOriginalAsin: target.asin },
        { ...review, variantAsin: "B099999999" },
        { ...review, input: "https://www.amazon.de/dp/B012345678" },
        { ...review, error: "no_results_found" },
        { ...review, reviewDescription: " " },
        null,
        { aiReviewsSummary: "摘要" },
      ],
      target
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].comment).toBe(review.reviewDescription)
  })

  it("可选字段未知留空，未验证购买保留否，缺少 ID 时去重", () => {
    const minimal = {
      productAsin: target.asin,
      reviewDescription: "正文",
      ratingScore: 9,
      isVerified: false,
    }
    expect(adaptAmazonReviewResults([minimal, minimal], target)).toEqual([
      {
        reviewId: "",
        date: "",
        star: null,
        title: "",
        comment: "正文",
        verified: "否",
        usefulNumber: "",
        variant: "",
      },
    ])
  })
})

describe("Amazon 审计适配", () => {
  it("A+ 对象图片贯通 A 卡，兼容字符串并从模块补图、去重、过滤占位图", () => {
    const first = "https://m.media-amazon.com/images/S/aplus-media-library-service-media/first.png"
    const second =
      "https://m.media-amazon.com/images/S/aplus-media-library-service-media/second.png"
    const data = adaptAmazonAuditResults(
      [
        {
          ...product,
          aPlusContent: {
            rawText: "Product description",
            rawImages: [
              { name: "laptop", url: first },
              first,
              null,
              { name: "无 URL" },
              { url: "https://img.test/grey-pixel.gif" },
            ],
            modules: [
              {
                type: "premium-module-2-fullbackground-image",
                image: { name: "laptop", url: first },
              },
              { type: "gallery", images: [{ name: "laptop", url: second }, "javascript:invalid"] },
            ],
          },
        },
      ],
      target
    )
    expect(data.aplusImages).toEqual([first, second])
    const cards = adaptAuditDetail({
      id: 1,
      asin: target.asin,
      url: target.url,
      platform: "amazon",
      country: "US",
      name: "商品",
      data,
      fetchedAt: "",
      createdAt: "",
      updatedAt: "",
    })
    expect(cards.A.aplusImages).toEqual([first, second])
    expect(cards.A.hasAplus).toBe(true)
    expect(data.aplusModules).toEqual([])
    expect(cards.A.aplusModules).toBeUndefined()
    expect(cards.A.productImages).toBeUndefined()
  })

  it("模块保留可读标题和正文，不向展示字段透传 Actor 布局代码", () => {
    const data = adaptAmazonAuditResults(
      [
        {
          ...product,
          aPlusContent: {
            modules: [
              {
                type: "premium-module-2-fullbackground-image",
                title: "品牌故事",
                text: "真实文案",
              },
              { type: "premium-module-13-carousel", text: "产品特点" },
              { type: "premium-module-16-tech-specs" },
            ],
          },
        },
      ],
      target
    )
    expect(data.aplusModules).toEqual([
      { type: "品牌故事", desc: "真实文案" },
      { type: "A+", desc: "产品特点" },
    ])
  })

  it("原文兜底去除区块标题及翻页噪音，保留真实文字", () => {
    const data = adaptAmazonAuditResults(
      [
        {
          ...product,
          aPlusContent: {
            rawText: "Product description\nPrevious page\n材质与工艺\nNext page",
            modules: [{ type: "premium-module-16-tech-specs" }],
          },
        },
      ],
      target
    )
    expect(data.aplusModules).toEqual([{ type: "A+", desc: "材质与工艺" }])
  })

  it.each([false, true])(
    "rawImages 缺失时可从模块图片或轮播 items 获取 A+ 图片，轮播=%s",
    carousel => {
      const url = "https://img.test/aplus.png"
      expect(
        adaptAmazonAuditResults(
          [
            {
              ...product,
              aPlusContent: {
                modules: [
                  carousel
                    ? {
                        type: "premium-module-12-nav-carousel",
                        items: [{ image: { url } }, { name: "参数", text: "普通文字" }],
                      }
                    : { image: { url } },
                ],
              },
            },
          ],
          target
        )
      ).toMatchObject({ aplusImages: [url], hasAplus: true })
    }
  )

  it("商品字段贯通现有 A/P/B，零评论保留，摘要不冒充原文", () => {
    const data = adaptAmazonAuditResults(
      [
        {
          ...product,
          features: ["五点", ""],
          stars: 4.5,
          reviewsCount: 0,
          highResolutionImages: [
            "https://img.test/main.jpg",
            "https://img.test/sub.jpg",
            "https://img.test/main.jpg",
          ],
          thumbnailImage: "https://img.test/low.jpg",
          attributes: [{ key: "Weight", value: "1kg" }],
          attributesMapped: { Weight: "1kg", Color: "Black" },
          productOverview: [
            { key: "Weight", value: "1kg" },
            { key: "Material", value: "Steel" },
          ],
          aPlusContent: { rawText: "品牌说明", rawImages: ["https://img.test/aplus.jpg"] },
          starsBreakdown: { "5 star": 70, "4 star": 20, "3 star": 5, "2 star": 3, "1 star": 2 },
          aiReviewsSummary: { text: "摘要" },
          answeredQuestions: 12,
          videosCount: 0,
        },
      ],
      target
    )
    const response = {
      id: 1,
      asin: target.asin,
      url: target.url,
      platform: "amazon",
      country: "US",
      name: "商品",
      data,
      fetchedAt: "2026-09-29T00:00:00Z",
      createdAt: "",
      updatedAt: "",
    }
    const cards = adaptAuditDetail(response)
    expect(cards.A).toMatchObject({
      filled: true,
      title: "商品",
      bullets: ["五点"],
      hasAplus: true,
      hasVideo: false,
      productImages: [
        { url: "https://img.test/main.jpg", role: "main" },
        { url: "https://img.test/sub.jpg", role: "secondary" },
      ],
    })
    expect(cards.P.groups?.flatMap(group => group.fields)).toEqual([
      { k: "Weight", v: "1kg" },
      { k: "Color", v: "Black" },
      { k: "Material", v: "Steel" },
    ])
    expect(cards.B).toMatchObject({
      filled: true,
      rating: 4.5,
      reviewCount: 0,
      dist: [
        { label: "5★", pct: "70%", bad: false },
        { label: "4★", pct: "20%", bad: false },
        { label: "3★", pct: "5%", bad: false },
        { label: "2★", pct: "3%", bad: true },
        { label: "1★", pct: "2%", bad: true },
      ],
    })
    expect(cards.A.qa).toBeUndefined()
    expect(cards.B.reviewSamples).toBeUndefined()
    expect(extractReviewComments(response).commentList).toEqual([])
  })

  it("可选内容缺失保留未知，图片回退缩略图", () => {
    const data = adaptAmazonAuditResults(
      [
        {
          ...product,
          stars: NaN,
          reviewsCount: -1,
          thumbnailImage: "https://img.test/main.jpg",
          galleryThumbnails: ["https://img.test/main.jpg", "https://img.test/sub.jpg"],
        },
      ],
      target
    )
    expect(data).toMatchObject({
      hasAplus: null,
      hasVideo: null,
      rating: null,
      reviewCount: null,
      imageUrl: "https://img.test/main.jpg",
      otherImagesUrl: ["https://img.test/sub.jpg"],
    })
  })

  it.each(
    [
      [],
      [{ error: "product_not_found", ...product }],
      [{ ...product, title: " " }],
      [{ ...product, asin: "B099999999", originalAsin: target.asin }],
      [{ ...product, url: "https://www.amazon.de/dp/B012345678" }],
      [{ ...product, loadedCountryCode: "DE" }],
      [{ ...product, url: "https://amazon.com.evil.test/dp/B012345678" }],
    ].map(items => ({ items }))
  )("拒绝空/错误/错商品结果 %#", ({ items }) => {
    expect(() => adaptAmazonAuditResults(items, target)).toThrow("备用数据源未获取到匹配的商品详情")
  })

  it("从混合结果中选择目标商品，英国接受 GB 国家码", () => {
    const uk = { ...target, country: Country.UK, url: "https://www.amazon.co.uk/dp/B012345678" }
    expect(
      adaptAmazonAuditResults(
        [{ error: "invalid_url" }, { ...product, url: uk.url, loadedCountryCode: "GB" }],
        uk
      )
    ).toMatchObject({ productId: target.asin, marketplace: "UK" })
  })

  it("整组判断比例单位，不把不完整分布或异常值变成百分比", () => {
    expect(
      amazonStarPercent({
        "5star": 0.86,
        "4star": 0.09,
        "3star": 0.03,
        "2star": 0.01,
        "1star": 0.01,
      })
    ).toEqual(["86%", "9%", "3%", "1%", "1%"])
    expect(
      amazonStarPercent({ "5 star": 86, "4 star": 9, "3 star": 3, "2 star": 1, "1 star": 1 })
    ).toEqual(["86%", "9%", "3%", "1%", "1%"])
    expect(amazonStarPercent({ "5star": 0.86 })).toEqual([])
    expect(
      amazonStarPercent({ "5star": 0, "4star": 0, "3star": 0, "2star": 0, "1star": 0 })
    ).toEqual([])
  })
})

describe("抓取目标与轻量数据校验", () => {
  it.each([
    "https://amazon.de/gp/product/b012345678?x=1",
    "https://m.amazon.de/gp/aw/d/B012345678",
    "https://www.amazon.de/title/dp/B012345678/ref=test",
  ])("解析商品路径 %s", url => {
    expect(parseAmazonAuditTarget(url)).toEqual({
      asin: target.asin,
      country: "DE",
      url: "https://www.amazon.de/dp/B012345678",
    })
  })
  it.each([
    "https://amazon.com.evil.test/dp/B012345678",
    "https://evil.test/dp/B012345678",
    "https://www.amazon.com/s?k=x",
    "https://www.amazon.com/dp/B0123456789",
    "ftp://amazon.com/dp/B012345678",
    "https://user:pass@amazon.com/dp/B012345678",
  ])("不接收非目标商品地址 %s", url => {
    expect(parseAmazonAuditTarget(url)).toBeNull()
  })
  it.each([{}, [], null, { productId: target.asin }, { rating: "bad" }, { reviewCount: -1 }])(
    "无有效内容 %p",
    data => expect(hasAuditContent(data)).toBe(false)
  )
  it.each([
    { title: "商品" },
    { reviewCount: 0 },
    { rating: "4.5" },
    { product_information_hhl: { Params: [["Weight", "1kg"]] } },
    { overviews: { Weight: "1kg" } },
    { images: [{ url: "https://img.test/a.jpg" }] },
  ])("有部分内容 %p", data => expect(hasAuditContent(data)).toBe(true))
})
