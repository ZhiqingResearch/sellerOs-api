import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import {
  CopyImageTemplateDto,
  CreateImageTemplateDto,
  QueryImageTemplateDto,
  QuerySystemTemplateDto,
  TemplateItemDto,
  UpdateImageTemplateDto,
} from "./image-template.dto"

type Json = Prisma.InputJsonValue

// 列表/详情统一带出图片条目 + 所属分组（用于把 groupId 摊平成 groupName 返回）
const ITEMS_ORDER: Prisma.ImageTemplateItemOrderByWithRelationInput[] = [
  { sortOrder: "asc" },
  { id: "asc" },
]
const DETAIL_INCLUDE = {
  items: { orderBy: ITEMS_ORDER },
  group: { select: { id: true, name: true } },
} satisfies Prisma.ImageTemplateInclude
const LIST_INCLUDE = {
  ...DETAIL_INCLUDE,
  _count: { select: { items: true } },
} satisfies Prisma.ImageTemplateInclude

@Injectable()
export class ImageTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  // ==================== 用户侧（个人模板 + 系统模板只读） ====================

  /** 列表：可见集合 = 自己的个人模板 ∪ 全部系统模板 */
  async findAll(query: QueryImageTemplateDto, userId: number) {
    const { page = 1, pageSize = 10, tab = "all", groupId, tag, keyword } = query

    const where: Prisma.ImageTemplateWhereInput = {
      AND: [
        this.visibilityClause(tab, userId),
        groupId ? { groupId } : {},
        tag ? { tags: { array_contains: tag } } : {},
        keyword
          ? {
              OR: [
                { name: { contains: keyword } },
                { note: { contains: keyword } },
                { items: { some: { prompt: { contains: keyword } } } },
              ],
            }
          : {},
      ],
    }

    const [total, rows] = await Promise.all([
      this.prisma.imageTemplate.count({ where }),
      this.prisma.imageTemplate.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: LIST_INCLUDE,
      }),
    ])

    return { total, page, pageSize, items: rows.map(r => this.present(r)) }
  }

  /** Tab 计数（全部/我的/系统），一次性返回供前端 Tab 标头展示 */
  async tabCounts(userId: number) {
    const [mine, system] = await Promise.all([
      this.prisma.imageTemplate.count({ where: { isSystem: false, userId } }),
      this.prisma.imageTemplate.count({ where: { isSystem: true } }),
    ])
    return { all: mine + system, mine, system }
  }

  /** 分组聚合，下拉框使用。随 Tab 取值：mine 只看个人分组 / system 只看系统分组 / all 并集 */
  async findGroups(userId: number, tab: "all" | "mine" | "system" = "all") {
    return this.listGroupsByScope(
      this.groupVisibility(tab, userId),
      this.visibilityClause(tab, userId)
    )
  }

  /** 标签聚合（JSON 数组在应用层去重计数），标签筛选条使用。随 Tab 取值，同 findGroups */
  async findTags(userId: number, tab: "all" | "mine" | "system" = "all") {
    const rows = await this.prisma.imageTemplate.findMany({
      where: this.visibilityClause(tab, userId),
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

  /** 详情：必须在可见集合内 */
  async findOne(id: number, userId: number) {
    return this.present(await this.findOneRow(id, userId))
  }

  /** 新建个人模板（isSystem 强制 false） */
  async create(dto: CreateImageTemplateDto, userId: number) {
    const groupId = await this.resolvePersonalGroupId(userId, dto.groupName)
    const row = await this.prisma.imageTemplate.create({
      data: {
        userId,
        isSystem: false,
        name: dto.name,
        groupId,
        tags: (dto.tags ?? Prisma.JsonNull) as Prisma.NullableJsonNullValueInput | Json,
        note: dto.note,
        items: { create: this.buildItems(dto.items) },
      },
      include: DETAIL_INCLUDE,
    })
    return this.present(row)
  }

  /** 编辑个人模板（仅本人，系统模板不可经此接口改） */
  async update(id: number, dto: UpdateImageTemplateDto, userId: number) {
    await this.assertOwnedPersonal(id, userId)
    const groupPatch =
      dto.groupName !== undefined
        ? { groupId: await this.resolvePersonalGroupId(userId, dto.groupName) }
        : {}
    const row = await this.prisma.imageTemplate.update({
      where: { id },
      data: {
        name: dto.name,
        ...groupPatch,
        ...(dto.tags !== undefined ? { tags: dto.tags as Json } : {}),
        note: dto.note,
        ...(dto.items ? { items: { deleteMany: {}, create: this.buildItems(dto.items) } } : {}),
      },
      include: DETAIL_INCLUDE,
    })
    return this.present(row)
  }

  /**
   * 往已有个人模板末尾追加一张图片条目（生成图「存为模板 · 加到现有模板」用）。
   * sortOrder 取当前最大值 +1，返回追加后的完整模板。
   */
  async addItem(id: number, dto: TemplateItemDto, userId: number) {
    await this.assertOwnedPersonal(id, userId)
    const last = await this.prisma.imageTemplateItem.findFirst({
      where: { templateId: id },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    })
    const nextSort = last ? last.sortOrder + 1 : 0
    await this.prisma.imageTemplateItem.create({
      data: { templateId: id, ...this.buildItemData(dto, nextSort) },
    })
    return this.findOne(id, userId)
  }

  /** 删除个人模板（软删除，仅本人） */
  async remove(id: number, userId: number) {
    await this.assertOwnedPersonal(id, userId)
    await this.prisma.imageTemplate.update({ where: { id }, data: { deletedAt: new Date() } })
    return { success: true }
  }

  /** 复制到我的分组：把可见模板克隆为当前用户的个人模板 */
  async copy(id: number, dto: CopyImageTemplateDto, userId: number) {
    const src = await this.findOneRow(id, userId)
    const groupId = await this.resolvePersonalGroupId(userId, dto.groupName ?? src.group?.name)
    const row = await this.prisma.imageTemplate.create({
      data: {
        userId,
        isSystem: false,
        name: dto.name ?? `${src.name}-副本`,
        groupId,
        tags: (src.tags ?? Prisma.JsonNull) as Prisma.NullableJsonNullValueInput | Json,
        note: src.note,
        items: { create: this.cloneItems(src.items) },
      },
      include: DETAIL_INCLUDE,
    })
    return this.present(row)
  }

  /**
   * 导入分享码：前端解析出模板 id 数组后调用，按 id 批量克隆为当前用户的个人模板。
   * 已删除（软删除自动过滤）/ 不存在的 id 直接跳过，只导入存在的；返回导入结果。
   * 源模板的分组名会落到当前用户自己的同名个人分组（不存在则建）。
   */
  async importTemplates(ids: number[], userId: number) {
    const uniqueIds = [...new Set(ids)]
    const sources = await this.prisma.imageTemplate.findMany({
      where: { id: { in: uniqueIds } },
      include: { items: { orderBy: ITEMS_ORDER }, group: { select: { name: true } } },
    })
    const foundIds = new Set(sources.map(s => s.id))
    const skippedIds = uniqueIds.filter(id => !foundIds.has(id))

    // 先把源模板分组名解析为当前用户的个人分组 id（按源分组名去重，每个源分组只建一次）
    // 导入语义：无同名分组→建同名分组；已有同名分组→另起「-副本」分组，不并入原分组
    const groupIdByName = new Map<string, number | null>()
    for (const name of new Set(sources.map(s => s.group?.name ?? ""))) {
      groupIdByName.set(name, await this.resolveImportGroupId(userId, name || undefined))
    }

    // $transaction 保序：created[i] 对应 sources[i]
    const created = await this.prisma.$transaction(
      sources.map(src =>
        this.prisma.imageTemplate.create({
          data: {
            userId,
            isSystem: false,
            name: src.name,
            groupId: groupIdByName.get(src.group?.name ?? "") ?? null,
            tags: (src.tags ?? Prisma.JsonNull) as Prisma.NullableJsonNullValueInput | Json,
            note: src.note,
            items: { create: this.cloneItems(src.items) },
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

  // ==================== 个人分组管理（分组管理弹窗） ====================

  /** 分组管理列表：当前用户全部个人分组（含 0 模板的空分组）+ 各组当前模板数 */
  async listGroups(userId: number) {
    return this.listGroupsByScope({ isSystem: false, userId }, { isSystem: false, userId })
  }

  /** 新建空分组 */
  async createGroup(userId: number, name: string) {
    const trimmed = name.trim()
    if (!trimmed) throw new ConflictException("分组名不能为空")
    const exists = await this.prisma.imageTemplateGroup.findUnique({
      where: { userId_name: { userId, name: trimmed } },
    })
    if (exists) throw new ConflictException("分组名已存在")
    const g = await this.prisma.imageTemplateGroup.create({
      data: { userId, isSystem: false, name: trimmed },
    })
    return { id: g.id, name: g.name, count: 0 }
  }

  /** 重命名分组：模板按 groupId 关联，名称随关系取，无需改动模板行 */
  async renameGroup(userId: number, id: number, name: string) {
    const trimmed = name.trim()
    if (!trimmed) throw new ConflictException("分组名不能为空")
    const g = await this.findOwnedGroup(id, userId)
    if (trimmed === g.name) return { id: g.id, name: g.name }
    const dup = await this.prisma.imageTemplateGroup.findUnique({
      where: { userId_name: { userId, name: trimmed } },
    })
    if (dup) throw new ConflictException("分组名已存在")
    const updated = await this.prisma.imageTemplateGroup.update({
      where: { id },
      data: { name: trimmed },
    })
    return { id: updated.id, name: updated.name }
  }

  /** 删除分组：连带软删除组内个人模板（并置空其 groupId），再硬删除分组行 */
  async deleteGroup(userId: number, id: number) {
    await this.findOwnedGroup(id, userId)
    const [res] = await this.prisma.$transaction([
      this.prisma.imageTemplate.updateMany({
        where: { groupId: id, deletedAt: null },
        data: { deletedAt: new Date(), groupId: null },
      }),
      this.prisma.imageTemplateGroup.delete({ where: { id } }),
    ])
    return { success: true, deletedTemplateCount: res.count }
  }

  // ==================== 管理员侧（系统模板） ====================

  /** 系统分组聚合（含计数），管理页分组筛选 Tab（全部/A+/PreA+ ...）使用 */
  async findGroupsSystem() {
    return this.listGroupsByScope({ isSystem: true }, { isSystem: true })
  }

  async findAllSystem(query: QuerySystemTemplateDto) {
    const { page = 1, pageSize = 10, groupId, keyword } = query
    const where: Prisma.ImageTemplateWhereInput = {
      isSystem: true,
      ...(groupId ? { groupId } : {}),
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword } },
              { note: { contains: keyword } },
              { items: { some: { prompt: { contains: keyword } } } },
            ],
          }
        : {}),
    }

    const [total, rows] = await Promise.all([
      this.prisma.imageTemplate.count({ where }),
      this.prisma.imageTemplate.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: LIST_INCLUDE,
      }),
    ])

    return { total, page, pageSize, items: rows.map(r => this.present(r)) }
  }

  /** 新建系统模板（isSystem=true，userId 记录创建管理员） */
  async createSystem(dto: CreateImageTemplateDto, adminUserId: number) {
    const groupId = await this.resolveSystemGroupId(dto.groupName)
    const row = await this.prisma.imageTemplate.create({
      data: {
        userId: adminUserId,
        isSystem: true,
        name: dto.name,
        groupId,
        tags: (dto.tags ?? Prisma.JsonNull) as Prisma.NullableJsonNullValueInput | Json,
        note: dto.note,
        items: { create: this.buildItems(dto.items) },
      },
      include: DETAIL_INCLUDE,
    })
    return this.present(row)
  }

  async updateSystem(id: number, dto: UpdateImageTemplateDto) {
    await this.assertSystem(id)
    const groupPatch =
      dto.groupName !== undefined ? { groupId: await this.resolveSystemGroupId(dto.groupName) } : {}
    const row = await this.prisma.imageTemplate.update({
      where: { id },
      data: {
        name: dto.name,
        ...groupPatch,
        ...(dto.tags !== undefined ? { tags: dto.tags as Json } : {}),
        note: dto.note,
        ...(dto.items ? { items: { deleteMany: {}, create: this.buildItems(dto.items) } } : {}),
      },
      include: DETAIL_INCLUDE,
    })
    return this.present(row)
  }

  async removeSystem(id: number) {
    await this.assertSystem(id)
    const tpl = await this.prisma.imageTemplate.findUnique({
      where: { id },
      select: { groupId: true },
    })
    await this.prisma.imageTemplate.update({ where: { id }, data: { deletedAt: new Date() } })
    // 该系统模板所在分组若已无其他存活系统模板，连带删除空分组
    if (tpl?.groupId != null) {
      const remaining = await this.prisma.imageTemplate.count({
        where: { groupId: tpl.groupId, isSystem: true },
      })
      if (remaining === 0) {
        await this.prisma.imageTemplateGroup.deleteMany({
          where: { id: tpl.groupId, isSystem: true },
        })
      }
    }
    return { success: true }
  }

  // ==================== 私有工具 ====================

  private visibilityClause(
    tab: "all" | "mine" | "system",
    userId: number
  ): Prisma.ImageTemplateWhereInput {
    if (tab === "mine") return { isSystem: false, userId }
    if (tab === "system") return { isSystem: true }
    return { OR: [{ isSystem: true }, { userId, isSystem: false }] }
  }

  private groupVisibility(
    tab: "all" | "mine" | "system",
    userId: number
  ): Prisma.ImageTemplateGroupWhereInput {
    if (tab === "mine") return { isSystem: false, userId }
    if (tab === "system") return { isSystem: true }
    return { OR: [{ isSystem: true }, { isSystem: false, userId }] }
  }

  /**
   * 分组列表通用实现：取 groupWhere 命中的分组行（含空分组），
   * 再按 templateWhere 统计各组当前模板数。返回 { id, name, count }。
   */
  private async listGroupsByScope(
    groupWhere: Prisma.ImageTemplateGroupWhereInput,
    templateWhere: Prisma.ImageTemplateWhereInput
  ) {
    const [groups, counts] = await Promise.all([
      this.prisma.imageTemplateGroup.findMany({
        where: groupWhere,
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      }),
      this.prisma.imageTemplate.groupBy({
        by: ["groupId"],
        where: { ...templateWhere, groupId: { not: null } },
        _count: { _all: true },
      }),
    ])
    const countMap = new Map(counts.map(c => [c.groupId as number, c._count._all]))
    return groups.map(g => ({ id: g.id, name: g.name, count: countMap.get(g.id) ?? 0 }))
  }

  /** 把所属分组摊平成 groupName，并把 _count.items 摊平成 itemCount */
  private present(row: {
    group?: { id: number; name: string } | null
    _count?: { items: number }
    [k: string]: unknown
  }) {
    const { group, _count, ...rest } = row
    return {
      ...rest,
      groupName: group?.name ?? null,
      ...(_count ? { itemCount: _count.items } : {}),
    }
  }

  /** 个人模板写入时把分组名解析为当前用户的个人分组 id（不存在则建），空名返回 null */
  private async resolvePersonalGroupId(userId: number, name?: string | null) {
    const trimmed = name?.trim()
    if (!trimmed) return null
    const g = await this.prisma.imageTemplateGroup.upsert({
      where: { userId_name: { userId, name: trimmed } },
      create: { userId, isSystem: false, name: trimmed },
      update: {},
      select: { id: true },
    })
    return g.id
  }

  /**
   * 导入分享码专用的分组解析：无同名个人分组则按原名建；已有同名分组则另起
   * 「{name}-副本」（再冲突顺延「-副本2」「-副本3」…）新建，绝不并入用户已有分组。
   */
  private async resolveImportGroupId(userId: number, name?: string | null) {
    const trimmed = name?.trim()
    if (!trimmed) return null

    const taken = async (n: string) =>
      !!(await this.prisma.imageTemplateGroup.findUnique({
        where: { userId_name: { userId, name: n } },
        select: { id: true },
      }))

    let target = trimmed
    if (await taken(target)) {
      // 重名：依次尝试「-副本」「-副本2」「-副本3」… 直到找到空闲名
      target = `${trimmed}-副本`
      for (let n = 2; await taken(target); n++) target = `${trimmed}-副本${n}`
    }

    const g = await this.prisma.imageTemplateGroup.create({
      data: { userId, isSystem: false, name: target },
      select: { id: true },
    })
    return g.id
  }

  /** 系统模板写入时把分组名解析为系统分组 id（不存在则建），空名返回 null */
  private async resolveSystemGroupId(name?: string | null) {
    const trimmed = name?.trim()
    if (!trimmed) return null
    const existing = await this.prisma.imageTemplateGroup.findFirst({
      where: { isSystem: true, name: trimmed },
      select: { id: true },
    })
    if (existing) return existing.id
    const created = await this.prisma.imageTemplateGroup.create({
      data: { isSystem: true, name: trimmed },
      select: { id: true },
    })
    return created.id
  }

  /** 取本人个人分组行，校验归属（系统分组不可经用户接口管理） */
  private async findOwnedGroup(id: number, userId: number) {
    const g = await this.prisma.imageTemplateGroup.findUnique({ where: { id } })
    if (!g || g.isSystem || g.userId !== userId) throw new NotFoundException("分组不存在")
    return g
  }

  private buildItems(items: TemplateItemDto[]) {
    return items.map((it, i) => this.buildItemData(it, i))
  }

  /** 单条 DTO → 入库字段；sortOrder 缺省时用 fallback（新建用下标，追加用 max+1） */
  private buildItemData(it: TemplateItemDto, fallbackSort: number) {
    return {
      name: it.name?.trim() || "默认",
      prompt: it.prompt,
      refImageUrl: it.refImageUrl,
      aspectRatio: it.aspectRatio,
      textAmount: it.textAmount,
      resolutionTier: it.resolutionTier,
      customAspectW: it.customAspectW,
      customAspectH: it.customAspectH,
      customSizeMode: it.customSizeMode,
      sortOrder: it.sortOrder ?? fallbackSort,
    }
  }

  /** 克隆已存在模板的条目（复制 / 导入共用），保留原值 */
  private cloneItems(
    items: {
      name: string
      prompt: string | null
      refImageUrl: string | null
      aspectRatio: string | null
      textAmount: string | null
      resolutionTier: string | null
      customAspectW: number | null
      customAspectH: number | null
      customSizeMode: string | null
      competitorTemplate: Prisma.JsonValue | null
      generationSettings: Prisma.JsonValue | null
      site: string | null
      promptVersion: string | null
      promptHash: string | null
      sortOrder: number
      sourceMeta?: Prisma.JsonValue | null
    }[]
  ) {
    return items.map((it, i) => ({
      sourceMeta: (it.sourceMeta ?? Prisma.JsonNull) as Json,
      name: it.name,
      prompt: it.prompt,
      refImageUrl: it.refImageUrl,
      aspectRatio: it.aspectRatio,
      textAmount: it.textAmount,
      resolutionTier: it.resolutionTier,
      customAspectW: it.customAspectW,
      customAspectH: it.customAspectH,
      customSizeMode: it.customSizeMode,
      competitorTemplate:
        it.competitorTemplate === null ? Prisma.JsonNull : (it.competitorTemplate as Json),
      generationSettings:
        it.generationSettings === null ? Prisma.JsonNull : (it.generationSettings as Json),
      site: it.site,
      promptVersion: it.promptVersion,
      promptHash: it.promptHash,
      sortOrder: it.sortOrder ?? i,
    }))
  }

  private async assertOwnedPersonal(id: number, userId: number) {
    const tpl = await this.prisma.imageTemplate.findUnique({
      where: { id },
      select: { userId: true, isSystem: true },
    })
    if (!tpl) throw new NotFoundException("模板不存在")
    if (tpl.isSystem) throw new ForbiddenException("系统模板请在「内置提示词管理」中维护")
    if (tpl.userId !== userId) throw new ForbiddenException("无权操作该模板")
  }

  private async assertSystem(id: number) {
    const tpl = await this.prisma.imageTemplate.findUnique({
      where: { id },
      select: { isSystem: true },
    })
    if (!tpl) throw new NotFoundException("系统模板不存在")
    if (!tpl.isSystem) throw new ForbiddenException("该模板不是系统模板")
  }

  private async findOneRow(id: number, userId: number) {
    const tpl = await this.prisma.imageTemplate.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    })
    if (!tpl) throw new NotFoundException("模板不存在")
    if (!tpl.isSystem && tpl.userId !== userId) throw new ForbiddenException("无权访问该模板")
    return tpl
  }
}
