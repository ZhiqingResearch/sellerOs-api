import { BadGatewayException, BadRequestException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import { ApifyProvider } from "../common/providers/apify.provider"
import { CrawlerError, CrawlerProvider } from "../common/providers/crawler.provider"
import { PrismaService } from "../prisma/prisma.service"
import { Country, buildProductUrl } from "./audit.marketplace"
import { AuditService } from "./audit.service"

describe("AuditService.findDetail", () => {
  let service: AuditService
  let prisma: { auditProduct: { findUnique: jest.Mock; upsert: jest.Mock } }
  let crawler: { fetchAudit: jest.Mock }
  let apify: { fetchAmazonAuditProduct: jest.Mock }
  let config: Record<string, string | number>

  const upsertCreate = (): Record<string, unknown> => {
    const calls = prisma.auditProduct.upsert.mock.calls as unknown as Array<
      [{ create: Record<string, unknown> }]
    >
    return calls[0][0].create
  }

  beforeEach(async () => {
    prisma = {
      auditProduct: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest
          .fn()
          .mockImplementation((arg: { create: object }) =>
            Promise.resolve({ id: 1, ...arg.create })
          ),
      },
    }
    crawler = {
      fetchAudit: jest
        .fn()
        .mockResolvedValue({ title: "Echo", productId: "B0AAAAAAAA", qa: [], review: [] }),
    }
    apify = {
      fetchAmazonAuditProduct: jest
        .fn()
        .mockResolvedValue({ title: "备用商品", productId: "B0AAAAAAAA" }),
    }
    config = { PRODUCT_CACHE_TTL_DAYS: 30 }
    const module = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: CrawlerProvider, useValue: crawler },
        { provide: ConfigService, useValue: { get: (key: string) => config[key] } },
        { provide: ApifyProvider, useValue: apify },
      ],
    }).compile()
    service = module.get(AuditService)
  })

  it("url 与 asin 都不传 → 400", async () => {
    await expect(service.findDetail({} as never)).rejects.toBeInstanceOf(BadRequestException)
    expect(crawler.fetchAudit).not.toHaveBeenCalled()
  })

  it("传 asin + country=US → 拼出 amazon.com/dp/{ASIN}、入参 asin 优先、name 取返回 title", async () => {
    await service.findDetail({ asin: "b0aaaaaaaa", country: Country.US } as never)
    expect(crawler.fetchAudit).toHaveBeenCalledWith("https://www.amazon.com/dp/B0AAAAAAAA")
    const c = upsertCreate()
    expect(c.url).toBe("https://www.amazon.com/dp/B0AAAAAAAA")
    expect(c.country).toBe("US")
    expect(c.asin).toBe("B0AAAAAAAA")
    expect(c.name).toBe("Echo")
  })

  it("country=DE → amazon.de", async () => {
    await service.findDetail({ asin: "B0AAAAAAAA", country: Country.DE } as never)
    expect(crawler.fetchAudit).toHaveBeenCalledWith("https://www.amazon.de/dp/B0AAAAAAAA")
  })

  it("传完整 url → 走 url 分支，asin 从返回 productId 回填", async () => {
    await service.findDetail({ url: "https://www.amazon.com/dp/B0ZZZZZZZZ" } as never)
    expect(crawler.fetchAudit).toHaveBeenCalledWith("https://www.amazon.com/dp/B0ZZZZZZZZ")
    expect(upsertCreate().asin).toBe("B0AAAAAAAA")
  })

  it("爬虫返回超长/非法 productId + 带 query 串的 url → 从 /dp 段提取真实 ASIN，不触发 P2000", async () => {
    crawler.fetchAudit.mockResolvedValue({
      title: "Echo",
      productId: "B0BC93XFCZ?ref=dlx_deals_dg_dcl_extra_long_query", // > 32 字符脏值
      qa: [],
      review: [],
    })
    await service.findDetail({
      url: "https://www.amazon.com/Loves-cabin/dp/B0BC93XFCZ?ref=dlx_deals_dg_dcl_B0BC93XFCZ_dt_sl14_7c&th=1",
    } as never)
    expect(upsertCreate().asin).toBe("B0BC93XFCZ")
  })

  it("url 无 /dp 段且爬虫返回均非法 → asin 收口为 null，不触发 P2000", async () => {
    crawler.fetchAudit.mockResolvedValue({
      title: "Echo",
      productId: "this-is-not-a-valid-asin-and-way-too-long",
      qa: [],
      review: [],
    })
    await service.findDetail({ url: "https://www.amazon.com/some/landing/page?x=1" } as never)
    expect(upsertCreate().asin).toBeNull()
  })

  it("url 与 asin 都传 → 以 url 为准", async () => {
    await service.findDetail({
      url: "https://www.amazon.com/dp/B0ZZZZZZZZ",
      asin: "B0AAAAAAAA",
      country: Country.DE,
    } as never)
    expect(crawler.fetchAudit).toHaveBeenCalledWith("https://www.amazon.com/dp/B0ZZZZZZZZ")
  })

  it("缓存命中且未过期 → 直返，不调爬虫", async () => {
    prisma.auditProduct.findUnique.mockResolvedValue({
      id: 9,
      data: { title: "缓存商品" },
      fetchedAt: new Date(),
    })
    const res = await service.findDetail({ url: "https://www.amazon.com/dp/B0ZZZZZZZZ" } as never)
    expect((res as { id: number }).id).toBe(9)
    expect(crawler.fetchAudit).not.toHaveBeenCalled()
    expect(prisma.auditProduct.upsert).not.toHaveBeenCalled()
  })

  it("缓存过期（40 天前 > 30 天 TTL）→ 重新调爬虫 upsert", async () => {
    prisma.auditProduct.findUnique.mockResolvedValue({
      id: 9,
      fetchedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000),
    })
    await service.findDetail({ url: "https://www.amazon.com/dp/B0ZZZZZZZZ" } as never)
    expect(crawler.fetchAudit).toHaveBeenCalled()
    expect(prisma.auditProduct.upsert).toHaveBeenCalled()
  })

  it("爬虫与默认兜底均失败 → 抛 502", async () => {
    crawler.fetchAudit.mockRejectedValue(new CrawlerError("RATE_LIMITED", "限流"))
    apify.fetchAmazonAuditProduct.mockRejectedValue(new Error("备用数据源失败"))
    await expect(
      service.findDetail({ url: "https://www.amazon.com/dp/B0ZZZZZZZZ" } as never)
    ).rejects.toBeInstanceOf(BadGatewayException)
  })

  it("buildProductUrl 不支持的站点 → 400", () => {
    expect(() => buildProductUrl("walmart", Country.US, "B0AAAAAAAA")).toThrow(BadRequestException)
  })

  it("配置 Apify 优先时成功即返回，不调用原爬虫，来源与顺序由服务端记录", async () => {
    config.ASIN_AUDIT_PRIMARY_SOURCE = "apify"
    apify.fetchAmazonAuditProduct.mockResolvedValue({
      title: "备用商品",
      _fetchMeta: { source: "crawler", primarySource: "crawler" },
    })
    await service.findDetail({ url: "https://www.amazon.de/dp/B0AAAAAAAA" })
    expect(apify.fetchAmazonAuditProduct).toHaveBeenCalledTimes(1)
    expect(crawler.fetchAudit).not.toHaveBeenCalled()
    expect(upsertCreate()).toMatchObject({
      country: "DE",
      asin: "B0AAAAAAAA",
      data: { _fetchMeta: { source: "apify", primarySource: "apify" } },
    })
  })

  it.each(["error", "empty"])("Apify 优先但 %s 时仅回退一次原爬虫", async failure => {
    config.ASIN_AUDIT_PRIMARY_SOURCE = "apify"
    if (failure === "error") apify.fetchAmazonAuditProduct.mockRejectedValue(new Error("failed"))
    else apify.fetchAmazonAuditProduct.mockResolvedValue({})
    await service.findDetail({ asin: "B0AAAAAAAA" })
    expect(apify.fetchAmazonAuditProduct).toHaveBeenCalledTimes(1)
    expect(crawler.fetchAudit).toHaveBeenCalledTimes(1)
    expect(apify.fetchAmazonAuditProduct.mock.invocationCallOrder[0]).toBeLessThan(
      crawler.fetchAudit.mock.invocationCallOrder[0]
    )
    expect(upsertCreate().data).toMatchObject({
      _fetchMeta: { source: "crawler", primarySource: "apify" },
    })
  })

  it("Apify 优先时两路均失败返回 502，不写缓存", async () => {
    config.ASIN_AUDIT_PRIMARY_SOURCE = "apify"
    apify.fetchAmazonAuditProduct.mockRejectedValue(new Error("failed"))
    crawler.fetchAudit.mockResolvedValue({})
    await expect(service.findDetail({ asin: "B0AAAAAAAA" })).rejects.toBeInstanceOf(
      BadGatewayException
    )
    expect(apify.fetchAmazonAuditProduct).toHaveBeenCalledTimes(1)
    expect(crawler.fetchAudit).toHaveBeenCalledTimes(1)
    expect(prisma.auditProduct.upsert).not.toHaveBeenCalled()
  })

  it.each(["crawler", "invalid"])("顺序配置 %s 保持原爬虫优先", async primary => {
    config.ASIN_AUDIT_PRIMARY_SOURCE = primary
    await service.findDetail({ asin: "B0AAAAAAAA" })
    expect(crawler.fetchAudit).toHaveBeenCalledTimes(1)
    expect(apify.fetchAmazonAuditProduct).not.toHaveBeenCalled()
  })

  it.each(["crawler", "apify"])("切换到 %s 优先后跳过旧顺序缓存", async primary => {
    config.ASIN_AUDIT_PRIMARY_SOURCE = primary
    prisma.auditProduct.findUnique.mockResolvedValue({
      id: 9,
      data: {
        title: "旧缓存",
        _fetchMeta: { source: primary, primarySource: primary === "apify" ? "crawler" : "apify" },
      },
      fetchedAt: new Date(),
    })
    await service.findDetail({ asin: "B0AAAAAAAA" })
    expect(prisma.auditProduct.upsert).toHaveBeenCalledTimes(1)
    expect(upsertCreate().data).toMatchObject({
      _fetchMeta: { source: primary, primarySource: primary },
    })
  })

  it("启用 Apify 优先后跳过无顺序标记的历史缓存", async () => {
    config.ASIN_AUDIT_PRIMARY_SOURCE = "apify"
    prisma.auditProduct.findUnique.mockResolvedValue({
      data: { title: "历史缓存" },
      fetchedAt: new Date(),
    })
    await service.findDetail({ asin: "B0AAAAAAAA" })
    expect(apify.fetchAmazonAuditProduct).toHaveBeenCalledTimes(1)
  })

  it.each(["crawler", "apify"])("Apify 优先下实际来源 %s 的新缓存仍可复用", async source => {
    config.ASIN_AUDIT_PRIMARY_SOURCE = "apify"
    const cached = {
      id: 9,
      data: { title: "缓存商品", _fetchMeta: { source, primarySource: "apify" } },
      fetchedAt: new Date(),
    }
    prisma.auditProduct.findUnique.mockResolvedValue(cached)
    expect(await service.findDetail({ asin: "B0AAAAAAAA" })).toBe(cached)
    expect(apify.fetchAmazonAuditProduct).not.toHaveBeenCalled()
    expect(crawler.fetchAudit).not.toHaveBeenCalled()
  })

  it.each(["read", "write"])("Apify 优先时数据库 %s 失败不触发换源", async stage => {
    config.ASIN_AUDIT_PRIMARY_SOURCE = "apify"
    const error = new Error("db failed")
    if (stage === "read") prisma.auditProduct.findUnique.mockRejectedValue(error)
    else prisma.auditProduct.upsert.mockRejectedValue(error)
    await expect(service.findDetail({ asin: "B0AAAAAAAA" })).rejects.toBe(error)
    expect(crawler.fetchAudit).not.toHaveBeenCalled()
    expect(apify.fetchAmazonAuditProduct).toHaveBeenCalledTimes(stage === "read" ? 0 : 1)
  })

  it("配置 Apify 优先时不支持的 URL 仍只走原爬虫", async () => {
    config.ASIN_AUDIT_PRIMARY_SOURCE = "apify"
    await service.findDetail({ url: "https://www.amazon.com/s?k=test" })
    expect(crawler.fetchAudit).toHaveBeenCalledTimes(1)
    expect(apify.fetchAmazonAuditProduct).not.toHaveBeenCalled()
  })

  it.each([new Error("timeout with secret"), new CrawlerError("RATE_LIMITED", "限流")])(
    "抓取失败调用一次 Apify，目标按 URL，来源覆盖上游伪造值",
    async error => {
      crawler.fetchAudit.mockRejectedValue(error)
      await service.findDetail({
        url: "https://www.amazon.de/dp/B0AAAAAAAA",
        asin: "B0BBBBBBBB",
        country: Country.US,
      })
      expect(apify.fetchAmazonAuditProduct).toHaveBeenCalledTimes(1)
      expect(apify.fetchAmazonAuditProduct).toHaveBeenCalledWith({
        url: "https://www.amazon.de/dp/B0AAAAAAAA",
        asin: "B0AAAAAAAA",
        country: Country.DE,
      })
      expect(upsertCreate()).toMatchObject({
        asin: "B0AAAAAAAA",
        country: "DE",
        data: { _fetchMeta: { source: "apify" } },
      })
    }
  )

  it.each([{}, null, [], { asin: "B0AAAAAAAA", brand: "brand" }])(
    "无有效商品内容 %p 触发兜底",
    async raw => {
      crawler.fetchAudit.mockResolvedValue(raw)
      await service.findDetail({ asin: "B0AAAAAAAA" })
      expect(apify.fetchAmazonAuditProduct).toHaveBeenCalledTimes(1)
    }
  )

  it("正常商品缺评论不兜底且不信任上游来源字段", async () => {
    crawler.fetchAudit.mockResolvedValue({ title: "有标题", _fetchMeta: { source: "apify" } })
    await service.findDetail({ asin: "B0AAAAAAAA" })
    expect(apify.fetchAmazonAuditProduct).not.toHaveBeenCalled()
    expect(upsertCreate().data).toMatchObject({ _fetchMeta: { source: "crawler" } })
  })

  it.each([false, true])("Apify 缓存过期=%s 时恢复优先原爬虫", async expired => {
    prisma.auditProduct.findUnique.mockResolvedValue({
      id: 8,
      data: { title: "备用商品", _fetchMeta: { source: "apify" } },
      fetchedAt: new Date(Date.now() - (expired ? 3_600_001 : 1_000)),
    })
    await service.findDetail({ asin: "B0AAAAAAAA" })
    expect(crawler.fetchAudit).toHaveBeenCalledTimes(expired ? 1 : 0)
    expect(apify.fetchAmazonAuditProduct).not.toHaveBeenCalled()
  })

  it("无需额外启用配置即可命中备用缓存", async () => {
    prisma.auditProduct.findUnique.mockResolvedValue({
      data: { title: "备用商品", _fetchMeta: { source: "apify" } },
      fetchedAt: new Date(),
    })
    crawler.fetchAudit.mockRejectedValue(new Error("secret"))
    const result = await service.findDetail({ asin: "B0AAAAAAAA" })
    expect(result.data).toMatchObject({ _fetchMeta: { source: "apify" } })
    expect(crawler.fetchAudit).not.toHaveBeenCalled()
    expect(apify.fetchAmazonAuditProduct).not.toHaveBeenCalled()
  })

  it("空缓存不会命中；Apify 失败不入库，旧缓存不更新时间", async () => {
    prisma.auditProduct.findUnique.mockResolvedValue({ data: {}, fetchedAt: new Date() })
    crawler.fetchAudit.mockRejectedValue(new Error("primary secret"))
    apify.fetchAmazonAuditProduct.mockRejectedValue(new Error("token secret"))
    await expect(service.findDetail({ asin: "B0AAAAAAAA" })).rejects.toThrow(
      "商品详情暂时无法获取，请稍后重试"
    )
    expect(apify.fetchAmazonAuditProduct).toHaveBeenCalledTimes(1)
    expect(prisma.auditProduct.upsert).not.toHaveBeenCalled()
  })

  it.each(["read", "write"])("数据库 %s 失败不触发付费兜底", async stage => {
    const error = new Error("db unavailable")
    if (stage === "read") prisma.auditProduct.findUnique.mockRejectedValue(error)
    else prisma.auditProduct.upsert.mockRejectedValue(error)
    await expect(service.findDetail({ asin: "B0AAAAAAAA" })).rejects.toBe(error)
    expect(apify.fetchAmazonAuditProduct).not.toHaveBeenCalled()
  })

  it("无法解析的旧 URL 仍走主爬虫，失败不触发 Actor", async () => {
    crawler.fetchAudit.mockRejectedValue(new Error("failed"))
    await expect(
      service.findDetail({ url: "https://www.amazon.com/s?k=test" })
    ).rejects.toBeInstanceOf(BadGatewayException)
    expect(apify.fetchAmazonAuditProduct).not.toHaveBeenCalled()
  })
})
