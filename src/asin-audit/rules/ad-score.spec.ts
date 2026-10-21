import { extractAdScore } from "./ad-score"

describe("extractAdScore 广告分提取", () => {
  it("顶层 score 数字直接采用并钳制到 [0,100]", () => {
    expect(extractAdScore({ score: 62 })).toBe(62)
    expect(extractAdScore({ score: 120 })).toBe(100)
    expect(extractAdScore({ score: -5 })).toBe(0)
    expect(extractAdScore({ score: 61.567 })).toBe(61.57)
  })

  it("顶层无 score 时按 total → overallScore 顺序兜底（与前端归档预检同序），score 优先级最高", () => {
    expect(extractAdScore({ total: 58 })).toBe(58)
    expect(extractAdScore({ total: "x", overallScore: 71 })).toBe(71)
    expect(extractAdScore({ overallScore: 66 })).toBe(66)
    expect(extractAdScore({ score: 40, total: 90, overallScore: 80 })).toBe(40)
    expect(extractAdScore({ total: 130 })).toBe(100)
  })

  it("无顶层 score 时按 dimensions 加权（Σscore×weight / Σweight）", () => {
    const ad = {
      dimensions: [
        { id: "AD1", weight: 24, score: 55 },
        { id: "AD2", weight: 22, score: 48 },
        { id: "AD3", weight: 20, score: 78 },
        { id: "AD4", weight: 18, score: 70 },
        { id: "AD5", weight: 16, score: 65 },
      ],
    }
    // (55×24 + 48×22 + 78×20 + 70×18 + 65×16) / 100 = 62.36
    expect(extractAdScore(ad)).toBe(62.36)
  })

  it("dimensions 无 weight 时取平均；权重 0/负数按无权重处理；脏条目跳过", () => {
    expect(extractAdScore({ dimensions: [{ score: 40 }, { score: 60 }] })).toBe(50)
    expect(extractAdScore({ dimensions: [{ weight: 0, score: 40 }, { score: 60 }] })).toBe(50)
    expect(
      extractAdScore({ dimensions: ["脏数据", null, { weight: 10, score: 80 }, { score: "x" }] })
    ).toBe(80)
  })

  it("未上传/结构提不出分 → null", () => {
    expect(extractAdScore(null)).toBeNull()
    expect(extractAdScore(undefined)).toBeNull()
    expect(extractAdScore("文本")).toBeNull()
    expect(extractAdScore([{ score: 60 }])).toBeNull()
    expect(extractAdScore({ score: "62" })).toBeNull()
    expect(extractAdScore({ score: NaN })).toBeNull()
    expect(extractAdScore({ findings: ["无分数"] })).toBeNull()
    expect(extractAdScore({ dimensions: [{ weight: 10 }] })).toBeNull()
  })
})
