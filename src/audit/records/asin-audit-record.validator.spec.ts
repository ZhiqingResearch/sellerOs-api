import { BadRequestException, PayloadTooLargeException } from "@nestjs/common"
import {
  validateCreateAsinAuditPayload,
  validateOptimizationPayload,
} from "./asin-audit-record.validator"
import { CreateAsinAuditRecordDto } from "./dto/create-asin-audit-record.dto"
import { UpdateAsinAuditRecordDto } from "./dto/update-asin-audit-record.dto"

describe("ASIN audit record payload validator", () => {
  it("accepts a complete score snapshot without ad data", () => {
    const result = validateCreateAsinAuditPayload(createDto())

    expect(result.score).toEqual({
      overallScore: 76,
      grade: "B+",
      contentScore: 80,
      trafficScore: 72,
      adScore: null,
    })
    expect(result.snapshotPayloadBytes).toBeGreaterThan(0)
  })

  it("requires all six evidence cards and meta", () => {
    const dto = createDto()
    delete dto.evidence.P

    expect(() => validateCreateAsinAuditPayload(dto)).toThrow(BadRequestException)
  })

  it("rejects adScore=0 when ad data is not included", () => {
    const dto = createDto()
    dto.scoreResult.adScore = 0

    expect(() => validateCreateAsinAuditPayload(dto)).toThrow(BadRequestException)
  })

  it("requires exactly ten dimensions with criteria", () => {
    const dto = createDto()
    dto.scoreResult.dimensions = [{ criteria: [{}] }]

    expect(() => validateCreateAsinAuditPayload(dto)).toThrow(BadRequestException)
  })

  it("accepts v2 ten-board scoreResult without ad data (score 接口现行形状原样归档)", () => {
    const dto = createDto()
    dto.scoreResult = {
      total: 76,
      grade: "GOOD",
      gradeLabel: "良好",
      domainScores: { content: 80, operations: 72 },
      overallScore: 76,
      contentScore: 80,
      trafficScore: 72,
      boards: Array.from({ length: 10 }, (_, index) => ({
        id: String.fromCharCode(65 + index),
        items: [{ id: `${String.fromCharCode(65 + index)}1` }],
      })),
      scoring: { convertedScore: 76 },
    }

    const result = validateCreateAsinAuditPayload(dto)
    expect(result.score).toEqual({
      overallScore: 76,
      grade: "良好",
      contentScore: 80,
      trafficScore: 72,
      adScore: null,
    })
  })

  it("v2 with ads: adScore 缺失时从 adDiagnostics 兜底提取；提不出则拒绝", () => {
    const dto = createDto()
    dto.adIncluded = true
    dto.scoreResult = v2ScoreResult({ adDiagnostics: { score: 62 } })

    const result = validateCreateAsinAuditPayload(dto)
    expect(result.score.adScore).toBe(62)

    const weighted = createDto()
    weighted.adIncluded = true
    weighted.scoreResult = v2ScoreResult({
      adScore: undefined,
      adDiagnostics: {
        dimensions: [
          { weight: 24, score: 55 },
          { weight: 22, score: 48 },
          { weight: 20, score: 78 },
          { weight: 18, score: 70 },
          { weight: 16, score: 65 },
        ],
      },
    })
    expect(validateCreateAsinAuditPayload(weighted).score.adScore).toBe(62.36)

    const invalid = createDto()
    invalid.adIncluded = true
    invalid.scoreResult = v2ScoreResult({ adDiagnostics: { findings: ["无分数"] } })
    expect(() => validateCreateAsinAuditPayload(invalid)).toThrow(BadRequestException)
  })

  it("v2 摘要分缺失时从 total/domainScores 兜底；未含广告时 adScore 必须为空", () => {
    const dto = createDto()
    dto.scoreResult = v2ScoreResult()
    delete dto.scoreResult.overallScore
    delete dto.scoreResult.contentScore
    delete dto.scoreResult.trafficScore

    const result = validateCreateAsinAuditPayload(dto)
    expect(result.score.overallScore).toBe(76)
    expect(result.score.contentScore).toBe(80)
    expect(result.score.trafficScore).toBe(72)

    const withAdScore = createDto()
    withAdScore.scoreResult = v2ScoreResult({ adScore: 60 })
    expect(() => validateCreateAsinAuditPayload(withAdScore)).toThrow(BadRequestException)
  })

  it("v2 boards 数量/结构不合法则拒绝", () => {
    const short = createDto()
    short.scoreResult = v2ScoreResult({ boards: v2Boards().slice(0, 9) })
    expect(() => validateCreateAsinAuditPayload(short)).toThrow(BadRequestException)

    const emptyItems = createDto()
    const boards = v2Boards()
    boards[0].items = []
    emptyItems.scoreResult = v2ScoreResult({ boards })
    expect(() => validateCreateAsinAuditPayload(emptyItems)).toThrow(BadRequestException)
  })

  it("rejects blob images and DOM snapshot fields", () => {
    const blobDto = createDto()
    blobDto.evidence.A = { aplusImages: ["blob:https://example.com/image"] }
    expect(() => validateCreateAsinAuditPayload(blobDto)).toThrow(BadRequestException)

    const domDto = createDto()
    domDto.evidence.B = { outerHtml: "<body />" }
    expect(() => validateCreateAsinAuditPayload(domDto)).toThrow(BadRequestException)
  })

  it("rejects create payloads over four MiB", () => {
    const dto = createDto()
    dto.evidence.B = { text: "x".repeat(4 * 1024 * 1024) }

    expect(() => validateCreateAsinAuditPayload(dto)).toThrow(PayloadTooLargeException)
  })

  it("validates optimization payloads and rejects empty objects", () => {
    expect(
      validateOptimizationPayload({
        expectedVersion: 1,
        schemaVersion: 1,
        optimizationResult: { listing: { title: "new title" } },
      } as UpdateAsinAuditRecordDto)
    ).toEqual({ payloadBytes: 33 })

    expect(() =>
      validateOptimizationPayload({
        expectedVersion: 1,
        schemaVersion: 1,
        optimizationResult: {},
      } as UpdateAsinAuditRecordDto)
    ).toThrow(BadRequestException)
  })
})

function createDto(): CreateAsinAuditRecordDto {
  return {
    clientRequestId: "23fd58d7-3810-4a16-8a39-61520e134994",
    schemaVersion: 1,
    asin: "B0C9L8ZR6Q",
    marketplace: "US",
    country: "US",
    category: {
      nodeId: "172282",
      name: "Electronics",
      path: "Electronics:Wearable Technology:Smart Glasses",
    },
    productTitle: "Example Smart Glasses",
    adIncluded: false,
    evidence: {
      A: { aplusImages: ["https://example.com/a-plus.jpg"] },
      P: {},
      B: {},
      C: {},
      D: {},
      E: {},
      meta: {},
    },
    scoreResult: {
      overallScore: 76,
      grade: "B+",
      contentScore: 80,
      trafficScore: 72,
      adScore: null,
      dimensions: Array.from({ length: 10 }, (_, index) => ({
        code: `D${index + 1}`,
        criteria: [{}],
      })),
      problemTypes: {},
      recommendations: [],
    },
  }
}

/** v2 boards：恰好 10 个板块、每板块 items 非空 */
function v2Boards(): { id: string; items: { id: string }[] }[] {
  return Array.from({ length: 10 }, (_, index) => ({
    id: String.fromCharCode(65 + index),
    items: [{ id: `${String.fromCharCode(65 + index)}1` }],
  }))
}

/** v2.0 十板块打分结果（score 接口现行输出形状），over 可覆盖顶层字段 */
function v2ScoreResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total: 76,
    grade: "GOOD",
    gradeLabel: "良好",
    domainScores: { content: 80, operations: 72 },
    overallScore: 76,
    contentScore: 80,
    trafficScore: 72,
    boards: v2Boards(),
    scoring: { convertedScore: 76 },
    ...over,
  }
}
