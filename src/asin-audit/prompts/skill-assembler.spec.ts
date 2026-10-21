import { buildAsinAuditScoreSkill } from "./skill-assembler"

describe("buildAsinAuditScoreSkill（类目覆盖层装配）", () => {
  it("无类目：不追加类目覆盖层", () => {
    const skill = buildAsinAuditScoreSkill()
    expect(skill).not.toContain("已加载 references/category-computer.md")
    expect(skill).toContain("已加载 references/score-dimensions.md")
  })

  it("null 同样走通用细则", () => {
    expect(buildAsinAuditScoreSkill(null)).not.toContain("已加载 references/category-computer.md")
  })

  it("computer：追加电脑类目冻结清单，且位于通用细则之后", () => {
    const skill = buildAsinAuditScoreSkill("computer")
    expect(skill).toContain("已加载 references/category-computer.md")
    // 生效声明与关键冻结清单内容在位
    expect(skill).toContain("以本文为准")
    expect(skill).toContain("电脑类目冻结清单")
    expect(skill).toContain("配置—用途—价位")
    // 通用 references 仍在
    expect(skill).toContain("已加载 references/traffic-optimization.md")
    // 覆盖层排在通用细则之后
    expect(skill.indexOf("已加载 references/category-computer.md")).toBeGreaterThan(
      skill.indexOf("已加载 references/score-dimensions.md")
    )
  })
})
