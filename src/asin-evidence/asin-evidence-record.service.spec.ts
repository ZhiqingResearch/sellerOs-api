jest.mock("../generation-record/generation-record-success", () => ({ recordGenerationSuccess: jest.fn().mockResolvedValue(undefined) }))
import { ConflictException, NotFoundException } from "@nestjs/common"
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library"
import { hashJson } from "../common/utils/canonical-json"
import { AsinEvidenceRecordService } from "./asin-evidence-record.service"
import { CreateAsinEvidenceRecordDto } from "./dto/create-asin-evidence-record.dto"

const RECORD_ID = "b9912892-6909-468c-a252-6a40ec697d5a"

describe("AsinEvidenceRecordService", () => {
  it("preserves mixed provider facts, dates and fallback reasons through save/detail", async () => {
    const { service, prisma } = createService()
    const dto = createDto()
    dto.evidence.D = { filled: true, group: { source: "xiyou", status: "partial", fallbackReason: "主数据源暂不可用", period: { startDate: "2026-09-28", endDate: "2026-10-27" } }, kwTop: [], kwDetail: [] }
    dto.evidence.E = { groups: { price: { source: "sif" }, orders: { source: "xiyou" } }, ordersLast30Days: 50 }
    dto.evidence.meta = { sources: { D: ["xiyou"], E: ["sif", "xiyou", "upload"] } }
    let saved: Record<string, unknown> = {}
    prisma.asinEvidenceRecord.create.mockImplementation((args: { data: Record<string, unknown> }) => {
      saved = { id: RECORD_ID, createdAt: new Date(), updatedAt: new Date(), ...args.data }
      return Promise.resolve(saved)
    })
    await service.create(7, dto)
    prisma.asinEvidenceRecord.findFirst.mockResolvedValue(saved)
    expect((await service.findOne(7, RECORD_ID)).evidence).toEqual(dto.evidence)
  })

  it("normalizes asin/country and extracts productTitle from card A on create", async () => {
    const { service, prisma } = createService()
    const dto = createDto()
    dto.asin = "b0gqb1c381"
    dto.evidence.meta = {
      generationRequestId: "generation-id",
      sources: { A: ["apify"], B: ["apify"] },
      sifWarnings: ["备用数据源未获取评论正文"],
    }
    const now = new Date("2026-09-11T08:00:00.000Z")
    prisma.asinEvidenceRecord.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: RECORD_ID, createdAt: now, updatedAt: now, ...args.data })
    )
    const meta = {
      clientRequestId: "generation-id",
      model: "ZQ-Think-Flash",
      scene: "evidence-module",
    }
    prisma.usageLog.findMany.mockResolvedValue([{ id: 10904, meta }])

    const result = await service.create(7, dto)

    expect(result).toMatchObject({ recordId: RECORD_ID, idempotentReplay: false })
    const createData = prisma.asinEvidenceRecord.create.mock.calls[0][0].data
    expect(createData).toMatchObject({
      userId: 7,
      asin: "B0GQB1C381",
      country: "US",
      productTitle: "Example Smart Glasses",
      evidence: dto.evidence,
      model: "ZQ-Think-Flash",
    })
    expect(prisma.usageLog.updateMany).toHaveBeenCalledWith({
      where: { id: 10904, meta: { equals: meta } },
      data: { meta: { ...meta, recordId: RECORD_ID } },
    })
    const query = prisma.usageLog.findMany.mock.calls[0] as unknown as [
      { where: { userId: number; source: string; AND: unknown[] } },
    ]
    expect(query[0].where).toMatchObject({ userId: 7, source: "asin.audit.evidence" })
    expect(query[0].where.AND).toContainEqual({
      OR: [
        { meta: { path: "$.resultHash", equals: hashJson(dto.evidence) } },
        { meta: { path: "$.clientRequestId", equals: "generation-id" } },
      ],
    })
  })

  it("prefers the client-provided productTitle over the extracted one", async () => {
    const { service, prisma } = createService()
    const dto = createDto()
    dto.productTitle = "自定义标题"
    prisma.asinEvidenceRecord.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: RECORD_ID, createdAt: new Date(), updatedAt: new Date(), ...args.data })
    )

    await service.create(7, dto)

    const createData = prisma.asinEvidenceRecord.create.mock.calls[0][0].data
    expect(createData.productTitle).toBe("自定义标题")
  })

  it("returns the existing record for an identical create retry", async () => {
    const { service, prisma } = createService()
    const dto = createDto()
    const now = new Date()
    prisma.asinEvidenceRecord.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: RECORD_ID, createdAt: now, updatedAt: now, ...args.data })
    )
    await service.create(7, dto)
    const fingerprint = prisma.asinEvidenceRecord.create.mock.calls[0][0].data
      .createFingerprint as string
    prisma.asinEvidenceRecord.findUnique.mockResolvedValue({
      id: RECORD_ID,
      createFingerprint: fingerprint,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })

    const replay = await service.create(7, dto)

    expect(replay.idempotentReplay).toBe(true)
    expect(prisma.asinEvidenceRecord.create).toHaveBeenCalledTimes(1)
  })

  it("rejects a reused clientRequestId with different content", async () => {
    const { service, prisma } = createService()
    prisma.asinEvidenceRecord.findUnique.mockResolvedValue({
      id: RECORD_ID,
      createFingerprint: "different",
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await expect(service.create(7, createDto())).rejects.toBeInstanceOf(ConflictException)
  })

  it("surfaces P2002 races through the raw-row fallback and replays identical content", async () => {
    const { service, prisma } = createService()
    const dto = createDto()
    prisma.asinEvidenceRecord.findUnique.mockResolvedValue(null)
    prisma.asinEvidenceRecord.create.mockRejectedValue(
      new PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002" })
    )
    prisma.$queryRaw.mockResolvedValue([
      { id: RECORD_ID, createFingerprint: fingerprintOf(dto), deletedAt: null },
    ])
    const now = new Date()
    prisma.asinEvidenceRecord.findFirst.mockResolvedValue({
      id: RECORD_ID,
      createFingerprint: fingerprintOf(dto),
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })

    const result = await service.create(7, dto)

    expect(result).toMatchObject({ recordId: RECORD_ID, idempotentReplay: true })
  })

  it("rejects creates whose clientRequestId belongs to a soft-deleted record", async () => {
    const { service, prisma } = createService()
    const dto = createDto()
    prisma.asinEvidenceRecord.findUnique.mockResolvedValue({
      id: RECORD_ID,
      createFingerprint: fingerprintOf(dto),
      deletedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await expect(service.create(7, dto)).rejects.toBeInstanceOf(ConflictException)
  })

  it("lists summaries without the evidence JSON and applies Beijing-day filters", async () => {
    const { service, prisma } = createService()
    prisma.asinEvidenceRecord.findMany.mockResolvedValue([])
    prisma.asinEvidenceRecord.count.mockResolvedValue(0)

    await service.findAll(7, {
      page: 1,
      pageSize: 10,
      keyword: "B0GQB1C381",
      country: "US",
      dateFrom: "2026-09-11",
      dateTo: "2026-09-11",
    })

    const query = prisma.asinEvidenceRecord.findMany.mock.calls[0][0]
    expect(query.where).toMatchObject({
      userId: 7,
      deletedAt: null,
      country: "US",
      createdAt: {
        gte: new Date("2026-09-10T16:00:00.000Z"),
        lt: new Date("2026-09-11T16:00:00.000Z"),
      },
    })
    expect(query.where.OR).toEqual([
      { asin: { contains: "B0GQB1C381" } },
      { productTitle: { contains: "B0GQB1C381" } },
    ])
    expect(query.select).not.toHaveProperty("evidence")
  })

  it("returns the full record including evidence on findOne", async () => {
    const { service, prisma } = createService()
    prisma.asinEvidenceRecord.findFirst.mockResolvedValue({
      id: RECORD_ID,
      userId: 7,
      asin: "B0GQB1C381",
      country: "US",
      productTitle: "Example Smart Glasses",
      model: "ZQ-Think-Flash",
      evidence: {
        A: {},
        P: {},
        B: {},
        C: {},
        D: {},
        E: {},
        meta: { sources: { A: ["apify"] }, sifWarnings: ["备用数据源未获取评论正文"] },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    })

    const result = await service.findOne(7, RECORD_ID)

    expect(result).toMatchObject({
      recordId: RECORD_ID,
      asin: "B0GQB1C381",
      productTitle: "Example Smart Glasses",
    })
    expect(result.evidence).toMatchObject({
      A: {},
      meta: { sources: { A: ["apify"] }, sifWarnings: ["备用数据源未获取评论正文"] },
    })
  })

  it("throws NotFound when the record belongs to someone else or was deleted", async () => {
    const { service, prisma } = createService()
    prisma.asinEvidenceRecord.findFirst.mockResolvedValue(null)

    await expect(service.findOne(7, RECORD_ID)).rejects.toBeInstanceOf(NotFoundException)
  })

  it("soft-deletes and reports NotFound when nothing matched", async () => {
    const { service, prisma } = createService()
    prisma.asinEvidenceRecord.updateMany.mockResolvedValue({ count: 1 })
    await service.remove(7, RECORD_ID)

    prisma.asinEvidenceRecord.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.remove(7, RECORD_ID)).rejects.toBeInstanceOf(NotFoundException)
  })
})

function fingerprintOf(dto: CreateAsinEvidenceRecordDto) {
  return hashJson({
    asin: dto.asin.trim().toUpperCase(),
    country: dto.country.trim().toUpperCase(),
    model: dto.model.trim(),
    evidence: JSON.parse(JSON.stringify(dto.evidence)) as unknown,
  })
}

function createService() {
  const transaction = jest.fn()
  const prisma = {
    $transaction: transaction,
    usageLog: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    asinEvidenceRecord: {
      create: jest.fn<Promise<unknown>, [{ data: Record<string, unknown> }]>(),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(),
      findMany: jest.fn<
        Promise<unknown[]>,
        [{ where: Record<string, unknown>; select?: Record<string, unknown> }]
      >(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  }
  transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) => callback(prisma))
  return { service: new AsinEvidenceRecordService(prisma as never), prisma }
}

function createDto(): CreateAsinEvidenceRecordDto {
  return {
    clientRequestId: "23fd58d7-3810-4a16-8a39-61520e134994",
    asin: "B0GQB1C381",
    country: "US",
    model: "ZQ-Think-Flash",
    evidence: {
      A: { filled: true, title: "Example Smart Glasses" },
      P: {},
      B: {},
      C: {},
      D: {},
      E: {},
      meta: {},
    },
  }
}
