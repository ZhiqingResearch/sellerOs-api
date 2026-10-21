import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { Prisma, ProductFactoryRecord } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { CreateRecordDto } from "./dto/create-record.dto"
import { QueryRecordDto } from "./dto/query-record.dto"
import { UpdateRecordDto } from "./dto/update-record.dto"

/** 竞品来源完整 6 步（末步「新品推广 SOP」与 /promotion-plan 菜单页同能力并存）。 */
const TOTAL_STEPS_COMPETITOR = 6
/** 非竞品来源（自有商品等）：无 Step1 竞品拆解，共 5 步。 */
const TOTAL_STEPS_OTHER = 5

@Injectable()
export class ProductFactoryService {
  private readonly logger = new Logger(ProductFactoryService.name)

  constructor(private readonly prisma: PrismaService) {}

  async findAll(userId: number, query: QueryRecordDto) {
    const where: Prisma.ProductFactoryRecordWhereInput = { userId }
    if (query.keyword) where.productName = { contains: query.keyword }
    if (query.sourceType) where.sourceType = query.sourceType
    if (query.status) where.status = query.status

    const [items, total] = await Promise.all([
      this.prisma.productFactoryRecord.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.productFactoryRecord.count({ where }),
    ])
    return { items, total, page: query.page, pageSize: query.pageSize }
  }

  async create(userId: number, dto: CreateRecordDto) {
    const isCompetitor = dto.sourceType === "competitor"
    const urls = dto.sourceInput.competitorUrls ?? []
    if (isCompetitor && urls.length === 0) {
      throw new BadRequestException("竞品来源必须提供至少 1 个竞品链接")
    }

    let productName: string
    if (isCompetitor) {
      const first = urls[0]
      const asin = this.extractAsin(first)
      productName = `竞品复刻 · ${asin ?? first.slice(0, 40)}`
    } else {
      // 自有商品：品名 ← 我方名称 → 首份资料文件名 → 采购平台 → 未命名
      const our = dto.sourceInput.ourProduct as
        | { name?: string; documents?: { name?: string }[]; purchaseInfo?: { platform?: string } }
        | undefined
      const ownName =
        our?.name?.trim() ||
        our?.documents?.[0]?.name?.trim() ||
        our?.purchaseInfo?.platform?.trim() ||
        "未命名"
      productName = `自有商品 · ${ownName.slice(0, 40)}`
    }

    const record = await this.prisma.productFactoryRecord.create({
      data: {
        userId,
        sourceType: dto.sourceType,
        productName,
        market: dto.sourceInput.market,
        status: "draft",
        currentStep: 1,
        totalSteps: isCompetitor ? TOTAL_STEPS_COMPETITOR : TOTAL_STEPS_OTHER,
        sourceInput: dto.sourceInput as unknown as Prisma.InputJsonValue,
      },
    })
    this.logger.log(`ProductFactoryRecord created: id=${record.id}, user=${userId}`)
    return record
  }

  async findOne(userId: number, id: number) {
    return this.getOwnedRecord(userId, id)
  }

  async update(userId: number, id: number, dto: UpdateRecordDto) {
    const existing = await this.getOwnedRecord(userId, id)

    if (dto.currentStep !== undefined && dto.currentStep > existing.totalSteps) {
      throw new BadRequestException(`currentStep 不能超过 totalSteps（${existing.totalSteps}）`)
    }

    const data: Prisma.ProductFactoryRecordUpdateInput = {}
    if (dto.productName !== undefined) data.productName = dto.productName
    if (dto.status !== undefined) data.status = dto.status
    if (dto.currentStep !== undefined) data.currentStep = dto.currentStep
    if (dto.brandIdentity !== undefined)
      data.brandIdentity = dto.brandIdentity as Prisma.InputJsonValue
    if (dto.step1Data !== undefined) data.step1Data = dto.step1Data as Prisma.InputJsonValue
    if (dto.step2Data !== undefined) data.step2Data = dto.step2Data as Prisma.InputJsonValue
    if (dto.step3Data !== undefined) data.step3Data = dto.step3Data as Prisma.InputJsonValue
    if (dto.step4Data !== undefined) data.step4Data = dto.step4Data as Prisma.InputJsonValue
    if (dto.step5Data !== undefined) data.step5Data = dto.step5Data as Prisma.InputJsonValue
    if (dto.step6Data !== undefined) data.step6Data = dto.step6Data as Prisma.InputJsonValue

    // 写入 step1Data / step4Data 时按优先级重算缩略图：
    // step4Data 主图 URL → step1Data.competitors[0].imageUrl → null
    if (dto.step1Data !== undefined || dto.step4Data !== undefined) {
      const step4 = dto.step4Data ?? (existing.step4Data as Record<string, unknown> | null)
      const step1 = dto.step1Data ?? (existing.step1Data as Record<string, unknown> | null)
      const thumbnail = this.extractStep4MainImage(step4) ?? this.extractStep1Image(step1)
      // 签名 URL（OSS/Spaces 查询参数很长）可能超过 VarChar(500)，截断防写库报错
      data.thumbnailUrl = thumbnail ? thumbnail.slice(0, 500) : null
    }

    return this.prisma.productFactoryRecord.update({ where: { id: existing.id }, data })
  }

  async remove(userId: number, id: number) {
    const existing = await this.getOwnedRecord(userId, id)
    await this.prisma.productFactoryRecord.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    })
    this.logger.log(`ProductFactoryRecord soft-deleted: id=${existing.id}, user=${userId}`)
  }

  /** 所有读写强制 userId 隔离，跨用户访问一律 404 */
  private async getOwnedRecord(userId: number, id: number): Promise<ProductFactoryRecord> {
    const record = await this.prisma.productFactoryRecord.findFirst({ where: { id, userId } })
    if (!record) throw new NotFoundException("制作记录不存在")
    return record
  }

  /** 提取 ASIN：纯 ASIN 直接返回；Amazon URL 用正则提取；提不到返回 null */
  private extractAsin(input: string): string | null {
    if (/^[A-Za-z0-9]{10}$/.test(input)) return input
    const match = input.match(/(?:\/dp\/|\/gp\/product\/|\/ASIN\/)([A-Z0-9]{10})/i)
    if (match) return match[1].toUpperCase()
    const fallback = input.match(/\b([A-Z0-9]{10})\b/)
    return fallback ? fallback[1] : null
  }

  /**
   * 从 step4Data 里容错地找主图 URL：step4Data 字段结构前端尚未冻结，
   * 依次尝试 slots / img1 / mainImage / images 等常见位置，取第一个 http(s) URL。
   */
  private extractStep4MainImage(step4Data: Record<string, unknown> | null): string | null {
    if (!step4Data || typeof step4Data !== "object") return null
    const positions = ["slots", "img1", "image1", "mainImage", "main", "primaryImage", "images"]
    for (const key of positions) {
      const url = this.firstHttpUrl(step4Data[key], 0)
      if (url) return url
    }
    return null
  }

  private extractStep1Image(step1Data: Record<string, unknown> | null): string | null {
    if (!step1Data || typeof step1Data !== "object") return null
    const competitors = step1Data.competitors
    if (!Array.isArray(competitors) || competitors.length === 0) return null
    const first = competitors[0] as Record<string, unknown> | null
    const url = first?.imageUrl
    return typeof url === "string" && /^https?:\/\//.test(url) ? url : null
  }

  /** 在任意嵌套结构里找第一个 http(s) 字符串（限深防止意外大对象） */
  private firstHttpUrl(value: unknown, depth: number): string | null {
    if (value === null || value === undefined || depth > 4) return null
    if (typeof value === "string") return /^https?:\/\//.test(value) ? value : null
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.firstHttpUrl(item, depth + 1)
        if (found) return found
      }
      return null
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) {
        const found = this.firstHttpUrl(item, depth + 1)
        if (found) return found
      }
    }
    return null
  }
}
