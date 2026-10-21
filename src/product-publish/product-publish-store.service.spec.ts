import { PrismaService } from "../prisma/prisma.service"
import { ProductPublishStoreService } from "./product-publish-store.service"

describe("ProductPublishStoreService", () => {
  let service: ProductPublishStoreService
  let prisma: {
    productPublishStore: {
      findMany: jest.Mock
    }
  }

  beforeEach(() => {
    prisma = {
      productPublishStore: {
        findMany: jest.fn(),
      },
    }
    service = new ProductPublishStoreService(prisma as unknown as PrismaService)
  })

  it("只查询启用店铺并按店铺、分类顺序返回白名单字段", async () => {
    prisma.productPublishStore.findMany.mockResolvedValue([
      {
        id: 1,
        externalStoreId: "27826971599669",
        name: "亚马逊店铺",
        shortName: "测试店",
        companyName: "测试公司",
        platform: "AMAZON",
        accountType: "主账号",
        classifications: [
          {
            id: 10,
            classification: "NOTEBOOK COMPUTER",
            classificationName: "laptop",
            sortOrder: 0,
            templateUrl: "https://cdn.example.com/laptop.xlsm",
            templateStatus: "SUCCESS",
            templateSyncedAt: new Date("2026-08-03T00:00:00Z"),
          },
        ],
      },
    ])

    const result = await service.findAllActive()

    expect(prisma.productPublishStore.findMany).toHaveBeenCalledWith({
      where: { disabled: false, platform: "AMAZON" },
      orderBy: [{ shortName: "asc" }, { name: "asc" }],
      select: {
        id: true,
        externalStoreId: true,
        name: true,
        shortName: true,
        companyName: true,
        platform: true,
        accountType: true,
        classifications: {
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            classification: true,
            classificationName: true,
            sortOrder: true,
            templateUrl: true,
            templateStatus: true,
            templateSyncedAt: true,
          },
        },
      },
    })
    expect(result).toEqual([
      {
        id: 1,
        externalStoreId: "27826971599669",
        name: "亚马逊店铺",
        shortName: "测试店",
        companyName: "测试公司",
        platform: "AMAZON",
        accountType: "主账号",
        categories: [
          expect.objectContaining({
            classification: "NOTEBOOK COMPUTER",
            templateUrl: "https://cdn.example.com/laptop.xlsm",
          }),
        ],
      },
    ])
    expect(result[0]).not.toHaveProperty("classifications")
  })
})
