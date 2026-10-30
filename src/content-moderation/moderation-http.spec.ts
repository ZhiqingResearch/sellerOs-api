import Core from "@alicloud/pop-core"
import { type ExecutionContext, type INestApplication } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { APP_PIPE } from "@nestjs/core"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { BeautyWorkflowController } from "../beauty-workflow/beauty-workflow.controller"
import { BeautyWorkflowService } from "../beauty-workflow/beauty-workflow.service"
import { AliyunContentModerationProvider } from "../common/providers/aliyun-content-moderation.provider"
import { CustomerController } from "../customer/customer.controller"
import { CustomerService } from "../customer/customer.service"
import { PublicResourceService } from "../customer/public-resource.service"
import { GenerateController } from "../image-generation/generate.controller"
import { GenerateService } from "../image-generation/generate.service"
import { ImageToImageController } from "../image-generation/image-to-image.controller"
import { ImageToImageService } from "../image-generation/image-to-image.service"
import { InternalImageToImageController } from "../image-generation/internal-image-to-image.controller"
import {
  LocalRedrawAuthGuard,
  LocalRedrawController,
} from "../image-generation/local-redraw.controller"
import { LocalRedrawService } from "../image-generation/local-redraw.service"
import { TextToImageController } from "../image-generation/text-to-image.controller"
import { TextToImageService } from "../image-generation/text-to-image.service"
import { PrismaService } from "../prisma/prisma.service"
import { InternalGenerationGuard } from "../video-project/internal-generation.guard"
import { contentInputs } from "./content-inputs"
import { ContentModerationPipe } from "./content-moderation.pipe"
import { ContentModerationService } from "./content-moderation.service"

jest.mock("@alicloud/pop-core", () => jest.fn())

describe("生成入口HTTP前置审核：实际管道、解析和决策", () => {
  let app: INestApplication
  const vendor = jest.fn()
  const business = jest.fn().mockResolvedValue({
    ok: true,
    success: true,
    taskId: 1,
    jobId: "job",
    generatedImages: [],
    items: [],
  })
  const spaces = {
    uploadBuffer: jest.fn(),
    deleteObject: jest.fn().mockResolvedValue(undefined),
    generateSignedDownloadUrl: jest.fn().mockResolvedValue("https://assets.test/upload.png"),
  }
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ id: 7 }) } }
  const normal = { Code: 200, Data: { RiskLevel: "none", Result: [] } }
  const cases = [
    {
      path: "/api/image-generation/generate",
      body: { form: JSON.stringify({ prompt: "商品图" }) },
    },
    {
      path: "/api/image-generation/image-to-image",
      body: { form: JSON.stringify({ prompt: "改图" }) },
    },
    {
      path: "/api/internal/generation/image/i2i",
      body: { phone: "credential-only", form: JSON.stringify({ prompt: "内部改图" }) },
    },
    { path: "/api/image-generation/local-redraw", body: { prompt: "局部重绘" } },
    {
      path: "/api/image-generation/text-to-image",
      body: { provider: "ZQ-Image-1", prompt: "文生图" },
    },
    {
      path: "/api/customer/storyboards/generate-videos",
      body: { items: [{ id: 1, duration: 4, prompt: "分镜内容" }] },
    },
    {
      path: "/api/beauty-project/1/tasks/batch",
      body: {
        digitalHumanId: 1,
        beautyInput: {},
        tasks: [
          {
            groupIndex: 0,
            segmentIndex: 1,
            segmentType: "BASE_MAKEUP",
            prompt: "美妆内容",
            durationSec: 6,
            referenceImageUrls: ["https://assets.test/a.png"],
          },
        ],
      },
    },
  ]

  beforeAll(async () => {
    ;(Core as unknown as jest.Mock).mockImplementation(() => ({ request: vendor }))
    const config = new ConfigService({
      ZQ_ACCESS_KEY_ID: "test",
      ZQ_ACCESS_KEY_SECRET: "test",
      SPACES_BASE_URL: "https://assets.test",
    })
    const provider = new AliyunContentModerationProvider(config)
    const moderation = new ContentModerationService(
      provider,
      spaces as never,
      {
        freeze: jest.fn(async (value, root, technical) => ({
          value,
          inputs: contentInputs(value, root, technical),
        })),
      } as never
    )
    const auth = {
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user: { id: number } }>().user = { id: 7 }
        return true
      },
    }
    const module = await Test.createTestingModule({
      controllers: [
        GenerateController,
        ImageToImageController,
        InternalImageToImageController,
        LocalRedrawController,
        TextToImageController,
        CustomerController,
        BeautyWorkflowController,
      ],
      providers: [
        { provide: ContentModerationService, useValue: moderation },
        { provide: APP_PIPE, useClass: ContentModerationPipe },
        { provide: PrismaService, useValue: prisma },
        ...[GenerateService, ImageToImageService, LocalRedrawService, TextToImageService].map(
          provide => ({ provide, useValue: { create: business } })
        ),
        { provide: CustomerService, useValue: { generateStoryboardVideos: business } },
        { provide: PublicResourceService, useValue: {} },
        { provide: BeautyWorkflowService, useValue: { createTaskBatch: business } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(auth)
      .overrideGuard(PermissionsGuard)
      .useValue(auth)
      .overrideGuard(InternalGenerationGuard)
      .useValue(auth)
      .overrideGuard(LocalRedrawAuthGuard)
      .useValue(auth)
      .compile()
    app = module.createNestApplication({ logger: false })
    app.setGlobalPrefix("api")
    await app.init()
    await app.listen(0, "127.0.0.1")
  })
  beforeEach(() => {
    jest.clearAllMocks()
    vendor.mockResolvedValue(normal)
  })
  afterAll(async () => {
    await app.close()
  })

  describe.each(cases)("$path", ({ path, body }) => {
    it.each(["rejected", "unavailable", "unknown"])("%s 时不进入业务创建", async mode => {
      if (mode === "unavailable") vendor.mockRejectedValue(new Error("network timeout"))
      else
        vendor.mockResolvedValue({
          Code: 200,
          Data: {
            RiskLevel: mode === "rejected" ? "high" : "future_level",
            Result: [{ Label: "new-risk", Description: "测试风险" }],
          },
        })
      const response = await request(app.getHttpServer()).post(path).send(body)
      expect(response.status).toBe(mode === "rejected" ? 400 : 503)
      expect(vendor).toHaveBeenCalled()
      expect(business).not.toHaveBeenCalled()
    })
    it("审核通过后才进入业务，防止全拒绝造成假阳性", async () => {
      const response = await request(app.getHttpServer()).post(path).send(body)
      expect(response.status).toBeGreaterThanOrEqual(200)
      expect(response.status).toBeLessThan(300)
      expect(vendor).toHaveBeenCalled()
      expect(business).toHaveBeenCalledTimes(1)
      expect(vendor.mock.invocationCallOrder.at(-1)).toBeLessThan(
        business.mock.invocationCallOrder[0]
      )
      expect(JSON.stringify(vendor.mock.calls)).not.toContain("credential-only")
    })
  })

  it("multipart嵌套参考图不是只审核JSON文本；图片拒绝时不会建任务", async () => {
    vendor.mockImplementation(async (action: string) =>
      action === "ImageModeration"
        ? { Code: 200, Data: { RiskLevel: "high", Result: [{ Label: "risk_image" }] } }
        : normal
    )
    await request(app.getHttpServer())
      .post("/api/image-generation/generate")
      .field(
        "form",
        JSON.stringify({ prompt: "普通提示词", referenceImageUrls: ["https://assets.test/a.png"] })
      )
      .expect(400)
    expect(vendor.mock.calls.some(([action]) => action === "ImageModeration")).toBe(true)
    expect(business).not.toHaveBeenCalled()
  })

  it("实际multipart上传文件也必须通过审核，拒绝时不进入图生图业务", async () => {
    vendor.mockImplementation(async (action: string) =>
      action === "ImageModeration"
        ? { Code: 200, Data: { RiskLevel: "high", Result: [{ Label: "risk_image" }] } }
        : normal
    )
    await request(app.getHttpServer())
      .post("/api/image-generation/image-to-image")
      .field("form", JSON.stringify({ prompt: "普通提示词" }))
      .attach("main", Buffer.from("fixture"), { filename: "fixture.png", contentType: "image/png" })
      .expect(400)
    expect(spaces.uploadBuffer).toHaveBeenCalled()
    expect(business).not.toHaveBeenCalled()
  })

  it.each(["generate", "image-to-image"])("%s 的审核拒绝保留真实原因及错误码", async route => {
    vendor.mockResolvedValue({ Code: 200, Data: { RiskLevel: "high", Result: [] } })
    const response = await request(app.getHttpServer())
      .post(`/api/image-generation/${route}`)
      .field("form", JSON.stringify({ prompt: "测试内容" }))
      .expect(400)
    expect(response.body).toEqual({
      error: "输入内容未通过安全审核，请修改后重试",
      code: "MODERATION_REJECTED",
    })
    expect(business).not.toHaveBeenCalled()
  })

  it.each(["generate", "image-to-image"])("%s 的真实multipart格式错误保留原协议", async route => {
    const response = await request(app.getHttpServer())
      .post(`/api/image-generation/${route}`)
      .set("Content-Type", "multipart/form-data")
      .send("invalid boundary")
      .expect(400)
    expect(response.body).toEqual({ error: "Invalid multipart/form-data body" })
    expect(vendor).not.toHaveBeenCalled()
    expect(business).not.toHaveBeenCalled()
  })

  it.each(["none", "high"])("公网商品源图无需域名名单，但仍须审核：%s", async riskLevel => {
    vendor.mockImplementation((action: string) =>
      Promise.resolve(
        action === "ImageModeration"
          ? { Code: 200, Data: { RiskLevel: riskLevel, Result: [] } }
          : normal
      )
    )
    const response = await request(app.getHttpServer())
      .post("/api/image-generation/generate")
      .field(
        "form",
        JSON.stringify({
          prompt: "生成电脑",
          productInfo: {
            commerceData: { sourceImages: ["https://m.media-amazon.com/images/a.jpg"] },
          },
        })
      )
    expect(vendor.mock.calls.some(([action]) => action === "ImageModeration")).toBe(true)
    if (riskLevel === "none") {
      expect(response.status).toBe(201)
      expect(business).toHaveBeenCalledTimes(1)
    } else {
      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ code: "MODERATION_REJECTED" })
      expect(business).not.toHaveBeenCalled()
    }
  })

  it("危险商品源图被公网地址校验拒绝时，不再伪装为multipart错误", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/image-generation/generate")
      .field(
        "form",
        JSON.stringify({
          prompt: "生成电脑",
          productInfo: {
            commerceData: { sourceImages: ["https://127.0.0.1/sample.jpg"] },
          },
        })
      )
      .expect(400)
    expect(response.body).toEqual({
      error: "素材地址必须是安全的公网 HTTPS 域名地址",
      code: "MODERATION_INVALID_INPUT",
    })
    expect(business).not.toHaveBeenCalled()
  })
})
