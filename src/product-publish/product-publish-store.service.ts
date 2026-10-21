import { Injectable } from "@nestjs/common"
import { PrismaService } from "../prisma/prisma.service"

@Injectable()
export class ProductPublishStoreService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllActive() {
    const stores = await this.prisma.productPublishStore.findMany({
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

    return stores.map(({ classifications, ...store }) => ({
      ...store,
      categories: classifications,
    }))
  }
}
