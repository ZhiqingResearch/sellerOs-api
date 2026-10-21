import { createHash } from "crypto"
import { UsageService } from "../usage/usage.service"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import {
  Prisma,
  SelectionAnalysisEntry,
  SelectionAnalysisStatus,
  SelectionAnalysisStep,
  SelectionAnalysisStepType,
} from "@prisma/client"
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library"
import { PrismaService } from "../prisma/prisma.service"
import { validateProductPayload, validateStepPayload } from "./analysis-payload.validator"
import { hashJson } from "./canonical-json"
import { CreateAnalysisRecordDto } from "./dto/create-analysis-record.dto"
import { QueryAnalysisRecordDto } from "./dto/query-analysis-record.dto"
import { SaveAnalysisStepDto } from "./dto/save-analysis-step.dto"
import { STEP_TYPE_BY_NO } from "./product-selection.constants"

interface LockedAnalysis {
  id: string
  entry: SelectionAnalysisEntry
  version: number
  lastCompletedStep: number
  pickCount: number
  status: SelectionAnalysisStatus
  createdAt: Date
  updatedAt: Date
}

interface ExistingCreateRow {
  id: string
  createFingerprint: string
  deletedAt: Date | null
}

@Injectable()
export class AnalysisRecordService {
  private readonly logger = new Logger(AnalysisRecordService.name)

  constructor(private readonly prisma: PrismaService, private readonly usage: UsageService) {}

  async create(userId: number, dto: CreateAnalysisRecordDto) {
    const isProduct = dto.entry === SelectionAnalysisEntry.PRODUCT
    const marketplace = normalizeCode(dto.marketplace, "marketplace")
    const normalizedCategories = (dto.categories ?? []).map(item => ({
      nodeId: item.nodeId.trim(),
      nodeIdPath: item.nodeIdPath.trim(),
      name: item.name.trim(),
      ...(item.nameCn !== undefined && { nameCn: item.nameCn.trim() }),
    }))
    const categoryNodeIds = normalizedCategories.map(item => item.nodeId)
    if (new Set(categoryNodeIds).size !== categoryNodeIds.length) {
      throw new BadRequestException({
        code: "INVALID_CATEGORIES",
        message: "categories 不能包含重复的类目节点",
      })
    }
    const categories = toJson(normalizedCategories)
    const primaryNodeId = dto.primaryCategoryNodeId?.trim()
    const primaryCategory = primaryNodeId
      ? normalizedCategories.find(item => item.nodeId === primaryNodeId)
      : undefined
    if (!isProduct && !primaryCategory) {
      throw new BadRequestException({
        code: "INVALID_PRIMARY_CATEGORY",
        message: "primaryCategoryNodeId 必须存在于 categories 中",
      })
    }
    if (isProduct && (primaryNodeId || normalizedCategories.length > 0) && !primaryCategory) {
      throw new BadRequestException({
        code: "INVALID_PRIMARY_CATEGORY",
        message: "PRODUCT 传入类目时，primaryCategoryNodeId 必须存在于 categories 中",
      })
    }

    const validation = isProduct
      ? validateProductPayload(dto.payload)
      : validateStepPayload(1, dto.payload)
    const { payloadBytes } = validation
    const payload = toJson(dto.payload)
    const createFingerprint = hashJson({
      marketplace,
      entry: dto.entry,
      primaryCategoryNodeId: primaryNodeId ?? null,
      categories,
      schemaVersion: dto.schemaVersion,
      payload,
    })

    const existing = await this.prisma.selectionAnalysisRecord.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId: dto.clientRequestId } },
      include: { steps: { where: { stepNo: 1 }, take: 1 } },
    })
    if (existing) return this.handleExistingCreate(existing, createFingerprint)

    try {
      const record = await this.prisma.$transaction(async tx => {
        const saved = await tx.selectionAnalysisRecord.create({
          data: {
            userId,
            clientRequestId: dto.clientRequestId,
            createFingerprint,
            marketplace,
            entry: dto.entry,
            primaryCategoryNodeId: primaryNodeId,
            primaryCategoryPath: primaryCategory?.nodeIdPath.trim(),
            primaryCategoryName: primaryCategory
              ? primaryCategory.nameCn || primaryCategory.name
              : undefined,
            categories,
            pickCount: isProduct ? validation.pickCount : 0,
            status: isProduct
              ? SelectionAnalysisStatus.COMPLETED
              : SelectionAnalysisStatus.PROCESSING,
            steps: {
              create: {
                stepNo: 1,
                stepType: isProduct
                  ? SelectionAnalysisStepType.PRODUCT_VALIDATION
                  : STEP_TYPE_BY_NO[1],
                schemaVersion: dto.schemaVersion,
                payload,
                payloadHash: hashJson({ schemaVersion: dto.schemaVersion, payload }),
              },
            },
          },
          include: { steps: { where: { stepNo: 1 }, take: 1 } },
        })
        if (isProduct) await this.usage.chargeFixedModule(userId, "flow.workbench", {
          model: "fixed-module",
          requestId: createHash("sha256").update(`product-validation:${userId}:${dto.clientRequestId}`).digest("hex"),
          meta: { operation: "product_validation", analysisId: saved.id },
        }, tx)
        return saved
      }, { timeout: 30000 })

      this.logger.log(
        `Selection analysis created: id=${record.id}, user=${userId}, payloadBytes=${payloadBytes}`
      )
      return createResponse(record, record.steps[0], false)
    } catch (error) {
      if (!(error instanceof PrismaClientKnownRequestError) || error.code !== "P2002") throw error
      return this.resolveCreateUniqueConflict(userId, dto.clientRequestId, createFingerprint)
    }
  }

  async saveStep(userId: number, analysisId: string, stepNo: number, dto: SaveAnalysisStepDto) {
    const stepType = STEP_TYPE_BY_NO[stepNo]
    if (!stepType) {
      throw new BadRequestException({
        code: "INVALID_STEP_NO",
        message: "步骤编号必须是 1 到 5",
      })
    }
    if (stepNo !== 5 && dto.pickCount !== undefined) {
      throw new BadRequestException({
        code: "INVALID_STEP_PAYLOAD",
        message: "pickCount 只能在第5步提交",
      })
    }

    const validation = validateStepPayload(stepNo, dto.payload, dto.pickCount)
    const payload = toJson(dto.payload)
    const payloadHash = hashJson({ schemaVersion: dto.schemaVersion, payload })

    const result = await this.prisma.$transaction(
      async tx => {
        const rows = await tx.$queryRaw<LockedAnalysis[]>`
          SELECT id, entry, version, lastCompletedStep, pickCount, status, createdAt, updatedAt
          FROM SelectionAnalysisRecord
          WHERE id = ${analysisId}
            AND userId = ${userId}
            AND deletedAt IS NULL
          FOR UPDATE
        `
        const record = rows[0]
        if (!record) throw analysisNotFound()
        if (record.entry === SelectionAnalysisEntry.PRODUCT) {
          throw new BadRequestException({
            code: "PRODUCT_VALIDATION_ALREADY_COMPLETE",
            message: "产品验证为单步保存，不支持继续提交步骤",
          })
        }

        if (stepNo > 1) {
          const previous = await tx.selectionAnalysisStep.findUnique({
            where: { analysisId_stepNo: { analysisId, stepNo: stepNo - 1 } },
            select: { id: true },
          })
          if (!previous) {
            throw new ConflictException({
              code: "PREVIOUS_STEP_NOT_COMPLETED",
              message: `请先完成第${stepNo - 1}步`,
              details: { previousStepNo: stepNo - 1 },
            })
          }
        }

        const current = await tx.selectionAnalysisStep.findUnique({
          where: { analysisId_stepNo: { analysisId, stepNo } },
        })
        const sameContent =
          current?.payloadHash === payloadHash &&
          current.schemaVersion === dto.schemaVersion &&
          (stepNo !== 5 || record.pickCount === validation.pickCount)

        if (current && sameContent) {
          return stepResponse(record, current, false, [])
        }

        if (record.version !== dto.expectedVersion) {
          throw new ConflictException({
            code: "ANALYSIS_VERSION_CONFLICT",
            message: "分析记录已在其他页面更新，请刷新后重试",
            details: { expectedVersion: dto.expectedVersion, currentVersion: record.version },
          })
        }

        const downstream = await tx.selectionAnalysisStep.findMany({
          where: { analysisId, stepNo: { gt: stepNo } },
          select: { stepNo: true },
          orderBy: { stepNo: "asc" },
        })
        const invalidatedSteps = downstream.map(item => item.stepNo)

        if (invalidatedSteps.length > 0) {
          await tx.selectionAnalysisStep.deleteMany({
            where: { analysisId, stepNo: { gt: stepNo } },
          })
        }

        const step = await tx.selectionAnalysisStep.upsert({
          where: { analysisId_stepNo: { analysisId, stepNo } },
          create: {
            analysisId,
            stepNo,
            stepType,
            schemaVersion: dto.schemaVersion,
            payload,
            payloadHash,
          },
          update: {
            stepType,
            schemaVersion: dto.schemaVersion,
            payload,
            payloadHash,
            revision: { increment: 1 },
          },
        })

        const completed = stepNo === 5
        const updated = await tx.selectionAnalysisRecord.update({
          where: { id: analysisId },
          data: {
            lastCompletedStep: stepNo,
            pickCount: completed ? validation.pickCount : 0,
            status: completed
              ? SelectionAnalysisStatus.COMPLETED
              : SelectionAnalysisStatus.PROCESSING,
            version: { increment: 1 },
          },
          select: {
            id: true,
            version: true,
            lastCompletedStep: true,
            pickCount: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        })

        return stepResponse(updated, step, true, invalidatedSteps)
      },
      { timeout: 10_000 }
    )

    if (result.changed) {
      this.logger.log(
        `Selection step saved: analysis=${analysisId}, user=${userId}, step=${stepNo}, version=${result.version}, revision=${result.revision}, payloadBytes=${validation.payloadBytes}`
      )
    }
    return result
  }

  async findAll(
    userId: number,
    query: QueryAnalysisRecordDto,
    access = { hasSelectionAccess: true, hasCategoryAccess: false }
  ) {
    if (query.includeCategoryAnalysis) return this._findUnifiedHistory(userId, query, access)
    const { page, pageSize } = query
    const keyword = query.keyword?.trim()
    const where: Prisma.SelectionAnalysisRecordWhereInput = {
      userId,
      ...(query.marketplace && { marketplace: query.marketplace.trim().toUpperCase() }),
      ...(query.entry && { entry: query.entry }),
      ...(query.status && { status: query.status }),
      ...(keyword && {
        OR: [
          { marketplace: { contains: keyword } },
          { primaryCategoryName: { contains: keyword } },
          { primaryCategoryPath: { contains: keyword } },
        ],
      }),
    }

    const [items, total] = await Promise.all([
      this.prisma.selectionAnalysisRecord.findMany({
        where,
        select: {
          id: true,
          marketplace: true,
          entry: true,
          primaryCategoryName: true,
          primaryCategoryPath: true,
          lastCompletedStep: true,
          pickCount: true,
          status: true,
          version: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.selectionAnalysisRecord.count({ where }),
    ])

    return {
      items: items.map(item => ({ analysisId: item.id, ...withoutId(item) })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  private async _findUnifiedHistory(
    userId: number,
    query: QueryAnalysisRecordDto,
    access: { hasSelectionAccess: boolean; hasCategoryAccess: boolean }
  ) {
    const { page, pageSize } = query
    const keyword = query.keyword?.trim()
    const marketplace = query.marketplace?.trim().toUpperCase()
    const selectionWhere: Prisma.SelectionAnalysisRecordWhereInput = {
      userId,
      deletedAt: null,
      ...(marketplace && { marketplace }),
      ...(query.entry && { entry: query.entry }),
      ...(query.status && { status: query.status }),
      ...(keyword && {
        OR: [
          { marketplace: { contains: keyword } },
          { primaryCategoryName: { contains: keyword } },
          { primaryCategoryPath: { contains: keyword } },
        ],
      }),
    }
    const categoryWhere: Prisma.CategoryAnalysisRecordWhereInput = {
      userId,
      deletedAt: null,
      ...(marketplace && { marketplace }),
      ...(query.status && { status: query.status }),
      ...(keyword && {
        OR: [{ marketplace: { contains: keyword } }, { title: { contains: keyword } }],
      }),
    }
    const hasCategoryAccess = access.hasCategoryAccess && query.entry !== "PRODUCT"
    // Each source contributes its first N rows before slicing the merged page.
    // Fetching one page from each source would skip newer rows on later pages.
    const take = page * pageSize
    const [selectionRecords, selectionTotal, categoryRecords, categoryTotal] = await Promise.all([
      access.hasSelectionAccess
        ? this.prisma.selectionAnalysisRecord.findMany({
            where: selectionWhere,
            select: {
              id: true,
              marketplace: true,
              entry: true,
              primaryCategoryName: true,
              primaryCategoryPath: true,
              lastCompletedStep: true,
              pickCount: true,
              status: true,
              version: true,
              createdAt: true,
              updatedAt: true,
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take,
          })
        : [],
      access.hasSelectionAccess
        ? this.prisma.selectionAnalysisRecord.count({ where: selectionWhere })
        : 0,
      hasCategoryAccess
        ? this.prisma.categoryAnalysisRecord.findMany({
            where: categoryWhere,
            select: {
              id: true,
              marketplace: true,
              title: true,
              status: true,
              createdAt: true,
              updatedAt: true,
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take,
          })
        : [],
      hasCategoryAccess ? this.prisma.categoryAnalysisRecord.count({ where: categoryWhere }) : 0,
    ])
    const items = [
      ...selectionRecords.map(item => ({
        analysisId: item.id,
        ...withoutId(item),
        source: "SELECTION" as const,
      })),
      ...categoryRecords.map(item => ({
        analysisId: `category:${item.id}`,
        marketplace: item.marketplace,
        entry: "CATALOG" as const,
        primaryCategoryName: item.title,
        primaryCategoryPath: null,
        lastCompletedStep: 0,
        pickCount: 0,
        status: item.status,
        version: 0,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        source: "CATEGORY_ANALYSIS" as const,
      })),
    ]
      .sort((left, right) => {
        const timeDifference = right.updatedAt.getTime() - left.updatedAt.getTime()
        if (timeDifference) return timeDifference
        if (left.source !== right.source) return left.source === "CATEGORY_ANALYSIS" ? -1 : 1
        if (left.source === "CATEGORY_ANALYSIS")
          return Number(right.analysisId.slice(9)) - Number(left.analysisId.slice(9))
        return right.analysisId.localeCompare(left.analysisId)
      })
      .slice((page - 1) * pageSize, page * pageSize)
    const total = selectionTotal + categoryTotal
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }

  async findOne(userId: number, analysisId: string) {
    const record = await this.prisma.selectionAnalysisRecord.findFirst({
      where: { id: analysisId, userId },
      include: { steps: { orderBy: { stepNo: "asc" } } },
    })
    if (!record) throw analysisNotFound()

    return {
      analysisId: record.id,
      clientRequestId: record.clientRequestId,
      marketplace: record.marketplace,
      entry: record.entry,
      primaryCategoryNodeId: record.primaryCategoryNodeId,
      primaryCategoryPath: record.primaryCategoryPath,
      primaryCategoryName: record.primaryCategoryName,
      categories: record.categories,
      lastCompletedStep: record.lastCompletedStep,
      pickCount: record.pickCount,
      status: record.status,
      version: record.version,
      steps: record.steps.map(step => ({
        stepNo: step.stepNo,
        stepType: step.stepType,
        schemaVersion: step.schemaVersion,
        revision: step.revision,
        payload: step.payload,
        createdAt: step.createdAt,
        updatedAt: step.updatedAt,
      })),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  async remove(userId: number, analysisId: string) {
    const result = await this.prisma.selectionAnalysisRecord.updateMany({
      where: { id: analysisId, userId, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    })
    if (result.count === 0) throw analysisNotFound()
    this.logger.log(`Selection analysis deleted: id=${analysisId}, user=${userId}`)
  }

  private handleExistingCreate(
    record: Prisma.SelectionAnalysisRecordGetPayload<{ include: { steps: true } }>,
    fingerprint: string
  ) {
    if (record.createFingerprint !== fingerprint) throw reusedClientRequestId()
    const step = record.steps.find(item => item.stepNo === 1)
    if (!step) throw new ConflictException("分析记录缺少第1步数据，请联系管理员")
    return createResponse(record, step, true)
  }

  private async resolveCreateUniqueConflict(
    userId: number,
    clientRequestId: string,
    fingerprint: string
  ) {
    const rows = await this.prisma.$queryRaw<ExistingCreateRow[]>`
      SELECT id, createFingerprint, deletedAt
      FROM SelectionAnalysisRecord
      WHERE userId = ${userId} AND clientRequestId = ${clientRequestId}
      LIMIT 1
    `
    const row = rows[0]
    if (!row) throw new ConflictException("创建分析记录时发生唯一约束冲突")
    if (row.deletedAt) {
      throw new ConflictException({
        code: "ANALYSIS_ALREADY_DELETED",
        message: "该创建请求对应的分析已删除，请开启新的分析",
      })
    }
    if (row.createFingerprint !== fingerprint) throw reusedClientRequestId()

    const record = await this.prisma.selectionAnalysisRecord.findFirst({
      where: { id: row.id, userId },
      include: { steps: { where: { stepNo: 1 }, take: 1 } },
    })
    if (!record) throw analysisNotFound()
    return this.handleExistingCreate(record, fingerprint)
  }
}

function createResponse(
  record: {
    id: string
    lastCompletedStep: number
    pickCount: number
    status: SelectionAnalysisStatus
    version: number
    createdAt: Date
    updatedAt: Date
  },
  step: Pick<SelectionAnalysisStep, "stepNo" | "revision">,
  idempotentReplay: boolean
) {
  return {
    analysisId: record.id,
    stepNo: step.stepNo,
    revision: step.revision,
    lastCompletedStep: record.lastCompletedStep,
    pickCount: record.pickCount,
    status: record.status,
    version: record.version,
    idempotentReplay,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function stepResponse(
  record: Omit<LockedAnalysis, "entry">,
  step: Pick<SelectionAnalysisStep, "stepNo" | "revision">,
  changed: boolean,
  invalidatedSteps: number[]
) {
  return {
    analysisId: record.id,
    stepNo: step.stepNo,
    revision: step.revision,
    lastCompletedStep: record.lastCompletedStep,
    pickCount: record.pickCount,
    status: record.status,
    version: record.version,
    changed,
    invalidatedSteps,
    updatedAt: record.updatedAt,
  }
}

function normalizeCode(value: string, field: string) {
  const normalized = value.trim().toUpperCase()
  if (!normalized) throw new BadRequestException(`${field} 不能为空`)
  return normalized
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function withoutId<T extends { id: unknown }>(value: T): Omit<T, "id"> {
  const { id, ...rest } = value
  void id
  return rest
}

function analysisNotFound() {
  return new NotFoundException({ code: "ANALYSIS_NOT_FOUND", message: "选品分析记录不存在" })
}

function reusedClientRequestId() {
  return new ConflictException({
    code: "CLIENT_REQUEST_ID_REUSED",
    message: "clientRequestId 已被用于其他分析内容，请生成新的请求 ID",
  })
}
