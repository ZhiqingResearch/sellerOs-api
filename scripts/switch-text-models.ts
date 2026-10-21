import { AiGatewayModel, Prisma, PrismaClient } from "@prisma/client"
import { AiGatewayClient } from "@zhiqingresearch/ai-ts-sdk"

// npm run switch:text-models -- --dry-run；去掉 --dry-run 正式执行，可重复运行。
// 只切换 AiGatewayModel 的 TEXT 目录；旧行保留并停用，不修改业务代码和历史记录。
// 新模型统一按网关实际账单配置：倍率 1、无一口价，重复执行也会清除已有加价。
export const QWEN = "qwen3.8-max"
export const MINIMAX = "MiniMax-M3"
const MODELS = [QWEN, MINIMAX]
const SINGLE_SLOTS: Record<string, string> = {
  CHETAIDOU_BREAKDOWN: QWEN,
  AI_SPLIT_MULTIMODAL: QWEN,
  LLM_TOOLBOX: MINIMAX,
  LLM_TOOLBOX_MULTIMODAL: QWEN,
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

export async function prepareModels(gateway: AiGatewayClient) {
  return Promise.all(
    MODELS.map(async publicId => {
      const [detail, requestSchema, pricing] = await Promise.all([
        gateway.models.get(publicId),
        gateway.models.requestSchema(publicId, { operation: "chat.completions" }),
        gateway.models.pricing(publicId, { operation: "chat.completions" }),
      ])
      if (
        detail.id !== publicId ||
        detail.modality !== "text" ||
        detail.exec_mode !== "sync" ||
        !detail.display_name?.trim()
      ) {
        throw new Error(`${publicId} 不是有效的同步文本模型`)
      }
      if (
        requestSchema.model !== publicId ||
        requestSchema.operation !== "chat.completions" ||
        !requestSchema.request_schema
      ) {
        throw new Error(`${publicId} 缺少 chat.completions 请求 Schema`)
      }
      if (
        pricing.model !== publicId ||
        !pricing.operations.some(op => op.operation === "chat.completions" && op.rates.length > 0)
      ) {
        throw new Error(`${publicId} 缺少 chat.completions 定价`)
      }
      return { publicId, detail, requestSchema, pricing }
    })
  )
}

type PreparedModels = Awaited<ReturnType<typeof prepareModels>>

export function planGatewayRows(rows: AiGatewayModel[], models: PreparedModels) {
  const categories = [
    ...new Set([...rows.map(row => row.category), ...Object.keys(SINGLE_SLOTS)]),
  ].sort()
  return categories.flatMap(category => {
    const targets = SINGLE_SLOTS[category] ? [SINGLE_SLOTS[category]] : MODELS
    return targets.map((publicId, sortOrder) => {
      const model = models.find(item => item.publicId === publicId)!
      const facts = model.detail.facts as Record<string, unknown>
      if (
        (category.includes("MULTIMODAL") || category === "CHETAIDOU_BREAKDOWN" || category === "VIDEO_ANALYSIS") &&
        facts.vision !== true
      ) {
        throw new Error(`${publicId} 未声明视觉能力，不能用于 ${category}`)
      }
      const gatewayConfig = {
        detail: model.detail,
        requestSchema: model.requestSchema,
        ...(category === "VIDEO_ANALYSIS"
          ? {
              // 两个新模型走百炼视频输入；不沿用 Gemini 音频/MIME 和专有 token 守卫。
              videoAnalysis: {
                supportsAudio: false,
                sendsMimeType: false,
                supportsJsonMode: facts.jsonMode === true,
                promptTokensIncludeVideo: false,
              },
            }
          : {}),
      }
      return {
        data: {
          publicId,
          category,
          displayName: model.detail.display_name,
          modality: "TEXT" as const,
          execMode: "SYNC" as const,
          gatewayConfig: json(gatewayConfig),
          quoteConfig: json(model.pricing),
          priceMultiplier: 1,
          fixedCredits: null,
          enabled: true,
          gatewayActive: true,
          syncedAt: new Date(),
          sortOrder,
        },
      }
    })
  })
}

export async function switchTextModels(db: PrismaClient, models: PreparedModels, dryRun = false) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const rows = await tx.aiGatewayModel.findMany({
      where: { modality: "TEXT" },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    })
    const plan = planGatewayRows(rows, models)
    const summary = {
      dryRun,
      warnings: [
        "当前工具箱与视频分析代码要求有效一口价；清空后会返回 503，需另行适配实际账单计费。本脚本只改目录。",
      ],
      categories: plan.map(({ data }) => ({
        category: data.category,
        model: data.publicId,
        multiplier: String(data.priceMultiplier),
        fixedCredits: data.fixedCredits,
      })),
      disable: rows
        .filter(
          row =>
            row.enabled &&
            !plan.some(
              item => item.data.category === row.category && item.data.publicId === row.publicId
            )
        )
        .map(row => ({ category: row.category, model: row.publicId })),
    }
    if (dryRun) return summary
    for (const { data } of plan) {
      await tx.aiGatewayModel.upsert({
        where: { publicId_category: { publicId: data.publicId, category: data.category } },
        create: data,
        update: data,
      })
    }
    for (const category of new Set(plan.map(item => item.data.category))) {
      await tx.aiGatewayModel.updateMany({
        where: {
          category,
          modality: "TEXT",
          publicId: {
            notIn: plan
              .filter(item => item.data.category === category)
              .map(item => item.data.publicId),
          },
        },
        data: { enabled: false },
      })
    }
    const after = await tx.aiGatewayModel.findMany({ where: { modality: "TEXT", enabled: true } })
    if (
      after.length !== plan.length ||
      after.some(
        row =>
          !row.gatewayActive ||
          Number(row.priceMultiplier) !== 1 ||
          row.fixedCredits !== null ||
          !plan.some(
            item => item.data.category === row.category && item.data.publicId === row.publicId
          )
      )
    ) {
      throw new Error("切换后模型校验失败，已回滚")
    }
    return summary
  }
  return dryRun ? execute(db) : db.$transaction(execute, { timeout: 60_000 })
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== "--dry-run"))
    throw new Error("用法：npm run switch:text-models -- [--dry-run]")
  const baseURL = process.env.AI_GATEWAY_BASE_URL?.trim()
  const apiKey = process.env.AI_GATEWAY_API_KEY?.trim()
  if (!baseURL || !apiKey) throw new Error("缺少 AI_GATEWAY_BASE_URL 或 AI_GATEWAY_API_KEY")
  const models = await prepareModels(
    new AiGatewayClient({ baseURL, apiKey, timeoutMs: 60_000, getRetry: { maxRetries: 0 } })
  )
  const db = new PrismaClient()
  try {
    console.log(
      JSON.stringify(await switchTextModels(db, models, args.includes("--dry-run")), null, 2)
    )
  } finally {
    await db.$disconnect()
  }
}

if (require.main === module)
  void main().catch((error: Error) => {
    console.error(
      error.name.startsWith("Prisma") ? "模型切换数据库访问失败，请检查连接和权限" : error.message
    )
    process.exitCode = 1
  })
