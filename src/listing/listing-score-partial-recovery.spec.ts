import { Logger, ValidationPipe } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { BusinessAiRun, Prisma } from "@prisma/client"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { ListingAiService } from "./listing-ai.service"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { HistoryService } from "../history/history.service"
import { ListingAiPermissionGuard } from "./guards/listing-ai-permission.guard"
import { ListingModelSelectionGuard } from "./guards/listing-model-selection.guard"
import { ListingDocumentService } from "./listing-document.service"
import { ListingGenerationService } from "./listing-generation.service"
import { ListingRunService } from "./listing-run.service"
import { ListingController } from "./listing.controller"
import { parseListingJsonObject } from "./listing-result-parser"
import { type ListingScoreSource } from "./listing-score-evidence"
import { buildListingEvidencePrompt } from "./listing-score-evidence-flow"
import * as images from "./listing-score-images"
import { validateListingReportRules } from "./listing-score-rules"
import { ListingScoreService } from "./listing-score.service"

interface IncidentFixture {
  sourceFacts: ListingScoreSource
  primary: string
  repairs: Array<{ outputText: string }>
}
interface Criterion {
  name: string
  maxScore: number
  score: number | null
  status?: string
  description?: string
  deductions: Array<{ points: number; reason: string; ruleId: string; evidence: string; checkId?: string }>
  assessment?: Record<string, unknown>
}
interface CorrectionRequest {
  requestedCriteria: Array<{ dimensionIndex: number; criterionIndex: number; currentCriterion: Criterion }>
  requestedDimensions: number[]
  pendingTailFields?: string[]
}
interface SavedBilling {
  repairs: Array<{ outputText: string; error?: string }>
  sourceFacts: ListingScoreSource
}
const incident = JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-format-20260917.json"), "utf8")) as IncidentFixture

function buildExpectedIncidentReport() {
  const primary = parseListingJsonObject(incident.primary) as unknown as {
    dimensions: Array<{ score: number; criteria: Criterion[] }>
  }
  const alexa = primary.dimensions[3]
  const description = "逐条核验7条Bullet，合格5条（1、2、3、4、7）；未含可验证数据点：5、6。"
  // 此旧事故assessment已有第4条top sealing design规格判断，保留模型判断，按5×5/7计算。
  // 维度原有隐含扣分为7+3.5+0-6=4.5，恢复后为7+3.5714+1-4.5=7.0714。
  return { ...primary, validationStatus: "BEST_EFFORT", total: 59.5214, potential: "C级 · 建议重新生成",
    dimensions: [...primary.dimensions.slice(0, 3), { ...alexa, score: 7.0714, criteria: [
      alexa.criteria[0],
      { ...alexa.criteria[1], score: 3.5714, description,
        deductions: [{ ruleId: "alexa.bulletData", points: 1.4286,
          reason: "Bullet 5、6缺少具名规格、认证或数字指标", evidence: description }] },
      { ...alexa.criteria[2], score: 1, description: "结构化规格段缺失；PRODUCT OVERVIEW具体场景缺失。",
        assessment: { checks: [
          { checkId: "specifications", isPresent: false, quotes: [] },
          { checkId: "overview_scenes", isPresent: false, quotes: [] },
        ] },
        deductions: [
          { ruleId: "alexa.description", checkId: "specifications", points: 1, reason: "缺少结构化规格段", evidence: "description为空，未提供独立产品描述。" },
          { ruleId: "alexa.description", checkId: "overview_scenes", points: 1, reason: "缺少PRODUCT OVERVIEW具体场景", evidence: "description为空，未提供独立产品描述。" },
        ] },
    ] }],
  }
}

// 与本商品先前逐条核验通过的25项assessment一致，保留矛盾、错位及待确认项；不以满分补齐。
function buildAttributeAssessment(): Record<string, unknown> {
  const weights = [2, 2, 1, 1, 1, 3, 3, 2, 3, 2, 1, 1, 1, 2, 3, 3, 2, 1, 1, 2, 2, 2, 3, 1, 1]
  const problems: Record<number, { errorType: string; suggestion: string; comparison?: Array<{ field: string; quote: string }> }> = {
    2: { errorType: "PENDING", suggestion: "明确Page Yield是单瓶还是整套口径" },
    6: { errorType: "CONTRADICTION", suggestion: "应与Ink Colour保持一致，改为Multicolor", comparison: [{ field: "attributes.1", quote: "Multicolor" }] },
    7: { errorType: "TYPE_MISMATCH", suggestion: "删除False，填入实际兼容型号" },
    9: { errorType: "CONTRADICTION", suggestion: "删除HP型号，填入EcoTank兼容型号", comparison: [{ field: "bullets.1", quote: "Eco Tank ET-2850" }] },
    15: { errorType: "PRODUCT_DESCRIPTION", suggestion: "改为502" },
    17: { errorType: "PRODUCT_DESCRIPTION", suggestion: "改为SUPRINT" },
    25: { errorType: "PRODUCT_DESCRIPTION", suggestion: "改为502" },
  }
  return { attributeChecks: weights.map((weight, index) => ({
    index: index + 1, weight, errorType: "NONE", comparison: [], suggestion: "", ...problems[index + 1],
  })) }
}

function buildCorrection(item: CorrectionRequest["requestedCriteria"][number]) {
  const { dimensionIndex, criterionIndex, currentCriterion } = item
  const current = structuredClone(currentCriterion)
  const descriptions: Record<string, string> = {
    "1:0": "标题前75字符包含502 Ink Refill Bottles。",
    "1:1": "标题及Bullet列明502补充墨水和兼容的ET/ST系列型号。",
    "1:3": "SEARCH TERMS未获取",
    "1:4": "原始属性Printer Model Compatibility写有HP Officejet Pro型号，与Bullet中的Eco Tank ET型号不符。",
    "2:0": "按原始报告核验功能、受众、场所及能力，保留原有未覆盖关系扣分。",
    "2:1": "按原始报告核验品类驱动关系，保留原有未覆盖关系扣分。",
    "3:0": "标题明确说明502补充墨水、高容量及5瓶装。",
  }
  if (dimensionIndex === 0 && criterionIndex === 0) current.assessment = buildAttributeAssessment()
  return {
    dimensionIndex, criterionIndex, score: current.score,
    ...(dimensionIndex === 0 ? { status: current.score === null ? "UNAVAILABLE" : current.deductions.length ? "MISSING" : "VERIFIED" } : {}),
    description: current.description || descriptions[`${dimensionIndex}:${criterionIndex}`] || current.deductions.map(deduction => deduction.reason).join("；"),
    deductions: current.deductions,
    ...(current.assessment ? { assessment: current.assessment } : {}),
  }
}

function createFixture(initialText = incident.primary, firstRepairText = incident.repairs[0].outputText) {
  let row: BusinessAiRun | null = null
  const matches = (where: Record<string, unknown>): boolean => {
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
  const requests: CorrectionRequest[] = []
  const returnedTexts: string[] = []
  const acceptedKeys = new Set<string>()
  let attempt = 0
  const streamChat = jest.fn(async function* (_systemPrompt: string, userPrompt: string) {
    const index = attempt++
    let text: string
    if (index === 0) text = initialText
    else {
      const request = JSON.parse(userPrompt) as CorrectionRequest
      requests.push(request)
      const requestedKeys = request.requestedCriteria.map(item => `${item.dimensionIndex}:${item.criterionIndex}`)
      for (const key of acceptedKeys) expect(requestedKeys).not.toContain(key)
      if (index === 1) {
        text = firstRepairText
        acceptedKeys.add("0:3")
      } else {
        const selected = request.requestedCriteria
        const dimensions = request.requestedDimensions
        text = JSON.stringify({
          corrections: selected.map(buildCorrection),
          ...(dimensions.length ? { dimensionCorrections: dimensions.map(dimensionIndex => ({ dimensionIndex, deductions: [] })) } : {}),
          ...(request.pendingTailFields?.includes("suggestions") ? { suggestions: ["修正已发现的结构化属性矛盾与错位，并补齐产品描述。"] } : {}),
        })
        selected.forEach(item => acceptedKeys.add(`${item.dimensionIndex}:${item.criterionIndex}`))
      }
      returnedTexts.push(text)
    }
    yield { type: "text", content: text }
    yield { type: "billing", billing: { model: "ZQ-Think-Flash", costCny: index === 0 ? "0.13" : "0.03", currency: "CNY",
      requestId: `partial-recovery-${index}`, requestIds: [`partial-recovery-${index}`] } }
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
    scoreRequestId: "6279856d-042f-49b0-b0b7-dbec30fb9579", scoreMarket: "amazon_us",
    userPrompt: `mode：standard\n<listing-scoring-source>${JSON.stringify(incident.sourceFacts)}</listing-scoring-source>`,
  }
  return { service, dto, streamChat, chargeSavedOutput, requests, returnedTexts, row: () => row! }
}

describe("实际报告直接交付、结构恢复与幂等结算", () => {
  beforeEach(() => {
    jest.spyOn(images, "prepareListingScoreImages").mockResolvedValue(undefined)
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())

  it("逐项校对提示仅携带该项的证据契约", () => {
    const attributePrompt = buildListingEvidencePrompt(incident.sourceFacts, [{ dimensionIndex: 0, criterionIndex: 0 }])
    expect(attributePrompt).toContain("attributeChecks")
    expect(attributePrompt).not.toContain('"terms"')
    expect(attributePrompt).not.toContain('"relations"')
    expect(attributePrompt).not.toContain('"bullets"')
    expect(attributePrompt).not.toContain('"checks"')
    expect(buildListingEvidencePrompt(incident.sourceFacts, [{ dimensionIndex: 0, criterionIndex: 3 }])).toBe("")
  })

  it("实际报告仅缺证据字段时按既有Alexa公式交付，其他维度及原始输出不变且不进入局部校对", async () => {
    const f = createFixture()
    const result = await f.service.complete(3, f.dto)
    const report = JSON.parse(result.text)
    expect(report).toEqual(buildExpectedIncidentReport())
    expect(() => validateListingReportRules(report, { sourceFacts: incident.sourceFacts })).toThrow()
    expect(f.row()).toMatchObject({ status: "COMPLETED", outputText: incident.primary, error: null })
    const billing = f.row().billing as unknown as SavedBilling
    expect(billing.repairs ?? []).toHaveLength(0)
    expect(f.requests).toHaveLength(0)
    expect(f.returnedTexts).toHaveLength(0)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput.mock.calls[0][2].requestId).toBe("partial-recovery-0")
    expect(await f.service.complete(3, f.dto)).toEqual(result)
    expect(await f.service.read(3, f.dto.scoreRequestId)).toMatchObject({ status: "COMPLETED", text: result.text })
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it("缺少评分项正常交付已有内容，已知原文可本地计算，不追加模型校对", async () => {
    const primary = parseListingJsonObject(incident.primary) as unknown as { dimensions: Array<{ criteria: Criterion[] }> }
    const incomplete = structuredClone(primary)
    incomplete.dimensions[3].criteria.pop()
    const initialText = JSON.stringify(incomplete)
    const f = createFixture(initialText, incident.primary)
    const result = await f.service.complete(3, f.dto)
    const report = JSON.parse(result.text)
    expect(report.dimensions[0].criteria).toEqual(primary.dimensions[0].criteria)
    // 原始description为空，按既定规则可直接计算为1，不需要模型补写。
    expect(report.dimensions[3].criteria[2].score).toBe(1)
    expect(f.row()).toMatchObject({ status: "COMPLETED", outputText: initialText, error: null })
    const billing = f.row().billing as unknown as SavedBilling
    expect(billing.repairs ?? []).toHaveLength(0)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(await f.service.complete(3, f.dto)).toEqual(result)
    expect(await f.service.read(3, f.dto.scoreRequestId)).toMatchObject({ status: "COMPLETED", text: result.text })
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it("真实事故通过HTTP/SSE一次交付完整报告，一致性诊断不暴露到页面", async () => {
    const f = createFixture()
    const builder = Test.createTestingModule({
      controllers: [ListingController],
      providers: [
        { provide: ListingScoreService, useValue: f.service },
        ...[ListingAiService, ListingDocumentService, ListingGenerationService, ListingRunService, HistoryService]
          .map(provide => ({ provide, useValue: {} })),
      ],
    })
    for (const guard of [JwtAuthGuard, PermissionsGuard, ListingAiPermissionGuard, ListingModelSelectionGuard])
      builder.overrideGuard(guard).useValue({ canActivate: () => true })
    const app = (await builder.compile()).createNestApplication({ logger: false })
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    app.use((request: { user: { id: number } }, _response: unknown, next: () => void) => {
      request.user = { id: 3 }
      next()
    })
    try {
      await app.listen(0, "127.0.0.1")
      const baseUrl = await app.getUrl()
      const post = () => fetch(`${baseUrl}/api/listing/ai/stream`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f.dto),
      })
      const response = await post()
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain("data: [DONE]")
      expect(body).not.toContain('"type":"error"')
      expect(body).not.toContain("返回格式与指定校对项不一致")
      const saved = await (await fetch(`${baseUrl}/api/listing/score-runs/${f.dto.scoreRequestId}`)).json()
      expect(saved.status).toBe("COMPLETED")
      expect(JSON.parse(saved.text)).toEqual(buildExpectedIncidentReport())
      expect(f.row()).toMatchObject({ status: "COMPLETED", outputText: incident.primary, error: null })
      expect(f.streamChat).toHaveBeenCalledTimes(1)
      const invocationCount = f.streamChat.mock.calls.length
      await (await post()).text()
      expect(f.streamChat).toHaveBeenCalledTimes(invocationCount)
      expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
      expect(f.chargeSavedOutput.mock.calls[0][2].requestId).toBe("partial-recovery-0")
    } finally {
      await app.close()
    }
  })
})
