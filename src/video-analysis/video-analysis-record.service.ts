import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { Prisma, type VideoAnalysisRecord } from "@prisma/client"
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library"
import { PaginationDto } from "../common/dto/pagination.dto"
import { hashJson } from "../common/utils/canonical-json"
import { PrismaService } from "../prisma/prisma.service"
import { VideoAnalysisDto } from "./dto/video-analysis.dto"
import { resolveVideoMimeType } from "./video-analysis.models"
import type { VideoAnalysisResult } from "./video-analysis.normalize"
import type { VideoAnalysisSseEvent } from "./video-analysis.service"

type TokenUsage = Extract<VideoAnalysisSseEvent, { type: "usage" }>["usage"]
type UsageDetail = Omit<Extract<VideoAnalysisSseEvent, { type: "usage_detail" }>, "type">
type ChargeEvent = Extract<VideoAnalysisSseEvent, { type: "charge" }>

export interface VideoAnalysisSnapshot {
  result: VideoAnalysisResult
  usage: TokenUsage
  usageDetail: UsageDetail
  charge: ChargeEvent
}

@Injectable()
export class VideoAnalysisRecordService {
  private readonly logger = new Logger(VideoAnalysisRecordService.name)

  constructor(private readonly prisma: PrismaService) {}

  async findReplay(userId: number, dto: VideoAnalysisDto, model: string) {
    // 显式读删除标记，防止重试重新生成或恢复已删除报告。
    const record = await this.findIncludingDeleted(userId, dto.chargeRequestId)
    if (!record) return null
    this.assertReplay(record, requestFingerprint(dto, model))
    return detailResponse(record)
  }

  async save(
    userId: number,
    dto: VideoAnalysisDto,
    model: string,
    snapshot: VideoAnalysisSnapshot
  ) {
    const input = normalizedInput(dto, model)
    const fingerprint = hashJson(input)
    // 唯一键 + 数据库 upsert：并发同请求仅保存首次结果，重试不覆盖报告。
    const record = await this.prisma.videoAnalysisRecord
      .upsert({
        where: { userId_chargeRequestId: { userId, chargeRequestId: dto.chargeRequestId } },
        create: {
          userId,
          chargeRequestId: dto.chargeRequestId,
          fingerprint,
          title: snapshot.result.title.trim().slice(0, 500) || "未命名视频分析",
          ...input,
          result: toJson(snapshot.result),
          usage: toJson(snapshot.usage),
          usageDetail: toJson(snapshot.usageDetail),
          charge: toJson(snapshot.charge),
        },
        update: {},
      })
      .catch(async (error: unknown) => {
        // MySQL 的并发 upsert 可能撞唯一键；只重读本人的相同请求，不吞其它错误。
        if (!(error instanceof PrismaClientKnownRequestError) || error.code !== "P2002") throw error
        const existing = await this.findIncludingDeleted(userId, dto.chargeRequestId)
        if (!existing) throw error
        return existing
      })
    this.assertReplay(record, fingerprint)
    this.logger.log(`视频分析结果已保存：recordId=${record.id}, userId=${userId}`)
    return detailResponse(record)
  }

  async findAll(userId: number, pagination: PaginationDto) {
    const { page, pageSize } = pagination
    const where = { userId, deletedAt: null }
    const [records, total] = await Promise.all([
      this.prisma.videoAnalysisRecord.findMany({
        where,
        select: {
          id: true,
          title: true,
          videoUrl: true,
          duration: true,
          model: true,
          charge: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.videoAnalysisRecord.count({ where }),
    ])
    return {
      items: records.map(({ id, charge, ...record }) => ({
        recordId: id,
        ...record,
        charge: charge as unknown as ChargeEvent,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  async findOne(userId: number, recordId: string) {
    const record = await this.prisma.videoAnalysisRecord.findFirst({
      where: { id: recordId, userId, deletedAt: null },
    })
    if (!record) throw new NotFoundException("视频分析记录不存在")
    return detailResponse(record)
  }

  async remove(userId: number, recordId: string) {
    const result = await this.prisma.videoAnalysisRecord.updateMany({
      where: { id: recordId, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    })
    if (result.count === 0) throw new NotFoundException("视频分析记录不存在")
    this.logger.log(`视频分析记录已删除：recordId=${recordId}, userId=${userId}`)
  }

  private async findIncludingDeleted(userId: number, chargeRequestId: string) {
    // 参数化查询绕过全局软删除读过滤，仅供内部幂等检查识别已删除请求。
    const records = await this.prisma.$queryRaw<VideoAnalysisRecord[]>`
      SELECT * FROM VideoAnalysisRecord
      WHERE userId = ${userId} AND chargeRequestId = ${chargeRequestId}
      LIMIT 1
    `
    return records[0] ?? null
  }

  private assertReplay(record: VideoAnalysisRecord, fingerprint: string) {
    if (record.deletedAt) {
      throw new ConflictException("视频分析记录已删除，请使用新的 chargeRequestId 发起分析")
    }
    if (record.fingerprint !== fingerprint) {
      throw new ConflictException("chargeRequestId 已用于其他视频分析请求，请使用新的请求编号")
    }
  }
}

function normalizedInput(dto: VideoAnalysisDto, model: string) {
  return {
    videoUrl: dto.videoUrl,
    duration: Number(dto.duration),
    focus: dto.focus?.trim().slice(0, 500) || null,
    mimeType: resolveVideoMimeType(dto.videoUrl, dto.mimeType),
    model,
  }
}

function requestFingerprint(dto: VideoAnalysisDto, model: string) {
  return hashJson(normalizedInput(dto, model))
}

function toJson(value: object): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function detailResponse(record: VideoAnalysisRecord) {
  return {
    recordId: record.id,
    chargeRequestId: record.chargeRequestId,
    title: record.title,
    videoUrl: record.videoUrl,
    duration: record.duration,
    focus: record.focus,
    mimeType: record.mimeType,
    model: record.model,
    result: record.result as unknown as VideoAnalysisResult,
    usage: record.usage as unknown as TokenUsage,
    usageDetail: record.usageDetail as unknown as UsageDetail,
    charge: record.charge as unknown as ChargeEvent,
    createdAt: record.createdAt,
  }
}
