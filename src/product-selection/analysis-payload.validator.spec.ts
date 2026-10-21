import { BadRequestException, PayloadTooLargeException } from "@nestjs/common"
import { validateProductPayload, validateStepPayload } from "./analysis-payload.validator"

describe("validateStepPayload", () => {
  it("validates every step's required top-level fields", () => {
    expect(validateStepPayload(1, { diagnosis: [] }).pickCount).toBe(0)
    expect(
      validateStepPayload(2, { oppResults: [], selectedKeywords: ["cup holder"] }).pickCount
    ).toBe(0)
    expect(
      validateStepPayload(3, {
        compResults: [],
        selectedAsinsByKeyword: { "cup holder": ["B0GWK1HFXP"] },
      }).pickCount
    ).toBe(0)
    expect(validateStepPayload(4, { anaResult: { score: 1 } }).pickCount).toBe(0)
    expect(
      validateStepPayload(5, { reportData: { items: [{ asin: "B0GWK1HFXP" }] } }, 1).pickCount
    ).toBe(1)
  })

  it("rejects a mismatched fifth-step count", () => {
    expect(() => validateStepPayload(5, { reportData: { items: [{}, {}] } }, 1)).toThrow(
      BadRequestException
    )
  })

  it("rejects duplicate selected keywords", () => {
    expect(() =>
      validateStepPayload(2, {
        oppResults: [],
        selectedKeywords: ["Cup Holder", "cup holder"],
      })
    ).toThrow(BadRequestException)
  })

  it("rejects oversized payloads", () => {
    expect(() =>
      validateStepPayload(1, { diagnosis: [], padding: "x".repeat(4 * 1024 * 1024) })
    ).toThrow(PayloadTooLargeException)
  })

  it("validates a complete single-step product result", () => {
    expect(
      validateProductPayload({
        pdfUrl: "https://example.com/product-validation.pdf",
        productData: { asin: "B0GWK1HFXP" },
      })
    ).toEqual(expect.objectContaining({ pickCount: 1 }))
  })

  it("rejects an incomplete single-step product result", () => {
    expect(() =>
      validateProductPayload({ pdfUrl: "https://example.com/product-validation.pdf" })
    ).toThrow(BadRequestException)
    expect(() =>
      validateProductPayload({ pdfUrl: "javascript:alert(1)", productData: { asin: "x" } })
    ).toThrow(BadRequestException)
  })
})
