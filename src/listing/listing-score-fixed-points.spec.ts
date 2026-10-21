import {
  getListingCriterionCheckIds,
  getListingCriterionRuleError,
  getListingCriterionRules,
  validateListingReportRules,
} from "./listing-score-rules"

function makeCountDeduction(points: number) {
  return { ruleId: "image.count", points, reason: "副图5张，数量项按3×5/6计算", evidence: "后端图片清单：副图1至副图5" }
}

function makeCoverageDeduction(checkId: string, points = 0.75) {
  return { ruleId: "image.coverage", checkId, points, reason: `缺少${checkId}类型`, evidence: "副图清单对应内容未覆盖" }
}

function makeDescriptionDeduction(checkId: string, points = 1) {
  return { ruleId: "alexa.description", checkId, points, reason: `缺少${checkId}检查点`, evidence: "产品描述原文缺少对应部分" }
}

describe("仅按文档的数量和固定检查点计算扣分", () => {
  it("后端确认5张副图时数量得2.5、只扣0.5", () => {
    expect(getListingCriterionRuleError(0, 3, { score: 14.5, deductions: [makeCountDeduction(0.5)] },
      { confirmedSecondaryCount: 5 })).toBeNull()
  })

  it.each([0.75, 2.5])("5张副图不能扣%s分", points => {
    expect(getListingCriterionRuleError(0, 3, { score: 15 - points, deductions: [makeCountDeduction(points)] },
      { confirmedSecondaryCount: 5 })).toContain("累计应扣0.5分")
  })

  it("数量依据存在时不能漏记0.5分扣分", () => {
    expect(getListingCriterionRuleError(0, 3, { score: 15, deductions: [] },
      { confirmedSecondaryCount: 5 })).toContain("累计应扣0.5分")
  })

  it.each([6, 7])("确认%s张副图不扣数量分", count => {
    expect(getListingCriterionRuleError(0, 3, { score: 15, deductions: [] },
      { confirmedSecondaryCount: count })).toBeNull()
    expect(getListingCriterionRuleError(0, 3, { score: 14.5, deductions: [makeCountDeduction(0.5)] },
      { confirmedSecondaryCount: count })).toContain("累计应扣0分")
  })

  it("确认0张副图与未获取数量严格区分", () => {
    expect(getListingCriterionRuleError(0, 3, { score: 12, deductions: [makeCountDeduction(3)] },
      { confirmedSecondaryCount: 0 })).toBeNull()
    expect(getListingCriterionRuleError(0, 3, { score: 15, deductions: [] })).toBeNull()
    expect(getListingCriterionRuleError(0, 3, { score: null, deductions: [] },
      { confirmedSecondaryCount: 5 })).toBeNull()
  })

  it("同一证据只能在各自不同的覆盖类型各扣0.75", () => {
    const deductions = ["scene", "detail", "dimensions", "package"].map(checkId => makeCoverageDeduction(checkId))
    expect(getListingCriterionRuleError(0, 3, { score: 12, deductions })).toBeNull()
    expect(getListingCriterionRuleError(0, 3, { score: 14.25, deductions: [makeCoverageDeduction("dimensions")] })).toBeNull()
  })

  it("仅缺尺寸不能扣满覆盖度3分", () => {
    expect(getListingCriterionRuleError(0, 3, { score: 12, deductions: [makeCoverageDeduction("dimensions", 3)] }))
      .toContain("固定扣0.75分")
  })

  it("同类覆盖换说法也不能重复扣分", () => {
    const first = makeCoverageDeduction("dimensions")
    expect(getListingCriterionRuleError(0, 3, { score: 13.5, deductions: [first,
      { ...first, reason: "缺少尺寸对比图", evidence: "另一组图片同样未见尺寸" },
    ] })).toContain("只能扣分一次")
  })

  it.each([undefined, "style", "scene,dimensions"])("覆盖类型%s不能替代已有四类检查点", checkId => {
    expect(getListingCriterionRuleError(0, 3, { score: 14.25,
      deductions: [{ ...makeCoverageDeduction("scene"), checkId }],
    })).toContain("checkId")
  })

  it("描述只缺规格扣1，两类都缺扣2，满分仍为3", () => {
    expect(getListingCriterionRuleError(3, 2, { score: 2, deductions: [makeDescriptionDeduction("specifications")] })).toBeNull()
    expect(getListingCriterionRuleError(3, 2, { score: 1, deductions: [
      makeDescriptionDeduction("specifications"), makeDescriptionDeduction("overview_scenes"),
    ] })).toBeNull()
    expect(getListingCriterionRules(3, 2)).toEqual({ "alexa.description": 2 })
  })

  it("缺一个规格检查点不能扣2分，也不能按不同措辞重复扣", () => {
    expect(getListingCriterionRuleError(3, 2, { score: 1,
      deductions: [makeDescriptionDeduction("specifications", 2)],
    })).toContain("固定扣1分")
    const first = makeDescriptionDeduction("specifications")
    expect(getListingCriterionRuleError(3, 2, { score: 1, deductions: [first,
      { ...first, reason: "规格段缺失", evidence: "描述没有结构化规格" },
    ] })).toContain("只能扣分一次")
  })

  it("不为段头或文案新建第三个描述扣分检查点", () => {
    expect(getListingCriterionRuleError(3, 2, { score: 2,
      deductions: [makeDescriptionDeduction("heading_format")],
    })).toContain("checkId")
  })

  it.each([0, -1, NaN, Infinity, "0.5"])("保留非法分值%s拦截", points => {
    expect(getListingCriterionRuleError(0, 3, { score: 15,
      deductions: [{ ...makeCountDeduction(0.5), points }],
    })).toContain("正数points")
  })

  it("保留空扣分原因拦截", () => {
    expect(getListingCriterionRuleError(0, 3, { score: 14.5,
      deductions: [{ ...makeCountDeduction(0.5), reason: " " }],
    })).toContain("具体reason")
  })

  it("向请求构造器只导出当前项的既有检查点，返回副本", () => {
    const ids = getListingCriterionCheckIds(0, 3)
    expect(ids).toEqual({ "image.coverage": ["scene", "detail", "dimensions", "package"] })
    expect(getListingCriterionCheckIds(3, 2)).toEqual({ "alexa.description": ["specifications", "overview_scenes"] })
    expect(getListingCriterionCheckIds(0, 0)).toEqual({})
    ids["image.coverage"].push("outside")
    expect(getListingCriterionCheckIds(0, 3)["image.coverage"]).not.toContain("outside")
  })

  it("报告最终校验同样使用后端数量上下文", () => {
    const report = {
      scoreVersion: "cdq-2026-09-16",
      dimensions: [[30, 25, 20, 15, 5, 5], [7, 7, 5, 4, 2], [10, 6, 4], [7, 5, 3]].map((limits, index) => ({
        score: [40, 25, 20, 15][index], criteria: limits.map(score => ({ score, deductions: [] as unknown[] })),
      })),
    }
    expect(() => validateListingReportRules(report, { confirmedSecondaryCount: 5 })).toThrow("累计应扣0.5分")
    Object.assign(report.dimensions[0].criteria[3], { score: 14.5, deductions: [makeCountDeduction(0.5)] })
    expect(() => validateListingReportRules(report, { confirmedSecondaryCount: 5 })).not.toThrow()
  })
})
