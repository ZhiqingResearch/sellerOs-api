import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import {
  CopyDigitalHumanDto,
  CreateDigitalHumanDto,
  QueryDigitalHumanDto,
  UpdateDigitalHumanDto,
} from "./dto/digital-human.dto"

type JsonIn = Prisma.InputJsonValue

// 列表不带 persona（隐藏人设），详情才带；roleCard 需返回（库页按其有无分流编辑器 + 渲染 chips）
const LIST_SELECT = {
  id: true,
  name: true,
  portraits: true,
  videos: true,
  voiceDesc: true,
  voiceAudio: true,
  purposes: true,
  tags: true,
  roleCard: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DigitalHumanSelect

@Injectable()
export class DigitalHumanService {
  constructor(private readonly prisma: PrismaService) {}

  /** 列表：分页 + 关键字（名称 / 标签）。不返回 persona */
  async findAll(query: QueryDigitalHumanDto, userId: number) {
    const { page = 1, pageSize = 10, keyword } = query
    const where: Prisma.DigitalHumanWhereInput = {
      userId,
      ...(keyword
        ? { OR: [{ name: { contains: keyword } }, { tags: { array_contains: keyword } }] }
        : {}),
    }
    const [total, items] = await Promise.all([
      this.prisma.digitalHuman.count({ where }),
      this.prisma.digitalHuman.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: LIST_SELECT,
      }),
    ])
    return { total, page, pageSize, items }
  }

  /** 当前用户数字人的去重标签 + 计数（筛选 chips） */
  async findTags(userId: number) {
    const rows = await this.prisma.digitalHuman.findMany({
      where: { userId },
      select: { tags: true },
    })
    const counter = new Map<string, number>()
    for (const r of rows) {
      if (!Array.isArray(r.tags)) continue
      for (const t of r.tags) {
        if (typeof t !== "string") continue
        counter.set(t, (counter.get(t) ?? 0) + 1)
      }
    }
    return Array.from(counter.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  /** 详情：含 persona（供视频侧注入隐藏人设） */
  async findOne(id: number, userId: number) {
    return this.assertOwned(id, userId)
  }

  async create(dto: CreateDigitalHumanDto, userId: number) {
    return this.prisma.digitalHuman.create({
      data: { userId, name: dto.name, ...this.toData(dto) },
    })
  }

  /** 批量新建：AI 角色卡入库走这个，一次事务落 N 个（要么全成要么全败，不串数据） */
  async batchCreate(cards: CreateDigitalHumanDto[], userId: number) {
    const created = await this.prisma.$transaction(
      cards.map(dto =>
        this.prisma.digitalHuman.create({
          data: { userId, name: dto.name, ...this.toData(dto) },
          select: { id: true, name: true },
        })
      )
    )
    return { createdCount: created.length, items: created }
  }

  async update(id: number, dto: UpdateDigitalHumanDto, userId: number) {
    await this.assertOwned(id, userId)
    return this.prisma.digitalHuman.update({
      where: { id },
      data: { ...(dto.name !== undefined ? { name: dto.name } : {}), ...this.toData(dto) },
    })
  }

  /** 复制为新副本 */
  async copy(id: number, dto: CopyDigitalHumanDto, userId: number) {
    const src = await this.assertOwned(id, userId)
    return this.prisma.digitalHuman.create({
      data: {
        userId,
        name: dto.name ?? `${src.name}-副本`,
        portraits: (src.portraits ?? Prisma.JsonNull) as JsonIn,
        videos: (src.videos ?? Prisma.JsonNull) as JsonIn,
        voiceDesc: src.voiceDesc,
        voiceAudio: src.voiceAudio,
        persona: src.persona,
        purposes: (src.purposes ?? Prisma.JsonNull) as JsonIn,
        tags: (src.tags ?? Prisma.JsonNull) as JsonIn,
        roleCard: (src.roleCard ?? Prisma.JsonNull) as JsonIn,
      },
    })
  }

  /** 导入分享码：按 id 批量克隆 */
  async import(ids: number[], userId: number) {
    const uniqueIds = [...new Set(ids)]
    const sources = await this.prisma.digitalHuman.findMany({ where: { id: { in: uniqueIds } } })
    const foundIds = new Set(sources.map(s => s.id))
    const skippedIds = uniqueIds.filter(id => !foundIds.has(id))

    const created = await this.prisma.$transaction(
      sources.map(src =>
        this.prisma.digitalHuman.create({
          data: {
            userId,
            name: src.name,
            portraits: (src.portraits ?? Prisma.JsonNull) as JsonIn,
            videos: (src.videos ?? Prisma.JsonNull) as JsonIn,
            voiceDesc: src.voiceDesc,
            voiceAudio: src.voiceAudio,
            persona: src.persona,
            purposes: (src.purposes ?? Prisma.JsonNull) as JsonIn,
            tags: (src.tags ?? Prisma.JsonNull) as JsonIn,
            roleCard: (src.roleCard ?? Prisma.JsonNull) as JsonIn,
          },
          select: { id: true, name: true },
        })
      )
    )
    return {
      requested: uniqueIds.length,
      importedCount: created.length,
      skippedCount: skippedIds.length,
      skippedIds,
      imported: created.map((c, i) => ({ sourceId: sources[i].id, newId: c.id, name: c.name })),
    }
  }

  async remove(id: number, userId: number) {
    await this.assertOwned(id, userId)
    await this.prisma.digitalHuman.update({ where: { id }, data: { deletedAt: new Date() } })
    return { success: true }
  }

  // ==================== 私有 ====================

  private async assertOwned(id: number, userId: number) {
    const row = await this.prisma.digitalHuman.findUnique({ where: { id } })
    if (!row) throw new NotFoundException("数字人不存在")
    if (row.userId !== userId) throw new ForbiddenException("无权操作该数字人")
    return row
  }

  /** DTO → 入库字段（不含 name）：仅写入已传字段；数组传入时整组替换 */
  private toData(dto: CreateDigitalHumanDto | UpdateDigitalHumanDto) {
    return {
      ...(dto.portraits !== undefined ? { portraits: dto.portraits as unknown as JsonIn } : {}),
      ...(dto.videos !== undefined ? { videos: dto.videos as unknown as JsonIn } : {}),
      ...(dto.voiceDesc !== undefined ? { voiceDesc: dto.voiceDesc } : {}),
      ...(dto.voiceAudio !== undefined ? { voiceAudio: dto.voiceAudio } : {}),
      ...(dto.persona !== undefined ? { persona: dto.persona } : {}),
      ...(dto.purposes !== undefined ? { purposes: dto.purposes as JsonIn } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags as JsonIn } : {}),
      ...(dto.roleCard !== undefined ? { roleCard: dto.roleCard as unknown as JsonIn } : {}),
    }
  }
}
