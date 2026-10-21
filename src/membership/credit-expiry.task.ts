import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { Cron, CronExpression } from "@nestjs/schedule"
import { CreditService } from "./credit.service"

/**
 * 套餐/赠送积分（PACKAGE）周期清零定时任务。
 * 每日凌晨（**Asia/Shanghai**）把已过期批次落成物理 EXPIRED + 写 EXPIRE 流水（清零留痕）。
 * 余额读取一律过滤 expiresAt>now（读时兜底），故即便本任务延迟/漏跑也不会误扣，
 * 进程重启时再 catch-up 一次，保证留痕不丢。
 */
@Injectable()
export class CreditExpiryTask implements OnModuleInit {
  private readonly logger = new Logger(CreditExpiryTask.name)

  constructor(private readonly credit: CreditService) {}

  onModuleInit() {
    // 启动 catch-up（fire-and-forget）：补跑可能在停机期间错过的清零，不阻断启动
    void this.runExpire("启动")
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { timeZone: "Asia/Shanghai" })
  async handleDailyExpire() {
    await this.runExpire("每日")
  }

  private async runExpire(trigger: string) {
    try {
      const { expired } = await this.credit.expireLots()
      if (expired > 0) this.logger.log(`${trigger}清零：过期 ${expired} 笔套餐积分批次`)
      // 同一时点：到期未续费的订阅降为无等级（tier 置空 + 等级 NONE；读侧已按有效期即时推导）
      const { downgraded } = await this.credit.downgradeExpiredSubscriptions()
      if (downgraded > 0)
        this.logger.log(`${trigger}降级：${downgraded} 个到期未续费用户降为无等级`)
    } catch (err) {
      this.logger.error(`${trigger}清零任务失败: ${(err as Error).message}`)
    }
  }
}
