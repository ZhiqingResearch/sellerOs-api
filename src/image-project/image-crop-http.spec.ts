import { ExecutionContext, INestApplication, ValidationPipe } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { ImageCropController } from "./image-crop.controller"
import { ImageCropService } from "./image-crop.service"

describe("图片裁剪 HTTP 契约", () => {
  let app: INestApplication
  const service = {
    uploadUrl: jest
      .fn()
      .mockResolvedValue({ uploadUrl: "signed-put", publicUrl: "https://cdn.example/crop.png" }),
    save: jest
      .fn()
      .mockResolvedValue({ id: 501, generationMode: "CROP", generatedImages: [{ id: 601 }] }),
  }
  const body = {
    idempotencyKey: "c64f5c10-828e-48c8-aabc-e5820a792846",
    sourceImageId: 101,
    url: "https://cdn.example/crop.png",
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ImageCropController],
      providers: [{ provide: ImageCropService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest<{ user: { id: number } }>().user = { id: 7 }
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
  })
  beforeEach(() => jest.clearAllMocks())
  afterAll(async () => app.close())

  it("获取凭证和保存均返回 HTTP 200 裸对象，用户只能由登录态取得", async () => {
    await request(app.getHttpServer())
      .post("/api/image-project/crops/upload-url")
      .send({})
      .expect(200)
    expect(service.uploadUrl).toHaveBeenCalledWith(7)
    const response = await request(app.getHttpServer())
      .post("/api/image-project/3/crops")
      .send({ ...body, userId: 8 })
      .expect(200)
    expect(service.save).toHaveBeenCalledWith(3, body, 7)
    expect(response.body).toEqual({
      id: 501,
      generationMode: "CROP",
      generatedImages: [{ id: 601 }],
    })
  })

  it.each([
    {},
    { ...body, sourceImageId: "101" },
    { ...body, sourceImageId: -1 },
    { ...body, sourceImageId: Number.MAX_SAFE_INTEGER + 1 },
    { ...body, idempotencyKey: "invalid" },
    { ...body, url: "http://cdn.example/crop.png" },
  ])("非法参数在保存前返回 400：%j", async input => {
    await request(app.getHttpServer()).post("/api/image-project/3/crops").send(input).expect(400)
    expect(service.save).not.toHaveBeenCalled()
  })
})
