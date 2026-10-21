import { AiModelExecMode, AiModelModality, Prisma, PrismaClient } from "@prisma/client"
import { AiGatewayClient, GatewayApiError } from "@zhiqingresearch/ai-ts-sdk"

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

/** 布尔开关：支持 --flag 或 --flag=true */
function flag(name: string): boolean {
  return process.argv.some(a => a === `--${name}` || a === `--${name}=true`)
}

function execMode(value: "sync" | "async"): AiModelExecMode {
  return value === "sync" ? AiModelExecMode.SYNC : AiModelExecMode.ASYNC
}

type ModalitySpec = {
  modality: AiModelModality
  /** 网关 detail.modality 返回的模态字符串（与目录枚举同值） */
  gatewayModality: "video" | "image" | "text"
  /** 拉 requestSchema / pricing 时使用的 operation */
  operation: "videos.generations" | "images.generations" | "chat.completions"
  /**
   * 是否同步 quoteConfig（pricing 快照）。
   * 视频价格按 estimateVideoPrice 动态计算、quoteConfig 不作为报价来源，故与既有视频同步脚本一致不覆盖；
   * 图片 / 文本为静态定价，覆盖 quoteConfig。
   */
  syncPricing: boolean
}

const MODALITY_SPECS: Record<"video" | "image" | "text", ModalitySpec> = {
  video: {
    modality: AiModelModality.VIDEO,
    gatewayModality: "video",
    operation: "videos.generations",
    syncPricing: false,
  },
  image: {
    modality: AiModelModality.IMAGE,
    gatewayModality: "image",
    operation: "images.generations",
    syncPricing: true,
  },
  text: {
    modality: AiModelModality.TEXT,
    gatewayModality: "text",
    operation: "chat.completions",
    syncPricing: true,
  },
}

/**
 * AI Gateway 模型目录统一同步：刷新本地已存在的视频 / 图片 / 文本模型行快照
 * （displayName / execMode / gatewayConfig，图片&文本另刷 quoteConfig）。
 *
 * 只 update 不 create：新模型上架仍需人工建行（走 onboard-ai-gateway-video-model.ts 或 sync-ai-split-models.ts），
 * 避免未接入的业务能力直接对前端可见；网关侧已下架（404）的行置 gatewayActive=false（findAll 据此隐藏）。
 *
 * 用法：
 *   npm run sync:ai-gateway-models                       # 同步全部模态（video + image + text）
 *   npm run sync:ai-gateway-models -- --modality=video   # 仅视频（别名：视频）
 *   npm run sync:ai-gateway-models -- --modality=image   # 仅图片（别名：图像 / 图片）
 *   npm run sync:ai-gateway-models -- --modality=text    # 仅文本（别名：文本）
 *   npm run sync:ai-gateway-models -- --modality=image,video   # 多选（逗号 / 顿号分隔）
 *   npm run sync:ai-gateway-models -- --modality=all     # 显式全部（等价于不传）
 *   npm run sync:ai-gateway-models -- --publicId=xxx     # 单独同步某一个：只同步匹配该 publicId 的行
 *   npm run sync:ai-gateway-models -- --dry-run          # 预览：拉网关对比但不写库，仅打印将发生的变更
 */

/** 模态别名（含中文）归一到内部 key */
const MODALITY_ALIASES: Record<string, "video" | "image" | "text"> = {
  video: "video",
  视频: "video",
  image: "image",
  图片: "image",
  图像: "image",
  text: "text",
  文本: "text",
  文字: "text",
}

/** 解析 --modality：支持 all、单值、逗号/顿号多选、中文别名，去重保序 */
function parseModalities(raw: string): ("video" | "image" | "text")[] {
  const tokens = raw
    .split(/[,，、\s]+/)
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
  if (!tokens.length || tokens.includes("all")) return ["video", "image", "text"]

  const result: ("video" | "image" | "text")[] = []
  for (const token of tokens) {
    const key = MODALITY_ALIASES[token]
    if (!key) {
      throw new Error(
        `无法识别的模态「${token}」。可选：video/视频、image/图像/图片、text/文本、all，或用逗号组合`
      )
    }
    if (!result.includes(key)) result.push(key)
  }
  return result
}

async function syncModality(
  gateway: AiGatewayClient,
  spec: ModalitySpec,
  opts: { publicIdFilter?: string; dryRun: boolean }
) {
  const { publicIdFilter, dryRun } = opts
  const tag = dryRun ? "[dry-run] " : ""
  const rows = await prisma.aiGatewayModel.findMany({
    where: {
      modality: spec.modality,
      ...(publicIdFilter ? { publicId: publicIdFilter } : {}),
    },
    select: { publicId: true, category: true, displayName: true, execMode: true },
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
  })
  if (!rows.length) {
    console.log(
      `[${spec.gatewayModality}] 本地无匹配目录行${publicIdFilter ? `（publicId=${publicIdFilter}）` : ""}，跳过`
    )
    return { synced: 0, total: 0 }
  }

  let synced = 0
  for (const row of rows) {
    let detail, requestSchema
    try {
      ;[detail, requestSchema] = await Promise.all([
        gateway.models.get(row.publicId),
        gateway.models.requestSchema(row.publicId, { operation: spec.operation }),
      ])
    } catch (error) {
      if (error instanceof GatewayApiError && error.status === 404) {
        if (!dryRun) {
          await prisma.aiGatewayModel.update({
            where: { publicId_category: { publicId: row.publicId, category: row.category } },
            data: { gatewayActive: false, syncedAt: new Date() },
          })
        }
        console.warn(
          `${tag}deactivate modality=${spec.gatewayModality} category=${row.category} publicId=${row.publicId}（网关已下架，置 gatewayActive=false）`
        )
        continue
      }
      throw error
    }

    if (detail.modality !== spec.gatewayModality) {
      console.warn(
        `${tag}skip publicId=${row.publicId}：网关返回 modality=${detail.modality}，与目录 ${spec.gatewayModality} 不符`
      )
      continue
    }

    // 图片 / 文本静态定价：拉 pricing 刷新 quoteConfig；拉取失败不阻断，仅保留原快照
    let quoteConfig: Prisma.InputJsonValue | undefined
    if (spec.syncPricing) {
      try {
        const pricing = await gateway.models.pricing(row.publicId, { operation: spec.operation })
        quoteConfig = pricing as unknown as Prisma.InputJsonValue
      } catch (error) {
        console.warn(
          `pricing 拉取失败 publicId=${row.publicId}，保留原 quoteConfig：${(error as Error).message}`
        )
      }
    }

    const nextExecMode = execMode(detail.exec_mode)
    const changes: string[] = []
    if (detail.display_name !== row.displayName) {
      changes.push(`displayName: ${row.displayName} -> ${detail.display_name}`)
    }
    if (nextExecMode !== row.execMode) {
      changes.push(`execMode: ${row.execMode} -> ${nextExecMode}`)
    }
    if (quoteConfig != null) changes.push("quoteConfig 刷新")
    const summary = changes.length ? changes.join("；") : "仅刷新快照/时间戳"

    if (!dryRun) {
      await prisma.aiGatewayModel.update({
        where: { publicId_category: { publicId: row.publicId, category: row.category } },
        data: {
          displayName: detail.display_name,
          modality: spec.modality,
          execMode: nextExecMode,
          gatewayConfig: { detail, requestSchema } as unknown as Prisma.InputJsonValue,
          ...(quoteConfig != null ? { quoteConfig } : {}),
          gatewayActive: true,
          syncedAt: new Date(),
        },
      })
    }
    synced++
    console.log(
      `${tag}sync modality=${spec.gatewayModality} category=${row.category} publicId=${row.publicId} schemaVersion=${requestSchema.version}（${summary}）`
    )
  }
  return { synced, total: rows.length }
}

async function main() {
  const publicIdFilter = arg("publicId")?.trim() || undefined
  const dryRun = flag("dry-run")
  const specs: ModalitySpec[] = parseModalities(arg("modality") ?? "all").map(
    key => MODALITY_SPECS[key]
  )

  if (dryRun) console.log("== DRY-RUN：仅预览，不写库 ==")

  const gateway = new AiGatewayClient({
    baseURL: requiredEnv("AI_GATEWAY_BASE_URL"),
    apiKey: requiredEnv("AI_GATEWAY_API_KEY"),
    timeoutMs: 60_000,
    getRetry: { maxRetries: 0 },
  })

  let totalSynced = 0
  let totalRows = 0
  for (const spec of specs) {
    const { synced, total } = await syncModality(gateway, spec, { publicIdFilter, dryRun })
    totalSynced += synced
    totalRows += total
  }
  console.log(
    `${dryRun ? "[dry-run] " : ""}done：${dryRun ? "将同步" : "共同步"} ${totalSynced}/${totalRows} 行（模态 ${specs.map(s => s.gatewayModality).join(", ")}）`
  )
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
