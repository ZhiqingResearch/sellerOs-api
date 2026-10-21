import { Injectable, Logger } from "@nestjs/common"
import { Cron } from "@nestjs/schedule"
import { TeamStatus } from "@prisma/client"
import { MailProvider } from "../../common/providers/mail.provider"
import { exportDateFormatter } from "../../common/utils/datetime"
import { DAY_MS } from "../../membership/membership.constants"
import { PrismaService } from "../../prisma/prisma.service"

/**
 * 到期提醒邮件（每日 01:30 **Asia/Shanghai**，避开 0 点清零/激活任务）：
 * 个人套餐与团队版统一在 **到期前 7 / 3 / 1 天**各发一封续费提醒（窗口按**北京自然日**整天切——
 * 容器为 UTC 时不能用进程本地时区取日，邮件展示日期同样按北京时区格式化；
 * 每天恰好一批、自然去重不重发）。到期当天与过期后均不发（2026-08-27 产品定稿 7/3/1 三封；
 * 旧版「过期次日/宽限首日」两封按前一自然日查询、延迟一天，已取消）。
 * 收件人邮箱为空跳过（User.email 可选）；单封失败不阻塞其它。
 */
@Injectable()
export class ExpiryReminderTask {
  private readonly logger = new Logger(ExpiryReminderTask.name)

  /** 临期提醒档位（到期前 N 天） */
  private static readonly REMIND_DAYS = [7, 3, 1] as const

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailProvider
  ) {}

  @Cron("30 1 * * *", { timeZone: "Asia/Shanghai" })
  async run() {
    const now = new Date()
    // 北京自然日 00:00 边界（与容器时区无关）：先取北京 YYYY-MM-DD，再按 +08:00 构造绝对时刻
    const bjYmd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now)
    const dayStart = new Date(`${bjYmd}T00:00:00.000+08:00`)
    const inDays = (n: number) => new Date(dayStart.getTime() + n * DAY_MS)
    const dateStr = exportDateFormatter("Asia/Shanghai")

    let personalTotal = 0
    let teamTotal = 0

    for (const days of ExpiryReminderTask.REMIND_DAYS) {
      const window = { gte: inDays(days), lt: inDays(days + 1) }

      // ---- 个人套餐：T-N 临期 ----
      const personalExpiring = await this.prisma.user.findMany({
        where: { subscriptionExpiresAt: window },
        select: { id: true, username: true, email: true, subscriptionExpiresAt: true },
      })
      for (const u of personalExpiring) {
        if (!u.email || !u.subscriptionExpiresAt) continue
        await this.send(
          u.email,
          `【SellerOS】套餐将于 ${days} 天后到期`,
          `<p>${u.username}，你好：</p><p>你的会员套餐将于 <b>${dateStr(u.subscriptionExpiresAt)}</b> 到期。到期后套餐与赠送积分将清零，请及时续费。</p>`
        )
      }
      personalTotal += personalExpiring.length

      // ---- 团队版：T-N 临期（发管理员） ----
      const teamExpiring = await this.prisma.team.findMany({
        where: { status: TeamStatus.ACTIVE, expiresAt: window },
        select: {
          id: true,
          name: true,
          expiresAt: true,
          admin: { select: { username: true, email: true } },
        },
      })
      for (const t of teamExpiring) {
        if (!t.admin.email) continue
        await this.send(
          t.admin.email,
          `【SellerOS】团队版将于 ${days} 天后到期`,
          `<p>${t.admin.username}，你好：</p><p>你的企业「${t.name ?? "未命名"}」团队版将于 <b>${dateStr(t.expiresAt)}</b> 到期。到期后共享积分池将冻结并进入 30 天宽限期，请及时续费。</p>`
        )
      }
      teamTotal += teamExpiring.length
    }

    if (personalTotal + teamTotal > 0) {
      this.logger.log(`expiry-reminder: 个人临期 ${personalTotal} / 团队临期 ${teamTotal}`)
    }
  }

  /** 单封发送（失败仅告警不阻塞） */
  private async send(to: string, subject: string, html: string): Promise<void> {
    await this.mail.sendMail(to, subject, html).catch(e => {
      this.logger.warn(`expiry-reminder mail to ${to} failed: ${(e as Error).message}`)
    })
  }
}
