import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common"
import {
  readListingStepResult,
  readListingTaskResult,
} from "../generation-record/listing-generation-snapshot"
import {
  AuditStage,
  asinAuditUsageContext,
  asinUsageFunction,
  asinUsageSummary,
} from "./asin-audit-generation-records"
import { AuditPrismaService } from "./audit-prisma.service"
import { businessGenerationModels } from "./business-generation-models"
import { GenerationRecordDetailDto } from "./dto/generation-record-detail.dto"
import {
  GENERATION_FUNCTION_LABELS,
  TextGenerationFunction,
} from "./dto/query-generation-records.dto"
import { SOURCE_FUNCTIONS } from "./text-generation-record.service"

type DetailRow = {
  userId: number
  status: string
  createdAt: Date
  deletedAt?: Date | null
  content: unknown
  actualModel?: string | null
  actualModels?: string[]
}

function numericId(value: string, max = 2_147_483_647) {
  const id = Number(value)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id) || id > max) {
    throw new BadRequestException("记录标识格式不正确")
  }
  return id
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

@Injectable()
export class GenerationRecordDetailService {
  constructor(private readonly audit: AuditPrismaService) {}

  async detail(key: string): Promise<GenerationRecordDetailDto> {
    const listing =
      /^TEXT:(LISTING_GENERATION|LISTING_SCORING):([1-9]\d*):(task|revision|step):([1-9]\d*)$/.exec(
        key
      )
    if (listing) {
      const fn = listing[1] as "LISTING_GENERATION" | "LISTING_SCORING"
      const historyId = numericId(listing[2])
      const sourceId = numericId(listing[4])
      if (listing[3] === "revision") {
        const row = await this.audit.historyRevision.findFirst({
          where: { id: sourceId, historyId, history: { type: fn } },
          select: { data: true, createdAt: true, history: { select: { userId: true } } },
        })
        return this.response(
          key,
          fn,
          row && {
            userId: row.history.userId,
            createdAt: row.createdAt,
            status: "COMPLETED",
            content: { report: row.data, steps: [] },
          }
        )
      }
      if (fn !== "LISTING_GENERATION") throw new NotFoundException("生成记录不存在")
      const row =
        listing[3] === "task"
          ? await readListingTaskResult(this.audit, historyId, sourceId)
          : await readListingStepResult(this.audit, historyId, sourceId)
      return this.response(key, fn, row && { ...row, status: "COMPLETED" })
    }
    const revision =
      /^TEXT:ASIN_AUDIT:([^:]+):revision:([^:]+)(?::event:([1-9]\d*))?:optimize$/.exec(key)
    if (revision)
      return this.auditRevisionDetail(
        key,
        revision[1],
        numericId(revision[2]),
        revision[3] ? numericId(revision[3]) : undefined
      )
    const stage = /^TEXT:ASIN_AUDIT:([^:]+):(score|optimize)$/.exec(key)
    if (stage) return this.auditStageDetail(key, stage[1], stage[2] as AuditStage)
    const run = /^TEXT_RUN:(listing-score|competitor-analysis):([^:]+)$/.exec(key)
    if (run) {
      const fn = run[1] === "listing-score" ? "LISTING_SCORING" : "COMPETITOR_ANALYSIS"
      const row = await this.audit.businessAiRun.findFirst({
        where: { id: numericId(run[2], 4_294_967_295), module: run[1] },
        select: { userId: true, status: true, createdAt: true, outputText: true, billing: true },
      })
      // 独立评分优先返回修复、校验后的交付正文，不把原始账单或修复调用证据下发。
      const delivered = run[1] === "listing-score" ? asObject(row?.billing).resultText : null
      return this.response(
        key,
        fn,
        row && {
          ...row,
          content: typeof delivered === "string" && delivered.trim() ? delivered : row.outputText,
        }
      )
    }
    const match = /^TEXT:([A-Z_]+):(.+)$/.exec(key)
    if (
      !match ||
      !(match[1] in GENERATION_FUNCTION_LABELS) ||
      ["IMAGE", "VIDEO", "INSPIRATION_RADAR"].includes(match[1])
    ) {
      throw new BadRequestException("仅支持使用文本生成记录的完整 key 查询正文")
    }
    const fn = match[1] as TextGenerationFunction
    const id = match[2]
    if (id.startsWith("usage:")) {
      const log = await this.audit.usageLog.findUnique({
        where: { id: numericId(id.slice("usage:".length)) },
        select: {
          id: true,
          userId: true,
          source: true,
          meta: true,
          requestId: true,
          createdAt: true,
        },
      })
      if (!log || (asinUsageFunction(log) ?? SOURCE_FUNCTIONS[log.source ?? ""]) !== fn)
        throw new NotFoundException("生成记录不存在")
      if (fn === "ASIN_AUDIT" || fn === "ASIN_EVIDENCE") {
        const context = await asinAuditUsageContext(this.audit, log.userId, fn)
        const linked = context.matches.get(log.id)
        if (linked)
          return linked.operation === "evidence"
            ? this.evidenceDetail(key, linked.recordId, context)
            : this.auditStageDetail(key, linked.recordId, linked.operation, context)
      }
      return this.response(key, fn, { ...log, status: "BILLED", content: null })
    }
    if (id.includes(":")) throw new BadRequestException("记录标识格式不正确")
    if (fn === "ASIN_EVIDENCE") return this.evidenceDetail(key, id)
    return this.response(key, fn, await this.record(fn, id))
  }

  private async evidenceDetail(
    key: string,
    recordId: string,
    existingContext?: Awaited<ReturnType<typeof asinAuditUsageContext>>
  ) {
    const row = await this.audit.asinEvidenceRecord.findUnique({
      where: { id: recordId },
      select: { userId: true, createdAt: true, deletedAt: true, evidence: true, model: true },
    })
    if (!row) throw new NotFoundException("生成记录不存在")
    const context =
      existingContext ?? (await asinAuditUsageContext(this.audit, row.userId, "ASIN_EVIDENCE"))
    const summary = asinUsageSummary(context, recordId, "evidence")
    return {
      ...this.response(key, "ASIN_EVIDENCE", { ...row, status: "SUCCESS", content: row.evidence }),
      ...summary,
      models: [...new Set([...(row.model ? [row.model] : []), ...summary.models])],
      operation: "evidence" as const,
      recordId,
    }
  }

  private async auditRevisionDetail(
    key: string,
    recordId: string,
    revisionId: number,
    eventId?: number
  ): Promise<GenerationRecordDetailDto> {
    const revision = await this.audit.asinAuditOptimizationRevision.findFirst({
      where: { id: revisionId, recordId },
      select: {
        revision: true,
        schemaVersion: true,
        optimizationResult: true,
        createdAt: true,
        record: { select: { userId: true, deletedAt: true } },
      },
    })
    if (!revision) throw new NotFoundException("该审计阶段记录不存在")
    const snapshot = await this.audit.generationRecord.findUnique({
      where: {
        sourceType_sourceId_operation: {
          sourceType: "TEXT",
          sourceId: `ASIN_AUDIT:${recordId}:revision:${revisionId}${eventId ? `:event:${eventId}` : ""}`,
          operation: "optimize",
        },
      },
    })
    if (eventId && !snapshot) throw new NotFoundException("生成记录不存在")
    return {
      ...this.response(key, "ASIN_AUDIT", {
        userId: revision.record.userId,
        deletedAt: revision.record.deletedAt,
        status: "OPTIMIZED",
        createdAt: snapshot?.occurredAt ?? revision.createdAt,
        content: {
          revision: revision.revision,
          schemaVersion: revision.schemaVersion,
          optimizationResult: revision.optimizationResult,
        },
      }),
      recordId,
      operation: "optimize",
      credits: snapshot?.credits?.toString() ?? null,
      models: snapshot?.modelPublicId ? [snapshot.modelPublicId] : [],
    }
  }

  private async auditStageDetail(
    key: string,
    recordId: string,
    operation: AuditStage,
    existingContext?: Awaited<ReturnType<typeof asinAuditUsageContext>>
  ): Promise<GenerationRecordDetailDto> {
    const row = await this.audit.asinAuditRecord.findUnique({
      where: { id: recordId },
      select: {
        userId: true,
        createdAt: true,
        deletedAt: true,
        scoreSnapshot: {
          select: { evidence: true, scoreResult: true, schemaVersion: true, createdAt: true },
        },
        optimizationRevisions: {
          orderBy: { revision: "desc" },
          take: 1,
          select: {
            revision: true,
            schemaVersion: true,
            optimizationResult: true,
            createdAt: true,
          },
        },
      },
    })
    if (!row) throw new NotFoundException("生成记录不存在")
    const snapshot = operation === "score" ? row.scoreSnapshot : row.optimizationRevisions[0]
    if (!snapshot) throw new NotFoundException("该审计阶段记录不存在")
    const context = existingContext ?? (await asinAuditUsageContext(this.audit, row.userId))
    const { createdAt, ...content } = snapshot
    return {
      ...this.response(key, "ASIN_AUDIT", {
        ...row,
        createdAt,
        status: operation === "score" ? "SCORED" : "OPTIMIZED",
        content,
      }),
      recordId,
      operation,
      ...asinUsageSummary(context, recordId, operation),
    }
  }

  private response(
    key: string,
    fn: TextGenerationFunction,
    row: DetailRow | null
  ): GenerationRecordDetailDto {
    if (!row) throw new NotFoundException("生成记录不存在")
    const deleted = row.deletedAt != null
    let content: unknown = deleted ? null : (row.content ?? null)
    let format: "JSON" | "TEXT" | null = content === null ? null : "JSON"
    if (typeof content === "string") {
      if (!content.trim()) content = null
      else {
        format = "TEXT"
        try {
          content = JSON.parse(content) as unknown
          format = "JSON"
        } catch {
          /* 非 JSON 正文按纯文本返回。 */
        }
      }
    }
    const available = content !== null
    return {
      key,
      function: fn,
      functionLabel: GENERATION_FUNCTION_LABELS[fn],
      contentType: "TEXT",
      ...(row.actualModels
        ? { actualModel: row.actualModel ?? null, actualModels: row.actualModels }
        : {}),
      userId: row.userId,
      status: row.status,
      deleted,
      createdAt: row.createdAt.toISOString(),
      available,
      format: available ? format : null,
      content,
      message: available
        ? null
        : deleted
          ? "记录已删除，正文不可用"
          : row.status === "BILLED"
            ? "仅有扣费流水，暂无关联报告正文"
            : "该记录暂无已保存的正文",
    }
  }

  private async record(
    fn: Exclude<TextGenerationFunction, "ASIN_EVIDENCE">,
    id: string
  ): Promise<DetailRow | null> {
    switch (fn) {
      case "ASIN_AUDIT": {
        const row = await this.audit.asinAuditRecord.findUnique({
          where: { id },
          select: {
            userId: true,
            status: true,
            createdAt: true,
            deletedAt: true,
            scoreSnapshot: { select: { evidence: true, scoreResult: true, schemaVersion: true } },
            optimizationRevisions: {
              orderBy: { revision: "asc" },
              select: {
                revision: true,
                schemaVersion: true,
                optimizationResult: true,
                createdAt: true,
              },
            },
          },
        })
        return (
          row && {
            ...row,
            content:
              row.scoreSnapshot || row.optimizationRevisions.length
                ? {
                    evidence: row.scoreSnapshot?.evidence ?? null,
                    scoreResult: row.scoreSnapshot?.scoreResult ?? null,
                    schemaVersion: row.scoreSnapshot?.schemaVersion ?? null,
                    optimizations: row.optimizationRevisions,
                  }
                : null,
          }
        )
      }
      case "COMPETITOR_ANALYSIS": {
        const row = await this.audit.competitorAnalysisRecord.findUnique({
          where: { id },
          select: {
            userId: true,
            createdAt: true,
            deletedAt: true,
            inputSnapshot: true,
            analysisResult: true,
            reportData: true,
            reportPdfUrl: true,
            products: {
              orderBy: { sortOrder: "asc" },
              select: {
                asin: true,
                sortOrder: true,
                productData: true,
                steps: {
                  orderBy: { stepNo: "asc" },
                  select: { stepCode: true, stepNo: true, schemaVersion: true, resultData: true },
                },
              },
            },
          },
        })
        return (
          row && {
            ...row,
            status: "SUCCESS",
            content: {
              input: row.inputSnapshot,
              analysisResult: row.analysisResult,
              products: row.products,
              reportData: row.reportData,
              reportPdfUrl: row.reportPdfUrl,
            },
          }
        )
      }
      case "LISTING_GENERATION":
      case "LISTING_SCORING": {
        const row = await this.audit.history.findFirst({
          where: { id: numericId(id), type: fn },
          select: {
            userId: true,
            createdAt: true,
            data: true,
            listingRun: {
              select: {
                status: true,
                steps: {
                  where: {
                    operation: {
                      in: ["generation", "optimization", "score", "qa_rewrite", "long_title"],
                    },
                    outputText: { not: null },
                  },
                  orderBy: { id: "asc" },
                  select: { operation: true, model: true, status: true, outputText: true },
                },
              },
            },
          },
        })
        if (!row) return null
        const data = asObject(row.data)
        const hasReport =
          !row.listingRun ||
          data.result ||
          (Array.isArray(data.plans) &&
            data.plans.some(plan => asObject(plan).result || asObject(plan).partialText))
        const steps = (row.listingRun?.steps ?? []).filter(step => step.outputText?.trim())
        return {
          ...row,
          status: row.listingRun?.status ?? "SUCCESS",
          content: hasReport || steps.length ? { report: row.data, steps } : null,
        }
      }
      case "CATEGORY_ANALYSIS": {
        const row = await this.audit.categoryAnalysisRecord.findUnique({
          where: { id: numericId(id, 4_294_967_295) },
          select: { userId: true, status: true, createdAt: true, deletedAt: true, result: true },
        })
        return row && { ...row, content: row.result }
      }
      case "PRODUCT_SELECTION": {
        const row = await this.audit.selectionAnalysisRecord.findFirst({
          where: { id, entry: "PRODUCT" },
          select: {
            userId: true,
            status: true,
            createdAt: true,
            deletedAt: true,
            marketplace: true,
            entry: true,
            steps: {
              orderBy: { stepNo: "asc" },
              select: {
                stepNo: true,
                stepType: true,
                schemaVersion: true,
                revision: true,
                payload: true,
              },
            },
          },
        })
        return (
          row && {
            ...row,
            content: row.steps.length
              ? { marketplace: row.marketplace, entry: row.entry, steps: row.steps }
              : null,
          }
        )
      }
      case "SMART_PRICING": {
        const row = await this.audit.smartPricingRecord.findUnique({
          where: { id },
          select: {
            clientRequestId: true,
            userId: true,
            createdAt: true,
            deletedAt: true,
            marketplaceCode: true,
            marketplaceName: true,
            currency: true,
            category: true,
            product: true,
            inputSnapshot: true,
            competitorContext: true,
            result: true,
          },
        })
        const models = row
          ? (await businessGenerationModels(this.audit, [{ id, ...row }], "smart-pricing")).get(id)
          : null
        return (
          row && {
            ...row,
            ...(models ?? { actualModel: null, actualModels: [] }),
            status: "SUCCESS",
            content: {
              marketplaceCode: row.marketplaceCode,
              marketplaceName: row.marketplaceName,
              currency: row.currency,
              category: row.category,
              product: row.product,
              input: row.inputSnapshot,
              competitorContext: row.competitorContext,
              result: row.result,
            },
          }
        )
      }
      case "PROMOTION_PLAN": {
        const row = await this.audit.promotionPlanRecord.findUnique({
          where: { id },
          select: { clientRequestId: true, userId: true, createdAt: true, result: true },
        })
        const models = row
          ? (await businessGenerationModels(this.audit, [{ id, ...row }], "promotion-plan")).get(id)
          : null
        return (
          row && {
            ...row,
            ...(models ?? { actualModel: null, actualModels: [] }),
            status: "SUCCESS",
            content: row.result,
          }
        )
      }
      case "VIDEO_ANALYSIS": {
        const row = await this.audit.videoAnalysisRecord.findUnique({
          where: { id },
          select: { userId: true, createdAt: true, deletedAt: true, result: true },
        })
        return row && { ...row, status: "SUCCESS", content: row.result }
      }
      case "CHETAIDOU_TEXT": {
        const row = await this.audit.chetaidouTask.findFirst({
          where: {
            id,
            type: { in: ["BREAKDOWN", "IDEATION", "REFRESH_GROUP", "DIVERGE", "COMPOSE"] },
          },
          select: {
            ownerId: true,
            type: true,
            status: true,
            createdAt: true,
            rootTaskId: true,
            imageId: true,
            output: true,
          },
        })
        if (!row) return null
        const groups = await this.audit.chetaidouGroup.findMany({
          where: { taskId: row.rootTaskId },
          orderBy: { order: "asc" },
          select: {
            id: true,
            key: true,
            definition: true,
            options: true,
            status: true,
            order: true,
          },
        })
        const breakdownId = asObject(row.output).breakdownId
        const breakdown =
          row.type === "BREAKDOWN" &&
          typeof breakdownId === "number" &&
          Number.isSafeInteger(breakdownId) &&
          breakdownId > 0 &&
          breakdownId <= 2_147_483_647
            ? await this.audit.chetaidouBreakdown.findFirst({
                where: { id: breakdownId, imageId: row.imageId },
                select: { schemaVersion: true, payload: true },
              })
            : null
        return {
          ...row,
          userId: row.ownerId,
          status: row.status ?? "GENERATING",
          content: (
            row.type === "BREAKDOWN"
              ? breakdown != null
              : row.output != null || groups.some(group => group.options != null)
          )
            ? { type: row.type, output: row.output, groups, breakdown }
            : null,
        }
      }
    }
  }
}
