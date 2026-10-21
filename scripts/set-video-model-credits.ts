import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length)
}

/**
 * 视频模型固定一口价（积分/秒，按分辨率分档）配置：按 publicId + category 维护
 * AiGatewayVideoFixedPrice 表，一行 = 一个分辨率档。扣费/预检/报价实时读库，
 * 改完即对下一笔任务生效，无需重启。
 *
 * 用法：
 *   npx tsx scripts/set-video-model-credits.ts --publicId=X --category=NORMAL \
 *     --per-sec="480p=15,720p=20,720p-sr=20"
 *   npx tsx scripts/set-video-model-credits.ts --publicId=X --category=REFERENCE \
 *     --mode=video_to_video --per-sec="480p=25,720p=25"   # 按生成模式分价（如全能参考的参考/编辑）
 *   npx tsx scripts/set-video-model-credits.ts --publicId=X --category=NORMAL --clear   # 清空该模型全部档位，回落按量
 *   npx tsx scripts/set-video-model-credits.ts --list                                  # 列出视频模型与已配价格
 *
 * 说明：
 *   - 配置后该 (publicId, category) 的视频生成仅 SUCCESS 按「积分/秒 × 实际时长秒」
 *     精确扣费（exactCredits，不打折不乘倍率）；失败/取消/超时不扣。
 *   - 档位键 = 网关请求/终态回传的 resolution 字符串（脚本统一小写归一，如 480p / 720p-sr），
 *     实际枚举以 --list 输出的 requestSchema 为准；请求缺档位 → 该笔回落按量。
 *   - mode 匹配优先精确行（如 reference_to_video / video_to_video），未命中退通配行（--mode 缺省），
 *     仍无则该笔回落按量；同模型同分辨率可按模式配不同价。
 *   - 无行/清空 = 该模型回落按量计费（网关实际账单 × priceMultiplier）。
 *   - 仅允许为已上架目录行配价；目录行不存在会提示先 onboard，不误建孤儿价。
 */
async function main() {
  if (process.argv.includes("--list")) {
    const models = await prisma.aiGatewayModel.findMany({
      where: { modality: "VIDEO" },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
      select: {
        publicId: true,
        displayName: true,
        category: true,
        enabled: true,
        gatewayActive: true,
      },
    })
    const prices = await prisma.aiGatewayVideoFixedPrice.findMany({
      orderBy: [{ publicId: "asc" }, { mode: "asc" }, { resolution: "asc" }],
    })
    const priceByModel = new Map<string, string>()
    for (const row of prices) {
      if (row.creditsPerSec == null) continue
      const key = `${row.publicId}::${row.category}`
      const modeLabel = row.mode ? `${row.mode}:` : ""
      priceByModel.set(
        key,
        `${priceByModel.get(key) ? `${priceByModel.get(key)}, ` : ""}${modeLabel}${row.resolution}=${row.creditsPerSec.toString()}`
      )
    }
    console.log("视频模型目录（publicId | displayName | category | 上架 | 已配一口价）：")
    for (const model of models) {
      const price = priceByModel.get(`${model.publicId}::${model.category}`)
      console.log(
        `${model.publicId} | ${model.displayName} | ${model.category} | ${model.enabled && model.gatewayActive ? "✅" : "❌"} | ${price ?? "（按量）"}`
      )
    }
    return
  }

  const publicId = arg("publicId")
  const category = arg("category")
  const mode = (arg("mode") ?? "").trim().toLowerCase()
  const perSecArg = arg("per-sec")
  const clear = process.argv.includes("--clear")

  if (!publicId || !category || (!clear && !perSecArg) || (clear && perSecArg)) {
    throw new Error(
      "用法：--publicId=<模型ID> --category=<类别> (--per-sec=<480p=15,720p=20,...> | --clear | --list)\n" +
        "  可选 --mode=<reference_to_video|video_to_video|...> 按生成模式分价（缺省=通配该类别全部模式）\n" +
        "类别常用 NORMAL(常规模式) / REFERENCE(全能参考) / MOTION_CONTROL(动作复刻) / STORYBOARD(客户分镜) / BEAUTY(美业)"
    )
  }

  const existing = await prisma.aiGatewayModel.findUnique({
    where: { publicId_category: { publicId, category } },
    select: { id: true, enabled: true, gatewayActive: true },
  })
  if (!existing) {
    throw new Error(
      `目录行不存在：publicId=${publicId} category=${category}（先经 onboard-ai-gateway-video-model.ts 上架，再配价）`
    )
  }
  if (!existing.enabled || !existing.gatewayActive) {
    console.warn(
      `⚠️  目录行未启用（enabled=${existing.enabled} gatewayActive=${existing.gatewayActive}），价格仍会保存，但模型不可用时不产生扣费`
    )
  }

  if (clear) {
    const removed = await prisma.aiGatewayVideoFixedPrice.updateMany({
      where: { publicId, category, mode },
      data: { creditsPerSec: null },
    })
    console.log(
      `✅ 已清空 publicId=${publicId} category=${category}${mode ? ` mode=${mode}` : "（通配）"} 的 ${removed.count} 档，该范围回落按量计费`
    )
    return
  }

  const entries = (perSecArg ?? "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const [rawResolution, rawValue] = part.split("=").map(s => s?.trim())
      const resolution = rawResolution?.toLowerCase()
      const creditsPerSec = Number(rawValue)
      if (!resolution || !rawValue || !Number.isFinite(creditsPerSec) || creditsPerSec <= 0) {
        throw new Error(`档位格式不合法：${part}（应为 分辨率=积分/秒，如 720p=20，且为正数）`)
      }
      return { publicId, category, mode, resolution, creditsPerSec }
    })
  if (!entries.length) throw new Error("--per-sec 不能为空")

  for (const entry of entries) {
    await prisma.aiGatewayVideoFixedPrice.upsert({
      where: {
        publicId_category_mode_resolution: {
          publicId: entry.publicId,
          category: entry.category,
          mode: entry.mode,
          resolution: entry.resolution,
        },
      },
      create: entry,
      update: { creditsPerSec: entry.creditsPerSec },
    })
    console.log(
      `✅ ${entry.publicId} [${entry.category}]${entry.mode ? ` ${entry.mode}` : "（通配）"} ${entry.resolution} = ${entry.creditsPerSec} 积分/秒`
    )
  }
  console.log(
    `完成：${entries.length} 档已保存（未列出的旧档位保留，可用 --clear 全清后重配）。生效口径：仅 SUCCESS 按「积分/秒 × 实际时长」扣费`
  )
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
