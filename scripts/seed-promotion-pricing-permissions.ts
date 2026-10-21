/**
 * 补齐新品推广计划、商品智能定价菜单及 ADMIN 授权，保留已有菜单配置与角色绑定。
 * 新菜单紧随目标库的 AI 商品工厂排序；定义复用权限种子。
 *
 * npx tsx scripts/seed-promotion-pricing-permissions.ts --database=agent-api-dev3 --dry-run
 * npx tsx scripts/seed-promotion-pricing-permissions.ts --database=agent-api-dev3
 */
import { PrismaClient } from "@prisma/client"
import "dotenv/config"
import { PERMISSIONS } from "../prisma/seed/permissions"

const prisma = new PrismaClient()
const isDryRun = process.argv.includes("--dry-run")
const permissionKeys = ["tool.promotion_plan", "tool.smart_pricing"]

async function seedPromotionPricingPermissions() {
  const expectedDatabase = process.argv.find(arg => arg.startsWith("--database="))?.slice(11)
  const databaseName = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1)
  if (!expectedDatabase || databaseName !== expectedDatabase) {
    throw new Error("请用 --database=目标库名 指定与 DATABASE_URL 一致的数据库")
  }
  console.log(`目标库：${databaseName}；${isDryRun ? "预览，不写库" : "正式执行"}`)

  await prisma.$transaction(
    async tx => {
      const admin = await tx.roleModel.findUniqueOrThrow({ where: { code: "ADMIN" } })
      const factory = await tx.permission.findUnique({ where: { key: "tool.product_factory" } })
      for (const [index, key] of permissionKeys.entries()) {
        const definition = PERMISSIONS.find(permission => permission.key === key)
        if (!definition) throw new Error(`种子未定义菜单：${key}`)
        const existing = await tx.permission.findUnique({ where: { key } })
        const data = {
          ...definition,
          subRoutes: definition.subRoutes ?? [],
          sortOrder: factory ? factory.sortOrder + index + 1 : definition.sortOrder,
        }
        console.log(
          `${key}：${existing ? "保留已有配置" : `新增 ${data.route}，排序 ${data.sortOrder}`}`
        )
        if (isDryRun) {
          const binding = existing
            ? await tx.rolePermission.findUnique({
                where: { roleId_permissionId: { roleId: admin.id, permissionId: existing.id } },
              })
            : null
          console.log(`  ADMIN：${binding ? "已授权" : "将补充授权"}`)
          continue
        }
        const permission = await tx.permission.upsert({ where: { key }, update: {}, create: data })
        await tx.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: admin.id, permissionId: permission.id } },
          update: {},
          create: { roleId: admin.id, permissionId: permission.id },
        })
        console.log("  ADMIN：授权已确认")
      }
    },
    { timeout: 30000 }
  )
}

seedPromotionPricingPermissions()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "菜单补齐失败")
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
