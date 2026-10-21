import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common"
import { PrismaClient } from "@prisma/client"

/**
 * 财务/审计对账专用的只读 Prisma 客户端 —— 刻意「不」挂载全局 PrismaService 的软删除扩展，
 * 因此能读到 deletedAt != null 的软删除行（生成记录页需要含已删除任务对齐扣费流水）。
 *
 * 与全局 PrismaService 完全独立：全局默认行为一字未改，其它模块不受任何影响。
 * 连接池刻意收到很小（审计接口低频、仅管理员使用），避免额外客户端占用过多数据库连接。
 */
@Injectable()
export class AuditPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditPrismaService.name)

  constructor() {
    const url = AuditPrismaService.buildUrl()
    super(url ? { datasources: { db: { url } } } : undefined)
  }

  /** 在 DATABASE_URL 上追加较小的 connection_limit，避免第二个客户端撑大连接数 */
  private static buildUrl(): string | undefined {
    const base = process.env.DATABASE_URL
    if (!base || base.includes("connection_limit=")) return base
    const sep = base.includes("?") ? "&" : "?"
    return `${base}${sep}connection_limit=2`
  }

  async onModuleInit() {
    await this.$connect()
    this.logger.log("Audit (soft-delete-bypass) database connected")
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
