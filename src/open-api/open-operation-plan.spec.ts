import { INestApplication, ValidationPipe } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createHash, createHmac } from "node:crypto"
import request from "supertest"
import { PrismaService } from "../prisma/prisma.service"
import { OpenApiAuthGuard } from "./open-api-auth.guard"
import { OpenOperationPlanController } from "./open-operation-plan.controller"
import { OpenOperationPlanService } from "./open-operation-plan.service"

const URL = "https://www.amazon.com/dp/B09VLJJPL6"
const REQUEST_ID = "a".repeat(64)
describe("牛牛生成入口删除与历史快照兼容", () => {
  let app: INestApplication
  const caller = {
    appId: "niuniu",
    appSecret: "test-secret",
    status: "ACTIVE",
    isNiuniuOperationPlanEnabled: true,
  }
  const findUnique = jest.fn()
  const findRun = jest.fn()
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OpenOperationPlanController],
      providers: [
        OpenApiAuthGuard,
        OpenOperationPlanService,
        {
          provide: PrismaService,
          useValue: {
            openApiApp: { findUnique: () => caller },
            openOperationPlanRequest: { findUnique },
            businessAiRun: { findUnique: findRun },
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
    caller.isNiuniuOperationPlanEnabled = true
    findUnique.mockReset()
    findRun.mockReset().mockResolvedValue(null)
  })
  function headers(body = "") {
    const timestamp = String(Date.now()),
      nonce = "test"
    const sign = createHmac("sha256", caller.appSecret)
      .update(
        [caller.appId, timestamp, nonce, createHash("sha256").update(body).digest("hex")].join("\n")
      )
      .digest("hex")
    return {
      "Content-Type": "application/json",
      "x-app-id": caller.appId,
      "x-timestamp": timestamp,
      "x-nonce": nonce,
      "x-sign": sign,
    }
  }
  it("旧生成入口已删除，返回404且不读写生成记录", async () => {
    const body = JSON.stringify({ url: URL })
    await request(app.getHttpServer())
      .post("/api/open/operation-plans/generate")
      .set(headers(body))
      .send(body)
      .expect(404)
    expect(findUnique).not.toHaveBeenCalled()
    expect(findRun).not.toHaveBeenCalled()
  })
  it.each([1, 2])("保留schemaVersion=%s旧结果快照原样读取，不补扣", async version => {
    const result = { schemaVersion: version, saved: "历史快照" }
    findUnique.mockResolvedValue({ requestId: REQUEST_ID, result })
    const response = await request(app.getHttpServer())
      .get(`/api/open/operation-plans/${REQUEST_ID}`)
      .set(headers())
      .expect(200)
    expect(response.body).toEqual({
      requestId: REQUEST_ID,
      status: "COMPLETED",
      billingHandled: true,
      result,
    })
    expect(findUnique).toHaveBeenCalledWith({
      where: { appId_requestId: { appId: "niuniu", requestId: REQUEST_ID } },
    })
    expect(findRun).not.toHaveBeenCalled()
  })
  it("未交付记录仅查状态；缺失记录404", async () => {
    findUnique.mockResolvedValueOnce({
      requestId: REQUEST_ID,
      result: null,
      input: { schemaVersion: 2 },
      billingUserId: 73,
      runId: "legacy",
    })
    const response = await request(app.getHttpServer())
      .get(`/api/open/operation-plans/${REQUEST_ID}`)
      .set(headers())
      .expect(200)
    expect(response.body).toMatchObject({ status: "PENDING", billingHandled: false, result: null })
    findUnique.mockResolvedValueOnce(null)
    await request(app.getHttpServer())
      .get(`/api/open/operation-plans/${REQUEST_ID}`)
      .set(headers())
      .expect(404)
  })
  it("历史查询仍校验签名和接入权限", async () => {
    await request(app.getHttpServer())
      .get(`/api/open/operation-plans/${REQUEST_ID}`)
      .expect(401)
    caller.isNiuniuOperationPlanEnabled = false
    await request(app.getHttpServer())
      .get(`/api/open/operation-plans/${REQUEST_ID}`)
      .set(headers())
      .expect(403)
  })
})
