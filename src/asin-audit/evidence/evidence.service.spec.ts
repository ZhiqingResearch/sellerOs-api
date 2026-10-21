import { BadRequestException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { AuditService } from "../../audit/audit.service"
import { AsinAuditBilling } from "../asin-audit.billing"
import { EvidenceRequestDto } from "../dto/evidence.dto"
import { ReviewAnalysisService } from "../review-analysis.service"
import { ReviewPainPointsService } from "../review-pain-points.service"
import type { ReviewEvidence } from "../types/audit.types"
import type { KeywordTrafficEvidence } from "../types/de.types"
import { EvidenceService, EvidenceSseEvent } from "./evidence.service"
import { SellerSpriteMcpClient } from "./mcp.client"
import { SifApiError, SifClient } from "./sif.client"

/** 合成取证编排：参数解析 / 六卡事件序列 / 降级矩阵 / B 卡痛点并入 + module 双输出分流。 */
describe("EvidenceService", () => {
  let service: EvidenceService
  let sif: {
    getLastDataTime: jest.Mock
    asinKeywordsMonthly: jest.Mock
    batchKeywordOverview: jest.Mock
    variantLastSales: jest.Mock
    batchAsinPrice: jest.Mock
    batchAsinDetail: jest.Mock
    asinOpTrafficTrend: jest.Mock
  }
  let mcp: { callAsinCompetitor: jest.Mock }
  let audit: { findDetail: jest.Mock }
  let painPoints: { run: jest.Mock }
  let reviewAnalysis: { run: jest.Mock }
  let billing: { assertFixedStageAffordable: jest.Mock; chargeFixedStage: jest.Mock }

  const dto = (over: Partial<EvidenceRequestDto> = {}): EvidenceRequestDto => ({
    asin: "B012345678",
    model: "ZQ-Think-Flash",
    ...over,
  })

  const auditRow = (data: Record<string, unknown> = {}) => ({
    id: 1,
    url: "https://www.amazon.com/dp/B012345678",
    urlHash: "h",
    platform: "amazon",
    country: "US",
    asin: "B012345678",
    name: "测试商品",
    data,
    fetchedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  const auditData = () => ({
    title: "测试商品标题",
    bullets: ["B1", "B2"],
    description: "描述",
    rating: 4.2,
    reviewCount: 128,
    review: { comment_list: [{ name: "A", comment: "太吵了" }, { comment: "材质差" }] },
  })

  const kwResp = () => ({
    list: [
      {
        asin: "B012345678",
        keyword: "kw1",
        totalScore: 100,
        naturalScore: 60,
        adScore: 40,
        searchVolume: 5000,
        searchRank: 300,
        keywordTags: ["isMainKw"],
        naturalPositionSeq: [{ page: 1, allPageRank: 5 }],
        spPositionSeq: [],
        conversionShared: 3,
      },
      {
        asin: "B012345678",
        keyword: "kw2",
        totalScore: 50,
        naturalScore: 10,
        adScore: 40,
        searchVolume: 2000,
        searchRank: 900,
        keywordTags: ["品类"],
        naturalPositionSeq: [],
        spPositionSeq: [{ page: 1, allPageRank: 3 }],
        conversionShared: 1,
      },
    ],
  })

  const collect = async (d = dto()): Promise<{ events: EvidenceSseEvent[]; error?: unknown }> => {
    const events: EvidenceSseEvent[] = []
    try {
      await service.run(d, service.resolve(d), 7, ev => events.push(ev))
      return { events }
    } catch (e) {
      return { events, error: e }
    }
  }

  beforeEach(async () => {
    sif = {
      getLastDataTime: jest.fn().mockResolvedValue({ list: [] }),
      asinKeywordsMonthly: jest.fn().mockResolvedValue(kwResp()),
      batchKeywordOverview: jest.fn().mockResolvedValue([
        { keyword: "kw1", estSearchesNum: 5000 },
        { keyword: "kw2", estSearchesNum: 2000 },
      ]),
      variantLastSales: jest
        .fn()
        .mockResolvedValue([{ asin: "B012345678", boughtInPastMonth: 320 }]),
      batchAsinPrice: jest.fn().mockResolvedValue({
        list: [{ asin: "B012345678", currentPrice: 39.9, listedDate: "2026-01-01" }],
      }),
      batchAsinDetail: jest.fn().mockResolvedValue({
        list: [{ asin: "B012345678", title: "测试商品标题", brand: "测试品牌" }],
      }),
      asinOpTrafficTrend: jest
        .fn()
        .mockResolvedValue({ dates: [], bsr: [], buyboxPrice: [], couponInfo: [] }),
    }
    mcp = {
      callAsinCompetitor: jest.fn().mockResolvedValue({
        items: [
          { asin: "B0COMPET001", title: "同款竞品一号", brand: "X" },
          { asin: "B0COMPET002", title: "同款竞品二号" },
        ],
        parsed: null,
      }),
    }
    audit = { findDetail: jest.fn().mockResolvedValue(auditRow(auditData())) }
    painPoints = {
      run: jest.fn().mockResolvedValue({
        painPoints: [{ text: "太吵了", freq: 2 }],
        tokenUsage: null,
        billingHandled: true,
        requestId: "req-1",
      }),
    }
    reviewAnalysis = {
      run: jest.fn().mockResolvedValue({
        highlights: [{ text: "音质出色", freq: 1, quote: "太吵了" }],
        painPoints: [{ text: "太吵了", freq: 2, quote: "太吵了" }],
        tokenUsage: null,
        billingHandled: true,
        requestId: "req-2",
      }),
    }
    billing = {
      assertFixedStageAffordable: jest.fn().mockResolvedValue(false),
      chargeFixedStage: jest.fn().mockResolvedValue(false),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        EvidenceService,
        { provide: SifClient, useValue: sif },
        { provide: SellerSpriteMcpClient, useValue: mcp },
        { provide: AuditService, useValue: audit },
        { provide: AsinAuditBilling, useValue: billing },
        { provide: ReviewPainPointsService, useValue: painPoints },
        { provide: ReviewAnalysisService, useValue: reviewAnalysis },
      ],
    }).compile()
    service = moduleRef.get(EvidenceService)
  })

  // 评论原文抽样条数 1~10 随机——测试统一钉为「取满」（random=0.999 → 10 条），保持断言确定
  beforeEach(() => {
    jest.spyOn(Math, "random").mockReturnValue(0.999)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("resolve：asin 优先、URL 提取、都缺失 400、非法 ASIN 400", () => {
    expect(service.resolve(dto())).toEqual({ asin: "B012345678", country: "US", productUrl: null })
    expect(
      service.resolve(
        dto({ asin: undefined, productUrl: "https://www.amazon.com/dp/B0GQB1C381?x=1" })
      ).asin
    ).toBe("B0GQB1C381")
    expect(() =>
      service.resolve(dto({ asin: undefined, productUrl: "https://x.com/noasin" }))
    ).toThrow(BadRequestException)
    expect(() => service.resolve(dto({ asin: "SHORT" }))).toThrow("ASIN 格式无效")
    expect(() => service.resolve(dto({ asin: undefined }))).toThrow("需提供 asin 或 productUrl")
  })

  it("URL 推导站点，显式冲突不允许混合其他商品取证", () => {
    expect(
      service.resolve(dto({ asin: undefined, productUrl: "https://www.amazon.de/dp/B012345678" }))
    ).toMatchObject({ asin: "B012345678", country: "DE" })
    expect(() =>
      service.resolve(dto({ productUrl: "https://www.amazon.com/dp/B099999999" }))
    ).toThrow("ASIN 与商品地址不一致")
    expect(() =>
      service.resolve(dto({ country: "US", productUrl: "https://www.amazon.de/dp/B012345678" }))
    ).toThrow("所选站点与商品地址不一致")
    expect(() => service.resolve(dto({ productUrl: "https://evil.test/dp/B012345678" }))).toThrow(
      BadRequestException
    )
  })

  it.each(["audit", "evidence-module"] as const)(
    "Apify 部分成功 %s：来源/实际时间/缺正文，不调用 AI，不重复扣费",
    async scene => {
      const fetchedAt = new Date("2026-09-28T03:00:00.000Z")
      audit.findDetail.mockResolvedValue({
        ...auditRow({
          title: "备用商品",
          rating: 4.5,
          reviewCount: 0,
          product_information_hhl: { Details: [["Weight", "1kg"]] },
          _fetchMeta: { source: "apify" },
        }),
        fetchedAt,
      })
      const { events, error } = await collect(dto({ scene }))
      expect(error).toBeUndefined()
      const done = events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
      expect(done.result.meta.sources).toMatchObject({ A: ["apify"], P: ["apify"], B: ["apify"] })
      expect(done.checklist.listing).toMatchObject({
        source: "apify",
        fetchedAt: fetchedAt.toISOString(),
      })
      expect(done.checklist.reviews).toMatchObject({
        status: "fetched",
        source: "apify",
        hasReviewText: false,
        hasPainPoints: false,
      })
      expect(done.checklist.reviews.reviewTextMissingReason).toContain("未获取评论正文")
      expect(done.checklist.qa).toMatchObject({ status: "missing", source: "apify" })
      expect(done.result.meta.sifWarnings).toContain("本次使用备用数据源，部分内容可能未获取。")
      expect(done.result.B.reviewSamples).toBeUndefined()
      expect(painPoints.run).not.toHaveBeenCalled()
      expect(reviewAnalysis.run).not.toHaveBeenCalled()
      expect(billing.chargeFixedStage).toHaveBeenCalledTimes(scene === "evidence-module" ? 1 : 0)
    }
  )

  it("全链路：逐卡事件 + done 六卡 + sources + estimatedPoints", async () => {
    sif.asinOpTrafficTrend.mockResolvedValue({
      dates: Array.from({ length: 14 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`),
      bsr: [...Array.from({ length: 7 }, () => 100), 90, 100, 120, 150, 200, 250, 300],
      buyboxPrice: [],
      couponInfo: [],
    })
    // D 卡双推断言需按「emit 时刻」快照：服务原地 mutate D 后重推，直接收集引用会看到挂上 bsrTrend 的终态
    const events: EvidenceSseEvent[] = []
    const dWire: string[] = []
    const d = dto()
    await service.run(d, service.resolve(d), 7, ev => {
      events.push(ev)
      if (ev.type === "evidence" && ev.card === "D") dWire.push(JSON.stringify(ev.data))
    })
    const cards = events.filter(
      (e): e is Extract<EvidenceSseEvent, { type: "evidence" }> => e.type === "evidence"
    )
    expect(cards.map(c => c.card)).toEqual(["A", "P", "B", "D", "C", "D", "E", "B"]) // B/D 各推两次（基础→增强，覆盖渲染）

    // D 卡双推：第一推（同 SSE 线上序列化时刻）无 BSR 走势，第二推 trend 就绪后带 bsrTrend（series/series7）
    expect(dWire).toHaveLength(2)
    expect(dWire[0]).not.toContain("bsrTrend")
    const d2Bt = (JSON.parse(dWire[1]) as KeywordTrafficEvidence).trafficPrecompute?.bsrTrend
    expect(d2Bt).toBeDefined()
    expect(d2Bt).toMatchObject({ available: true, windowDays: 14, validDays: 14 })
    expect(d2Bt?.series7).toHaveLength(7)

    const done = events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(done.type).toBe("done")
    expect(done.result.asin).toBe("B012345678")
    expect(done.result.A.filled).toBe(true)
    expect(done.result.B.richPainPoints).toEqual([{ text: "太吵了", freq: 2 }])
    expect(done.result.C.filled).toBe(true) // MCP 竞品成功
    expect(done.result.D.filled).toBe(true)
    expect(done.result.D.trafficPrecompute?.bsrTrend?.series7).toHaveLength(7)
    // 页面 8 项清单：有标题 → listing fetched；无 QA/图/参数 → missing；有评论+痛点 → reviews fetched
    expect(done.checklist).toMatchObject({
      listing: { status: "fetched", source: "crawler" },
      qa: { status: "missing", missingReason: "商品详情未返回 Q&A" },
      aplus: { status: "missing" },
      images: { status: "missing" },
      params: { status: "missing" },
      reviews: { status: "fetched", source: "crawler", hasPainPoints: true },
      traffic: { status: "fetched", source: "sif" },
      ads: { status: "skipped" },
    })
    // P 卡无参数数据 → filled=false 不写 sources
    expect(done.result.meta.sources).toMatchObject({
      A: ["erp"],
      B: ["erp"],
      C: ["mcp"],
      D: ["sif"],
      E: ["sif"],
    })
    expect(done.result.P.filled).toBe(false)
    // 2 个关键词：kwMonthly(1) + overview min(2,10)=2 + asinDetail 参照(1) + sales(1) + price(2) + trend(1)
    expect(done.result.meta.estimatedPoints).toBe(8)
    expect(painPoints.run).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "ZQ-Think-Flash",
        commentList: [{ name: "A", comment: "太吵了" }, { comment: "材质差" }],
      }),
      7,
      // ZQ-Think-Flash 为固定价模型：内嵌按量扣费跳过（scene=audit 审计链免费）
      { skipUsageCharge: true }
    )
  })

  it("爬虫失败：warning + 空 A/P/B 卡，done 仍成功", async () => {
    audit.findDetail.mockRejectedValue(new Error("爬虫挂了"))
    const { events } = await collect()
    expect(
      events.some(
        e => e.type === "warning" && (e as { message: string }).message.includes("ABPC 取证")
      )
    ).toBe(true)
    const done = events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(done.result.A).toEqual({ filled: false })
    expect(done.result.P.filled).toBe(false)
    expect(done.result.B.filled).toBe(false)
    expect(painPoints.run).not.toHaveBeenCalled()
  })

  it("SIF 主请求失败：整体 error（SifApiError code 保留）", async () => {
    sif.asinKeywordsMonthly.mockRejectedValue(
      new SifApiError(-20, "SIF API 错误 -20：API 配额已用完")
    )
    const { events, error } = await collect()
    expect(error).toBeInstanceOf(SifApiError)
    expect(service.toErrorEvent(error)).toEqual({
      message: "SIF API 错误 -20：API 配额已用完",
      code: -20,
    })
    expect(events.some(e => e.type === "done")).toBe(false) // done 未发出
  })

  it("MCP 失败：warning + C 空卡（filled=false），其余卡不受影响", async () => {
    mcp.callAsinCompetitor.mockRejectedValue(new Error("MCP 挂了"))
    const { events } = await collect()
    expect(
      events.some(
        e => e.type === "warning" && (e as { message: string }).message.includes("竞品查询失败")
      )
    ).toBe(true)
    const done = events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(done.result.C.filled).toBe(false)
    expect(done.result.C.missingReason).toBe("MCP 挂了")
  })

  it("C 卡配件过滤：打印纸/支架候选剔除，真竞品保留 + 过滤 warning", async () => {
    mcp.callAsinCompetitor.mockResolvedValue({
      items: [
        {
          asin: "B0PAPER001",
          title: "HP Printer Paper | 8.5 x 11 Paper | 500 Sheets",
          nodeLabelPath: "Office Products:Paper",
        },
        { asin: "B0KEEP0002", title: "HP 15.6 Laptop 8GB RAM 256GB SSD" },
        { asin: "B0KEEP0003", title: "Acer Chromebook Plus 515 Laptop" },
      ],
      parsed: null,
    })
    sif.batchAsinDetail.mockResolvedValue({
      list: [{ asin: "B012345678", title: "HP Essential Laptop 2026 15.6 inch", brand: "HP" }],
    })
    const { events } = await collect()
    const done = events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(done.result.C.filled).toBe(true)
    expect(done.result.C.competitorAsins).toEqual(["B0KEEP0002", "B0KEEP0003"])
    expect(done.result.C.sharedKeywords).toEqual(["kw1"]) // D 卡 Top1 词回显
    expect(
      events.some(
        e =>
          e.type === "warning" && (e as { message: string }).message.includes("B0PAPER001 已过滤")
      )
    ).toBe(true)
  })

  it("C 卡过滤后无匹配：空卡 missingReason + warning，不反查竞品关键词", async () => {
    mcp.callAsinCompetitor.mockResolvedValue({
      items: [
        { asin: "B0PAPER001", title: "HP Printer Paper 8.5 x 11 Ream" },
        { asin: "B0STAND002", title: "Laptop Stand Aluminum" },
      ],
      parsed: null,
    })
    sif.batchAsinDetail.mockResolvedValue({
      list: [{ asin: "B012345678", title: "HP Essential Laptop 2026", brand: "HP" }],
    })
    const { events } = await collect()
    const done = events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(done.result.C).toEqual({
      filled: false,
      missingReason: "竞品经配件/周边过滤后无匹配",
    })
    expect(
      events.some(
        e => e.type === "warning" && (e as { message: string }).message.includes("已过滤")
      )
    ).toBe(true)
  })

  it("C 卡目标参照失败：warning + 跳过过滤，候选原样保留", async () => {
    sif.batchAsinDetail.mockRejectedValue(new Error("SIF 详情挂了"))
    const { events } = await collect()
    const done = events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(done.result.C.filled).toBe(true)
    expect(done.result.C.competitorAsins).toEqual(["B0COMPET001", "B0COMPET002"])
    expect(
      events.some(
        e =>
          e.type === "warning" &&
          (e as { message: string }).message.includes("竞品品类过滤参照获取失败")
      )
    ).toBe(true)
  })

  it("B 卡：评论为空跳过痛点；痛点失败 warning 回退基础卡", async () => {
    audit.findDetail.mockResolvedValue(auditRow({ title: "T", rating: 4.0, reviewCount: 10 }))
    const { events } = await collect()
    expect(painPoints.run).not.toHaveBeenCalled()
    const done = events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(done.result.B.richPainPoints ?? []).toHaveLength(0)

    painPoints.run.mockRejectedValue(new Error("模型挂了"))
    audit.findDetail.mockResolvedValue(auditRow(auditData()))
    const retry = await collect()
    expect(
      retry.events.some(
        e => e.type === "warning" && (e as { message: string }).message.includes("评论痛点分析失败")
      )
    ).toBe(true)
    const retryDone = retry.events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(retryDone.result.B.richPainPoints ?? []).toHaveLength(0)
  })

  it("B 卡 reviewSamples：爬虫原样透传（基础推与 done 均携带；无评论缺省）", async () => {
    audit.findDetail.mockResolvedValue(
      auditRow({
        ...auditData(),
        review: {
          comment_list: [
            { name: "A", date: "2026-08-27", star: 5, title: "Great", comment: "太吵了" },
            { comment: "材质差" },
          ],
        },
      })
    )
    const { events } = await collect()
    const bCards = events.filter(
      (e): e is Extract<EvidenceSseEvent, { type: "evidence" }> =>
        e.type === "evidence" && e.card === "B"
    )
    const baseB = bCards[0].data as ReviewEvidence
    expect(baseB.reviewSamples).toEqual([
      { date: "2026-08-27", rating: 5, title: "Great", text: "太吵了" },
      { text: "材质差" },
    ])
    const done = events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(done.result.B.reviewSamples).toEqual(baseB.reviewSamples)

    audit.findDetail.mockResolvedValue(auditRow({ title: "T", rating: 4.0, reviewCount: 10 }))
    const empty = await collect()
    const emptyDone = empty.events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(emptyDone.result.B.reviewSamples).toBeUndefined()
  })

  it("evidence-module 场景：B 第二推带 highlights+quote，checklist 带 hasHighlights；不调痛点服务", async () => {
    const { events } = await collect(dto({ scene: "evidence-module" }))
    const cards = events.filter(
      (e): e is Extract<EvidenceSseEvent, { type: "evidence" }> => e.type === "evidence"
    )
    expect(cards.map(c => c.card)).toEqual(["A", "P", "B", "D", "C", "D", "E", "B"]) // B/D 各推两次

    const done = events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(done.result.B.highlights).toEqual([{ text: "音质出色", freq: 1, quote: "太吵了" }])
    expect(done.result.B.richPainPoints).toEqual([{ text: "太吵了", freq: 2, quote: "太吵了" }])
    expect(done.checklist.reviews).toMatchObject({
      status: "fetched",
      hasPainPoints: true,
      hasHighlights: true,
    })
    expect(reviewAnalysis.run).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "ZQ-Think-Flash",
        commentList: [{ name: "A", comment: "太吵了" }, { comment: "材质差" }],
      }),
      7,
      // ZQ-Think-Flash 为固定价模型：内嵌按量扣费跳过（取证模块由流程价 5 覆盖）；
      // source/meta 供非固定价模型按量回落时分流「ASIN 取证」
      { skipUsageCharge: true, source: "asin.audit.evidence", meta: { scene: "evidence-module" } }
    )
    expect(painPoints.run).not.toHaveBeenCalled()
  })

  it("固定积分：evidence-module 场景预检并成功后扣 5（stage=evidence，source=取证）", async () => {
    const { events } = await collect(dto({ scene: "evidence-module" }))
    expect(events.at(-1)?.type).toBe("done")
    expect(billing.assertFixedStageAffordable).toHaveBeenCalledWith(7, "ZQ-Think-Flash", "evidence")
    expect(billing.chargeFixedStage).toHaveBeenCalledWith(
      7,
      "ZQ-Think-Flash",
      "evidence",
      expect.objectContaining({ scene: "evidence-module" }),
      "asin.audit.evidence"
    )
  })

  it("固定积分：audit 场景（缺省）取证免费——不预检不扣", async () => {
    const { events } = await collect()
    expect(events.at(-1)?.type).toBe("done")
    expect(billing.assertFixedStageAffordable).not.toHaveBeenCalled()
    expect(billing.chargeFixedStage).not.toHaveBeenCalled()
  })

  it("缺省（audit）回归：走痛点服务不调分析服务，B 卡无 highlights", async () => {
    const { events } = await collect()
    const done = events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(done.result.B.richPainPoints).toEqual([{ text: "太吵了", freq: 2 }])
    expect(done.result.B.highlights).toBeUndefined()
    expect(done.checklist.reviews).not.toHaveProperty("hasHighlights")
    expect(painPoints.run).toHaveBeenCalled()
    expect(reviewAnalysis.run).not.toHaveBeenCalled()
  })

  it("evidence-module 场景：评论为空跳过分析；分析失败 warning 回退基础卡", async () => {
    audit.findDetail.mockResolvedValue(auditRow({ title: "T", rating: 4.0, reviewCount: 10 }))
    const empty = await collect(dto({ scene: "evidence-module" }))
    expect(reviewAnalysis.run).not.toHaveBeenCalled()
    const emptyDone = empty.events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(emptyDone.result.B.highlights ?? []).toHaveLength(0)

    reviewAnalysis.run.mockRejectedValue(new Error("模型挂了"))
    audit.findDetail.mockResolvedValue(auditRow(auditData()))
    const retry = await collect(dto({ scene: "evidence-module" }))
    expect(
      retry.events.some(
        e => e.type === "warning" && (e as { message: string }).message.includes("评论分析失败")
      )
    ).toBe(true)
    const retryDone = retry.events.at(-1) as Extract<EvidenceSseEvent, { type: "done" }>
    expect(retryDone.result.B.highlights ?? []).toHaveLength(0)
  })
})
