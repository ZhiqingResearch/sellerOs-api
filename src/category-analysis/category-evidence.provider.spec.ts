import { ConfigService } from "@nestjs/config"
import axios from "axios"
import { createHash } from "crypto"
import { PrismaService } from "../prisma/prisma.service"
import { CategoryEvidenceProvider } from "./category-evidence.provider"

jest.mock("axios")
interface RequestOptions {
  url: string
  method?: string
  data?: { keywords?: string[]; asins?: string[]; month?: number }
  params?: Record<string, unknown>
}
const mockedAxios = axios as unknown as {
  request: jest.Mock<Promise<unknown>, [RequestOptions]>
  get: jest.Mock<Promise<unknown>, [string, { params: { asin: string; buybox?: number } }]>
}
const request = mockedAxios.request
const get = mockedAxios.get
const category = { nodeId: "123", nodeIdPath: "1:123", name: "Storage", path: "家居 > 收纳" }
const details = Array.from({ length: 35 }, (_, index) => ({
  asin: `B${String(index).padStart(9, "0")}`,
  title: "Spice rack",
  price: 20,
  boughtInPastMonth: 100,
  packageWeight: 453.592,
  packageLength: 304.8,
  packageWidth: 304.8,
  packageHeight: 304.8,
  bsrList: [{ id: "kitchen/123", name: "Storage", rank: 1 }],
}))
const usageOf = () => ({
  totalCalls: 0,
  callDetail: {} as Record<string, number>,
  endpointCalls: {} as Record<string, number>,
})
const providerOf = (config = { SIF_API_KEY: "test", KEEPA_API_KEY: "test" }) =>
  new CategoryEvidenceProvider(new ConfigService(config), {} as PrismaService)
function respond(options: { url: string; data?: Record<string, unknown> }) {
  const endpoint = options.url.split("/v2/")[1]
  const payload = options.data ?? {}
  let data: unknown = []
  if (endpoint === "category/suggestion") data = [{ categoryId: 123, categoryName: "Storage" }]
  if (endpoint === "relevanceScreen/keywordByCategory")
    data = [{ keyword: "storage", topAsin: details.slice(0, 30).map(row => ({ asin: row.asin })) }]
  if (endpoint === "categoryNewReleases")
    data = { list: details.slice(30).map(row => ({ asin: row.asin })) }
  if (endpoint === "batchAsinDetail")
    data = { list: details.filter(row => (payload.asins as string[]).includes(row.asin)) }
  if (endpoint === "batchKeywordSimpleOverview")
    data = (payload.keywords as string[]).map(keyword => ({ keyword, estSearchesNum: 12000 }))
  if (endpoint === "asinsHistorySales")
    data = Object.fromEntries(
      (payload.asins as string[]).map(asin => [asin, { "2026-01": 50, "2026-02": 100 }])
    )
  if (endpoint === "timeMachine/asinOpTrafficTrend")
    data = {
      dates: ["2026-01-01", "2026-01-31"],
      review: [10, 40],
      seller: [1, 3],
      bsr: [200, 100],
      buyboxPrice: [10, 20],
      nfScoreRatios: [0.7, 0.8],
    }
  if (endpoint === "competePatternFlexibleGroupByMonthly")
    data = {
      list: details
        .slice(0, 20)
        .map(row => ({ asin: row.asin, keyword: (payload.keywords as string[])[0] })),
    }
  return Promise.resolve({ data: { code: 1, data } })
}
beforeEach(() => {
  jest.resetAllMocks()
  request.mockImplementation(respond)
  get.mockResolvedValue({ data: { tokensLeft: 0 } })
})

it("实时样本合并新品，月销每批最多10个，头部趋势使用GET，字段单位正确", async () => {
  const result = await providerOf().collect(7, category, "US")
  expect(result.source).toBe("sif")
  expect(result.rows).toHaveLength(35)
  expect(result.newReleaseMerged).toBe(5)
  expect(result.rows[0].weightLb).toBeCloseTo(1)
  expect(result.rows[0].cuft).toBeCloseTo(1)
  expect(result.rows[0].bs).toBe(true)
  expect(result.rows[0].reviewsNew).toBe(30)
  expect(result.months).toHaveLength(2)
  const historyCalls = request.mock.calls.filter(([options]) =>
    options.url.endsWith("asinsHistorySales")
  )
  expect(historyCalls.map(([options]) => options.data!.asins!.length)).toEqual([10, 10, 10, 5])
  expect(historyCalls.every(([options]) => options.data!.month === 18)).toBe(true)
  expect(
    request.mock.calls
      .filter(([options]) => options.url.endsWith("asinOpTrafficTrend"))
      .every(([options]) => options.method === "GET" && options.params?.asin)
  ).toBe(true)
})
it("成功请求按次统计；并发与当天缓存不重复计费", async () => {
  const provider = providerOf(),
    first = usageOf(),
    second = usageOf()
  await Promise.all([
    provider.collect(7, category, "US", first),
    provider.collect(8, category, "US", second),
  ])
  expect(first.totalCalls + second.totalCalls).toBe(request.mock.calls.length)
  expect(second.totalCalls).toBe(0)
  const cached = usageOf()
  await provider.collect(7, category, "US", cached)
  expect(cached.totalCalls).toBe(0)
})
it("增加用户词只补新词五接口，复用样本历史和原头部词", async () => {
  const provider = providerOf()
  await provider.collect(7, category, "US")
  request.mockClear()
  const result = await provider.collect(7, category, "US", usageOf(), ["spice rack"])
  expect(request).toHaveBeenCalledTimes(5)
  expect(
    request.mock.calls.every(([options]) => options.data!.keywords!.join() === "spice rack")
  ).toBe(true)
  expect(result.keywords[0]).toMatchObject({ keyword: "spice rack", is_user: true })
})
it("未配置或样本不足均明确失败，不使用导入或虚构样本兜底", async () => {
  await expect(
    providerOf({ SIF_API_KEY: "", KEEPA_API_KEY: "" }).collect(7, category, "US")
  ).rejects.toThrow("尚未配置")
  request.mockImplementation(options =>
    options.url.endsWith("batchAsinDetail")
      ? Promise.resolve({ data: { code: 1, data: details.slice(0, 2) } })
      : respond(options)
  )
  const usage = usageOf()
  await expect(providerOf().collect(7, category, "US", usage)).rejects.toThrow("不足 30 条")
  expect(usage.totalCalls).toBe(4)
})
it("部分请求失败不计费，但不丢失已经成功的调用", async () => {
  request.mockImplementation(options =>
    options.url.endsWith("keywordConversionLast")
      ? Promise.resolve({ data: { code: -20 } })
      : options.url.endsWith("estSearchesHistory")
        ? Promise.reject(new Error("network"))
        : respond(options)
  )
  const usage = usageOf()
  const result = await providerOf().collect(7, category, "US", usage)
  expect(usage.totalCalls).toBe(request.mock.calls.length - 2)
  expect(usage.endpointCalls["sif:keywordConversionLast"]).toBeUndefined()
  expect(result.keywords[0].ppc).toBeNull()
  expect(result.notices.join()).toContain("需补充")
})
it("BuyBox商品按3token截断；零额度不请求卖家也不缓存空结果", async () => {
  const provider = providerOf()
  await provider.collect(7, category, "US")
  get
    .mockResolvedValueOnce({ data: { tokensLeft: 3 } })
    .mockResolvedValueOnce({
      data: { products: [{ asin: details[0].asin, stats: { buyBoxSellerId: "S1" } }] },
    })
    .mockResolvedValueOnce({ data: { tokensLeft: 0 } })
  const usage = usageOf()
  const result = await provider.collect(7, category, "US", usage)
  expect(result.keepa).toHaveLength(1)
  const product = get.mock.calls.find(([url]) => url.endsWith("/product"))![1].params
  expect(product.asin).toBe(details[0].asin)
  expect(product.buybox).toBe(1)
  expect(get.mock.calls.some(([url]) => url.endsWith("/seller"))).toBe(false)
  expect(usage.callDetail).toEqual({ keepa: 1 })
})
it("商品和卖家各计一次，画像按天缓存，token探测不计费", async () => {
  get.mockImplementation((url: string) =>
    Promise.resolve({
      data: url.endsWith("/token")
        ? { tokensLeft: 60 }
        : url.endsWith("/product")
          ? {
              products: details
                .slice(0, 10)
                .map(row => ({ asin: row.asin, stats: { buyBoxSellerId: "S1" } })),
            }
          : { sellers: { S1: { sellerName: "Store", address: ["HK"] } } },
    })
  )
  const provider = providerOf(),
    usage = usageOf()
  const result = await provider.collect(7, category, "US", usage)
  expect(usage.callDetail.keepa).toBe(2)
  expect(result.rows[0]).toMatchObject({ seller: "Store", sellerCountry: "HK", sellerId: "S1" })
  const cached = usageOf()
  await provider.collect(7, category, "US", cached)
  expect(cached.totalCalls).toBe(0)
})
it("关键词反查取数字类目ID、忽略退出榜与重复投票，合并多词候选", async () => {
  request.mockImplementation(options =>
    options.url.endsWith("batchAsinDetail")
      ? Promise.resolve({
          data: {
            code: 1,
            data: {
              list: [
                {
                  ...details[0],
                  bsrList: [
                    { id: "kitchen", rank: 1 },
                    { id: "kitchen/123", rank: 2, name: "Storage" },
                    { id: "kitchen/123", rank: 3 },
                    { id: "999", rank: -1 },
                  ],
                },
              ],
            },
          },
        })
      : respond(options)
  )
  const provider = providerOf(),
    usage = usageOf()
  const result = await provider.resolveKeywords(["spice rack", "storage"], "US", usage)
  expect(result.candidates[0]).toMatchObject({
    categoryId: "123",
    hits: 2,
    kws: ["spice rack", "storage"],
  })
  expect(result.candidates.some(candidate => candidate.categoryId === "999")).toBe(false)
  expect(result.topAsins).toHaveLength(20)
  const cached = usageOf()
  await provider.resolveKeywords(["spice rack", "storage"], "US", cached)
  expect(cached.totalCalls).toBe(0)
})

describe("SIF 十四天持久缓存", () => {
  const startedAt = Date.parse("2026-09-18T10:30:00Z")
  const ttlMs = 14 * 86400000
  function persistentProviders() {
    const rows = new Map<string, { payload: unknown; expiresAt: Date }>()
    const cacheTable = {
      findUnique: jest.fn(({ where }: { where: { cacheKey: string } }) =>
        Promise.resolve(rows.get(where.cacheKey) ?? null)
      ),
      upsert: jest.fn(
        ({
          where,
          create,
        }: {
          where: { cacheKey: string }
          create: { payload: unknown; expiresAt: Date }
        }) => {
          rows.set(where.cacheKey, create)
          return Promise.resolve(create)
        }
      ),
    }
    const create = () =>
      new CategoryEvidenceProvider(new ConfigService({ SIF_API_KEY: "test" }), {
        categoryAnalysisCache: cacheTable,
      } as unknown as PrismaService)
    return { create, rows, cacheTable }
  }
  beforeEach(() => jest.useFakeTimers({ now: startedAt }))
  afterEach(() => jest.useRealTimers())

  it("跨天、服务重启、其他用户与并发读取复用全部 SIF 数据，满14天才重新计费", async () => {
    const { create, rows, cacheTable } = persistentProviders()
    const first = usageOf()
    await create().collect(7, category, "US", first, ["spice rack"])
    const originalCalls = request.mock.calls.length
    expect(first.totalCalls).toBe(originalCalls)
    expect([...rows.values()].every(row => row.expiresAt.getTime() === startedAt + ttlMs)).toBe(
      true
    )
    const writes = cacheTable.upsert.mock.calls.length
    request.mockClear()
    jest.setSystemTime(startedAt + ttlMs - 1)
    const restarted = create()
    const cached = usageOf(),
      concurrent = usageOf()
    await Promise.all([
      restarted.collect(8, category, "US", cached, ["spice rack"]),
      restarted.collect(9, category, "US", concurrent, ["spice rack"]),
    ])
    expect(request).not.toHaveBeenCalled()
    expect(cached.totalCalls + concurrent.totalCalls).toBe(0)
    expect(cacheTable.upsert).toHaveBeenCalledTimes(writes)
    jest.setSystemTime(startedAt + ttlMs)
    const refreshed = usageOf()
    await restarted.collect(8, category, "US", refreshed, ["spice rack"])
    expect(request).toHaveBeenCalledTimes(originalCalls)
    expect(refreshed.totalCalls).toBe(originalCalls)
  })

  it("批量顺序和对象属性顺序不影响命中，站点、筛选和显式时间范围各自隔离", async () => {
    const { create } = persistentProviders()
    const provider = create()
    const call = (site: string, payload: Record<string, unknown>) =>
      provider["_sif"]("batchAsinDetail", site, payload, usageOf())
    await call("US", { asins: [details[0].asin, details[1].asin], month: 18 })
    await call("US", { month: 18, asins: [details[1].asin, details[0].asin] })
    expect(request).toHaveBeenCalledTimes(1)
    await call("UK", { month: 18, asins: [details[0].asin, details[1].asin] })
    await call("US", { month: 6, asins: [details[0].asin, details[1].asin] })
    const range = { asin: details[0].asin, startDate: "2026-01-01", endDate: "2026-02-01" }
    await provider["_sif"]("timeMachine/asinOpTrafficTrend", "US", range, usageOf(), true)
    await provider["_sif"](
      "timeMachine/asinOpTrafficTrend",
      "US",
      { ...range, endDate: "2026-03-01" },
      usageOf(),
      true
    )
    expect(request).toHaveBeenCalledTimes(5)
  })

  it("逐词缓存包含筛选条件，从旧批次恢复词缓存不延长到期时间", async () => {
    const { create, rows } = persistentProviders()
    const provider = create()
    const endpoint = "batchKeywordSimpleOverview"
    await provider["_keywordBatch"](endpoint, "US", ["rack"], { last30d: true }, usageOf())
    const wordKey = [...provider["cache"].keys()].find(key => key.startsWith("word:"))!
    rows.delete(createHash("sha256").update(wordKey).digest("hex"))
    jest.setSystemTime(startedAt + 13 * 86400000)
    await create()["_keywordBatch"](endpoint, "US", ["rack"], { last30d: true }, usageOf())
    expect(request).toHaveBeenCalledTimes(1)
    expect(rows.get(createHash("sha256").update(wordKey).digest("hex"))?.expiresAt.getTime()).toBe(
      startedAt + ttlMs
    )
    await provider["_keywordBatch"](endpoint, "US", ["rack"], { last30d: false }, usageOf())
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("失败响应不落缓存不计费，下次可立即重试", async () => {
    const { create, rows } = persistentProviders()
    const provider = create(),
      usage = usageOf()
    request.mockResolvedValueOnce({ data: { code: -20 } })
    await expect(provider["_sif"]("category/suggestion", "US", {}, usage, true)).rejects.toThrow(
      "配额"
    )
    expect(rows.size).toBe(0)
    expect(usage.totalCalls).toBe(0)
    await provider["_sif"]("category/suggestion", "US", {}, usage, true)
    expect(request).toHaveBeenCalledTimes(2)
    expect(usage.totalCalls).toBe(1)
  })
})
