import { parseArgs } from "node:util"
import { PrismaClient } from "@prisma/client"
import { AiGatewayClient } from "@zhiqingresearch/ai-ts-sdk"
import { prepareTextModels, syncTextModels } from "./chetaidou/text-models.mjs"

const { values: args } = parseArgs({ options: {
  "dry-run": { type: "boolean" }, enable: { type: "boolean" }, multiplier: { type: "string" },
  model: { type: "string" },
} })
const db = new PrismaClient()
try {
  const baseURL = process.env.AI_GATEWAY_BASE_URL?.trim()
  const apiKey = process.env.AI_GATEWAY_API_KEY?.trim()
  if (!baseURL || !apiKey) throw new Error("缺少 AI_GATEWAY_BASE_URL 或 AI_GATEWAY_API_KEY")
  const gateway = new AiGatewayClient({ baseURL, apiKey, timeoutMs: 60_000, getRetry: { maxRetries: 0 } })
  const models = await prepareTextModels(gateway, args.model ? [args.model] : undefined)
  if (args.model) {
    const last = await db.aiGatewayModel.findFirst({
      where: { category: "CHETAIDOU_MULTIMODAL" }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true },
    })
    models[0].sortOrder = last ? last.sortOrder + 1 : 0
  }
  const results = await syncTextModels(db, models, {
    dryRun: !!args["dry-run"], enable: !!args.enable,
    multiplier: args.multiplier === undefined ? undefined : Number(args.multiplier),
  })
  console.log(JSON.stringify({ dryRun: !!args["dry-run"], models: results }, null, 2))
} catch (error) {
  // 不输出 Prisma 原始错误（可能包含连接信息）。
  console.error(error.name?.startsWith("Prisma") ? "模型目录数据库访问失败，请检查连接和权限" : error.message)
  process.exitCode = 1
} finally { await db.$disconnect() }
