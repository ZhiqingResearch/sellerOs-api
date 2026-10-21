import { ConflictException, GoneException, Injectable, NotFoundException } from "@nestjs/common"
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library"
import { createHash } from "node:crypto"
import { PrismaService } from "../prisma/prisma.service"
import { RegisterDownloadDto } from "./dto/register-download.dto"
import {
  RegisterDownloadResponseDto,
  SkillMarketListResponseDto,
  SkillMarketSkillItemDto,
} from "./dto/skill-market-response.dto"

const USER_AGENT_MAX_LENGTH = 255
// dev/prod 库是远程 MySQL（单次往返数百毫秒），事务内最多 6 条语句，
// 默认 5s 超时不够（对齐 product-publish-rpa 的事务超时惯例）
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 30_000 } as const
// 关系表 create/update 降级重试上限（并发回滚窗口兜底，正常 1-2 次即收敛）
const RELATION_UPSERT_MAX_ATTEMPTS = 3

@Injectable()
export class SkillMarketService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /skills：所有可用技能的动态统计 + 当前用户下载状态 */
  async listSkills(userId: number): Promise<SkillMarketListResponseDto> {
    const [skills, userSkills] = await Promise.all([
      this.prisma.skillMarketSkill.findMany({
        where: { status: "ACTIVE" },
        orderBy: { id: "asc" },
      }),
      this.prisma.skillMarketUserSkill.findMany({ where: { userId } }),
    ])
    const relationBySkillId = new Map(userSkills.map(r => [r.skillId, r]))

    const items: SkillMarketSkillItemDto[] = skills.map(skill => {
      const rel = relationBySkillId.get(skill.skillId)
      return {
        skillId: skill.skillId,
        status: skill.status,
        downloadCount: Number(skill.downloadCount),
        downloadEventCount: Number(skill.downloadEventCount),
        downloaded: rel !== undefined && rel.removedAt === null,
        firstDownloadedAt: rel?.firstDownloadedAt ?? null,
        lastDownloadedAt: rel?.lastDownloadedAt ?? null,
        downloadTimes: rel?.downloadTimes ?? 0,
      }
    })

    return {
      items,
      summary: {
        availableSkillCount: skills.length,
        myDownloadedSkillCount: items.filter(i => i.downloaded).length,
      },
      serverTime: new Date().toISOString(),
    }
  }

  /**
   * POST /skills/:skillId/downloads：登记一次下载。
   *
   * 幂等与并发约定（联调文档 6.2 / 9.1 / 9.2）：
   * - clientRequestId 唯一索引是最后防线，不依赖「先查再写」；事件插在事务最前面，
   *   同键并发被抢先时事务内零写入即返回，绝不重复计数；
   * - 关系表 (userId, skillId) 唯一索引保证并发首次下载只有一个 create 成功，
   *   另一个降级为重复下载路径（MySQL 语句级回滚，事务可继续）；
   * - 计数全部走数据库原子 increment，禁止读-算-写；
   * - 移出后重新下载只清 removedAt，不再次增加去重下载量。
   */
  async registerDownload(
    userId: number,
    skillId: string,
    dto: RegisterDownloadDto,
    meta: { ip?: string; userAgent?: string }
  ): Promise<RegisterDownloadResponseDto> {
    // 快速路径：事务外先查幂等键（读最新已提交数据，无事务快照问题）
    const existingEvent = await this.prisma.skillMarketDownloadEvent.findUnique({
      where: { clientRequestId: dto.clientRequestId },
    })
    if (existingEvent) {
      this.assertEventOwnership(existingEvent, userId, skillId)
      return this.buildDownloadResponse(userId, skillId, existingEvent.createdAt, true)
    }

    const inserted = await this.prisma.$transaction(async tx => {
      const skill = await tx.skillMarketSkill.findUnique({ where: { skillId } })
      if (!skill) throw new NotFoundException({ code: "SKILL_NOT_FOUND", message: "技能不存在" })
      if (skill.status === "DISABLED") {
        throw new GoneException({ code: "SKILL_DISABLED", message: "技能已下架" })
      }

      const now = new Date()
      try {
        await tx.skillMarketDownloadEvent.create({
          data: {
            clientRequestId: dto.clientRequestId,
            userId,
            skillId,
            ipHash: hashIp(meta.ip),
            userAgent: truncate(meta.userAgent),
          },
        })
      } catch (error) {
        if (!isUniqueConstraintViolation(error)) throw error
        // 同键并发被抢先：此刻事务内零写入，直接提交空事务，由外部重查判定重放/冲突
        return false
      }

      let firstDownload: boolean | undefined
      for (let attempt = 0; attempt < RELATION_UPSERT_MAX_ATTEMPTS; attempt++) {
        try {
          await tx.skillMarketUserSkill.create({
            data: {
              userId,
              skillId,
              firstDownloadedAt: now,
              lastDownloadedAt: now,
            },
          })
          firstDownload = true
          break
        } catch (error) {
          if (!isUniqueConstraintViolation(error)) throw error
          // 唯一索引兜底并发：两个首次请求并发到达时只有一个 create 成功，
          // 另一个在此降级为重复下载路径（MySQL 语句级回滚，事务可继续）。
          // 用 updateMany 探测而非 update：并发回滚窗口下行可能瞬时不可见（不抛 P2025），
          // 此时重试一次 create 即可收敛
          const updated = await tx.skillMarketUserSkill.updateMany({
            where: { userId, skillId },
            data: {
              lastDownloadedAt: now,
              downloadTimes: { increment: 1 },
              removedAt: null,
            },
          })
          if (updated.count > 0) {
            firstDownload = false
            break
          }
        }
      }
      if (firstDownload === undefined) {
        throw new ConflictException({
          code: "SKILL_MARKET_INTERNAL_ERROR",
          message: "下载登记冲突未收敛，请重试",
        })
      }

      // 单条原子 UPDATE 同时完成两个计数（去重数只在历史首次时 +1）
      await tx.skillMarketSkill.update({
        where: { id: skill.id },
        data: {
          downloadEventCount: { increment: 1 },
          ...(firstDownload ? { downloadCount: { increment: 1 } } : {}),
        },
      })
      return true
    }, TRANSACTION_OPTIONS)

    if (!inserted) {
      const event = await this.prisma.skillMarketDownloadEvent.findUnique({
        where: { clientRequestId: dto.clientRequestId },
      })
      // 事件行永不删除，唯一冲突即存在；防御性兜底
      if (!event) {
        throw new ConflictException({
          code: "CLIENT_REQUEST_ID_CONFLICT",
          message: "幂等键处理异常，请生成新的 clientRequestId 重试",
        })
      }
      this.assertEventOwnership(event, userId, skillId)
      return this.buildDownloadResponse(userId, skillId, event.createdAt, true)
    }

    return this.buildDownloadResponse(userId, skillId, new Date(), false)
  }

  /** DELETE /skills/:skillId/my-library：移出个人列表（不动计数、不删行，幂等） */
  async removeFromLibrary(
    userId: number,
    skillId: string
  ): Promise<{
    skillId: string
    downloaded: boolean
    downloadCount: number
    removedAt: string | null
  }> {
    const skill = await this.prisma.skillMarketSkill.findUnique({ where: { skillId } })
    if (!skill) throw new NotFoundException({ code: "SKILL_NOT_FOUND", message: "技能不存在" })

    const relation = await this.prisma.skillMarketUserSkill.findUnique({
      where: { userId_skillId: { userId, skillId } },
    })
    // 从未下载过或已移出：幂等返回成功
    if (!relation || relation.removedAt) {
      return {
        skillId,
        downloaded: false,
        downloadCount: Number(skill.downloadCount),
        removedAt: relation?.removedAt?.toISOString() ?? null,
      }
    }

    const updated = await this.prisma.skillMarketUserSkill.update({
      where: { userId_skillId: { userId, skillId } },
      data: { removedAt: new Date() },
    })
    return {
      skillId,
      downloaded: false,
      downloadCount: Number(skill.downloadCount),
      removedAt: updated.removedAt!.toISOString(),
    }
  }

  /** 事务提交后读最新状态组装响应（downloadedAt 取对应事件时间） */
  private async buildDownloadResponse(
    userId: number,
    skillId: string,
    downloadedAt: Date,
    idempotentReplay: boolean
  ): Promise<RegisterDownloadResponseDto> {
    const [skill, relation] = await Promise.all([
      this.prisma.skillMarketSkill.findUnique({ where: { skillId } }),
      this.prisma.skillMarketUserSkill.findUnique({
        where: { userId_skillId: { userId, skillId } },
      }),
    ])
    if (!skill || !relation) {
      throw new NotFoundException({ code: "SKILL_NOT_FOUND", message: "技能不存在" })
    }

    return {
      skillId,
      downloadCount: Number(skill.downloadCount),
      downloadEventCount: Number(skill.downloadEventCount),
      downloaded: relation.removedAt === null,
      // downloadTimes === 1 即历史首次；幂等重放首访请求时同样成立，与原结果一致
      firstDownload: relation.downloadTimes === 1,
      downloadTimes: relation.downloadTimes,
      downloadedAt: downloadedAt.toISOString(),
      idempotentReplay,
      // 正文公开直链（对象元数据已带 attachment 文件名，浏览器直接落盘）；未上传时为 null 由前端兜底
      downloadUrl: skill.fileUrl ?? null,
      expiresAt: null,
    }
  }

  private assertEventOwnership(
    event: { userId: number; skillId: string },
    userId: number,
    skillId: string
  ): void {
    if (event.userId !== userId || event.skillId !== skillId) {
      throw new ConflictException({
        code: "CLIENT_REQUEST_ID_CONFLICT",
        message: "该 clientRequestId 已被用于其他用户或技能",
      })
    }
  }
}

function isUniqueConstraintViolation(error: unknown): error is PrismaClientKnownRequestError {
  return error instanceof PrismaClientKnownRequestError && error.code === "P2002"
}

function hashIp(ip: string | undefined): string | null {
  if (!ip) return null
  return createHash("sha256").update(ip).digest("hex")
}

function truncate(value: string | undefined): string | null {
  if (!value) return null
  return value.length > USER_AGENT_MAX_LENGTH ? value.slice(0, USER_AGENT_MAX_LENGTH) : value
}
