import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { QueryBrandKitDto, SaveBrandKitDto } from "./brand-kit.dto"

type Json = Prisma.InputJsonValue

@Injectable()
export class BrandKitService {
  constructor(private readonly prisma: PrismaService) {}

  // 保存当前品牌基因为一条品牌库记录（允许同名，不查重）
  create(dto: SaveBrandKitDto, userId: number) {
    return this.prisma.brandKit.create({
      data: {
        userId,
        brandNameZh: dto.brandNameZh,
        brandNameEn: dto.brandNameEn,
        primaryColors: dto.primaryColors as Json | undefined,
        applyBrandColor: dto.applyBrandColor,
        designStyles: dto.designStyles as Json | undefined,
        patterns: dto.patterns as Json | undefined,
        font: dto.font,
        logoUrl: dto.logoUrl,
        brandImageUrl: dto.brandImageUrl,
        tone: dto.tone,
      },
    })
  }

  // 列表：按中/英文名模糊搜索 + 分页（前端「从库导入」下拉首屏 6、加载更多每次 +6）。
  // 返回全字段，前端选中即回填表单，无需单独 detail / import 端点。
  async findAll(query: QueryBrandKitDto, userId: number) {
    const { page = 1, pageSize = 6, keyword } = query
    const where: Prisma.BrandKitWhereInput = {
      userId,
      ...(keyword
        ? {
            OR: [
              { brandNameZh: { contains: keyword } },
              { brandNameEn: { contains: keyword } },
            ],
          }
        : {}),
    }

    const [total, items] = await Promise.all([
      this.prisma.brandKit.count({ where }),
      this.prisma.brandKit.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return { total, page, pageSize, items }
  }

  async remove(id: number, userId: number) {
    const row = await this.prisma.brandKit.findUnique({ where: { id } })
    if (!row) throw new NotFoundException("品牌库记录不存在")
    if (row.userId !== userId) throw new ForbiddenException("无权操作该品牌库记录")
    await this.prisma.brandKit.update({ where: { id }, data: { deletedAt: new Date() } })
    return { success: true }
  }
}
