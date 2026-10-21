import { BadRequestException, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { hashJson } from "../product-selection/canonical-json"
import { ProductLibrarySortBy, ProductLibrarySortOrder } from "./dto/query-product-library-item.dto"
import { ProductLibraryService } from "./product-library.service"

describe("ProductLibraryService", () => {
  interface TransactionMock {
    selectionAnalysisRecord: { findMany: jest.Mock }
    productLibraryItem: { upsert: jest.Mock; create: jest.Mock }
    productLibrarySnapshot: {
      findUnique: jest.Mock
      create: jest.Mock
      update: jest.Mock
    }
  }

  interface PrismaMock {
    $transaction: jest.Mock
    productLibraryItem: {
      findMany: jest.Mock
      count: jest.Mock
      findFirst: jest.Mock
      updateMany: jest.Mock
    }
  }

  let service: ProductLibraryService
  let prisma: PrismaMock
  let tx: TransactionMock

  const now = new Date("2026-08-20T00:00:00.000Z")
  const sourceAnalysisId = "5e10c2ea-f40e-48c7-9074-45388a7bfb2f"
  const baseDto = {
    asin: "b0gwk1hfxp",
    marketplace: "us",
    keyword: "  cup   holder ",
    title: "Cup Holder",
    compScore: 6.07,
    price: 17,
    monthlySales: 800,
    ratingNum: 27,
    sourceAnalysisId,
    tags: ["重点观察"],
    notes: "下月复查",
    profile: { competitor: {}, analysis: {} },
  }

  beforeEach(() => {
    tx = {
      selectionAnalysisRecord: { findMany: jest.fn() },
      productLibraryItem: { upsert: jest.fn(), create: jest.fn() },
      productLibrarySnapshot: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    }
    prisma = {
      $transaction: jest.fn((callback: (client: TransactionMock) => unknown) => callback(tx)),
      productLibraryItem: {
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
    }
    service = new ProductLibraryService(prisma as unknown as PrismaService)
  })

  it("normalizes and saves one product plus its source snapshot", async () => {
    tx.selectionAnalysisRecord.findMany.mockResolvedValue([{ id: sourceAnalysisId }])
    tx.productLibraryItem.upsert.mockResolvedValue({
      id: 11,
      asin: "B0GWK1HFXP",
      marketplace: "US",
      createdAt: now,
      updatedAt: now,
    })
    tx.productLibrarySnapshot.findUnique.mockResolvedValue(null)
    tx.productLibrarySnapshot.create.mockResolvedValue({ id: 21 })

    const result = await service.create(7, baseDto)

    expect(result).toEqual(
      expect.objectContaining({ id: 11, snapshotId: 21, snapshotChanged: true })
    )
    const itemUpsertCall = firstCallArg(tx.productLibraryItem.upsert)
    expect(itemUpsertCall).toMatchObject({
      where: {
        userId_marketplace_asin: {
          userId: 7,
          marketplace: "US",
          asin: "B0GWK1HFXP",
        },
      },
      update: { latestKeyword: "cup holder", deletedAt: null },
    })
    const snapshotCreateCall = firstCallArg(tx.productLibrarySnapshot.create)
    expect(snapshotCreateCall).toMatchObject({
      data: { itemId: 11, sourceAnalysisId, keyword: "cup holder" },
    })
  })

  it("does not rewrite an unchanged source snapshot", async () => {
    const keyword = "cup holder"
    const profileHash = hashJson({
      keyword,
      compScore: 6.07,
      price: 17,
      monthlySales: 800,
      ratingNum: 27,
      profile: baseDto.profile,
    })
    tx.selectionAnalysisRecord.findMany.mockResolvedValue([{ id: sourceAnalysisId }])
    tx.productLibraryItem.upsert.mockResolvedValue({
      id: 11,
      asin: "B0GWK1HFXP",
      marketplace: "US",
      createdAt: now,
      updatedAt: now,
    })
    tx.productLibrarySnapshot.findUnique.mockResolvedValue({ id: 21, profileHash })

    const result = await service.create(7, baseDto)

    expect(result.snapshotChanged).toBe(false)
    expect(tx.productLibrarySnapshot.create).not.toHaveBeenCalled()
    expect(tx.productLibrarySnapshot.update).not.toHaveBeenCalled()
  })

  it("creates an independent product when asin is omitted", async () => {
    tx.selectionAnalysisRecord.findMany.mockResolvedValue([{ id: sourceAnalysisId }])
    tx.productLibraryItem.create.mockResolvedValue({
      id: 12,
      asin: null,
      marketplace: "US",
      createdAt: now,
      updatedAt: now,
    })
    tx.productLibrarySnapshot.findUnique.mockResolvedValue(null)
    tx.productLibrarySnapshot.create.mockResolvedValue({ id: 22 })

    const result = await service.create(7, { ...baseDto, asin: undefined })

    expect(result).toEqual(
      expect.objectContaining({ id: 12, asin: null, snapshotId: 22, snapshotChanged: true })
    )
    expect(firstCallArg(tx.productLibraryItem.create)).toMatchObject({ data: { asin: null } })
    expect(tx.productLibraryItem.upsert).not.toHaveBeenCalled()
  })

  it("rejects a source analysis that does not belong to the user", async () => {
    tx.selectionAnalysisRecord.findMany.mockResolvedValue([])

    await expect(service.create(7, baseDto)).rejects.toBeInstanceOf(NotFoundException)
    expect(tx.productLibraryItem.upsert).not.toHaveBeenCalled()
  })

  it("rejects duplicate source snapshots in one batch", async () => {
    await expect(
      service.createBatch(7, { items: [baseDto, { ...baseDto }] })
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("returns paginated summaries and converts Decimal values", async () => {
    prisma.productLibraryItem.findMany.mockResolvedValue([
      {
        id: 11,
        marketplace: "US",
        asin: "B0GWK1HFXP",
        title: "Cup Holder",
        brand: null,
        imageUrl: null,
        tags: [],
        notes: null,
        latestKeyword: "cup holder",
        latestCompScore: new Prisma.Decimal("6.0700"),
        latestPrice: new Prisma.Decimal("17.00"),
        latestMonthlySales: 800,
        latestRatingNum: 27,
        createdAt: now,
        updatedAt: now,
        snapshots: [
          {
            sourceAnalysisId,
            keyword: "cup holder",
            price: new Prisma.Decimal("17.00"),
            createdAt: now,
            updatedAt: now,
            sourceAnalysis: {
              entry: "CATALOG",
              primaryCategoryNodeId: "172282",
              primaryCategoryName: "杯架",
              primaryCategoryPath: "Automotive:Cup Holders",
            },
          },
        ],
      },
    ])
    prisma.productLibraryItem.count.mockResolvedValue(1)

    const result = await service.findAll(7, {
      page: 1,
      pageSize: 10,
      sortBy: ProductLibrarySortBy.COMP_SCORE,
      order: ProductLibrarySortOrder.DESC,
    })

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        latestCompScore: 6.07,
        latestPrice: 17,
        sources: [
          expect.objectContaining({
            sourceAnalysisId,
            price: 17,
            primaryCategoryName: "杯架",
          }),
        ],
      })
    )
    expect(prisma.productLibraryItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { latestCompScore: "desc" } })
    )
  })

  it("filters by source analysis, category, price, and first-saved time", async () => {
    prisma.productLibraryItem.findMany.mockResolvedValue([])
    prisma.productLibraryItem.count.mockResolvedValue(0)

    await service.findAll(7, {
      page: 1,
      pageSize: 20,
      sourceAnalysisId,
      category: " 洗碗机 ",
      minPrice: 10,
      maxPrice: 100,
      dateFrom: "2026-08-01",
      dateTo: "2026-08-20",
      sortBy: ProductLibrarySortBy.CREATED_AT,
      order: ProductLibrarySortOrder.DESC,
    })

    expect(firstCallArg(prisma.productLibraryItem.findMany)).toMatchObject({
      where: {
        userId: 7,
        snapshots: {
          some: {
            sourceAnalysisId,
            sourceAnalysis: {
              OR: [
                { primaryCategoryNodeId: { contains: "洗碗机" } },
                { primaryCategoryName: { contains: "洗碗机" } },
                { primaryCategoryPath: { contains: "洗碗机" } },
              ],
            },
          },
        },
        latestPrice: { gte: 10, lte: 100 },
        createdAt: {
          gte: new Date("2026-08-01"),
          lt: new Date("2026-08-21"),
        },
      },
    })
  })

  it("rejects an inverted price range", async () => {
    await expect(
      service.findAll(7, {
        page: 1,
        pageSize: 20,
        minPrice: 100,
        maxPrice: 10,
        sortBy: ProductLibrarySortBy.UPDATED_AT,
        order: ProductLibrarySortOrder.DESC,
      })
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})

function firstCallArg(mock: jest.Mock): unknown {
  const calls = mock.mock.calls as unknown[][]
  return calls[0]?.[0]
}
