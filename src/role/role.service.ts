import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { MePermissionDto } from "../auth/dto/me.dto"
import { PermissionCacheService } from "../auth/services/permission-cache.service"
import { PrismaService } from "../prisma/prisma.service"
import { CreateRoleDto } from "./dto/create-role.dto"
import { RoleItemDto, RoleUserItemDto } from "./dto/role-response.dto"
import { UpdateRoleDto } from "./dto/update-role.dto"

@Injectable()
export class RoleService {
  private readonly logger = new Logger(RoleService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionCache: PermissionCacheService
  ) {}

  /** 全部权限清单（按 groupCode + sortOrder），供前端渲染勾选树 */
  async listPermissions(): Promise<MePermissionDto[]> {
    const rows = await this.prisma.permission.findMany({
      orderBy: [{ groupCode: "asc" }, { sortOrder: "asc" }],
    })
    return rows.map(p => ({
      key: p.key,
      label: p.label,
      groupCode: p.groupCode,
      parentKey: p.parentKey,
      route: p.route,
      subRoutes: (p.subRoutes as string[] | null) ?? null,
      sortOrder: p.sortOrder,
    }))
  }

  /** 角色列表，含用户数与权限 key */
  async listRoles(): Promise<RoleItemDto[]> {
    const roles = await this.prisma.roleModel.findMany({
      orderBy: { id: "asc" },
      include: {
        _count: { select: { users: true } },
        permissions: { select: { permission: { select: { key: true } } } },
      },
    })
    return roles.map(r => this.toRoleItem(r))
  }

  /** 角色详情 */
  async getRole(id: number): Promise<RoleItemDto> {
    const role = await this.prisma.roleModel.findUnique({
      where: { id },
      include: {
        _count: { select: { users: true } },
        permissions: { select: { permission: { select: { key: true } } } },
      },
    })
    if (!role) throw new NotFoundException("角色不存在")
    return this.toRoleItem(role)
  }

  /** 新建角色（含权限绑定） */
  async createRole(dto: CreateRoleDto): Promise<RoleItemDto> {
    await this.assertNameAvailable(dto.name)
    const code = await this.generateUniqueCode(dto.name)

    const role = await this.prisma.roleModel.create({
      data: {
        code,
        name: dto.name,
        description: dto.description ?? null,
        color: dto.color ?? null,
        isSystem: false,
      },
    })

    await this.bindPermissions(role.id, dto.permissionKeys)
    this.logger.log(`Role created: ${code} (#${role.id})`)
    return this.getRole(role.id)
  }

  /** 修改角色：name/description/color/permissionKeys（内置超级管理员完全不可改） */
  async updateRole(id: number, dto: UpdateRoleDto): Promise<RoleItemDto> {
    const role = await this.prisma.roleModel.findUnique({ where: { id } })
    if (!role) throw new NotFoundException("角色不存在")

    // 唯一的内置角色＝超级管理员：拥有全部权限，名称/权限均不可在管理端修改
    if (role.isSystem) {
      throw new BadRequestException("内置超级管理员不可修改")
    }

    if (dto.name !== undefined && dto.name !== role.name) {
      await this.assertNameAvailable(dto.name)
    }

    await this.prisma.roleModel.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.color !== undefined && { color: dto.color }),
      },
    })

    if (dto.permissionKeys !== undefined) {
      await this.bindPermissions(id, dto.permissionKeys)
      this.permissionCache.invalidate(id)
    }

    return this.getRole(id)
  }

  /** 删除角色：内置角色不可删；角色下有用户不可删 */
  async deleteRole(id: number): Promise<{ id: number }> {
    const role = await this.prisma.roleModel.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } },
    })
    if (!role) throw new NotFoundException("角色不存在")
    if (role.isSystem) throw new ConflictException("内置超级管理员不可删除")
    if (role._count.users > 0) {
      throw new ConflictException(`该角色下还有 ${role._count.users} 名用户，请先移除后再删除`)
    }

    // RolePermission 通过外键级联删除
    await this.prisma.roleModel.delete({ where: { id } })
    this.permissionCache.invalidate(id)
    this.logger.log(`Role deleted: ${role.code} (#${id})`)
    return { id }
  }

  /** 角色下的用户列表 */
  async listRoleUsers(id: number): Promise<RoleUserItemDto[]> {
    const role = await this.prisma.roleModel.findUnique({ where: { id }, select: { id: true } })
    if (!role) throw new NotFoundException("角色不存在")

    const links = await this.prisma.userRole.findMany({
      where: { roleId: id },
      select: {
        user: {
          select: { id: true, username: true, phone: true, isActive: true, lastLoginAt: true },
        },
      },
      orderBy: { userId: "asc" },
    })
    return links.map(l => ({
      id: l.user.id,
      username: l.user.username,
      phone: l.user.phone,
      isActive: l.user.isActive,
      lastLoginAt: l.user.lastLoginAt ? l.user.lastLoginAt.toISOString() : null,
    }))
  }

  // ── 内部工具 ──────────────────────────────────────────────

  private toRoleItem(role: {
    id: number
    code: string
    name: string
    description: string | null
    color: string | null
    isSystem: boolean
    _count: { users: number }
    permissions: { permission: { key: string } }[]
  }): RoleItemDto {
    return {
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      color: role.color,
      isSystem: role.isSystem,
      usersCount: role._count.users,
      permissionKeys: role.permissions.map(p => p.permission.key),
    }
  }

  /** 整组重置角色权限绑定：先清自己的，再按 key 解析出的 id 重建（参考 seed/rbac.ts） */
  private async bindPermissions(roleId: number, permissionKeys: string[]): Promise<void> {
    const unique = [...new Set(permissionKeys)]
    const perms = unique.length
      ? await this.prisma.permission.findMany({
          where: { key: { in: unique } },
          select: { id: true },
        })
      : []
    const data = perms.map(p => ({ roleId, permissionId: p.id }))

    const ops: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.rolePermission.deleteMany({ where: { roleId } }),
    ]
    if (data.length) {
      ops.push(this.prisma.rolePermission.createMany({ data, skipDuplicates: true }))
    }
    await this.prisma.$transaction(ops)
  }

  /** 角色名称唯一校验 */
  private async assertNameAvailable(name: string): Promise<void> {
    const exists = await this.prisma.roleModel.findFirst({
      where: { name },
      select: { id: true },
    })
    if (exists) throw new ConflictException(`角色名称「${name}」已存在`)
  }

  /**
   * 角色 code 仅作 seed 跨环境稳定标识用，自定义角色不暴露给客户端（客户端一律用 id 寻址）。
   * 这里按名称派生一个唯一值满足 schema 的非空唯一列；全中文名兜底为 "role"。
   */
  private async generateUniqueCode(name: string): Promise<string> {
    const base =
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "role"
    let candidate = base
    let n = 1
    while (await this.prisma.roleModel.findUnique({ where: { code: candidate } })) {
      n += 1
      candidate = `${base}_${n}`
    }
    return candidate
  }
}
