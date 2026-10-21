import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import { HistoryType, Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import {
  assertNumericIds,
  assertStringIds,
  BatchDeleteRecordsDto,
  NUMERIC_ID_TYPES,
  ToolboxRecordType,
} from "./dto/batch-delete-records.dto"

export interface BatchDeleteResult {
  /** 实际删除条数 */
  deleted: number
  /** 请求删除条数（去重后） */
  requested: number
  /** 不存在或不属于当前用户的 id 原样返回 */
  missing: (number | string)[]
}

/**
 * 工具箱历史记录批量删除：9 类记录一个入口，删除语义与各模块既有单删对齐
 * （软删的保持软删、硬删的保持硬删，asin_audit 保留 version++ 乐观锁递增）。
 * 全部按 userId 归属过滤；不存在/非本人记录计入 missing，不泄露他人记录。
 */
@Injectable()
export class ToolboxRecordService {
  private readonly logger = new Logger(ToolboxRecordService.name)

  constructor(private readonly prisma: PrismaService) {}

  async batchDelete(userId: number, dto: BatchDeleteRecordsDto): Promise<BatchDeleteResult> {
    // HTTP 层由 DTO @ArrayMaxSize 拦截；service 内再防御一次
    if (dto.ids.length > 100) {
      throw new BadRequestException("ids 一次最多 100 个")
    }
    // 去重 + 按 type 校验 id 形状（数字类型 vs UUID/taskId 字符串）
    const uniqueIds = [...new Set(dto.ids)]
    if (NUMERIC_ID_TYPES.includes(dto.type)) {
      assertNumericIds(dto.type, uniqueIds)
    } else {
      assertStringIds(dto.type, uniqueIds)
    }

    const deletedIds = await this.deleteByIds(userId, dto.type, uniqueIds)
    const missing = uniqueIds.filter(id => !deletedIds.includes(id))
    if (deletedIds.length > 0) {
      this.logger.log(
        `Toolbox batch delete: type=${dto.type}, user=${userId}, deleted=${deletedIds.length}/${uniqueIds.length}`
      )
    }
    return { deleted: deletedIds.length, requested: uniqueIds.length, missing }
  }

  private async deleteByIds(
    userId: number,
    type: ToolboxRecordType,
    ids: (number | string)[]
  ): Promise<(number | string)[]> {
    switch (type) {
      // ── 软删（deletedAt），与各模块单删一致 ──
      case "asin_evidence":
        return this.softDelete(userId, ids as string[], {
          findOwned: ownedIds =>
            this.prisma.asinEvidenceRecord.findMany({
              where: { id: { in: ownedIds }, userId, deletedAt: null },
              select: { id: true },
            }),
          markDeleted: ownedIds =>
            this.prisma.asinEvidenceRecord.updateMany({
              where: { id: { in: ownedIds }, userId, deletedAt: null },
              data: { deletedAt: new Date() },
            }),
        })
      case "asin_audit":
        return this.softDelete(userId, ids as string[], {
          findOwned: ownedIds =>
            this.prisma.asinAuditRecord.findMany({
              where: { id: { in: ownedIds }, userId, deletedAt: null },
              select: { id: true },
            }),
          markDeleted: ownedIds =>
            this.prisma.asinAuditRecord.updateMany({
              where: { id: { in: ownedIds }, userId, deletedAt: null },
              data: { deletedAt: new Date(), version: { increment: 1 } },
            }),
        })
      case "competitor_analysis":
        return this.softDelete(userId, ids as string[], {
          findOwned: ownedIds =>
            this.prisma.competitorAnalysisRecord.findMany({
              where: { id: { in: ownedIds }, userId, deletedAt: null },
              select: { id: true },
            }),
          markDeleted: ownedIds =>
            this.prisma.competitorAnalysisRecord.updateMany({
              where: { id: { in: ownedIds }, userId, deletedAt: null },
              data: { deletedAt: new Date() },
            }),
        })
      case "product_selection":
        return this.softDelete(userId, ids as string[], {
          findOwned: ownedIds =>
            this.prisma.selectionAnalysisRecord.findMany({
              where: { id: { in: ownedIds }, userId, deletedAt: null },
              select: { id: true },
            }),
          markDeleted: ownedIds =>
            this.prisma.selectionAnalysisRecord.updateMany({
              where: { id: { in: ownedIds }, userId, deletedAt: null },
              data: { deletedAt: new Date() },
            }),
        })
      case "smart_pricing":
        return this.softDelete(userId, ids as string[], {
          findOwned: ownedIds =>
            this.prisma.smartPricingRecord.findMany({
              where: { id: { in: ownedIds }, userId, deletedAt: null },
              select: { id: true },
            }),
          markDeleted: ownedIds =>
            this.prisma.smartPricingRecord.updateMany({
              where: { id: { in: ownedIds }, userId, deletedAt: null },
              data: { deletedAt: new Date() },
            }),
        })

      // ── 硬删（表无 deletedAt 或与模块单删口径一致）──
      case "promotion_plan":
        return this.hardDelete(ids as string[], {
          findOwned: ownedIds =>
            this.prisma.promotionPlanRecord
              .findMany({ where: { id: { in: ownedIds }, userId }, select: { id: true } })
              .then(rows => rows.map(r => r.id)),
          remove: ownedIds =>
            this.prisma.promotionPlanRecord.deleteMany({
              where: { id: { in: ownedIds }, userId },
            }),
        })
      case "listing_generation":
        return this.deleteHistory(userId, ids as number[], HistoryType.LISTING_GENERATION)
      case "listing_scoring":
        return this.deleteHistory(userId, ids as number[], HistoryType.LISTING_SCORING)
      case "ad_cleaning":
        // AdCleaningTask 前端标识为 taskId（UUID 字符串）；表无软删列，硬删
        return this.hardDelete(ids as string[], {
          findOwned: ownedIds =>
            this.prisma.adCleaningTask
              .findMany({
                where: { taskId: { in: ownedIds }, userId },
                select: { taskId: true },
              })
              .then(rows => rows.map(r => r.taskId)),
          remove: ownedIds =>
            this.prisma.adCleaningTask.deleteMany({
              where: { taskId: { in: ownedIds }, userId },
            }),
        })
    }
  }

  /** 软删骨架：先查归属集合精确算 missing，再对归属集合置 deletedAt（count 异常下降时以 count 为准） */
  private async softDelete(
    userId: number,
    ids: string[],
    ops: {
      findOwned: (ownedIds: string[]) => Promise<{ id: string }[]>
      markDeleted: (ownedIds: string[]) => Promise<Prisma.BatchPayload>
    }
  ): Promise<string[]> {
    const owned = await ops.findOwned(ids)
    const ownedIds = owned.map(o => o.id)
    if (ownedIds.length === 0) return []
    const result = await ops.markDeleted(ownedIds)
    // 并发删除导致 count 下降时无法定位具体 id，按 count 截断（deleted 与 missing 合计仍守恒）
    return result.count === ownedIds.length ? ownedIds : ownedIds.slice(0, result.count)
  }

  /** 硬删骨架：同软删的两段式，置删换 deleteMany（userId 已在 ops 闭包内） */
  private async hardDelete(
    ids: string[],
    ops: {
      findOwned: (ownedIds: string[]) => Promise<string[]>
      remove: (ownedIds: string[]) => Promise<Prisma.BatchPayload>
    }
  ): Promise<string[]> {
    const ownedIds = await ops.findOwned(ids)
    if (ownedIds.length === 0) return []
    const result = await ops.remove(ownedIds)
    return result.count === ownedIds.length ? ownedIds : ownedIds.slice(0, result.count)
  }

  /** History（Listing 生成/打分）：数字 id，按 type 限定删除（HistoryRevision 由外键级联清理） */
  private async deleteHistory(userId: number, ids: number[], type: HistoryType): Promise<number[]> {
    const owned = await this.prisma.history.findMany({
      where: { id: { in: ids }, userId, type },
      select: { id: true },
    })
    const ownedIds = owned.map(o => o.id)
    if (ownedIds.length === 0) return []
    const result = await this.prisma.history.deleteMany({
      where: { id: { in: ownedIds }, userId, type },
    })
    return result.count === ownedIds.length ? ownedIds : ownedIds.slice(0, result.count)
  }
}
