import { BadRequestException } from "@nestjs/common"
import { createSmartPricingDto as createDto } from "./smart-pricing-record.fixture"
import { validateAndNormalizeSmartPricingRecord } from "./smart-pricing-record.validator"

describe("SmartPricingRecordValidator", () => {
  it("normalizes URLs, ASINs, colors and text before persistence", () => {
    const dto = createDto()
    dto.product.sourceText = " https://example.com/item/1?campaign=abc#detail "
    dto.product.sourceUrl = "https://user:secret@example.com/item/1?session=secret#detail"
    dto.competitorContext!.competitors[0].asin = "b0aaaa0001"
    dto.result.verdict.c = "#34C759"

    const result = validateAndNormalizeSmartPricingRecord(dto)

    expect(result.product.sourceText).toBe("https://example.com/item/1")
    expect(result.product.sourceUrl).toBe("https://example.com/item/1")
    expect(result.competitorContext?.competitors[0].asin).toBe("B0AAAA0001")
    expect(result.result.verdict.c).toBe("#34c759")
    expect(result.payloadBytes).toBeGreaterThan(0)
  })

  it("accepts a missing competitor context and negative profit outputs", () => {
    const dto = createDto()
    dto.competitorContext = null
    dto.result.recNet = -2.5
    dto.result.recMargin = -8.25

    const result = validateAndNormalizeSmartPricingRecord(dto)

    expect(result.competitorContext).toBeNull()
    expect(result.result.recNet).toBe(-2.5)
    expect(result.result.recMargin).toBe(-8.25)
  })

  it("requires marketplace code and display name to match", () => {
    const dto = createDto()
    dto.marketplaceName = "Walmart US"

    expectBusinessError(() => validateAndNormalizeSmartPricingRecord(dto), {
      code: "INVALID_SMART_PRICING_RECORD",
      message: "marketplaceCode 与 marketplaceName 不匹配",
    })
  })

  it("accepts marketplace-local currencies and normalizes them to upper case", () => {
    const dto = createDto()
    dto.currency = " mxn "

    const result = validateAndNormalizeSmartPricingRecord(dto)

    expect(result.currency).toBe("MXN")
  })

  it("rejects currencies outside the supported whitelist", () => {
    const dto = createDto()
    dto.currency = "CNY"

    expectBusinessError(() => validateAndNormalizeSmartPricingRecord(dto), {
      code: "INVALID_SMART_PRICING_RECORD",
      message: "不支持的 currency: CNY，可选 USD/MXN/GBP/EUR",
    })
  })

  it("requires duplicated result inputs to equal the confirmed input", () => {
    const dto = createDto()
    dto.result.acosR = 0.25

    expectBusinessError(() => validateAndNormalizeSmartPricingRecord(dto), {
      code: "INVALID_SMART_PRICING_RECORD",
      message: "result.acosR 必须与 input.acosR 一致",
    })
  })

  it("requires four waterfall items when vatR is zero", () => {
    const dto = createDto()
    dto.result.waterfall.push(["站点税 VAT", 1, "#8e8e93"])

    expectBusinessError(() => validateAndNormalizeSmartPricingRecord(dto), {
      code: "INVALID_SMART_PRICING_RECORD",
      message: "result.waterfall 在 vatR=0 时必须包含 4 项",
    })
  })

  it("requires and accepts five waterfall items when vatR is positive", () => {
    const dto = createDto()
    dto.input.vatR = 0.2
    dto.result.vatR = 0.2
    dto.result.waterfall.push(["站点税 VAT", 9.198, "#8e8e93"])

    const result = validateAndNormalizeSmartPricingRecord(dto)

    expect(result.result.waterfall).toHaveLength(5)
  })

  it("rejects malformed stages and unsafe filenames", () => {
    const malformed = createDto()
    malformed.result.stages = malformed.result.stages.slice(0, 3)
    expect(() => validateAndNormalizeSmartPricingRecord(malformed)).toThrow(BadRequestException)

    const unsafeFilename = createDto()
    unsafeFilename.product.filenames = ["C:\\Users\\me\\quote.pdf"]
    expectBusinessError(() => validateAndNormalizeSmartPricingRecord(unsafeFilename), {
      code: "INVALID_SMART_PRICING_RECORD",
    })
  })

  it("rejects invalid HEX colors and score ranges", () => {
    const invalidColor = createDto()
    invalidColor.result.verdict.c = "red"
    expect(() => validateAndNormalizeSmartPricingRecord(invalidColor)).toThrow(BadRequestException)

    const invalidScore = createDto()
    invalidScore.result.composite = 101
    expect(() => validateAndNormalizeSmartPricingRecord(invalidScore)).toThrow(BadRequestException)
  })
})

function expectBusinessError(action: () => unknown, expected: { code: string; message?: string }) {
  try {
    action()
    throw new Error("Expected action to throw")
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException)
    expect((error as BadRequestException).getResponse()).toMatchObject(expected)
  }
}
