import { BadRequestException, PayloadTooLargeException } from "@nestjs/common"
import { createCompetitorAnalysisDto as createDto } from "./competitor-analysis-record.fixture"
import { validateAndNormalizeCompetitorAnalysisRecord } from "./competitor-analysis-record.validator"
import { COMPETITOR_ANALYSIS_MAX_BYTES } from "./competitor-analysis.constants"

describe("validateAndNormalizeCompetitorAnalysisRecord", () => {
  it("normalizes ASINs and preserves arbitrary product and step JSON", () => {
    const dto = createDto()
    dto.marketplace = " us "
    dto.input.ownAsin = " b0aaaa0001 "
    dto.input.competitorAsins = [" b0bbbb0002 ", "b0cccc0003"]
    dto.products[0].productData = {
      title: "前端产品标题",
      customFutureField: { score: 9.8, tags: ["a", "b"] },
    }
    dto.products[0].steps.push({
      stepCode: "FUTURE_STEP_FROM_FRONTEND",
      stepNo: 99,
      schemaVersion: 1,
      resultData: { anyShape: { accepted: true } },
    })

    const result = validateAndNormalizeCompetitorAnalysisRecord(dto)

    expect(result.marketplace).toBe("US")
    expect(result.input.ownAsin).toBe("B0AAAA0001")
    expect(result.input.competitorAsins).toEqual(["B0BBBB0002", "B0CCCC0003"])
    expect(result.products[0].productData).toEqual(dto.products[0].productData)
    expect(result.products[0].steps).toHaveLength(2)
    expect(result.products[0].steps[1]).toMatchObject({
      stepCode: "FUTURE_STEP_FROM_FRONTEND",
      stepNo: 99,
      resultData: { anyShape: { accepted: true } },
    })
    expect(result.title).toBe("我方 B0AAAA0001 vs 2 个竞品")
  })

  it("accepts products with an empty steps array", () => {
    const dto = createDto()
    dto.products[0].steps = []

    expect(validateAndNormalizeCompetitorAnalysisRecord(dto).products[0].steps).toEqual([])
  })

  it("requires a keyword only in KEYWORD mode", () => {
    const keywordDto = createDto()
    keywordDto.input.mode = " keyword "
    keywordDto.input.ownAsin = null
    keywordDto.input.keyword = " portable blender "

    const result = validateAndNormalizeCompetitorAnalysisRecord(keywordDto)
    expect(result.input).toMatchObject({ mode: "KEYWORD", keyword: "portable blender" })

    keywordDto.input.keyword = null
    expect(() => validateAndNormalizeCompetitorAnalysisRecord(keywordDto)).toThrow(
      BadRequestException
    )
  })

  it("rejects duplicate products and duplicate frontend step codes", () => {
    const duplicateProductDto = createDto()
    duplicateProductDto.products.push({
      ...duplicateProductDto.products[0],
      sortOrder: 1,
      steps: [],
    })
    expect(() => validateAndNormalizeCompetitorAnalysisRecord(duplicateProductDto)).toThrow(
      BadRequestException
    )

    const duplicateStepDto = createDto()
    duplicateStepDto.products[0].steps.push({
      stepCode: "profile",
      stepNo: 2,
      schemaVersion: 1,
      resultData: {},
    })
    expect(() => validateAndNormalizeCompetitorAnalysisRecord(duplicateStepDto)).toThrow(
      BadRequestException
    )
  })

  it("rejects JSON strings, data URLs and DOM snapshots", () => {
    const jsonStringDto = createDto()
    jsonStringDto.products[0].steps[0].resultData = '{"score": 1}' as unknown as Record<
      string,
      unknown
    >
    expect(() => validateAndNormalizeCompetitorAnalysisRecord(jsonStringDto)).toThrow(
      BadRequestException
    )

    const dataUrlDto = createDto()
    dataUrlDto.reportData = { image: "data:image/png;base64,AAAA" }
    expect(() => validateAndNormalizeCompetitorAnalysisRecord(dataUrlDto)).toThrow(
      BadRequestException
    )

    const domDto = createDto()
    domDto.analysisResult = { documentHtml: "<html></html>" }
    expect(() => validateAndNormalizeCompetitorAnalysisRecord(domDto)).toThrow(BadRequestException)
  })

  it("rejects payloads above the normalized 4 MiB limit", () => {
    const dto = createDto()
    dto.reportData = { text: "x".repeat(COMPETITOR_ANALYSIS_MAX_BYTES) }

    expect(() => validateAndNormalizeCompetitorAnalysisRecord(dto)).toThrow(
      PayloadTooLargeException
    )
  })
})
