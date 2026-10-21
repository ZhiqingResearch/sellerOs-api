import { createHash } from "crypto"
import { UsageService } from "../usage/usage.service"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { CreatePromotionPlanRecordDto } from "./dto/create-promotion-plan-record.dto"
import { ListPromotionPlanRecordsDto } from "./dto/list-promotion-plan-records.dto"

@Injectable()
export class PromotionPlanRecordService {
  private readonly logger = new Logger(PromotionPlanRecordService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService
  ) {}

  async create(userId: number, dto: CreatePromotionPlanRecordDto) {
    assertSopResultShape(dto.result)

    const existing = await this.prisma.promotionPlanRecord.findUnique({
      where: { clientRequestId: dto.clientRequestId },
    })
    if (existing) return this.resolveExistingCreate(userId, existing)

    try {
      const record = await this.prisma.$transaction(async tx => {
        const saved = await tx.promotionPlanRecord.create({
          data: {
            userId,
            clientRequestId: dto.clientRequestId,
            schemaVersion: dto.schemaVersion,
            productName: dto.productName,
            market: dto.market,
            category: dto.category,
            anchorPrice: dto.anchorPrice,
            competitorCount: dto.competitorCount,
            input: toJson(dto.input),
            result: toJson(dto.result),
          },
        })
        await this.usage.chargeFixedModule(userId, "launch.plan", {
          model: "fixed-module",
          requestId: createHash("sha256").update(`launch.plan:${userId}:${dto.clientRequestId}`).digest("hex"),
          meta: { operation: "generate", recordId: saved.id },
        }, tx)
        return saved
      }, { timeout: 30000 })

      this.logger.log(`Promotion plan record created: id=${record.id}, user=${userId}`)
      return createResponse(record, false)
    } catch (error) {
      if (!(error instanceof PrismaClientKnownRequestError) || error.code !== "P2002") throw error
      const conflict = await this.prisma.promotionPlanRecord.findUnique({
        where: { clientRequestId: dto.clientRequestId },
      })
      if (!conflict) throw error
      return this.resolveExistingCreate(userId, conflict)
    }
  }

  private resolveExistingCreate(
    userId: number,
    record: { id: string; userId: number; version: number; createdAt: Date; updatedAt: Date }
  ) {
    if (record.userId !== userId) throw clientRequestIdTaken()
    return createResponse(record, true)
  }

  async findAll(userId: number, query: ListPromotionPlanRecordsDto) {
    const { page, pageSize } = query
    const keyword = query.keyword?.trim() || undefined
    const category = query.category?.trim() || undefined
    const createdAt = dateRange(query.dateFrom, query.dateTo)
    const where: Prisma.PromotionPlanRecordWhereInput = {
      userId,
      ...(query.market && { market: query.market }),
      ...(category && { category }),
      ...(createdAt && { createdAt }),
      ...(keyword && { productName: { contains: keyword } }),
    }

    const [items, total] = await Promise.all([
      this.prisma.promotionPlanRecord.findMany({
        where,
        select: {
          id: true,
          productName: true,
          market: true,
          category: true,
          anchorPrice: true,
          competitorCount: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.promotionPlanRecord.count({ where }),
    ])

    return {
      items: items.map(item => ({
        recordId: item.id,
        productName: item.productName,
        market: item.market,
        category: item.category,
        anchorPrice: item.anchorPrice,
        competitorCount: item.competitorCount,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  async findOne(userId: number, recordId: string) {
    const record = await this.prisma.promotionPlanRecord.findFirst({
      where: { id: recordId, userId },
    })
    if (!record) throw promotionPlanRecordNotFound()

    return {
      recordId: record.id,
      schemaVersion: record.schemaVersion,
      version: record.version,
      productName: record.productName,
      market: record.market,
      category: record.category,
      anchorPrice: record.anchorPrice,
      competitorCount: record.competitorCount,
      input: record.input,
      result: record.result,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  async remove(userId: number, recordId: string) {
    const result = await this.prisma.promotionPlanRecord.deleteMany({
      where: { id: recordId, userId },
    })
    if (result.count === 0) throw promotionPlanRecordNotFound()
    this.logger.log(`Promotion plan record deleted: id=${recordId}, user=${userId}`)
  }
}

function assertSopResultShape(result: Record<string, unknown>) {
  const productName = result.productName
  if (typeof productName !== "string" || productName.trim() === "") {
    throw new BadRequestException({
      code: "INVALID_SOP_RESULT",
      message: "result.productName 必须为非空字符串",
    })
  }
}

function createResponse(
  record: { id: string; version: number; createdAt: Date; updatedAt: Date },
  idempotentReplay: boolean
) {
  return {
    recordId: record.id,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    idempotentReplay,
  }
}

function dateRange(dateFrom?: string, dateTo?: string): Prisma.DateTimeFilter | undefined {
  if (!dateFrom && !dateTo) return undefined
  const from = dateFrom ? parseShanghaiDate(dateFrom, 0) : undefined
  const to = dateTo ? parseShanghaiDate(dateTo, 1) : undefined
  if (from && to && from >= to) {
    throw new BadRequestException({
      code: "INVALID_DATE_RANGE",
      message: "dateFrom 不能晚于 dateTo",
    })
  }
  return { ...(from && { gte: from }), ...(to && { lt: to }) }
}

function parseShanghaiDate(value: string, dayOffset: number) {
  const [year, month, day] = value.split("-").map(Number)
  const check = new Date(Date.UTC(year, month - 1, day))
  if (
    year < 1970 ||
    year > 9998 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new BadRequestException({
      code: "INVALID_DATE_RANGE",
      message: `${value} 不是有效日期`,
    })
  }
  return new Date(Date.UTC(year, month - 1, day + dayOffset) - 8 * 60 * 60 * 1000)
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function promotionPlanRecordNotFound() {
  return new NotFoundException({
    code: "PROMOTION_PLAN_RECORD_NOT_FOUND",
    message: "记录不存在",
  })
}

function clientRequestIdTaken() {
  return new ConflictException({
    code: "CLIENT_REQUEST_ID_TAKEN",
    message: "clientRequestId 已被占用",
  })
}
