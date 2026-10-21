/** 仅迁移本次菜单及旧选品权限，保留所有自定义角色和其他菜单。先运行 --dry-run。 */
import { PrismaClient } from "@prisma/client"
import { PERMISSIONS } from "../prisma/seed/permissions"

const prisma = new PrismaClient()
async function main() {
  const keys = ["tool.market_research", "tool.category_analysis"]
  const definitions = PERMISSIONS.filter(permission => keys.includes(permission.key))
  const legacy = await prisma.permission.findMany({
    where: { key: { in: ["tool.flow_workbench", "tool.flow_workbench.tool"] } },
    select: { id: true },
  })
  const grants = legacy.length
    ? await prisma.rolePermission.findMany({
        where: { permissionId: { in: legacy.map(permission => permission.id) } },
        select: { roleId: true },
        distinct: ["roleId"],
      })
    : []
  console.log(
    `将更新 ${definitions.length} 个菜单，为 ${grants.length} 个既有选品角色保留类目分析权限`
  )
  if (process.argv.includes("--dry-run")) return
  await prisma.$transaction(
    async tx => {
      for (const permission of definitions) {
        const data = { ...permission, subRoutes: permission.subRoutes ?? [] }
        await tx.permission.upsert({ where: { key: permission.key }, create: data, update: data })
      }
      const added = await tx.permission.findMany({
        where: { key: { in: keys } },
      })
      if (grants.length)
        await tx.rolePermission.createMany({
          data: grants.flatMap(grant =>
            added.map(permission => ({ roleId: grant.roleId, permissionId: permission.id }))
          ),
          skipDuplicates: true,
        })
    },
    { timeout: 30000 }
  )
  console.log("菜单与原有授权已迁移；权限缓存最长 5 分钟后更新")
}
main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : "菜单迁移失败")
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
