import type { AuditEvidence } from "../types/audit.types"
import { formatListingA } from "./asin-audit-prompt-format"

function listingA(A: Partial<AuditEvidence["A"]>): AuditEvidence["A"] {
  return { filled: true, ...A } as AuditEvidence["A"]
}

describe("formatListingA 副标题输出", () => {
  it("secondTitle 有值时输出副标题行（爬虫 title 常截断，卖点多在 second_title）", () => {
    const sub = "Long Sleeve Button Down, Breasted Notch Lapel, Open Front Suit Jacket"
    const text = formatListingA(listingA({ title: "Short Title", secondTitle: sub }))

    expect(text).toContain(`副标题（second_title，${sub.length} 字符）：${sub}`)
  })

  it("secondTitle 为 null/空时不输出副标题行", () => {
    expect(formatListingA(listingA({ title: "T", secondTitle: null }))).not.toContain("副标题")
    expect(formatListingA(listingA({ title: "T", secondTitle: "" }))).not.toContain("副标题")
  })
})
