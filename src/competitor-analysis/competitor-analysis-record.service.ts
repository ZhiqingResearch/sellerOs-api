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
import {
  normalizeCompetitorAnalysisMarketplace,
  validateAndNormalizeCompetitorAnalysisRecord,
} from "./competitor-analysis-record.validator"
import { CreateCompetitorAnalysisRecordDto } from "./dto/create-competitor-analysis-record.dto"
import { QueryCompetitorAnalysisRecordDto } from "./dto/query-competitor-analysis-record.dto"

interface ExistingCreateRow {
  id: string
  createFingerprint: string
  deletedAt: Date | null
}

@Injectable()
export class CompetitorAnalysisRecordService {
  private readonly logger = new Logger(CompetitorAnalysisRecordService.name)

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: number, dto: CreateCompetitorAnalysisRecordDto) {
    const snapshot = validateAndNormalizeCompetitorAnalysisRecord(dto)
    const createFingerprint = hashJson(fingerprintPayload(snapshot))

    const existing = await this.prisma.competitorAnalysisRecord.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId: dto.clientRequestId } },
    })
    if (existing) return this.handleExistingCreate(existing, createFingerprint)

    try {
      const record = await this.prisma.$transaction(transaction =>
        transaction.competitorAnalysisRecord.create({
          data: {
            userId,
            clientRequestId: dto.clientRequestId,
            createFingerprint,
            schemaVersion: snapshot.schemaVersion,
            marketplace: snapshot.marketplace,
            mode: snapshot.input.mode,
            ownAsin: snapshot.input.ownAsin,
            competitorAsins: toJson(snapshot.input.competitorAsins),
            sourceKeyword: snapshot.input.keyword,
            title: snapshot.title,
            productCount: snapshot.productCount,
            competitorCount: snapshot.competitorCount,
            inputSnapshot: toJson(snapshot.input),
            analysisResult: toJson(snapshot.analysisResult),
            reportData: toJson(snapshot.reportData),
            payloadBytes: snapshot.payloadBytes,
            products: {
              create: snapshot.products.map(product => ({
                asin: product.asin,
                sortOrder: product.sortOrder,
                productData: toJson(product.productData),
                steps: {
                  create: product.steps.map(step => ({
                    stepCode: step.stepCode,
                    stepNo: step.stepNo,
                    schemaVersion: step.schemaVersion,
                    resultData: toJson(step.resultData),
                    payloadHash: step.payloadHash,
                    payloadBytes: step.payloadBytes,
                  })),
                },
              })),
            },
          },
        })
      )

      this.logger.log(
        `Competitor analysis record created: id=${record.id}, user=${userId}, ` +
          `products=${snapshot.productCount}, payloadBytes=${snapshot.payloadBytes}`
      )
      return createResponse(record, false)
    } catch (error) {
      if (!(error instanceof PrismaClientKnownRequestError) || error.code !== "P2002") throw error
      return this.resolveCreateUniqueConflict(userId, dto.clientRequestId, createFingerprint)
    }
  }

  async findAll(userId: number, query: QueryCompetitorAnalysisRecordDto) {
    const { page, pageSize } = query
    const keyword = query.keyword?.trim().toUpperCase() || undefined
    const createdAt = dateRange(query.dateFrom, query.dateTo)
    const asinFilter = keyword ? buildAsinFilter(keyword) : undefined
    const where: Prisma.CompetitorAnalysisRecordWhereInput = {
      userId,
      ...(query.marketplace && {
        marketplace: normalizeCompetitorAnalysisMarketplace(query.marketplace),
      }),
      ...(createdAt && { createdAt }),
      ...(asinFilter && { OR: asinFilter }),
    }

    const [items, total] = await Promise.all([
      this.prisma.competitorAnalysisRecord.findMany({
        where,
        select: {
          id: true,
          marketplace: true,
          mode: true,
          ownAsin: true,
          competitorAsins: true,
          sourceKeyword: true,
          title: true,
          productCount: true,
          competitorCount: true,
          reportPdfUrl: true,
          version: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.competitorAnalysisRecord.count({ where }),
    ])

    return {
      items: items.map(item => ({
        recordId: item.id,
        marketplace: item.marketplace,
        mode: item.mode,
        title: item.title,
        ownAsin: item.ownAsin,
        competitorAsins: jsonStringArray(item.competitorAsins),
        keyword: item.sourceKeyword,
        productCount: item.productCount,
        competitorCount: item.competitorCount,
        reportPdfUrl: item.reportPdfUrl,
        version: item.version,
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
    const record = await this.prisma.competitorAnalysisRecord.findFirst({
      where: { id: recordId, userId },
      include: {
        products: {
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          include: { steps: { orderBy: [{ stepNo: "asc" }, { id: "asc" }] } },
        },
      },
    })
    if (!record) throw competitorAnalysisRecordNotFound()

    return {
      recordId: record.id,
      schemaVersion: record.schemaVersion,
      version: record.version,
      marketplace: record.marketplace,
      input: record.inputSnapshot,
      summary: summaryResponse(record),
      analysisResult: record.analysisResult,
      products: record.products.map(product => ({
        productId: product.id,
        asin: product.asin,
        sortOrder: product.sortOrder,
        productData: product.productData,
        steps: product.steps.map(step => ({
          stepCode: step.stepCode,
          stepNo: step.stepNo,
          schemaVersion: step.schemaVersion,
          resultData: step.resultData,
        })),
      })),
      reportData: record.reportData,
      reportPdfUrl: record.reportPdfUrl,
      reportPdfUpdatedAt: record.reportPdfUpdatedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  async updateReportPdf(userId: number, recordId: string, requestedUrl: string) {
    const reportPdfUrl = this.normalizeReportPdfUrl(requestedUrl)
    const existing = await this.prisma.competitorAnalysisRecord.findFirst({
      where: { id: recordId, userId },
      select: {
        id: true,
        reportPdfUrl: true,
        reportPdfUpdatedAt: true,
        version: true,
        updatedAt: true,
      },
    })
    if (!existing) throw competitorAnalysisRecordNotFound()

    if (existing.reportPdfUrl === reportPdfUrl) {
      return pdfResponse(existing, false)
    }

    const reportPdfUpdatedAt = new Date()
    const result = await this.prisma.competitorAnalysisRecord.updateMany({
      where: { id: recordId, userId, deletedAt: null },
      data: {
        reportPdfUrl,
        reportPdfUpdatedAt,
        version: { increment: 1 },
      },
    })
    if (result.count === 0) throw competitorAnalysisRecordNotFound()

    const updated = await this.prisma.competitorAnalysisRecord.findFirst({
      where: { id: recordId, userId },
      select: {
        id: true,
        reportPdfUrl: true,
        reportPdfUpdatedAt: true,
        version: true,
        updatedAt: true,
      },
    })
    if (!updated) throw competitorAnalysisRecordNotFound()

    this.logger.log(`Competitor analysis PDF updated: id=${recordId}, user=${userId}`)
    return pdfResponse(updated, true)
  }

  async remove(userId: number, recordId: string) {
    const result = await this.prisma.competitorAnalysisRecord.updateMany({
      where: { id: recordId, userId, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    })
    if (result.count === 0) throw competitorAnalysisRecordNotFound()
    this.logger.log(`Competitor analysis record deleted: id=${recordId}, user=${userId}`)
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
      FROM CompetitorAnalysisRecord
      WHERE userId = ${userId} AND clientRequestId = ${clientRequestId}
      LIMIT 1
    `
    const row = rows[0]
    if (!row) throw new ConflictException("创建竞品分析记录时发生唯一约束冲突")
    if (row.deletedAt) {
      throw new ConflictException({
        code: "COMPETITOR_RECORD_ALREADY_DELETED",
        message: "该创建请求对应的竞品分析记录已删除，请生成新的 clientRequestId",
      })
    }
    if (row.createFingerprint !== fingerprint) throw reusedClientRequestId()

    const record = await this.prisma.competitorAnalysisRecord.findFirst({
      where: { id: row.id, userId },
    })
    if (!record) throw competitorAnalysisRecordNotFound()
    return this.handleExistingCreate(record, fingerprint)
  }

  private normalizeReportPdfUrl(value: string) {
    let url: URL
    try {
      url = new URL(value.trim())
    } catch {
      throw invalidReportPdfUrl("reportPdfUrl 不是合法 URL")
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw invalidReportPdfUrl("reportPdfUrl 必须是无账号信息的 HTTPS URL")
    }

    return url.toString()
  }
}

function buildAsinFilter(keyword: string): Prisma.CompetitorAnalysisRecordWhereInput[] {
  if (/^[A-Z0-9]{10}$/.test(keyword)) {
    return [{ ownAsin: keyword }, { products: { some: { asin: keyword } } }]
  }
  return [
    { ownAsin: { contains: keyword } },
    { products: { some: { asin: { contains: keyword } } } },
  ]
}

function fingerprintPayload(
  snapshot: ReturnType<typeof validateAndNormalizeCompetitorAnalysisRecord>
) {
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

function summaryResponse(record: {
  title: string
  ownAsin: string | null
  competitorAsins: Prisma.JsonValue
  productCount: number
  competitorCount: number
}) {
  return {
    title: record.title,
    ownAsin: record.ownAsin,
    competitorAsins: jsonStringArray(record.competitorAsins),
    productCount: record.productCount,
    competitorCount: record.competitorCount,
  }
}

function pdfResponse(
  record: {
    id: string
    reportPdfUrl: string | null
    reportPdfUpdatedAt: Date | null
    version: number
    updatedAt: Date
  },
  changed: boolean
) {
  return {
    recordId: record.id,
    reportPdfUrl: record.reportPdfUrl,
    reportPdfUpdatedAt: record.reportPdfUpdatedAt,
    version: record.version,
    updatedAt: record.updatedAt,
    changed,
  }
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return []
  return value
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

function competitorAnalysisRecordNotFound() {
  return new NotFoundException({
    code: "COMPETITOR_RECORD_NOT_FOUND",
    message: "竞品分析记录不存在",
  })
}

function reusedClientRequestId() {
  return new ConflictException({
    code: "CLIENT_REQUEST_ID_REUSED",
    message: "clientRequestId 已被用于其他竞品分析内容，请生成新的请求 ID",
  })
}

function invalidReportPdfUrl(message: string) {
  return new BadRequestException({ code: "INVALID_REPORT_PDF_URL", message })
}
