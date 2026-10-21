import { Injectable, Logger } from "@nestjs/common"
import { PrismaService } from "../prisma/prisma.service"
import { CreateSelectedProductsDto } from "./dto/create-selected-products.dto"

@Injectable()
export class SelectedProductService {
  private readonly logger = new Logger(SelectedProductService.name)

  constructor(private readonly prisma: PrismaService) {}

  async createBatch(userId: number, dto: CreateSelectedProductsDto) {
    const result = await this.prisma.selectedProduct.createMany({
      data: dto.productCodes.map(productCode => ({
        productCode,
        userId,
      })),
    })
    this.logger.log(`SelectedProduct batch created: count=${result.count}, user=${userId}`)
    return { count: result.count }
  }
}
