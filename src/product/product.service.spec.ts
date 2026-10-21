import { BadGatewayException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import { CrawlOutcome } from "@prisma/client"
import { ApifyProvider } from "../common/providers/apify.provider"
import { CrawlerError, CrawlerProvider } from "../common/providers/crawler.provider"
import { PrismaService } from "../prisma/prisma.service"
import { ProductService } from "./product.service"

describe("ProductService", () => {
  let service: ProductService
  let prisma: {
    product: { findUnique: jest.Mock; upsert: jest.Mock }
    crawlLog: { create: jest.Mock }
  }
  let crawler: { fetchPdp: jest.Mock }
  let apify: { fetchTikTokShopProduct: jest.Mock }
  let config: { get: jest.Mock }

  const URL = "https://www.amazon.com/dp/B0XXXX"
  const USER_ID = 7

  const amazonRaw = {
    platform: "amazon",
    marketplace: "US",
    productId: "B0XXXX",
    url: URL,
    fetchAt: "2026-05-08T03:00:00Z",
    title: "Echo Dot",
    second_title: null,
    brand: "Amazon",
    price: "$49.99",
  }

  const walmartRaw = {
    platform: "walmart",
    marketplace: "US",
    productId: "WM123",
    url: "https://www.walmart.com/ip/WM123",
    fetchAt: "2026-05-08T03:00:00Z",
    title: "Walmart Item",
    brand: "Foo",
  }

  beforeEach(async () => {
    prisma = {
      product: { findUnique: jest.fn(), upsert: jest.fn() },
      crawlLog: { create: jest.fn().mockResolvedValue({}) },
    }
    crawler = { fetchPdp: jest.fn() }
    apify = { fetchTikTokShopProduct: jest.fn() }
    config = { get: jest.fn().mockReturnValue(30) } // 默认 TTL 30 天

    const module = await Test.createTestingModule({
      providers: [
        ProductService,
        { provide: PrismaService, useValue: prisma },
        { provide: CrawlerProvider, useValue: crawler },
        { provide: ApifyProvider, useValue: apify },
        { provide: ConfigService, useValue: config },
      ],
    }).compile()

    service = module.get(ProductService)
  })

  describe("缓存命中", () => {
    it("旧 Amazon 缓存没有 second_title 时重新抓取并保留真实副标题", async () => {
      const legacyData = { ...amazonRaw } as Record<string, unknown>
      delete legacyData.second_title
      prisma.product.findUnique.mockResolvedValue({
        id: 1, platform: "amazon", data: legacyData, fetchedAt: new Date(),
      })
      const secondTitle = "原始副标题，不由 AI 改写"
      crawler.fetchPdp.mockResolvedValue({ ...amazonRaw, second_title: secondTitle })
      prisma.product.upsert.mockResolvedValue({ id: 1 })

      await service.findByUrl(USER_ID, URL)

      expect(crawler.fetchPdp).toHaveBeenCalledWith(URL)
      expect(prisma.product.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ data: expect.objectContaining({ second_title: secondTitle }) }),
        update: expect.objectContaining({ data: expect.objectContaining({ second_title: secondTitle }) }),
      }))
    })

    it("新抓取无副标题时记录 null，随后继续命中缓存而不是反复抓取", async () => {
      const rawWithoutHighlights = { ...amazonRaw } as Record<string, unknown>
      delete rawWithoutHighlights.second_title
      prisma.product.findUnique.mockResolvedValue(null)
      crawler.fetchPdp.mockResolvedValue(rawWithoutHighlights)
      prisma.product.upsert.mockImplementation(async ({ create }) => ({
        id: 1, ...create,
      }))

      const product = await service.findByUrl(USER_ID, URL)
      expect(product.data).toMatchObject({ second_title: null })
      prisma.product.findUnique.mockResolvedValue(product)
      expect(await service.findByUrl(USER_ID, URL)).toBe(product)
      expect(crawler.fetchPdp).toHaveBeenCalledTimes(1)
    })

    it("其他平台缺少 second_title 不影响缓存命中", async () => {
      const product = { id: 1, platform: "walmart", data: walmartRaw, fetchedAt: new Date() }
      prisma.product.findUnique.mockResolvedValue(product)
      expect(await service.findByUrl(USER_ID, walmartRaw.url)).toBe(product)
      expect(crawler.fetchPdp).not.toHaveBeenCalled()
    })

    it("fetchedAt 距今 1 天 → 直接返回 existing，不调爬虫，不写流水", async () => {
      const fetchedAt = new Date(Date.now() - 24 * 3600 * 1000)
      const existing = {
        id: 1,
        url: URL,
        urlHash: "hash",
        platform: "amazon",
        name: "cached",
        data: amazonRaw,
        fetchedAt,
      }
      prisma.product.findUnique.mockResolvedValue(existing)

      const result = await service.findByUrl(USER_ID, URL)

      expect(result).toBe(existing)
      expect(crawler.fetchPdp).not.toHaveBeenCalled()
      expect(prisma.product.upsert).not.toHaveBeenCalled()
      expect(prisma.crawlLog.create).not.toHaveBeenCalled()
    })
  })

  describe("缓存过期", () => {
    it("fetchedAt 距今 31 天 → 调爬虫、upsert、log SUCCESS", async () => {
      const stale = {
        id: 1,
        urlHash: "hash",
        platform: "amazon",
        fetchedAt: new Date(Date.now() - 31 * 24 * 3600 * 1000),
      }
      prisma.product.findUnique.mockResolvedValue(stale)
      crawler.fetchPdp.mockResolvedValue(amazonRaw)
      prisma.product.upsert.mockResolvedValue({ id: 1, ...amazonRaw, name: "Echo Dot" })

      await service.findByUrl(USER_ID, URL)

      expect(crawler.fetchPdp).toHaveBeenCalledWith(URL)
      expect(prisma.product.upsert).toHaveBeenCalledTimes(1)
      const logArg = prisma.crawlLog.create.mock.calls[0][0] as {
        data: Record<string, unknown>
      }
      expect(logArg.data).toMatchObject({
        userId: USER_ID,
        url: URL,
        outcome: CrawlOutcome.SUCCESS,
        productId: 1,
      })
      expect(logArg.data.durationMs).toEqual(expect.any(Number))
    })
  })

  describe("缓存 miss", () => {
    it("findUnique 返回 null → 调爬虫、upsert、log SUCCESS", async () => {
      prisma.product.findUnique.mockResolvedValue(null)
      crawler.fetchPdp.mockResolvedValue(amazonRaw)
      prisma.product.upsert.mockResolvedValue({ id: 5, name: "Echo Dot" })

      await service.findByUrl(USER_ID, URL)

      expect(crawler.fetchPdp).toHaveBeenCalledWith(URL)
      const upsertArg = prisma.product.upsert.mock.calls[0][0] as {
        where: { urlHash: string }
        create: { url: string; platform: string; name: string }
      }
      expect(upsertArg.where.urlHash).toMatch(/^[a-f0-9]{64}$/)
      expect(upsertArg.create.platform).toBe("amazon")
      expect(upsertArg.create.name).toBe("Echo Dot")
    })

    it("Walmart 平台正确归一化为小写字符串", async () => {
      prisma.product.findUnique.mockResolvedValue(null)
      crawler.fetchPdp.mockResolvedValue(walmartRaw)
      prisma.product.upsert.mockResolvedValue({ id: 6 })

      await service.findByUrl(USER_ID, "https://www.walmart.com/ip/WM123")

      const upsertArg = prisma.product.upsert.mock.calls[0][0] as {
        create: { platform: string }
      }
      expect(upsertArg.create.platform).toBe("walmart")
    })

    it("新平台 ebay → 直接按爬虫返回值存为字符串，不抛错", async () => {
      prisma.product.findUnique.mockResolvedValue(null)
      crawler.fetchPdp.mockResolvedValue({ ...amazonRaw, platform: "EBAY" })
      prisma.product.upsert.mockResolvedValue({ id: 7 })

      await service.findByUrl(USER_ID, "https://www.ebay.com/itm/123")

      const upsertArg = prisma.product.upsert.mock.calls[0][0] as {
        create: { platform: string }
      }
      expect(upsertArg.create.platform).toBe("ebay")
    })
  })

  describe("爬虫错误处理", () => {
    it("CrawlerError → 抛 BadGatewayException + log FAILED 含 errorCode/errorMessage", async () => {
      prisma.product.findUnique.mockResolvedValue(null)
      crawler.fetchPdp.mockRejectedValue(new CrawlerError("RATE_LIMITED", "请求过快"))

      await expect(service.findByUrl(USER_ID, URL)).rejects.toThrow(BadGatewayException)

      const logArg = prisma.crawlLog.create.mock.calls[0][0] as {
        data: Record<string, unknown>
      }
      expect(logArg.data).toMatchObject({
        userId: USER_ID,
        url: URL,
        outcome: CrawlOutcome.FAILED,
        errorCode: "RATE_LIMITED",
        errorMessage: "请求过快",
      })
      expect(prisma.product.upsert).not.toHaveBeenCalled()
    })

    it("非 CrawlerError（网络异常）→ errorCode=UNEXPECTED，仍 log FAILED", async () => {
      prisma.product.findUnique.mockResolvedValue(null)
      crawler.fetchPdp.mockRejectedValue(new Error("ECONNRESET"))

      await expect(service.findByUrl(USER_ID, URL)).rejects.toThrow(BadGatewayException)

      const logArg = prisma.crawlLog.create.mock.calls[0][0] as {
        data: Record<string, unknown>
      }
      expect(logArg.data).toMatchObject({
        outcome: CrawlOutcome.FAILED,
        errorCode: "UNEXPECTED",
        errorMessage: "ECONNRESET",
      })
    })

    it("platform 为空 且 URL host 也无法识别 → 抛 BadGatewayException UNKNOWN_PLATFORM", async () => {
      prisma.product.findUnique.mockResolvedValue(null)
      crawler.fetchPdp.mockResolvedValue({ ...amazonRaw, platform: undefined })

      await expect(service.findByUrl(USER_ID, "https://short.example.com/abc")).rejects.toThrow(
        BadGatewayException
      )
    })

    it("URL host 不可识别但上游 platform 可识别 → 用上游字段", async () => {
      prisma.product.findUnique.mockResolvedValue(null)
      crawler.fetchPdp.mockResolvedValue({ ...amazonRaw, platform: "amazon" })
      prisma.product.upsert.mockResolvedValue({ id: 8 })

      await service.findByUrl(USER_ID, "https://short.example.com/abc")

      const upsertArg = prisma.product.upsert.mock.calls[0][0] as {
        create: { platform: string }
      }
      expect(upsertArg.create.platform).toBe("amazon")
    })

    it("上游 platform 为空但 URL host 是 walmart → fallback 推断为 walmart", async () => {
      prisma.product.findUnique.mockResolvedValue(null)
      crawler.fetchPdp.mockResolvedValue({ ...walmartRaw, platform: undefined })
      prisma.product.upsert.mockResolvedValue({ id: 9 })

      await service.findByUrl(USER_ID, "https://www.walmart.com/ip/WM999")

      const upsertArg = prisma.product.upsert.mock.calls[0][0] as {
        create: { platform: string }
      }
      expect(upsertArg.create.platform).toBe("walmart")
    })
  })

  describe("TTL 配置", () => {
    it("PRODUCT_CACHE_TTL_DAYS=1：fetchedAt 2 天前算过期，触发爬虫", async () => {
      config.get.mockReturnValue(1)
      prisma.product.findUnique.mockResolvedValue({
        id: 1,
        fetchedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000),
      })
      crawler.fetchPdp.mockResolvedValue(amazonRaw)
      prisma.product.upsert.mockResolvedValue({ id: 1 })

      await service.findByUrl(USER_ID, URL)

      expect(crawler.fetchPdp).toHaveBeenCalled()
    })

    it("env 未设置时走默认 30 天", async () => {
      config.get.mockReturnValue(undefined)
      prisma.product.findUnique.mockResolvedValue({
        id: 1,
        fetchedAt: new Date(Date.now() - 29 * 24 * 3600 * 1000), // 29 天前 < 30 天
      })

      const result = await service.findByUrl(USER_ID, URL)

      expect(result).toBeDefined()
      expect(crawler.fetchPdp).not.toHaveBeenCalled()
    })
  })

  describe("urlHash 一致性", () => {
    it("同一 URL 产生同一 hash", async () => {
      prisma.product.findUnique.mockResolvedValue(null)
      crawler.fetchPdp.mockResolvedValue(amazonRaw)
      prisma.product.upsert.mockResolvedValue({ id: 1 })

      await service.findByUrl(USER_ID, URL)
      const hash1 = (prisma.product.findUnique.mock.calls[0][0] as { where: { urlHash: string } })
        .where.urlHash

      await service.findByUrl(USER_ID, URL)
      const hash2 = (prisma.product.findUnique.mock.calls[1][0] as { where: { urlHash: string } })
        .where.urlHash

      expect(hash1).toBe(hash2)
    })
  })
})
