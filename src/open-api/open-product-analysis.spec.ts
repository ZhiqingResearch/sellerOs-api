import { BadRequestException, INestApplication, ValidationPipe } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { Decimal } from "@prisma/client/runtime/library"
import { createHash, createHmac, randomUUID } from "node:crypto"
import request from "supertest"
import { CompetitorEvidenceBundle } from "../competitor-analysis/competitor-analysis.types"
import { CompetitorEvidenceProvider } from "../competitor-analysis/competitor-evidence.provider"
import { PricingService } from "../pricing/pricing.service"
import { PrismaService } from "../prisma/prisma.service"
import { UsageService } from "../usage/usage.service"
import { OpenApiAuthGuard } from "./open-api-auth.guard"
import { OpenOperationQueryController } from "./open-operation-query.controller"
import { OpenProductAnalysisController } from "./open-product-analysis.controller"
import {
  OpenProductAnalysisService,
  buildHistoricalOperations,
} from "./open-product-analysis.service"

const ASIN = "B0F15TM77B"
const URL = `https://www.amazon.com/dp/${ASIN}`
function evidence(): CompetitorEvidenceBundle {
  const current: number[] = []
  current[4] = 1999
  return {
    country: "US",
    asins: [ASIN],
    collectedAt: "2026-09-22T00:00:00Z",
    sif: {
      profile: [{ asin: ASIN, title: "真实商品", firstAvailableDay: "2026-08-01" }],
      price: [{ asin: ASIN, currentPrice: 12.99 }],
      monthlySales: { [ASIN]: { "2026-08": 350, "2026-09": 0 } },
      trafficTrends: {
        [ASIN]: {
          dates: ["2026-08-01", "2026-09-20", "2026-09-21", "2026-09-22"],
          buyboxPrice: [25, 15.99, 14.99, 12.99],
          bsr: [500, 450, 400, 350],
          bought: [0, 150, 160, 180],
          adScore: [0, 20, 30, 40],
          review: [1, 5, 6, 8],
          title: [0, 1, 0, 0],
        },
      },
    },
    keepa: { [ASIN]: { products: [{ asin: ASIN, stats: { current } }] } },
    sellerSprite: null,
    sources: [],
    callDetail: {},
  }
}
describe("牛牛独立商品分析查询", () => {
  let app: INestApplication
  const collectModuleEvidence = jest.fn()
  const collectProductHistoryEvidence = jest.fn()
  const collectOperationProductEvidence = jest.fn()
  const findUser = jest.fn()
  const assertGatewayAffordable = jest.fn()
  const chargeMcpInTransaction = jest.fn()
  const caller = {
    appId: "niuniu",
    appSecret: "test-secret",
    status: "ACTIVE",
    isNiuniuOperationPlanEnabled: true,
    perCallMaxCny: new Decimal("1.5"),
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OpenProductAnalysisController, OpenOperationQueryController],
      providers: [
        OpenProductAnalysisService,
        OpenApiAuthGuard,
        {
          provide: PrismaService,
          useValue: {
            openApiApp: { findUnique: () => caller },
            user: { findUnique: findUser },
            $transaction: (callback: (tx: object) => Promise<unknown>) => callback({}),
          },
        },
        { provide: PricingService, useValue: { getMcpCallPrice: () => new Decimal("0.12375") } },
        { provide: UsageService, useValue: { assertGatewayAffordable, chargeMcpInTransaction } },
        {
          provide: CompetitorEvidenceProvider,
          useValue: {
            collectModuleEvidence,
            collectProductHistoryEvidence,
            collectOperationProductEvidence,
          },
        },
      ],
    }).compile()
    app = module.createNestApplication({ rawBody: true, logger: false })
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    collectModuleEvidence
      .mockReset()
      .mockImplementation((_country: string, _asins: string[], module: string) =>
        Promise.resolve({
          ...evidence(),
          callDetail: module === "profile" ? { sif: 3 } : { sif: 2, keepa: 1 },
        })
      )
    collectProductHistoryEvidence
      .mockReset()
      .mockImplementation(
        (country: string, asin: string) =>
          collectModuleEvidence(country, [asin], "history") as Promise<CompetitorEvidenceBundle>
      )
    collectOperationProductEvidence
      .mockReset()
      .mockResolvedValue({ ...evidence(), callDetail: { sif: 1 } })
    findUser.mockReset().mockResolvedValue({ id: 73, isActive: true })
    assertGatewayAffordable.mockReset().mockResolvedValue(undefined)
    chargeMcpInTransaction
      .mockReset()
      .mockImplementation((_tx: unknown, _userId: number, dto: { calls: number }) =>
        Promise.resolve({
          costCny: new Decimal("0.12375").mul(dto.calls),
          creditsCharged: new Decimal("0.12375").mul(dto.calls).mul(10).ceil(),
        })
      )
    caller.isNiuniuOperationPlanEnabled = true
    caller.perCallMaxCny = new Decimal("1.5")
  })
  function query(payload: unknown = { url: URL }, path = "/api/open/products/analysis") {
    const body = JSON.stringify(payload),
      timestamp = String(Date.now()),
      nonce = randomUUID()
    const sign = createHmac("sha256", caller.appSecret)
      .update(
        [caller.appId, timestamp, nonce, createHash("sha256").update(body).digest("hex")].join("\n")
      )
      .digest("hex")
    return request(app.getHttpServer())
      .post(path)
      .set({
        "Content-Type": "application/json",
        "x-app-id": caller.appId,
        "x-timestamp": timestamp,
        "x-nonce": nonce,
        "x-sign": sign,
      })
      .send(body)
  }
  it("单链接返回历史数据，按成功取数次数从内置账号扣费并标记API流水", async () => {
    const response = await query().expect(200)
    expect(response.body).toMatchObject({
      asin: ASIN,
      price: 12.99,
      listPrice: 19.99,
      monthlySales: 0,
      monthlySalesPeriod: "2026-09",
      monthlySalesBasis: "calendar_month",
    })
    const body = response.body as {
      priceCurve: { points: unknown[] }
      historicalOperations: { rows: unknown[] }
    }
    expect(body.priceCurve.points).toEqual([
      { date: "2026-09-20", price: 15.99 },
      { date: "2026-09-21", price: 14.99 },
      { date: "2026-09-22", price: 12.99 },
    ])
    expect(body.historicalOperations.rows.length).toBeGreaterThan(0)
    expect(response.body).not.toHaveProperty("operationPlan")
    expect(collectProductHistoryEvidence).toHaveBeenCalledWith("US", ASIN)
    expect(collectModuleEvidence).not.toHaveBeenCalledWith("US", [ASIN], "pricePromo")
    expect(response.body).toMatchObject({
      billingHandled: true,
      billing: {
        calls: 6,
        callDetail: { sif: 5, keepa: 1 },
        costCny: "0.7425",
        creditsCharged: "8",
      },
    })
    expect(assertGatewayAffordable).toHaveBeenCalledWith(73, new Decimal("0.7425"))
    expect(chargeMcpInTransaction).toHaveBeenCalledTimes(1)
    expect(chargeMcpInTransaction).toHaveBeenCalledWith(
      {},
      73,
      expect.objectContaining({
        calls: 6,
        source: "open.product-analysis",
        requestId: (response.body as { requestId: string }).requestId,
        meta: expect.objectContaining({
          appId: "niuniu",
          callDetail: { sif: 5, keepa: 1 },
        }) as unknown,
      }),
      { invokeType: "API", unitPriceCny: new Decimal("0.12375") }
    )
  })
  it("历史取数失败仍返回商品基础字段和明确缺失状态，不伪造曲线或月销量", async () => {
    const data = evidence()
    data.callDetail = { sif: 3 }
    data.sif.monthlySales = {}
    delete data.sif.trafficTrends
    collectModuleEvidence.mockImplementation(
      (_country: string, _asins: string[], module: string) =>
        module === "profile" ? Promise.resolve(data) : Promise.reject(new Error("upstream"))
    )
    const response = await query().expect(200)
    expect(response.body).toMatchObject({
      price: 12.99,
      listPrice: null,
      monthlySales: null,
      priceCurve: { status: "unavailable", points: [] },
      historicalOperations: { status: "unavailable", rows: [] },
      billing: {
        calls: 3,
        callDetail: { sif: 3, keepa: 0 },
        costCny: "0.37125",
        creditsCharged: "4",
      },
    })
  })
  it("行情缺少真实价格时保持null，不以零充当售价", async () => {
    const data = evidence()
    data.sif.price = []
    data.keepa = null
    collectModuleEvidence.mockResolvedValue(data)
    const response = await query().expect(200)
    expect(response.body).toMatchObject({ price: null, listPrice: null })
  })
  it("Keepa日元曲线和划线价使用日元单位", async () => {
    const data = evidence()
    const minute = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 60000) - 21564000
    const csv: number[][] = []
    csv[0] = [minute("2026-09-21"), 1500, minute("2026-09-22"), 1400]
    const current: number[] = []
    current[4] = 1999
    data.keepa = { [ASIN]: { products: [{ asin: ASIN, csv, stats: { current } }] } }
    collectModuleEvidence.mockResolvedValue(data)
    const response = await query({ url: `https://www.amazon.co.jp/dp/${ASIN}` }).expect(200)
    expect(response.body).toMatchObject({
      currency: "JPY",
      listPrice: 1999,
      priceCurve: {
        source: "keepa",
        points: [
          { date: "2026-09-21", price: 1500 },
          { date: "2026-09-22", price: 1400 },
        ],
      },
    })
  })
  it("拒绝缺签名、未授权及非法URL，均不调用上游", async () => {
    await request(app.getHttpServer())
      .post("/api/open/products/analysis")
      .send({ url: URL })
      .expect(401)
    caller.isNiuniuOperationPlanEnabled = false
    await query().expect(403)
    caller.isNiuniuOperationPlanEnabled = true
    await query({ url: "https://evil.test/dp/B0F15TM77B" }).expect(400)
    await query({}).expect(400)
    expect(collectModuleEvidence).not.toHaveBeenCalled()
    expect(chargeMcpInTransaction).not.toHaveBeenCalled()
  })
  it("余额不足、账号停用、单笔上限不足在调用数据源前拒绝", async () => {
    findUser.mockResolvedValueOnce(null)
    await query().expect(403)
    findUser.mockResolvedValueOnce({ id: 73, isActive: false })
    await query().expect(403)
    caller.perCallMaxCny = new Decimal("0.7")
    await query().expect(400)
    caller.perCallMaxCny = new Decimal("1.5")
    assertGatewayAffordable.mockRejectedValueOnce(new BadRequestException("积分余额不足"))
    await query().expect(400)
    expect(collectModuleEvidence).not.toHaveBeenCalled()
    expect(chargeMcpInTransaction).not.toHaveBeenCalled()
  })
  it("基础取数失败或商品无效不扣费", async () => {
    collectModuleEvidence.mockRejectedValueOnce(new Error("upstream"))
    await query().expect(500)
    const data = evidence()
    data.sif.profile = []
    collectModuleEvidence.mockResolvedValue(data)
    await query().expect(502)
    expect(chargeMcpInTransaction).not.toHaveBeenCalled()
  })
  it("同链接重复查询重新取数并使用独立消费编号", async () => {
    const first = await query().expect(200)
    const second = await query().expect(200)
    expect((first.body as { requestId: string }).requestId).not.toBe(
      (second.body as { requestId: string }).requestId
    )
    expect(chargeMcpInTransaction).toHaveBeenCalledTimes(2)
  })
  it("扣费失败不返回成功结果", async () => {
    chargeMcpInTransaction.mockRejectedValueOnce(new BadRequestException("积分余额不足"))
    await query().expect(400)
  })
  it("零调用不扣费；非法调用计数拒绝结算", async () => {
    collectModuleEvidence.mockResolvedValue(evidence())
    const response = await query().expect(200)
    expect((response.body as { billing: unknown }).billing).toMatchObject({
      calls: 0,
      creditsCharged: "0",
    })
    expect(chargeMcpInTransaction).not.toHaveBeenCalled()
    collectModuleEvidence.mockResolvedValue({ ...evidence(), callDetail: { sif: 7 } })
    await query().expect(502)
    collectModuleEvidence.mockResolvedValue({ ...evidence(), callDetail: { sif: -1 } })
    await query().expect(502)
    expect(chargeMcpInTransaction).not.toHaveBeenCalled()
  })
  it("运营详情独立查询只取身份和历史信号，最多4次，不返回未来计划", async () => {
    const response = await query({ url: URL }, "/api/open/operation-plans/query").expect(200)
    expect(response.body).toMatchObject({
      asin: ASIN,
      title: "真实商品",
      operationScheme: {
        kind: "competitor_operations",
        basis: "external_data_and_rules",
        status: "available",
      },
      billing: {
        calls: 4,
        callDetail: { sif: 3, keepa: 1 },
        costCny: "0.495",
        creditsCharged: "5",
      },
    })
    expect(response.body).not.toHaveProperty("operationPlan")
    expect(response.body).not.toHaveProperty("priceCurve")
    expect(response.body).not.toHaveProperty("monthlySales")
    expect(collectOperationProductEvidence).toHaveBeenCalledWith("US", ASIN)
    expect(collectModuleEvidence).not.toHaveBeenCalledWith("US", [ASIN], "profile")
    expect(assertGatewayAffordable).toHaveBeenCalledWith(73, new Decimal("0.495"))
    expect(chargeMcpInTransaction).toHaveBeenCalledWith(
      {},
      73,
      expect.objectContaining({ source: "open.operation-plan.query", calls: 4 }),
      { invokeType: "API", unitPriceCny: new Decimal("0.12375") }
    )
  })
  it("运营详情无历史数据明确返回不可用，按成功的商品取数结算", async () => {
    const data = evidence()
    delete data.sif.trafficTrends
    data.keepa = null
    collectOperationProductEvidence.mockResolvedValue({ ...data, callDetail: { sif: 1 } })
    collectProductHistoryEvidence.mockRejectedValueOnce(new Error("history unavailable"))
    const response = await query({ url: URL }, "/api/open/operation-plans/query").expect(200)
    expect(response.body).toMatchObject({
      operationScheme: { status: "unavailable", rows: [], periodSignals: [], currentStage: null },
      billing: { calls: 1, callDetail: { sif: 1, keepa: 0 }, creditsCharged: "2" },
    })
  })
  it("运营详情预检遵守4次上限，未授权和非法链接不取数", async () => {
    caller.perCallMaxCny = new Decimal("0.5")
    await query({ url: URL }, "/api/open/operation-plans/query").expect(200)
    collectOperationProductEvidence.mockClear()
    caller.perCallMaxCny = new Decimal("0.49")
    await query({ url: URL }, "/api/open/operation-plans/query").expect(400)
    caller.isNiuniuOperationPlanEnabled = false
    await query({ url: URL }, "/api/open/operation-plans/query").expect(403)
    caller.isNiuniuOperationPlanEnabled = true
    await query(
      { url: "https://evil.test/dp/B0F15TM77B" },
      "/api/open/operation-plans/query"
    ).expect(400)
    expect(collectOperationProductEvidence).not.toHaveBeenCalled()
  })
  it("过滤无依据或数据不足的历史条目，不把固定未来90天当历史", () => {
    const result = buildHistoricalOperations(
      {
        bucketDays: 7,
        stage: "数据不足",
        weeks: [{ startDate: "2026-09-20" }, { startDate: "2026-10-01" }],
        rows: [
          {
            key: "stage",
            label: "阶段",
            truthLevel: "inference",
            cells: [
              { active: true, label: "数据不足", source: "sif" },
              { active: true, label: "增长", source: "sif" },
            ],
          },
        ],
      },
      "2026-09-22"
    )
    expect(result).toMatchObject({
      status: "unavailable",
      rows: [],
      startDate: null,
      currentStage: null,
    })
  })
})
