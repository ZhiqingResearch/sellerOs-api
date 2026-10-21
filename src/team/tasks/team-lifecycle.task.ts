import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { Cron, CronExpression } from "@nestjs/schedule"
import { TeamService } from "../team.service"

/**
 * 团队生命周期定时任务。
 * 每日 0 点（**Asia/Shanghai**，容器为 UTC 时也必须按北京时间迁移，否则宽限期会延迟到北京 08:00）
 * + 进程启动各跑一次（catch-up 不阻断启动）：
 * ACTIVE 到期 → GRACE（宽限 30 天，池冻结不清零）；GRACE 满 → ARCHIVED
 * （套餐/赠送池清零留痕、充值池退管理员个人户、成员名单保留 status=ARCHIVED）。
 */
@Injectable()
export class TeamLifecycleTask implements OnModuleInit {
  private readonly logger = new Logger(TeamLifecycleTask.name)

  constructor(private readonly team: TeamService) {}

  onModuleInit() {
    // 启动 catch-up（fire-and-forget）：补跑停机期间错过的状态迁移
    void this.runLifecycle("启动")
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { timeZone: "Asia/Shanghai" })
  async handleDailyLifecycle() {
    await this.runLifecycle("每日")
  }

  private async runLifecycle(trigger: string) {
    try {
      const { grace, archived } = await this.team.runLifecycle()
      if (grace + archived > 0) {
        this.logger.log(`${trigger}生命周期：${grace} 个团队进入宽限期，${archived} 个团队归档`)
      }
    } catch (err) {
      this.logger.error(`${trigger}生命周期任务失败: ${(err as Error).message}`)
    }
  }
}
