import type { DeEvidenceResult } from "../types/audit.types"
import { collectMissingEvidence, normalizeAuditEvidence } from "./normalize-evidence"
import { parseListingPaste, parseListingPasteLoose } from "./parse-listing"

/** 证据归一化（等价迁移 Web lib/asin-audit/normalize-evidence.ts）：ABPC 优先 / pastedContent 兜底 / 缺失卡收集。 */
describe("normalizeAuditEvidence", () => {
  const de = (over: Partial<DeEvidenceResult> = {}): DeEvidenceResult => ({
    asin: "B0XXXX",
    country: "US",
    C: { filled: false, missingReason: "一期未接入 SIF 竞品词卡" },
    D: { filled: true, kwTop: [], kwDetail: [] },
    E: {
      filled: true,
      asin: "B0XXXX",
      boughtInPastMonth: null,
      priceBsr: { buyboxPrice: null, bsr: null, bsrTrend: null, coupon: null, listedDate: null },
      sales: null,
      traffic: null,
      ad: null,
      profit: null,
      inventory: null,
    },
    meta: {
      sources: { D: ["sif"], E: ["sif"] },
      sifDataReady: true,
      sifWarnings: [],
      fetchedAt: "2026-09-07T00:00:00Z",
      estimatedPoints: 5,
    },
    ...over,
  })

  it("abpc.A filled 优先于 pastedContent；来源标 erp", () => {
    const evidence = normalizeAuditEvidence(de(), "amazon_us", "标题：粘贴标题\n描述：粘贴描述", {
      A: { filled: true, title: "ABPC 标题" },
    })
    expect(evidence.A.title).toBe("ABPC 标题")
    expect(evidence.meta.sources.A).toEqual(["erp"])
  })

  it("六卡 Apify 来源经评分归一化保留，未知 A+ 不变成 false", () => {
    const input = {
      ...de(),
      A: { filled: true, title: "备用商品", hasAplus: null },
      P: { filled: true, groups: [{ name: "参数", fields: [{ k: "重量", v: "1kg" }] }] },
      B: { filled: true, rating: 4.5, reviewCount: 0 },
      meta: {
        ...de().meta,
        sources: { ...de().meta.sources, A: ["apify"], P: ["apify"], B: ["apify"] },
      },
    }
    const result = normalizeAuditEvidence(input as DeEvidenceResult, "amazon_us")
    expect(result.meta.sources).toMatchObject({ A: ["apify"], P: ["apify"], B: ["apify"] })
    expect(result.A.hasAplus).toBeNull()
    expect(result.B.reviewSamples).toBeUndefined()
    expect(
      normalizeAuditEvidence(input as DeEvidenceResult, "amazon_us", undefined, {
        A: { filled: true, title: "人工覆盖" },
      }).meta.sources.A
    ).toEqual(["erp"])
  })

  it("pastedContent 结构化解析出 Listing；来源标 paste；searchTerms 切词", () => {
    const paste =
      "标题：便携榨汁机\n卖点：\n1. 无线充电\n- 大容量\n描述：适合户外\n后台搜索词：juicer, portable"
    const evidence = normalizeAuditEvidence(de(), "amazon_us", paste)
    expect(evidence.A.filled).toBe(true)
    expect(evidence.A.title).toBe("便携榨汁机")
    expect(evidence.A.bullets).toEqual(["无线充电", "大容量"])
    expect(evidence.A.description).toBe("适合户外")
    expect(evidence.A.searchTerms).toEqual(["juicer", "portable"])
    expect(evidence.meta.sources.A).toEqual(["paste"])
  })

  it("无 ABPC 无粘贴：A 卡 filled=false 且无 missingReason；P/B/C 卡带一期未接入原因", () => {
    const evidence = normalizeAuditEvidence(de(), "amazon_us")
    expect(evidence.A).toEqual({ filled: false })
    expect(evidence.P).toEqual({
      filled: false,
      missingReason: "一期未接入 Product Information 抓取",
    })
    expect(evidence.B).toEqual({ filled: false, missingReason: "一期未接入评论痛点服务" })
    expect(evidence.C).toEqual({ filled: false, missingReason: "一期未接入 SIF 竞品词卡" })
  })

  it("E 卡有 adCleaning 时来源标 sif+upload；D/E 卡与 meta 透传", () => {
    const evidence = normalizeAuditEvidence(
      de({ E: { ...de().E, adCleaning: { confirmedAt: "2026-09-07" } as never } }),
      "amazon_us"
    )
    expect(evidence.meta.sources.E).toEqual(["sif", "upload"])
    expect(evidence.D).toEqual(de().D)
    expect(evidence.meta.fetchedAt).toBe("2026-09-07T00:00:00Z")
  })

  it("collectMissingEvidence 收集全部缺失卡（机器 key）", () => {
    const evidence = normalizeAuditEvidence(
      de({ D: { filled: false, kwTop: [], kwDetail: [] }, E: { ...de().E, filled: false } }),
      "amazon_us"
    )
    expect(collectMissingEvidence(evidence)).toEqual([
      "A.listing",
      "P.params",
      "B.reviews",
      "C.competitors",
      "D.traffic",
      "E.performance",
    ])
  })
})

describe("parseListingPaste", () => {
  it("结构化解析：标题/卖点/描述/搜索词分段；bullet 前缀剥离", () => {
    const parsed = parseListingPaste(
      "标题：测试商品\n五点描述：\n1. 卖点一\n• 卖点二\n产品描述：描述文本\n搜索词：a b c"
    )
    expect(parsed).toEqual({
      title: "测试商品",
      bullets: ["卖点一", "卖点二"],
      description: "描述文本",
      searchTerms: "a b c",
    })
  })

  it("识别段数 <2 返回 null（无法结构化）", () => {
    expect(parseListingPaste("只有标题：xxx")).toBeNull()
  })

  it("parseListingPasteLoose 兜底：首行作标题，其余作描述", () => {
    const parsed = parseListingPasteLoose("首行标题\n第二行内容\n第三行内容")
    expect(parsed).toEqual({
      title: "首行标题",
      bullets: [],
      description: "第二行内容\n第三行内容",
      searchTerms: "",
    })
  })
})
