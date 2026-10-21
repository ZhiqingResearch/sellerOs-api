import DmClient, {
  SingleSendMailAdvanceRequest,
  SingleSendMailAdvanceRequestAttachments,
} from "@alicloud/dm20151123"
import { $OpenApiUtil } from "@alicloud/openapi-core"
import Core from "@alicloud/pop-core"
import * as $dara from "@darabonba/typescript"
import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Readable } from "stream"

/**
 * 邮件发送（阿里云邮件推送 DirectMail，HTTP API 走 443）。用于邀请注册的邮箱验证码。
 *
 * 为什么不用 SMTP：海外主机（DigitalOcean）出站 SMTP 端口 25/465/587 被云厂商整体封禁，
 * 裸 SMTP 连接直接超时；DirectMail HTTP API 走 HTTPS(443) 不受影响。复用阿里云 ACCESS_KEY（与短信同一套）。
 *
 * 未配置（缺 ACCESS_KEY 或发信地址 MAIL_FROM）时不抛错只告警，发送时才抛 503（不阻断无邮件配置的环境启动）。
 * 环境变量：
 *   ACCESS_KEY_ID / ACCESS_KEY_SECRET（复用短信）
 *   MAIL_FROM         已在 DirectMail 验证的发信地址；兼容 "昵称 <addr@x.com>" 写法（自动拆地址+昵称）
 *   MAIL_FROM_ALIAS   可选，发信人昵称（优先级高于 MAIL_FROM 里解析出的昵称）
 *   MAIL_DM_ENDPOINT  DirectMail API 端点，按开通区域填：
 *                       美东     https://dm.us-east-1.aliyuncs.com
 *                       新加坡   https://dm.ap-southeast-1.aliyuncs.com
 *                       杭州     https://dm.aliyuncs.com（默认）
 */
@Injectable()
export class MailProvider {
  private readonly logger = new Logger(MailProvider.name)
  private readonly client: Core | null
  private readonly dmClient: DmClient | null // 官方 Tea SDK（附件发送只认它，pop-core 裸调不支持附件）
  private readonly accountName: string
  private readonly fromAlias?: string

  constructor(config: ConfigService) {
    const accessKeyId = config.get<string>("ZQ_ACCESS_KEY_ID")
    const accessKeySecret = config.get<string>("ZQ_ACCESS_KEY_SECRET")
    const endpoint = config.get<string>("MAIL_DM_ENDPOINT") ?? "https://dm.aliyuncs.com"

    const parsed = parseFrom(config.get<string>("MAIL_FROM") ?? "")
    this.accountName = parsed.address
    this.fromAlias = config.get<string>("MAIL_FROM_ALIAS") || parsed.alias

    if (accessKeyId && accessKeySecret && this.accountName) {
      this.client = new Core({
        accessKeyId,
        accessKeySecret,
        endpoint,
        apiVersion: "2015-11-23",
      })
      // Tea SDK 的 endpoint 不带协议前缀；regionId 从端点域名里取（dm.us-east-1 → us-east-1）
      const host = endpoint.replace(/^https?:\/\//, "")
      const regionId = host.match(/^dm\.([a-z0-9-]+)\.aliyuncs\.com$/)?.[1] ?? "cn-hangzhou"
      this.dmClient = new DmClient(
        new $OpenApiUtil.Config({ accessKeyId, accessKeySecret, endpoint: host, regionId })
      )
    } else {
      this.client = null
      this.dmClient = null
      this.logger.warn(
        "邮件推送未配置（ACCESS_KEY_ID/ACCESS_KEY_SECRET/MAIL_FROM），邮件发送不可用"
      )
    }
  }

  async sendMail(to: string, subject: string, html: string): Promise<void> {
    if (!this.client) throw new ServiceUnavailableException("邮件服务未配置")
    await this.client.request(
      "SingleSendMail",
      {
        AccountName: this.accountName, // DirectMail 控制台已验证的发信地址
        AddressType: 1, // 1=使用发信地址
        ReplyToAddress: false,
        ToAddress: to,
        Subject: subject,
        HtmlBody: html,
        ...(this.fromAlias ? { FromAlias: this.fromAlias } : {}),
      },
      { method: "POST", formatParams: false }
    )
    this.logger.log(`mail sent to ${to}: ${subject}`)
  }

  /** 发送注册验证码邮件（英文模板） */
  async sendVerificationCode(to: string, code: string): Promise<void> {
    await this.sendMail(
      to,
      "[SellerOS] Registration Verification Code",
      `<p>You are registering for SellerOS. Your verification code is <b style="font-size:18px">${code}</b>, valid for 5 minutes.</p>` +
        `<p>If this wasn't you, please ignore this email.</p>`
    )
  }

  /**
   * 带附件发送（收据 PDF 等）：走官方 dm20151123 SDK 的 SingleSendMailAdvance——
   * 附件能力只在新版 SDK 提供（SDK 内部先把附件传到临时 OSS 再发信），pop-core 裸调不支持。
   * 附件总大小（Base64 后）上限约 15MB，收据 PDF 远小于此。
   */
  async sendMailWithAttachment(
    to: string,
    subject: string,
    html: string,
    attachments: { name: string; content: Buffer }[]
  ): Promise<void> {
    if (!this.dmClient) throw new ServiceUnavailableException("邮件服务未配置")
    const request = new SingleSendMailAdvanceRequest({
      accountName: this.accountName,
      addressType: 1,
      replyToAddress: false,
      toAddress: to,
      subject,
      htmlBody: html,
      ...(this.fromAlias ? { fromAlias: this.fromAlias } : {}),
      attachments: attachments.map(
        a =>
          new SingleSendMailAdvanceRequestAttachments({
            attachmentName: a.name,
            // Readable.from(Buffer) 会按字节迭代，必须包成数组成一个 chunk
            attachmentUrlObject: Readable.from([a.content]),
          })
      ),
    })
    // 附件会先 POST 到临时 OSS（跨洋链路可能较慢），默认 3s 读超时不够，放宽
    await this.dmClient.singleSendMailAdvance(
      request,
      new $dara.RuntimeOptions({ readTimeout: 30_000, connectTimeout: 15_000 })
    )
    this.logger.log(`mail with ${attachments.length} attachment(s) sent to ${to}: ${subject}`)
  }
}

/** 解析 MAIL_FROM：兼容 "昵称 <addr@x.com>" 与纯地址 "addr@x.com" 两种写法。 */
function parseFrom(raw: string): { address: string; alias?: string } {
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (m) return { address: m[2].trim(), alias: m[1].trim() || undefined }
  return { address: raw.trim() }
}
