import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length)
}

/**
 * 图片模型固定一口价（积分/张）配置：按 publicId + category(逗号分隔多值) 更新
 * AiGatewayModel.fixedCredits。扣费侧实时读库，改完即对下一笔任务生效，无需重启。
 *
 * 用法：
 *   npx tsx scripts/set-image-model-credits.ts --publicId=ZQ-Image-1 --category=IMAGE_GENERATION,PORTRAIT --credits=15
 *   npx tsx scripts/set-image-model-credits.ts --publicId=ZQ-Image-1 --category=AI_SPLIT --credits=30
 *   npx tsx scripts/set-image-model-credits.ts --publicId=ZQ-Image-1 --category=PORTRAIT --clear   # 清空回落按量
 *
 * 说明：
 *   - fixedCredits 配置后该类别生图按「fixedCredits × 成功张数」精确扣费（不打折）；
 *     AI_SPLIT 行为组合价（含拆图分析费，分析两步不再单独计费）。
 *   - NULL（--clear）= 该模型回落按量计费（网关实际账单 × priceMultiplier）。
 *   - 仅更新已有目录行；行不存在会提示先经 onboard/sync 脚本上架，不会误建残缺行。
 */
async function main() {
  const publicId = arg("publicId")
  const categories = arg("category")
    ?.split(",")
    .map(c => c.trim())
    .filter(Boolean)
  const creditsArg = arg("credits")
  const clear = process.argv.includes("--clear")

  if (
    !publicId ||
    !categories?.length ||
    (!clear && creditsArg == null) ||
    (clear && creditsArg != null)
  ) {
    throw new Error(
      "用法：--publicId=<模型ID> --category=<类别1,类别2...> (--credits=<积分/张> | --clear)\n" +
        "类别可选 IMAGE_GENERATION(通用生图) / PORTRAIT(人像) / AI_SPLIT(拆图组合价)"
    )
  }

  let fixedCredits: number | null = null
  if (!clear) {
    fixedCredits = Number(creditsArg)
    if (!Number.isFinite(fixedCredits) || fixedCredits <= 0)
      throw new Error("--credits 需为正数（清空配置用 --clear）")
  }

  let updated = 0
  for (const category of categories) {
    const existing = await prisma.aiGatewayModel.findUnique({
      where: { publicId_category: { publicId, category } },
      select: { id: true, enabled: true, gatewayActive: true, fixedCredits: true },
    })
    if (!existing) {
      console.warn(
        `⚠️  跳过 category=${category}：目录行不存在（先经 onboard-ai-gateway-image-model.ts / sync-ai-split-models.ts 上架）`
      )
      continue
    }
    await prisma.aiGatewayModel.update({
      where: { publicId_category: { publicId, category } },
      data: { fixedCredits },
    })
    updated += 1
    console.log(
      `✅ category=${category} publicId=${publicId} fixedCredits: ${existing.fixedCredits?.toString() ?? "null"} → ${fixedCredits?.toString() ?? "null"}（enabled=${existing.enabled} gatewayActive=${existing.gatewayActive}）`
    )
  }
  console.log(`完成：更新 ${updated}/${categories.length} 行`)
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
