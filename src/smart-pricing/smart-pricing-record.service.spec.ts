import { UsageService } from "../usage/usage.service"
import { ConflictException, NotFoundException } from "@nestjs/common"
import { PrismaService } from "../prisma/prisma.service"
import { createSmartPricingDto as createDto } from "./smart-pricing-record.fixture"
import { SmartPricingRecordService } from "./smart-pricing-record.service"

describe("SmartPricingRecordService", () => {
  interface PrismaMock {
    $transaction: jest.Mock
    $queryRaw: jest.Mock
    smartPricingRecord: {
      findUnique: jest.Mock
      create: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
      findFirst: jest.Mock
      updateMany: jest.Mock
    }
  }

  let prisma: PrismaMock
  let service: SmartPricingRecordService
  const now = new Date("2026-08-25T08:00:00.000Z")
  const recordId = "f31fce7d-99e2-45d8-943c-ed7055c95ce5"

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn((callback: (tx: PrismaMock) => Promise<unknown>) => callback(prisma)),
      $queryRaw: jest.fn(),
      smartPricingRecord: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
    }
    service = new SmartPricingRecordService(prisma as unknown as PrismaService, { chargeFixedModule: jest.fn().mockResolvedValue({}) } as unknown as UsageService)
  })

  it("creates a normalized immutable snapshot and extracts list summaries", async () => {
    prisma.smartPricingRecord.findUnique.mockResolvedValue(null)
    prisma.smartPricingRecord.create.mockResolvedValue({
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
    expect(firstCallArg(prisma.smartPricingRecord.create)).toMatchObject({
      data: {
        userId: 7,
        marketplaceCode: "AMAZON_US",
        marketplaceName: "Amazon US",
        currency: "USD",
        productName: "Example Product",
        suggestedPrice: 44.99,
        netMargin: 16.7113,
        netProfit: 7.5186,
        floorPrice: 33.3333,
        compositeScore: 74,
        verdictText: "✅ 可上架定价",
      },
    })
    const data = firstCallArg(prisma.smartPricingRecord.create).data as {
      product: { sourceUrl: string; sourceText: string }
    }
    expect(data.product.sourceUrl).toBe("https://www.1688.com/offer/123.html")
    expect(data.product.sourceText).toBe("https://www.1688.com/offer/123.html")
  })

  it("returns the existing record for an identical create retry", async () => {
    prisma.smartPricingRecord.findUnique.mockResolvedValue(null)
    prisma.smartPricingRecord.create.mockResolvedValue({
      id: recordId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    await service.create(7, createDto())
    const createData = firstCallArg(prisma.smartPricingRecord.create).data as {
      createFingerprint: string
    }
    const createFingerprint = createData.createFingerprint

    prisma.smartPricingRecord.findUnique.mockResolvedValue({
      id: recordId,
      createFingerprint,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    prisma.smartPricingRecord.create.mockClear()

    const result = await service.create(7, createDto())

    expect(result.idempotentReplay).toBe(true)
    expect(prisma.smartPricingRecord.create).not.toHaveBeenCalled()
  })

  it("rejects reuse of a client request ID for different content", async () => {
    prisma.smartPricingRecord.findUnique.mockResolvedValue({
      id: recordId,
      createFingerprint: "different",
      version: 1,
      createdAt: now,
      updatedAt: now,
    })

    await expect(service.create(7, createDto())).rejects.toBeInstanceOf(ConflictException)
  })

  it("builds Beijing date boundaries and excludes full snapshots from list queries", async () => {
    prisma.smartPricingRecord.findMany.mockResolvedValue([
      {
        id: recordId,
        productName: "Example Product",
        marketplaceCode: "AMAZON_US",
        marketplaceName: "Amazon US",
        currency: "USD",
        category: "家居厨房",
        suggestedPrice: 44.99,
        netMargin: 16.7113,
        netProfit: 7.5186,
        floorPrice: 33.3333,
        compositeScore: 74,
        verdictText: "✅ 可上架定价",
        createdAt: now,
        updatedAt: now,
      },
    ])
    prisma.smartPricingRecord.count.mockResolvedValue(1)

    const result = await service.findAll(7, {
      page: 1,
      pageSize: 10,
      keyword: " Example ",
      marketplaceCode: "amazon_us",
      category: " 家居厨房 ",
      dateFrom: "2026-08-25",
      dateTo: "2026-08-25",
    })

    expect(result.items[0]).toMatchObject({
      recordId,
      netMargin: 16.7113,
      verdict: "✅ 可上架定价",
    })
    const query = firstCallArg(prisma.smartPricingRecord.findMany)
    expect(query.where).toMatchObject({
      userId: 7,
      marketplaceCode: "AMAZON_US",
      category: "家居厨房",
      createdAt: {
        gte: new Date("2026-08-24T16:00:00.000Z"),
        lt: new Date("2026-08-25T16:00:00.000Z"),
      },
      OR: [
        { productName: { contains: "Example" } },
        { marketplaceName: { contains: "Example" } },
        { category: { contains: "Example" } },
      ],
    })
    expect(query.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }])
    expect(query.select).not.toHaveProperty("product")
    expect(query.select).not.toHaveProperty("result")
    expect(query.select).not.toHaveProperty("competitorContext")
  })

  it("maps the stored input snapshot back to input in details", async () => {
    prisma.smartPricingRecord.findFirst.mockResolvedValue({
      id: recordId,
      schemaVersion: 1,
      version: 1,
      marketplaceCode: "AMAZON_US",
      marketplaceName: "Amazon US",
      currency: "USD",
      category: "家居厨房",
      product: { name: "Example Product" },
      inputSnapshot: { cost: 12.3 },
      competitorContext: null,
      result: { rec: 44.99 },
      createdAt: now,
      updatedAt: now,
    })

    const result = await service.findOne(7, recordId)

    expect(result).toMatchObject({
      recordId,
      input: { cost: 12.3 },
      competitorContext: null,
    })
    expect(firstCallArg(prisma.smartPricingRecord.findFirst).where).toEqual({
      id: recordId,
      userId: 7,
    })
  })

  it("does not reveal another user's record and soft-deletes only owned rows", async () => {
    prisma.smartPricingRecord.findFirst.mockResolvedValue(null)
    await expect(service.findOne(7, recordId)).rejects.toBeInstanceOf(NotFoundException)

    prisma.smartPricingRecord.updateMany.mockResolvedValue({ count: 1 })
    await expect(service.remove(7, recordId)).resolves.toBeUndefined()
    expect(firstCallArg(prisma.smartPricingRecord.updateMany)).toMatchObject({
      where: { id: recordId, userId: 7, deletedAt: null },
      data: { version: { increment: 1 } },
    })

    prisma.smartPricingRecord.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.remove(7, recordId)).rejects.toBeInstanceOf(NotFoundException)
  })

  it("rejects invalid calendar dates", async () => {
    await expect(
      service.findAll(7, {
        page: 1,
        pageSize: 10,
        dateFrom: "2026-02-30",
      })
    ).rejects.toMatchObject({ response: { code: "INVALID_DATE_RANGE" } })
  })
})

function firstCallArg(mock: jest.Mock): Record<string, unknown> {
  const calls = mock.mock.calls as unknown[][]
  return calls[0][0] as Record<string, unknown>
}
