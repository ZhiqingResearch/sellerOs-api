import { Injectable, Logger, NotFoundException } from "@nestjs/common"
import { PaginationDto } from "../common/dto/pagination.dto"
import { PrismaService } from "../prisma/prisma.service"
import { CreateProductReportDto } from "./dto/create-product-report.dto"

@Injectable()
export class ProductReportService {
  private readonly logger = new Logger(ProductReportService.name)

  constructor(private readonly prisma: PrismaService) {}

  async findByUser(userId: number, pagination: PaginationDto) {
    const { page, pageSize } = pagination
    const skip = (page - 1) * pageSize

    const [items, total] = await Promise.all([
      this.prisma.productReport.findMany({
        where: { userId },
        select: {
          id: true,
          title: true,
          score: true,
          description: true,
          reportUrl: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.productReport.count({ where: { userId } }),
    ])

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  async findById(id: number) {
    const record = await this.prisma.productReport.findUnique({
      where: { id },
    })

    if (!record) {
      throw new NotFoundException("产品分析报告不存在")
    }

    return record
  }

  async create(userId: number, dto: CreateProductReportDto) {
    const record = await this.prisma.productReport.create({
      data: {
        title: dto.title,
        score: dto.score,
        description: dto.description,
        data: dto.data,
        reportUrl: dto.reportUrl,
        userId,
      },
    })
    this.logger.log(`ProductReport created: id=${record.id}, user=${userId}`)
    return record
  }

  async remove(id: number, userId: number) {
    const record = await this.prisma.productReport.findUnique({
      where: { id },
    })

    if (!record) {
      throw new NotFoundException("产品分析报告不存在")
    }

    await this.prisma.productReport.delete({ where: { id } })

    this.logger.log(`ProductReport deleted: id=${id}, user=${userId}`)
  }
}
