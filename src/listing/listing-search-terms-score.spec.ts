import { normalizeUnavailableSearchTerms } from "./listing-search-terms-score"

function createReport(description = "未提供后台搜索词数据") {
  return {
    total: 72, potential: "B级", dimensions: [
      { name: "CDQ完整性", score: 30 },
      { name: "关键词覆盖", maxScore: 25, score: 18, criteria: [
        { name: "核心关键词", score: 7 }, { name: "S/A关键词", score: 7 },
        { name: "长尾词", score: 2, deductions: [{ points: 3, reason: "覆盖不足" }] },
        { name: "后台搜索词写满且与标题不重复", maxScore: 4, score: 0, description,
          deductions: [{ points: 4, reason: description }] },
        { name: "关键词真实", score: 2 },
      ] },
      { name: "COSMO", score: 15 }, { name: "Alexa", score: 9 },
    ],
  }
}

describe("后台搜索词未获取不扣分", () => {
  it("只退回关键词第4项扣分，重复处理不再加分，保留其他维度与扣分", () => {
    const original = createReport()
    const result = normalizeUnavailableSearchTerms(original)
    expect(result.total).toBe(76)
    expect(result.dimensions[1].score).toBe(22)
    expect(result.dimensions[1].criteria![3]).toMatchObject({
      status: "UNAVAILABLE", score: 4, description: "SEARCH TERMS未获取", deductions: [],
    })
    expect(result.dimensions[1].criteria![2]).toEqual(original.dimensions[1].criteria![2])
    for (const index of [0, 2, 3]) expect(result.dimensions[index]).toEqual(original.dimensions[index])
    expect(normalizeUnavailableSearchTerms(result)).toEqual(result)
    expect(original.total).toBe(72)
  })

  it("确认已获取且为空、或内容不达标时保留原扣分", () => {
    for (const description of ["已从后台完整取证，确认内容为空", "实际后台搜索词只有80字节"]) {
      const report = createReport(description)
      expect(normalizeUnavailableSearchTerms(report)).toEqual(report)
    }
  })

  it("保留原有维度级额外扣分", () => {
    const report = createReport()
    report.dimensions[1].score = 8
    report.total = 62
    const result = normalizeUnavailableSearchTerms(report)
    expect(result.dimensions[1].score).toBe(12)
    expect(result.total).toBe(66)
  })

  it("不作用于其他平台", () => {
    const report = createReport()
    report.dimensions[0].name = "沃尔玛属性完整度"
    expect(normalizeUnavailableSearchTerms(report)).toEqual(report)
  })
})
