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
import { hashJson } from "../common/utils/canonical-json"
import { PrismaService } from "../prisma/prisma.service"
import { CreateSmartPricingRecordDto } from "./dto/create-smart-pricing-record.dto"
import { QuerySmartPricingRecordDto } from "./dto/query-smart-pricing-record.dto"
import {
  normalizeMarketplaceCode,
  validateAndNormalizeSmartPricingRecord,
} from "./smart-pricing-record.validator"

interface ExistingCreateRow {
  id: string
  createFingerprint: string
  deletedAt: Date | null
}

@Injectable()
export class SmartPricingRecordService {
  private readonly logger = new Logger(SmartPricingRecordService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService
  ) {}

  async create(userId: number, dto: CreateSmartPricingRecordDto) {
    const snapshot = validateAndNormalizeSmartPricingRecord(dto)
    const createFingerprint = hashJson(fingerprintPayload(snapshot))

    const existing = await this.prisma.smartPricingRecord.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId: dto.clientRequestId } },
    })
    if (existing) return this.handleExistingCreate(existing, createFingerprint)

    try {
      const record = await this.prisma.$transaction(async tx => {
        const saved = await tx.smartPricingRecord.create({
          data: {
            userId,
            clientRequestId: dto.clientRequestId,
            createFingerprint,
            schemaVersion: snapshot.schemaVersion,
            marketplaceCode: snapshot.marketplaceCode,
            marketplaceName: snapshot.marketplaceName,
            currency: snapshot.currency,
            category: snapshot.category,
            productName: snapshot.product.name,
            suggestedPrice: snapshot.result.rec,
            netMargin: snapshot.result.recMargin,
            netProfit: snapshot.result.recNet,
            floorPrice: snapshot.result.P_floor,
            compositeScore: snapshot.result.composite,
            verdictText: snapshot.result.verdict.t,
            product: toJson(snapshot.product),
            inputSnapshot: toJson(snapshot.input),
            competitorContext:
              snapshot.competitorContext === null
                ? Prisma.DbNull
                : toJson(snapshot.competitorContext),
            result: toJson(snapshot.result),
          },
        })
        await this.usage.chargeFixedModule(userId, "pricing.quote", {
          model: "fixed-module",
          requestId: createHash("sha256").update(`pricing.quote:${userId}:${dto.clientRequestId}`).digest("hex"),
          meta: { operation: "generate", recordId: saved.id },
        }, tx)
        return saved
      }, { timeout: 30000 })

      this.logger.log(
        `Smart pricing record created: id=${record.id}, user=${userId}, payloadBytes=${snapshot.payloadBytes}`
      )
      return createResponse(record, false)
    } catch (error) {
      if (!(error instanceof PrismaClientKnownRequestError) || error.code !== "P2002") throw error
      return this.resolveCreateUniqueConflict(userId, dto.clientRequestId, createFingerprint)
    }
  }

  async findAll(userId: number, query: QuerySmartPricingRecordDto) {
    const { page, pageSize } = query
    const keyword = query.keyword?.trim() || undefined
    const category = query.category?.trim() || undefined
    const createdAt = dateRange(query.dateFrom, query.dateTo)
    const where: Prisma.SmartPricingRecordWhereInput = {
      userId,
      ...(query.marketplaceCode && {
        marketplaceCode: normalizeMarketplaceCode(query.marketplaceCode),
      }),
      ...(category && { category }),
      ...(createdAt && { createdAt }),
      ...(keyword && {
        OR: [
          { productName: { contains: keyword } },
          { marketplaceName: { contains: keyword } },
          { category: { contains: keyword } },
        ],
      }),
    }

    const [items, total] = await Promise.all([
      this.prisma.smartPricingRecord.findMany({
        where,
        select: {
          id: true,
          productName: true,
          marketplaceCode: true,
          marketplaceName: true,
          currency: true,
          category: true,
          suggestedPrice: true,
          netMargin: true,
          netProfit: true,
          floorPrice: true,
          compositeScore: true,
          verdictText: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.smartPricingRecord.count({ where }),
    ])

    return {
      items: items.map(item => ({
        recordId: item.id,
        productName: item.productName,
        marketplaceCode: item.marketplaceCode,
        marketplaceName: item.marketplaceName,
        currency: item.currency,
        category: item.category,
        suggestedPrice: decimalToNumber(item.suggestedPrice),
        netMargin: decimalToNumber(item.netMargin),
        netProfit: decimalToNumber(item.netProfit),
        floorPrice: decimalToNumber(item.floorPrice),
        compositeScore: decimalToNumber(item.compositeScore),
        verdict: item.verdictText,
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
    const record = await this.prisma.smartPricingRecord.findFirst({
      where: { id: recordId, userId },
    })
    if (!record) throw smartPricingRecordNotFound()

    return {
      recordId: record.id,
      schemaVersion: record.schemaVersion,
      version: record.version,
      marketplaceCode: record.marketplaceCode,
      marketplaceName: record.marketplaceName,
      currency: record.currency,
      category: record.category,
      product: record.product,
      input: record.inputSnapshot,
      competitorContext: record.competitorContext,
      result: record.result,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  async remove(userId: number, recordId: string) {
    const result = await this.prisma.smartPricingRecord.updateMany({
      where: { id: recordId, userId, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    })
    if (result.count === 0) throw smartPricingRecordNotFound()
    this.logger.log(`Smart pricing record deleted: id=${recordId}, user=${userId}`)
  }

  private handleExistingCreate(
    record: {
      id: string
      createFingerprint: string
      version: number
      createdAt: Date
      updatedAt: Date
    },
    fingerprint: string
  ) {
    if (record.createFingerprint !== fingerprint) throw reusedClientRequestId()
    return createResponse(record, true)
  }

  private async resolveCreateUniqueConflict(
    userId: number,
    clientRequestId: string,
    fingerprint: string
  ) {
    const rows = await this.prisma.$queryRaw<ExistingCreateRow[]>`
      SELECT id, createFingerprint, deletedAt
      FROM SmartPricingRecord
      WHERE userId = ${userId} AND clientRequestId = ${clientRequestId}
      LIMIT 1
    `
    const row = rows[0]
    if (!row) throw new ConflictException("创建智能定价记录时发生唯一约束冲突")
    if (row.deletedAt) {
      throw new ConflictException({
        code: "SMART_PRICING_RECORD_ALREADY_DELETED",
        message: "该创建请求对应的智能定价记录已删除，请生成新的 clientRequestId",
      })
    }
    if (row.createFingerprint !== fingerprint) throw reusedClientRequestId()

    const record = await this.prisma.smartPricingRecord.findFirst({
      where: { id: row.id, userId },
    })
    if (!record) throw smartPricingRecordNotFound()
    return this.handleExistingCreate(record, fingerprint)
  }
}

function fingerprintPayload(snapshot: ReturnType<typeof validateAndNormalizeSmartPricingRecord>) {
  const { payloadBytes, ...payload } = snapshot
  void payloadBytes
  return payload
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

function decimalToNumber(value: Prisma.Decimal | number) {
  return typeof value === "number" ? value : value.toNumber()
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function smartPricingRecordNotFound() {
  return new NotFoundException({
    code: "SMART_PRICING_RECORD_NOT_FOUND",
    message: "智能定价记录不存在",
  })
}

function reusedClientRequestId() {
  return new ConflictException({
    code: "CLIENT_REQUEST_ID_REUSED",
    message: "clientRequestId 已被用于其他智能定价内容，请生成新的请求 ID",
  })
}
