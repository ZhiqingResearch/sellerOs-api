import { ValidationPipe, type ExecutionContext, type INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { AiGatewayModelController } from "../../ai-gateway/ai-gateway-model.controller"
import { AiGatewayModelService } from "../../ai-gateway/ai-gateway-model.service"
import { AiGatewayProvider } from "../../ai-gateway/ai-gateway.provider"
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../../auth/guards/permissions.guard"
import { CompetitorAnalysisController } from "../../competitor-analysis/competitor-analysis.controller"
import { CompetitorAnalysisService } from "../../competitor-analysis/competitor-analysis.service"
import { HistoryService } from "../../history/history.service"
import { ListingAiPermissionGuard } from "../../listing/guards/listing-ai-permission.guard"
import { ListingAiService } from "../../listing/listing-ai.service"
import { ListingDocumentService } from "../../listing/listing-document.service"
import { ListingGenerationService } from "../../listing/listing-generation.service"
import { ListingRunService } from "../../listing/listing-run.service"
import { ListingScoreService } from "../../listing/listing-score.service"
import { ListingController } from "../../listing/listing.controller"
import { PrismaService } from "../../prisma/prisma.service"
import { PromotionPlanAiController } from "../../promotion-plan/promotion-plan-ai.controller"
import { SmartPricingAiController } from "../../smart-pricing/smart-pricing-ai.controller"
import { UsageService } from "../../usage/usage.service"
import { BusinessAiService } from "./business-ai.service"
import { DomesticBusinessModels } from "./domestic-business-models"

const runId = "832c13ca-7715-4515-b17a-236fab52a9ba"
const generation = { operation: "generation", userPrompt: "商品资料" }
const cases = [
  ["/listing/ai/complete", generation],
  ["/listing/ai/stream", generation],
  ["/listing/ai/complete", { operation: "score", userPrompt: "待评分资料" }],
  [
    "/listing/documents/analyze",
    {
      objectKey: "listing-documents/7/test.pdf",
      fileName: "test.pdf",
      mimeType: "application/pdf",
      fileSize: 100,
    },
  ],
  ["/promotion-plan/ai/stream", { operation: "generate", userPrompt: "商品资料" }],
  ["/smart-pricing/ai/stream", { operation: "research", userPrompt: "商品资料" }],
  ["/competitor-analysis/analyze", { asins: ["B000000001"], country: "US" }],
  ["/competitor-analysis/summary", { asins: ["B000000001"], country: "US", modules: {} }],
  ["/promotion-plan/ai/complete", { operation: "generate", userPrompt: "商品资料" }],
  ["/smart-pricing/ai/complete", { operation: "research", userPrompt: "商品资料" }],
] as const

describe("国产模型实际 HTTP 入口校验", () => {
  let app: INestApplication
  const findFirst = jest.fn()
  const findMany = jest.fn()
  const invoke = jest.fn().mockResolvedValue({ text: "成功" })
  const stream = jest.fn(async function* () {
    yield await Promise.resolve({ type: "text" as const, content: "成功" })
  })
  beforeAll(async () => {
    const builder = Test.createTestingModule({
      controllers: [
        ListingController,
        CompetitorAnalysisController,
        PromotionPlanAiController,
        SmartPricingAiController,
        AiGatewayModelController,
      ],
      providers: [
        DomesticBusinessModels,
        AiGatewayModelService,
        { provide: AiGatewayProvider, useValue: {} },
        { provide: UsageService, useValue: {} },
        { provide: PrismaService, useValue: { aiGatewayModel: { findFirst, findMany } } },
        { provide: ListingAiService, useValue: { complete: invoke, stream } },
        { provide: ListingScoreService, useValue: { complete: invoke, stream } },
        { provide: ListingDocumentService, useValue: { analyze: invoke } },
        { provide: ListingGenerationService, useValue: { submit: invoke, finish: invoke } },
        { provide: ListingRunService, useValue: {} },
        { provide: HistoryService, useValue: {} },
        { provide: CompetitorAnalysisService, useValue: { analyze: invoke, summarize: invoke } },
        { provide: BusinessAiService, useValue: { complete: invoke, stream } },
      ],
    })
    builder.overrideGuard(JwtAuthGuard).useValue({
      canActivate(context: ExecutionContext) {
        context.switchToHttp().getRequest<{ user: { id: number } }>().user = { id: 7 }
        return true
      },
    })
    for (const guard of [PermissionsGuard, ListingAiPermissionGuard])
      builder.overrideGuard(guard).useValue({ canActivate: () => true })
    const module = await builder.compile()
    app = module.createNestApplication({ logger: false })
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(() => {
    jest.clearAllMocks()
    findFirst.mockResolvedValue({ publicId: "qwen3.8-max" })
  })

  it.each(cases)("%s 要求前端必传 model", async (path, body) => {
    await request(app.getHttpServer()).post(`/api${path}`).send(body).expect(400)
    expect(invoke).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
  })
  it.each(cases)("%s 在开流或执行业务前拒绝停用模型", async (path, body) => {
    findFirst.mockResolvedValue(null)
    await request(app.getHttpServer())
      .post(`/api${path}`)
      .send({ ...body, model: "MiniMax-M3" })
      .expect(400)
    expect(invoke).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
  })
  it.each(cases)("%s 原样传递前端所选国产模型", async (path, body) => {
    for (const model of ["qwen3.8-max", "MiniMax-M3"]) {
      await request(app.getHttpServer())
        .post(`/api${path}`)
        .send({ ...body, model })
        .expect(path.endsWith("stream") ? 200 : 201)
      const call: unknown = path.endsWith("stream")
        ? stream.mock.calls.at(-1)
        : invoke.mock.calls.at(-1)
      expect(call).toEqual(expect.arrayContaining([expect.objectContaining({ model })]))
    }
  })
  it.each(["main", "longTitle"])("入队前拒绝 %s 中的旧模型", async field => {
    const body = {
      runId,
      attemptId: runId,
      planIndex: 0,
      context: {},
      main: { ...generation, model: "qwen3.8-max" },
      [field]: { ...generation, model: "ZQ-Think-Flash" },
    }
    await request(app.getHttpServer()).post("/api/listing/generations").send(body).expect(400)
    expect(invoke).not.toHaveBeenCalled()
  })
  it("自动评分嵌套模型也必须在数据库启用", async () => {
    findFirst.mockResolvedValue(null)
    await request(app.getHttpServer())
      .post(`/api/listing/generations/${runId}/result`)
      .send({
        status: "COMPLETED",
        autoScore: { operation: "score", userPrompt: "评分", model: "MiniMax-M3" },
      })
      .expect(400)
    expect(invoke).not.toHaveBeenCalled()
  })
  it("目录接口仅返回数据库允许的两个模型", async () => {
    const items = [
      { publicId: "qwen3.8-max", displayName: "Qwen" },
      { publicId: "MiniMax-M3", displayName: "MiniMax" },
    ]
    findMany.mockResolvedValue(items)
    const response = await request(app.getHttpServer())
      .get("/api/ai-models?modality=TEXT&category=SELLER_BUSINESS")
      .expect(200)
    expect(response.body.items).toMatchObject(items)
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          modality: "TEXT",
          category: "SELLER_BUSINESS",
          enabled: true,
          gatewayActive: true,
        },
      })
    )
  })
})
