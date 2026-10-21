import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { Cron, CronExpression } from "@nestjs/schedule"
import { CreditService } from "./credit.service"

/**
 * 【遗留】续费「排队生效」激活定时任务。
 * 2026-08-25 起续费改为立即生效（renewImmediateInTx），不再产生新的排队单；
 * 本任务仅为 2026-08-25 前的历史排队单（ScheduledPlan PENDING）保留激活链路，
 * 每日把当前订阅已到期、且有历史待生效续费套餐的用户激活——发积分 / 切等级 / 设新到期日。
 * 读时（getWallet/consume）已做兜底激活；进程重启时再 catch-up 一次。
 */
@Injectable()
export class PlanActivationTask implements OnModuleInit {
  private readonly logger = new Logger(PlanActivationTask.name)

  constructor(private readonly credit: CreditService) {}

  onModuleInit() {
    // 启动 catch-up（fire-and-forget）：补跑停机期间错过的激活，不阻断启动
    void this.runActivate("启动")
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { timeZone: "Asia/Shanghai" })
  async handleDailyActivate() {
    await this.runActivate("每日")
  }

  private async runActivate(trigger: string) {
    try {
      const { activated, users } = await this.credit.activateAllDuePlans()
      if (activated > 0) {
        this.logger.log(`${trigger}续费激活：${users} 个用户共激活 ${activated} 笔待生效套餐`)
      }
    } catch (err) {
      this.logger.error(`${trigger}续费激活任务失败: ${(err as Error).message}`)
    }
  }
}
