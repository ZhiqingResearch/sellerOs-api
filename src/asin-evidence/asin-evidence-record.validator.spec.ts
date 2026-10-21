import { BadRequestException, PayloadTooLargeException } from "@nestjs/common"
import { ASIN_EVIDENCE_MAX_BYTES } from "./asin-evidence-record.constants"
import { validateAsinEvidencePayload } from "./asin-evidence-record.validator"
import { CreateAsinEvidenceRecordDto } from "./dto/create-asin-evidence-record.dto"

describe("validateAsinEvidencePayload", () => {
  it("accepts a six-card payload and extracts the product title from card A", () => {
    const dto = createDto()

    const result = validateAsinEvidencePayload(dto)

    expect(result.productTitle).toBe("Example Smart Glasses")
    expect(result.evidenceBytes).toBeGreaterThan(0)
  })

  it("rejects payloads with a missing or non-object card", () => {
    const dto = createDto()
    delete (dto.evidence as Record<string, unknown>).B

    expect(() => validateAsinEvidencePayload(dto)).toThrow(BadRequestException)

    const dto2 = createDto()
    ;(dto2.evidence as Record<string, unknown>).meta = "oops"
    expect(() => validateAsinEvidencePayload(dto2)).toThrow(BadRequestException)
  })

  it("rejects blob or base64 image strings and DOM snapshot keys", () => {
    const blobDto = createDto()
    ;(blobDto.evidence as Record<string, unknown>).meta = { note: "data:image/png;base64,xxxx" }
    expect(() => validateAsinEvidencePayload(blobDto)).toThrow(/blob: 或 Base64/)

    const domDto = createDto()
    ;(domDto.evidence as Record<string, unknown>).pageHtml = "<html></html>"
    expect(() => validateAsinEvidencePayload(domDto)).toThrow(/DOM HTML 快照/)
  })

  it("rejects oversized payloads", () => {
    const dto = createDto()
    ;(dto.evidence as Record<string, unknown>).meta = { pad: "x".repeat(ASIN_EVIDENCE_MAX_BYTES) }

    expect(() => validateAsinEvidencePayload(dto)).toThrow(PayloadTooLargeException)
  })

  it("prefers the client productTitle and falls back to null when card A has no title", () => {
    const explicit = createDto()
    explicit.productTitle = "自定义标题"
    expect(validateAsinEvidencePayload(explicit).productTitle).toBe("自定义标题")

    const noTitle = createDto()
    ;(noTitle.evidence as Record<string, unknown>).A = { filled: false }
    expect(validateAsinEvidencePayload(noTitle).productTitle).toBeNull()
  })
})

function createDto(): CreateAsinEvidenceRecordDto {
  return {
    clientRequestId: "23fd58d7-3810-4a16-8a39-61520e134994",
    asin: "B0GQB1C381",
    country: "US",
    model: "ZQ-Think-Flash",
    evidence: {
      A: { filled: true, title: "Example Smart Glasses" },
      P: {},
      B: {},
      C: {},
      D: {},
      E: {},
      meta: {},
    },
  }
}
