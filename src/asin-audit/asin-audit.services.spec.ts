/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest 匹配器（expect.any/stringContaining 等）返回 any */
import { BadGatewayException, BadRequestException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { Decimal } from "@prisma/client/runtime/library"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { UsageService } from "../usage/usage.service"
import { AsinAuditBilling } from "./asin-audit.billing"
import { AuditOptimizeService } from "./audit-optimize.service"
import { AuditScoreService } from "./audit-score.service"
import type { OptimizeRequestDto } from "./dto/optimize.dto"
import type { ReviewPainPointsDto } from "./dto/review-pain-points.dto"
import type { ScoreRequestDto } from "./dto/score.dto"
import { buildAsinAuditOptimizeUserPrompt } from "./prompts/asin-audit-optimize"
import { PROMPT_VERSION } from "./prompts/prompt-assets"
import { ReviewPainPointsService } from "./review-pain-points.service"
import { AUDIT_BOARD_CONTRACT } from "./rules/board-contract"
import type { AuditEvidence, AuditScoreResult } from "./types/audit.types"

/** 三个业务服务 + 共享计费：事件透传 / 归一化 / 先解析后计费口径。 */
describe("AsinAudit 服务（评分/优化/痛点 + 计费）", () => {
  let gateway: { streamChat: jest.Mock }
  let usage: {
    gatewayPriceMultiplier: jest.Mock
    chargeModel: jest.Mock
    assertExactCreditsAffordable: jest.Mock
  }
  let painPoints: ReviewPainPointsService
  let score: AuditScoreService
  let optimize: AuditOptimizeService

  const billing = {
    costCny: "0.35",
    currency: "CNY",
    model: "ZQ-Think-Lite",
    requestId: "req-1",
    requestIds: ["req-1"],
  }

  /** 模拟网关流：thinking → text（完整 JSON）→ usage → billing */
  const mockStream = (textChunks: string[], billingOver: Record<string, unknown> = {}) =>
    (function* () {
      yield { type: "thinking", content: "Analyzing…" }
      for (const chunk of textChunks) yield { type: "text", content: chunk }
      yield {
        type: "usage",
        content: "",
        usage: { promptTokens: 10, completionTokens: 20, thinkingTokens: 5, totalTokens: 35 },
      }
      yield { type: "billing", content: "", billing: { ...billing, ...billingOver } }
    })()

  const evidenceDto = (): ScoreRequestDto => ({
    model: "ZQ-Think-Lite",
    evidence: {
      asin: "B012345678",
      country: "US",
      C: { filled: false },
      D: { filled: false, kwTop: [], kwDetail: [] },
      E: { filled: false, asin: "B012345678", boughtInPastMonth: null, priceBsr: {} },
      meta: {
        sources: { D: ["sif"], E: ["sif"] },
        sifDataReady: true,
        sifWarnings: [],
        fetchedAt: "2026-09-07T00:00:00Z",
      },
    },
  })

  const fullScorePayload = () => ({
    historyTitle: "B012345678 审计",
    boards: AUDIT_BOARD_CONTRACT.map(spec => ({
      id: spec.id,
      name: spec.name,
      weight: spec.weight,
      maxScore: spec.maxScore,
      score: 100,
      items: spec.items.map(item => ({
        id: item.id,
        name: item.name,
        maxScore: item.maxScore,
        score: item.maxScore,
        status: "verified",
        pendingReason: null,
        naReason: null,
        deductions: [],
      })),
    })),
    diagnosis: { weakestBoards: [], contentNarrative: "…", operationsNarrative: "…", issues: [] },
    suggestions: ["建议 1"],
    aiVerdict: "verdict",
    aiSecondary: "secondary",
    actionItems: ["action"],
  })

  const promptEvidence = (): AuditEvidence => ({
    asin: "B012345678",
    country: "US",
    market: "amazon_us",
    A: { filled: true, title: "Premium Laptop Stand" },
    P: { filled: false },
    B: { filled: false },
    C: { filled: false },
    D: { filled: true, kwTop: [], kwDetail: [] },
    E: {
      filled: false,
      asin: "B012345678",
      boughtInPastMonth: null,
      priceBsr: { buyboxPrice: null, bsr: null, bsrTrend: null, coupon: "", listedDate: null },
    },
    meta: { sources: {}, fetchedAt: "2026-09-10T00:00:00Z" },
  })

  const scoreResult: AuditScoreResult = {
    historyTitle: "B012345678 审计",
    total: 88,
    grade: "GOOD",
    gradeLabel: "良好",
    domainScores: { content: 90, operations: 80 },
    boards: AUDIT_BOARD_CONTRACT.map(spec => ({
      id: spec.id,
      name: spec.name,
      weight: spec.weight,
      maxScore: spec.maxScore,
      score: 80,
      items: spec.items.map(item => ({
        id: item.id,
        name: item.name,
        maxScore: item.maxScore,
        score: Math.floor(item.maxScore * 0.8),
        status: "verified",
        pendingReason: null,
        naReason: null,
        deductions:
          item.maxScore - Math.floor(item.maxScore * 0.8) > 0
            ? [{ reason: "低分示例", points: item.maxScore - Math.floor(item.maxScore * 0.8) }]
            : [],
      })),
    })),
    scoring: {
      applicableMax: 100,
      evidenceMax: 100,
      earnedScore: 88,
      convertedScore: 88,
      coverageRate: 1,
      isComplete: true,
    },
    diagnosis: { weakestBoards: ["F"], contentNarrative: "", operationsNarrative: "", issues: [] },
    actionItems: [],
    suggestions: [],
  }

  beforeEach(async () => {
    gateway = { streamChat: jest.fn() }
    usage = {
      gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal(1)),
      chargeModel: jest.fn().mockResolvedValue({}),
      assertExactCreditsAffordable: jest.fn().mockResolvedValue(undefined),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        AsinAuditBilling,
        ReviewPainPointsService,
        AuditScoreService,
        AuditOptimizeService,
        { provide: AiGatewayProvider, useValue: gateway },
        { provide: UsageService, useValue: usage },
      ],
    }).compile()
    painPoints = moduleRef.get(ReviewPainPointsService)
    score = moduleRef.get(AuditScoreService)
    optimize = moduleRef.get(AuditOptimizeService)
  })

  // ==================== 痛点 ====================

  it("痛点：空评论不调模型、不扣费，直接空数组", async () => {
    const dto: ReviewPainPointsDto = { model: "ZQ-Think-Flash", commentList: [{ comment: "  " }] }
    const outcome = await painPoints.run(dto, 7)
    expect(outcome.painPoints).toEqual([])
    expect(outcome.billingHandled).toBe(false)
    expect(gateway.streamChat).not.toHaveBeenCalled()
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("痛点：清洗截断 200 条/600 字，解析后按 freq 降序取 Top5，计费 meta 全口径", async () => {
    const longComment = "c".repeat(700)
    const comments = Array.from({ length: 205 }, (_, i) => ({
      comment: i === 0 ? longComment : `评${i}`,
    }))
    gateway.streamChat.mockReturnValue(
      mockStream([
        '{"painPoints":[{"text":"A","freq":2},{"text":"B","freq":8},{"text":"C"},{"text":"","freq":9},{"text":"D","freq":6},{"text":"E","freq":5},{"text":"F","freq":4}]}',
      ])
    )
    const dto: ReviewPainPointsDto = {
      model: "ZQ-Think-Flash",
      commentList: comments,
      starPercent: ["5 星 75%"],
      reviewCount: 50000,
      clientRequestId: "c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1",
    }
    const outcome = await painPoints.run(dto, 7)
    expect(outcome.painPoints).toEqual([
      { text: "B", freq: 8 },
      { text: "D", freq: 6 },
      { text: "E", freq: 5 },
      { text: "F", freq: 4 },
      { text: "A", freq: 2 },
    ])
    const [systemPrompt, userPrompt] = gateway.streamChat.mock.calls[0] as [string, string]
    expect(userPrompt).toContain('"comment_list"')
    expect(userPrompt).toContain("c".repeat(600))
    expect(userPrompt).not.toContain("c".repeat(601))
    expect(systemPrompt).toContain("painPoints")
    expect(usage.chargeModel).toHaveBeenCalledWith(7, new Decimal("0.35"), {
      source: "asin.audit",
      model: "ZQ-Think-Flash",
      requestId: "req-1",
      meta: {
        gatewayAmountCny: "0.35",
        priceMultiplier: "1",
        action: "review-pain-points",
        promptVersion: PROMPT_VERSION,
        gatewayRequestIds: ["req-1"],
        clientRequestId: "c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1",
      },
    })
    expect(outcome.billingHandled).toBe(true)
  })

  it("痛点：模型输出无 JSON → 报错且不扣分（先解析后计费）", async () => {
    gateway.streamChat.mockReturnValue(mockStream(["纯文本无 JSON"]))
    const dto: ReviewPainPointsDto = { model: "ZQ-Think-Flash", commentList: [{ comment: "评" }] }
    await expect(painPoints.run(dto, 7)).rejects.toThrow("评论痛点分析：未从模型响应中解析出 JSON")
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("痛点：账单缺失 → 502", async () => {
    gateway.streamChat.mockReturnValue(
      (function* () {
        yield { type: "text", content: '{"painPoints":[{"text":"A","freq":1}]}' }
      })()
    )
    const dto: ReviewPainPointsDto = { model: "ZQ-Think-Flash", commentList: [{ comment: "评" }] }
    await expect(painPoints.run(dto, 7)).rejects.toBeInstanceOf(BadGatewayException)
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  // ==================== 打分 ====================

  it("打分：thinking/text/usage 透传，result.data 为 10 维处理后结构，计费 action=score", async () => {
    gateway.streamChat.mockReturnValue(mockStream([JSON.stringify(fullScorePayload())]))
    const events: unknown[] = []
    for await (const event of score.stream(evidenceDto(), 7)) events.push(event)
    expect(events[0]).toEqual({ type: "thinking", content: "Analyzing…" })
    expect(events[1]).toEqual({ type: "text", content: JSON.stringify(fullScorePayload()) })
    expect(events[2]).toMatchObject({ type: "usage" })
    const resultEvent = events.at(-1) as {
      type: string
      data: AuditScoreResult
      billingHandled: boolean
      requestId: string
    }
    expect(resultEvent.type).toBe("result")
    expect(resultEvent.billingHandled).toBe(true)
    expect(resultEvent.requestId).toBe("req-1")
    expect(resultEvent.data.boards).toHaveLength(10)
    expect(resultEvent.data.total).toBe(100) // 服务端重算，模型不输出聚合分
    expect(resultEvent.data.grade).toBe("EXCELLENT")
    expect(resultEvent.data.scoring.coverageRate).toBe(1)
    expect(usage.chargeModel).toHaveBeenCalledWith(
      7,
      new Decimal("0.35"),
      expect.objectContaining({
        source: "asin.audit",
        model: "ZQ-Think-Lite",
        requestId: "req-1",
        meta: expect.objectContaining({ action: "score", promptVersion: PROMPT_VERSION }),
      })
    )
    // 打分按能力固定 temperature 0
    expect(gateway.streamChat).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ model: "ZQ-Think-Lite", temperature: 0 })
    )
  })

  it("打分：计费失败（余额不足）从流中抛出，controller 转 error 事件", async () => {
    gateway.streamChat.mockReturnValue(mockStream([JSON.stringify(fullScorePayload())]))
    usage.chargeModel.mockRejectedValue(new BadRequestException("积分余额不足，请充值"))
    await expect(
      (async () => {
        for await (const _ of score.stream(evidenceDto(), 7)) {
          void _
        }
      })()
    ).rejects.toThrow("积分余额不足，请充值")
  })

  // ==================== 固定积分（ZQ-Think-Flash 一口价） ====================

  it("固定价打分：ZQ-Think-Flash 预检 20 + 成功后 exactCredits 20，不双扣按量", async () => {
    gateway.streamChat.mockReturnValue(mockStream([JSON.stringify(fullScorePayload())]))
    const events: unknown[] = []
    for await (const event of score.stream({ ...evidenceDto(), model: "ZQ-Think-Flash" }, 7)) {
      events.push(event)
    }
    const resultEvent = events.at(-1) as { type: string; billingHandled: boolean }
    expect(resultEvent.type).toBe("result")
    expect(resultEvent.billingHandled).toBe(true)
    expect(usage.assertExactCreditsAffordable).toHaveBeenCalledWith(7, 20)
    expect(usage.chargeModel).toHaveBeenCalledTimes(1)
    expect(usage.chargeModel).toHaveBeenCalledWith(
      7,
      new Decimal("2"),
      expect.objectContaining({
        source: "asin.audit",
        model: "ZQ-Think-Flash",
        exactCredits: 20,
        allowOverdraft: true,
        requestId: expect.stringMatching(/^charge:asin-audit:score:/),
        meta: expect.objectContaining({
          pricingMode: "fixed",
          stage: "score",
          fixedCredits: 20,
        }),
      })
    )
  })

  it("固定价打分：余额不足在预检即抛出，未调网关未扣费", async () => {
    usage.assertExactCreditsAffordable.mockRejectedValue(
      new BadRequestException("积分余额不足，请充值")
    )
    await expect(
      (async () => {
        for await (const _ of score.stream({ ...evidenceDto(), model: "ZQ-Think-Flash" }, 7)) {
          void _
        }
      })()
    ).rejects.toThrow("积分余额不足，请充值")
    expect(gateway.streamChat).not.toHaveBeenCalled()
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  // ==================== 优化 ====================

  it("优化：空 listing（title 与 bullets 同空）→ 报错且不扣分", async () => {
    gateway.streamChat.mockReturnValue(mockStream(['{"listing":{"title":"","bullets":[]}}']))
    const dto: OptimizeRequestDto = { ...evidenceDto(), score: scoreResult }
    await expect(
      (async () => {
        for await (const _ of optimize.stream(dto, 7)) {
          void _
        }
      })()
    ).rejects.toThrow("Invalid optimize response: listing 主体为空")
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("优化：v2.0 不补数量——交付物原样透传（bullets 1 条不补到 5），计费 action=optimize", async () => {
    gateway.streamChat.mockReturnValue(
      mockStream([
        JSON.stringify({
          listing: {
            title: "优化标题",
            bullets: ["B1"],
            description: "",
            searchTerms: [],
            qaCandidates: [{ q: "q", a: "a" }],
          },
          imageSellingPoints: [],
          aplusModules: [],
          keywordTiers: [],
          reviewStrategies: [],
          differentiationUSPs: [],
          launchPhases: [],
        }),
      ])
    )
    const dto: OptimizeRequestDto = { ...evidenceDto(), score: scoreResult }
    const events: unknown[] = []
    for await (const event of optimize.stream(dto, 7)) events.push(event)
    const resultEvent = events.at(-1) as {
      type: string
      data: {
        listing: { bullets: string[]; qaCandidates: { q: string; a: string }[] }
        differentiationUSPs: { title: string }[]
        launchPhases: { name: string }[]
        improvementPriorities?: { level: string }[]
      }
    }
    expect(resultEvent.type).toBe("result")
    expect(resultEvent.data.listing.bullets).toHaveLength(1) // 不强制补齐数量
    expect(resultEvent.data.listing.qaCandidates).toHaveLength(1)
    expect(resultEvent.data.differentiationUSPs).toHaveLength(0)
    expect(resultEvent.data.launchPhases).toHaveLength(0)
    expect(resultEvent.data.improvementPriorities?.length).toBeGreaterThan(0) // 优先级兜底保留
    expect(usage.chargeModel).toHaveBeenCalledWith(
      7,
      new Decimal("0.35"),
      expect.objectContaining({
        meta: expect.objectContaining({ action: "optimize" }),
      })
    )
  })

  it("固定价优化：ZQ-Think-Flash 预检 15 + 成功后 exactCredits 15", async () => {
    gateway.streamChat.mockReturnValue(
      mockStream([
        JSON.stringify({
          listing: {
            title: "优化标题",
            bullets: ["B1"],
            description: "",
            searchTerms: [],
            qaCandidates: [{ q: "q", a: "a" }],
          },
          imageSellingPoints: [],
          aplusModules: [],
          keywordTiers: [],
          reviewStrategies: [],
          differentiationUSPs: [],
          launchPhases: [],
        }),
      ])
    )
    const dto: OptimizeRequestDto = {
      ...evidenceDto(),
      model: "ZQ-Think-Flash",
      score: scoreResult,
    }
    const events: unknown[] = []
    for await (const event of optimize.stream(dto, 7)) events.push(event)
    const resultEvent = events.at(-1) as { type: string; billingHandled: boolean }
    expect(resultEvent.type).toBe("result")
    expect(resultEvent.billingHandled).toBe(true)
    expect(usage.assertExactCreditsAffordable).toHaveBeenCalledWith(7, 15)
    expect(usage.chargeModel).toHaveBeenCalledTimes(1)
    expect(usage.chargeModel).toHaveBeenCalledWith(
      7,
      new Decimal("1.5"),
      expect.objectContaining({
        source: "asin.audit",
        model: "ZQ-Think-Flash",
        exactCredits: 15,
        allowOverdraft: true,
        requestId: expect.stringMatching(/^charge:asin-audit:optimize:/),
        meta: expect.objectContaining({
          pricingMode: "fixed",
          stage: "optimize",
          fixedCredits: 15,
        }),
      })
    )
  })

  it("优化：禁词红线——LLM 输出的 searchTerms/keywordTiers 关键词机械清洗（促销词/竞品品牌词剔除，兼容前缀保留）", async () => {
    gateway.streamChat.mockReturnValue(
      mockStream([
        JSON.stringify({
          listing: {
            title: "优化标题",
            bullets: ["B1"],
            description: "",
            searchTerms: ["laptop stand", "free shipping case", "samsung galaxy cover"],
            qaCandidates: [],
          },
          keywordTiers: [
            {
              tier: "S",
              label: "标题可识别位置",
              keywords: ["best seller laptop", "laptop stand"],
            },
            {
              tier: "A",
              label: "标题 + Bullet 1-2 必现",
              keywords: ["case for samsung galaxy"],
            },
          ],
        }),
      ])
    )
    const dto: OptimizeRequestDto = { ...evidenceDto(), score: scoreResult }
    const events: unknown[] = []
    for await (const event of optimize.stream(dto, 7)) events.push(event)
    const resultEvent = events.at(-1) as {
      type: string
      data: {
        listing: { searchTerms: string[] }
        keywordTiers: { tier: string; keywords: string[] }[]
      }
    }
    expect(resultEvent.data.listing.searchTerms).toEqual(["laptop stand"])
    expect(resultEvent.data.keywordTiers[0]?.keywords).toEqual(["laptop stand"])
    expect(resultEvent.data.keywordTiers[1]?.keywords).toEqual(["case for samsung galaxy"])
  })

  it("优化：searchTerms 空回退 D/C 查询词时同样先过禁词过滤", async () => {
    gateway.streamChat.mockReturnValue(
      mockStream([
        JSON.stringify({
          listing: {
            title: "优化标题",
            bullets: ["B1"],
            description: "",
            searchTerms: [],
            qaCandidates: [],
          },
        }),
      ])
    )
    const dto: OptimizeRequestDto = {
      ...evidenceDto(),
      score: scoreResult,
      evidence: {
        ...evidenceDto().evidence,
        C: {
          filled: true,
          sharedKeywords: ["samsung galaxy case", "aluminum stand"],
          keywords: [],
        },
        D: {
          filled: true,
          kwTop: [
            {
              kw: "laptop stand",
              searchVol: "12K",
              contribution: 5,
              aba: 100,
              heat: "搜索量高",
              ranking: "自然P2-pos.55 / 广告无排名",
              tags: ["核心"],
            },
            {
              kw: "free shipping laptop",
              searchVol: "9K",
              contribution: 3,
              aba: null,
              heat: "搜索量中",
              ranking: "自然无排名 / 广告无排名",
              tags: [],
            },
          ],
          kwDetail: [],
        },
      },
    }
    const events: unknown[] = []
    for await (const event of optimize.stream(dto, 7)) events.push(event)
    const resultEvent = events.at(-1) as {
      type: string
      data: { listing: { searchTerms: string[] } }
    }
    expect(resultEvent.data.listing.searchTerms).toEqual(["laptop stand", "aluminum stand"])
  })

  it("优化 user prompt：trafficSuggestions 现场构建（评分结果已下线该字段，词位原料仍到达模型）", () => {
    const prompt = buildAsinAuditOptimizeUserPrompt(promptEvidence(), {
      ...scoreResult,
      trafficPrecompute: {
        top10Page1Hits: 2,
        homepageHitTier: { score: 5, max: 8, label: "D" },
        weightedNaturalPct: null,
        naturalHealthTier: { score: 0, max: 0, label: "" },
        opportunityCount: 0,
        top1ConcentrationPct: 0,
        concentrationTier: { score: 0, max: 0, label: "" },
        summaryLines: [],
        positionAllocation: [
          {
            kw: "laptop stand",
            searches: 12000,
            searchVolLabel: "12K",
            currentRank: "P2-pos.55",
            suggestPosition: "Bullet 1 开头",
          },
        ],
      },
    })
    expect(prompt).toContain("trafficSuggestions 四子维度")
    expect(prompt).toContain("G1 当日核心词首页观测率")
    expect(prompt).toContain(
      "laptop stand｜月搜索量 12K｜当日观测 P2-pos.55｜建议位置 Bullet 1 开头"
    )
  })

  // ==================== 共享计费 ====================

  it("计费：零金额不扣积分但 billingHandled=true（后端已负责结算）", async () => {
    gateway.streamChat.mockReturnValue(
      mockStream(['{"painPoints":[{"text":"A","freq":1}]}'], { costCny: "0" })
    )
    const dto: ReviewPainPointsDto = { model: "ZQ-Think-Flash", commentList: [{ comment: "评" }] }
    const outcome = await painPoints.run(dto, 7)
    expect(outcome.billingHandled).toBe(true)
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })
})
