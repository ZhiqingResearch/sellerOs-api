/**
 * 数据库种子脚本（幂等，可重复跑）。
 *
 * 用法：
 *   tsx prisma/seed.ts [task...]
 *   不传参 = 跑默认集合：rbac
 *
 * 可用 task：
 *   rbac     权限 + 内置超级管理员角色绑定（= perms + roles）
 *   perms    只刷权限（PERMISSIONS 变了才需要）
 *   roles    只刷内置角色 + 绑定（改了 ROLE_DEFINITIONS 时用）
 *   pricing  写入定价配置（必须显式传，默认集合不含）
 *   membership 写入会员套餐 + 充值包配置（必须显式传，默认集合不含）
 *   billing  写入团队套餐档/团队充值包/自定义阶梯/返利规则（必须显式传，默认集合不含）
 *   models   写入 AI 模型目录（必须显式传，默认集合不含）
 *   local-redraw 初始化 LOCAL_REDRAW 分类 ZQ-Image-2（复用已有通用生图配置与定价）
 *   features 写入功能模块注册表（必须显式传，默认集合不含）
 *   skill-market 写入 Skill 市场技能目录 23 条（必须显式传，默认集合不含）
 *
 * 例子：
 *   tsx prisma/seed.ts            # rbac
 *   tsx prisma/seed.ts perms      # 只刷权限目录
 *   tsx prisma/seed.ts rbac pricing
 *
 * 执行顺序固定为 perms → roles → pricing → membership（不受传参顺序影响），保证依赖正确。
 *
 * 说明：角色（除内置超级管理员外）与用户均改由管理界面维护，不再 seed。
 *   seed 只负责：① 权限目录 PERMISSIONS  ② 一个内置超级管理员角色（绑全部权限）。
 *   ⚠️ seed 不创建任何用户；全新/空库需手动创建首个超级管理员用户才能登录管理端。
 *
 * 注意：所有写操作均为 upsert / 范围限定 deleteMany，不会清空业务数据。
 */
import { PrismaClient } from "@prisma/client"
import { seedBilling } from "./seed/billing"
import { seedFeatures } from "./seed/features"
import { seedMembership } from "./seed/membership"
import { seedModels } from "./seed/models"
import { seedLocalRedrawModel } from "./seed/local-redraw"
import { seedPricing } from "./seed/pricing"
import { seedPermissions, seedRoles } from "./seed/rbac"
import { seedSkillMarket } from "./seed/skill-market"

const prisma = new PrismaClient()

const TASKS = [
  "rbac",
  "perms",
  "roles",
  "pricing",
  "membership",
  "billing",
  "models",
  "features",
  "skill-market",
  "local-redraw",
] as const
type Task = (typeof TASKS)[number]
// 不传参时跑的默认集合；pricing 必须显式传 `pricing` 才会执行
const DEFAULT_TASKS: readonly Task[] = ["rbac"]

async function main() {
  const args = process.argv.slice(2).map(a => a.toLowerCase())
  const unknown = args.filter(a => !TASKS.includes(a as Task))
  if (unknown.length) {
    console.error(`未知任务：${unknown.join(", ")}；可用：${TASKS.join(" | ")}`)
    process.exit(1)
  }
  const selected = new Set<Task>(args.length ? (args as Task[]) : DEFAULT_TASKS)

  const lines: string[] = ["Seed completed:"]

  // perms 必须在 roles 之前（roles 的绑定要按 key 查权限 id）
  const runPerms = selected.has("rbac") || selected.has("perms")
  const runRoles = selected.has("rbac") || selected.has("roles")

  if (runPerms) {
    const r = await seedPermissions(prisma)
    lines.push(`  permissions: ${r.permissions}`)
    lines.push(`  groups:      ${r.groups}`)
  }
  if (runRoles) {
    const r = await seedRoles(prisma)
    lines.push(`  roles:       ${r.roles}`)
  }
  if (selected.has("pricing")) {
    const r = await seedPricing(prisma)
    lines.push(`  pricing:     ${r.count}`)
  }
  if (selected.has("membership")) {
    const r = await seedMembership(prisma)
    lines.push(`  membership:  plans ${r.plans}, packs ${r.packs}`)
  }
  if (selected.has("billing")) {
    const r = await seedBilling(prisma)
    lines.push(
      `  billing:     teamPlans ${r.teamPlans}, teamPacks ${r.teamPacks}, ladderTiers ${r.ladderTiers}`
    )
  }
  if (selected.has("local-redraw")) {
    const result = await seedLocalRedrawModel(prisma)
    lines.push(`  local-redraw: ${result.created ? "created" : "existing"}`)
  }
  if (selected.has("models")) {
    const r = await seedModels(prisma)
    lines.push(`  models:      ${r.models}`)
  }
  if (selected.has("features")) {
    const r = await seedFeatures(prisma)
    lines.push(`  features:    ${r.features}`)
  }
  if (selected.has("skill-market")) {
    const r = await seedSkillMarket(prisma)
    lines.push(`  skillMarket: ${r.skills} skills`)
  }

  console.log(lines.join("\n"))
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
