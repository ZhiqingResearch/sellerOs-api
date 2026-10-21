import { DomesticBusinessGateway } from "./domestic-business-gateway"
import { DomesticBusinessModels } from "./domestic-business-models"
import {
  UnauthorizedException,
  ValidationPipe,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { Decimal } from "@prisma/client/runtime/library"
import request from "supertest"
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard"
import { PermissionCacheService } from "../../auth/services/permission-cache.service"
import { PrismaService } from "../../prisma/prisma.service"
import { PromotionPlanAiController } from "../../promotion-plan/promotion-plan-ai.controller"
import { SmartPricingAiController } from "../../smart-pricing/smart-pricing-ai.controller"
import { UsageService } from "../../usage/usage.service"
import { BusinessAiService } from "./business-ai.service"

describe("推广计划与智能定价 AI HTTP 链路", () => {
  let app: INestApplication
  let permissions: Set<string>
  const assertFixedModuleAffordable = jest.fn()
  const gatewayPriceMultiplier = jest.fn()
  const chargeModel = jest.fn()
  const chargeModelInTransaction = jest.fn()
  const generateJson = jest.fn()
  const streamChat = jest.fn()
  const prisma = {
    aiGatewayModel: { findFirst: jest.fn().mockResolvedValue({ publicId: "qwen3.8-max" }) },
    businessAiRun: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
  }
  const billing = {
    costCny: "0.123456",
    currency: "CNY",
    model: "qwen3.8-max",
    requestId: "gateway-business-test",
    requestIds: ["gateway-business-test"],
  }
  const tokenUsage = { promptTokens: 10, completionTokens: 5, thinkingTokens: 2, totalTokens: 17 }
  const payload = { model: "qwen3.8-max", operation: "generate", userPrompt: "商品资料", temperature: 0.1 }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PromotionPlanAiController, SmartPricingAiController],
      providers: [
        BusinessAiService,
        DomesticBusinessModels,
        { provide: DomesticBusinessGateway, useValue: { generateJson, streamChat } },
        {
          provide: UsageService,
          useValue: { chargeModel, chargeModelInTransaction, gatewayPriceMultiplier, assertFixedModuleAffordable },
        },
        { provide: PrismaService, useValue: prisma },
        {
          provide: PermissionCacheService,
          useValue: {
            getForUser: async () => permissions,
            getLabelMap: async () => new Map(),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest()
          if (req.headers.authorization !== "Bearer test") throw new UnauthorizedException("未登录")
          req.user = { id: 7 }
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    assertFixedModuleAffordable.mockResolvedValue(undefined)
    permissions = new Set(["tool.promotion_plan", "tool.smart_pricing"])
    gatewayPriceMultiplier.mockResolvedValue(new Decimal("4"))
    chargeModel.mockResolvedValue({})
    chargeModelInTransaction.mockResolvedValue({})
    prisma.businessAiRun.findUnique.mockReset()
    prisma.businessAiRun.create.mockReset()
    prisma.businessAiRun.update.mockReset()
    prisma.businessAiRun.updateMany.mockReset()
    prisma.businessAiRun.findFirst.mockReset()
    prisma.$transaction.mockReset()
    generateJson.mockResolvedValue({ data: { result: "分析完成" }, billing, tokenUsage })
    streamChat.mockImplementation(async function* () {
      yield { type: "thinking", content: "正在分析" }
      yield { type: "text", content: '{"result":"分析完成"}' }
      yield { type: "usage", content: "", usage: tokenUsage }
      yield { type: "billing", content: "", billing }
    })
  })
  afterAll(async () => app.close())

  it.each([
    ["promotion-plan", "launch.plan"],
    ["smart-pricing", "pricing.quote"],
  ])("%s JSON 预检固定售价，最终归档前不扣费", async (module, source) => {
    const response = await request(app.getHttpServer())
      .post(`/api/${module}/ai/complete`)
      .set("Authorization", "Bearer test")
      .send({
        ...payload,
        responseFormat: "json_object",
        source: "listing.generate",
        costCny: 999,
        userId: 999,
      })
      .expect(201)
    expect(response.body).toEqual({ text: '{"result":"分析完成"}', billingHandled: true })
    expect(assertFixedModuleAffordable).toHaveBeenCalledWith(7, source)
    expect(chargeModel).not.toHaveBeenCalled()
  })

  it("流式响应完成后不计中间费用，不回传 usage", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/promotion-plan/ai/stream")
      .set("Authorization", "Bearer test")
      .send(payload)
      .expect(200)
    expect(response.text).toContain('"type":"thinking"')
    expect(response.text).toContain('"type":"text"')
    expect(response.text).not.toContain('"type":"usage"')
    expect(response.text).toContain('"type":"billing_handled"')
    expect(response.text).toContain("[DONE]")
    expect(assertFixedModuleAffordable).toHaveBeenCalledWith(7, "launch.plan")
    expect(chargeModel).not.toHaveBeenCalled()
  })

  it("余额不足返回 error，不调用模型", async () => {
    assertFixedModuleAffordable.mockRejectedValueOnce(new Error("积分余额不足"))
    const response = await request(app.getHttpServer())
      .post("/api/smart-pricing/ai/stream")
      .set("Authorization", "Bearer test")
      .send(payload)
      .expect(200)
    expect(response.text).toContain('"type":"error"')
    expect(response.text).toContain("积分余额不足")
    expect(streamChat).not.toHaveBeenCalled()
    expect(response.text).not.toContain("billing_handled")
    expect(response.text).not.toContain("[DONE]")
  })

  it("没有账单时 fail closed", async () => {
    generateJson.mockResolvedValueOnce({ data: {}, tokenUsage })
    await request(app.getHttpServer())
      .post("/api/smart-pricing/ai/complete")
      .set("Authorization", "Bearer test")
      .send({ ...payload, responseFormat: "json_object" })
      .expect(502)
    expect(chargeModel).not.toHaveBeenCalled()
  })

  it("相同运行号重试直接返回已保存正文，不重复请求模型或扣费", async () => {
    let storedRun: {
      id: number
      inputHash: string
      status: string
      outputText: string | null
      billing: object | null
    } | null = null
    prisma.businessAiRun.findUnique.mockImplementation(async (args: unknown) => {
      const input = args as { select?: { id?: boolean } }
      if (input.select?.id) return storedRun ? { id: storedRun.id } : null
      return storedRun
    })
    prisma.businessAiRun.create.mockImplementation(async (args: unknown) => {
      const input = args as { data: { inputHash: string } }
      storedRun = {
        id: 1,
        inputHash: input.data.inputHash,
        status: "RUNNING",
        outputText: null,
        billing: null,
      }
      return storedRun
    })
    prisma.businessAiRun.update.mockImplementation(async (args: unknown) => {
      const input = args as { data: { status?: string; outputText?: string; billing?: object } }
      if (!storedRun) throw new Error("运行记录不存在")
      storedRun = { ...storedRun, ...input.data }
      return storedRun
    })
    prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        usageLog: { findUnique: jest.fn().mockResolvedValue({ id: 9 }) },
        businessAiRun: {
          update: jest.fn().mockImplementation(async () => {
            if (storedRun) storedRun = { ...storedRun, status: "COMPLETED" }
          }),
        },
      })
    )

    const requestBody = {
      ...payload,
      runId: "promotion-plan-test-run",
      businessEventId: "promotion-plan-test-run",
      responseFormat: "json_object",
    }
    const first = await request(app.getHttpServer())
      .post("/api/promotion-plan/ai/complete")
      .set("Authorization", "Bearer test")
      .send(requestBody)
      .expect(201)
    const replay = await request(app.getHttpServer())
      .post("/api/promotion-plan/ai/complete")
      .set("Authorization", "Bearer test")
      .send(requestBody)
      .expect(201)

    expect(first.body).toEqual({ text: '{"result":"分析完成"}', billingHandled: true })
    expect(replay.body).toEqual(first.body)
    expect(generateJson).toHaveBeenCalledTimes(1)
    expect(assertFixedModuleAffordable).toHaveBeenCalledTimes(1)
    expect(chargeModelInTransaction).not.toHaveBeenCalled()
  })

  it("拒绝未登录及跨模块未授权调用", async () => {
    await request(app.getHttpServer())
      .post("/api/smart-pricing/ai/complete")
      .send(payload)
      .expect(401)
    permissions = new Set(["tool.promotion_plan"])
    await request(app.getHttpServer())
      .post("/api/smart-pricing/ai/complete")
      .set("Authorization", "Bearer test")
      .send(payload)
      .expect(403)
    expect(generateJson).not.toHaveBeenCalled()
    expect(streamChat).not.toHaveBeenCalled()
  })

  it.each([
    { userPrompt: "  " },
    { model: "gemini-unsafe" },
    { temperature: -1 },
    { operation: "unknown" },
  ])("无效参数在调用网关前被拒绝：%j", async override => {
    await request(app.getHttpServer())
      .post("/api/promotion-plan/ai/complete")
      .set("Authorization", "Bearer test")
      .send({ ...payload, ...override })
      .expect(400)
    expect(streamChat).not.toHaveBeenCalled()
    expect(generateJson).not.toHaveBeenCalled()
  })
})
