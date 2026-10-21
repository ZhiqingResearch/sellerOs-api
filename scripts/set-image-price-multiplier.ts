/**
 * 将现有 IMAGE 模型统一设为指定倍率（含所有 category 和停用模型）。
 * 倍率默认 2，默认只预览；--apply 正式更新。重复执行只更新倍率不同的行。
 *
 * npm run gateway:image-price -- --multiplier=1.5 --dry-run
 * npm run gateway:image-price -- --multiplier=1.5 --apply
 *
 * 使用当前环境的 DATABASE_URL，缺省从项目根目录 .env 加载。
 * 仅调整现有记录；未来新模型上架时需显式配置对应的 --priceMultiplier。
 */
import "dotenv/config"
import { AiModelModality, PrismaClient } from "@prisma/client"

async function main() {
  const args = process.argv.slice(2)
  const allowed = new Set(["--dry-run", "--apply", "--help"])
  if (args.some(arg => !allowed.has(arg) && !arg.startsWith("--multiplier="))) {
    throw new Error("不支持的参数。用法：npm run gateway:image-price -- --multiplier=1.5 [--dry-run | --apply]")
  }
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("--apply 与 --dry-run 不能同时使用")
  }
  if (args.includes("--help")) {
    console.log("用法：npm run gateway:image-price -- --multiplier=1.5 [--dry-run | --apply]")
    console.log("倍率默认 2，支持 0.01～999.99、最多两位小数；默认预览，--apply 正式更新。")
    return
  }

  const multiplierArgs = args.filter(arg => arg.startsWith("--multiplier="))
  if (multiplierArgs.length > 1) throw new Error("--multiplier 只能指定一次")
  const rawMultiplier = multiplierArgs[0]?.slice("--multiplier=".length) ?? "2"
  const multiplier = Number(rawMultiplier)
  // 与数据库 Decimal(5, 2) 对齐，避免数据库静默舍入或溢出。
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(rawMultiplier) || multiplier <= 0 || multiplier > 999.99) {
    throw new Error("倍率必须在 0.01～999.99 之间，且最多两位小数")
  }

  const prisma = new PrismaClient()
  const where = {
    modality: AiModelModality.IMAGE,
    priceMultiplier: { not: multiplier },
  }
  try {
    const models = await prisma.aiGatewayModel.findMany({
      where,
      select: { id: true, publicId: true, category: true, priceMultiplier: true },
      orderBy: { id: "asc" },
    })
    for (const model of models) {
      console.log(
        `模型 ${model.id} ${model.publicId} [${model.category}]：${model.priceMultiplier.toString()} → ${multiplier}`
      )
    }
    if (!args.includes("--apply")) {
      console.log(`预览完成：${models.length} 条记录需要更新，未写入数据库。`)
      return
    }

    const result = await prisma.aiGatewayModel.updateMany({
      where,
      data: { priceMultiplier: multiplier },
    })
    const remaining = await prisma.aiGatewayModel.count({ where })
    if (remaining > 0) {
      throw new Error(`已更新 ${result.count} 条，复查仍有 ${remaining} 条倍率不为 ${multiplier}，请检查并发配置变更`)
    }
    console.log(`更新完成：${result.count} 条记录已设为 ${multiplier}；复查所有现有 IMAGE 模型倍率均为 ${multiplier}。`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "执行失败")
  process.exitCode = 1
})
