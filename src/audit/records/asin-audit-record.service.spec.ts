import { ConflictException, NotFoundException } from "@nestjs/common"
import { AsinAuditRecordStatus } from "@prisma/client"
import { hashJson } from "../../common/utils/canonical-json"
import { AsinAuditRecordService } from "./asin-audit-record.service"
import { CreateAsinAuditRecordDto } from "./dto/create-asin-audit-record.dto"
import { UpdateAsinAuditRecordDto } from "./dto/update-asin-audit-record.dto"

describe("AsinAuditRecordService", () => {
  it("creates the main record and immutable score snapshot in one transaction", async () => {
    const { service, prisma, tx } = createService()
    const dto = createDto()
    const now = new Date("2026-08-25T08:00:00.000Z")
    tx.asinAuditRecord.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: "b9912892-6909-468c-a252-6a40ec697d5a",
        version: 1,
        status: AsinAuditRecordStatus.SCORED,
        createdAt: now,
        updatedAt: now,
        ...args.data,
      })
    )

    const result = await service.create(7, dto)

    expect(result).toMatchObject({
      version: 1,
      status: AsinAuditRecordStatus.SCORED,
      idempotentReplay: false,
    })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    const createCall = tx.asinAuditRecord.create.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ]
    const createData = createCall[0].data
    expect(createData).toMatchObject({
      userId: 7,
      asin: "B0C9L8ZR6Q",
      marketplace: "US",
      adScore: null,
      scoreSnapshot: {
        create: {
          schemaVersion: 1,
          evidence: dto.evidence,
          scoreResult: dto.scoreResult,
        },
      },
    })
  })

  it("returns the existing record for an identical create retry", async () => {
    const { service, prisma, tx } = createService()
    const dto = createDto()
    const now = new Date()
    let created: Record<string, unknown> | undefined
    tx.asinAuditRecord.create.mockImplementation((args: { data: Record<string, unknown> }) => {
      created = args.data
      return Promise.resolve({
        id: "b9912892-6909-468c-a252-6a40ec697d5a",
        version: 1,
        status: AsinAuditRecordStatus.SCORED,
        createdAt: now,
        updatedAt: now,
      })
    })
    await service.create(7, dto)
    prisma.asinAuditRecord.findUnique.mockResolvedValue({
      id: "b9912892-6909-468c-a252-6a40ec697d5a",
      createFingerprint: created?.createFingerprint,
      version: 1,
      status: AsinAuditRecordStatus.SCORED,
      createdAt: now,
      updatedAt: now,
    })

    const replay = await service.create(7, dto)

    expect(replay.idempotentReplay).toBe(true)
    expect(tx.asinAuditRecord.create).toHaveBeenCalledTimes(1)
  })

  it("rejects a reused clientRequestId with different content", async () => {
    const { service, prisma } = createService()
    prisma.asinAuditRecord.findUnique.mockResolvedValue({
      id: "b9912892-6909-468c-a252-6a40ec697d5a",
      createFingerprint: "different",
      version: 1,
      status: AsinAuditRecordStatus.SCORED,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await expect(service.create(7, createDto())).rejects.toBeInstanceOf(ConflictException)
  })

  it("adds an optimization revision and advances the main version", async () => {
    const { service, tx } = createService()
    const updatedAt = new Date("2026-08-25T08:05:00.000Z")
    tx.$queryRaw.mockResolvedValue([
      {
        id: "b9912892-6909-468c-a252-6a40ec697d5a",
        version: 1,
        status: AsinAuditRecordStatus.SCORED,
        latestOptimizationRevision: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    tx.asinAuditRecord.update.mockResolvedValue({
      id: "b9912892-6909-468c-a252-6a40ec697d5a",
      version: 2,
      status: AsinAuditRecordStatus.OPTIMIZED,
      latestOptimizationRevision: 1,
      createdAt: new Date(),
      updatedAt,
    })

    const result = await service.optimize(7, "b9912892-6909-468c-a252-6a40ec697d5a", optimizeDto())

    expect(result).toMatchObject({ version: 2, optimizationRevision: 1, changed: true })
    const revisionCall = tx.asinAuditOptimizationRevision.create.mock.calls[0] as unknown as [
      { data: { recordId: string; revision: number } },
    ]
    expect(revisionCall[0].data).toMatchObject({
      recordId: "b9912892-6909-468c-a252-6a40ec697d5a",
      revision: 1,
    })
    const updateCall = tx.asinAuditRecord.update.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ]
    expect(updateCall[0].data).toMatchObject({
      status: AsinAuditRecordStatus.OPTIMIZED,
      version: { increment: 1 },
      latestOptimizationRevision: 1,
    })
  })

  it("treats the same latest optimization as idempotent before checking stale version", async () => {
    const { service, tx } = createService()
    const dto = optimizeDto()
    tx.$queryRaw.mockResolvedValue([
      {
        id: "b9912892-6909-468c-a252-6a40ec697d5a",
        version: 2,
        status: AsinAuditRecordStatus.OPTIMIZED,
        latestOptimizationRevision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    tx.asinAuditOptimizationRevision.findUnique.mockResolvedValue({
      payloadHash: hashJson({
        schemaVersion: dto.schemaVersion,
        optimizationResult: dto.optimizationResult,
      }),
    })

    const result = await service.optimize(7, "b9912892-6909-468c-a252-6a40ec697d5a", dto)

    expect(result).toMatchObject({ version: 2, optimizationRevision: 1, changed: false })
    expect(tx.asinAuditOptimizationRevision.create).not.toHaveBeenCalled()
    expect(tx.asinAuditRecord.update).not.toHaveBeenCalled()
  })

  it("rejects changed optimization content when expectedVersion is stale", async () => {
    const { service, tx } = createService()
    tx.$queryRaw.mockResolvedValue([
      {
        id: "b9912892-6909-468c-a252-6a40ec697d5a",
        version: 2,
        status: AsinAuditRecordStatus.OPTIMIZED,
        latestOptimizationRevision: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    tx.asinAuditOptimizationRevision.findUnique.mockResolvedValue({ payloadHash: "old" })

    await expect(
      service.optimize(7, "b9912892-6909-468c-a252-6a40ec697d5a", optimizeDto())
    ).rejects.toBeInstanceOf(ConflictException)
    expect(tx.asinAuditOptimizationRevision.create).not.toHaveBeenCalled()
  })

  it("lists only main-table summaries and never selects JSON snapshots", async () => {
    const { service, prisma } = createService()
    prisma.asinAuditRecord.findMany.mockResolvedValue([])
    prisma.asinAuditRecord.count.mockResolvedValue(0)

    await service.findAll(7, {
      page: 1,
      pageSize: 10,
      marketplace: "us",
      dateFrom: "2026-08-25",
      dateTo: "2026-08-25",
    })

    const findManyCall = prisma.asinAuditRecord.findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown>; select: Record<string, unknown> },
    ]
    const query = findManyCall[0]
    expect(query.where).toMatchObject({
      userId: 7,
      marketplace: "US",
      createdAt: {
        gte: new Date("2026-08-24T16:00:00.000Z"),
        lt: new Date("2026-08-25T16:00:00.000Z"),
      },
    })
    expect(query.select).not.toHaveProperty("scoreSnapshot")
    expect(query.select).not.toHaveProperty("optimizationRevisions")
  })

  it("returns the immutable score snapshot and only the latest optimization", async () => {
    const { service, tx } = createService()
    const createdAt = new Date("2026-08-25T08:00:00.000Z")
    const updatedAt = new Date("2026-08-25T08:10:00.000Z")
    tx.asinAuditRecord.findFirst.mockResolvedValue({
      id: "b9912892-6909-468c-a252-6a40ec697d5a",
      userId: 7,
      asin: "B0C9L8ZR6Q",
      marketplace: "US",
      country: "US",
      categoryNodeId: "172282",
      categoryName: "Electronics",
      categoryPath: "Electronics:Smart Glasses",
      productTitle: "Example Smart Glasses",
      adIncluded: false,
      version: 3,
      status: AsinAuditRecordStatus.OPTIMIZED,
      latestOptimizationRevision: 2,
      createdAt,
      updatedAt,
    })
    tx.asinAuditScoreSnapshot.findUnique.mockResolvedValue({
      schemaVersion: 1,
      evidence: { A: {}, P: {}, B: {}, C: {}, D: {}, E: {}, meta: {} },
      scoreResult: createDto().scoreResult,
    })
    tx.asinAuditOptimizationRevision.findUnique.mockResolvedValue({
      optimizationResult: { listing: { title: "latest" } },
    })

    const result = await service.findOne(7, "b9912892-6909-468c-a252-6a40ec697d5a")

    expect(result).toMatchObject({
      version: 3,
      optimizationRevision: 2,
      optimizationResult: { listing: { title: "latest" } },
      category: { nodeId: "172282", name: "Electronics" },
    })
    expect(tx.asinAuditOptimizationRevision.findUnique).toHaveBeenCalledWith({
      where: {
        recordId_revision: {
          recordId: "b9912892-6909-468c-a252-6a40ec697d5a",
          revision: 2,
        },
      },
      select: { optimizationResult: true },
    })
  })

  it("soft-deletes only records owned by the current user", async () => {
    const { service, prisma } = createService()
    prisma.asinAuditRecord.updateMany.mockResolvedValue({ count: 1 })

    await service.remove(7, "b9912892-6909-468c-a252-6a40ec697d5a")

    const removeCall = prisma.asinAuditRecord.updateMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ]
    expect(removeCall[0]).toMatchObject({
      where: {
        id: "b9912892-6909-468c-a252-6a40ec697d5a",
        userId: 7,
        deletedAt: null,
      },
      data: { version: { increment: 1 } },
    })

    prisma.asinAuditRecord.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.remove(8, "b9912892-6909-468c-a252-6a40ec697d5a")).rejects.toBeInstanceOf(
      NotFoundException
    )
  })
})

function createService() {
  const tx = {
    $queryRaw: jest.fn(),
    asinAuditRecord: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
    },
    asinAuditScoreSnapshot: { findUnique: jest.fn() },
    asinAuditOptimizationRevision: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
  }
  const prisma = {
    asinAuditRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
  }
  return { service: new AsinAuditRecordService(prisma as never), prisma, tx }
}

function createDto(): CreateAsinAuditRecordDto {
  return {
    clientRequestId: "23fd58d7-3810-4a16-8a39-61520e134994",
    schemaVersion: 1,
    asin: "B0C9L8ZR6Q",
    marketplace: "US",
    country: "US",
    category: {
      nodeId: "172282",
      name: "Electronics",
      path: "Electronics:Wearable Technology:Smart Glasses",
    },
    productTitle: "Example Smart Glasses",
    adIncluded: false,
    evidence: { A: {}, P: {}, B: {}, C: {}, D: {}, E: {}, meta: {} },
    scoreResult: {
      overallScore: 76,
      grade: "B+",
      contentScore: 80,
      trafficScore: 72,
      adScore: null,
      dimensions: Array.from({ length: 10 }, () => ({ criteria: [{}] })),
      problemTypes: {},
      recommendations: [],
    },
  }
}

function optimizeDto(): UpdateAsinAuditRecordDto {
  return {
    expectedVersion: 1,
    schemaVersion: 1,
    optimizationResult: { listing: { title: "new title" } },
  }
}
