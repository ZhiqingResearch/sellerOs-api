import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Cron } from "@nestjs/schedule"
import { ProductPublishFeishuSyncTrigger } from "@prisma/client"
import { ProductPublishStoreSyncService } from "./product-publish-store-sync.service"

@Injectable()
export class ProductPublishStoreSyncTask {
  private readonly logger = new Logger(ProductPublishStoreSyncTask.name)

  constructor(
    private readonly syncService: ProductPublishStoreSyncService,
    private readonly config: ConfigService
  ) {}

  @Cron("0 10 2 * * *", {
    name: "product-publish-feishu-store-sync",
    timeZone: "Asia/Shanghai",
    waitForCompletion: true,
  })
  async handleDailySync() {
    const profile = this.config.get<string>("YINGDAO_PRODUCT_PUBLISH_PROFILE", "").trim()
    if (profile !== "prod") {
      this.logger.log(`跳过飞书店铺每日同步：当前环境 profile=${profile || "未配置"}`)
      return
    }

    try {
      await this.syncService.syncFromFeishu(ProductPublishFeishuSyncTrigger.SCHEDULED)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`飞书店铺每日同步失败：${message}`)
    }
  }
}
