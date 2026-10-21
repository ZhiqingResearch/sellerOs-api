import { Logger } from "@nestjs/common"
import { BusinessAiRun, Prisma } from "@prisma/client"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { ListingAiService } from "./listing-ai.service"
import { buildScoreCorrectionPlan } from "./listing-score-correction"
import * as images from "./listing-score-images"
import { validateListingReportRules } from "./listing-score-rules"
import { ListingScoreService } from "./listing-score.service"

// 仅保留线上失败的评分 JSON；不包含账号、运行记录、请求标识或计费数据。
const rawText = readFileSync(join(__dirname, "fixtures/listing-score-missing-description.json"), "utf8")

interface TestDeduction {
  points: number
  reason: string
  ruleId: string
  evidence: string
  checkId?: string
}

interface TestCorrection {
  dimensionIndex: number
  criterionIndex: number
  score: number | null
  description: string
  status?: string
  deductions: TestDeduction[]
}

const STATIC_LISTING = `mode：standard
回归测试的固定商品资料：
标题：502 Ink Bottles 502 Ink Bottles 502 Ink Bottles。标题同词出现三次。
未提供结构化属性数据及类目必填属性清单；未提供变体矩阵和 Backend Search Terms。
主图为白底、无水印、商品占比90%，长边1600px。副图共5张，有场景和细节，缺尺寸及包装清单。
A+含3个模块、对比表和场景图。Bullet共7条，其中1至4条分别有502型号、17000页、140mL、24/7；5至7条仅有宣传话术。
S/A关键词7个覆盖6个。B/C关键词5个覆盖3个。
COSMO通用四类已覆盖；品类关系缺一类，按原规则扣1.5；中优先级仅IS_A，缺两类。
标题有产品和型号但重复堆砌，标题子项扣3分，不另扣维度分。
描述没有结构化规格，也没有PRODUCT OVERVIEW具体场景。`

function buildCorrections(): TestCorrection[] {
  const deduction = (ruleId: string, points: number, evidence: string, checkId?: string): TestDeduction => ({
    ruleId, points, evidence, reason: evidence, ...(checkId ? { checkId } : {}),
  })
  return [
    { dimensionIndex: 0, criterionIndex: 0, score: null, status: "UNAVAILABLE", description: "未提供结构化属性数据及类目必填清单，无法核验", deductions: [] },
    { dimensionIndex: 0, criterionIndex: 1, score: 22.5, status: "MISSING", description: "标题同词出现三次，按重复词检查点扣分", deductions: [deduction("title.repeat", 2.5, "title: 502 Ink Bottles 连续出现三次")] },
    { dimensionIndex: 0, criterionIndex: 3, score: 13, status: "MISSING", description: "副图5张，缺尺寸及包装清单", deductions: [
      deduction("image.count", 0.5, "副图5张，数量得分2.5/3"),
      deduction("image.coverage", 0.75, "副图缺尺寸对比", "dimensions"),
      deduction("image.coverage", 0.75, "副图缺包装清单", "package"),
    ] },
    { dimensionIndex: 1, criterionIndex: 1, score: 6, description: "7个S/A词覆盖6个", deductions: [deduction("keyword.sa", 1, "S/A词7个覆盖6个")] },
    { dimensionIndex: 1, criterionIndex: 2, score: 4.2857, description: "5个B/C词覆盖3个，覆盖率60%，按70%门槛比例计分", deductions: [deduction("keyword.longtail", 0.7143, "B/C覆盖3/5；5×(60%/70%)=4.2857")] },
    { dimensionIndex: 2, criterionIndex: 1, score: 4.5, description: "品类关系缺一类", deductions: [deduction("cosmo.category", 1.5, "原始固定资料明确品类关系缺一类")] },
    { dimensionIndex: 2, criterionIndex: 2, score: 1, description: "仅覆盖IS_A，距三类缺两类", deductions: [deduction("cosmo.medium", 3, "IS_A已覆盖；USED_TO、USED_BY、USED_FOR_EVE均未覆盖")] },
    { dimensionIndex: 3, criterionIndex: 0, score: 4, description: "标题有产品型号，但同一短语重复堆砌", deductions: [deduction("alexa.title", 3, "title: 502 Ink Bottles 连续重复三次")] },
    { dimensionIndex: 3, criterionIndex: 1, score: 2.8571, description: "7条Bullet中4条有可验证数据点", deductions: [deduction("alexa.bulletData", 2.1429, "Bullet1-4：502、17000页、140mL、24/7；Bullet5-7无数据点")] },
    { dimensionIndex: 3, criterionIndex: 2, score: 1, description: "描述缺规格和总览场景，各扣1分", deductions: [
      deduction("alexa.description", 1, "description未包含结构化规格", "specifications"),
      deduction("alexa.description", 1, "description未包含PRODUCT OVERVIEW具体场景", "overview_scenes"),
    ] },
  ]
}

function createFixture(initialText = rawText) {
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
  const correction = { corrections: buildCorrections(), dimensionCorrections: [
    { dimensionIndex: 1, deductions: [] }, { dimensionIndex: 3, deductions: [] },
  ] }
  let attempt = 0
  const streamChat = jest.fn(async function* () {
    const index = attempt++
    yield { type: "text", content: index === 0 ? initialText : JSON.stringify(correction) }
    yield { type: "billing", billing: { model: "ZQ-Think-Flash", costCny: "0.13", currency: "CNY",
      requestId: `recovery-test-${index}`, requestIds: [`recovery-test-${index}`] } }
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
    scoreRequestId: "b3c7bb2a-7d21-4aaf-855b-19de9a92f228", scoreMarket: "amazon_us", userPrompt: STATIC_LISTING,
  }
  return { service, dto, streamChat, chargeSavedOutput, row: () => row! }
}

describe("CDQ真实缺可选字段报告的直接交付", () => {
  beforeEach(() => {
    jest.spyOn(images, "prepareListingScoreImages").mockResolvedValue(undefined)
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())

  it("缺description并缺扣分ruleId时仍生成校对计划，不提前抛出取证状态报错", () => {
    const plan = buildScoreCorrectionPlan(rawText, "amazon_us", true)
    expect(plan).not.toBeNull()
    expect(plan!.criteria).toEqual(buildCorrections().map(({ dimensionIndex, criterionIndex }) => ({ dimensionIndex, criterionIndex })))
    expect(plan!.dimensionIndices).toEqual([1, 3])
    expect(plan!.report).toEqual(JSON.parse(rawText))
    expect(plan!.report.dimensions[1].criteria[2]).not.toHaveProperty("description")
  })

  it("缺说明和扣分ruleId仍交付原细则并修正汇总，不启动语义校对且同号只结算一次", async () => {
    const fixture = createFixture()
    const result = await fixture.service.complete(3, fixture.dto)
    const report = JSON.parse(result.text)
    const raw = JSON.parse(rawText)
    expect(fixture.row()).toMatchObject({ status: "COMPLETED", outputText: rawText, error: null })
    expect(report).toEqual({ ...raw, dimensions: [{ ...raw.dimensions[0], score: 23.125, cdq: {
      applicableMax: 100, effectiveMax: 80, earnedScore: 46.25, normalizedScore: 57.8125, evidenceCoverage: 0.8,
    } }, ...raw.dimensions.slice(1)], total: 60.7679, potential: "C级 · 建议重新生成", validationStatus: "BEST_EFFORT" })
    expect(report.dimensions[1].criteria[2]).not.toHaveProperty("description")
    expect(() => validateListingReportRules(report)).toThrow()
    expect((fixture.row().billing as { repairs?: unknown[] }).repairs ?? []).toHaveLength(0)
    expect(fixture.streamChat).toHaveBeenCalledTimes(1)
    expect(await fixture.service.complete(3, fixture.dto)).toEqual(result)
    expect(await fixture.service.read(3, fixture.dto.scoreRequestId)).toMatchObject({ status: "COMPLETED", text: result.text })
    expect(fixture.streamChat).toHaveBeenCalledTimes(1)
    expect(fixture.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(fixture.chargeSavedOutput.mock.calls[0][2].requestId).toBe("recovery-test-0")
  })

  it("缺说明、建议和评级时保留细则和扣分，修正汇总并直接完成", async () => {
    const partial = JSON.parse(rawText)
    delete partial.suggestions
    delete partial.potential
    const initialText = JSON.stringify(partial)
    const fixture = createFixture(initialText)
    const result = await fixture.service.complete(3, fixture.dto)
    const report = JSON.parse(result.text)
    expect(report).toEqual({ ...partial, dimensions: [{ ...partial.dimensions[0], score: 23.125, cdq: {
      applicableMax: 100, effectiveMax: 80, earnedScore: 46.25, normalizedScore: 57.8125, evidenceCoverage: 0.8,
    } }, ...partial.dimensions.slice(1)], total: 60.7679, suggestions: [], potential: "C级 · 建议重新生成", validationStatus: "BEST_EFFORT" })
    expect(report.dimensions[1].criteria[2]).not.toHaveProperty("description")
    expect(fixture.row()).toMatchObject({ status: "COMPLETED", outputText: initialText, error: null })
    expect((fixture.row().billing as { repairs?: unknown[] }).repairs ?? []).toHaveLength(0)
    expect(await fixture.service.complete(3, fixture.dto)).toEqual(result)
    expect(await fixture.service.read(3, fixture.dto.scoreRequestId)).toMatchObject({ status: "COMPLETED", text: result.text })
    expect(fixture.streamChat).toHaveBeenCalledTimes(1)
    expect(fixture.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })
})
