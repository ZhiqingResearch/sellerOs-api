import { Logger } from "@nestjs/common"
import { BusinessAiRun, Prisma } from "@prisma/client"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { PrismaService } from "../prisma/prisma.service"
import { ListingAiService } from "./listing-ai.service"
import * as images from "./listing-score-images"
import { ListingScoreService } from "./listing-score.service"

function createLegacyReport() {
  const limits = [[12, 10, 8, 6, 2, 2], [7, 7, 5, 4, 2], [10, 6, 4], [7, 5, 3]]
  const report = {
    mode: "standard", total: 100, suggestions: ["精简过长标题"], potential: "S级 · 可直接上线",
    dimensions: limits.map((scores, index) => ({
      name: ["CDQ健康度", "关键词覆盖", "COSMO关系覆盖", "Alexa语义质量"][index],
      maxScore: [40, 25, 20, 15][index], score: [40, 25, 20, 15][index],
      criteria: scores.map(maxScore => ({
        name: "评分项", maxScore, score: maxScore, description: "已核验原始资料",
        deductions: [] as Array<{ points: number; reason: string }>,
      })),
    })),
  }
  // 原始模型漏减标题的5分；按用户交付策略保留原始评分，仅记录诊断。
  report.dimensions[0].criteria[1].deductions = [{ points: 5, reason: "标题过长" }]
  return report
}

function createServiceFixture(outputs: string[]) {
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
      row = {
        ...data, id: 1, status: "RUNNING", outputText: null, billing: null, requestId: null,
        usageLogId: null, error: null, createdAt: new Date(), updatedAt: new Date(),
      }
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
  const streamChat = jest.fn(async function* (_systemPrompt: string, _userPrompt: string) {
    const index = attempt++
    yield { type: "text", content: outputs[index] ?? "unexpected model request" }
    yield { type: "billing", billing: {
      model: "ZQ-Think-Flash", costCny: index === 0 ? "0.13" : "0.03", currency: "CNY",
      requestId: `legacy-progress-${index}`, requestIds: [`legacy-progress-${index}`],
    } }
  })
  const chargeSavedOutput = jest.fn().mockResolvedValue(null)
  const tx = { businessAiRun: table, usageLog: { findUnique: jest.fn().mockResolvedValue({ id: 9 }) } }
  const prisma = {
    ...tx,
    $transaction: jest.fn(async callback => {
      const previousRow = structuredClone(row)
      try { return await callback(tx) } catch (error) { row = previousRow; throw error }
    }),
  }
  const service = new ListingScoreService(prisma as unknown as PrismaService,
    { streamChat } as unknown as AiGatewayProvider, { chargeSavedOutput, assertAffordable: jest.fn().mockResolvedValue(undefined) } as unknown as ListingAiService)
  return { service, streamChat, chargeSavedOutput, row: () => row! }
}

describe("旧版可展示评分同样不受语义校验阻断", () => {
  beforeEach(() => {
    jest.spyOn(images, "prepareListingScoreImages").mockResolvedValue(undefined)
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())

  it("携带sourceFacts的旧版算术差异保留原始报告，同号重放不重复调用或扣费", async () => {
    const report = createLegacyReport()
    const raw = JSON.stringify(report)
    const fixture = createServiceFixture([raw])
    const sourceFacts = { title: "Ink refill bottles", itemHighlights: "", bullets: ["Includes five bottles"], description: "For home office printing.", searchTerms: "ink refill" }
    const dto = {
      operation: "score" as const, model: "ZQ-Think-Flash" as const, scoreMarket: "amazon_us",
      scoreRequestId: "03bb3134-8bb7-4251-9e0e-de5fc3eac3c6",
      userPrompt: `mode：standard\n<listing-scoring-source>${JSON.stringify(sourceFacts)}</listing-scoring-source>`,
    }
    const result = await fixture.service.complete(3, dto)
    const scored = JSON.parse(result.text)
    expect(scored.scoreVersion).toBeUndefined()
    expect(scored.dimensions).toEqual(report.dimensions)
    expect(scored.total).toBe(100)
    expect(scored.potential).toBe(report.potential)
    expect(scored.validationStatus).toBe("BEST_EFFORT")
    expect(scored).not.toHaveProperty("validationWarnings")
    expect(fixture.row()).toMatchObject({ status: "COMPLETED", outputText: raw, error: null })
    expect(fixture.row().billing).toMatchObject({ sourceFacts })
    expect(fixture.row().billing).not.toHaveProperty("repairs")
    expect(fixture.streamChat).toHaveBeenCalledTimes(1)
    expect(fixture.chargeSavedOutput).toHaveBeenCalledTimes(1)
    expect(fixture.chargeSavedOutput.mock.calls[0][2].requestId).toBe("legacy-progress-0")
    expect(await fixture.service.complete(3, dto)).toEqual(result)
    expect(fixture.streamChat).toHaveBeenCalledTimes(1)
    expect(fixture.chargeSavedOutput).toHaveBeenCalledTimes(1)
  })
})
