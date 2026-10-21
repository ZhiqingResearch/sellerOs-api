import { Module } from "@nestjs/common"
import { ConfigModule, ConfigService } from "@nestjs/config"
import { NestFactory } from "@nestjs/core"
import { ProductPublishRpaLogStatus } from "@prisma/client"
import { setTimeout as delay } from "node:timers/promises"
import { YingdaoProvider } from "../src/common/providers/yingdao.provider"
import { ZixiaoyunProvider } from "../src/common/providers/zixiaoyun.provider"
import { PrismaService } from "../src/prisma/prisma.service"
import { ProductPublishEventsService } from "../src/product-publish/product-publish-events.service"
import { ProductPublishRpaService } from "../src/product-publish/product-publish-rpa.service"
import { ProductPublishService } from "../src/product-publish/product-publish.service"
import { SpacesService } from "../src/spaces/spaces.service"

/**
 * 一次性强制同步全部启用 Amazon 店铺的全部分类模板。
 *
 * 完整流程：
 * 1. 查询全部启用 Amazon 店铺 × 店铺分类映射；
 * 2. 为每个店铺分类建立数据库状态锁和 RPA 审计记录；
 * 3. 逐条上传 download_listing 参数文件并调起影刀脚本；
 * 4. 等待各个 RPA POST /api/product-publish/internal/rpa/results；
 * 5. 回调服务将 templateUrl 写入数据库；
 * 6. 所有请求结束后，统一输出每个店铺、分类及模板链接或错误。
 *
 * 与每日 Cron 的区别：本脚本忽略最近同步时间，逐条串行强制执行全部目标；已有
 * 未结束的 download_listing 会先终结旧审计并释放锁，然后重新调度。若旧回调正在
 * 写库，脚本会等待该事务结束后继续，任何分类都不会因为旧请求而被跳过。
 *
 * 前置条件：
 * - 数据库已完成一键上架相关迁移，店铺及分类映射已经初始化；
 * - .env 已配置数据库和影刀相关环境变量；
 * - 正式后端回调接口正在运行，并且 RPA 能访问该接口；
 * - RPA 回调携带的 X-API-Key 与服务端配置一致。
 *
 * 数据影响：更新全部目标 ProductPublishStoreClassification，新增一条
 * ProductPublishRpaRun 和每个店铺分类对应的 ProductPublishRpaLog。
 */
const DEFAULT_WAIT_SECONDS = 4_200
const POLL_INTERVAL_MS = 2_000

interface ScriptArgs {
  waitSeconds?: number
}

interface TemplateSyncResult {
  requestId: string | null
  businessId: string | null
  storeName: string | null
  category: string | null
  status: ProductPublishRpaLogStatus
  templateUrl: string | null
  errorMessage: string | null
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [
    PrismaService,
    YingdaoProvider,
    ZixiaoyunProvider,
    SpacesService,
    ProductPublishService,
    ProductPublishEventsService,
    ProductPublishRpaService,
  ],
})
// 只装配本脚本需要的服务，不启动 HTTP Server，也不注册生产 Cron。
class TemplateSyncScriptModule {}

function usage(): string {
  return [
    "用法：",
    "  npm run sync:product-publish-templates -- [--wait-seconds <秒>]",
    "",
    "示例：",
    "  npm run sync:product-publish-templates -- --wait-seconds 4200",
  ].join("\n")
}

function parseArgs(argv: string[]): ScriptArgs | null {
  if (argv.includes("--help") || argv.includes("-h")) return null
  if (argv.length === 0) return {}
  if (argv.length !== 2 || argv[0] !== "--wait-seconds" || !argv[1]) {
    throw new Error(`参数格式错误\n\n${usage()}`)
  }

  const waitSeconds = Number(argv[1])
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds <= 0 || waitSeconds > 86_400) {
    throw new Error("--wait-seconds 必须是 1 到 86400 之间的整数")
  }
  return { waitSeconds }
}

function configuredWaitSeconds(config: ConfigService, override?: number): number {
  if (override !== undefined) return override
  const value = Number(
    config.get<string>(
      "YINGDAO_PRODUCT_PUBLISH_CALLBACK_TIMEOUT_SECONDS",
      String(DEFAULT_WAIT_SECONDS)
    )
  )
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_WAIT_SECONDS
}

async function readRunResults(prisma: PrismaService, runId: number): Promise<TemplateSyncResult[]> {
  const logs = await prisma.productPublishRpaLog.findMany({
    where: { runId },
    select: {
      requestId: true,
      storeId: true,
      classification: true,
      status: true,
      errorMessage: true,
      store: { select: { externalStoreId: true, name: true } },
    },
    orderBy: [{ storeId: "asc" }, { classification: "asc" }],
  })
  const targets = logs.flatMap(log =>
    log.storeId !== null && log.classification
      ? [{ storeId: log.storeId, classification: log.classification }]
      : []
  )
  const templates = targets.length
    ? await prisma.productPublishStoreClassification.findMany({
        where: { OR: targets },
        select: { storeId: true, classification: true, templateUrl: true },
      })
    : []
  const templateUrls = new Map(
    templates.map(template => [
      `${template.storeId}:${template.classification}`,
      template.templateUrl,
    ])
  )

  return logs.map(log => ({
    requestId: log.requestId,
    businessId: log.store?.externalStoreId ?? null,
    storeName: log.store?.name ?? null,
    category: log.classification,
    status: log.status,
    templateUrl:
      log.status === ProductPublishRpaLogStatus.SUCCESS &&
      log.storeId !== null &&
      log.classification
        ? (templateUrls.get(`${log.storeId}:${log.classification}`) ?? null)
        : null,
    errorMessage: log.errorMessage,
  }))
}

async function waitForAllTemplates(
  prisma: PrismaService,
  runId: number,
  expectedCount: number,
  waitSeconds: number
): Promise<TemplateSyncResult[]> {
  const deadline = Date.now() + waitSeconds * 1_000
  const terminalStatuses: ProductPublishRpaLogStatus[] = [
    ProductPublishRpaLogStatus.SUCCESS,
    ProductPublishRpaLogStatus.FAILED,
    ProductPublishRpaLogStatus.TIMEOUT,
  ]
  let lastProgress = ""

  // 影刀 startTask 只代表脚本已启动，所有模板链接必须等待 RPA 回调落库后再读取。
  while (Date.now() <= deadline) {
    const [logCount, pendingCount] = await Promise.all([
      prisma.productPublishRpaLog.count({ where: { runId } }),
      prisma.productPublishRpaLog.count({
        where: { runId, status: { notIn: terminalStatuses } },
      }),
    ])
    const progress = `${logCount - pendingCount}/${expectedCount}`
    if (progress !== lastProgress) {
      console.log(`[RPA 回调进度] 已完成 ${progress}，等待中 ${pendingCount}`)
      lastProgress = progress
    }
    if (logCount === expectedCount && pendingCount === 0) {
      return readRunResults(prisma, runId)
    }
    await delay(POLL_INTERVAL_MS)
  }

  throw new Error(
    `等待 RPA 回调超过 ${waitSeconds} 秒；请求仍保留在数据库中，可根据 runId=${runId} 继续排查`
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    console.log(usage())
    return
  }

  const app = await NestFactory.createApplicationContext(TemplateSyncScriptModule, {
    logger: ["error", "warn", "log"],
  })
  try {
    const config = app.get(ConfigService)
    const prisma = app.get(PrismaService)
    const rpaService = app.get(ProductPublishRpaService)
    const waitSeconds = configuredWaitSeconds(config, args.waitSeconds)
    const targetCount = await prisma.productPublishStoreClassification.count({
      where: { store: { disabled: false, platform: "AMAZON" } },
    })
    console.log(`准备强制同步全部店铺模板，共 ${targetCount} 个店铺分类。`)

    // 强制调度全部启用店铺的全部分类，并复用正式回调状态和审计日志。
    const dispatched = await rpaService.refreshAllTemplatesOnce()
    if (dispatched.total === 0) throw new Error("没有可同步的启用 Amazon 店铺分类")

    console.log("全部 download_listing 请求已完成逐条调度：")
    console.log(JSON.stringify(dispatched, null, 2))

    const expectedCount = dispatched.total - dispatched.skipped
    console.log(`正在等待 ${expectedCount} 个 RPA 结果，最长等待 ${waitSeconds} 秒……`)
    const results = await waitForAllTemplates(prisma, dispatched.runId, expectedCount, waitSeconds)
    const successCount = results.filter(
      result => result.status === ProductPublishRpaLogStatus.SUCCESS && result.templateUrl
    ).length
    const failedCount = results.length - successCount

    console.log("全部店铺模板同步结果：")
    console.log(
      JSON.stringify(
        {
          runId: dispatched.runId,
          total: dispatched.total,
          dispatched: expectedCount,
          skipped: dispatched.skipped,
          success: successCount,
          failed: failedCount,
          results,
        },
        null,
        2
      )
    )
    if (failedCount > 0) {
      throw new Error(`全量模板同步有 ${failedCount} 项未成功，请根据上方结果和 runId 排查`)
    }
  } finally {
    await app.close()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`全量模板同步失败：${message}`)
  process.exitCode = 1
})
