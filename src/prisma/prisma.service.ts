import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common"
import { Prisma, PrismaClient } from "@prisma/client"

/** 在 DATABASE_URL 上叠加连接池参数（已带的参数不覆盖） */
function buildPooledUrl(): string {
  const raw = process.env.DATABASE_URL ?? ""
  if (!raw) return raw
  const limit = process.env.PRISMA_CONNECTION_LIMIT ?? "15"
  const poolTimeout = process.env.PRISMA_POOL_TIMEOUT ?? "30"
  const extra = new URLSearchParams()
  if (!/connection_limit=/.test(raw)) extra.set("connection_limit", limit)
  if (!/pool_timeout=/.test(raw)) extra.set("pool_timeout", poolTimeout)
  const qs = extra.toString()
  if (!qs) return raw
  return raw.includes("?") ? `${raw}&${qs}` : `${raw}?${qs}`
}

/** 启用软删除过滤的模型（读操作自动过滤 deletedAt != null） */
const SOFT_DELETE_MODELS = new Set<string>([
  Prisma.ModelName.Customer,
  Prisma.ModelName.Account,
  Prisma.ModelName.Avatar,
  Prisma.ModelName.Voice,
  Prisma.ModelName.Project,
  Prisma.ModelName.Source,
  Prisma.ModelName.Strategy,
  Prisma.ModelName.Production,
  Prisma.ModelName.Script,
  Prisma.ModelName.CopyWriting,
  Prisma.ModelName.Storyboard,
  Prisma.ModelName.StoryboardVideo,
  Prisma.ModelName.MaterialImage,
  Prisma.ModelName.MaterialImageVariant,
  Prisma.ModelName.ImageProject,
  Prisma.ModelName.ProductPublishTask,
  Prisma.ModelName.ProductProfile,
  Prisma.ModelName.BrandIdentity,
  Prisma.ModelName.BrandKit,
  Prisma.ModelName.ProductImage,
  Prisma.ModelName.GenerationTask,
  Prisma.ModelName.GeneratedImage,
  Prisma.ModelName.ImageTemplate,
  Prisma.ModelName.VideoProject,
  Prisma.ModelName.VideoTask,
  Prisma.ModelName.RpaCreationProject,
  Prisma.ModelName.RpaCreationTask,
  Prisma.ModelName.RpaCreationOutput,
  Prisma.ModelName.BeautyProject,
  Prisma.ModelName.BeautyTask,
  Prisma.ModelName.PoolImage,
  Prisma.ModelName.PoolGroup,
  Prisma.ModelName.DigitalHuman,
  Prisma.ModelName.Scene,
  Prisma.ModelName.SalesWorkflow,
  Prisma.ModelName.SalesSegment,
  Prisma.ModelName.InspirationSubscription,
  Prisma.ModelName.ProductFactoryRecord,
  Prisma.ModelName.SelectionAnalysisRecord,
  Prisma.ModelName.ProductLibraryItem,
  Prisma.ModelName.AsinAuditRecord,
  Prisma.ModelName.SmartPricingRecord,
  Prisma.ModelName.CompetitorAnalysisRecord,
  Prisma.ModelName.VideoAnalysisRecord,
  Prisma.ModelName.Announcement,
])

/** 需要自动注入 deletedAt: null 过滤的读操作 */
const READ_OPERATIONS = new Set<string>([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
])

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)

  constructor() {
    super({
      datasources: {
        db: {
          // 高 RTT 远程开发库（DO NYC3）下需显式管理连接池：过小则长事务排队
          // 顶爆 interactive timeout；过大则撞托管网关连接上限（小规格 ~25），
          // 表现为 P1001 Can't reach database server。取 15 平衡。
          url: buildPooledUrl(),
        },
      },
    })

    // 通过 $extends 对所有读操作自动注入 deletedAt: null 过滤，然后把扩展后的
    // 模型委托覆盖回当前实例，使外部调用方无需感知软删除逻辑。
    const extended = this.$extends({
      query: {
        $allModels: {
          $allOperations: ({ model, operation, args, query }) => {
            if (SOFT_DELETE_MODELS.has(model) && READ_OPERATIONS.has(operation)) {
              const a = args as { where?: Record<string, unknown> }
              a.where = { ...a.where, deletedAt: null }
            }
            return query(args)
          },
        },
      },
    })

    for (const modelName of SOFT_DELETE_MODELS) {
      const key = modelName.charAt(0).toLowerCase() + modelName.slice(1)
      Object.defineProperty(this, key, {
        value: (extended as unknown as Record<string, unknown>)[key],
        writable: false,
        configurable: true,
      })
    }
  }

  async onModuleInit() {
    await this.$connect()
    this.logger.log("Database connected")
  }

  async onModuleDestroy() {
    await this.$disconnect()
    this.logger.log("Database disconnected")
  }
}
