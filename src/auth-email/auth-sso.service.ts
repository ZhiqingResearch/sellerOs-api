import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { Prisma } from "@prisma/client"
import { createHash, randomBytes } from "node:crypto"
import { PrismaService } from "../prisma/prisma.service"

/** 交接码有效期（秒） */
const HANDOFF_TTL_MS = 60 * 1000

/** 所有核销失败统一话术：不区分无效/过期/已使用（防枚举），也不触发前端 401 拦截 */
const INVALID_CODE_MESSAGE = "登录链接无效或已过期，请重新登录"

/**
 * 跨域登录交接（海外首页 → Seller 主站）。
 * localStorage 按 Origin 隔离、Bearer token 不随跳转携带，跨站登录态交接用
 * OAuth 授权码同款模式：短时（60s）一次性高熵 code，核销端原子换取 token。
 * 后端只发 code 不构造任何跳转 URL（无开放重定向面），跳转由前端用自身配置拼接。
 */
@Injectable()
export class AuthSsoService {
  private readonly logger = new Logger(AuthSsoService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService
  ) {}

  /** 签发交接码（需登录态）：256-bit 随机 code，库内只存 sha256 哈希；作废该用户旧未用码防堆积 */
  async handoff(userId: number) {
    const code = randomBytes(32).toString("base64url")
    const now = new Date()
    await this.prisma.$transaction([
      this.prisma.authHandoffCode.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: now },
      }),
      this.prisma.authHandoffCode.create({
        data: {
          codeHash: sha256Hex(code),
          userId,
          expiresAt: new Date(now.getTime() + HANDOFF_TTL_MS),
        },
      }),
    ])
    this.logger.log(`Handoff code issued for user ${userId}`)
    return { handoffCode: code, expiresIn: 60 }
  }

  /** 核销交接码（公开接口）：校验未用未过期 → 账号可用 → 条件 updateMany 原子单次核销 → 签发 token */
  async exchange(handoffCode: string) {
    const record = await this.prisma.authHandoffCode.findUnique({
      where: { codeHash: sha256Hex(handoffCode) },
    })
    if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(INVALID_CODE_MESSAGE)
    }

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      include: LOGIN_INCLUDE,
    })
    if (!user || !user.isActive) {
      throw new BadRequestException(INVALID_CODE_MESSAGE)
    }

    const consumed = await this.prisma.authHandoffCode.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    })
    if (consumed.count === 0) {
      throw new BadRequestException(INVALID_CODE_MESSAGE)
    }

    this.logger.log(`User ${user.id} exchanged handoff code`)
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

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** 核销签发 token 取首个角色 code + 首个组织 id（与 /auth/login 口径一致） */
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
