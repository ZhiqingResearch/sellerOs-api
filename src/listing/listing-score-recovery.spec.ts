import {
  extractScoreRecoveryCore,
  mergeScoreRepair,
  validateRecoveredScore,
  validateScoreReport,
} from "./listing-score-recovery"

const report = {
  total: 2,
  dimensions: [
    {
      name: "质量",
      score: 2,
      maxScore: 2,
      criteria: [{ name: "完整性", score: 2, maxScore: 2, deductions: [] }],
    },
  ],
  suggestions: ["补充具体使用场景"],
  potential: "A",
}

describe("评分结果受限恢复", () => {
  it("本地修复闭合对象的逗号问题，不需要模型", () => {
    const text = JSON.stringify(report).replace('"total":2,', '"total":2 ')
    expect(JSON.parse(validateScoreReport(text))).toEqual(report)
  })

  it("重现优化建议中途结束：保留完整评分核心，由一次修复补尾部", () => {
    const { suggestions: _suggestions, potential: _potential, ...core } = report
    const text = JSON.stringify(core).slice(0, -1) + ',"suggestions":["已有建议","标题建议未完'
    expect(() => validateScoreReport(text)).toThrow()
    expect(extractScoreRecoveryCore(text)).toEqual(core)
    expect(JSON.parse(validateRecoveredScore(JSON.stringify(report), core))).toEqual(report)
  })

  it.each([
    "没有评分 JSON",
    '{"total":2,"dimensions":[{"name":"质量","criteria":[',
    JSON.stringify({ ...report, dimensions: [{ ...report.dimensions[0], criteria: [] }] }),
  ])("缺失评分细则时拒绝让修复模型猜测: %s", text => {
    expect(() => extractScoreRecoveryCore(text)).toThrow()
  })

  it("修复模型不得改分数、扣分理由或已经完成的建议", () => {
    expect(() => validateRecoveredScore(JSON.stringify({ ...report, total: 1 }), report)).toThrow(
      "改变了原始评分"
    )
    expect(() =>
      validateRecoveredScore(JSON.stringify({ ...report, suggestions: ["新建议"] }), report)
    ).toThrow("改变了原始评分")
  })

  it("完整 JSON 仍须包含展示所需字段，Amazon 必须满足四维细则契约", () => {
    expect(() =>
      validateScoreReport(JSON.stringify({ ...report, suggestions: undefined }))
    ).toThrow()
    expect(() => validateScoreReport(JSON.stringify(report), "amazon_us")).toThrow()
  })

  it("不得新增会影响前端评分解释的字段", () => {
    expect(() =>
      validateRecoveredScore(JSON.stringify({ ...report, severeDefects: ["猜测的缺陷"] }), report)
    ).toThrow("新增了未经确认的字段")
  })

  it("只补评级时由后端保留原建议、评分与扣分理由", () => {
    const { potential: _potential, ...core } = report
    expect(JSON.parse(mergeScoreRepair('{"potential":"A"}', core))).toEqual(report)
    expect(() => mergeScoreRepair('{"potential":"A","suggestions":["改写建议"]}', core)).toThrow(
      "改变了原始评分"
    )
  })
})
