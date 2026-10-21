import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { InviteAppStatus, Prisma } from "@prisma/client"
import * as argon2 from "argon2"
import { PrismaService } from "../prisma/prisma.service"
import { SmsService } from "../sms/sms.service"
import { LoginDto } from "./dto/login.dto"
import { MePermissionGroupDto, MeResponseDto, PermissionsResponseDto } from "./dto/me.dto"
import { SmsLoginDto } from "./dto/sms-login.dto"
import { mergeUserPermissions, mergeUserRoles, userRolesSelect } from "./role-permissions.util"

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly smsService: SmsService
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
      include: LOGIN_INCLUDE,
    })

    if (!user) {
      const application = await this.prisma.inviteApplication.findFirst({
        where: { phone: dto.phone, status: InviteAppStatus.PENDING },
        select: { passwordHash: true },
      })
      if (application && (await argon2.verify(application.passwordHash, dto.password))) {
        throw new BadRequestException("审核中，请联系平台顾问")
      }
      // 凭证错误用 400（而非 401）：401 被前端全局拦截为“会话失效→跳登录”，会吞掉提示语；
      // 401 专留给 JwtAuthGuard 的 token 失效/账号被停用场景。
      throw new BadRequestException("手机号或密码错误")
    }

    const valid = await argon2.verify(user.password, dto.password)
    if (!valid) {
      throw new BadRequestException("手机号或密码错误")
    }

    if (!user.isActive) {
      throw new BadRequestException("账号已停用，请联系管理员")
    }

    await this.touchLastLogin(user.id)
    this.logger.log(`User ${user.phone} logged in via password`)
    return this.generateToken(user, user.orgs[0]?.orgId ?? null)
  }

  async loginBySms(dto: SmsLoginDto) {
    const valid = await this.smsService.verifyCode(dto.phone, dto.code)
    if (!valid) {
      throw new BadRequestException("验证码无效或已过期")
    }

    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
      include: LOGIN_INCLUDE,
    })

    if (!user) {
      const application = await this.prisma.inviteApplication.findFirst({
        where: { phone: dto.phone, status: InviteAppStatus.PENDING },
        select: { id: true },
      })
      if (application) {
        throw new BadRequestException("审核中，请联系平台顾问")
      }
      throw new BadRequestException("用户不存在")
    }

    if (!user.isActive) {
      throw new BadRequestException("账号已停用，请联系管理员")
    }

    await this.touchLastLogin(user.id)
    this.logger.log(`User ${user.phone} logged in via SMS`)
    return this.generateToken(user, user.orgs[0]?.orgId ?? null)
  }

  async sendCode(phone: string) {
    await this.smsService.sendCode(phone)
    return { message: "验证码已发送" }
  }

  async getMe(userId: number): Promise<MeResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: userRolesSelect,
        orgs: { select: { org: { select: { id: true, name: true } } } },
        emailAccounts: { select: { email: true } },
      },
    })

    if (!user) {
      throw new NotFoundException("用户不存在")
    }

    return {
      user: {
        id: user.id,
        username: user.username,
        phone: user.phone,
        email: user.emailAccounts[0]?.email ?? null,
        registerType: user.emailAccounts.length > 0 ? "EMAIL" : "PHONE",
        modelUnlocked: user.modelUnlocked,
        mustChangePassword: user.mustChangePassword,
        createdAt: user.createdAt.toISOString(),
      },
      roles: mergeUserRoles(user.roles),
      orgs: user.orgs.map(o => ({ id: o.org.id, name: o.org.name })),
      permissions: mergeUserPermissions(user.roles),
    }
  }

  async getPermissions(userId: number): Promise<PermissionsResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { roles: userRolesSelect },
    })

    if (!user) {
      throw new NotFoundException("用户不存在")
    }

    const permissions = mergeUserPermissions(user.roles)
    const groupCodes = [...new Set(permissions.map(p => p.groupCode))]
    const groups = await this.findPermissionGroups(groupCodes)

    return { permissions, groups }
  }

  /** 按分组编码取分组（sortOrder 升序）；Permission.groupCode 无外键关联，靠内存对齐 */
  private findPermissionGroups(codes: string[]): Promise<MePermissionGroupDto[]> {
    if (codes.length === 0) return Promise.resolve([])
    return this.prisma.permissionGroup.findMany({
      where: { code: { in: codes } },
      orderBy: { sortOrder: "asc" },
      select: { code: true, label: true, sortOrder: true },
    })
  }

  /** 修改自己的密码：校验原密码 → 写新密码 → 清除强制改密标记 */
  async changePassword(userId: number, oldPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true },
    })
    if (!user) throw new NotFoundException("用户不存在")

    const valid = await argon2.verify(user.password, oldPassword)
    if (!valid) throw new BadRequestException("原密码不正确")

    const password = await argon2.hash(newPassword)
    await this.prisma.user.update({
      where: { id: userId },
      data: { password, mustChangePassword: false },
    })
    return
  }

  private async touchLastLogin(userId: number) {
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } })
  }

  /**
   * 切换当前组织：校验用户确属该组织（传 null 则清空）→ 重签 token 写入 currentOrgId。
   */
  async switchOrg(userId: number, orgId: number | null) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: LOGIN_INCLUDE,
    })
    if (!user) throw new NotFoundException("用户不存在")

    if (orgId != null) {
      const member = await this.prisma.userOrganization.findUnique({
        where: { userId_orgId: { userId, orgId } },
        select: { userId: true },
      })
      if (!member) throw new ForbiddenException("你不属于该组织")
    }

    return this.generateToken(user, orgId ?? null)
  }

  private generateToken(
    user: { id: number; phone: string; roles: { role: { code: string } }[] },
    currentOrgId: number | null
  ) {
    // roleCode 为保留字段：取首个角色 code（单角色用户与旧行为一致），鉴权不依赖它
    const roleCode = user.roles[0]?.role.code ?? null
    const payload = { sub: user.id, phone: user.phone, roleCode, currentOrgId }
    return {
      access_token: this.jwtService.sign(payload),
    }
  }
}

/** 登录/切换组织重签 token 时取：首个角色 code + 首个组织 id */
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
