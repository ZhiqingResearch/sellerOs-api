import { Logger } from "@nestjs/common"
import { BusinessAiRun, Prisma } from "@prisma/client"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { ListingAiService } from "./listing-ai.service"
import { buildScoreCorrectionPlan, mergeScoreCorrection } from "./listing-score-correction"
import { type ListingScoreSource } from "./listing-score-evidence"
import { projectListingReportEvidence } from "./listing-score-evidence-flow"
import * as images from "./listing-score-images"
import { ListingScoreService } from "./listing-score.service"

const sourceFacts: ListingScoreSource = {
  title: "Ink refill bottles for EcoTank printers",
  itemHighlights: "Printing supplies for homes and offices",
  bullets: [
    "Refill your printer with 502 ink refill bottles.",
    "Black ink prints up to 17000 pages.",
    "Each black bottle contains 140 mL of ink.",
    "Sturdy seals undergo dozens of strict shipping tests.",
    "Enjoy beautiful colors for family photos and school projects.",
    "Rigorous testing ensures excellent quality and satisfaction.",
    "Technical support is available 24/7.",
  ],
  description: "",
  searchTerms: "",
}

function buildAssessments(): Record<string, Record<string, unknown>> {
  return {
    "1:2": { basis: "inferred", terms: [
      { term: "ink refill bottles", field: "bullets.1", quote: "ink refill bottles" },
      { term: "archival printer ink", field: "", quote: "" },
      { term: "pigment printer ink", field: "", quote: "" },
    ] },
    "2:2": { relations: [
      { type: "IS_A", field: "title", quote: "Ink refill bottles" },
      { type: "USED_TO", field: "bullets.1", quote: "Refill your printer" },
      { type: "USED_BY", field: "", quote: "" },
      { type: "USED_FOR_EVE", field: "", quote: "" },
    ] },
    "3:1": { bullets: [
      { index: 1, kind: "numeric", quote: "502" },
      { index: 2, kind: "numeric", quote: "17000 pages" },
      { index: 3, kind: "numeric", quote: "140 mL" },
      { index: 4, kind: "", quote: "" },
      { index: 5, kind: "", quote: "" },
      { index: 6, kind: "", quote: "" },
      { index: 7, kind: "numeric", quote: "24/7" },
    ] },
    "3:2": { checks: [
      { checkId: "specifications", isPresent: false, quotes: [] },
      { checkId: "overview_scenes", isPresent: false, quotes: [] },
    ] },
  }
}

interface TestCriterion {
  name: string
  description: string
  maxScore: number
  score: number
  status: string
  deductions: unknown[]
  assessment?: Record<string, unknown>
}

const EMPTY_DESCRIPTION: Partial<TestCriterion> = {
  score: 1, description: "结构化规格段缺失；PRODUCT OVERVIEW具体场景缺失。",
  assessment: { checks: [
    { checkId: "specifications", isPresent: false, quotes: [] },
    { checkId: "overview_scenes", isPresent: false, quotes: [] },
  ] },
  deductions: [
    { ruleId: "alexa.description", checkId: "specifications", points: 1, reason: "缺少结构化规格段", evidence: "description为空，未提供独立产品描述。" },
    { ruleId: "alexa.description", checkId: "overview_scenes", points: 1, reason: "缺少PRODUCT OVERVIEW具体场景", evidence: "description为空，未提供独立产品描述。" },
  ],
}
const FOUR_QUALIFIED_BULLETS: Partial<TestCriterion> = {
  // 原有完整assessment确认1、2、3、7：5 × 4/7 = 2.8571。
  score: 2.8571, description: "逐条核验7条Bullet，合格4条（1、2、3、7）；未含可验证数据点：4、5、6。",
  deductions: [{ ruleId: "alexa.bulletData", points: 2.1429, reason: "Bullet 4、5、6缺少具名规格、认证或数字指标",
    evidence: "逐条核验7条Bullet，合格4条（1、2、3、7）；未含可验证数据点：4、5、6。" }],
}
const THREE_EXPLICIT_BULLETS: Partial<TestCriterion> = {
  // 缺assessment时只确认第2、3、7条；孤立502不自动视为具名型号。
  score: 2.1429, description: "至少已识别3/7条Bullet含明确数据点（第2、3、7条）；其余条目尚未取得完整逐条依据。",
  deductions: [{ ruleId: "alexa.bulletData", points: 2.8571, reason: "按已确认的数据点计分，其余条目尚未取得完整逐条依据",
    evidence: "bullets.2: 17000 pages；bullets.3: 140 mL；bullets.7: 24/7" }],
}

interface DeliveryExpectation {
  score: number
  total: number
  bullet?: Partial<TestCriterion>
  description: Partial<TestCriterion>
}

function buildReport(shouldIncludeAssessments = false) {
  const assessments = buildAssessments()
  const report = {
    scoreVersion: "cdq-2026-09-16", mode: "standard", total: 100, potential: "S级", suggestions: [],
    dimensions: [[30, 25, 20, 15, 5, 5], [7, 7, 5, 4, 2], [10, 6, 4], [7, 5, 3]].map((limits, dimensionIndex) => ({
      name: ["CDQ完整性", "关键词覆盖", "COSMO", "Alexa"][dimensionIndex],
      maxScore: [40, 25, 20, 15][dimensionIndex],
      weight: [40, 25, 20, 15][dimensionIndex],
      score: [40, 25, 20, 15][dimensionIndex],
      criteria: limits.map((maxScore, criterionIndex): TestCriterion => ({
        name: `评分项${dimensionIndex}-${criterionIndex}`,
        description: "原始合规项，局部校对不得改动",
        maxScore, score: maxScore, status: "VERIFIED", deductions: [],
        ...(shouldIncludeAssessments && assessments[`${dimensionIndex}:${criterionIndex}`]
          ? { assessment: assessments[`${dimensionIndex}:${criterionIndex}`] } : {}),
      })),
    })),
  }
  Object.assign(report.dimensions[1].criteria[3], {
    name: "后台搜索词写满且与标题不重复", status: "UNAVAILABLE", description: "SEARCH TERMS未获取",
  })
  return report
}

function createFixture(outputs: string[], source: ListingScoreSource = sourceFacts) {
  let row: BusinessAiRun | null = null
  const matches = (where: Record<string, unknown>) => {
    if (!row) return false
    if (typeof where.status === "string" && row.status !== where.status) return false
    if (where.status && typeof where.status === "object" && !(where.status as { in: string[] }).in.includes(row.status)) return false
    const key = where.userId_module_operation_runId as { userId: number; runId: string } | undefined
    return !key || (key.userId === row.userId && key.runId === row.runId)
  }
  const table = {
    findUnique: jest.fn(async ({ where }) => matches(where) ? structuredClone(row) : null),
    findUniqueOrThrow: jest.fn(async () => structuredClone(row!)),
    create: jest.fn(async ({ data }) => {
      if (row) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6" })
      row = { ...data, id: 1, status: "RUNNING", outputText: null, billing: null, requestId: null,
        usageLogId: null, error: null, createdAt: new Date(), updatedAt: new Date() }
      return structuredClone(row!)
    }),
    update: jest.fn(async ({ data }) => {
      row = { ...row!, ...data, updatedAt: new Date() }
      return structuredClone(row!)
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      if (!matches(where)) return { count: 0 }
      row = { ...row!, ...data, updatedAt: new Date() }
      return { count: 1 }
    }),
  }
  let attempt = 0
  const streamChat = jest.fn(async function* () {
    const index = attempt++
    yield { type: "text", content: outputs[index] ?? "unexpected model call" }
    yield { type: "billing", billing: { model: "ZQ-Think-Flash", costCny: "0.13", currency: "CNY",
      requestId: `evidence-request-${index}`, requestIds: [`evidence-request-${index}`] } }
  })
  const chargeSavedOutput = jest.fn().mockResolvedValue(null)
  const tx = { businessAiRun: table, usageLog: { findUnique: jest.fn().mockResolvedValue({ id: 9 }) } }
  const prisma = { ...tx, $transaction: jest.fn(async callback => {
    const before = structuredClone(row)
    try { return await callback(tx) } catch (error) { row = before; throw error }
  }) }
  const service = new ListingScoreService(prisma as unknown as PrismaService,
    { streamChat } as unknown as AiGatewayProvider, { chargeSavedOutput, assertAffordable: jest.fn().mockResolvedValue(undefined) } as unknown as ListingAiService)
  const dto = {
    operation: "score" as const, model: "ZQ-Think-Flash" as const,
    scoreRequestId: "f3e1cda9-ed2b-4822-899c-e3f4d66f323c", scoreMarket: "amazon_us",
    userPrompt: `mode：standard\n<listing-scoring-source>${JSON.stringify(source)}</listing-scoring-source>`,
  }
  return { service, streamChat, chargeSavedOutput, dto, row: () => row! }
}

function expectEvidenceScores(report: ReturnType<typeof buildReport>) {
  expect(report.dimensions[1].criteria[2].score).toBe(2.381)
  expect(report.dimensions[1].criteria[3]).toMatchObject({ score: 4, status: "UNAVAILABLE", deductions: [] })
  expect(report.dimensions[2].criteria[2].score).toBe(2.5)
  expect(report.dimensions[3].criteria[1].score).toBe(2.8571)
  expect(report.dimensions[3].criteria[2]).toMatchObject({ score: 1, deductions: [
    { ruleId: "alexa.description", checkId: "specifications", points: 1 },
    { ruleId: "alexa.description", checkId: "overview_scenes", points: 1 },
  ] })
  expect(report.total).toBe(91.7381)
}

describe("非CDQ证据差异的非阻断交付与幂等结算", () => {
  beforeEach(() => {
    jest.spyOn(images, "prepareListingScoreImages").mockResolvedValue(undefined)
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
    jest.spyOn(Logger, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())

  async function expectPrimaryDelivery(raw: ReturnType<typeof buildReport>, expected: DeliveryExpectation, source: ListingScoreSource = sourceFacts) {
    const rawText = JSON.stringify(raw)
    const f = createFixture([rawText], source)
    const result = await f.service.complete(3, f.dto)
    const completed = JSON.parse(result.text)
    const { dimensions: rawDimensions, total: _total, potential: _potential, ...unchanged } = raw
    expect(completed).toMatchObject({ ...unchanged, potential: "S级 · 可直接上线", validationStatus: "BEST_EFFORT" })
    const dimensions = raw.dimensions as Array<{ criteria: unknown[] }>
    expect(completed.dimensions[0].criteria).toEqual(dimensions[0].criteria)
    expect(completed.dimensions.slice(1, 3)).toEqual(dimensions.slice(1, 3))
    expect(completed.dimensions[3]).toEqual({ ...rawDimensions[3], score: expected.score, criteria: [
      rawDimensions[3].criteria[0],
      { ...rawDimensions[3].criteria[1], ...expected.bullet },
      { ...rawDimensions[3].criteria[2], ...expected.description },
    ] })
    expect(completed.dimensions[0]).toMatchObject({ score: 40, cdq: {
      applicableMax: 100, effectiveMax: 100, earnedScore: 100, normalizedScore: 100, evidenceCoverage: 1,
    } })
    expect(completed.total).toBe(expected.total)
    expect(completed).not.toHaveProperty("validationWarnings")
    expect(f.row()).toMatchObject({ status: "COMPLETED", outputText: rawText, error: null })
    expect(f.row().billing).not.toHaveProperty("repairs")
    expect(await f.service.complete(3, f.dto)).toEqual(result)
    expect(await f.service.read(3, f.dto.scoreRequestId)).toMatchObject({ status: "COMPLETED", text: result.text })
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput.mock.calls[0][2].requestId).toBe("evidence-request-0")
    return { f, completed }
  }

  it("缺少assessment的可展示报告直接完成，证据校验仅留诊断且同号只结算一次", async () => {
    const raw = buildReport()
    const { completed } = await expectPrimaryDelivery(raw, { score: 13, total: 98, description: EMPTY_DESCRIPTION })
    expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining("assessment"), "ListingScoreDelivery")
    expect(completed.dimensions[1].criteria[2].score).toBe(5)
    expect(completed.dimensions[1].criteria[2]).not.toHaveProperty("assessment")
  })

  it("候选词分数或原文字段不一致时保留模型原文，不再自动查证改分", async () => {
    const raw = buildReport(true)
    const longtail = raw.dimensions[1].criteria[2].assessment as { basis: string; terms: Array<{ field: string; quote: string }> }
    longtail.basis = "provided"
    longtail.terms.forEach(term => { term.field = "title"; term.quote = "Ink refill bottles" })
    const { completed } = await expectPrimaryDelivery(raw, { score: 10.8571, total: 95.8571, bullet: FOUR_QUALIFIED_BULLETS, description: EMPTY_DESCRIPTION })
    expect(completed.dimensions[1].criteria[2].assessment).toEqual(longtail)
  })

  it("部分取证缺失时保留首次候选词和其他评分项，不启动后续模型重评", async () => {
    const raw = buildReport(true)
    delete raw.dimensions[3].criteria[1].assessment
    const terms = structuredClone(raw.dimensions[1].criteria[2].assessment)
    const { completed } = await expectPrimaryDelivery(raw, { score: 13, total: 98, description: EMPTY_DESCRIPTION })
    expect(completed.dimensions[1].criteria[2].assessment).toEqual(terms)
    expect(completed.dimensions[3].criteria[1]).not.toHaveProperty("assessment")
  })

  it("无assessment且分数低于原文明示下界时仅补已确认数据点，不清空扣分或补成满分", async () => {
    const raw = buildReport()
    Object.assign(raw.dimensions[3].criteria[1], {
      score: 2, description: "部分Bullet缺少明确数据点",
      deductions: [{ points: 3, reason: "Bullet 6、7缺少明确数据点" }],
    })
    const { completed } = await expectPrimaryDelivery(raw, { score: 10.1429, total: 95.1429, bullet: THREE_EXPLICIT_BULLETS, description: EMPTY_DESCRIPTION })
    expect(completed.dimensions[3].criteria[1]).toEqual({ ...raw.dimensions[3].criteria[1], ...THREE_EXPLICIT_BULLETS })
    expect(completed.dimensions[3].criteria[1]).not.toHaveProperty("assessment")
  })

  it("跨Bullet引用容量属于诊断差异，不将完整报告改成FAILED或再次调用模型", async () => {
    const raw = buildReport(true)
    const bulletCriterion = raw.dimensions[3].criteria[1]
    bulletCriterion.description = "Bullet 1-7 均包含具体型号、页数 yield、容量 mL 等可验证数据点。"
    const bullets = (bulletCriterion.assessment as { bullets: Array<{ index: number; kind: string; quote: string }> }).bullets
    bullets[4] = { index: 5, kind: "numeric", quote: "140 mL" }
    bullets[5] = { index: 6, kind: "numeric", quote: "17000 pages" }
    const { completed } = await expectPrimaryDelivery(raw, { score: 13, total: 98, description: EMPTY_DESCRIPTION })
    expect(completed.dimensions[3].criteria[1]).toEqual(bulletCriterion)
  })

  it("评分主体可展示但建议和评级缺失时补空建议并按总分评级，只结算一次", async () => {
    const raw = { ...buildReport() } as Record<string, unknown>
    delete raw.suggestions
    delete raw.potential
    const rawText = JSON.stringify(raw)
    const f = createFixture([rawText])
    const result = await f.service.complete(3, f.dto)
    const completed = JSON.parse(result.text)
    const { dimensions: _dimensions, total: _total, ...unchanged } = raw
    expect(completed).toMatchObject({ ...unchanged, suggestions: [], potential: "S级 · 可直接上线", validationStatus: "BEST_EFFORT", total: 98 })
    const dimensions = raw.dimensions as Array<{ criteria: unknown[] }>
    expect(completed.dimensions[0].criteria).toEqual(dimensions[0].criteria)
    expect(completed.dimensions.slice(1, 3)).toEqual(dimensions.slice(1, 3))
    expect(completed.dimensions[3]).toEqual({ ...dimensions[3], score: 13, criteria: [
      dimensions[3].criteria[0], dimensions[3].criteria[1],
      { ...(dimensions[3].criteria[2] as TestCriterion), ...EMPTY_DESCRIPTION },
    ] })
    expect(completed.dimensions[0]).toMatchObject({ score: 40, cdq: {
      applicableMax: 100, effectiveMax: 100, earnedScore: 100, normalizedScore: 100, evidenceCoverage: 1,
    } })
    expect(f.row()).toMatchObject({ status: "COMPLETED", outputText: rawText, error: null })
    expect(await f.service.complete(3, f.dto)).toEqual(result)
    expect(await f.service.read(3, f.dto.scoreRequestId)).toMatchObject({ status: "COMPLETED", text: result.text })
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it("B0G6KWK4LB空description误引Bullet页产量时按空描述1分交付，原始输出仍保存且不阻断", async () => {
    const quote = "Each black bottle delivers up to 17000 pages, while color bottles yield up to 6500 pages each"
    const source = structuredClone(sourceFacts)
    source.bullets[1] = `Tired of constant ink interruptions? ${quote} (5% A4 coverage).`
    const raw = buildReport(true)
    Object.assign(raw.dimensions[3].criteria[2], {
      score: 3, description: "产品描述包含页产量规格和家庭办公场景，已满足要求。", deductions: [],
      assessment: { checks: [
        { checkId: "specifications", isPresent: true, quotes: [quote] },
        { checkId: "overview_scenes", isPresent: true, quotes: ["family photos", "school projects"] },
      ] },
    })
    const { completed } = await expectPrimaryDelivery(raw, { score: 10.8571, total: 95.8571, bullet: FOUR_QUALIFIED_BULLETS, description: EMPTY_DESCRIPTION }, source)
    expect(completed.dimensions[3].criteria[2]).toEqual({ ...raw.dimensions[3].criteria[2], ...EMPTY_DESCRIPTION })
  })

  it("COSMO误标description引用字段时保留原始关系证据，交付不触发局部校对", async () => {
    const raw = buildReport(true)
    const relations = raw.dimensions[2].criteria[2].assessment!.relations as Array<{ type: string; field: string; quote: string }>
    relations[1].field = "description"
    const { completed } = await expectPrimaryDelivery(raw, { score: 10.8571, total: 95.8571, bullet: FOUR_QUALIFIED_BULLETS, description: EMPTY_DESCRIPTION })
    expect(completed.dimensions[2].criteria[2].assessment.relations).toEqual(relations)
  })

  it("旧description待校对计划返回跨字段引用，合并时仍按空原文事实1分恢复", () => {
    const raw = buildReport(true)
    const source = structuredClone(sourceFacts)
    const quote = "Each black bottle delivers up to 17000 pages, while color bottles yield up to 6500 pages each"
    source.bullets[1] = quote
    const prepared = JSON.parse(projectListingReportEvidence(JSON.stringify(raw), source))
    // 兼容校对已经发起的旧计划：本轮模型仍回传description借用Bullet的错误证据。
    const plan = { report: prepared, criteria: [{ dimensionIndex: 3, criterionIndex: 2 }], shouldCorrectSuggestions: false }
    const patch = { corrections: [{ dimensionIndex: 3, criterionIndex: 2, score: 3,
      description: "描述具备页产量数据", deductions: [], assessment: { checks: [
        { checkId: "specifications", isPresent: true, quotes: [quote] },
        { checkId: "overview_scenes", isPresent: false, quotes: [] },
      ] },
    }] }
    const result = JSON.parse(mergeScoreCorrection(JSON.stringify(patch), plan, "amazon_us", true, { sourceFacts: source }))
    expectEvidenceScores(result)
    expect(result.dimensions[3].criteria[2].assessment.checks.every((check: { isPresent: boolean; quotes: string[] }) =>
      !check.isPresent && check.quotes.length === 0)).toBe(true)
  })

  it("description有内容但缺少assessment时保留已有描述评分，不套用空原文结论或拦截", async () => {
    const raw = buildReport(true)
    delete raw.dimensions[3].criteria[2].assessment
    const source = { ...sourceFacts, description: "CAPACITY: 140 mL. PRODUCT OVERVIEW: Homework at home and proposals in the office." }
    const { completed } = await expectPrimaryDelivery(raw, { score: 12.8571, total: 97.8571, bullet: FOUR_QUALIFIED_BULLETS, description: {} }, source)
    expect(completed.dimensions[3].criteria[2].score).toBe(3)
    expect(completed.dimensions[3].criteria[2]).not.toHaveProperty("assessment")
  })

  it("证据分数2.1429的浮点尾差不会阻断维度与CDQ状态的局部校对", () => {
    const raw = buildReport(true)
    const bulletAssessment = raw.dimensions[3].criteria[1].assessment as { bullets: Array<{ index: number; kind: string; quote: string }> }
    bulletAssessment.bullets[6] = { index: 7, kind: "", quote: "" }
    const ruleContext = { sourceFacts: structuredClone(sourceFacts) }
    ruleContext.sourceFacts.bullets[6] = "Friendly support helps you enjoy a better printing experience."
    const prepared = JSON.parse(projectListingReportEvidence(JSON.stringify(raw), ruleContext.sourceFacts))
    expect(prepared.dimensions[3].criteria.map(({ score }) => score)).toEqual([7, 2.1429, 1])
    prepared.dimensions[3].score = 10
    delete prepared.dimensions[0].criteria[0].status
    const plan = buildScoreCorrectionPlan(JSON.stringify(prepared), "amazon_us", true, ruleContext)
    expect(plan?.criteria).toEqual([{ dimensionIndex: 0, criterionIndex: 0 }])
    expect(plan?.dimensionIndices).toEqual([3])
    const merged = JSON.parse(mergeScoreCorrection(JSON.stringify({
      corrections: [{ dimensionIndex: 0, criterionIndex: 0, score: 30, status: "VERIFIED",
        description: "原始合规项，仅补齐取证状态", deductions: [] }],
      dimensionCorrections: [{ dimensionIndex: 3, deductions: [] }],
    }), plan!, "amazon_us", true, ruleContext))
    expect(merged.dimensions[3].score).toBe(10.1429)
    expect(merged.dimensions[3].criteria[1].score).toBe(2.1429)
    expect(merged.dimensions[0].criteria[0]).toMatchObject({ score: 30, status: "VERIFIED" })
    expect(merged.total).toBe(91.0239)
  })
})
