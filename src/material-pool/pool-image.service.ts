import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import {
  BatchMoveToGroupDto,
  PersistVariantsDto,
  QueryPoolImageDto,
  StorePoolImageDto,
} from "./dto/pool-image.dto"
import { PoolGroupService } from "./pool-group.service"
import { POOL_IMAGE_KIND, PoolImageKind } from "./pool-image.constants"

type JsonIn = Prisma.InputJsonValue

// 列表/详情带出所属分组（把 groupId 摊平成 groupName 返回）
const GROUP_INCLUDE = {
  group: { select: { id: true, name: true } },
} satisfies Prisma.PoolImageInclude

const VARIANT_TAG = "变体"

@Injectable()
export class PoolImageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: PoolGroupService
  ) {}

  /** 列表：分页 + 关键字（名/prompt/标签）+ 分组 / 标签 / 分类 / 类型筛选 */
  async findAll(query: QueryPoolImageDto, userId: number) {
    const { page = 1, pageSize = 10, keyword, groupId, ungrouped, tag, category, kind } = query

    const where: Prisma.PoolImageWhereInput = {
      userId,
      ...(kind ? { kind } : {}),
      ...(ungrouped ? { groupId: null } : groupId ? { groupId } : {}),
      ...(tag ? { tags: { array_contains: tag } } : {}),
      ...(category ? { categories: { array_contains: category } } : {}),
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword } },
              { prompt: { contains: keyword } },
              { tags: { array_contains: keyword } },
            ],
          }
        : {}),
    }

    const [total, rows] = await Promise.all([
      this.prisma.poolImage.count({ where }),
      this.prisma.poolImage.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: GROUP_INCLUDE,
      }),
    ])

    return { total, page, pageSize, items: rows.map(r => this.present(r)) }
  }

  /** 分类聚合（JSON 数组应用层去重计数），筛选 chips 使用 */
  async findCategories(userId: number) {
    const rows = await this.prisma.poolImage.findMany({
      where: { userId },
      select: { categories: true },
    })
    const counter = new Map<string, number>()
    for (const r of rows) {
      if (!Array.isArray(r.categories)) continue
      for (const c of r.categories) {
        if (typeof c !== "string") continue
        counter.set(c, (counter.get(c) ?? 0) + 1)
      }
    }
    return Array.from(counter.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
  }

  /** 手动存入素材池：按 url 去重（name/prompt 仅作展示与搜索），可选归组 / 归属项目 */
  async store(dto: StorePoolImageDto, userId: number) {
    if (dto.groupId != null) await this.groups.assertOwned(dto.groupId, userId)
    if (dto.projectId != null) await this.assertProjectOwned(dto.projectId, userId)

    // name 由前端按文件名/源图名派生，同名不同图是正常场景；仅同一 URL 重复入池视为重复
    if (dto.url != null) {
      const dup = await this.prisma.poolImage.findFirst({
        where: { userId, url: dto.url },
        select: { id: true },
      })
      if (dup) throw new ConflictException("已在素材池中")
    }

    const row = await this.prisma.poolImage.create({
      data: {
        userId,
        projectId: dto.projectId ?? null,
        url: dto.url,
        hue: dto.hue ?? 0,
        name: dto.name,
        prompt: dto.prompt,
        sourceLabel: dto.sourceLabel,
        tags: (dto.tags ?? Prisma.JsonNull) as JsonIn,
        categories: (dto.categories ?? Prisma.JsonNull) as JsonIn,
        groupId: dto.groupId ?? null,
        kind: dto.kind ?? POOL_IMAGE_KIND.IMAGE,
      },
      include: GROUP_INCLUDE,
    })
    return this.present(row)
  }

  /**
   * 变体持久化：前端拿到 N 张变体后落库，自动入池（不归组、打「变体」标签、不去重）。
   * 传 sourceImageId 则校验归属并建立血缘；order 紧接源图之后。
   */
  async persistVariants(dto: PersistVariantsDto, userId: number) {
    let baseOrder = 0
    let sourceKind: PoolImageKind = POOL_IMAGE_KIND.IMAGE
    let sourceProjectId: number | null = null
    if (dto.sourceImageId != null) {
      const src = await this.prisma.poolImage.findUnique({
        where: { id: dto.sourceImageId },
        select: { userId: true, order: true, kind: true, projectId: true },
      })
      if (!src) throw new NotFoundException("源图不存在")
      if (src.userId !== userId) throw new ForbiddenException("无权操作该素材")
      baseOrder = src.order
      // 变体跟随源图类型与项目归属：竞品参考图的衍生图仍是该项目的竞品参考
      sourceKind = src.kind as PoolImageKind
      sourceProjectId = src.projectId
    }

    const created = await this.prisma.$transaction(
      dto.items.map((it, i) =>
        this.prisma.poolImage.create({
          data: {
            userId,
            url: it.url,
            hue: it.hue ?? 0,
            name: it.name,
            prompt: it.prompt,
            sourceLabel: dto.sourceLabel,
            tags: this.mergeVariantTags(dto.directions) as JsonIn,
            groupId: null,
            sourceImageId: dto.sourceImageId ?? null,
            order: baseOrder + i + 1,
            kind: sourceKind,
            projectId: sourceProjectId,
          },
          include: GROUP_INCLUDE,
        })
      )
    )
    return { count: created.length, items: created.map(r => this.present(r)) }
  }

  /**
   * 导入分享码：前端解析出 id 数组后按 id 批量克隆为当前用户素材图。
   * 已删除（软删自动过滤）/ 不存在的 id 跳过；克隆不带分组、不带血缘；
   * projectId 不复制（导入方与源项目无归属关系，统一落公共库）。
   */
  async import(ids: number[], userId: number) {
    const uniqueIds = [...new Set(ids)]
    const sources = await this.prisma.poolImage.findMany({
      where: { id: { in: uniqueIds } },
    })
    const foundIds = new Set(sources.map(s => s.id))
    const skippedIds = uniqueIds.filter(id => !foundIds.has(id))

    const created = await this.prisma.$transaction(
      sources.map(src =>
        this.prisma.poolImage.create({
          data: {
            userId,
            sourceMeta: (src.sourceMeta ?? Prisma.JsonNull) as JsonIn,
            url: src.url,
            hue: src.hue,
            name: src.name,
            prompt: src.prompt,
            sourceLabel: src.sourceLabel,
            tags: (src.tags ?? Prisma.JsonNull) as JsonIn,
            categories: (src.categories ?? Prisma.JsonNull) as JsonIn,
            groupId: null,
            kind: src.kind,
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

  /** 批量移到分组（不传 groupId = 移出分组）；仅作用于本人素材 */
  async batchMoveToGroup(dto: BatchMoveToGroupDto, userId: number) {
    if (dto.groupId != null) await this.groups.assertOwned(dto.groupId, userId)
    const res = await this.prisma.poolImage.updateMany({
      where: { id: { in: dto.ids }, userId },
      data: { groupId: dto.groupId ?? null },
    })
    return { success: true, movedCount: res.count }
  }

  /** 批量下载：返回本人素材的 URL 列表，前端自行下载（无服务端打包） */
  async batchDownload(ids: number[], userId: number) {
    const rows = await this.prisma.poolImage.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, name: true, url: true },
    })
    return { count: rows.length, items: rows }
  }

  /** 批量软删除（仅本人素材） */
  async batchRemove(ids: number[], userId: number) {
    const res = await this.prisma.poolImage.updateMany({
      where: { id: { in: ids }, userId },
      data: { deletedAt: new Date() },
    })
    return { success: true, deletedCount: res.count }
  }

  /** 单条软删除 */
  async remove(id: number, userId: number) {
    await this.assertOwned(id, userId)
    await this.prisma.poolImage.update({ where: { id }, data: { deletedAt: new Date() } })
    return { success: true }
  }

  // ==================== 私有 ====================

  /** 校验项目归属：必须是本人电商创作项目（与拆图模块同口径） */
  private async assertProjectOwned(projectId: number, userId: number) {
    const project = await this.prisma.imageProject.findFirst({
      where: { id: projectId, userId, type: "ECOMMERCE", source: "platform" },
      select: { id: true },
    })
    if (!project) throw new NotFoundException("电商创作项目不存在")
  }

  private async assertOwned(id: number, userId: number) {
    const row = await this.prisma.poolImage.findUnique({
      where: { id },
      select: { userId: true },
    })
    if (!row) throw new NotFoundException("素材不存在")
    if (row.userId !== userId) throw new ForbiddenException("无权操作该素材")
  }

  /** 变体标签：固定「变体」+ 发散方向（去重） */
  private mergeVariantTags(directions?: string[]) {
    return [...new Set([VARIANT_TAG, ...(directions ?? [])])]
  }

  /** 把所属分组摊平成 groupName 返回 */
  private present(row: { group?: { id: number; name: string } | null; [k: string]: unknown }) {
    const { group, ...rest } = row
    return { ...rest, groupName: group?.name ?? null }
  }
}
