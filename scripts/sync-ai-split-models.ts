import { AiModelExecMode, AiModelModality, Prisma, PrismaClient } from "@prisma/client"
import { AiGatewayClient, type GatewayModel } from "@zhiqingresearch/ai-ts-sdk"

// 用法：npx tsx scripts/sync-ai-split-models.ts [--analysis <publicId>] [--credits <积分/张>] [imageModelId...]
//   --analysis   同步为 AI 拆图多模态分析模型（AI_SPLIT_MULTIMODAL，chat.completions）：
//                enabled=true 并停用同类目其余行（应用要求该类目启用行恰好一条），
//                分析模型不写死代码，各环境用本参数指定要启用的模型
//   --credits    拆图生图模型固定一口价（积分/张，组合价含分析费）；仅对位置参数
//                生图模型行（AI_SPLIT）落库，create 落值、update 仅在传参时覆盖；
//                不传则不动 fixedCredits（NULL=按量回落）。0/负数非法，清空用
//                scripts/set-image-model-credits.ts --clear
//   位置参数     AI 拆图生图模型（AI_SPLIT，images.generations），可传多个
const prisma = new PrismaClient()

function requiredEnv(key: string) {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${key}`)
  return value
}

function modality(value: GatewayModel["modality"]): AiModelModality {
  return {
    text: AiModelModality.TEXT,
    image: AiModelModality.IMAGE,
    video: AiModelModality.VIDEO,
  }[value]
}

function execMode(value: GatewayModel["exec_mode"]): AiModelExecMode {
  return value === "sync" ? AiModelExecMode.SYNC : AiModelExecMode.ASYNC
}

async function syncModel(
  gateway: AiGatewayClient,
  publicId: string,
  category: "AI_SPLIT_MULTIMODAL" | "AI_SPLIT",
  operation: "chat.completions" | "images.generations",
  fixedCredits?: number
) {
  const [detail, requestSchema, pricing] = await Promise.all([
    gateway.models.get(publicId),
    gateway.models.requestSchema(publicId, { operation }),
    gateway.models.pricing(publicId, { operation }),
  ])
  if (
    category === "AI_SPLIT_MULTIMODAL" &&
    (detail.modality !== "text" || detail.exec_mode !== "sync")
  ) {
    throw new Error(`${publicId} 不是同步文本/多模态模型`)
  }
  if (category === "AI_SPLIT" && detail.modality !== "image") {
    throw new Error(`${publicId} 不是图片模型`)
  }

  await prisma.aiGatewayModel.upsert({
    where: { publicId_category: { publicId, category } },
    update: {
      displayName: detail.display_name,
      modality: modality(detail.modality),
      execMode: execMode(detail.exec_mode),
      gatewayConfig: { detail, requestSchema } as unknown as Prisma.InputJsonValue,
      quoteConfig: pricing as unknown as Prisma.InputJsonValue,
      gatewayActive: true,
      syncedAt: new Date(),
      enabled: true,
      ...(fixedCredits != null ? { fixedCredits } : {}),
    },
    create: {
      publicId,
      category,
      displayName: detail.display_name,
      modality: modality(detail.modality),
      execMode: execMode(detail.exec_mode),
      gatewayConfig: { detail, requestSchema } as unknown as Prisma.InputJsonValue,
      quoteConfig: pricing as unknown as Prisma.InputJsonValue,
      gatewayActive: true,
      syncedAt: new Date(),
      enabled: true,
      sortOrder: 0,
      ...(fixedCredits != null ? { fixedCredits } : {}),
    },
  })
  console.log(
    `synced category=${category} publicId=${publicId} fixedCredits=${fixedCredits ?? "未变更"} schemaVersion=${requestSchema.version}`
  )
}

async function main() {
  const gateway = new AiGatewayClient({
    baseURL: requiredEnv("AI_GATEWAY_BASE_URL"),
    apiKey: requiredEnv("AI_GATEWAY_API_KEY"),
    timeoutMs: 60_000,
    getRetry: { maxRetries: 0 },
  })

  const args = process.argv.slice(2)
  const analysisIndex = args.indexOf("--analysis")
  const analysisModel =
    analysisIndex >= 0 ? args[analysisIndex + 1]?.trim() : undefined
  if (analysisIndex >= 0 && !analysisModel) {
    throw new Error("--analysis 需要跟模型 publicId")
  }
  const creditsIndex = args.indexOf("--credits")
  const creditsRaw = creditsIndex >= 0 ? args[creditsIndex + 1]?.trim() : undefined
  if (
    creditsIndex >= 0 &&
    (!creditsRaw || !Number.isFinite(Number(creditsRaw)) || Number(creditsRaw) <= 0)
  ) {
    throw new Error("--credits 需要跟正数（积分/张；清空用 set-image-model-credits.ts --clear）")
  }
  const fixedCredits = creditsRaw != null ? Number(creditsRaw) : undefined
  const exclude = new Set<number>()
  if (analysisIndex >= 0) {
    exclude.add(analysisIndex)
    if (analysisIndex + 1 < args.length) exclude.add(analysisIndex + 1)
  }
  if (creditsIndex >= 0) {
    exclude.add(creditsIndex)
    if (creditsIndex + 1 < args.length) exclude.add(creditsIndex + 1)
  }
  const imageModels = [
    ...new Set(
      args
        .filter((_, index) => !exclude.has(index))
        .map(value => value.trim())
        .filter(Boolean)
    ),
  ]
  if (!analysisModel && imageModels.length === 0) {
    console.log("未指定任何模型。用法：sync-ai-split-models.ts [--analysis <publicId>] [imageModel...]")
    return
  }

  if (analysisModel) {
    await syncModel(gateway, analysisModel, "AI_SPLIT_MULTIMODAL", "chat.completions")
    // 同步即切换：应用层要求 AI_SPLIT_MULTIMODAL 启用行恰好一条，停用同类目其余行
    const disabled = await prisma.aiGatewayModel.updateMany({
      where: { category: "AI_SPLIT_MULTIMODAL", publicId: { not: analysisModel } },
      data: { enabled: false },
    })
    if (disabled.count > 0) {
      console.log(`disabled ${disabled.count} other AI_SPLIT_MULTIMODAL rows`)
    }
  }
  for (const publicId of imageModels) {
    await syncModel(gateway, publicId, "AI_SPLIT", "images.generations", fixedCredits)
  }
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
