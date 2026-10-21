import { UsageService } from "../usage/usage.service"
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common"
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { CreatePromotionPlanRecordDto } from "./dto/create-promotion-plan-record.dto"
import { PromotionPlanRecordService } from "./promotion-plan-record.service"

describe("PromotionPlanRecordService", () => {
  interface PrismaMock {
    $transaction: jest.Mock
    promotionPlanRecord: {
      findUnique: jest.Mock
      create: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
      findFirst: jest.Mock
      deleteMany: jest.Mock
    }
  }

  let prisma: PrismaMock
  let service: PromotionPlanRecordService
  const now = new Date("2026-08-30T02:11:05.000Z")
  const recordId = "0b9f6a3e-1111-4c22-b333-444455556666"

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn((callback: (tx: PrismaMock) => Promise<unknown>) => callback(prisma)),
      promotionPlanRecord: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        deleteMany: jest.fn(),
      },
    }
    service = new PromotionPlanRecordService(prisma as unknown as PrismaService, { chargeFixedModule: jest.fn().mockResolvedValue({}) } as unknown as UsageService)
  })

  it("creates an immutable snapshot and returns the record summary", async () => {
    prisma.promotionPlanRecord.findUnique.mockResolvedValue(null)
    prisma.promotionPlanRecord.create.mockResolvedValue({
      id: recordId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })

    const result = await service.create(7, createDto())

    expect(result).toEqual({
      recordId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      idempotentReplay: false,
    })
    expect(firstCallArg(prisma.promotionPlanRecord.create)).toMatchObject({
      data: {
        userId: 7,
        clientRequestId: "3f1c2b8e-6d4a-4f2e-9c1d-8a7b6c5d4e3f",
        schemaVersion: 1,
        productName: "便携榨汁杯 400ml",
        market: "amazon_us",
        category: "家居厨房",
        anchorPrice: 29.99,
        competitorCount: 2,
        input: {
          productText: "便携榨汁杯 400ml · USB-C 快充",
          competitors: [{ sourceUrl: "https://www.amazon.com/dp/B09VLJJPL6" }],
        },
        result: { productName: "便携榨汁杯 400ml", rows: [{ id: "anchor" }] },
      },
    })
  })

  it("returns the existing record for an identical create retry", async () => {
    prisma.promotionPlanRecord.findUnique.mockResolvedValue({
      id: recordId,
      userId: 7,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })

    const result = await service.create(7, createDto())

    expect(result).toMatchObject({ recordId, idempotentReplay: true })
    expect(prisma.promotionPlanRecord.create).not.toHaveBeenCalled()
  })

  it("rejects a clientRequestId already owned by another user", async () => {
    prisma.promotionPlanRecord.findUnique.mockResolvedValue({
      id: recordId,
      userId: 8,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })

    await expect(service.create(7, createDto())).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.promotionPlanRecord.create).not.toHaveBeenCalled()
  })

  it("resolves a unique-constraint race by re-querying the conflicting row", async () => {
    prisma.promotionPlanRecord.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: recordId,
      userId: 7,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    prisma.promotionPlanRecord.create.mockRejectedValue(p2002())

    const result = await service.create(7, createDto())

    expect(result).toMatchObject({ recordId, idempotentReplay: true })
  })

  it("rejects a unique-constraint race that belongs to another user", async () => {
    prisma.promotionPlanRecord.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: recordId,
      userId: 8,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    prisma.promotionPlanRecord.create.mockRejectedValue(p2002())

    await expect(service.create(7, createDto())).rejects.toBeInstanceOf(ConflictException)
  })

  it("rethrows non-P2002 create failures", async () => {
    prisma.promotionPlanRecord.findUnique.mockResolvedValue(null)
    prisma.promotionPlanRecord.create.mockRejectedValue(new Error("db down"))

    await expect(service.create(7, createDto())).rejects.toThrow("db down")
  })

  it("requires a non-empty result.productName", async () => {
    const dto = createDto()
    dto.result = { rows: [] }

    await expect(service.create(7, dto)).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.promotionPlanRecord.findUnique).not.toHaveBeenCalled()
  })

  it("builds Shanghai date boundaries and excludes snapshots from list queries", async () => {
    prisma.promotionPlanRecord.findMany.mockResolvedValue([
      {
        id: recordId,
        productName: "便携榨汁杯 400ml",
        market: "amazon_us",
        category: "家居厨房",
        anchorPrice: 29.99,
        competitorCount: 2,
        createdAt: now,
        updatedAt: now,
      },
    ])
    prisma.promotionPlanRecord.count.mockResolvedValue(1)

    const result = await service.findAll(7, {
      page: 1,
      pageSize: 10,
      keyword: " 榨汁 ",
      market: "amazon_us",
      category: " 家居厨房 ",
      dateFrom: "2026-08-30",
      dateTo: "2026-08-30",
    })

    expect(result).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    })
    expect(result.items[0]).toEqual({
      recordId,
      productName: "便携榨汁杯 400ml",
      market: "amazon_us",
      category: "家居厨房",
      anchorPrice: 29.99,
      competitorCount: 2,
      createdAt: now,
      updatedAt: now,
    })
    const query = firstCallArg(prisma.promotionPlanRecord.findMany)
    expect(query.where).toEqual({
      userId: 7,
      market: "amazon_us",
      category: "家居厨房",
      createdAt: {
        gte: new Date("2026-08-29T16:00:00.000Z"),
        lt: new Date("2026-08-30T16:00:00.000Z"),
      },
      productName: { contains: "榨汁" },
    })
    expect(query.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }])
    expect(query.select).not.toHaveProperty("input")
    expect(query.select).not.toHaveProperty("result")
  })

  it("returns an empty page without querying large payloads", async () => {
    prisma.promotionPlanRecord.findMany.mockResolvedValue([])
    prisma.promotionPlanRecord.count.mockResolvedValue(0)

    const result = await service.findAll(7, { page: 2, pageSize: 10 })

    expect(result).toMatchObject({ items: [], total: 0, page: 2, totalPages: 0 })
    expect(firstCallArg(prisma.promotionPlanRecord.findMany).skip).toBe(10)
  })

  it("rejects invalid calendar dates and inverted ranges", async () => {
    await expect(
      service.findAll(7, { page: 1, pageSize: 10, dateFrom: "2026-02-30" })
    ).rejects.toMatchObject({ response: { code: "INVALID_DATE_RANGE" } })
    await expect(
      service.findAll(7, { page: 1, pageSize: 10, dateFrom: "2026-08-31", dateTo: "2026-08-30" })
    ).rejects.toMatchObject({ response: { code: "INVALID_DATE_RANGE" } })
  })

  it("maps stored snapshots back to input/result in details", async () => {
    prisma.promotionPlanRecord.findFirst.mockResolvedValue({
      id: recordId,
      schemaVersion: 1,
      version: 1,
      productName: "便携榨汁杯 400ml",
      market: "amazon_us",
      category: "家居厨房",
      anchorPrice: 29.99,
      competitorCount: 2,
      input: { productText: "便携榨汁杯 400ml" },
      result: { productName: "便携榨汁杯 400ml", rows: [{ id: "anchor" }] },
      createdAt: now,
      updatedAt: now,
    })

    const result = await service.findOne(7, recordId)

    expect(result).toMatchObject({
      recordId,
      schemaVersion: 1,
      version: 1,
      input: { productText: "便携榨汁杯 400ml" },
      result: { rows: [{ id: "anchor" }] },
    })
    expect(firstCallArg(prisma.promotionPlanRecord.findFirst).where).toEqual({
      id: recordId,
      userId: 7,
    })
  })

  it("hides other users' records in details and deletes only owned rows", async () => {
    prisma.promotionPlanRecord.findFirst.mockResolvedValue(null)
    await expect(service.findOne(7, recordId)).rejects.toBeInstanceOf(NotFoundException)

    prisma.promotionPlanRecord.deleteMany.mockResolvedValue({ count: 1 })
    await expect(service.remove(7, recordId)).resolves.toBeUndefined()
    expect(firstCallArg(prisma.promotionPlanRecord.deleteMany)).toEqual({
      where: { id: recordId, userId: 7 },
    })

    prisma.promotionPlanRecord.deleteMany.mockResolvedValue({ count: 0 })
    await expect(service.remove(7, recordId)).rejects.toBeInstanceOf(NotFoundException)
  })
})

function createDto(): CreatePromotionPlanRecordDto {
  return {
    clientRequestId: "3f1c2b8e-6d4a-4f2e-9c1d-8a7b6c5d4e3f",
    schemaVersion: 1,
    productName: "便携榨汁杯 400ml",
    market: "amazon_us",
    category: "家居厨房",
    anchorPrice: 29.99,
    competitorCount: 2,
    input: {
      productText: "便携榨汁杯 400ml · USB-C 快充",
      competitorLinks: ["https://www.amazon.com/dp/B09VLJJPL6"],
      competitors: [
        {
          sourceUrl: "https://www.amazon.com/dp/B09VLJJPL6",
          title: "Portable Blender, USB Rechargeable",
        },
      ],
      targetPrice: 25.9,
      market: "amazon_us",
      category: "家居厨房",
    },
    result: { productName: "便携榨汁杯 400ml", rows: [{ id: "anchor" }] },
  }
}

function p2002() {
  return new PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  })
}

function firstCallArg(mock: jest.Mock): Record<string, unknown> {
  const calls = mock.mock.calls as unknown[][]
  return calls[0][0] as Record<string, unknown>
}
