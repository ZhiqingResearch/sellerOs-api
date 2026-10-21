/**
 * 一次性补充分销体系菜单权限键（2026-08-30，B4）：
 *   - management.distribution（分销管理 → /customer-operations，C1 已定落在客户运营页 tab）
 *   - tool.distribution（邀请分销 → /distribution，C 端 P8 独立页）
 * 并把这两个键绑定到内置 ADMIN 角色（只补缺失行，不重置既有绑定）。
 *
 * 为什么不用全量 `npx tsx prisma/seed.ts rbac`：全量 seed 会把种子里所有键的
 * label/route/sortOrder 回写成种子值，覆盖后台运营手工调过的菜单配置。本脚本只处理
 * 这两个新键：**键已存在则整行跳过**（后台改过的 route/label 不会被覆盖），自定义角色
 * 的绑定一律不动（要授权去角色管理里勾）。
 *
 * 性能说明（2026-09-01 优化）：全部查询合并为最多 4 次往返（角色 1 + 权限 1 + 绑定 1，
 * 有缺失才追加 createMany 1-2 次）——脚本耗时几乎全在 tsx/Prisma 启动与海外库网络延迟上，
 * 串行小查询已压到最少；全量已存在时仅 3 次只读往返。
 *
 * 幂等，可随时重跑。用法：
 *   npx tsx scripts/seed-distribution-permissions.ts --dry-run   # 先看影响面
 *   npx tsx scripts/seed-distribution-permissions.ts             # 正式执行
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

const NEW_PERMISSIONS = [
  {
    key: "management.distribution",
    label: "分销管理",
    groupCode: "management",
    parentKey: null,
    route: "/customer-operations",
    sortOrder: 17,
  },
  {
    key: "tool.distribution",
    label: "邀请分销",
    groupCode: "tools",
    parentKey: null,
    route: "/distribution",
    sortOrder: 11,
  },
] as const

async function main() {
  console.log(dryRun ? "=== DRY RUN（不写库）===" : "=== 正式执行 ===")

  const keys = NEW_PERMISSIONS.map(p => p.key)
  // 往返 1+2：角色与两个权限键并行查（互无依赖）
  const [admin, existingPerms] = await Promise.all([
    prisma.roleModel.findUnique({ where: { code: "ADMIN" }, select: { id: true } }),
    prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true, key: true, route: true } }),
  ])
  if (!admin) {
    console.warn("⚠️ 未找到内置 ADMIN 角色，跳过绑定（仅插入权限键）")
  }

  const existingByKey = new Map(existingPerms.map(p => [p.key, p]))
  const missing = NEW_PERMISSIONS.filter(p => !existingByKey.has(p.key))
  for (const p of NEW_PERMISSIONS) {
    const existing = existingByKey.get(p.key)
    if (existing) {
      console.log(`权限 ${p.key} 已存在（route=${existing.route}），跳过不覆盖`)
    } else {
      console.log(`权限 ${p.key} 不存在 → 新增（route=${p.route}）`)
    }
  }

  // 有缺失才写（往返 3a：createMany 一次性插入；随后一次性取回 id）
  const idByKey = new Map(existingPerms.map(p => [p.key, p.id]))
  if (missing.length) {
    if (!dryRun) {
      await prisma.permission.createMany({ data: missing })
      const created = await prisma.permission.findMany({
        where: { key: { in: missing.map(p => p.key) } },
        select: { id: true, key: true },
      })
      for (const c of created) idByKey.set(c.key, c.id)
    } else {
      console.log(`ADMIN 对缺失键将一并补绑（dry-run，不落库）`)
    }
  }

  if (admin) {
    // dry-run 下缺失键没有 id，绑定检查只覆盖已存在的键
    const checkable = keys.filter(k => idByKey.has(k))
    if (checkable.length) {
      // 往返 3b：一次性查绑定
      const bound = await prisma.rolePermission.findMany({
        where: { roleId: admin.id, permissionId: { in: checkable.map(k => idByKey.get(k)!) } },
        select: { permissionId: true },
      })
      const boundIds = new Set(bound.map(b => b.permissionId))
      const toBind = checkable.filter(k => !boundIds.has(idByKey.get(k)!))
      for (const k of checkable) {
        console.log(boundIds.has(idByKey.get(k)!) ? `  ADMIN 已绑定 ${k}，跳过` : `  ADMIN 未绑定 ${k} → 补绑`)
      }
      if (toBind.length && !dryRun) {
        // 往返 4：createMany 一次性补绑
        await prisma.rolePermission.createMany({
          data: toBind.map(k => ({ roleId: admin.id, permissionId: idByKey.get(k)! })),
        })
      }
    }
  }
  console.log(dryRun ? "dry-run 完成" : "完成")
}

main()
  .catch(e => {
    console.error("执行失败：", e)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
