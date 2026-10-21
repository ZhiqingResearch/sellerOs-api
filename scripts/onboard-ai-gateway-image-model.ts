import { AiModelExecMode, AiModelModality, Prisma, PrismaClient } from "@prisma/client"
import { AiGatewayClient } from "@zhiqingresearch/ai-ts-sdk"

const prisma = new PrismaClient()

function requiredEnv(key: string) {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${key}`)
  return value
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length)
}

/**
 * 新图片模型上架：按 publicId + category upsert 目录行（拉取网关 detail/requestSchema 快照，enabled=true）。
 * 通用生图下拉（GET /api/image-generation/models）读 modality=IMAGE + category=IMAGE_GENERATION 的行。
 * 用法：npx tsx scripts/onboard-ai-gateway-image-model.ts --publicId=ZQ-Image-1 --category=IMAGE_GENERATION --sortOrder=10 --priceMultiplier=3 --credits=15
 * category 缺省 IMAGE_GENERATION；--credits=固定一口价（积分/张，可 --credits=0 表示清除回落按量）；
 * 配套下架：直接改行 enabled=false（本脚本不动已有行的 enabled=false 状态，重复执行只刷新快照）。
 */
async function main() {
  const publicId = arg("publicId")
  const category = arg("category") ?? "IMAGE_GENERATION"
  const sortOrder = Number(arg("sortOrder") ?? 0)
  const multiplierArg = arg("priceMultiplier")
  const priceMultiplier = multiplierArg != null ? Number(multiplierArg) : undefined
  const creditsArg = arg("credits")
  // fixedCredits 为可空精确小数：传 --credits 落值，--credits=0 显式清空（回落按量）
  const fixedCredits =
    creditsArg != null
      ? creditsArg === "0" || Number(creditsArg) === 0
        ? null
        : Number(creditsArg)
      : undefined
  if (!publicId)
    throw new Error(
      "用法：--publicId=<模型ID> [--category=IMAGE_GENERATION] [--sortOrder=<序号>] [--priceMultiplier=<倍率>] [--credits=<积分/张|0清空>]"
    )
  if (!Number.isInteger(sortOrder)) throw new Error("--sortOrder 需为整数")
  if (priceMultiplier != null && (!Number.isFinite(priceMultiplier) || priceMultiplier <= 0))
    throw new Error("--priceMultiplier 需为正数")
  if (fixedCredits != null && (!Number.isFinite(fixedCredits) || fixedCredits <= 0))
    throw new Error("--credits 需为正数（清空用 --credits=0）")

  const gateway = new AiGatewayClient({
    baseURL: requiredEnv("AI_GATEWAY_BASE_URL"),
    apiKey: requiredEnv("AI_GATEWAY_API_KEY"),
    timeoutMs: 60_000,
    getRetry: { maxRetries: 0 },
  })

  const [detail, requestSchema] = await Promise.all([
    gateway.models.get(publicId),
    gateway.models.requestSchema(publicId, { operation: "images.generations" }),
  ])
  if (detail.modality !== "image")
    throw new Error(`${publicId} 不是图片模型（modality=${detail.modality}）`)

  const existing = await prisma.aiGatewayModel.findUnique({
    where: { publicId_category: { publicId, category } },
    select: { enabled: true },
  })
  const row = await prisma.aiGatewayModel.upsert({
    where: { publicId_category: { publicId, category } },
    create: {
      publicId,
      category,
      displayName: detail.display_name,
      modality: AiModelModality.IMAGE,
      execMode: detail.exec_mode === "sync" ? AiModelExecMode.SYNC : AiModelExecMode.ASYNC,
      gatewayConfig: { detail, requestSchema } as unknown as Prisma.InputJsonValue,
      gatewayActive: true,
      syncedAt: new Date(),
      enabled: true,
      sortOrder,
      ...(priceMultiplier != null ? { priceMultiplier } : {}),
      ...(creditsArg != null ? { fixedCredits } : {}),
    },
    update: {
      displayName: detail.display_name,
      execMode: detail.exec_mode === "sync" ? AiModelExecMode.SYNC : AiModelExecMode.ASYNC,
      gatewayConfig: { detail, requestSchema } as unknown as Prisma.InputJsonValue,
      gatewayActive: true,
      syncedAt: new Date(),
      ...(existing?.enabled === false ? {} : { enabled: true }),
      ...(arg("sortOrder") != null ? { sortOrder } : {}),
      ...(priceMultiplier != null ? { priceMultiplier } : {}),
      ...(creditsArg != null ? { fixedCredits } : {}),
    },
  })
  console.log(
    `onboarded category=${category} publicId=${publicId} sortOrder=${row.sortOrder} priceMultiplier=${row.priceMultiplier.toString()} fixedCredits=${row.fixedCredits?.toString() ?? "null(按量)"} enabled=${row.enabled} schemaVersion=${requestSchema.version}`
  )
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
