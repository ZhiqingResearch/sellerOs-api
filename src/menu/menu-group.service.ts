import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { PrismaService } from "../prisma/prisma.service"
import { CreateMenuGroupDto } from "./dto/create-menu-group.dto"
import { MenuGroupDto } from "./dto/menu-response.dto"
import { UpdateMenuGroupDto } from "./dto/update-menu-group.dto"

type GroupRow = Prisma.PermissionGroupGetPayload<object>

@Injectable()
export class MenuGroupService {
  private readonly logger = new Logger(MenuGroupService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** 分组列表（按 sortOrder 排序，带组内菜单数量） */
  async list(): Promise<MenuGroupDto[]> {
    const [groups, counts] = await Promise.all([
      this.prisma.permissionGroup.findMany({ orderBy: { sortOrder: "asc" } }),
      this.prisma.permission.groupBy({
        by: ["groupCode"],
        _count: { _all: true },
      }),
    ])
    const countByCode = new Map(counts.map(c => [c.groupCode, c._count._all]))
    return groups.map(g => ({
      ...this.toDto(g),
      menuCount: countByCode.get(g.code) ?? 0,
    }))
  }

  /** 新增分组（code 全局唯一，创建后不可修改） */
  async create(dto: CreateMenuGroupDto): Promise<MenuGroupDto> {
    const exists = await this.prisma.permissionGroup.findUnique({
      where: { code: dto.code },
      select: { id: true },
    })
    if (exists) throw new ConflictException(`分组编码「${dto.code}」已存在`)

    const sortOrder = await this.nextSortOrder()
    const created = await this.prisma.permissionGroup.create({
      data: { code: dto.code, label: dto.label, sortOrder },
    })
    this.logger.log(`Menu group created: ${created.code} (#${created.id})`)
    return { ...this.toDto(created), menuCount: 0 }
  }

  /** 编辑分组（仅 label / sortOrder；code 不可改） */
  async update(id: number, dto: UpdateMenuGroupDto): Promise<MenuGroupDto> {
    const group = await this.prisma.permissionGroup.findUnique({ where: { id } })
    if (!group) throw new NotFoundException("分组不存在")

    const updated = await this.prisma.permissionGroup.update({
      where: { id },
      data: {
        ...(dto.label !== undefined && { label: dto.label }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
    })
    this.logger.log(`Menu group updated: ${updated.code} (#${id})`)
    return { ...this.toDto(updated), menuCount: await this.countMenus(updated.code) }
  }

  /** 删除分组：内置组不可删；组内还有菜单不可删（需先移出/删除菜单） */
  async remove(id: number): Promise<{ id: number }> {
    const group = await this.prisma.permissionGroup.findUnique({ where: { id } })
    if (!group) throw new NotFoundException("分组不存在")
    if (group.isBuiltin) throw new BadRequestException("内置分组不可删除")

    const menuCount = await this.countMenus(group.code)
    if (menuCount > 0) {
      throw new ConflictException(`该分组下还有 ${menuCount} 个菜单，请先移出后再删除`)
    }

    await this.prisma.permissionGroup.delete({ where: { id } })
    this.logger.log(`Menu group deleted: ${group.code} (#${id})`)
    return { id }
  }

  /** 分组存在性校验，供菜单创建/换组复用 */
  async assertGroupExists(code: string): Promise<void> {
    const exists = await this.prisma.permissionGroup.findUnique({
      where: { code },
      select: { id: true },
    })
    if (!exists) throw new BadRequestException(`菜单分组不存在：${code}`)
  }

  // ── 内部工具 ──────────────────────────────────────────────

  private async countMenus(code: string): Promise<number> {
    return this.prisma.permission.count({ where: { groupCode: code } })
  }

  private async nextSortOrder(): Promise<number> {
    const last = await this.prisma.permissionGroup.findFirst({
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    })
    return last ? last.sortOrder + 1 : 1
  }

  private toDto(g: GroupRow): MenuGroupDto {
    return {
      id: g.id,
      code: g.code,
      label: g.label,
      isBuiltin: g.isBuiltin,
      sortOrder: g.sortOrder,
      menuCount: 0,
    }
  }
}
