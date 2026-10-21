import { ChetaidouResultService } from "./chetaidou-result.service"
import { INestApplication, ValidationPipe } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { ChetaidouController } from "./chetaidou.controller"
import { ChetaidouService } from "./chetaidou.service"

describe("车泰斗工作区 HTTP 契约", () => {
  let app: INestApplication
  const workspaceId = "430bf253-e97c-49fb-8bdc-f2e80931c690"
  const service = {
    resetDraft: jest.fn().mockResolvedValue({ workspaceId, revision: 2 }),
    restoreAdjustment: jest.fn().mockResolvedValue({ workspaceId, revision: 2 }),
    listResults: jest.fn().mockResolvedValue({ total: 0, items: [] }),
    createTask: jest.fn().mockResolvedValue({ taskId: workspaceId }),
    cropUploadUrl: jest
      .fn()
      .mockResolvedValue({ uploadUrl: "signed-put", publicUrl: "https://assets.example/crop.png" }),
    saveCrop: jest.fn().mockResolvedValue({ resultId: 501, status: "SUCCEEDED" }),
  }
  const results = { inpaint: jest.fn().mockResolvedValue({ taskId: workspaceId }), saveTemplate: jest.fn().mockResolvedValue({ templateId: 1 }), saveMaterial: jest.fn().mockResolvedValue({ poolImageId: 1 }) }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ChetaidouController],
      providers: [{ provide: ChetaidouService, useValue: service }, { provide: ChetaidouResultService, useValue: results }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { id: 7 }
          return true
        },
      })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix("api")
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
  })
  beforeEach(() => jest.clearAllMocks())
  afterAll(async () => app.close())

  it("裁剪改用公开直传凭证和 JSON 地址，保存返回 200", async () => {
    await request(app.getHttpServer()).post("/api/chetaidou/crops/upload-url").send({}).expect(200)
    expect(service.cropUploadUrl).toHaveBeenCalledWith(7)
    const body = { idempotencyKey: workspaceId, url: "https://assets.example/crop.png" }
    const result = await request(app.getHttpServer())
      .post("/api/chetaidou/results/101/crops")
      .send(body)
      .expect(200)
    expect(result.body).toEqual({ resultId: 501, status: "SUCCEEDED" })
    expect(service.saveCrop).toHaveBeenCalledWith(7, 101, body.url, workspaceId)
    service.saveCrop.mockClear()
    for (const invalid of [
      { idempotencyKey: workspaceId },
      { ...body, idempotencyKey: "invalid" },
      { ...body, url: "not-url" },
    ]) {
      await request(app.getHttpServer())
        .post("/api/chetaidou/results/101/crops")
        .send(invalid)
        .expect(400)
    }
    await request(app.getHttpServer())
      .post("/api/chetaidou/results/101/crops")
      .field("idempotencyKey", workspaceId)
      .attach("file", Buffer.from("png"), "crop.png")
      .expect(400)
    expect(service.saveCrop).not.toHaveBeenCalled()
  })
  it("重绘 multipart 校验嵌套坐标，不合法输入不调用服务", async () => {
    const path = "/api/chetaidou/results/310/inpaint"
    const form = { idempotencyKey: workspaceId, sourceWidth: 100, sourceHeight: 100,
      annotatedBoxes: [{ n: 1, x: 0, y: 0, w: 0.5, h: 0.5, instruction: "改背景" }] }
    await request(app.getHttpServer()).post(path).field("form", "bad-json").expect(400)
    await request(app.getHttpServer()).post(path).field("form", JSON.stringify({ ...form, annotatedBoxes: [{ ...form.annotatedBoxes[0], x: -1 }] })).expect(400)
    expect(results.inpaint).not.toHaveBeenCalled()
    await request(app.getHttpServer()).post(path).field("form", JSON.stringify(form)).attach("annotatedImage", Buffer.from("image"), { filename: "annotated.png", contentType: "image/png" }).expect(202)
    expect(results.inpaint).toHaveBeenCalledWith(7, 310, expect.objectContaining(form), expect.objectContaining({ buffer: expect.any(Buffer) }), undefined)
  })
  it("保存接口保留当前用户，校验幂等键并返回 200", async () => {
    await request(app.getHttpServer()).post("/api/chetaidou/results/310/save-to-template").send({ mode: "CREATE", name: "模板" }).expect(400)
    await request(app.getHttpServer()).post("/api/chetaidou/results/310/save-to-material-pool").send({ idempotencyKey: workspaceId, name: "图片", groupId: 12 }).expect(200)
    expect(results.saveMaterial).toHaveBeenCalledWith(7, 310, { idempotencyKey: workspaceId, name: "图片", groupId: 12 })
  })
  it("reset 必须带合法工作区及版本，通过后返回 200", async () => {
    const path = "/api/chetaidou/images/19/draft/reset"
    await request(app.getHttpServer()).post(path).send({ revision: 0 }).expect(400)
    await request(app.getHttpServer()).post(path).send({ workspaceId, revision: -1 }).expect(400)
    expect(service.resetDraft).not.toHaveBeenCalled()
    await request(app.getHttpServer())
      .post(path)
      .send({ workspaceId, revision: 1, unexpected: true })
      .expect(200)
    expect(service.resetDraft).toHaveBeenCalledWith(7, 19, { workspaceId, revision: 1 })
  })
  it("恢复路径 UUID 校验；只透传当前用户及当前工作区", async () => {
    await request(app.getHttpServer())
      .post("/api/chetaidou/images/19/adjustments/invalid/restore")
      .send({ workspaceId, revision: 1 })
      .expect(400)
    expect(service.restoreAdjustment).not.toHaveBeenCalled()
    await request(app.getHttpServer())
      .post(`/api/chetaidou/images/19/adjustments/${workspaceId}/restore`)
      .send({ workspaceId, revision: 1 })
      .expect(200)
    expect(service.restoreAdjustment).toHaveBeenCalledWith(7, 19, workspaceId, {
      workspaceId,
      revision: 1,
    })
  })
  it("任务旧入参缺令牌或版本时拒绝；保留显式生图模型", async () => {
    const body = {
      type: "GENERATE",
      imageId: 19,
      count: 1,
      idempotencyKey: workspaceId,
      imageModel: " ZQ-Image-1 ",
    }
    await request(app.getHttpServer()).post("/api/chetaidou/tasks").send(body).expect(400)
    expect(service.createTask).not.toHaveBeenCalled()
    await request(app.getHttpServer())
      .post("/api/chetaidou/tasks")
      .send({ ...body, workspaceId, draftRevision: 0 })
      .expect(202)
    expect(service.createTask).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ imageModel: "ZQ-Image-1", workspaceId, draftRevision: 0 })
    )
  })
  it("结果筛选转为数字并验证站点及正整数", async () => {
    const path = "/api/chetaidou/skus/1/results"
    await request(app.getHttpServer()).get(`${path}?site=unknown`).expect(400)
    await request(app.getHttpServer()).get(`${path}?imageId=0`).expect(400)
    await request(app.getHttpServer()).get(`${path}?pageSize=0`).expect(400)
    expect(service.listResults).not.toHaveBeenCalled()
    await request(app.getHttpServer())
      .get(`${path}?site=amazon_de&imageId=19&page=2&pageSize=10`)
      .expect(200)
    expect(service.listResults).toHaveBeenCalledWith(7, 1, {
      site: "amazon_de",
      imageId: 19,
      page: 2,
      pageSize: 10,
    })
  })
})
