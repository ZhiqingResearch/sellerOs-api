import {
  extractScoreRecoveryCore,
  validateRecoveredScore,
  validateScoreReport,
} from "./listing-score-recovery"

// 按正式 Amazon 四维结构构造的脱敏样本，不冒充生产原始正文。
const dimensions = [
  { name: "CDQ 内容质量", limits: [12, 10, 8, 6, 2, 2] },
  { name: "关键词布局", limits: [7, 7, 5, 4, 2] },
  { name: "COSMO", limits: [10, 6, 4] },
  { name: "Alexa", limits: [7, 5, 3] },
].map(({ name, limits }) => ({
  name,
  maxScore: limits.reduce((sum, value) => sum + value, 0),
  score: limits.reduce((sum, value) => sum + value - 1, 0),
  criteria: limits.map((maxScore, index) => ({
    name: `${name}项目${index + 1}`,
    maxScore,
    score: maxScore - 1,
    description: '测试文本包含转义字符："标题"、\\路径、[括号]、{花括号}',
    deductions: [{ points: 1, reason: "现有文本缺少具体场景说明" }],
  })),
}))
const core = { total: 83, dimensions }
const report = {
  ...core,
  suggestions: ["补充已有信息对应的场景", '核对标题中的 "规格"'],
  potential: "A",
}
const text = JSON.stringify(report)

describe("Amazon 评分截断位置遍历", () => {
  it("完整的四维十七项评分可以通过，所有评分字段保持一致", () => {
    expect(dimensions.reduce((sum, dimension) => sum + dimension.score, 0)).toBe(core.total)
    expect(JSON.parse(validateScoreReport(text, "amazon_us"))).toEqual(report)
  })

  it("逐字符截断评分核心，任何位置都不能补造剩余评分", () => {
    const coreEnd = text.indexOf(',"suggestions"')
    for (let cut = 0; cut <= coreEnd; cut++) {
      const truncated = text.slice(0, cut)
      expect(() => validateScoreReport(truncated, "amazon_us")).toThrow()
      // 未遇到完整字段后的分隔符时也保守拒绝，避免根据不完整文法猜测。
      expect(() => extractScoreRecoveryCore(truncated, "amazon_us")).toThrow()
    }
  })

  it("逐字符截断末尾：能提取完整核心时，恢复不得修改任何既有字段", () => {
    const coreEnd = text.indexOf(',"suggestions"')
    let recoveredCount = 0
    for (let cut = coreEnd + 1; cut < text.length; cut++) {
      const truncated = text.slice(0, cut)
      const saved = extractScoreRecoveryCore(truncated, "amazon_us")
      const recovered = JSON.parse(validateRecoveredScore(text, saved, "amazon_us"))
      expect(recovered.total).toBe(core.total)
      expect(recovered.dimensions).toEqual(core.dimensions)
      recoveredCount++
    }
    expect(recoveredCount).toBeGreaterThan(50)
  })

  it.each(["score", "maxScore", "reason"])("修复篡改 %s 时拒绝接受", field => {
    const changed = structuredClone(report)
    if (field === "reason") changed.dimensions[0].criteria[0].deductions[0].reason = "补造理由"
    else changed.dimensions[0].criteria[0][field as "score" | "maxScore"] += 1
    expect(() => validateRecoveredScore(JSON.stringify(changed), core, "amazon_us")).toThrow(
      "改变了原始评分"
    )
  })
})
