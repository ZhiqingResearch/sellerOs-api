import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { CreditBucket, CreditTxnType, Prisma } from "@prisma/client"
import * as argon2 from "argon2"
import { CreditService } from "../membership/credit.service"
import { SIGNUP_BONUS_CREDITS, signupBonusExpiresAt } from "../membership/membership.constants"
import { PrismaService } from "../prisma/prisma.service"
import { EmailLoginDto } from "./dto/email-login.dto"
import { EmailRegisterDto } from "./dto/register.dto"
import { ResetPasswordDto } from "./dto/reset-password.dto"
import { EmailAuthCodeService } from "./email-auth-code.service"

/** 伪手机号生成重试次数（随机撞唯一索引的概率极低，仅兜底） */
const FAKE_PHONE_MAX_ATTEMPTS = 5

/** 邮箱注册默认绑定的角色名（运营预置；缺失时不阻塞注册，仅 error 日志留痕） */
const DEFAULT_EMAIL_SIGNUP_ROLE_NAME = "Ops"

/**
 * 邮箱认证通道：开放注册 / 邮箱登录 / 找回密码。
 * 完全独立于手机号登录（/auth/login）与邀请注册的邮箱验证码（EmailCode 表），互不感知。
 * 邮箱账号落在 EmailAccount 表（email 库级唯一）；有该表行 = 邮箱注册用户（找回密码的权限闸门）。
 */
@Injectable()
export class AuthEmailService {
  private readonly logger = new Logger(AuthEmailService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly emailCode: EmailAuthCodeService,
    private readonly credit: CreditService
  ) {}

  /** 发送注册验证码：邮箱已被注册直接 400（不发码不烧频次） */
  async sendRegisterCode(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase()
    const taken = await this.prisma.emailAccount.findUnique({
      where: { email },
      select: { id: true },
    })
    if (taken) throw new BadRequestException("该邮箱已注册，请直接登录")

    await this.emailCode.send(email, "REGISTER")
    return { message: "验证码已发送，请查收邮箱" }
  }

  /** 邮箱开放注册：可恢复校验（邮箱占用）先做、失败不烧码 → 核销验证码 → 建 User + EmailAccount → 送注册积分 → 签发 token */
  async register(dto: EmailRegisterDto) {
    const email = dto.email.trim().toLowerCase()

    const taken = await this.prisma.emailAccount.findUnique({
      where: { email },
      select: { id: true },
    })
    if (taken) throw new ConflictException("该邮箱已注册，请直接登录")

    const codeValid = await this.emailCode.consume(email, dto.emailCode, "REGISTER")
    if (!codeValid) throw new BadRequestException("验证码无效或已过期")

    const passwordHash = await argon2.hash(dto.password)
    const username = this.deriveUsername(dto.username, email)

    for (let attempt = 0; attempt < FAKE_PHONE_MAX_ATTEMPTS; attempt++) {
      const phone = this.generateFakePhone()
      const phoneTaken = await this.prisma.user.findUnique({
        where: { phone },
        select: { id: true },
      })
      if (phoneTaken) continue

      try {
        // 事务显式放宽到 15s（仓库惯例）：远程库（开发库在境外机房）往返延迟下，
        // 默认 5s 交互式事务会被建号+送积分的多趟查询拖超时
        const { user, role } = await this.prisma.$transaction(
          async tx => {
            const created = await tx.user.create({
              data: {
                username,
                phone, // 伪手机号：仅满足 User.phone 必填+唯一，9 开头不落在真实号段
                email, // 同步写通知邮箱（到期提醒/收据回落链复用），登录一律走 EmailAccount
                password: passwordHash,
                balance: 0,
              },
            })
            await tx.emailAccount.create({ data: { email, userId: created.id } })
            // 默认绑定「Ops」角色（按名称查运营预置的角色）；角色缺失不阻塞注册——配置问题
            // 不该挡用户建号，后续建好角色后新注册自动带上
            const defaultRole = await tx.roleModel.findFirst({
              where: { name: DEFAULT_EMAIL_SIGNUP_ROLE_NAME },
              select: { id: true, code: true },
            })
            if (defaultRole) {
              await tx.userRole.create({ data: { userId: created.id, roleId: defaultRole.id } })
            } else {
              this.logger.error(
                `邮箱注册默认角色「${DEFAULT_EMAIL_SIGNUP_ROLE_NAME}」不存在，用户 ${created.id} 未绑定角色`
              )
            }
            // 注册赠送 200 体验积分（GIFT，注册起 30 天过期，与后台建号/邀请注册口径一致）
            await this.credit.grant(
              created.id,
              CreditBucket.GIFT,
              SIGNUP_BONUS_CREDITS,
              {
                type: CreditTxnType.SIGNUP_BONUS,
                source: "email.signup",
                expiresAt: signupBonusExpiresAt(new Date()),
              },
              tx
            )
            return { user: created, role: defaultRole }
          },
          { timeout: 15_000 }
        )

        this.logger.log(`User ${user.id} registered via email ${email}`)
        // 注册即登录：新号默认绑「Ops」角色、无组织；roleCode 取该角色 code（展示性保留字段）
        return {
          access_token: this.jwtService.sign({
            sub: user.id,
            phone: user.phone,
            roleCode: role?.code ?? null,
            currentOrgId: null,
          }),
        }
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002" &&
          this.isPhoneUniqueViolation(e)
        ) {
          continue // 伪手机号被并发占用（概率极低）：换号重试
        }
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          // 邮箱占用：快检后到建号前被并发注册，EmailAccount.email 唯一兜底
          throw new ConflictException("该邮箱已注册，请直接登录")
        }
        throw e
      }
    }

    throw new InternalServerErrorException("注册失败，请稍后重试")
  }

  /** 邮箱密码登录：凭证错误统一 400（401 专留给 token 失效/账号停用，与 /auth/login 口径一致） */
  async login(dto: EmailLoginDto) {
    const email = dto.email.trim().toLowerCase()
    const account = await this.prisma.emailAccount.findUnique({
      where: { email },
      include: { user: { include: LOGIN_INCLUDE } },
    })
    if (!account) throw new BadRequestException("邮箱或密码错误")

    const valid = await argon2.verify(account.user.password, dto.password)
    if (!valid) throw new BadRequestException("邮箱或密码错误")

    if (!account.user.isActive) {
      throw new BadRequestException("账号已停用，请联系管理员")
    }

    await this.prisma.user.update({
      where: { id: account.user.id },
      data: { lastLoginAt: new Date() },
    })
    this.logger.log(`User ${account.user.id} logged in via email password`)
    return this.generateToken(account.user)
  }

  /** 忘记密码：仅邮箱注册账号发码；响应统一话术，不暴露账号是否存在 */
  async forgotPassword(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase()
    const account = await this.prisma.emailAccount.findUnique({
      where: { email },
      select: { id: true },
    })
    if (account) {
      await this.emailCode.send(email, "RESET")
    }
    return { message: "如该邮箱已注册，验证码已发送，请查收" }
  }

  /** 重置密码：核销重置码 → 写新密码；账号不存在与验证码无效返回同一话术（防枚举） */
  async resetPassword(dto: ResetPasswordDto) {
    const email = dto.email.trim().toLowerCase()
    const account = await this.prisma.emailAccount.findUnique({
      where: { email },
      select: { userId: true },
    })

    const codeValid =
      account !== null && (await this.emailCode.consume(email, dto.emailCode, "RESET"))
    if (!codeValid) throw new BadRequestException("验证码无效或已过期")

    const password = await argon2.hash(dto.newPassword)
    await this.prisma.user.update({
      where: { id: account.userId },
      data: { password, mustChangePassword: false },
    })
    this.logger.log(`User ${account.userId} reset password via email code`)
    return { message: "密码已重置，请使用新密码登录" }
  }

  /**
   * 伪手机号："9" + 10 位随机数字。11 位且 9 开头，落在真实号段 /^1[3-9]/ 之外，
   * 绝不占用真实用户号码；仅用于满足 User.phone 必填+唯一约束。
   */
  private generateFakePhone(): string {
    return `9${Math.floor(Math.random() * 1e10)
      .toString()
      .padStart(10, "0")}`
  }

  /** 用户名缺省取邮箱 @ 前部分（≤50） */
  private deriveUsername(input: string | undefined, email: string): string {
    if (input && input.trim().length > 0) return input.trim().slice(0, 50)
    const local = email.split("@")[0]?.trim()
    return local && local.length > 0 ? local.slice(0, 50) : email.slice(0, 50)
  }

  /** P2002 是否撞在 User.phone 唯一索引上（meta.target 可能是字段数组或索引名，两种都判） */
  private isPhoneUniqueViolation(e: Prisma.PrismaClientKnownRequestError): boolean {
    const target = e.meta?.target
    if (Array.isArray(target)) return target.includes("phone")
    return typeof target === "string" ? target.toLowerCase().includes("phone") : false
  }

  /** 与 /auth/login 同构的 token：payload/有效期完全一致，JwtAuthGuard/JwtStrategy 零适配 */
  private generateToken(user: {
    id: number
    phone: string
    roles: { role: { code: string } }[]
    orgs: { orgId: number }[]
  }) {
    const roleCode = user.roles[0]?.role.code ?? null
    const payload = {
      sub: user.id,
      phone: user.phone,
      roleCode,
      currentOrgId: user.orgs[0]?.orgId ?? null,
    }
    return { access_token: this.jwtService.sign(payload) }
  }
}

/** 登录取首个角色 code + 首个组织 id（与 auth.service 的 LOGIN_INCLUDE 同构） */
const LOGIN_INCLUDE = {
  roles: {
    select: { role: { select: { code: true } } },
    take: 1,
    orderBy: { roleId: Prisma.SortOrder.asc },
  },
  orgs: {
    select: { orgId: true },
    take: 1,
    orderBy: { orgId: Prisma.SortOrder.asc },
  },
} satisfies Prisma.UserInclude
