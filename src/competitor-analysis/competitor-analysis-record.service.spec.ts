import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common"
import { PrismaService } from "../prisma/prisma.service"
import { createCompetitorAnalysisDto as createDto } from "./competitor-analysis-record.fixture"
import { CompetitorAnalysisRecordService } from "./competitor-analysis-record.service"

interface CreateCallArgument {
  data: {
    [key: string]: unknown
    createFingerprint: string
    products: {
      create: Array<
        Record<string, unknown> & {
          steps: { create: Array<Record<string, unknown>> }
        }
      >
    }
  }
}

interface ListCallArgument {
  where: Record<string, unknown>
  select: Record<string, unknown>
}

interface OwnedCallArgument {
  where: Record<string, unknown>
}

describe("CompetitorAnalysisRecordService", () => {
  interface PrismaMock {
    $queryRaw: jest.Mock
    $transaction: jest.Mock
    competitorAnalysisRecord: {
      findUnique: jest.Mock
      create: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
      findFirst: jest.Mock
      updateMany: jest.Mock
    }
  }

  let prisma: PrismaMock
  let service: CompetitorAnalysisRecordService
  const now = new Date("2026-08-25T08:00:00.000Z")
  const later = new Date("2026-08-25T08:05:00.000Z")
  const recordId = "48efab82-71c1-4d4e-a626-5bc0ac351e53"

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn(),
      $transaction: jest.fn((callback: (client: PrismaMock) => unknown) => callback(prisma)),
      competitorAnalysisRecord: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
    }
    service = new CompetitorAnalysisRecordService(prisma as unknown as PrismaService)
  })

  it("writes the main record, products and arbitrary steps in one transaction", async () => {
    prisma.competitorAnalysisRecord.findUnique.mockResolvedValue(null)
    prisma.competitorAnalysisRecord.create.mockResolvedValue(baseRecord())

    const result = await service.create(7, createDto())

    expect(result).toMatchObject({ recordId, version: 1, idempotentReplay: false })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    const createArg = firstCallArg<CreateCallArgument>(prisma.competitorAnalysisRecord.create)
    expect(createArg.data).toMatchObject({
      userId: 7,
      marketplace: "US",
      mode: "ASIN",
      ownAsin: "B0AAAA0001",
      competitorAsins: ["B0BBBB0002", "B0CCCC0003"],
      productCount: 1,
      competitorCount: 2,
    })
    expect(createArg.data.products.create[0]).toMatchObject({
      asin: "B0AAAA0001",
      sortOrder: 0,
      productData: { title: "我方产品", price: 29.99 },
    })
    expect(createArg.data.products.create[0].steps.create[0]).toMatchObject({
      stepCode: "PROFILE",
      stepNo: 1,
      resultData: { strengths: ["轻量"] },
    })
  })

  it("returns an existing record for the same idempotent content and rejects changed content", async () => {
    prisma.competitorAnalysisRecord.findUnique.mockResolvedValue(null)
    prisma.competitorAnalysisRecord.create.mockResolvedValue(baseRecord())
    await service.create(7, createDto())
    const fingerprint = firstCallArg<CreateCallArgument>(prisma.competitorAnalysisRecord.create)
      .data.createFingerprint

    prisma.competitorAnalysisRecord.findUnique.mockResolvedValue({
      ...baseRecord(),
      createFingerprint: fingerprint,
    })
    prisma.competitorAnalysisRecord.create.mockClear()
    await expect(service.create(7, createDto())).resolves.toMatchObject({
      idempotentReplay: true,
    })
    expect(prisma.competitorAnalysisRecord.create).not.toHaveBeenCalled()

    prisma.competitorAnalysisRecord.findUnique.mockResolvedValue({
      ...baseRecord(),
      createFingerprint: "different",
    })
    await expect(service.create(7, createDto())).rejects.toBeInstanceOf(ConflictException)
  })

  it("uses creator ownership, Beijing date boundaries and summary-only list selection", async () => {
    prisma.competitorAnalysisRecord.findMany.mockResolvedValue([
      {
        ...baseRecord(),
        marketplace: "US",
        mode: "ASIN",
        ownAsin: "B0AAAA0001",
        competitorAsins: ["B0BBBB0002", "B0CCCC0003"],
        sourceKeyword: null,
        title: "我方 B0AAAA0001 vs 2 个竞品",
        productCount: 1,
        competitorCount: 2,
        reportPdfUrl: null,
      },
    ])
    prisma.competitorAnalysisRecord.count.mockResolvedValue(1)

    const result = await service.findAll(7, {
      page: 1,
      pageSize: 10,
      keyword: "b0bbbb0002",
      marketplace: "us",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-25",
    })

    expect(result.items[0].competitorAsins).toEqual(["B0BBBB0002", "B0CCCC0003"])
    const listArg = firstCallArg<ListCallArgument>(prisma.competitorAnalysisRecord.findMany)
    expect(listArg.where).toMatchObject({
      userId: 7,
      marketplace: "US",
      createdAt: {
        gte: new Date("2026-07-31T16:00:00.000Z"),
        lt: new Date("2026-08-25T16:00:00.000Z"),
      },
      OR: [{ ownAsin: "B0BBBB0002" }, { products: { some: { asin: "B0BBBB0002" } } }],
    })
    expect(listArg.select).not.toHaveProperty("analysisResult")
    expect(listArg.select).not.toHaveProperty("reportData")
    expect(listArg.select).not.toHaveProperty("inputSnapshot")
  })

  it("returns the complete product-step tree only to the creator", async () => {
    prisma.competitorAnalysisRecord.findFirst.mockResolvedValue({
      ...baseRecord(),
      schemaVersion: 1,
      marketplace: "US",
      inputSnapshot: { mode: "ASIN" },
      title: "我方 B0AAAA0001 vs 2 个竞品",
      ownAsin: "B0AAAA0001",
      competitorAsins: ["B0BBBB0002", "B0CCCC0003"],
      productCount: 1,
      competitorCount: 2,
      analysisResult: { overview: true },
      reportData: { conclusion: true },
      reportPdfUrl: null,
      reportPdfUpdatedAt: null,
      products: [
        {
          id: 11,
          asin: "B0AAAA0001",
          sortOrder: 0,
          productData: { title: "我方产品" },
          steps: [
            {
              stepCode: "PROFILE",
              stepNo: 1,
              schemaVersion: 1,
              resultData: { score: 8 },
            },
          ],
        },
      ],
    })

    const result = await service.findOne(7, recordId)

    expect(
      firstCallArg<OwnedCallArgument>(prisma.competitorAnalysisRecord.findFirst).where
    ).toEqual({
      id: recordId,
      userId: 7,
    })
    expect(result.products[0].steps[0]).toEqual({
      stepCode: "PROFILE",
      stepNo: 1,
      schemaVersion: 1,
      resultData: { score: 8 },
    })

    prisma.competitorAnalysisRecord.findFirst.mockResolvedValue(null)
    await expect(service.findOne(8, recordId)).rejects.toBeInstanceOf(NotFoundException)
  })

  it("updates an owned OSS PDF URL, and treats the same URL as idempotent", async () => {
    const url = "https://cdn.example.com/competitor-analysis/7/report.pdf"
    prisma.competitorAnalysisRecord.findFirst
      .mockResolvedValueOnce({
        ...baseRecord(),
        reportPdfUrl: null,
        reportPdfUpdatedAt: null,
      })
      .mockResolvedValueOnce({
        ...baseRecord(),
        reportPdfUrl: url,
        reportPdfUpdatedAt: later,
        version: 2,
        updatedAt: later,
      })
    prisma.competitorAnalysisRecord.updateMany.mockResolvedValue({ count: 1 })

    await expect(service.updateReportPdf(7, recordId, url)).resolves.toMatchObject({
      reportPdfUrl: url,
      version: 2,
      changed: true,
    })
    expect(
      firstCallArg<OwnedCallArgument>(prisma.competitorAnalysisRecord.updateMany).where
    ).toEqual({
      id: recordId,
      userId: 7,
      deletedAt: null,
    })

    prisma.competitorAnalysisRecord.findFirst.mockReset()
    prisma.competitorAnalysisRecord.findFirst.mockResolvedValue({
      ...baseRecord(),
      reportPdfUrl: url,
      reportPdfUpdatedAt: later,
      version: 2,
      updatedAt: later,
    })
    prisma.competitorAnalysisRecord.updateMany.mockClear()
    await expect(service.updateReportPdf(7, recordId, url)).resolves.toMatchObject({
      changed: false,
      version: 2,
    })
    expect(prisma.competitorAnalysisRecord.updateMany).not.toHaveBeenCalled()
  })

  it("rejects non-HTTPS PDF URLs and atomically soft-deletes only owned records", async () => {
    await expect(
      service.updateReportPdf(7, recordId, "http://files.example.com/report.pdf")
    ).rejects.toBeInstanceOf(BadRequestException)

    prisma.competitorAnalysisRecord.updateMany.mockResolvedValue({ count: 1 })
    await service.remove(7, recordId)
    expect(
      firstCallArg<OwnedCallArgument>(prisma.competitorAnalysisRecord.updateMany).where
    ).toEqual({
      id: recordId,
      userId: 7,
      deletedAt: null,
    })

    prisma.competitorAnalysisRecord.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.remove(8, recordId)).rejects.toBeInstanceOf(NotFoundException)
  })

  function baseRecord() {
    return { id: recordId, version: 1, createdAt: now, updatedAt: now }
  }
})

function firstCallArg<T>(mock: jest.Mock): T {
  const calls = mock.mock.calls as unknown[][]
  return calls[0][0] as T
}
