import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PermissionCacheService } from "../auth/services/permission-cache.service"
import { PrismaService } from "../prisma/prisma.service"
import { CreateMenuDto } from "./dto/create-menu.dto"
import { MenuNodeDto, MenuTreeGroupDto, MenuTreeResponseDto } from "./dto/menu-response.dto"
import { ReorderMenuDto } from "./dto/reorder-menu.dto"
import { UpdateMenuDto } from "./dto/update-menu.dto"
import { MenuGroupService } from "./menu-group.service"

/** Permission 表中与菜单相关的列 */
const MENU_SELECT = {
  id: true,
  key: true,
  label: true,
  groupCode: true,
  parentKey: true,
  route: true,
  subRoutes: true,
  sortOrder: true,
} satisfies Prisma.PermissionSelect

type MenuRow = Prisma.PermissionGetPayload<{ select: typeof MENU_SELECT }>

/** 内置超级管理员角色 code（见 prisma/seed/permissions.ts ROLE_DEFINITIONS） */
const SUPER_ADMIN_ROLE_CODE = "ADMIN"

@Injectable()
export class MenuService {
  private readonly logger = new Logger(MenuService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionCache: PermissionCacheService,
    private readonly menuGroups: MenuGroupService
  ) {}

  /** 分组菜单树：分组按 PermissionGroup.sortOrder 排序，组内菜单按 sortOrder 排序 */
  async getTree(): Promise<MenuTreeResponseDto> {
    const [groups, rows] = await Promise.all([
      this.prisma.permissionGroup.findMany({ orderBy: { sortOrder: "asc" } }),
      this.prisma.permission.findMany({ orderBy: [{ sortOrder: "asc" }], select: MENU_SELECT }),
    ])

    const roots = this.buildTree(rows)
    const buckets = new Map<string, MenuNodeDto[]>()
    for (const node of roots) {
      const arr = buckets.get(node.groupCode) ?? []
      arr.push(node)
      buckets.set(node.groupCode, arr)
    }
    const countByCode = new Map<string, number>()
    for (const r of rows) countByCode.set(r.groupCode, (countByCode.get(r.groupCode) ?? 0) + 1)

    const known = new Set(groups.map(g => g.code))
    const out: MenuTreeGroupDto[] = groups.map(g => ({
      code: g.code,
      label: g.label,
      sortOrder: g.sortOrder,
      menuCount: countByCode.get(g.code) ?? 0,
      menus: buckets.get(g.code) ?? [],
    }))
    // 兜底：分组表缺失的孤儿 groupCode（历史数据），按 code 排在最后，避免菜单凭空消失
    const orphans = [...buckets.keys()].filter(code => !known.has(code)).sort()
    for (const code of orphans) {
      out.push({
        code,
        label: code,
        sortOrder: Number.MAX_SAFE_INTEGER,
        menuCount: countByCode.get(code) ?? 0,
        menus: buckets.get(code) ?? [],
      })
    }
    return { groups: out }
  }

  /** 新增菜单 / 子菜单 */
  async createMenu(dto: CreateMenuDto): Promise<MenuNodeDto> {
    await this.assertKeyAvailable(dto.key)

    let groupCode: string
    let parentKey: string | null = null

    if (dto.parentKey) {
      const parent = await this.prisma.permission.findUnique({
        where: { key: dto.parentKey },
        select: { key: true, groupCode: true },
      })
      if (!parent) throw new BadRequestException(`父菜单不存在：${dto.parentKey}`)
      parentKey = parent.key
      groupCode = parent.groupCode // 子菜单分组继承父级，忽略入参
    } else {
      if (!dto.groupCode) throw new BadRequestException("顶级菜单必须指定分组 groupCode")
      groupCode = dto.groupCode
      await this.menuGroups.assertGroupExists(groupCode)
    }

    const sortOrder = await this.nextSortOrder(parentKey)

    // 超管的「全部权限」是物化的绑定行而非运行时旁路：新权限必须同步绑给超管，
    // 否则连超管自己都看不到新菜单。其余角色不动，由管理端手动勾选。
    const adminRole = await this.prisma.roleModel.findUnique({
      where: { code: SUPER_ADMIN_ROLE_CODE },
      select: { id: true },
    })

    const created = await this.prisma.$transaction(async tx => {
      const p = await tx.permission.create({
        data: {
          key: dto.key,
          label: dto.label,
          groupCode,
          parentKey,
          route: dto.route ?? null,
          subRoutes: dto.subRoutes ?? Prisma.JsonNull,
          sortOrder,
        },
        select: MENU_SELECT,
      })
      if (adminRole) {
        await tx.rolePermission.create({ data: { roleId: adminRole.id, permissionId: p.id } })
      }
      return p
    })

    if (!adminRole) {
      this.logger.warn(
        `未找到内置超级管理员角色（code=${SUPER_ADMIN_ROLE_CODE}），新菜单 ${created.key} 未自动授权`
      )
    }
    this.permissionCache.invalidateAll()
    this.logger.log(`Menu created: ${created.key} (#${created.id})`)
    return this.toNode(created)
  }

  /** 编辑菜单 */
  async updateMenu(id: number, dto: UpdateMenuDto): Promise<MenuNodeDto> {
    const menu = await this.prisma.permission.findUnique({ where: { id }, select: MENU_SELECT })
    if (!menu) throw new NotFoundException("菜单不存在")

    const wantsKeyChange = dto.key !== undefined && dto.key !== menu.key
    const wantsGroupChange = dto.groupCode !== undefined && dto.groupCode !== menu.groupCode

    if (wantsGroupChange && menu.parentKey !== null) {
      throw new BadRequestException("子菜单分组继承父级，不可单独修改")
    }
    if (wantsGroupChange) await this.menuGroups.assertGroupExists(dto.groupCode as string)
    if (wantsKeyChange) await this.assertKeyAvailable(dto.key as string)

    const data: Prisma.PermissionUpdateInput = {
      ...(dto.label !== undefined && { label: dto.label }),
      ...(dto.route !== undefined && { route: dto.route || null }),
      ...(wantsKeyChange && { key: dto.key }),
      ...(wantsGroupChange && { groupCode: dto.groupCode }),
      ...(dto.subRoutes !== undefined && {
        subRoutes: dto.subRoutes === null ? Prisma.JsonNull : dto.subRoutes,
      }),
    }

    if (wantsGroupChange) {
      // 顶级菜单换组：级联同步整棵子树的 groupCode
      const descendantIds = await this.collectDescendantIds(menu.key)
      await this.prisma.$transaction([
        this.prisma.permission.update({ where: { id }, data }),
        ...(descendantIds.length
          ? [
              this.prisma.permission.updateMany({
                where: { id: { in: descendantIds } },
                data: { groupCode: dto.groupCode },
              }),
            ]
          : []),
      ])
    } else {
      await this.prisma.permission.update({ where: { id }, data })
    }

    this.permissionCache.invalidateAll()
    const fresh = await this.prisma.permission.findUnique({ where: { id }, select: MENU_SELECT })
    return this.toNode(fresh as MenuRow)
  }

  /** 删除菜单：有子菜单不可删（需先删子菜单） */
  async deleteMenu(id: number): Promise<{ id: number }> {
    const menu = await this.prisma.permission.findUnique({ where: { id }, select: MENU_SELECT })
    if (!menu) throw new NotFoundException("菜单不存在")

    const childCount = await this.prisma.permission.count({ where: { parentKey: menu.key } })
    if (childCount > 0) {
      throw new ConflictException(`该菜单下还有 ${childCount} 个子菜单，请先删除后再删除`)
    }

    // RolePermission 通过外键级联删除，自动解绑所有角色
    await this.prisma.permission.delete({ where: { id } })
    this.permissionCache.invalidateAll()
    this.logger.log(`Menu deleted: ${menu.key} (#${id})`)
    return { id }
  }

  /** 同级批量重排：前端回传同级分组的新顺序 id 列表，后端赋 sortOrder = 下标+1 */
  async reorderMenus(dto: ReorderMenuDto): Promise<{ updated: number }> {
    const { orderedIds } = dto
    const rows = await this.prisma.permission.findMany({
      where: { id: { in: orderedIds } },
      select: { id: true, parentKey: true },
    })
    if (rows.length !== orderedIds.length) {
      throw new BadRequestException("存在不存在的菜单 id")
    }
    // 轻校验：必须同属一个同级分组（同 parentKey），避免跨级误传
    const parentKeys = new Set(rows.map(r => r.parentKey))
    if (parentKeys.size > 1) {
      throw new BadRequestException("只能对同一同级分组重排（parentKey 不一致）")
    }

    await this.prisma.$transaction(
      orderedIds.map((id, i) =>
        this.prisma.permission.update({ where: { id }, data: { sortOrder: i + 1 } })
      )
    )
    // sortOrder 不进权限缓存，无需 invalidate
    return { updated: orderedIds.length }
  }

  // ── 内部工具 ──────────────────────────────────────────────

  private buildTree(rows: MenuRow[]): MenuNodeDto[] {
    const nodeByKey = new Map<string, MenuNodeDto>()
    for (const r of rows) nodeByKey.set(r.key, this.toNode(r))

    const roots: MenuNodeDto[] = []
    for (const r of rows) {
      const node = nodeByKey.get(r.key) as MenuNodeDto
      const parent = r.parentKey ? nodeByKey.get(r.parentKey) : undefined
      if (parent) parent.children.push(node)
      else roots.push(node) // 顶级，或父级缺失时兜底挂根
    }
    return roots
  }

  private toNode(r: MenuRow): MenuNodeDto {
    return {
      id: r.id,
      key: r.key,
      label: r.label,
      groupCode: r.groupCode,
      parentKey: r.parentKey,
      route: r.route,
      subRoutes: (r.subRoutes as string[] | null) ?? null,
      sortOrder: r.sortOrder,
      children: [],
    }
  }

  private async assertKeyAvailable(key: string): Promise<void> {
    const exists = await this.prisma.permission.findUnique({ where: { key }, select: { id: true } })
    if (exists) throw new ConflictException(`权限标识「${key}」已存在`)
  }

  /** 同一父级（同 parentKey）下的下一个排序值 = max + 1 */
  private async nextSortOrder(parentKey: string | null): Promise<number> {
    const last = await this.prisma.permission.findFirst({
      where: { parentKey },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    })
    return last ? last.sortOrder + 1 : 1
  }

  /** 按 parentKey 链收集某节点的全部后代 id（不含自身） */
  private async collectDescendantIds(rootKey: string): Promise<number[]> {
    const all = await this.prisma.permission.findMany({
      select: { id: true, key: true, parentKey: true },
    })
    const childrenByParent = new Map<string, { id: number; key: string }[]>()
    for (const p of all) {
      if (!p.parentKey) continue
      const arr = childrenByParent.get(p.parentKey) ?? []
      arr.push({ id: p.id, key: p.key })
      childrenByParent.set(p.parentKey, arr)
    }
    const result: number[] = []
    const queue = [rootKey]
    while (queue.length) {
      const k = queue.shift() as string
      for (const child of childrenByParent.get(k) ?? []) {
        result.push(child.id)
        queue.push(child.key)
      }
    }
    return result
  }
}
