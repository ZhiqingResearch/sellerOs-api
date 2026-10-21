import { ValidationPipe, type INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import type { Server } from "node:http"
import request from "supertest"
import { AiGatewayModelController } from "../ai-gateway/ai-gateway-model.controller"
import { AiGatewayModelService } from "../ai-gateway/ai-gateway-model.service"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { InternalGenerationController } from "./internal-generation.controller"
import { InternalGenerationGuard } from "./internal-generation.guard"
import { InternalGenerationService } from "./internal-generation.service"

describe("InternalGenerationController 模型目录筛选", () => {
  let app: INestApplication
  const createVideoTask = jest.fn().mockResolvedValue({ taskId: 900, status: "GENERATING" })
  const findAll = jest.fn().mockResolvedValue({ items: [] })
  const quote = jest.fn().mockResolvedValue({ variants: [] })

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [InternalGenerationController, AiGatewayModelController],
      providers: [
        { provide: InternalGenerationService, useValue: { createVideoTask } },
        { provide: AiGatewayModelService, useValue: { findAll, quote } },
      ],
    })
      .overrideGuard(InternalGenerationGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = module.createNestApplication()
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
  })

  beforeEach(() => jest.clearAllMocks())
  afterAll(async () => app.close())

  it.each(["/api/ai-models/quote", "/api/internal/generation/models/quote"])(
    "%s 只传模型和配置即可报价，不需要提示词或时长",
    async path => {
      const body = {
        category: "NORMAL",
        publicId: "sourcing-test-video",
        params: { mode: "image_to_video", resolution: "720p" },
      }
      await request(app.getHttpServer<Server>()).post(path).send(body).expect(201, { variants: [] })
      expect(quote).toHaveBeenCalledWith(body)
    }
  )

  it("提交保留 category 和模型参数，移除额外顶层字段", async () => {
    const body = {
      phone: "13800000001",
      category: "REFERENCE",
      request: {
        model: "shared-model",
        prompt: "x",
        mode: "reference_to_video",
        resolution: "480p",
      },
    }
    await request(app.getHttpServer<Server>())
      .post("/api/internal/generation/video-tasks")
      .send({ ...body, unexpected: "remove-me" })
      .expect(201)
    expect(createVideoTask).toHaveBeenCalledWith(body)
  })

  it.each([{}, { model: "m" }, { model: "", prompt: "x" }, { model: "m", prompt: " " }])(
    "拒绝缺少模型或提示词的请求 %j",
    async params => {
      await request(app.getHttpServer<Server>())
        .post("/api/internal/generation/video-tasks")
        .send({ phone: "13800000001", category: "REFERENCE", request: params })
        .expect(400)
      expect(createVideoTask).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, null, "", "   ", 42, "x".repeat(51)])(
    "拒绝无效业务分类 %j",
    async category => {
      await request(app.getHttpServer<Server>())
        .post("/api/internal/generation/video-tasks")
        .send({ phone: "13800000001", category, request: { model: "m", prompt: "x" } })
        .expect(400)
      expect(createVideoTask).not.toHaveBeenCalled()
    }
  )

  it.each([
    { modality: "VIDEO", category: "MOTION_CONTROL" },
    { modality: "VIDEO", category: "BEAUTY" },
    { modality: "IMAGE", category: "IMAGE_GENERATION" },
  ])("将 $modality / $category 筛选完整传入目录服务", async query => {
    await request(app.getHttpServer<Server>())
      .get("/api/internal/generation/models")
      .query({ ...query, unexpected: "remove-me" })
      .expect(200, { items: [] })

    expect(findAll).toHaveBeenCalledTimes(1)
    expect(findAll).toHaveBeenCalledWith(query)
  })

  it.each([{}, { modality: "IMAGE" }, { modality: "VIDEO" }, { category: "MOTION_CONTROL" }])(
    "允许省略内部目录筛选条件：%j",
    async query => {
      await request(app.getHttpServer<Server>())
        .get("/api/internal/generation/models")
        .query(query)
        .expect(200, { items: [] })

      expect(findAll).toHaveBeenCalledWith(query)
    }
  )

  it.each([
    { modality: "INVALID", category: "MOTION_CONTROL" },
    { modality: "VIDEO", category: "" },
    { modality: "IMAGE", category: "x".repeat(51) },
  ])("拒绝已提供但非法的筛选条件：%j", async query => {
    await request(app.getHttpServer<Server>())
      .get("/api/internal/generation/models")
      .query(query)
      .expect(400)

    expect(findAll).not.toHaveBeenCalled()
  })
})
