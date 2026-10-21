import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { AsinAuditRecordStatus, Prisma } from "@prisma/client"
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library"
import { hashJson } from "../../common/utils/canonical-json"
import { PrismaService } from "../../prisma/prisma.service"
import {
  validateCreateAsinAuditPayload,
  validateOptimizationPayload,
} from "./asin-audit-record.validator"
import { CreateAsinAuditRecordDto } from "./dto/create-asin-audit-record.dto"
import { QueryAsinAuditRecordDto } from "./dto/query-asin-audit-record.dto"
import { UpdateAsinAuditRecordDto } from "./dto/update-asin-audit-record.dto"

interface ExistingCreateRow {
  id: string
  createFingerprint: string
  deletedAt: Date | null
}

interface LockedAuditRecord {
  id: string
  version: number
  status: AsinAuditRecordStatus
  latestOptimizationRevision: number
  createdAt: Date
  updatedAt: Date
}

@Injectable()
export class AsinAuditRecordService {
  private readonly logger = new Logger(AsinAuditRecordService.name)

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: number, dto: CreateAsinAuditRecordDto) {
    const asin = dto.asin.trim().toUpperCase()
    const marketplace = normalizeCode(dto.marketplace, "marketplace")
    const country = normalizeCode(dto.country, "country")
    const category = {
      nodeId: normalizeRequiredText(dto.category.nodeId, "category.nodeId"),
      name: normalizeRequiredText(dto.category.name, "category.name"),
      path: normalizeRequiredText(dto.category.path, "category.path"),
    }
    const productTitle = normalizeRequiredText(dto.productTitle, "productTitle")
    const validation = validateCreateAsinAuditPayload(dto)
    const evidence = toJson(dto.evidence)
    const scoreResult = toJson(dto.scoreResult)
    // 快照哈希只覆盖第一步结构；创建指纹还会纳入商品和类目摘要，防止幂等键被换内容复用。
    const snapshotPayloadHash = hashJson({
      schemaVersion: dto.schemaVersion,
      evidence,
      scoreResult,
    })
    const createFingerprint = hashJson({
      schemaVersion: dto.schemaVersion,
      asin,
      marketplace,
      country,
      category,
      productTitle,
      adIncluded: dto.adIncluded,
      evidence,
      scoreResult,
    })

    const existing = await this.prisma.asinAuditRecord.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId: dto.clientRequestId } },
    })
    if (existing) return this.handleExistingCreate(existing, createFingerprint)

    try {
      // 主记录和第一步快照必须原子创建，避免出现只有列表摘要、没有详情快照的半成品。
      const record = await this.prisma.$transaction(tx =>
        tx.asinAuditRecord.create({
          data: {
            userId,
            clientRequestId: dto.clientRequestId,
            createFingerprint,
            asin,
            marketplace,
            country,
            productTitle,
            categoryNodeId: category.nodeId,
            categoryName: category.name,
            categoryPath: category.path,
            adIncluded: dto.adIncluded,
            overallScore: validation.score.overallScore,
            grade: validation.score.grade,
            contentScore: validation.score.contentScore,
            trafficScore: validation.score.trafficScore,
            adScore: validation.score.adScore,
            scoreSnapshot: {
              create: {
                schemaVersion: dto.schemaVersion,
                evidence,
                scoreResult,
                payloadHash: snapshotPayloadHash,
                payloadBytes: validation.snapshotPayloadBytes,
              },
            },
          },
        })
      )

      this.logger.log(
        `ASIN audit created: id=${record.id}, user=${userId}, payloadBytes=${validation.snapshotPayloadBytes}`
      )
      return createResponse(record, false)
    } catch (error) {
      if (!(error instanceof PrismaClientKnownRequestError) || error.code !== "P2002") throw error
      return this.resolveCreateUniqueConflict(userId, dto.clientRequestId, createFingerprint)
    }
  }

  async optimize(userId: number, recordId: string, dto: UpdateAsinAuditRecordDto) {
    const validation = validateOptimizationPayload(dto)
    const optimizationResult = toJson(dto.optimizationResult)
    const payloadHash = hashJson({
      schemaVersion: dto.schemaVersion,
      optimizationResult,
    })

    const response = await this.prisma.$transaction(
      async tx => {
        // 对主记录加行锁，串行分配 revision，防止并发优化写出重复版本号。
        const rows = await tx.$queryRaw<LockedAuditRecord[]>`
          SELECT id, version, status, latestOptimizationRevision, createdAt, updatedAt
          FROM AsinAuditRecord
          WHERE id = ${recordId}
            AND userId = ${userId}
            AND deletedAt IS NULL
          FOR UPDATE
        `
        const record = rows[0]
        if (!record) throw auditRecordNotFound()

        const currentRevision = record.latestOptimizationRevision
        const current =
          currentRevision > 0
            ? await tx.asinAuditOptimizationRevision.findUnique({
                where: { recordId_revision: { recordId, revision: currentRevision } },
                select: { payloadHash: true },
              })
            : null

        if (currentRevision > 0 && !current) {
          throw new ConflictException({
            code: "AUDIT_OPTIMIZATION_REVISION_MISSING",
            message: "审计记录缺少最新优化版本，请联系管理员",
          })
        }

        // 内容幂等判断先于乐观锁；网络重试即使携带旧 expectedVersion 也能安全成功。
        if (current?.payloadHash === payloadHash) {
          return optimizationResponse(record, currentRevision, false)
        }

        if (record.version !== dto.expectedVersion) {
          throw new ConflictException({
            code: "AUDIT_RECORD_VERSION_CONFLICT",
            message: "审计记录已在其他页面更新，请刷新后重试",
            details: { expectedVersion: dto.expectedVersion, currentVersion: record.version },
          })
        }

        // 只有优化内容真正变化时才新增子表版本并推进主记录版本。
        const nextRevision = currentRevision + 1
        await tx.asinAuditOptimizationRevision.create({
          data: {
            recordId,
            revision: nextRevision,
            schemaVersion: dto.schemaVersion,
            optimizationResult,
            payloadHash,
            payloadBytes: validation.payloadBytes,
          },
        })

        const updated = await tx.asinAuditRecord.update({
          where: { id: recordId },
          data: {
            status: AsinAuditRecordStatus.OPTIMIZED,
            version: { increment: 1 },
            latestOptimizationRevision: nextRevision,
            optimizedAt: new Date(),
          },
          select: {
            id: true,
            version: true,
            status: true,
            latestOptimizationRevision: true,
            createdAt: true,
            updatedAt: true,
          },
        })
        return optimizationResponse(updated, nextRevision, true)
      },
      { timeout: 10_000 }
    )

    if (response.changed) {
      this.logger.log(
        `ASIN audit optimized: id=${recordId}, user=${userId}, revision=${response.optimizationRevision}, payloadBytes=${validation.payloadBytes}`
      )
    }
    return response
  }

  async findAll(userId: number, query: QueryAsinAuditRecordDto) {
    const { page, pageSize } = query
    const keyword = query.keyword?.trim()
    const createdAt = dateRange(query.dateFrom, query.dateTo)
    const where: Prisma.AsinAuditRecordWhereInput = {
      userId,
      ...(query.marketplace && { marketplace: normalizeCode(query.marketplace, "marketplace") }),
      ...(createdAt && { createdAt }),
      ...(keyword && {
        OR: [
          { asin: { contains: keyword } },
          { productTitle: { contains: keyword } },
          { marketplace: { contains: keyword } },
          { country: { contains: keyword } },
          { categoryName: { contains: keyword } },
          { categoryPath: { contains: keyword } },
        ],
      }),
    }

    const [items, total] = await Promise.all([
      // 列表只读取主表摘要字段，避免加载 evidence、scoreResult 和优化结果大 JSON。
      this.prisma.asinAuditRecord.findMany({
        where,
        select: {
          id: true,
          asin: true,
          marketplace: true,
          country: true,
          categoryName: true,
          productTitle: true,
          adIncluded: true,
          overallScore: true,
          grade: true,
          contentScore: true,
          trafficScore: true,
          adScore: true,
          status: true,
          version: true,
          latestOptimizationRevision: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.asinAuditRecord.count({ where }),
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
    return this.prisma.$transaction(async tx => {
      const record = await tx.asinAuditRecord.findFirst({
        where: { id: recordId, userId, deletedAt: null },
      })
      if (!record) throw auditRecordNotFound()

      const snapshot = await tx.asinAuditScoreSnapshot.findUnique({
        where: { recordId },
      })
      if (!snapshot) {
        throw new ConflictException({
          code: "AUDIT_SCORE_SNAPSHOT_MISSING",
          message: "审计记录缺少取证与评分快照，请联系管理员",
        })
      }

      // 详情默认只读取最新优化，历史 revision 保留在子表中但不随详情批量返回。
      const optimization =
        record.latestOptimizationRevision > 0
          ? await tx.asinAuditOptimizationRevision.findUnique({
              where: {
                recordId_revision: {
                  recordId,
                  revision: record.latestOptimizationRevision,
                },
              },
              select: { optimizationResult: true },
            })
          : null

      if (record.latestOptimizationRevision > 0 && !optimization) {
        throw new ConflictException({
          code: "AUDIT_OPTIMIZATION_REVISION_MISSING",
          message: "审计记录缺少最新优化版本，请联系管理员",
        })
      }

      return {
        recordId: record.id,
        schemaVersion: snapshot.schemaVersion,
        version: record.version,
        status: record.status,
        asin: record.asin,
        marketplace: record.marketplace,
        country: record.country,
        category: {
          nodeId: record.categoryNodeId,
          name: record.categoryName,
          path: record.categoryPath,
        },
        productTitle: record.productTitle,
        adIncluded: record.adIncluded,
        evidence: snapshot.evidence,
        scoreResult: snapshot.scoreResult,
        optimizationRevision:
          record.latestOptimizationRevision > 0 ? record.latestOptimizationRevision : null,
        optimizationResult: optimization?.optimizationResult ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }
    })
  }

  async remove(userId: number, recordId: string) {
    const result = await this.prisma.asinAuditRecord.updateMany({
      where: { id: recordId, userId, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    })
    if (result.count === 0) throw auditRecordNotFound()
    this.logger.log(`ASIN audit deleted: id=${recordId}, user=${userId}`)
  }

  private handleExistingCreate(
    record: {
      id: string
      createFingerprint: string
      version: number
      status: AsinAuditRecordStatus
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
      FROM AsinAuditRecord
      WHERE userId = ${userId} AND clientRequestId = ${clientRequestId}
      LIMIT 1
    `
    const row = rows[0]
    if (!row) throw new ConflictException("创建审计记录时发生唯一约束冲突")
    if (row.deletedAt) {
      throw new ConflictException({
        code: "AUDIT_RECORD_ALREADY_DELETED",
        message: "该创建请求对应的审计记录已删除，请生成新的 clientRequestId",
      })
    }
    if (row.createFingerprint !== fingerprint) throw reusedClientRequestId()

    const record = await this.prisma.asinAuditRecord.findFirst({
      where: { id: row.id, userId },
    })
    if (!record) throw auditRecordNotFound()
    return this.handleExistingCreate(record, fingerprint)
  }
}

function createResponse(
  record: {
    id: string
    version: number
    status: AsinAuditRecordStatus
    createdAt: Date
    updatedAt: Date
  },
  idempotentReplay: boolean
) {
  return {
    recordId: record.id,
    version: record.version,
    status: record.status,
    idempotentReplay,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function optimizationResponse(
  record: {
    id: string
    version: number
    status: AsinAuditRecordStatus
    updatedAt: Date
  },
  optimizationRevision: number,
  changed: boolean
) {
  return {
    recordId: record.id,
    version: record.version,
    status: record.status,
    optimizationRevision,
    changed,
    updatedAt: record.updatedAt,
  }
}

function normalizeCode(value: string, field: string) {
  const normalized = value.trim().toUpperCase()
  if (!normalized) {
    throw new BadRequestException({
      code: "INVALID_AUDIT_RECORD_PAYLOAD",
      message: `${field} 不能为空`,
    })
  }
  return normalized
}

function normalizeRequiredText(value: string, field: string) {
  const normalized = value.trim()
  if (!normalized) {
    throw new BadRequestException({
      code: "INVALID_AUDIT_RECORD_PAYLOAD",
      message: `${field} 不能为空`,
    })
  }
  return normalized
}

function dateRange(dateFrom?: string, dateTo?: string): Prisma.DateTimeFilter | undefined {
  if (!dateFrom && !dateTo) return undefined
  const from = dateFrom ? shanghaiDayStart(dateFrom) : undefined
  const to = dateTo ? shanghaiNextDayStart(dateTo) : undefined
  if (from && to && from >= to) {
    throw new BadRequestException({
      code: "INVALID_AUDIT_DATE_RANGE",
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
      code: "INVALID_AUDIT_DATE_RANGE",
      message: `${value} 不是有效日期`,
    })
  }
  return new Date(Date.UTC(year, month - 1, day + dayOffset) - 8 * 60 * 60 * 1000)
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function withoutId<T extends { id: unknown }>(value: T): Omit<T, "id"> {
  const { id, ...rest } = value
  void id
  return rest
}

function auditRecordNotFound() {
  return new NotFoundException({ code: "AUDIT_RECORD_NOT_FOUND", message: "ASIN 审计记录不存在" })
}

function reusedClientRequestId() {
  return new ConflictException({
    code: "CLIENT_REQUEST_ID_REUSED",
    message: "clientRequestId 已被用于其他审计内容，请生成新的请求 ID",
  })
}
