import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { MailProvider } from "../common/providers/mail.provider"

/**
 * 计费邮件：收据 PDF 附件邮件 / 计费告警邮件。
 * 收据附件通道：阿里云 DirectMail 官方 SDK 的 SingleSendMailAdvance（与验证码同一套 AK/发信地址）。
 * 降级链：PDF 已生成但附件发送失败 → 自动降级为纯 HTML 正文（无附件）+ 告警日志，不阻塞记账。
 * 环境变量：MAIL_* / ZQ_ACCESS_KEY_*（见 MailProvider）；BILLING_ALERT_EMAIL（告警收件人，可多个逗号分隔）。
 */
@Injectable()
export class BillingMailService {
  private readonly logger = new Logger(BillingMailService.name)
  private readonly alertEmails: string[]

  constructor(
    private readonly mail: MailProvider,
    config: ConfigService
  ) {
    this.alertEmails = (config.get<string>("BILLING_ALERT_EMAIL") ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
  }

  /** 收据邮件：有 PDF 走附件发送（失败降级纯 HTML）；pdfBuffer 传 null 强制无附件 */
  async sendReceiptMail(opts: {
    to: string
    subject: string
    html: string
    pdfBuffer: Buffer | null
    pdfFilename: string
  }): Promise<{ channel: "directmail"; withAttachment: boolean }> {
    if (opts.pdfBuffer) {
      try {
        await this.mail.sendMailWithAttachment(opts.to, opts.subject, opts.html, [
          { name: opts.pdfFilename, content: opts.pdfBuffer },
        ])
        this.logger.log(`receipt mail sent WITH pdf attachment to ${opts.to}: ${opts.subject}`)
        return { channel: "directmail", withAttachment: true }
      } catch (e) {
        this.logger.warn(`收据附件发送失败，降级为纯 HTML 正文：${(e as Error).message}`)
      }
    }
    await this.mail.sendMail(opts.to, opts.subject, opts.html)
    this.logger.warn(
      `receipt mail sent WITHOUT pdf attachment to ${opts.to}（PDF 未生成或附件发送失败）`
    )
    return { channel: "directmail", withAttachment: false }
  }

  /** 计费告警（金额不符 / dispute / 结算失败等转人工场景）：通知平台处理人 */
  async sendAlert(subject: string, html: string): Promise<void> {
    if (!this.alertEmails.length) {
      this.logger.warn(`BILLING_ALERT_EMAIL 未配置，告警仅落日志：${subject}`)
      return
    }
    for (const addr of this.alertEmails) {
      await this.mail
        .sendMail(addr, subject, html)
        .catch(e => this.logger.warn(`alert mail to ${addr} failed: ${(e as Error).message}`))
    }
  }
}
