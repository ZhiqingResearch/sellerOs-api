import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { Cron } from "@nestjs/schedule"
import { PrismaService } from "../prisma/prisma.service"

/**
 * Skill 市场计数校准定时任务。
 * skill_market_skills 的两个计数是性能缓存，真实来源是关系表/事件表；
 * 每日凌晨按真实来源回写，修复可能的计数偏差（联调文档第十节）。
 * 进程重启时 catch-up 一次，与项目其他任务的补偿执行惯例一致。
 */
@Injectable()
export class SkillMarketTasks implements OnModuleInit {
  private readonly logger = new Logger(SkillMarketTasks.name)

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // 启动 catch-up（fire-and-forget），不阻断启动
    void this.calibrate("启动")
  }

  /** 每日 04:00（服务器本地时区），避开 0 点任务扎堆 */
  @Cron("0 4 * * *")
  async handleDailyCalibrate() {
    await this.calibrate("每日")
  }

  private async calibrate(trigger: string) {
    try {
      // removedAt 不影响历史去重下载量：关系行一律计入 downloadCount
      const [relations, events] = await Promise.all([
        this.prisma.skillMarketUserSkill.groupBy({
          by: ["skillId"],
          _count: { _all: true },
        }),
        this.prisma.skillMarketDownloadEvent.groupBy({
          by: ["skillId"],
          _count: { _all: true },
        }),
      ])
      const expectedCount = new Map(relations.map(r => [r.skillId, BigInt(r._count._all)]))
      const expectedEventCount = new Map(events.map(e => [e.skillId, BigInt(e._count._all)]))

      const skills = await this.prisma.skillMarketSkill.findMany({
        select: { id: true, skillId: true, downloadCount: true, downloadEventCount: true },
      })

      let fixed = 0
      for (const skill of skills) {
        const targetCount = expectedCount.get(skill.skillId) ?? BigInt(0)
        const targetEventCount = expectedEventCount.get(skill.skillId) ?? BigInt(0)
        if (skill.downloadCount === targetCount && skill.downloadEventCount === targetEventCount)
          continue
        await this.prisma.skillMarketSkill.update({
          where: { id: skill.id },
          data: { downloadCount: targetCount, downloadEventCount: targetEventCount },
        })
        fixed++
        this.logger.warn(
          `${trigger}校准 ${skill.skillId}: downloadCount ${skill.downloadCount}->${targetCount}, ` +
            `downloadEventCount ${skill.downloadEventCount}->${targetEventCount}`
        )
      }
      if (fixed > 0) this.logger.log(`${trigger}校准完成：修正 ${fixed} 个技能的计数`)
    } catch (err) {
      this.logger.error(`${trigger}校准任务失败: ${(err as Error).message}`)
    }
  }
}
