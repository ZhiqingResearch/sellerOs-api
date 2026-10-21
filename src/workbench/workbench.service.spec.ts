import { PrismaService } from "../prisma/prisma.service"
import { WorkbenchPeriod } from "./dto/workbench-query.dto"
import { WorkbenchFeatureKey, WorkbenchOutputItem, WorkbenchOutputQuery } from "./workbench-outputs"
import { WorkbenchService } from "./workbench.service"

interface MockOutputRow {
  recordId: string
  title: string | null
  occurredAt: Date
}

interface MockQueryBundle {
  query: WorkbenchOutputQuery
  count: jest.Mock<Promise<number>, [userId: number, since: Date | null]>
  latest: jest.Mock<
    Promise<WorkbenchOutputItem[]>,
    [userId: number, since: Date | null, limit: number]
  >
}

/** 构造一个固定产出的 mock 查询：counts=[全时间 count, 周期内 count] */
const mockQuery = (
  key: WorkbenchFeatureKey,
  label: string,
  counts: [number, number],
  items: MockOutputRow[] = []
): MockQueryBundle => {
  const item = (row: MockOutputRow): WorkbenchOutputItem => ({
    featureKey: key,
    featureLabel: label,
    recordId: row.recordId,
    title: row.title,
    occurredAt: row.occurredAt,
  })
  const count = jest.fn((userId: number, since: Date | null) =>
    Promise.resolve(since === null ? counts[0] : counts[1])
  )
  const latest = jest.fn((userId: number, since: Date | null, limit: number) =>
    Promise.resolve(items.slice(0, limit).map(item))
  )
  return { query: { key, label, count, latest }, count, latest }
}

describe("WorkbenchService", () => {
  const now = new Date("2026-09-10T12:00:00.000Z")

  const buildService = (queries: WorkbenchOutputQuery[]) =>
    new WorkbenchService({} as PrismaService, queries)

  beforeEach(() => {
    jest.spyOn(Date, "now").mockImplementation(() => now.getTime())
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("总览：汇总各功能 count，覆盖功能数与分布排序正确，count=0 不进分布", async () => {
    const service = buildService([
      mockQuery(WorkbenchFeatureKey.ASIN_AUDIT, "ASIN 自审", [5, 3]).query,
      mockQuery(WorkbenchFeatureKey.COMPETITOR, "竞品分析", [4, 4]).query,
      mockQuery(WorkbenchFeatureKey.LISTING, "Listing 生成", [0, 0]).query,
    ])

    const overview = await service.getOverview(1, { period: WorkbenchPeriod.LAST_30_DAYS })

    expect(overview.totalOutputs).toBe(7)
    expect(overview.featuresCovered).toBe(2)
    expect(overview.totalFeatures).toBe(3)
    expect(overview.period).toBe(WorkbenchPeriod.LAST_30_DAYS)
    // 按 count 降序；count=0 的功能不下发
    expect(overview.distribution.map(item => item.featureKey)).toEqual([
      WorkbenchFeatureKey.COMPETITOR,
      WorkbenchFeatureKey.ASIN_AUDIT,
    ])
  })

  it("总览：lastOutputAt 取全时间最近一次产出且不随周期变化", async () => {
    const bundle = mockQuery(
      WorkbenchFeatureKey.ASIN_AUDIT,
      "ASIN 自审",
      [2, 1],
      [{ recordId: "a", title: null, occurredAt: new Date("2026-09-09T11:53:00.000Z") }]
    )
    const service = buildService([bundle.query])

    const overview = await service.getOverview(1, { period: WorkbenchPeriod.LAST_7_DAYS })

    expect(overview.lastOutputAt).toBe("2026-09-09T11:53:00.000Z")
    // lastOutputAt 固定走全时间口径（since=null）
    expect(bundle.latest.mock.calls[0].slice(0, 2)).toEqual([1, null])
  })

  it("总览：无任何产出时 lastOutputAt 为 null", async () => {
    const service = buildService([mockQuery(WorkbenchFeatureKey.PUBLISH, "上架", [0, 0]).query])
    const overview = await service.getOverview(1, { period: WorkbenchPeriod.ALL })
    expect(overview.lastOutputAt).toBeNull()
  })

  it("周期映射：ALL 不加时间条件，近 7 天传滚动窗口起点", async () => {
    const bundle = mockQuery(WorkbenchFeatureKey.PRICING, "智能定价", [9, 2])
    const service = buildService([bundle.query])

    await service.getOverview(1, { period: WorkbenchPeriod.ALL })
    expect(bundle.count.mock.calls[0][1]).toBeNull()

    await service.getOverview(1, { period: WorkbenchPeriod.LAST_7_DAYS })
    const since = bundle.count.mock.calls[1][1]
    const expected = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    expect(since?.getTime()).toBe(expected.getTime())
  })

  it("最近产出：跨功能合并按时间倒序并截断 limit", async () => {
    const asin = mockQuery(
      WorkbenchFeatureKey.ASIN_AUDIT,
      "ASIN 自审",
      [2, 2],
      [
        { recordId: "a1", title: "B0GQB1C381", occurredAt: new Date("2026-09-09T11:53:00.000Z") },
        { recordId: "a2", title: "B09VLJJPL6", occurredAt: new Date("2026-09-08T08:32:00.000Z") },
      ]
    )
    const pricing = mockQuery(
      WorkbenchFeatureKey.PRICING,
      "智能定价",
      [1, 1],
      [{ recordId: "p1", title: "便携榨汁杯", occurredAt: new Date("2026-09-09T15:00:00.000Z") }]
    )
    const service = buildService([asin.query, pricing.query])

    const result = await service.getRecentOutputs(1, {
      period: WorkbenchPeriod.LAST_30_DAYS,
      limit: 2,
    })

    expect(result.items.map(item => item.recordId)).toEqual(["p1", "a1"])
    expect(result.items[0].featureKey).toBe(WorkbenchFeatureKey.PRICING)
    expect(result.items[0].featureLabel).toBe("智能定价")
  })
})
