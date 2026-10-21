import { ExecutionContext, INestApplication, ValidationPipe } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { App } from "supertest/types"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { CompetitorAnalysisRecordController } from "./competitor-analysis-record.controller"
import { createCompetitorAnalysisDto } from "./competitor-analysis-record.fixture"
import { CompetitorAnalysisRecordService } from "./competitor-analysis-record.service"

describe("CompetitorAnalysisRecordController smoke", () => {
  let app: INestApplication<App>
  const recordId = "48efab82-71c1-4d4e-a626-5bc0ac351e53"
  const service = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    updateReportPdf: jest.fn(),
    remove: jest.fn(),
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CompetitorAnalysisRecordController],
      providers: [{ provide: CompetitorAnalysisRecordService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const httpRequest = context.switchToHttp().getRequest<{ user?: { id: number } }>()
          httpRequest.user = { id: 7 }
          return true
        },
      })
      .compile()

    app = module.createNestApplication()
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    app.setGlobalPrefix("api")
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("serves create, list, detail, PDF URL update and delete routes", async () => {
    service.create.mockResolvedValue({ recordId, version: 1, idempotentReplay: false })
    service.findAll.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10, totalPages: 0 })
    service.findOne.mockResolvedValue({ recordId, products: [], reportData: {} })
    service.updateReportPdf.mockResolvedValue({
      recordId,
      reportPdfUrl: "https://files.example.com/report.pdf",
      version: 2,
      changed: true,
    })
    service.remove.mockResolvedValue(undefined)

    await request(app.getHttpServer())
      .post("/api/competitor-analysis/records")
      .send(createCompetitorAnalysisDto())
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ recordId, version: 1 }))

    await request(app.getHttpServer())
      .get("/api/competitor-analysis/records?page=1&pageSize=10")
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ total: 0, page: 1 }))

    await request(app.getHttpServer())
      .get(`/api/competitor-analysis/records/${recordId}`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ recordId }))

    await request(app.getHttpServer())
      .patch(`/api/competitor-analysis/records/${recordId}/report-pdf`)
      .send({ reportPdfUrl: "https://files.example.com/report.pdf" })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ recordId, version: 2, changed: true }))

    await request(app.getHttpServer())
      .delete(`/api/competitor-analysis/records/${recordId}`)
      .expect(204)

    expect(service.create).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ clientRequestId: createCompetitorAnalysisDto().clientRequestId })
    )
    expect(service.updateReportPdf).toHaveBeenCalledWith(
      7,
      recordId,
      "https://files.example.com/report.pdf"
    )
    expect(service.remove).toHaveBeenCalledWith(7, recordId)
  })

  it("rejects a double-encoded step result before calling the service", async () => {
    const body = createCompetitorAnalysisDto()
    body.products[0].steps[0].resultData = '{"score": 1}' as unknown as Record<string, unknown>

    await request(app.getHttpServer())
      .post("/api/competitor-analysis/records")
      .send(body)
      .expect(400)

    expect(service.create).not.toHaveBeenCalled()
  })
})
