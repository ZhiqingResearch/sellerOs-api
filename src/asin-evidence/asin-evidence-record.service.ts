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
import { validateAsinEvidencePayload } from "./asin-evidence-record.validator"
import { CreateAsinEvidenceRecordDto } from "./dto/create-asin-evidence-record.dto"
import { QueryAsinEvidenceRecordDto } from "./dto/query-asin-evidence-record.dto"

interface ExistingCreateRow {
  id: string
  createFingerprint: string
  deletedAt: Date | null
}

@Injectable()
export class AsinEvidenceRecordService {
  private readonly logger = new Logger(AsinEvidenceRecordService.name)

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: number, dto: CreateAsinEvidenceRecordDto) {
    const asin = dto.asin.trim().toUpperCase()
    const country = dto.country.trim().toUpperCase()
    const model = dto.model.trim()
    const validation = validateAsinEvidencePayload(dto)
    const evidence = toJson(dto.evidence)
    // 创建指纹覆盖全部业务内容，防止幂等键被换内容复用。
    const createFingerprint = hashJson({ asin, country, model, evidence })

    const existing = await this.prisma.asinEvidenceRecord.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId: dto.clientRequestId } },
    })
    if (existing) return this.handleExistingCreate(existing, createFingerprint)

    try {
      const record = await this.prisma.asinEvidenceRecord.create({
        data: {
          userId,
          clientRequestId: dto.clientRequestId,
          createFingerprint,
          asin,
          country,
          productTitle: validation.productTitle,
          evidence,
          model,
        },
      })

      this.logger.log(
        `ASIN evidence record created: id=${record.id}, user=${userId}, asin=${asin}, country=${country}, evidenceBytes=${validation.evidenceBytes}`
      )
      return createResponse(record, false)
    } catch (error) {
      if (!(error instanceof PrismaClientKnownRequestError) || error.code !== "P2002") throw error
      return this.resolveCreateUniqueConflict(userId, dto.clientRequestId, createFingerprint)
    }
  }

  async findAll(userId: number, query: QueryAsinEvidenceRecordDto) {
    const { page, pageSize } = query
    const keyword = query.keyword?.trim()
    const createdAt = dateRange(query.dateFrom, query.dateTo)
    const where: Prisma.AsinEvidenceRecordWhereInput = {
      userId,
      deletedAt: null,
      ...(query.country && { country: query.country }),
      ...(createdAt && { createdAt }),
      ...(keyword && {
        OR: [
          { asin: { contains: keyword } },
          { productTitle: { contains: keyword } },
        ],
      }),
    }

    const [items, total] = await Promise.all([
      // 列表只读摘要字段，不加载 evidence 大 JSON。
      this.prisma.asinEvidenceRecord.findMany({
        where,
        select: {
          id: true,
          asin: true,
          country: true,
          productTitle: true,
          model: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.asinEvidenceRecord.count({ where }),
    ])

    return {
      items: items.map(item => ({ recordId: item.id, ...withoutId(item) })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  async findOne(userId: number, recordId: string) {
    const record = await this.prisma.asinEvidenceRecord.findFirst({
      where: { id: recordId, userId, deletedAt: null },
    })
    if (!record) throw asinEvidenceRecordNotFound()

    return {
      recordId: record.id,
      asin: record.asin,
      country: record.country,
      productTitle: record.productTitle,
      model: record.model,
      evidence: record.evidence,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  async remove(userId: number, recordId: string) {
    const result = await this.prisma.asinEvidenceRecord.updateMany({
      where: { id: recordId, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    })
    if (result.count === 0) throw asinEvidenceRecordNotFound()
    this.logger.log(`ASIN evidence record deleted: id=${recordId}, user=${userId}`)
  }

  private handleExistingCreate(
    record: {
      id: string
      createFingerprint: string
      deletedAt: Date | null
      createdAt: Date
      updatedAt: Date
    },
    fingerprint: string
  ) {
    if (record.deletedAt) throw alreadyDeleted()
    if (record.createFingerprint !== fingerprint) throw reusedClientRequestId()
    return createResponse(record, true)
  }

  private async resolveCreateUniqueConflict(
    userId: number,
    clientRequestId: string,
    fingerprint: string
  ) {
    // 软删除行仍占用唯一索引，P2002 后按原始行判断冲突类型。
    const rows = await this.prisma.$queryRaw<ExistingCreateRow[]>`
      SELECT id, createFingerprint, deletedAt
      FROM AsinEvidenceRecord
      WHERE userId = ${userId} AND clientRequestId = ${clientRequestId}
      LIMIT 1
    `
    const row = rows[0]
    if (!row) throw new ConflictException("创建取证记录时发生唯一约束冲突")
    if (row.deletedAt) throw alreadyDeleted()
    if (row.createFingerprint !== fingerprint) throw reusedClientRequestId()

    const record = await this.prisma.asinEvidenceRecord.findFirst({
      where: { id: row.id, userId },
    })
    if (!record) throw asinEvidenceRecordNotFound()
    return this.handleExistingCreate(record, fingerprint)
  }
}

function createResponse(
  record: {
    id: string
    createdAt: Date
    updatedAt: Date
  },
  idempotentReplay: boolean
) {
  return {
    recordId: record.id,
    idempotentReplay,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function withoutId<T extends { id: unknown }>(value: T): Omit<T, "id"> {
  const { id, ...rest } = value
  void id
  return rest
}

/** 时间范围：北京时间自然日整天，dateFrom/dateTo 均包含。 */
function dateRange(dateFrom?: string, dateTo?: string): Prisma.DateTimeFilter | undefined {
  if (!dateFrom && !dateTo) return undefined
  const from = dateFrom ? shanghaiDayStart(dateFrom) : undefined
  const to = dateTo ? shanghaiNextDayStart(dateTo) : undefined
  if (from && to && from >= to) {
    throw new BadRequestException({
      code: "INVALID_ASIN_EVIDENCE_DATE_RANGE",
      message: "dateFrom 不能晚于 dateTo",
    })
  }
  return { ...(from && { gte: from }), ...(to && { lt: to }) }
}

function shanghaiDayStart(value: string) {
  return parseDate(value, 0)
}

function shanghaiNextDayStart(value: string) {
  return parseDate(value, 1)
}

function parseDate(value: string, dayOffset: number) {
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
      code: "INVALID_ASIN_EVIDENCE_DATE_RANGE",
      message: `${value} 不是有效日期`,
    })
  }
  return new Date(Date.UTC(year, month - 1, day + dayOffset) - 8 * 60 * 60 * 1000)
}

function asinEvidenceRecordNotFound() {
  return new NotFoundException({
    code: "ASIN_EVIDENCE_RECORD_NOT_FOUND",
    message: "ASIN 取证记录不存在",
  })
}

function reusedClientRequestId() {
  return new ConflictException({
    code: "CLIENT_REQUEST_ID_REUSED",
    message: "clientRequestId 已被用于其他取证内容，请生成新的请求 ID",
  })
}

function alreadyDeleted() {
  return new ConflictException({
    code: "ASIN_EVIDENCE_RECORD_ALREADY_DELETED",
    message: "该创建请求对应的取证记录已删除，请生成新的 clientRequestId",
  })
}
