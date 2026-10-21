import { MePermissionDto, MeRoleDto } from "./dto/me.dto"

/**
 * 多角色合并工具：用户名下可挂多个角色，最终的角色列表 / 权限菜单都是各角色的并集。
 * getMe / getPermissions / usage.statsByUser 三处共用，合并去重逻辑只在这里实现一次。
 */

interface PermissionRow {
  key: string
  label: string
  groupCode: string
  parentKey: string | null
  route: string | null
  subRoutes: unknown
  sortOrder: number
}

interface RoleRow {
  code: string
  name: string
  color: string | null
  permissions: { permission: PermissionRow }[]
}

/** UserRole 关联行（含其 role） */
export interface UserRoleRow {
  role: RoleRow
}

/** 用户的角色列表（去掉权限明细，仅 code/name/color） */
export function mergeUserRoles(rows: readonly UserRoleRow[] | null | undefined): MeRoleDto[] {
  return (rows ?? []).map(r => ({
    code: r.role.code,
    name: r.role.name,
    color: r.role.color ?? null,
  }))
}

/**
 * 用户的权限并集：跨所有角色按 key 去重，按 sortOrder 升序。
 */
export function mergeUserPermissions(
  rows: readonly UserRoleRow[] | null | undefined
): MePermissionDto[] {
  const byKey = new Map<string, MePermissionDto>()
  for (const ur of rows ?? []) {
    for (const rp of ur.role.permissions) {
      const p = rp.permission
      if (byKey.has(p.key)) continue
      byKey.set(p.key, {
        key: p.key,
        label: p.label,
        groupCode: p.groupCode,
        parentKey: p.parentKey,
        route: p.route,
        subRoutes: (p.subRoutes as string[] | null) ?? null,
        sortOrder: p.sortOrder,
      })
    }
  }
  return [...byKey.values()].sort((a, b) => a.sortOrder - b.sortOrder)
}

/** Prisma select 片段：把用户的 roles → role → permissions → permission 一次取齐。可直接铺进 select / include。 */
export const userRolesSelect = {
  select: {
    role: {
      select: {
        code: true,
        name: true,
        color: true,
        permissions: {
          select: {
            permission: {
              select: {
                key: true,
                label: true,
                groupCode: true,
                parentKey: true,
                route: true,
                subRoutes: true,
                sortOrder: true,
              },
            },
          },
        },
      },
    },
  },
} as const
