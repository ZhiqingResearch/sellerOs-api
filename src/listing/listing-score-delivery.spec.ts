import { DomesticBusinessModels } from "../common/business-ai/domestic-business-models"
import { Logger, ValidationPipe } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { BusinessAiRun, Prisma } from "@prisma/client"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { HistoryService } from "../history/history.service"
import { ListingAiPermissionGuard } from "./guards/listing-ai-permission.guard"
import { ListingModelSelectionGuard } from "./guards/listing-model-selection.guard"
import { ListingAiService } from "./listing-ai.service"
import { ListingDocumentService } from "./listing-document.service"
import { ListingGenerationService } from "./listing-generation.service"
import { ListingRunService } from "./listing-run.service"
import { ListingController } from "./listing.controller"
import { type ListingScoreSource } from "./listing-score-evidence"
import * as images from "./listing-score-images"
import { parseListingJsonObject } from "./listing-result-parser"
import { ListingScoreService } from "./listing-score.service"

interface IncidentFixture {
  sourceFacts: ListingScoreSource
  primary: string
}
interface SavedBilling { repairs?: Array<{ outputText: string }>; resultText?: string }

it("推荐属性未填误扣6分时直接按规则计分并完成，不增加AI调用或报错拦截", async () => {
  const incident = loadIncident(28)
  const raw = JSON.parse(incident.primary)
  Object.assign(raw.dimensions[0].criteria[0], { score: 24, status: "VERIFIED",
    description: "已核验13项前台可见属性，无明显矛盾或错位，填写规范。",
    deductions: [{ points: 6, reason: "属性填写完整度与重要度加权扣分", ruleId: "attribute.required", evidence: "前台可见属性13项，部分推荐属性未填，按权重折算" }],
  })
  incident.primary = JSON.stringify(raw)
  const f = createFixture(incident)
  const result = await f.service.complete(3, f.dto)
  expect(JSON.parse(result.text).dimensions[0].criteria[0]).toMatchObject({ score: 30, status: "VERIFIED", deductions: [] })
  expect(f.row()).toMatchObject({ status: "COMPLETED", error: null, outputText: incident.primary })
  expect((f.row().billing as unknown as SavedBilling).repairs ?? []).toEqual([])
  expect(f.streamChat).toHaveBeenCalledTimes(1)
  expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  expect(await f.service.complete(3, f.dto)).toEqual(result)
  expect(f.streamChat).toHaveBeenCalledTimes(1)
  expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
})

function loadIncident(incidentId: number): IncidentFixture {
  if (incidentId === 32) {
    const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-alexa-zero-20260917.json"), "utf8"))
    return { sourceFacts: fixture.sourceFacts, primary: JSON.stringify(fixture.primary) }
  }
  const fixtureName = incidentId === 28 ? "listing-score-summary-28-20260917.json" : `listing-score-bullet-${incidentId}-20260917.json`
  return JSON.parse(readFileSync(join(__dirname, "fixtures", fixtureName), "utf8"))
}

/** 原始报告保持完整结构，只允许一次模型输出，禁止语义校对再次调用模型。 */
function createFixture(incident: IncidentFixture) {
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
  let invocationCount = 0
  const streamChat = jest.fn(async function* () {
    invocationCount++
    if (invocationCount > 1) throw new Error("完整报告不得再次调用模型校对")
    yield { type: "text", content: incident.primary }
    yield { type: "billing", billing: { model: "ZQ-Think-Flash", costCny: "0.13", currency: "CNY",
      requestId: "delivery-primary", requestIds: ["delivery-primary"] } }
  })
  const chargeSavedOutput = jest.fn().mockResolvedValue(null)
  const tx = { businessAiRun: table, usageLog: { findUnique: jest.fn().mockResolvedValue({ id: 9 }) } }
  const prisma = { ...tx, $transaction: jest.fn(async callback => {
    const previousRow = structuredClone(row)
    try { return await callback(tx) } catch (error) { row = previousRow; throw error }
  }) }
  const service = new ListingScoreService(prisma as unknown as PrismaService,
    { streamChat } as unknown as AiGatewayProvider, { chargeSavedOutput, assertAffordable: jest.fn().mockResolvedValue(undefined) } as unknown as ListingAiService)
  const dto = {
    operation: "score" as const, model: "qwen3.8-max" as const,
    scoreRequestId: "07f3ca4e-e9a8-4693-811c-009e5658cfaa", scoreMarket: "amazon_us",
    userPrompt: `mode：standard\n<listing-scoring-source>${JSON.stringify(incident.sourceFacts)}</listing-scoring-source>`,
  }
  return { service, dto, streamChat, chargeSavedOutput, row: () => row! }
}

function expectDeliveredPrimary(text: string, incident: IncidentFixture, incidentId: number) {
  const report = parseListingJsonObject(text)
  const primaryReport = parseListingJsonObject(incident.primary)
  // 本次仅修Alexa既有公式；CDQ细则、关键词和COSMO不重判，原始输出单独保留。
  const dimensions = primaryReport.dimensions as Array<{ score: number; criteria: unknown[] }>
  const deliveredDimensions = report.dimensions as Array<{ score: number; criteria: Array<{ score: number; deductions: Array<{ points: number }> }>; cdq?: unknown }>
  expect(deliveredDimensions[0].criteria).toEqual(dimensions[0].criteria)
  expect(deliveredDimensions.slice(1, 3)).toEqual(dimensions.slice(1, 3))
  expect(report.suggestions).toEqual(primaryReport.suggestions)
  const expectedScores: Record<number, number[]> = { 25: [7, 5, 1], 26: [7, 4, 1], 28: [7, 5, 1], 32: [5, 2.8571, 1] }
  const expectedTotals: Record<number, number> = { 25: 85.3684, 26: 78.3334, 28: 84.4286, 32: 82.5833 }
  expect(deliveredDimensions[3].criteria.map(item => item.score)).toEqual(expectedScores[incidentId])
  expect(deliveredDimensions[3].criteria[2].deductions.map(item => item.points)).toEqual([1, 1])
  expect(report.total).toBe(expectedTotals[incidentId])
  if (incidentId === 26) {
    expect(deliveredDimensions[0]).toMatchObject({ score: 32.8334, cdq: {
      applicableMax: 100, effectiveMax: 80, earnedScore: 65.6667, normalizedScore: 82.0834, evidenceCoverage: 0.8,
    } })
    expect(report.potential).toBe("B级 · 优化后上线")
  } else if (incidentId === 28) {
    expect(deliveredDimensions[0]).toMatchObject({ score: 31.4286, cdq: {
      applicableMax: 100, effectiveMax: 80, earnedScore: 62.8571, normalizedScore: 78.5714, evidenceCoverage: 0.8,
    } })
    expect(Math.round((report.dimensions as Array<{ cdq: { normalizedScore: number } }>)[0].cdq.normalizedScore)).toBe(79)
  } else if (incidentId === 32) {
    expect(deliveredDimensions[3].score).toBe(8.8571)
    expect(deliveredDimensions[0]).toMatchObject({ score: 31.7262 })
    expect(report.potential).toBe("A级 · 小幅调整后上线")
  }
  expect(report.validationStatus).toBe("BEST_EFFORT")
  return report
}

describe.each([25, 26, 28, 32])("原始完整报告%s不再因语义校对阻断交付", incidentId => {
  const incident = loadIncident(incidentId)
  beforeEach(() => {
    jest.spyOn(images, "prepareListingScoreImages").mockResolvedValue(undefined)
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())

  it("真实事故只调用一次模型，细则保留且汇总正确后持久化，重读不重复结算", async () => {
    const f = createFixture(incident)
    const result = await f.service.complete(3, f.dto)
    expectDeliveredPrimary(result.text, incident, incidentId)
    expect(f.row().status).toBe("COMPLETED")
    expect(f.row().error).toBeNull()
    expect(f.row().outputText).toBe(incident.primary)
    const billing = f.row().billing as unknown as SavedBilling
    expect(billing.repairs ?? []).toEqual([])
    expect(billing.resultText).toBe(result.text)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput.mock.calls[0][2].requestId).toBe("delivery-primary")
    expect(await f.service.complete(3, f.dto)).toEqual(result)
    expect(await f.service.read(3, f.dto.scoreRequestId)).toMatchObject({ status: "COMPLETED", text: result.text, error: null })
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })

  it("HTTP/SSE交付原始完整报告并返回DONE，分数和证据不一致也不出现语义拦截", async () => {
    const f = createFixture(incident)
    const builder = Test.createTestingModule({
      controllers: [ListingController],
      providers: [
        { provide: DomesticBusinessModels, useValue: { assertEnabled: jest.fn().mockResolvedValue(undefined) } },
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
    app.use((request: { user: { id: number } }, _response: unknown, next: () => void) => { request.user = { id: 3 }; next() })
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
      expect(body).not.toContain("原文证据核验")
      const saved = await (await fetch(`${baseUrl}/api/listing/score-runs/${f.dto.scoreRequestId}`)).json()
      expect(saved.status).toBe("COMPLETED")
      expect(saved.error).toBeNull()
      expectDeliveredPrimary(saved.text, incident, incidentId)
      expect(f.streamChat).toHaveBeenCalledTimes(1)
      await (await post()).text()
      expect(f.streamChat).toHaveBeenCalledTimes(1)
      expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
      expect(f.chargeSavedOutput.mock.calls[0][2].requestId).toBe("delivery-primary")
    } finally { await app.close() }
  })

  if (incidentId === 32) it("已完成的旧零分报告在重读及同请求重放时修分，不改存档也不重新扣费", async () => {
    const f = createFixture(incident)
    await f.service.complete(3, f.dto)
    const billing = f.row().billing as unknown as SavedBilling
    billing.resultText = incident.primary
    const original = structuredClone(f.row())
    const read = await f.service.read(3, f.dto.scoreRequestId)
    expectDeliveredPrimary(read.text!, incident, incidentId)
    expectDeliveredPrimary((await f.service.complete(3, f.dto)).text, incident, incidentId)
    expect(f.row()).toEqual(original)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })
})


describe("已返回评分的交付回归", () => {
  const incident: IncidentFixture = JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-negative-description-20261014.json"), "utf8"))
  it("实跑负1.05分按3减1交付2分，HTTP结果正常且重读不重复扣费", async () => {
    const f = createFixture(incident)
    const result = await f.service.complete(3, f.dto)
    const report = JSON.parse(result.text)
    expect(report.dimensions[3].criteria[2]).toMatchObject({ score: 2, deductions: [{ points: 1 }] })
    expect(report.dimensions[3].score).toBe(14)
    expect(report.total).toBe(95.5)
    expect(f.row()).toMatchObject({ status: "COMPLETED", error: null, outputText: incident.primary })
    expect(await f.service.complete(3, f.dto)).toEqual(result)
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })
  it("缺一个细则正常返回已有内容，未知项不补分，不额外请求AI或扣费", async () => {
    const report = JSON.parse(incident.primary)
    report.dimensions[3].criteria.pop()
    const f = createFixture({ ...incident, primary: JSON.stringify(report) })
    const result = JSON.parse((await f.service.complete(3, f.dto)).text)
    expect(result.total).toBeNull()
    expect(result.dimensions[3].criteria[2]).toMatchObject({ score: null, status: "PENDING" })
    expect(result.dimensions[0].criteria[0].score).toBe(30)
    expect(f.row()).toMatchObject({ status: "COMPLETED", error: null })
    expect(f.streamChat).toHaveBeenCalledTimes(1)
    expect(f.chargeSavedOutput).not.toHaveBeenCalled()
  })
})


it("描述2分没有扣分依据时独立打分正常完成，暂未评分且不重试或扣费", async () => {
  const incident: IncidentFixture = JSON.parse(readFileSync(join(__dirname, "fixtures/listing-score-negative-description-20261014.json"), "utf8"))
  const raw = JSON.parse(incident.primary)
  Object.assign(raw.dimensions[3].criteria[2], { score: 2, description: "描述结构合规，包含场景与规格。", deductions: [] })
  const f = createFixture({ ...incident, primary: JSON.stringify(raw) })
  const result = await f.service.complete(3, f.dto)
  expect(JSON.parse(result.text).dimensions[3].criteria[2]).toMatchObject({ score: null, deductions: [], status: "PENDING" })
  expect(f.row()).toMatchObject({ status: "COMPLETED", error: null })
  expect(await f.service.complete(3, f.dto)).toEqual(result)
  expect(f.streamChat).toHaveBeenCalledTimes(1)
  expect(f.chargeSavedOutput).not.toHaveBeenCalled()
})
