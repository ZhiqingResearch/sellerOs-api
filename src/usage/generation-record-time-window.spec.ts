import { recentGenerationQuery } from "./generation-record-time-window"

const now = new Date("2026-11-03T12:00:00.000Z")

describe("用户生成记录近 14 天范围", () => {
  it("默认覆盖最近 14×24 小时，保留其他筛选且不修改入参", () => {
    const query = { function: "IMAGE", dateFrom: undefined }
    expect(recentGenerationQuery(query, now)).toEqual({
      function: "IMAGE",
      dateFrom: "2026-10-20T12:00:00.000Z",
      dateTo: now.toISOString(),
    })
    expect(query).toEqual({ function: "IMAGE", dateFrom: undefined })
  })

  it("显式时间不能扩大窗口，未来结束时间裁到当前时刻", () => {
    expect(recentGenerationQuery({ dateFrom: "2020-01-01", dateTo: "2030-01-01" }, now)).toEqual({
      dateFrom: "2026-10-20T12:00:00.000Z",
      dateTo: now.toISOString(),
    })
  })

  it("保留窗口内更窄的筛选，纯日期结束仍包含当日", () => {
    expect(
      recentGenerationQuery({ dateFrom: "2026-11-01T08:00:00+08:00", dateTo: "2026-11-02" }, now)
    ).toEqual({ dateFrom: "2026-11-01T00:00:00.000Z", dateTo: "2026-11-02T23:59:59.999Z" })
  })

  it("完全位于窗口外的日期产生空交集，不扩成一次全历史查询", () => {
    const range = recentGenerationQuery({ dateFrom: "2026-09-01", dateTo: "2026-09-02" }, now)
    expect(range.dateFrom > range.dateTo).toBe(true)
  })
})
