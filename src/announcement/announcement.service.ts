import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { PaginationDto } from "../common/dto/pagination.dto"
import { exportDateTimeFormatter } from "../common/utils/datetime"
import { PrismaService } from "../prisma/prisma.service"
import { CreateAnnouncementDto } from "./dto/create-announcement.dto"

// 重叠提示时间按东八区展示（页面口径），格式 YYYY-MM-DD HH:mm，不露 UTC ISO 原始时间
const fmtBeijingMinute = (() => {
  const fmt = exportDateTimeFormatter() // 默认 Asia/Shanghai，hourCycle h23
  return (d: Date) => fmt(d).slice(0, 16)
})()

@Injectable()
export class AnnouncementService {
  private readonly logger = new Logger(AnnouncementService.name)

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: number, dto: CreateAnnouncementDto, now: Date = new Date()) {
    const start = new Date(dto.startAt)
    const end = new Date(dto.endAt)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException("时间格式无效")
    }
    if (start >= end) {
      throw new BadRequestException("开始时间必须早于结束时间")
    }
    // 不允许发布已过期公告（结束时间早于或等于当前时间）
    if (end <= now) {
      throw new BadRequestException("公告结束时间必须晚于当前时间")
    }

    // 重叠校验（仅针对有效公告）：
    // - 真重叠 ⟺ 已有.startAt < 新.endAt 且 已有.endAt > 新.startAt（严格不等，边界相接不算重叠）
    // - 排除已过期公告：仅校验结束时间晚于当前时间的公告，与历史已过期记录重叠不拦截
    // - 已软删公告由 SOFT_DELETE_MODELS 自动过滤，无需显式 deletedAt: null
    const conflict = await this.prisma.announcement.findFirst({
      where: {
        AND: [{ startAt: { lt: end }, endAt: { gt: start } }, { endAt: { gt: now } }],
      },
      select: { id: true, startAt: true, endAt: true },
    })
    if (conflict) {
      throw new BadRequestException(
        `公告时间段与已有公告重叠：已有公告时间 ${fmtBeijingMinute(conflict.startAt)} ～ ${fmtBeijingMinute(conflict.endAt)}`
      )
    }

    const record = await this.prisma.announcement.create({
      data: { content: dto.content, startAt: start, endAt: end, createdById: userId },
      include: { createdBy: { select: { id: true, username: true } } },
    })
    this.logger.log(`Announcement created: id=${record.id}, user=${userId}`)
    return record
  }

  /** 历史公告列表：全部状态（未生效/生效中/已过期），按创建时间倒序分页 */
  async findAll(pagination: PaginationDto) {
    const { page, pageSize } = pagination
    const skip = (page - 1) * pageSize

    const [items, total] = await Promise.all([
      this.prisma.announcement.findMany({
        include: { createdBy: { select: { id: true, username: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.announcement.count(),
    ])

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  /** 生效中公告：当前时间在 [startAt, endAt] 闭区间内，不分页 */
  async findActive(now: Date = new Date()) {
    return this.prisma.announcement.findMany({
      where: { startAt: { lte: now }, endAt: { gte: now } },
      include: { createdBy: { select: { id: true, username: true } } },
      orderBy: { createdAt: "desc" },
    })
  }

  async remove(id: number) {
    const existing = await this.prisma.announcement.findUnique({ where: { id } })
    if (!existing) {
      throw new NotFoundException("公告不存在")
    }

    const record = await this.prisma.announcement.update({
      where: { id },
      data: { deletedAt: new Date() },
      select: { id: true, deletedAt: true },
    })
    this.logger.log(`Announcement soft-deleted: id=${id}`)
    return record
  }
}
