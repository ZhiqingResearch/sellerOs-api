import Core from "@alicloud/pop-core"
import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Prisma } from "@prisma/client"
import { randomInt } from "node:crypto"
import { PrismaService } from "../prisma/prisma.service"

@Injectable()
export class SmsService {
  private readonly client: Core
  private readonly logger = new Logger(SmsService.name)

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService
  ) {
    this.client = new Core({
      accessKeyId: this.configService.get<string>("ACCESS_KEY_ID") as string,
      accessKeySecret: this.configService.get<string>("ACCESS_KEY_SECRET") as string,
      endpoint: "https://dysmsapi.aliyuncs.com",
      apiVersion: "2017-05-25",
    })
  }

  async sendCode(phone: string): Promise<void> {
    const templateCode = this.configService.get<string>("SMS_TEMPLATE_CODE")
    const signName = this.configService.get<string>("SMS_SIGN_NAME")
    if (
      !templateCode ||
      !signName ||
      !this.configService.get<string>("ACCESS_KEY_ID") ||
      !this.configService.get<string>("ACCESS_KEY_SECRET")
    ) {
      throw new BadRequestException("短信服务未配置，请联系管理员")
    }
    // Check 60s rate limit
    const recentCode = await this.prisma.smsCode.findFirst({
      where: { phone },
      orderBy: { createdAt: "desc" },
    })

    if (recentCode) {
      const diff = Date.now() - recentCode.createdAt.getTime()
      if (diff < 60 * 1000) {
        throw new BadRequestException("验证码获取过于频繁，请60秒后再试")
      }
    }

    const code = randomInt(1000000).toString().padStart(6, "0")
    const expiredAt = new Date(Date.now() + 5 * 60 * 1000)

    const [, record] = await this.prisma.$transaction([
      this.prisma.smsCode.updateMany({ where: { phone, used: false }, data: { used: true } }),
      this.prisma.smsCode.create({ data: { phone, code, expiredAt } }),
    ])

    try {
      const result = await this.client.request<{ Code: string }>(
        "SendSms",
        {
          PhoneNumbers: phone,
          SignName: signName,
          TemplateCode: templateCode,
          TemplateParam: JSON.stringify({ code }),
        },
        { method: "POST", formatParams: false }
      )
      if (result.Code !== "OK") {
        this.logger.warn(`SMS rejected: ${result.Code}`)
        throw new Error("SMS rejected")
      }
      this.logger.log(`SMS code sent to ${phone}`)
    } catch {
      await this.prisma.smsCode.updateMany({ where: { id: record.id }, data: { used: true } })
      this.logger.error(`Failed to send SMS to ${phone}`)
      throw new BadRequestException("短信发送失败，请稍后再试")
    }
  }

  /**
   * 密码重置成功通知：只提示"密码已被重置，请用初始密码登录后修改"，**不含任何密码内容**。
   * 模板为固定文案、无参数。未配置（SMS_RESET_TEMPLATE_CODE 为空）时只记日志、跳过，不阻断重置流程。
   */
  async sendPasswordResetNotice(phone: string): Promise<void> {
    const templateCode = this.configService.get<string>("SMS_RESET_TEMPLATE_CODE")
    const signName = this.configService.get<string>("SMS_SIGN_NAME")
    if (!templateCode || !signName) {
      this.logger.warn(`未配置 SMS_RESET_TEMPLATE_CODE，跳过密码重置短信通知（${phone}）`)
      return
    }
    try {
      await this.client.request(
        "SendSms",
        {
          PhoneNumbers: phone,
          SignName: signName,
          TemplateCode: templateCode,
        },
        { method: "POST", formatParams: false }
      )
      this.logger.log(`Password reset notice SMS sent to ${phone}`)
    } catch (error) {
      // 通知失败不应让重置接口整体失败（密码已改成功），仅记录
      this.logger.error(`Failed to send password-reset SMS to ${phone}`, error)
    }
  }

  async verifyCode(
    phone: string,
    code: string,
    tx: Prisma.TransactionClient = this.prisma
  ): Promise<boolean> {
    const record = await tx.smsCode.findFirst({
      where: {
        phone,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    })

    if (!record || record.used || record.expiredAt <= new Date() || record.attempts >= 5) {
      return false
    }

    if (record.code !== code) {
      await tx.smsCode.updateMany({
        where: { id: record.id, used: false, attempts: { lt: 5 } },
        data: { attempts: { increment: 1 } },
      })
      return false
    }

    const result = await tx.smsCode.updateMany({
      where: { id: record.id, used: false, attempts: { lt: 5 }, expiredAt: { gt: new Date() } },
      data: { used: true },
    })

    return result.count > 0
  }
}
