import { Injectable } from "@nestjs/common"
import { Prisma, GenerationRecord as StoredGenerationRecord } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { AuditPrismaService } from "./audit-prisma.service"
import {
  GENERATION_FUNCTION_LABELS,
  GenerationFunction,
  GenerationRecordModelOptionDto,
  QueryGenerationRecordModelOptionsDto,
  QueryGenerationRecordsDto,
} from "./dto/query-generation-records.dto"
import { recentGenerationQuery } from "./generation-record-time-window"
import type { GenerationRecord } from "./generation-record.service"

const USER_SELECT = {
  id: true,
  username: true,
  phone: true,
  orgs: { select: { org: { select: { name: true } } } },
  roles: { select: { role: { select: { name: true, color: true } } } },
} satisfies Prisma.UserSelect

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>
type RecordFilter = QueryGenerationRecordModelOptionsDto & { model?: string }

function numericId(value: string): number | string {
  const parsed = Number(value)
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(parsed) ? parsed : value
}

@Injectable()
export class UnifiedGenerationRecordReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditPrismaService
  ) {}

  async list(query: QueryGenerationRecordsDto) {
    const where = await this.where(query, new Date())
    const { page, pageSize } = query
    const [rows, total, aggregate] = await this.prisma.$transaction(
      async tx =>
        Promise.all([
          tx.generationRecord.findMany({
            where,
            orderBy: [
              { occurredAt: "desc" },
              { sourceType: "asc" },
              { sourceId: "asc" },
              { operation: "asc" },
              { id: "asc" },
            ],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.generationRecord.count({ where }),
          tx.generationRecord.aggregate({ where, _sum: { credits: true } }),
        ]),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    )
    const [users, splitIds] = await Promise.all([
      rows.length
        ? this.prisma.user.findMany({
            where: { id: { in: [...new Set(rows.map(row => row.userId))] } },
            select: USER_SELECT,
          })
        : [],
      this.splitDisplayIds(rows),
    ])
    const userMap = new Map(users.map(user => [user.id, user]))
    return {
      items: rows.map(row => ({
        ...this.toRecord(row, userMap.get(row.userId), splitIds),
        functionLabel: GENERATION_FUNCTION_LABELS[row.function as GenerationFunction],
        createdAt: row.occurredAt.toISOString(),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      summary: { totalCredits: aggregate._sum.credits?.toString() ?? "0" },
    }
  }

  async getModelOptions(query: QueryGenerationRecordModelOptionsDto) {
    // 即使调用方绕过 DTO，也不允许已选模型收窄模型选项。
    const where = await this.where({ ...query, model: undefined }, new Date())
    const groups = await this.prisma.generationRecord.groupBy({
      by: ["function", "modelPublicId", "modelDisplayName"],
      where: {
        AND: [where, { function: { not: "INSPIRATION_RADAR" }, modelPublicId: { not: null } }],
      },
      _max: { occurredAt: true },
    })
    const unique = new Map<string, { option: GenerationRecordModelOptionDto; occurredAt: number }>()
    for (const group of groups) {
      if (!group.modelPublicId) continue
      const key = `${group.function}:${group.modelPublicId}`
      const occurredAt = group._max.occurredAt?.getTime() ?? 0
      const option: GenerationRecordModelOptionDto = {
        value: group.modelPublicId,
        label: group.modelDisplayName || group.modelPublicId,
        function: group.function as GenerationRecordModelOptionDto["function"],
      }
      const previous = unique.get(key)
      if (
        !previous ||
        occurredAt > previous.occurredAt ||
        (occurredAt === previous.occurredAt && option.label < previous.option.label)
      )
        unique.set(key, { option, occurredAt })
    }
    return [...unique.values()]
      .map(({ option }) => option)
      .sort(
        (a, b) =>
          a.function.localeCompare(b.function) ||
          a.label.localeCompare(b.label, "zh-CN") ||
          a.value.localeCompare(b.value)
      )
  }

  private async where(query: RecordFilter, now: Date): Promise<Prisma.GenerationRecordWhereInput> {
    const bounded = recentGenerationQuery(query, now)
    const scope: Prisma.UserWhereInput = {
      ...(query.orgId ? { orgs: { some: { orgId: query.orgId } } } : {}),
      ...(query.roleId ? { roles: { some: { roleId: query.roleId } } } : {}),
    }
    const [scopedUsers, matchingUsers] = await Promise.all([
      query.orgId || query.roleId
        ? this.prisma.user.findMany({ where: scope, select: { id: true } })
        : null,
      query.keyword
        ? this.prisma.user.findMany({
            where: {
              ...scope,
              OR: [
                { username: { contains: query.keyword } },
                { phone: { contains: query.keyword } },
              ],
            },
            select: { id: true },
          })
        : [],
    ])
    return {
      occurredAt: { gte: new Date(bounded.dateFrom), lte: new Date(bounded.dateTo) },
      ...(query.function ? { function: query.function } : {}),
      ...(query.model ? { modelPublicId: query.model } : {}),
      ...(scopedUsers ? { userId: { in: scopedUsers.map(user => user.id) } } : {}),
      ...(query.keyword
        ? {
            OR: [
              { prompt: { contains: query.keyword } },
              { userId: { in: matchingUsers.map(user => user.id) } },
            ],
          }
        : {}),
    }
  }

  private async splitDisplayIds(rows: StoredGenerationRecord[]) {
    const ids = rows.filter(row => row.sourceType === "AI_SPLIT").map(row => row.sourceId)
    const groups = ids.filter(id => !id.startsWith("task:"))
    const tasks = ids.filter(id => id.startsWith("task:")).map(id => Number(id.slice(5)))
    const result = new Map<string, number>()
    if (!ids.length) return result
    // 仅对当前页补旧接口代表任务 ID，不参与分页、费用或总数计算。
    const sources = await this.audit.generationTask.findMany({
      where: {
        source: "platform",
        project: { source: "platform" },
        generationMode: "AI_SPLIT",
        OR: [{ groupId: { in: groups } }, { id: { in: tasks } }],
      },
      select: { id: true, groupId: true, createdAt: true },
      orderBy: { id: "asc" },
    })
    for (const source of sources) {
      const key = source.groupId ?? `task:${source.id}`
      if (!result.has(key)) result.set(key, source.id)
    }
    return result
  }

  private toRecord(
    row: StoredGenerationRecord,
    user: UserRow | undefined,
    splitIds: Map<string, number>
  ): GenerationRecord {
    const fn = row.function as GenerationFunction
    const text = row.sourceType === "TEXT" || row.sourceType === "TEXT_RUN"
    const businessId = text ? row.sourceId.slice(row.sourceId.indexOf(":") + 1) : row.sourceId
    const parentId = businessId.split(/:(?:task|revision|step|event):/)[0]
    const asin = fn === "ASIN_AUDIT" || fn === "ASIN_EVIDENCE"
    const stage = fn === "ASIN_AUDIT" ? row.operation : ""
    const model = row.modelPublicId ?? ""
    return {
      key: `${row.sourceType}:${row.sourceId}${stage ? `:${stage}` : ""}`,
      function: fn,
      id:
        row.sourceType === "AI_SPLIT"
          ? (splitIds.get(row.sourceId) ?? numericId(row.sourceId.replace(/^task:/, "")))
          : stage
            ? `${businessId}:${stage}`
            : numericId(fn === "INSPIRATION_RADAR" ? businessId.split(":refresh:")[0] : parentId),
      userId: row.userId,
      username: user?.username ?? "",
      phone: user?.phone ?? "",
      orgs: user?.orgs.map(item => item.org.name) ?? [],
      roles: user?.roles.map(item => ({ name: item.role.name, color: item.role.color })) ?? [],
      prompt: row.prompt,
      model,
      modelLabel: row.modelDisplayName || row.modelPublicId || "—",
      credits: row.credits?.toString() ?? null,
      status: this.status(row),
      resultUrl: row.deletedAt ? null : row.resultUrl,
      ...(row.resultCount == null ? {} : { resultCount: row.resultCount }),
      resultLabel:
        text || row.resultCount == null
          ? GENERATION_FUNCTION_LABELS[fn]
          : fn === "INSPIRATION_RADAR"
            ? `抓取 ${row.resultCount} 张`
            : `成功 ${row.resultCount} ${fn === "VIDEO" ? "条" : "张"}`,
      ...(text ? { contentType: "TEXT" as const, models: model ? [model] : [] } : {}),
      ...(["SMART_PRICING", "PROMOTION_PLAN"].includes(fn)
        ? { actualModel: row.modelPublicId, actualModels: model ? [model] : [] }
        : {}),
      ...(row.operation ? { operation: row.operation } : {}),
      ...(asin ? { recordId: parentId } : {}),
      expired: false,
      deleted: row.deletedAt != null,
      createdAt: row.occurredAt,
    }
  }

  private status(row: StoredGenerationRecord) {
    if (row.function === "ASIN_AUDIT") return row.operation === "score" ? "SCORED" : "OPTIMIZED"
    if (row.function === "CHETAIDOU_TEXT") return "SUCCEEDED"
    if (
      row.sourceType === "TEXT_RUN" ||
      ["CATEGORY_ANALYSIS", "PRODUCT_SELECTION", "LISTING_GENERATION", "LISTING_SCORING"].includes(
        row.function
      )
    )
      return "COMPLETED"
    return "SUCCESS"
  }
}
