import { AiModelExecMode, AiModelModality, Prisma, PrismaClient } from "@prisma/client"
import { AiGatewayClient } from "@zhiqingresearch/ai-ts-sdk"

// LLM 工具箱三件 + 视频分析模型建行脚本（方案 docs/designs/2026-09-22-llm-toolbox-video-analysis-backend-plan.md §7）。
// 模型与定价统一维护在 AiGatewayModel（代码不写死模型名），从网关拉取
// detail/requestSchema/pricing 正确填充，upsert by publicId_category——不做裸 SQL。
//
// 用法（幂等，可重复执行；需 AI_GATEWAY_BASE_URL / AI_GATEWAY_API_KEY）：
//   npx tsx scripts/onboard-llm-toolbox-models.ts --category LLM_TOOLBOX ZQ-Think-Flash=2
//   npx tsx scripts/onboard-llm-toolbox-models.ts --category LLM_TOOLBOX_MULTIMODAL ZQ-Multimodal-Gemini-3.1-Pro=2
//   npx tsx scripts/onboard-llm-toolbox-models.ts --category VIDEO_ANALYSIS \
//     ZQ-Multimodal-Gemini-3.5-Flash-Lite=5 --sort 1 --audio --mime --json --video-guard
//   npx tsx scripts/onboard-llm-toolbox-models.ts --category VIDEO_ANALYSIS \
//     ZQ-Multimodal-Gemini-3.7-Flash=5 --audio --mime
//   npx tsx scripts/onboard-llm-toolbox-models.ts --category VIDEO_ANALYSIS \
//     ZQ-Multimodal-Qwen-3.7-Plus=10 --json --video-guard
//
// 定价基线（2026-09-22 定价表，模型名已按网关目录核对）：
//   三件套 2 积分/次——润色/互译 ZQ-Think-Flash（display「Gemini 3.1 Flash Lite」，成本 ≤0.003）、
//   由图推理 ZQ-Multimodal-Gemini-3.1-Pro（display「Atlas 多模态理解」，成本 ≤0.02）；
//   视频分析 5/5/10——成本 3.5-flash-lite ≤0.04、3.7-flash ≤0.07、Qwen-3.7-plus ≤0.25。
//   注意：定价表里的「Gemini-3.1-flash-lite / Gemini-3.1-Pro」是显示名简称，网关 publicId 以本注释为准。
//
// 单槽类目（LLM_TOOLBOX / LLM_TOOLBOX_MULTIMODAL）：同类别只允许一条启用行，
// 本脚本建行后自动停用同类别其余行——换模型 = 用新 publicId 再跑一次本脚本。
// 视频能力开关（仅 VIDEO_ANALYSIS，写入 gatewayConfig.videoAnalysis）：
//   --audio        supportsAudio（可分析音频；Qwen 不加）
//   --mime         sendsMimeType（Gemini 系需发 mime_type；Qwen 不加）
//   --json         supportsJsonMode（支持 response_format json_object；3.7-Flash 不加）
//   --video-guard  promptTokensIncludeVideo（启用「模型没收到视频」守卫；3.7-Flash 不加）
// --sort N 可选（默认 0）：VIDEO_ANALYSIS 多行白名单按 sortOrder 升序，**最小者为默认模型**，
//   同值会导致默认模型漂移——多行建行时务必给不同的 --sort。
// 位置参数为 <publicId>=<fixedCredits 积分/次>；调价改库即生效，也可用
// scripts/set-image-model-credits.ts（category 通用）单独调。
// 建行必须先于功能发布：缺行 = 接口 503 fail-closed（方案 R6）。
const prisma = new PrismaClient()

const CATEGORIES = ["LLM_TOOLBOX", "LLM_TOOLBOX_MULTIMODAL", "VIDEO_ANALYSIS"] as const
type Category = (typeof CATEGORIES)[number]

const SINGLE_SLOT_CATEGORIES: ReadonlySet<string> = new Set([
  "LLM_TOOLBOX",
  "LLM_TOOLBOX_MULTIMODAL",
])

interface VideoCapabilityFlags {
  supportsAudio: boolean
  sendsMimeType: boolean
  supportsJsonMode: boolean
  promptTokensIncludeVideo: boolean
}

function requiredEnv(key: string) {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${key}`)
  return value
}

async function syncModel(
  gateway: AiGatewayClient,
  publicId: string,
  category: Category,
  fixedCredits: number,
  sortOrder: number,
  videoCaps: VideoCapabilityFlags | null
) {
  const [detail, requestSchema, pricing] = await Promise.all([
    gateway.models.get(publicId),
    gateway.models.requestSchema(publicId, { operation: "chat.completions" }),
    gateway.models.pricing(publicId, { operation: "chat.completions" }),
  ])
  // 本脚本管理的全是 chat.completions 的同步文本/多模态模型（TEXT 行不会被后台
  // maybeRefreshModels 覆盖，与 AI_SPLIT_MULTIMODAL 同待遇）
  if (detail.modality !== "text" || detail.exec_mode !== "sync") {
    throw new Error(
      `${publicId} 不是同步文本/多模态模型（modality=${detail.modality} exec_mode=${detail.exec_mode}）`
    )
  }

  const gatewayConfig: Record<string, unknown> = { detail, requestSchema }
  if (videoCaps) gatewayConfig.videoAnalysis = videoCaps

  await prisma.aiGatewayModel.upsert({
    where: { publicId_category: { publicId, category } },
    update: {
      displayName: detail.display_name,
      modality: AiModelModality.TEXT,
      execMode: AiModelExecMode.SYNC,
      gatewayConfig: gatewayConfig as unknown as Prisma.InputJsonValue,
      quoteConfig: pricing as unknown as Prisma.InputJsonValue,
      gatewayActive: true,
      syncedAt: new Date(),
      enabled: true,
      fixedCredits,
    },
    create: {
      publicId,
      category,
      displayName: detail.display_name,
      modality: AiModelModality.TEXT,
      execMode: AiModelExecMode.SYNC,
      gatewayConfig: gatewayConfig as unknown as Prisma.InputJsonValue,
      quoteConfig: pricing as unknown as Prisma.InputJsonValue,
      gatewayActive: true,
      syncedAt: new Date(),
      enabled: true,
      sortOrder: 0,
      fixedCredits,
    },
  })
  console.log(
    `synced category=${category} publicId=${publicId} fixedCredits=${fixedCredits}` +
      (videoCaps ? ` caps=${JSON.stringify(videoCaps)}` : "") +
      ` schemaVersion=${requestSchema.version}`
  )

  // 单槽类目：启用新行后停用其余行（换模型语义；VIDEO_ANALYSIS 是多行白名单，不停用）
  if (SINGLE_SLOT_CATEGORIES.has(category)) {
    const disabled = await prisma.aiGatewayModel.updateMany({
      where: { category, publicId: { not: publicId } },
      data: { enabled: false },
    })
    if (disabled.count > 0) {
      console.log(`disabled ${disabled.count} other ${category} rows (single-slot switch)`)
    }
  }
}

async function main() {
  const gateway = new AiGatewayClient({
    baseURL: requiredEnv("AI_GATEWAY_BASE_URL"),
    apiKey: requiredEnv("AI_GATEWAY_API_KEY"),
    timeoutMs: 60_000,
    getRetry: { maxRetries: 0 },
  })

  const args = process.argv.slice(2)
  const categoryIndex = args.indexOf("--category")
  const category = categoryIndex >= 0 ? args[categoryIndex + 1]?.trim() : undefined
  if (!category || !CATEGORIES.includes(category as Category)) {
    throw new Error(`--category 必须是 ${CATEGORIES.join(" | ")}`)
  }
  const sortIndex = args.indexOf("--sort")
  const sortRaw = sortIndex >= 0 ? args[sortIndex + 1]?.trim() : undefined
  const sortOrder = sortRaw !== undefined ? Number(sortRaw) : 0
  if (sortIndex >= 0 && (!Number.isSafeInteger(sortOrder) || sortOrder < 0)) {
    throw new Error("--sort 需要跟非负整数（VIDEO_ANALYSIS 多行时最小者为默认模型）")
  }

  const flagSet = new Set(["--audio", "--mime", "--json", "--video-guard"])
  const hasFlags = args.some(value => flagSet.has(value))
  if (category !== "VIDEO_ANALYSIS" && hasFlags) {
    throw new Error("能力开关（--audio/--mime/--json/--video-guard）仅适用于 VIDEO_ANALYSIS")
  }
  const videoCaps: VideoCapabilityFlags | null =
    category === "VIDEO_ANALYSIS"
      ? {
          supportsAudio: args.includes("--audio"),
          sendsMimeType: args.includes("--mime"),
          supportsJsonMode: args.includes("--json"),
          promptTokensIncludeVideo: args.includes("--video-guard"),
        }
      : null

  const skipIndexes = new Set<number>()
  for (const flagIndex of [categoryIndex, sortIndex]) {
    if (flagIndex >= 0) {
      skipIndexes.add(flagIndex)
      skipIndexes.add(flagIndex + 1)
    }
  }
  const entries = args
    .filter((_, index) => !skipIndexes.has(index))
    .map(value => value.trim())
    .filter(value => value && !flagSet.has(value))
    .map(value => {
      const separator = value.lastIndexOf("=")
      if (separator <= 0) throw new Error(`参数格式应为 <publicId>=<积分/次>，收到：${value}`)
      const publicId = value.slice(0, separator)
      const credits = Number(value.slice(separator + 1))
      if (!Number.isFinite(credits) || credits <= 0) {
        throw new Error(`积分必须为正数，收到：${value}`)
      }
      return { publicId, credits }
    })
  if (entries.length === 0) {
    console.log(
      "未指定任何模型。用法：onboard-llm-toolbox-models.ts --category <LLM_TOOLBOX|LLM_TOOLBOX_MULTIMODAL|VIDEO_ANALYSIS> [--audio] [--mime] [--json] [--video-guard] <publicId>=<积分/次>..."
    )
    return
  }

  for (const entry of entries) {
    await syncModel(
      gateway,
      entry.publicId,
      category as Category,
      entry.credits,
      sortOrder,
      videoCaps
    )
  }
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
