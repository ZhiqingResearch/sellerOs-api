import { ExecutionContext, INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PrismaService } from "../prisma/prisma.service"
import { LocalRedrawAuthGuard, LocalRedrawController } from "./local-redraw.controller"
import { LocalRedrawService } from "./local-redraw.service"

describe("统一重绘 HTTP 与身份来源", () => {
  let app: INestApplication
  const create = jest.fn().mockResolvedValue({ success: true, taskId: 71 })
  const findUnique = jest.fn().mockResolvedValue({ id: 8 })
  const previousToken = process.env.INTERNAL_GENERATION_TOKEN
  beforeAll(async () => {
    process.env.INTERNAL_GENERATION_TOKEN = "test-internal"
    jest
      .spyOn(JwtAuthGuard.prototype, "canActivate")
      .mockImplementation((ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user: { id: number } }>().user = { id: 7 }
        return true
      })
    const module = await Test.createTestingModule({
      controllers: [LocalRedrawController],
      providers: [
        LocalRedrawAuthGuard,
        { provide: LocalRedrawService, useValue: { create } },
        { provide: PrismaService, useValue: { user: { findUnique } } },
      ],
    }).compile()
    app = module.createNestApplication()
    app.setGlobalPrefix("api")
    await app.init()
  })
  afterAll(async () => {
    await app.close()
    if (previousToken === undefined) delete process.env.INTERNAL_GENERATION_TOKEN
    else process.env.INTERNAL_GENERATION_TOKEN = previousToken
    jest.restoreAllMocks()
  })
  beforeEach(() => {
    create.mockClear()
    findUnique.mockClear()
  })
  it("JSON 项目重绘走 JWT 用户和 platform 来源", async () => {
    await request(app.getHttpServer())
      .post("/api/image-generation/local-redraw")
      .send({
        sourceImageId: 23,
        prompt: "移动文字",
        mainImageUrls: ["https://cdn.example.com/marked.png"],
      })
      .expect(200)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ sourceImageId: 23 }),
      {},
      7,
      "platform"
    )
    expect(findUnique).not.toHaveBeenCalled()
  })
  it("同一 URL 接收 VidFlow 内部令牌与 multipart，并保留原图和标注图顺序", async () => {
    await request(app.getHttpServer())
      .post("/api/image-generation/local-redraw")
      .set("X-Internal-Token", "test-internal")
      .field("phone", "test-phone")
      .field("form", JSON.stringify({ prompt: "改色" }))
      .attach("main", Buffer.from("original"), "original.png")
      .attach("refs", Buffer.from("marked"), "marked.png")
      .expect(200)
    expect(findUnique).toHaveBeenCalledWith({
      where: { phone: "test-phone" },
      select: { id: true },
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "改色" }),
      expect.objectContaining({
        main: [expect.objectContaining({ buffer: Buffer.from("original") })],
        refs: [expect.objectContaining({ buffer: Buffer.from("marked") })],
      }),
      8,
      "vidflowos"
    )
  })
  it("无效内部令牌拒绝，不能回落到 JWT 冒充 VidFlow", async () => {
    await request(app.getHttpServer())
      .post("/api/image-generation/local-redraw")
      .set("X-Internal-Token", "wrong")
      .send({ phone: "test-phone", prompt: "改色" })
      .expect(503)
    expect(create).not.toHaveBeenCalled()
    expect(findUnique).not.toHaveBeenCalled()
  })
  it("公开 multipart 携带 phone 不会改变 JWT 用户或来源", async () => {
    await request(app.getHttpServer())
      .post("/api/image-generation/local-redraw")
      .field("phone", "another-user")
      .field("form", JSON.stringify({ prompt: "改色" }))
      .expect(200)
    expect(create).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), 7, "platform")
    expect(findUnique).not.toHaveBeenCalled()
  })
  it("前端不需要 provider/尺寸字段，多余模型控制字段直接拒绝", async () => {
    await request(app.getHttpServer())
      .post("/api/image-generation/local-redraw")
      .send({ prompt: "改色", provider: "ZQ-Image-3" })
      .expect(400)
    expect(create).not.toHaveBeenCalled()
  })
})
