import { getListingHistoryScore } from "./listing-history-score"

describe("Listing 列表分数", () => {
  it("保留小数并取全部已保存方案最高分，包含0分", () => {
    expect(getListingHistoryScore({ plans: [
      { result: {}, score: 99, scoreResult: { total: 94.5 } },
      { result: {}, scoreResult: { total: 90 } }, null,
    ] })).toBe(94.5)
    expect(getListingHistoryScore({ plans: [{ result: {}, scoreResult: { total: 0 } }] })).toBe(0)
  })
  it("暂未评分或重新生成后清除旧分数，不把无结果或非法分数算入", () => {
    expect(getListingHistoryScore({ plans: [
      { result: {}, score: 95, scoreResult: { total: null } },
      { scoreResult: { total: 99 } },
      { result: {}, scoreResult: { total: -1 } },
      { result: {}, scoreResult: { total: 101 } },
      { result: {}, scoreResult: { total: "95" } },
    ] })).toBeNull()
    expect(getListingHistoryScore({ plans: [{ result: {} }] })).toBeNull()
  })
  it("兼容旧方案分数，非方案报告不改动原分数字段", () => {
    expect(getListingHistoryScore({ plans: [{ result: {}, score: 88 }] })).toBe(88)
    expect(getListingHistoryScore({ result: {} })).toBeUndefined()
  })
})
