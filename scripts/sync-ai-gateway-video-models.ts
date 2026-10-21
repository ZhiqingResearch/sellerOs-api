import { AiModelExecMode, AiModelModality, Prisma, PrismaClient } from "@prisma/client"
import { AiGatewayClient, GatewayApiError } from "@zhiqingresearch/ai-ts-sdk"

const prisma = new PrismaClient()

function requiredEnv(key: string) {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${key}`)
  return value
}

function execMode(value: "sync" | "async"): AiModelExecMode {
  return value === "sync" ? AiModelExecMode.SYNC : AiModelExecMode.ASYNC
}

/**
 * 刷新本地已存在的视频模型目录行（displayName / gatewayConfig / quoteConfig 快照）。
 * 只 update 不 create：新模型上架需人工补行，避免未接入的业务能力直接对前端可见。
 * 网关侧已下架（404）的模型置 gatewayActive=false（findAll 据此隐藏），其余行继续同步。
 */
async function main() {
  const gateway = new AiGatewayClient({
    baseURL: requiredEnv("AI_GATEWAY_BASE_URL"),
    apiKey: requiredEnv("AI_GATEWAY_API_KEY"),
    timeoutMs: 60_000,
    getRetry: { maxRetries: 0 },
  })

  const rows = await prisma.aiGatewayModel.findMany({
    where: { modality: AiModelModality.VIDEO },
    select: { publicId: true, category: true, displayName: true },
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
  })
  if (!rows.length) throw new Error("本地没有视频模型目录行，请先按迁移文档人工建行")

  for (const row of rows) {
    let detail, requestSchema
    try {
      ;[detail, requestSchema] = await Promise.all([
        gateway.models.get(row.publicId),
        gateway.models.requestSchema(row.publicId, { operation: "videos.generations" }),
      ])
    } catch (error) {
      if (error instanceof GatewayApiError && error.status === 404) {
        await prisma.aiGatewayModel.update({
          where: { publicId_category: { publicId: row.publicId, category: row.category } },
          data: { gatewayActive: false, syncedAt: new Date() },
        })
        console.warn(`deactivated category=${row.category} publicId=${row.publicId}（网关已下架）`)
        continue
      }
      throw error
    }
    if (detail.modality !== "video") {
      throw new Error(`${row.publicId} 不是视频模型`)
    }

    const renamed = detail.display_name !== row.displayName
    await prisma.aiGatewayModel.update({
      where: { publicId_category: { publicId: row.publicId, category: row.category } },
      data: {
        displayName: detail.display_name,
        modality: AiModelModality.VIDEO,
        execMode: execMode(detail.exec_mode),
        gatewayConfig: { detail, requestSchema } as unknown as Prisma.InputJsonValue,
        gatewayActive: true,
        syncedAt: new Date(),
      },
    })
    console.log(
      `synced category=${row.category} publicId=${row.publicId} schemaVersion=${requestSchema.version}${renamed ? ` displayName: ${row.displayName} -> ${detail.display_name}` : ""}`
    )
  }
}

main()
  .catch(error => {
    if (error instanceof GatewayApiError) {
      console.error(`AI Gateway 同步失败 status=${error.status}: ${error.message}`)
    } else {
      console.error(error instanceof Error ? error.message : error)
    }
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
