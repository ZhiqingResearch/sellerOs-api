import { BadGatewayException, BadRequestException, NotFoundException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { Decimal } from "@prisma/client/runtime/library"
import * as XLSX from "xlsx"
import { AuditService } from "../audit/audit.service"
import { AiGatewayProvider } from "../common/providers/ai-gateway.provider"
import { UsageService } from "../usage/usage.service"
import { AsinAuditBilling } from "./asin-audit.billing"
import type { ReviewPainPointsDto } from "./dto/review-pain-points.dto"
import { PROMPT_VERSION } from "./prompts/prompt-assets"
import { ReviewAnalysisService } from "./review-analysis.service"

/** 评论分析双输出服务（取证模块 type=module）：清洗 / 双数组归一 / quote 逐字校验 / 先解析后计费口径。 */
describe("ReviewAnalysisService", () => {
  let gateway: { streamChat: jest.Mock }
  let usage: { gatewayPriceMultiplier: jest.Mock; chargeModel: jest.Mock }
  let audit: { findDetail: jest.Mock }
  let service: ReviewAnalysisService

  const billing = {
    costCny: "0.35",
    currency: "CNY",
    model: "ZQ-Think-Lite",
    requestId: "req-1",
    requestIds: ["req-1"],
  }

  /** 模拟网关流：text（完整 JSON）→ usage → billing */
  const mockStream = (textChunks: string[]) =>
    (function* () {
      for (const chunk of textChunks) yield { type: "text", content: chunk }
      yield {
        type: "usage",
        content: "",
        usage: { promptTokens: 10, completionTokens: 20, thinkingTokens: 5, totalTokens: 35 },
      }
      yield { type: "billing", content: "", billing }
    })()

  beforeEach(async () => {
    gateway = { streamChat: jest.fn() }
    usage = {
      gatewayPriceMultiplier: jest.fn().mockResolvedValue(new Decimal(1)),
      chargeModel: jest.fn().mockResolvedValue({}),
    }
    audit = { findDetail: jest.fn() }
    const moduleRef = await Test.createTestingModule({
      providers: [
        AsinAuditBilling,
        ReviewAnalysisService,
        { provide: AiGatewayProvider, useValue: gateway },
        { provide: UsageService, useValue: usage },
        { provide: AuditService, useValue: audit },
      ],
    }).compile()
    service = moduleRef.get(ReviewAnalysisService)
  })

  const dto = (commentList: ReviewPainPointsDto["commentList"]): ReviewPainPointsDto => ({
    model: "ZQ-Think-Flash",
    commentList,
  })

  it("空评论不调模型、不扣费，双空数组", async () => {
    const outcome = await service.run(dto([{ comment: "  " }]), 7)
    expect(outcome.highlights).toEqual([])
    expect(outcome.painPoints).toEqual([])
    expect(outcome.billingHandled).toBe(false)
    expect(gateway.streamChat).not.toHaveBeenCalled()
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("双输出归一：freq 降序 Top5、空 text 过滤、verbatim quote 保留（大小写/空白容差）", async () => {
    gateway.streamChat.mockReturnValue(
      mockStream([
        JSON.stringify({
          highlights: [
            { text: "B", freq: 8, quote: "BASS IS PUNCHY  and clear." },
            { text: "A", freq: 2, quote: "bass is punchy" },
            { text: "", freq: 9 },
          ],
          painPoints: [{ text: "续航虚标", freq: 3, quote: "battery dies after 5-6 hours" }],
        }),
      ])
    )
    const outcome = await service.run(
      dto([
        { comment: "Bass is punchy and clear." },
        { comment: "Battery dies after 5-6 hours, not the 8 they claim." },
      ]),
      7
    )
    expect(outcome.highlights).toEqual([
      { text: "B", freq: 8, quote: "BASS IS PUNCHY  and clear." },
      { text: "A", freq: 2, quote: "bass is punchy" },
    ])
    expect(outcome.painPoints).toEqual([
      { text: "续航虚标", freq: 3, quote: "battery dies after 5-6 hours" },
    ])
  })

  it("quote 防幻觉：不在评论原文中的摘录被丢弃（text/freq 保留）；超 200 字符丢弃", async () => {
    gateway.streamChat.mockReturnValue(
      mockStream([
        JSON.stringify({
          highlights: [
            { text: "音质好", freq: 1, quote: "sound is absolutely fantastic beyond words" },
          ],
          painPoints: [{ text: "续航虚标", freq: 1, quote: "b".repeat(201) }],
        }),
      ])
    )
    const outcome = await service.run(dto([{ comment: "Bass is punchy and clear." }]), 7)
    expect(outcome.highlights).toEqual([{ text: "音质好", freq: 1 }])
    expect(outcome.painPoints).toEqual([{ text: "续航虚标", freq: 1 }])
  })

  it("单边为空：painPoints 缺失时 highlights 照常产出", async () => {
    gateway.streamChat.mockReturnValue(
      mockStream([JSON.stringify({ highlights: [{ text: "音质好", freq: 1 }] })])
    )
    const outcome = await service.run(dto([{ comment: "Bass is punchy." }]), 7)
    expect(outcome.highlights).toEqual([{ text: "音质好", freq: 1 }])
    expect(outcome.painPoints).toEqual([])
  })

  it("system/user prompt：新 skill 装配 + 600 字截断", async () => {
    gateway.streamChat.mockReturnValue(
      mockStream([JSON.stringify({ highlights: [], painPoints: [] })])
    )
    await service.run(dto([{ comment: "c".repeat(700) }]), 7)
    const [systemPrompt, userPrompt] = gateway.streamChat.mock.calls[0] as [string, string]
    expect(systemPrompt).toContain("highlights")
    expect(systemPrompt).toContain("painPoints")
    expect(userPrompt).toContain("c".repeat(600))
    expect(userPrompt).not.toContain("c".repeat(601))
  })

  it("模型输出无 JSON → 报错且不扣分（先解析后计费）", async () => {
    gateway.streamChat.mockReturnValue(mockStream(["纯文本无 JSON"]))
    await expect(service.run(dto([{ comment: "评" }]), 7)).rejects.toThrow(
      "评论分析：未从模型响应中解析出 JSON"
    )
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("账单缺失 → 502", async () => {
    gateway.streamChat.mockReturnValue(
      (function* () {
        yield { type: "text", content: '{"highlights":[],"painPoints":[]}' }
      })()
    )
    await expect(service.run(dto([{ comment: "评" }]), 7)).rejects.toBeInstanceOf(
      BadGatewayException
    )
    expect(usage.chargeModel).not.toHaveBeenCalled()
  })

  it("计费：action=review-analysis，meta 全口径", async () => {
    gateway.streamChat.mockReturnValue(
      mockStream([JSON.stringify({ highlights: [{ text: "A", freq: 1 }], painPoints: [] })])
    )
    const outcome = await service.run(
      { ...dto([{ comment: "good" }]), clientRequestId: "d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1" },
      7
    )
    expect(outcome.billingHandled).toBe(true)
    expect(usage.chargeModel).toHaveBeenCalledWith(7, new Decimal("0.35"), {
      source: "asin.audit",
      model: "ZQ-Think-Flash",
      requestId: "req-1",
      meta: {
        gatewayAmountCny: "0.35",
        priceMultiplier: "1",
        action: "review-analysis",
        promptVersion: PROMPT_VERSION,
        gatewayRequestIds: ["req-1"],
        clientRequestId: "d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1",
      },
    })
  })

  it("计费分流：opts.source/meta 透传（取证模块按量回落 → ASIN 取证）", async () => {
    gateway.streamChat.mockReturnValue(
      mockStream([JSON.stringify({ highlights: [], painPoints: [] })])
    )
    const outcome = await service.run(dto([{ comment: "good" }]), 7, {
      source: "asin.audit.evidence",
      meta: { scene: "evidence-module" },
    })
    expect(outcome.billingHandled).toBe(true)
    expect(usage.chargeModel).toHaveBeenCalledWith(7, new Decimal("0.35"), {
      source: "asin.audit.evidence",
      model: "ZQ-Think-Flash",
      requestId: "req-1",
      meta: {
        gatewayAmountCny: "0.35",
        priceMultiplier: "1",
        action: "review-analysis",
        promptVersion: PROMPT_VERSION,
        gatewayRequestIds: ["req-1"],
        scene: "evidence-module",
      },
    })
  })
})

/** 下载原始评论：findDetail → extractReviewRows → xlsx buffer；纯读取不扣积分。 */
describe("ReviewAnalysisService.downloadRawReviews", () => {
  let audit: { findDetail: jest.Mock }
  let service: ReviewAnalysisService

  beforeEach(async () => {
    audit = { findDetail: jest.fn() }
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReviewAnalysisService,
        { provide: AiGatewayProvider, useValue: {} },
        { provide: UsageService, useValue: {} },
        { provide: AsinAuditBilling, useValue: { charge: jest.fn() } },
        { provide: AuditService, useValue: audit },
      ],
    }).compile()
    service = moduleRef.get(ReviewAnalysisService)
  })

  const auditRow = (data: unknown, asin: string | null = "B0GQB1C381") => ({
    id: 1,
    url: "https://www.amazon.com/dp/B0GQB1C381",
    platform: "amazon",
    country: "US",
    asin,
    name: "Test Product",
    data,
    fetchedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  it("asin/productUrl 都不传 → 400", async () => {
    await expect(service.downloadRawReviews({})).rejects.toBeInstanceOf(BadRequestException)
    expect(audit.findDetail).not.toHaveBeenCalled()
  })

  it("都传以 asin 为准；country 缺省 US", async () => {
    audit.findDetail.mockResolvedValue(
      auditRow({ review: { comment_list: [{ name: "A", comment: "好" }] } })
    )
    await service.downloadRawReviews({ asin: "B0GQB1C381", productUrl: "https://x" })
    expect(audit.findDetail).toHaveBeenCalledWith({ asin: "B0GQB1C381", country: "US" })
  })

  it("comment_list 为空 → 404", async () => {
    audit.findDetail.mockResolvedValue(
      auditRow({ _fetchMeta: { source: "apify" }, rating: 4.5, review: { comment_list: [] } })
    )
    await expect(service.downloadRawReviews({ asin: "B0GQB1C381" })).rejects.toBeInstanceOf(
      NotFoundException
    )
  })

  it("备用数据无正文时下载提示为未获取，不声称商品没有评论", async () => {
    audit.findDetail.mockResolvedValue(
      auditRow({ _fetchMeta: { source: "apify" }, review: { comment_list: [] } })
    )
    await expect(service.downloadRawReviews({ asin: "B0GQB1C381" })).rejects.toThrow(
      "本次商品数据未获取原始评论，暂无法下载"
    )
  })

  it("正常导出：8 列表头 + 全字段成值 + content 别名 + 未来字段空串", async () => {
    audit.findDetail.mockResolvedValue(
      auditRow({
        review: {
          comment_list: [
            {
              name: "Toy Monique",
              date: "2026-08-27",
              star: 5,
              title: "Great sound",
              comment: "Bass is punchy",
              verified: true,
              usefulNumber: 3,
              variant: "Black",
            },
            { name: "B", content: "旧字段别名" },
          ],
        },
      })
    )
    const file = await service.downloadRawReviews({ asin: "b0gqb1c381" })
    expect(file.count).toBe(2)
    expect(file.utf8Filename).toBe(
      `原始评论-B0GQB1C381-${file.utf8Filename.match(/\d{4}-\d{2}-\d{2}/)?.[0]}.xlsx`
    )
    expect(file.asciiFilename).toMatch(/^reviews-B0GQB1C381-\d{4}-\d{2}-\d{2}\.xlsx$/)

    const wb = XLSX.read(file.buffer, { type: "buffer" })
    const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets["原始评论"], { header: 1 })
    expect(aoa[0]).toEqual([
      "买家",
      "日期",
      "星级",
      "标题",
      "评论正文",
      "已验证购买",
      "有用数",
      "变体",
    ])
    expect(aoa[1]).toEqual([
      "Toy Monique",
      "2026-08-27",
      "5",
      "Great sound",
      "Bass is punchy",
      "true",
      "3",
      "Black",
    ])
    expect(aoa[2]).toEqual(["B", "", "", "", "旧字段别名", "", "", ""])
  })

  it("文件名 ASIN 清洗：非字母数字剔除；仅传 url 时回落库中 asin", async () => {
    audit.findDetail.mockResolvedValue(
      auditRow({ review: { comment_list: [{ comment: "好" }] } }, "B0CLEAN1234")
    )
    const file = await service.downloadRawReviews({ productUrl: "https://www.amazon.com/dp/x" })
    expect(file.asciiFilename).toContain("B0CLEAN1234")
  })

  it("脏 asin：文件名清洗防 header 注入", async () => {
    audit.findDetail.mockResolvedValue(auditRow({ review: { comment_list: [{ comment: "好" }] } }))
    const file = await service.downloadRawReviews({ asin: 'B0\r\nGQ"1' })
    expect(file.asciiFilename).toBe(
      `reviews-B0GQ1-${file.asciiFilename.match(/\d{4}-\d{2}-\d{2}/)?.[0]}.xlsx`
    )
  })
})
