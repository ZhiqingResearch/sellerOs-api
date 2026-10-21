import { SKILL_MARKET_SKILLS, skillMarketFileUrl } from "../../prisma/seed/skill-market"

/** 联调文档第五节的 23 个固定 skillId，前后端合并静态元数据以此为准 */
const DOC_SKILL_IDS = [
  "trending",
  "sales-est",
  "seller-scan",
  "aba-insight",
  "global-expand",
  "listing-opt",
  "aplus",
  "main-images",
  "photo-plan",
  "backend-kw",
  "a9-seo",
  "ppc-build",
  "sd-ads",
  "ad-portfolio",
  "neg-kw",
  "kw-monitor",
  "buybox",
  "profit-waterfall",
  "price-watch",
  "deal-roi",
  "ship-calc",
  "fba-prep",
  "rank-track",
]

describe("Skill 市场种子目录", () => {
  it("共 23 个技能，skillId 与联调文档完全一致（无缺失、无多余）", () => {
    expect(SKILL_MARKET_SKILLS).toHaveLength(23)
    const ids = SKILL_MARKET_SKILLS.map(s => s.skillId)
    expect([...ids].sort()).toEqual([...DOC_SKILL_IDS].sort())
  })

  it("skillId / name / category / fileName 全部非空且无重复", () => {
    const byField = {
      skillId: SKILL_MARKET_SKILLS.map(s => s.skillId),
      fileName: SKILL_MARKET_SKILLS.map(s => s.fileName),
    }
    for (const skill of SKILL_MARKET_SKILLS) {
      expect(skill.skillId).toMatch(/^[a-z0-9-]+$/)
      expect(skill.name).toBeTruthy()
      expect(skill.category).toBeTruthy()
      expect(skill.fileName.startsWith(`${skill.skillId}-`)).toBe(true)
      expect(skill.fileName.endsWith(".md")).toBe(true)
    }
    expect(new Set(byField.skillId).size).toBe(23)
    expect(new Set(byField.fileName).size).toBe(23)
  })

  it("公开直链规则固定：<base>/skill-market/skills/<skillId>.md", () => {
    expect(skillMarketFileUrl("listing-opt")).toBe(
      "https://erp-pro.nyc3.digitaloceanspaces.com/skill-market/skills/listing-opt.md"
    )
  })

  it("分类为联调文档定义的 5 个运营场景", () => {
    const categories = new Set(SKILL_MARKET_SKILLS.map(s => s.category))
    expect(categories).toEqual(
      new Set(["选品与市场", "Listing 与内容", "广告与流量", "定价与利润", "运营与节奏"])
    )
  })
})
