import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildListingAlexaPrompt, recalculateListingAlexaScore } from "./listing-alexa-score"
import type { ListingScoreSource } from "./listing-score-evidence"

interface Criterion {
  score: number
  maxScore: number
  deductions: Array<Record<string, unknown>>
  assessment?: unknown
  description?: string
}
interface Dimension {
  score: number
  maxScore: number
  criteria: Criterion[]
  deductions?: Array<Record<string, unknown>>
}
interface Report {
  scoreVersion?: string
  dimensions: Dimension[]
  total: number
}
interface Incident {
  sourceFacts: ListingScoreSource
  primary: Report
}

const createIncident = (): Incident => JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-alexa-zero-20260917.json"), "utf8"))
const createTitleAssessment = () => ({ checks: [
  { checkId: "product", isSatisfied: true, quote: "Ink Refill Bottles" },
  { checkId: "problem", isSatisfied: true, quote: "Replacement" },
  { checkId: "audience", isSatisfied: false, quote: "" },
  { checkId: "stuffing", isSatisfied: true, quote: "" },
] })
const createBulletAssessment = () => ({ bullets: [
  { index: 1, kind: "specification", quote: "ET-2850" },
  { index: 2, kind: "numeric", quote: "17000 pages" },
  { index: 3, kind: "numeric", quote: "140mL" },
  { index: 4, kind: "", quote: "" },
  { index: 5, kind: "", quote: "" },
  { index: 6, kind: "", quote: "" },
  { index: 7, kind: "numeric", quote: "24/7" },
] })
const createDescriptionAssessment = () => ({ checks: [
  { checkId: "specifications", isPresent: true, quotes: ["CAPACITY: 140mL"] },
  { checkId: "overview_scenes", isPresent: true, quotes: ["homework at home", "proposals in the office"] },
] })

describe("Alexa 按既有规则计算且不拦截报告", () => {
  it("用途与人群允许只出现在亮点，标题仍承担产品识别", () => {
    const { primary, sourceFacts } = createIncident()
    sourceFacts.title = "Lenovo Laptop"
    sourceFacts.itemHighlights = "For spreadsheets, For students"
    primary.dimensions[3].criteria[0].assessment = { checks: [
      { checkId: "product", isSatisfied: true, field: "title", quote: "Laptop" },
      { checkId: "problem", isSatisfied: true, field: "itemHighlights", quote: "For spreadsheets" },
      { checkId: "audience", isSatisfied: true, field: "itemHighlights", quote: "For students" },
      { checkId: "stuffing", isSatisfied: true, field: "", quote: "" },
    ] }
    const title = recalculateListingAlexaScore(primary, sourceFacts).dimensions[3].criteria[0]
    expect(title.score).toBe(7)
    expect(title.deductions).toEqual([])
  })

  it.each(["longTitle", "description", "title"])("亮点原文不能伪装成%s字段证据", field => {
    const { primary, sourceFacts } = createIncident()
    sourceFacts.itemHighlights = "For students"
    const criterion = primary.dimensions[3].criteria[0]
    criterion.assessment = { checks: [
      ...createTitleAssessment().checks.filter(check => check.checkId !== "audience"),
      { checkId: "audience", isSatisfied: true, field, quote: "For students" },
    ] }
    expect(recalculateListingAlexaScore(primary, sourceFacts).dimensions[3].criteria[0]).toEqual(criterion)
  })
  it("事故32三个零分恢复已有规则的5、20/7和1分，其他维度和输入保持不变", () => {
    const { primary, sourceFacts } = createIncident()
    const original = structuredClone({ primary, sourceFacts })
    expect(primary.dimensions[3].criteria.map(item => item.score)).toEqual([0, 0, 0])

    const result = recalculateListingAlexaScore(primary, sourceFacts)
    const alexa = result.dimensions[3]
    expect(alexa.criteria.map(item => item.score)).toEqual([5, 2.8571, 1])
    expect(alexa.score).toBe(8.8571)
    expect(alexa.criteria[0].deductions).toEqual([expect.objectContaining({ checkId: "stuffing", points: 2 })])
    expect(alexa.criteria[1].deductions).toEqual([expect.objectContaining({ ruleId: "alexa.bulletData", points: 2.1429 })])
    expect(alexa.criteria[1].description).toContain("第1、2、3、7条")
    expect(alexa.criteria[2].deductions.map(item => item.points)).toEqual([1, 1])
    expect(result.dimensions.slice(0, 3)).toEqual(primary.dimensions.slice(0, 3))
    expect(result.total).toBe(77.3095)
    expect({ primary, sourceFacts }).toEqual(original)
    expect(recalculateListingAlexaScore(result, sourceFacts)).toEqual(result)
  })

  it.each([["standard", 2.8571], ["custom", 3.3333]] as const)("完整assessment在%s模式按原分母计分", (mode, expected) => {
    const { primary, sourceFacts } = createIncident()
    sourceFacts.mode = mode
    sourceFacts.description = "PRODUCT OVERVIEW: Print homework at home and proposals in the office. CAPACITY: 140mL."
    const criteria = primary.dimensions[3].criteria
    criteria[0].assessment = createTitleAssessment()
    criteria[1].assessment = createBulletAssessment()
    criteria[2].assessment = createDescriptionAssessment()
    const result = recalculateListingAlexaScore(primary, sourceFacts).dimensions[3]
    expect(result.criteria.map(item => item.score)).toEqual([5, expected, 3])
    expect(result.criteria[1].description).toContain("合格4条（1、2、3、7）")
    expect(result.criteria[2].deductions).toEqual([])
  })

  it.each([undefined, null, {}, { bullets: [] }, { bullets: [{ index: 1, kind: "numeric", quote: "6500 pages" }] }])("Bullet assessment缺失或不完整仍交付原文明示下界 %#", assessment => {
    const { primary, sourceFacts } = createIncident()
    primary.dimensions[3].criteria[1].assessment = assessment
    expect(() => recalculateListingAlexaScore(primary, sourceFacts)).not.toThrow()
    expect(recalculateListingAlexaScore(primary, sourceFacts).dimensions[3].criteria[1].score).toBe(2.8571)
  })

  it("缺少逐条判断时，下界不降低模型已给的高分或编造其余条目不合格", () => {
    const { primary, sourceFacts } = createIncident()
    const criterion = primary.dimensions[3].criteria[1]
    Object.assign(criterion, { score: 4, deductions: [{ points: 1, reason: "已有模型逐条结论" }] })
    const result = recalculateListingAlexaScore(primary, sourceFacts)
    expect(result.dimensions[3].criteria[1]).toEqual(criterion)
  })

  it.each([
    "New V2 release with premium quality.",
    "Limited offer: save 1/2 of the price.",
    "100% satisfaction, our promise to you.",
    "1. Premium quality; 2) Customer care.",
    "Updated on 2026/09/17.",
  ])("无assessment时不把版本、优惠、承诺、条号或日期当数据点：%s", bullet => {
    const { primary, sourceFacts } = createIncident()
    sourceFacts.bullets = [bullet]
    const criterion = primary.dimensions[3].criteria[1]
    expect(recalculateListingAlexaScore(primary, sourceFacts).dimensions[3].criteria[1]).toEqual(criterion)
  })

  it.each([
    "New V2 release with premium quality.",
    "Limited offer: save 1/2 of the price.",
    "100% satisfaction, our promise to you.",
    "1. Premium quality; 2) Customer care.",
    "Updated on 2026/09/17.",
  ])("完整assessment明确无数据点时也不从%s虚假加分", bullet => {
    const { primary, sourceFacts } = createIncident()
    sourceFacts.bullets = [bullet]
    primary.dimensions[3].criteria[1].assessment = { bullets: [{ index: 1, kind: "", quote: "" }] }
    expect(recalculateListingAlexaScore(primary, sourceFacts).dimensions[3].criteria[1].score).toBe(0)
  })

  it("实际没有Bullet时不虚假加分，仍允许完整报告返回", () => {
    const { primary, sourceFacts } = createIncident()
    sourceFacts.bullets = []
    expect(recalculateListingAlexaScore(primary, sourceFacts).dimensions[3].criteria[1].score).toBe(0)
    primary.dimensions[3].criteria[1].assessment = { bullets: [] }
    expect(recalculateListingAlexaScore(primary, sourceFacts).dimensions[3].criteria[1].score).toBe(0)
  })

  it("旧版或没有独立原文时不猜测分数", () => {
    const { primary, sourceFacts } = createIncident()
    expect(recalculateListingAlexaScore(primary)).toBe(primary)
    delete primary.scoreVersion
    expect(recalculateListingAlexaScore(primary, sourceFacts)).toBe(primary)
    primary.scoreVersion = "cdq-2026-09-15"
    expect(recalculateListingAlexaScore(primary, sourceFacts)).toBe(primary)
  })

  it.each([3, 4, 5])("保留合法alexa.stuffing维度额外%s分，不混入小项", points => {
    const { primary, sourceFacts } = createIncident()
    const deductions = [{ ruleId: "alexa.stuffing", points, reason: "多处重复堆砌", evidence: "listing" }]
    primary.dimensions[3].deductions = deductions
    const result = recalculateListingAlexaScore(primary, sourceFacts).dimensions[3]
    expect(result.criteria.map(item => item.score)).toEqual([5, 2.8571, 1])
    expect(result.score).toBe(Math.round((8.8571 - points) * 10000) / 10000)
    expect(result.deductions).toEqual(deductions)
  })

  it("合法维度额外扣分可以让低分归零，不设虚假的最低分", () => {
    const { primary, sourceFacts } = createIncident()
    sourceFacts.bullets = []
    const dimension = primary.dimensions[3]
    dimension.criteria[0].assessment = { checks: [
      { checkId: "product", isSatisfied: false, quote: "" },
      { checkId: "problem", isSatisfied: false, quote: "" },
      { checkId: "audience", isSatisfied: false, quote: "" },
      { checkId: "stuffing", isSatisfied: true, quote: "" },
    ] }
    dimension.deductions = [{ ruleId: "alexa.stuffing", points: 3, reason: "明确堆砌证据" }]
    const result = recalculateListingAlexaScore(primary, sourceFacts).dimensions[3]
    expect(result.criteria.map(item => item.score)).toEqual([1, 0, 1])
    expect(result.score).toBe(0)
  })

  it.each([1, 2, 6, -1, Number.NaN])("非法维度额外扣分%s不用于重新计算，原报告仍可返回", points => {
    const { primary, sourceFacts } = createIncident()
    primary.dimensions[3].deductions = [{ ruleId: "alexa.stuffing", points }]
    expect(recalculateListingAlexaScore(primary, sourceFacts)).toBe(primary)
  })

  it("标题四类问题按2、2、2、1截断，满分7不能产生8分扣分", () => {
    const { primary, sourceFacts } = createIncident()
    primary.dimensions[3].criteria[0].assessment = { checks: [
      { checkId: "product", isSatisfied: false, quote: "" },
      { checkId: "problem", isSatisfied: false, quote: "" },
      { checkId: "audience", isSatisfied: false, quote: "" },
      { checkId: "stuffing", isSatisfied: false, quote: "Ink Refill Bottles" },
    ] }
    const result = recalculateListingAlexaScore(primary, sourceFacts).dimensions[3].criteria[0]
    expect(result.score).toBe(0)
    expect(result.deductions.map(item => item.points)).toEqual([2, 2, 2, 1])
  })

  it("完整assessment引用跨字段错误时保留无法计算的小项，不抛出取证拦截", () => {
    const { primary, sourceFacts } = createIncident()
    sourceFacts.description = "Independent product description."
    const criteria = primary.dimensions[3].criteria
    const titleAssessment = createTitleAssessment()
    titleAssessment.checks[0].quote = "17000 pages"
    criteria[0].assessment = titleAssessment
    const bulletAssessment = createBulletAssessment()
    bulletAssessment.bullets[4] = { index: 5, kind: "numeric", quote: "17000 pages" }
    criteria[1].assessment = bulletAssessment
    criteria[2].assessment = createDescriptionAssessment()
    expect(() => recalculateListingAlexaScore(primary, sourceFacts)).not.toThrow()
    const result = recalculateListingAlexaScore(primary, sourceFacts).dimensions[3].criteria
    expect(result[0]).toEqual(criteria[0])
    expect(result[1].score).toBe(2.8571)
    expect(result[2]).toEqual(criteria[2])
  })

  it("生成提示只提供本次原文明示下界，营销条目不预判合格", () => {
    const { sourceFacts } = createIncident()
    const prompt = buildListingAlexaPrompt(sourceFacts)
    const context = JSON.parse(prompt.split("\n").find(line => line.startsWith('{"explicitBullets"'))!)
    expect(context.explicitBullets.map((item: { index: number }) => item.index)).toEqual([1, 2, 3, 7])
    expect(context.isDescriptionEmpty).toBe(true)
    expect(prompt).toContain("未列出的条目仍需你判断")
    expect(buildListingAlexaPrompt()).toBe("")
  })
})
