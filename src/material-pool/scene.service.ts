import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { CopySceneDto, CreateSceneDto, QuerySceneDto, UpdateSceneDto } from "./dto/scene.dto"

type JsonIn = Prisma.InputJsonValue

@Injectable()
export class SceneService {
  constructor(private readonly prisma: PrismaService) {}

  /** 列表：分页 + 关键字（名称 / 标签） */
  async findAll(query: QuerySceneDto, userId: number) {
    const { page = 1, pageSize = 10, keyword } = query
    const where: Prisma.SceneWhereInput = {
      userId,
      ...(keyword
        ? { OR: [{ name: { contains: keyword } }, { tags: { array_contains: keyword } }] }
        : {}),
    }
    const [total, items] = await Promise.all([
      this.prisma.scene.count({ where }),
      this.prisma.scene.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])
    return { total, page, pageSize, items }
  }

  /** 当前用户场景的去重标签 + 计数（筛选 chips） */
  async findTags(userId: number) {
    const rows = await this.prisma.scene.findMany({
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

  /** 详情：含 desc（供视频侧拼进可见 prompt） */
  async findOne(id: number, userId: number) {
    return this.assertOwned(id, userId)
  }

  async create(dto: CreateSceneDto, userId: number) {
    return this.prisma.scene.create({ data: { userId, name: dto.name, ...this.toData(dto) } })
  }

  async update(id: number, dto: UpdateSceneDto, userId: number) {
    await this.assertOwned(id, userId)
    return this.prisma.scene.update({
      where: { id },
      data: { ...(dto.name !== undefined ? { name: dto.name } : {}), ...this.toData(dto) },
    })
  }

  /** 复制为新副本 */
  async copy(id: number, dto: CopySceneDto, userId: number) {
    const src = await this.assertOwned(id, userId)
    return this.prisma.scene.create({
      data: {
        userId,
        name: dto.name ?? `${src.name}-副本`,
        images: (src.images ?? Prisma.JsonNull) as JsonIn,
        videos: (src.videos ?? Prisma.JsonNull) as JsonIn,
        desc: src.desc,
        categories: (src.categories ?? Prisma.JsonNull) as JsonIn,
        tags: (src.tags ?? Prisma.JsonNull) as JsonIn,
      },
    })
  }

  /** 导入分享码：按 id 批量克隆 */
  async import(ids: number[], userId: number) {
    const uniqueIds = [...new Set(ids)]
    const sources = await this.prisma.scene.findMany({ where: { id: { in: uniqueIds } } })
    const foundIds = new Set(sources.map(s => s.id))
    const skippedIds = uniqueIds.filter(id => !foundIds.has(id))

    const created = await this.prisma.$transaction(
      sources.map(src =>
        this.prisma.scene.create({
          data: {
            userId,
            name: src.name,
            images: (src.images ?? Prisma.JsonNull) as JsonIn,
            videos: (src.videos ?? Prisma.JsonNull) as JsonIn,
            desc: src.desc,
            categories: (src.categories ?? Prisma.JsonNull) as JsonIn,
            tags: (src.tags ?? Prisma.JsonNull) as JsonIn,
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
    await this.prisma.scene.update({ where: { id }, data: { deletedAt: new Date() } })
    return { success: true }
  }

  // ==================== 私有 ====================

  private async assertOwned(id: number, userId: number) {
    const row = await this.prisma.scene.findUnique({ where: { id } })
    if (!row) throw new NotFoundException("场景不存在")
    if (row.userId !== userId) throw new ForbiddenException("无权操作该场景")
    return row
  }

  /** DTO → 入库字段（不含 name）：仅写入已传字段；数组传入时整组替换 */
  private toData(dto: CreateSceneDto | UpdateSceneDto) {
    return {
      ...(dto.images !== undefined ? { images: dto.images as unknown as JsonIn } : {}),
      ...(dto.videos !== undefined ? { videos: dto.videos as unknown as JsonIn } : {}),
      ...(dto.desc !== undefined ? { desc: dto.desc } : {}),
      ...(dto.categories !== undefined ? { categories: dto.categories as JsonIn } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags as JsonIn } : {}),
    }
  }
}
