import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Cron } from "@nestjs/schedule"
import { ProductPublishRpaService } from "./product-publish-rpa.service"

@Injectable()
export class ProductPublishRpaTask {
  private readonly logger = new Logger(ProductPublishRpaTask.name)

  constructor(
    private readonly rpaService: ProductPublishRpaService,
    private readonly config: ConfigService
  ) {}

  @Cron("0 10 3 * * *", {
    name: "product-publish-rpa-template-refresh",
    timeZone: "Asia/Shanghai",
    waitForCompletion: true,
  })
  async handleDailyTemplateRefresh(): Promise<void> {
    const profile = this.config.get<string>("YINGDAO_PRODUCT_PUBLISH_PROFILE", "").trim()
    if (profile !== "prod") {
      this.logger.log(`跳过一键上架模板每日刷新：当前环境 profile=${profile || "未配置"}`)
      return
    }

    try {
      await this.rpaService.refreshTemplates()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`一键上架模板每日刷新失败：${message}`)
    }
  }

  @Cron("0 */5 * * * *", {
    name: "product-publish-rpa-result-poll",
    timeZone: "Asia/Shanghai",
    waitForCompletion: true,
  })
  async handlePublishingTaskPoll(): Promise<void> {
    try {
      await this.rpaService.pollPublishingTasks()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`一键上架处理结果定时查询失败：${message}`)
    }
  }
}
