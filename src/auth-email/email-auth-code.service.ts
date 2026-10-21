import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import { MailProvider } from "../common/providers/mail.provider"
import { PrismaService } from "../prisma/prisma.service"

/** 验证码场景：注册 / 重置密码。不同场景的码互不通用 */
export type EmailAuthPurpose = "REGISTER" | "RESET"

/** 验证码有效期（5 分钟） */
const CODE_TTL_MS = 5 * 60 * 1000

/** 同一邮箱同一场景的发送限频 */
const SEND_INTERVAL_MS = 60 * 1000

/** 连续校验失败次数上限，达到即作废当前码（防爆破 6 位码） */
const MAX_ATTEMPTS = 5

/**
 * 邮箱认证验证码（邮箱注册/登录/找回密码通道专用）。
 * 与邀请注册的 EmailCode 表完全隔离：60s 限频、重发即作废旧码（仅最新一条可用）、
 * 错码累计 5 次作废、条件 updateMany 原子核销防并发重放。
 */
@Injectable()
export class EmailAuthCodeService {
  private readonly logger = new Logger(EmailAuthCodeService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailProvider
  ) {}

  /** 发送验证码：限频 → 作废旧码 + 落新码 → 异步发信（失败不阻塞，60s 后可重试） */
  async send(rawEmail: string, purpose: EmailAuthPurpose): Promise<void> {
    const email = rawEmail.trim().toLowerCase()

    const recent = await this.prisma.emailAuthCode.findFirst({
      where: { email, purpose },
      orderBy: { createdAt: "desc" },
    })
    if (recent && Date.now() - recent.createdAt.getTime() < SEND_INTERVAL_MS) {
      throw new BadRequestException("验证码获取过于频繁，请 60 秒后再试")
    }

    const code = Math.floor(Math.random() * 1000000)
      .toString()
      .padStart(6, "0")
    await this.prisma.$transaction([
      // 作废旧码：未使用的历史验证码全部置 used，仅新码可核销（防新旧码并存混用）
      this.prisma.emailAuthCode.updateMany({
        where: { email, purpose, used: false },
        data: { used: true },
      }),
      this.prisma.emailAuthCode.create({
        data: { email, code, purpose, expiredAt: new Date(Date.now() + CODE_TTL_MS) },
      }),
    ])

    void this.sendMail(email, code, purpose).catch((err: unknown) => {
      this.logger.error(
        `发送邮箱验证码失败 email=${email} purpose=${purpose}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    })
  }

  /**
   * 核销验证码。条件 updateMany 原子占位：并发下同一张码只会成功一次。
   * 码不匹配时给该邮箱当前有效码记一次失败，连续失败 ≥ MAX_ATTEMPTS 直接作废。
   */
  async consume(rawEmail: string, code: string, purpose: EmailAuthPurpose): Promise<boolean> {
    const email = rawEmail.trim().toLowerCase()
    const record = await this.prisma.emailAuthCode.findFirst({
      where: { email, purpose, used: false, expiredAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    })
    if (!record) return false

    if (record.code !== code) {
      const attempts = record.attempts + 1
      await this.prisma.emailAuthCode.update({
        where: { id: record.id },
        data: { attempts, used: attempts >= MAX_ATTEMPTS },
      })
      return false
    }

    const result = await this.prisma.emailAuthCode.updateMany({
      where: { id: record.id, used: false },
      data: { used: true },
    })
    return result.count > 0
  }

  private sendMail(to: string, code: string, purpose: EmailAuthPurpose): Promise<void> {
    if (purpose === "RESET") {
      return this.mail.sendMail(
        to,
        "[SellerOS] Password Reset Verification Code",
        `<p>You are resetting your SellerOS account password. Your verification code is <b style="font-size:18px">${code}</b>, valid for 5 minutes.</p>` +
          `<p>If this wasn't you, please check your account security immediately and ignore this email.</p>`
      )
    }
    return this.mail.sendMail(
      to,
      "[SellerOS] Registration Verification Code",
      `<p>You are registering for SellerOS. Your verification code is <b style="font-size:18px">${code}</b>, valid for 5 minutes.</p>` +
        `<p>If this wasn't you, please ignore this email.</p>`
    )
  }
}
