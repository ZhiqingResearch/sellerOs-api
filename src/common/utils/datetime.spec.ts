import { beijingMonthKey, beijingMonthStart } from "./datetime"

describe("beijingMonthStart / beijingMonthKey（容器 UTC 也按北京自然月切）", () => {
  it("北京时间月中：起点为当月 1 日 00:00（东八区）对应的 UTC 时点", () => {
    // 北京 2026-08-15 12:00 = UTC 2026-08-15 04:00
    const now = new Date("2026-08-15T04:00:00.000Z")
    expect(beijingMonthStart(now).toISOString()).toBe("2026-07-31T16:00:00.000Z")
    expect(beijingMonthKey(now)).toBe("2026-08")
  })

  it("UTC 已是次月但北京仍上月末（北京 8/31 23:59）：仍算 8 月", () => {
    // 北京 2026-08-31 23:59 = UTC 2026-08-31 15:59
    const now = new Date("2026-08-31T15:59:00.000Z")
    expect(beijingMonthStart(now).toISOString()).toBe("2026-07-31T16:00:00.000Z")
    expect(beijingMonthKey(now)).toBe("2026-08")
  })

  it("UTC 仍上月末但北京已次月 1 日 00:00（关键窗口）：立即切到 9 月", () => {
    // 北京 2026-09-01 00:00 = UTC 2026-08-31 16:00 ——服务器本地（UTC）口径会错算 8 月
    const now = new Date("2026-08-31T16:00:00.000Z")
    expect(beijingMonthStart(now).toISOString()).toBe("2026-08-31T16:00:00.000Z")
    expect(beijingMonthKey(now)).toBe("2026-09")
  })

  it("offsetMonths=-1：上个北京自然月起点", () => {
    const now = new Date("2026-08-15T04:00:00.000Z")
    expect(beijingMonthStart(now, -1).toISOString()).toBe("2026-06-30T16:00:00.000Z")
  })

  it("跨年：北京 2027-01-01 00:30 切到 2027-01", () => {
    const now = new Date("2026-12-31T16:30:00.000Z")
    expect(beijingMonthStart(now).toISOString()).toBe("2026-12-31T16:00:00.000Z")
    expect(beijingMonthKey(now)).toBe("2027-01")
  })
})
