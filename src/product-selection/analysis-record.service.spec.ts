import { UsageService } from "../usage/usage.service"
import { BadRequestException, ConflictException } from "@nestjs/common"
import {
  SelectionAnalysisEntry,
  SelectionAnalysisStatus,
  SelectionAnalysisStepType,
} from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { AnalysisRecordService } from "./analysis-record.service"
import { hashJson } from "./canonical-json"

describe("AnalysisRecordService", () => {
  interface TransactionMock {
    $queryRaw: jest.Mock
    selectionAnalysisRecord: {
      create: jest.Mock
      update: jest.Mock
      findMany: jest.Mock
    }
    selectionAnalysisStep: {
      findUnique: jest.Mock
      findMany: jest.Mock
      deleteMany: jest.Mock
      upsert: jest.Mock
    }
  }

  interface PrismaMock {
    $transaction: jest.Mock
    $queryRaw: jest.Mock
    selectionAnalysisRecord: {
      findUnique: jest.Mock
      findFirst: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
      updateMany: jest.Mock
    }
  }

  let service: AnalysisRecordService
  let prisma: PrismaMock
  let tx: TransactionMock

  const now = new Date("2026-08-20T00:00:00.000Z")
  const analysisId = "5e10c2ea-f40e-48c7-9074-45388a7bfb2f"

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn(),
      selectionAnalysisRecord: {
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      selectionAnalysisStep: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        upsert: jest.fn(),
      },
    }
    prisma = {
      $transaction: jest.fn((callback: (client: TransactionMock) => unknown) => callback(tx)),
      $queryRaw: jest.fn(),
      selectionAnalysisRecord: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
      },
    }
    service = new AnalysisRecordService(prisma as unknown as PrismaService, { chargeFixedModule: jest.fn().mockResolvedValue({}) } as unknown as UsageService)
  })

  it("creates the main record and step 1 in one transaction", async () => {
    prisma.selectionAnalysisRecord.findUnique.mockResolvedValue(null)
    tx.selectionAnalysisRecord.create.mockResolvedValue({
      id: analysisId,
      lastCompletedStep: 1,
      pickCount: 0,
      status: SelectionAnalysisStatus.PROCESSING,
      version: 1,
      createdAt: now,
      updatedAt: now,
      steps: [{ stepNo: 1, revision: 1 }],
    })

    const result = await service.create(7, {
      clientRequestId: "0a49d1d3-84e7-43a0-8a68-c24f0ed93d27",
      marketplace: "us",
      entry: SelectionAnalysisEntry.CATALOG,
      primaryCategoryNodeId: "172282",
      categories: [
        {
          nodeId: "172282",
          nodeIdPath: "Automotive:Cup Holders",
          name: "Cup Holders",
          nameCn: "杯架",
        },
      ],
      schemaVersion: 1,
      payload: { diagnosis: [] },
    })

    expect(result).toEqual(expect.objectContaining({ analysisId, version: 1 }))
    const createCall = firstCallArg(tx.selectionAnalysisRecord.create)
    expect(createCall).toMatchObject({
      data: {
        userId: 7,
        marketplace: "US",
        primaryCategoryName: "杯架",
        steps: { create: { stepNo: 1 } },
      },
    })
  })

  it("creates a product validation as one completed step without category data", async () => {
    prisma.selectionAnalysisRecord.findUnique.mockResolvedValue(null)
    tx.selectionAnalysisRecord.create.mockResolvedValue({
      id: analysisId,
      lastCompletedStep: 1,
      pickCount: 1,
      status: SelectionAnalysisStatus.COMPLETED,
      version: 1,
      createdAt: now,
      updatedAt: now,
      steps: [{ stepNo: 1, revision: 1 }],
    })

    const result = await service.create(7, {
      clientRequestId: "cd62082f-96f0-480e-9727-bbdf425cf6d8",
      marketplace: "us",
      entry: SelectionAnalysisEntry.PRODUCT,
      schemaVersion: 1,
      payload: {
        pdfUrl: "https://example.com/product-validation.pdf",
        productData: { asin: "B0GWK1HFXP", price: 17 },
      },
    })

    expect(result).toEqual(
      expect.objectContaining({
        analysisId,
        lastCompletedStep: 1,
        pickCount: 1,
        status: SelectionAnalysisStatus.COMPLETED,
      })
    )
    expect(firstCallArg(tx.selectionAnalysisRecord.create)).toMatchObject({
      data: {
        entry: SelectionAnalysisEntry.PRODUCT,
        categories: [],
        pickCount: 1,
        status: SelectionAnalysisStatus.COMPLETED,
        steps: {
          create: {
            stepNo: 1,
            stepType: SelectionAnalysisStepType.PRODUCT_VALIDATION,
          },
        },
      },
    })
  })

  it("returns the original analysis for an identical create retry", async () => {
    const categories = [
      {
        nodeId: "172282",
        nodeIdPath: "Automotive:Cup Holders",
        name: "Cup Holders",
        nameCn: "杯架",
      },
    ]
    const payload = { diagnosis: [] }
    const createFingerprint = hashJson({
      marketplace: "US",
      entry: SelectionAnalysisEntry.CATALOG,
      primaryCategoryNodeId: "172282",
      categories,
      schemaVersion: 1,
      payload,
    })
    prisma.selectionAnalysisRecord.findUnique.mockResolvedValue({
      id: analysisId,
      createFingerprint,
      lastCompletedStep: 1,
      pickCount: 0,
      status: SelectionAnalysisStatus.PROCESSING,
      version: 1,
      createdAt: now,
      updatedAt: now,
      steps: [{ stepNo: 1, revision: 1 }],
    })

    const result = await service.create(7, {
      clientRequestId: "0a49d1d3-84e7-43a0-8a68-c24f0ed93d27",
      marketplace: "US",
      entry: SelectionAnalysisEntry.CATALOG,
      primaryCategoryNodeId: "172282",
      categories,
      schemaVersion: 1,
      payload,
    })

    expect(result.idempotentReplay).toBe(true)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("searches analysis records by marketplace, category name, or category path", async () => {
    prisma.selectionAnalysisRecord.findMany.mockResolvedValue([])
    prisma.selectionAnalysisRecord.count.mockResolvedValue(0)

    await service.findAll(7, { page: 1, pageSize: 20, keyword: " US " })

    const findManyCall = firstCallArg(prisma.selectionAnalysisRecord.findMany)
    expect(findManyCall).toMatchObject({
      where: {
        userId: 7,
        OR: [
          { marketplace: { contains: "US" } },
          { primaryCategoryName: { contains: "US" } },
          { primaryCategoryPath: { contains: "US" } },
        ],
      },
    })
    expect(prisma.selectionAnalysisRecord.count).toHaveBeenCalledWith({
      where: {
        userId: 7,
        OR: [
          { marketplace: { contains: "US" } },
          { primaryCategoryName: { contains: "US" } },
          { primaryCategoryPath: { contains: "US" } },
        ],
      },
    })
  })

  it("filters analysis records by entry", async () => {
    prisma.selectionAnalysisRecord.findMany.mockResolvedValue([])
    prisma.selectionAnalysisRecord.count.mockResolvedValue(0)

    await service.findAll(7, {
      page: 1,
      pageSize: 20,
      entry: SelectionAnalysisEntry.PRODUCT,
    })

    expect(firstCallArg(prisma.selectionAnalysisRecord.findMany)).toMatchObject({
      where: { userId: 7, entry: SelectionAnalysisEntry.PRODUCT },
    })
    expect(prisma.selectionAnalysisRecord.count).toHaveBeenCalledWith({
      where: { userId: 7, entry: SelectionAnalysisEntry.PRODUCT },
    })
  })

  it("rejects reuse of clientRequestId for different create content", async () => {
    prisma.selectionAnalysisRecord.findUnique.mockResolvedValue({
      id: analysisId,
      createFingerprint: "different-fingerprint",
      lastCompletedStep: 1,
      pickCount: 0,
      status: SelectionAnalysisStatus.PROCESSING,
      version: 1,
      createdAt: now,
      updatedAt: now,
      steps: [{ stepNo: 1, revision: 1 }],
    })

    await expect(
      service.create(7, {
        clientRequestId: "0a49d1d3-84e7-43a0-8a68-c24f0ed93d27",
        marketplace: "US",
        entry: SelectionAnalysisEntry.CATALOG,
        primaryCategoryNodeId: "172282",
        categories: [
          { nodeId: "172282", nodeIdPath: "Automotive:Cup Holders", name: "Cup Holders" },
        ],
        schemaVersion: 1,
        payload: { diagnosis: [] },
      })
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it("returns a no-op for the same step content without invalidating downstream", async () => {
    const payload = { oppResults: [], selectedKeywords: ["cup holder"] }
    tx.$queryRaw.mockResolvedValue([
      {
        id: analysisId,
        version: 5,
        lastCompletedStep: 5,
        pickCount: 4,
        status: SelectionAnalysisStatus.COMPLETED,
        createdAt: now,
        updatedAt: now,
      },
    ])
    tx.selectionAnalysisStep.findUnique.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce({
      id: 2,
      stepNo: 2,
      revision: 1,
      schemaVersion: 1,
      payloadHash: hashJson({ schemaVersion: 1, payload }),
    })

    const result = await service.saveStep(7, analysisId, 2, {
      expectedVersion: 1,
      schemaVersion: 1,
      payload,
    })

    expect(result).toEqual(
      expect.objectContaining({ changed: false, version: 5, lastCompletedStep: 5 })
    )
    expect(tx.selectionAnalysisStep.deleteMany).not.toHaveBeenCalled()
    expect(tx.selectionAnalysisStep.upsert).not.toHaveBeenCalled()
    expect(tx.selectionAnalysisRecord.update).not.toHaveBeenCalled()
  })

  it("updates an upstream step and invalidates all downstream steps", async () => {
    const payload = { oppResults: [{ keyword: "cup holder" }], selectedKeywords: ["cup holder"] }
    tx.$queryRaw.mockResolvedValue([
      {
        id: analysisId,
        version: 5,
        lastCompletedStep: 5,
        pickCount: 4,
        status: SelectionAnalysisStatus.COMPLETED,
        createdAt: now,
        updatedAt: now,
      },
    ])
    tx.selectionAnalysisStep.findUnique.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce({
      id: 2,
      stepNo: 2,
      revision: 1,
      schemaVersion: 1,
      payloadHash: "old-hash",
    })
    tx.selectionAnalysisStep.findMany.mockResolvedValue([
      { stepNo: 3 },
      { stepNo: 4 },
      { stepNo: 5 },
    ])
    tx.selectionAnalysisStep.upsert.mockResolvedValue({
      id: 2,
      stepNo: 2,
      revision: 2,
      stepType: SelectionAnalysisStepType.TRACK_VALIDATION,
    })
    tx.selectionAnalysisRecord.update.mockResolvedValue({
      id: analysisId,
      version: 6,
      lastCompletedStep: 2,
      pickCount: 0,
      status: SelectionAnalysisStatus.PROCESSING,
      createdAt: now,
      updatedAt: now,
    })

    const result = await service.saveStep(7, analysisId, 2, {
      expectedVersion: 5,
      schemaVersion: 1,
      payload,
    })

    expect(result).toEqual(
      expect.objectContaining({
        changed: true,
        version: 6,
        invalidatedSteps: [3, 4, 5],
        lastCompletedStep: 2,
      })
    )
    expect(tx.selectionAnalysisStep.deleteMany).toHaveBeenCalledWith({
      where: { analysisId, stepNo: { gt: 2 } },
    })
    const updateCall = firstCallArg(tx.selectionAnalysisRecord.update)
    expect(updateCall).toMatchObject({
      data: { pickCount: 0, status: SelectionAnalysisStatus.PROCESSING },
    })
  })

  it("rejects changed content when expectedVersion is stale", async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: analysisId,
        version: 4,
        lastCompletedStep: 2,
        pickCount: 0,
        status: SelectionAnalysisStatus.PROCESSING,
        createdAt: now,
        updatedAt: now,
      },
    ])
    tx.selectionAnalysisStep.findUnique.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce(null)

    await expect(
      service.saveStep(7, analysisId, 2, {
        expectedVersion: 3,
        schemaVersion: 1,
        payload: { oppResults: [], selectedKeywords: [] },
      })
    ).rejects.toBeInstanceOf(ConflictException)

    expect(tx.selectionAnalysisStep.upsert).not.toHaveBeenCalled()
  })

  it("rejects additional step submissions for a completed product validation", async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: analysisId,
        entry: SelectionAnalysisEntry.PRODUCT,
        version: 1,
        lastCompletedStep: 1,
        pickCount: 1,
        status: SelectionAnalysisStatus.COMPLETED,
        createdAt: now,
        updatedAt: now,
      },
    ])

    await expect(
      service.saveStep(7, analysisId, 1, {
        expectedVersion: 1,
        schemaVersion: 1,
        payload: { diagnosis: [] },
      })
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(tx.selectionAnalysisStep.upsert).not.toHaveBeenCalled()
  })
})

function firstCallArg(mock: jest.Mock): unknown {
  const calls = mock.mock.calls as unknown[][]
  return calls[0]?.[0]
}
