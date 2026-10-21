import { auditGrade, auditGradeLabel, auditGradeNarrative } from "./problem-types"

/** v2.0 等级：≥85 优秀 / ≥70 良好 / ≥50 一般 / <50 待优化（四类问题分数推导已随十维契约废弃）。 */
describe("auditGrade（v2.0 分档）", () => {
  it("分档边界：85/70/50", () => {
    expect(auditGrade(100)).toBe("EXCELLENT")
    expect(auditGrade(85)).toBe("EXCELLENT")
    expect(auditGrade(84.9)).toBe("GOOD")
    expect(auditGrade(70)).toBe("GOOD")
    expect(auditGrade(69.9)).toBe("FAIR")
    expect(auditGrade(50)).toBe("FAIR")
    expect(auditGrade(49.9)).toBe("POOR")
    expect(auditGrade(0)).toBe("POOR")
  })

  it("中文标签与分档话术", () => {
    expect(auditGradeLabel("EXCELLENT")).toBe("优秀")
    expect(auditGradeLabel("GOOD")).toBe("良好")
    expect(auditGradeLabel("FAIR")).toBe("一般")
    expect(auditGradeLabel("POOR")).toBe("待优化")
    expect(auditGradeNarrative("EXCELLENT")).toContain("整体健康")
    expect(auditGradeNarrative("POOR")).toContain("系统性重做")
  })
})
