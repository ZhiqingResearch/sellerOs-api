import { Prisma, PrismaClient } from "@prisma/client"
import { PERMISSION_GROUPS, PERMISSIONS, ROLE_DEFINITIONS } from "./permissions"

/**
 * 幂等写入权限基线：把所有 permission 的 upsert 收进一个事务一把发，
 * 避免逐条往返远程库。最终落库结果与逐条 upsert 完全一致。
 */
export async function seedPermissions(prisma: PrismaClient) {
  // 内置分组先于权限落库：Permission.groupCode 逻辑关联分组表
  await prisma.$transaction(
    PERMISSION_GROUPS.map(g =>
      prisma.permissionGroup.upsert({
        where: { code: g.code },
        update: { label: g.label, sortOrder: g.sortOrder, isBuiltin: true },
        create: { code: g.code, label: g.label, sortOrder: g.sortOrder, isBuiltin: true },
      })
    )
  )
  await prisma.$transaction(
    PERMISSIONS.map(p =>
      prisma.permission.upsert({
        where: { key: p.key },
        update: {
          label: p.label,
          groupCode: p.groupCode,
          parentKey: p.parentKey,
          route: p.route,
          subRoutes: p.subRoutes ?? undefined,
          sortOrder: p.sortOrder,
        },
        create: {
          key: p.key,
          label: p.label,
          groupCode: p.groupCode,
          parentKey: p.parentKey,
          route: p.route,
          subRoutes: p.subRoutes ?? undefined,
          sortOrder: p.sortOrder,
        },
      })
    )
  )
  await migrateChetaidouPermission(prisma)
  return { permissions: PERMISSIONS.length, groups: PERMISSION_GROUPS.length }
}

/**
 * 幂等写入内置角色 + 权限绑定：
 *  1. 一个事务批量 upsert 所有角色（同时拿回各自 id）
 *  2. 再一个事务里，对每个角色按 matcher 重置绑定（deleteMany 只清该角色自己的行，绝不全表清）
 *
 * matcher 的匹配范围是「数据库里的全部权限」而非 PERMISSIONS 种子数组——
 * 管理端运行时新增的菜单/权限也会被超管 matcher（() => true）匹中，
 * 因此重跑 seed 不会清掉超管对这些新菜单的授权。
 */
export async function seedRoles(prisma: PrismaClient) {
  const allPermissions = await prisma.permission.findMany({
    select: { id: true, key: true, groupCode: true },
  })

  // 1. 批量 upsert 角色，结果数组与 ROLE_DEFINITIONS 同序，可据此拿 role.id
  const roles = await prisma.$transaction(
    ROLE_DEFINITIONS.map(def =>
      prisma.roleModel.upsert({
        where: { code: def.code },
        update: {
          name: def.name,
          description: def.description,
          color: def.color ?? null,
          isSystem: def.isSystem,
        },
        create: {
          code: def.code,
          name: def.name,
          description: def.description,
          color: def.color ?? null,
          isSystem: def.isSystem,
        },
      })
    )
  )

  // 2. 批量重置绑定：每个角色「先清自己的、再按 matcher 重建」，顺序在同一事务内保持
  const bindingOps = ROLE_DEFINITIONS.flatMap((def, i) => {
    const roleId = roles[i].id
    const data = allPermissions.filter(def.matcher).map(p => ({ roleId, permissionId: p.id }))
    const ops: Prisma.PrismaPromise<Prisma.BatchPayload>[] = [
      prisma.rolePermission.deleteMany({ where: { roleId } }),
    ]
    if (data.length) {
      ops.push(prisma.rolePermission.createMany({ data, skipDuplicates: true }))
    }
    return ops
  })
  await prisma.$transaction(bindingOps)

  return { roles: ROLE_DEFINITIONS.length }
}

/**
 * 完整 RBAC 基线：权限 + 角色绑定。等价于先 seedPermissions 再 seedRoles。
 * 只改角色 matcher 时可单独跑 seedRoles 跳过权限刷新。
 */
export async function seedRbac(prisma: PrismaClient) {
  const p = await seedPermissions(prisma)
  const r = await seedRoles(prisma)
  return { permissions: p.permissions, roles: r.roles }
}

/** 将旧节点授权迁到菜单树节点；不扩大其他角色权限。部署后重启服务刷新权限缓存。 */
export async function migrateChetaidouPermission(prisma: PrismaClient) {
  await prisma.$transaction(async tx => {
    const old = await tx.permission.findUnique({ where: { key: "tool.chetaidou" } })
    const current = await tx.permission.findUnique({
      where: { key: "tool.ai_creative_studio.chetaidou" },
    })
    if (!old || !current) return
    const grants = await tx.rolePermission.findMany({ where: { permissionId: old.id } })
    await tx.rolePermission.createMany({
      data: grants.map(g => ({ roleId: g.roleId, permissionId: current.id })),
      skipDuplicates: true,
    })
    await tx.rolePermission.deleteMany({ where: { permissionId: old.id } })
    await tx.permission.delete({ where: { id: old.id } })
  })
}
