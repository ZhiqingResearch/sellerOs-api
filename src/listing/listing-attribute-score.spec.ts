import { projectListingAttributeCriterion, type ListingAttributePresentation, type ListingAttributeSource } from "./listing-attribute-score"

function createSource(): ListingAttributeSource {
  return {
    title: "Epson EcoTank ET-2850 502 ink refill bottles",
    itemHighlights: [], description: "One pack contains five ink bottles.",
    bullets: ["17000 pages for black ink; 6500 pages for each color bottle."],
    structuredAttributes: [
      { name: "Printer Model Compatibility", value: "HP OfficeJet Pro" },
      { name: "Compatible Printer Models", value: "False" },
      { name: "Color", value: "black color" },
      { name: "Model Name", value: "Replacement for 502 ink refill bottles" },
      { name: "Manufacturer", value: "SUPRINT for 502 ink refill bottles" },
      { name: "Number of Packs", value: "5" },
      { name: "Mfr Part Number", value: "Replacement for 502 ink refill bottles" },
      { name: "Ink Colour", value: "Multicolor" },
      { name: "Page Yield", value: "35000" },
      { name: "Number of Items", value: "5" },
      { name: "Compatible Devices", value: "Printer" },
      ...Array.from({ length: 7 }, (_, index) => ({ name: `辅助字段${index + 1}`, value: "已取证值" })),
      { name: "ASIN", value: "B0G6KWK4LB" }, { name: "BSR", value: "100" }, { name: "Customer Reviews", value: "1000" },
    ],
  }
}

function createChecks() {
  const weights = [3, 3, 3, 3, 2, 2, 1, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]
  const types = ["CONTRADICTION", "TYPE_MISMATCH", "CONTRADICTION", "PRODUCT_DESCRIPTION", "PRODUCT_DESCRIPTION", "GRANULARITY", "PRODUCT_DESCRIPTION", "NONE", "PENDING"]
  return weights.map((weight, offset) => ({
    index: offset + 1, weight, errorType: types[offset] ?? "NONE",
    comparison: offset === 0 ? [{ field: "title", quote: "Epson EcoTank ET-2850" }]
      : offset === 2 ? [{ field: "attributes.8", quote: "Multicolor" }]
        : offset === 5 ? [{ field: "description", quote: "One pack contains five ink bottles." }] : [],
    suggestion: "建议核对并填入当前字段对应的真实值",
  }))
}

describe("可选结构化属性表的程序计分", () => {
  it("按全部属性权重40与失分份额14计算19.5，忽略真实失败输出中的旧分数和合并扣分", () => {
    const criterion = { score: 12.5, description: "错误：权重52、失分34.5、多项营销话术", deductions: [{ points: 36.3141, reason: "3字段合并且Mfr重复扣" }], assessment: { attributeChecks: createChecks() } }
    const original = structuredClone(criterion)
    const result = projectListingAttributeCriterion(criterion, createSource())!
    expect(result.score).toBe(19.5)
    expect(result.status).toBe("MISSING")
    expect(result.deductions).toHaveLength(7)
    expect(result.deductions.map(deduction => deduction.points)).toEqual([2.25, 2.25, 2.25, 1.5, 1.125, 0.75, 0.375])
    expect(result.deductions.reduce((sum, deduction) => sum + deduction.points, 0)).toBe(10.5)
    expect(result.description).toContain("本次取得18项前台可见属性，已核验17项，7项有问题")
    expect(result.description).toContain("1项待确认，本次不扣分")
    expect(result.assessment.attributePresentation).toMatchObject({ attributeCount: 18, totalWeight: 40, totalLoss: 14 })
    expect(result.description).not.toMatch(/必填|营销|52|34.5/)
    expect(result.deductions.filter(deduction => deduction.reason.startsWith("Mfr Part Number"))).toHaveLength(1)
    expect(result.deductions[1].evidence).toContain("Compatible Printer Models: False")
    expect(criterion).toEqual(original)
  })

  it.each([undefined, {}, { attributeChecks: [] }])("无取证表%j兼容返回undefined，不抛错", assessment => {
    expect(projectListingAttributeCriterion({ assessment }, createSource())).toBeUndefined()
  })

  it("重复属性索引、不全表、非法权重不新建结果", () => {
    const checks = createChecks()
    expect(projectListingAttributeCriterion({ assessment: { attributeChecks: [...checks, checks[6]] } }, createSource())).toBeUndefined()
    expect(projectListingAttributeCriterion({ assessment: { attributeChecks: checks.slice(1) } }, createSource())).toBeUndefined()
    checks[0].weight = 4
    expect(projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, createSource())).toBeUndefined()
  })

  it.each([
    { comparison: [{ field: "attributes.11", quote: "Printer" }] },
    { comparison: [{ field: "title", quote: "商品原文不存在的Epson型号" }] },
    { comparison: [] },
  ])("无有效冲突原文%j只转对应行为PENDING，其他属性照常计分", ({ comparison }) => {
    const checks = createChecks()
    checks[0].comparison = comparison
    const result = projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, createSource())!
    expect(result.score).toBe(21.75)
    expect(result.deductions).toHaveLength(6)
    expect(result.description).toContain("2项待确认")
    expect((result.assessment.attributeChecks as typeof checks)[0].errorType).toBe("PENDING")
    expect(result.deductions.some(deduction => deduction.reason.startsWith("Printer Model Compatibility"))).toBe(false)
  })

  it("包数仅以件数5作证时待确认，不凭空推出1包", () => {
    const checks = createChecks()
    checks[5].comparison = [{ field: "attributes.10", quote: "5" }]
    const result = projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, createSource())!
    expect(result.score).toBe(21)
    expect(result.deductions.some(deduction => deduction.reason.startsWith("Number of Packs"))).toBe(false)
    expect(result.description).toContain("2项待确认")
  })

  it("非属性统计行不进入分母，但索引仍用原始位置", () => {
    const source = createSource()
    source.structuredAttributes.unshift({ name: "ASIN", value: "B0EXAMPLE" })
    const checks = createChecks().map(check => ({ ...check, index: check.index + 1, comparison: check.comparison.map(comparison => ({
      ...comparison, field: comparison.field.startsWith("attributes.") ? `attributes.${Number(comparison.field.split(".")[1]) + 1}` : comparison.field,
    })) }))
    expect(projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, source)?.score).toBe(19.5)
  })

  it("4位小数的明细余数分配后全扣不越30分，原分不会泄漏", () => {
    const source: ListingAttributeSource = { title: "", itemHighlights: [], description: "", bullets: [], structuredAttributes: Array.from({ length: 7 }, (_, index) => ({ name: `字段${index}`, value: "False" })) }
    const checks = source.structuredAttributes.map((_, index) => ({ index: index + 1, weight: 1, errorType: "TYPE_MISMATCH", comparison: [], suggestion: "填写对应真实值" }))
    const result = projectListingAttributeCriterion({ score: 100, assessment: { attributeChecks: checks } }, source)!
    expect(result.score).toBe(0)
    expect(Math.round(result.deductions.reduce((sum, deduction) => sum + deduction.points, 0) * 10000) / 10000).toBe(30)
    expect(result.deductions.every(deduction => deduction.points === 4.2857 || deduction.points === 4.2858)).toBe(true)
  })
})


describe("属性取证数值字符串兼容", () => {
  it("明确的index和weight数字字符串规范化为number，计分不变且原表不修改", () => {
    const checks = createChecks().map(check => ({ ...check, index: String(check.index), weight: String(check.weight) }))
    const original = structuredClone(checks)
    const result = projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, createSource())!
    expect(result.score).toBe(19.5)
    expect((result.assessment.attributeChecks as Array<{ index: unknown; weight: unknown }>).every(check =>
      typeof check.index === "number" && typeof check.weight === "number")).toBe(true)
    expect(checks).toEqual(original)
  })

  it.each(["1.0", "4", "", "1e0", "true", true])("非法weight %j仍兼容返回undefined", weight => {
    const checks: Array<Record<string, unknown>> = createChecks()
    checks[0].weight = weight
    expect(projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, createSource())).toBeUndefined()
  })

  it.each(["0", "-1", "1.1", "1e0", "9007199254740992", true])("非法index %j仍兼容返回undefined", index => {
    const checks: Array<Record<string, unknown>> = createChecks()
    checks[0].index = index
    expect(projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, createSource())).toBeUndefined()
  })

  it("字符串与数值重复同一index不能重复扣分", () => {
    const checks: Array<Record<string, unknown>> = createChecks()
    checks[1].index = "1"
    expect(projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, createSource())).toBeUndefined()
  })
})


describe("比较证据的展示和最低语义边界", () => {
  it("扣分原因直接显示比较字段及原值，页面无需展示evidence也能解释两处矛盾", () => {
    const result = projectListingAttributeCriterion({ assessment: { attributeChecks: createChecks() } }, createSource())!
    const color = result.deductions.find(deduction => deduction.reason.startsWith("Color"))!
    expect(color.reason).toContain("black color")
    expect(color.reason).toContain("Ink Colour=“Multicolor”")
    expect(result.deductions[0].reason).toContain("标题=“Epson EcoTank ET-2850”")
  })

  it.each(["Printer", "Inkjet Printer", "Laser Printer"])("自身泛化值%s与具体型号也不能判矛盾", value => {
    const source = createSource()
    source.structuredAttributes[10].value = value
    const checks = createChecks()
    checks[10].errorType = "CONTRADICTION"
    checks[10].comparison = [{ field: "title", quote: "Epson EcoTank ET-2850" }]
    const result = projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, source)!
    expect(result.score).toBe(19.5)
    expect((result.assessment.attributeChecks as typeof checks)[10].errorType).toBe("PENDING")
    expect(result.deductions.some(deduction => deduction.reason.startsWith("Compatible Devices"))).toBe(false)
  })

  it.each([
    { field: "title", quote: "502 ink refill bottles" },
    { field: "attributes.4", quote: "Replacement for 502 ink refill bottles" },
  ])("颜色拿无关产品事实%j比较时只待确认，不自动寻找新证据", comparison => {
    const checks = createChecks()
    checks[2].comparison = [comparison]
    const result = projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, createSource())!
    expect(result.score).toBe(21.75)
    expect(result.deductions.some(deduction => deduction.reason.startsWith("Color"))).toBe(false)
    expect((result.assessment.attributeChecks as typeof checks)[2].errorType).toBe("PENDING")
  })

  it("标题中引用实际颜色事实仍允许按模型确认的同口径矛盾计分", () => {
    const source = createSource()
    source.title += " Multicolor"
    const checks = createChecks()
    checks[2].comparison = [{ field: "title", quote: "Multicolor" }]
    const result = projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, source)!
    expect(result.score).toBe(19.5)
    expect(result.deductions.find(deduction => deduction.reason.startsWith("Color"))?.reason).toContain("标题=“Multicolor”")
  })
})


describe("属性卖家说明只调整文案与展示数据", () => {
  it("严重/中等/待确认关联原扣分索引，字段双方原值及建议完整保留", () => {
    const checks = createChecks()
    checks[0].suggestion = "建议按本品实际兼容型号改填 Epson EcoTank ET-2850"
    const result = projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, createSource())!
    const presentation = result.assessment.attributePresentation as ListingAttributePresentation
    expect(presentation.summary).toBe(result.description)
    expect(presentation.rows).toHaveLength(8)
    expect(presentation.rows.map(row => row.severity)).toEqual(["severe", "severe", "severe", "severe", "moderate", "moderate", "moderate", "pending"])
    expect(presentation.rows.slice(0, 7).map(row => row.deductionIndex)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(presentation.rows[0]).toMatchObject({
      field: "Printer Model Compatibility", currentValue: "HP OfficeJet Pro", comparison: "标题=“Epson EcoTank ET-2850”",
      suggestion: checks[0].suggestion, weight: 3, deductionRate: 1, errorType: "CONTRADICTION",
    })
    expect(presentation.rows[2]).toMatchObject({ field: "Color", currentValue: "black color", comparison: "Ink Colour=“Multicolor”" })
    expect(presentation.rows[7]).toMatchObject({ field: "Page Yield", currentValue: "35000", severity: "pending", deductionRate: 0 })
    expect(presentation.rows[7]).not.toHaveProperty("deductionIndex")
    expect(result.description + result.deductions.map(deduction => deduction.reason).join(" ")).not.toMatch(/权重|失分份额|扣除比例|模型判定|关键属性|重要属性|一般属性/)
    expect(result.deductions[0].reason).toContain("现在填“HP OfficeJet Pro”")
    expect(result.deductions[0].reason).toContain("→ 建议按本品实际兼容型号改填 Epson EcoTank ET-2850")
  })

  it("重复投影和伪造展示数据均不改变已验证的得分、扣分精度与顺序", () => {
    const criterion = { assessment: { attributeChecks: createChecks(), attributePresentation: { totalWeight: 1, totalLoss: 999, rows: [{ deductionIndex: -1 }] } } }
    const result = projectListingAttributeCriterion(criterion, createSource())!
    const repeated = projectListingAttributeCriterion(result, createSource())!
    const selectScoring = (value: typeof result) => ({ score: value.score, status: value.status, deductions: value.deductions.map(({ ruleId, points, evidence }) => ({ ruleId, points, evidence })) })
    expect(selectScoring(repeated)).toEqual(selectScoring(result))
    expect(result.score).toBe(19.5)
    expect(result.deductions.map(({ points }) => points)).toEqual([2.25, 2.25, 2.25, 1.5, 1.125, 0.75, 0.375])
    expect(result.assessment.attributePresentation).toEqual(repeated.assessment.attributePresentation)
    expect((result.assessment.attributePresentation as ListingAttributePresentation).totalWeight).toBe(40)
  })

  it("全满分不会生成问题组或扣分行，原有30分不变", () => {
    const checks = createChecks().map(check => ({ ...check, errorType: "NONE", comparison: [], suggestion: "" }))
    const result = projectListingAttributeCriterion({ assessment: { attributeChecks: checks } }, createSource())!
    expect(result).toMatchObject({ score: 30, status: "VERIFIED", deductions: [] })
    expect(result.assessment.attributePresentation).toMatchObject({ attributeCount: 18, totalWeight: 40, totalLoss: 0, rows: [] })
    expect(result.description).toContain("未发现可确认的问题")
  })
})
