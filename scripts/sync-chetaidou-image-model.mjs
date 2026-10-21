import { parseArgs } from "node:util"
import { PrismaClient } from "@prisma/client"
import { AiGatewayClient } from "@zhiqingresearch/ai-ts-sdk"
import { registerImageModel } from "./chetaidou/image-models.mjs"

const { values: args } = parseArgs({ options: {
  model: { type: "string", default: "ZQ-Image-1" }, apply: { type: "boolean" }, enable: { type: "boolean" }, help: { type: "boolean" },
} })
if (args.help) {
  console.log("预览：node --env-file-if-exists=.env scripts/sync-chetaidou-image-model.mjs\n执行新增可选项：加 --apply --enable；已有行只同步元数据，不改价格、启停或排序。")
} else {
  const db = new PrismaClient()
  try {
    const baseURL = process.env.AI_GATEWAY_BASE_URL?.trim(), apiKey = process.env.AI_GATEWAY_API_KEY?.trim()
    if (!baseURL || !apiKey) throw new Error("缺少网关配置")
    const gateway = new AiGatewayClient({ baseURL, apiKey, timeoutMs: 30000, getRetry: { maxRetries: 0 } })
    console.log(JSON.stringify(await registerImageModel(db, gateway, { publicId: args.model, enable: !!args.enable, dryRun: !args.apply })))
  } catch (error) {
    console.error(error.name?.startsWith("Prisma") ? "模型目录数据库访问失败" : "模型元数据登记失败，请检查配置和通道能力")
    process.exitCode = 1
  } finally { await db.$disconnect() }
}
