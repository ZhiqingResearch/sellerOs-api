import {
  ExecutionContext,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { App } from "supertest/types"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { VideoAnalysisRecordController } from "./video-analysis-record.controller"
import { VideoAnalysisRecordService } from "./video-analysis-record.service"

describe("VideoAnalysisRecordController HTTP", () => {
  let app: INestApplication<App>
  const recordId = "48efab82-71c1-4d4e-a626-5bc0ac351e53"
  const service = { findAll: jest.fn(), findOne: jest.fn(), remove: jest.fn() }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [VideoAnalysisRecordController],
      providers: [{ provide: VideoAnalysisRecordService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context
            .switchToHttp()
            .getRequest<{ headers: { authorization?: string }; user?: { id: number } }>()
          if (req.headers.authorization !== "Bearer test")
            throw new UnauthorizedException("请先登录")
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

  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("列表应用分页默认值和数值转换，详情返回报告，删除返回 204 空响应", async () => {
    service.findAll.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10, totalPages: 0 })
    service.findOne.mockResolvedValue({ recordId, result: { title: "开箱视频" } })
    service.remove.mockResolvedValue(undefined)
    await request(app.getHttpServer())
      .get("/api/video-analysis/records")
      .set("Authorization", "Bearer test")
      .expect(200)
    expect(service.findAll).toHaveBeenLastCalledWith(7, { page: 1, pageSize: 10 })
    await request(app.getHttpServer())
      .get("/api/video-analysis/records?page=2&pageSize=20")
      .set("Authorization", "Bearer test")
      .expect(200)
    expect(service.findAll).toHaveBeenLastCalledWith(7, { page: 2, pageSize: 20 })
    await request(app.getHttpServer())
      .get(`/api/video-analysis/records/${recordId}`)
      .set("Authorization", "Bearer test")
      .expect(200)
      .expect(({ body }: { body: unknown }) =>
        expect(body).toMatchObject({ recordId, result: { title: "开箱视频" } })
      )
    expect(service.findOne).toHaveBeenCalledWith(7, recordId)
    const deleted = await request(app.getHttpServer())
      .delete(`/api/video-analysis/records/${recordId}`)
      .set("Authorization", "Bearer test")
      .expect(204)
    expect(deleted.text).toBe("")
    expect(service.remove).toHaveBeenCalledWith(7, recordId)
  })

  it("不合法的分页参数或记录编号在进入服务前被拒绝", async () => {
    for (const query of ["page=0", "page=abc", "pageSize=101"]) {
      await request(app.getHttpServer())
        .get(`/api/video-analysis/records?${query}`)
        .set("Authorization", "Bearer test")
        .expect(400)
    }
    for (const method of ["get", "delete"] as const) {
      await request(app.getHttpServer())
        [method]("/api/video-analysis/records/invalid")
        .set("Authorization", "Bearer test")
        .expect(400)
    }
    expect(service.findAll).not.toHaveBeenCalled()
    expect(service.findOne).not.toHaveBeenCalled()
    expect(service.remove).not.toHaveBeenCalled()
  })

  it("所有查询与删除接口要求登录", async () => {
    await request(app.getHttpServer()).get("/api/video-analysis/records").expect(401)
    await request(app.getHttpServer()).get(`/api/video-analysis/records/${recordId}`).expect(401)
    await request(app.getHttpServer()).delete(`/api/video-analysis/records/${recordId}`).expect(401)
    expect(service.findAll).not.toHaveBeenCalled()
    expect(service.findOne).not.toHaveBeenCalled()
    expect(service.remove).not.toHaveBeenCalled()
  })

  it("详情与删除透传不存在或无权访问的 404", async () => {
    service.findOne.mockRejectedValue(new NotFoundException("视频分析记录不存在"))
    service.remove.mockRejectedValue(new NotFoundException("视频分析记录不存在"))
    await request(app.getHttpServer())
      .get(`/api/video-analysis/records/${recordId}`)
      .set("Authorization", "Bearer test")
      .expect(404)
    await request(app.getHttpServer())
      .delete(`/api/video-analysis/records/${recordId}`)
      .set("Authorization", "Bearer test")
      .expect(404)
  })
})
