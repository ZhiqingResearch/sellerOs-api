import { Injectable, UnauthorizedException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { PassportStrategy } from "@nestjs/passport"
import { ExtractJwt, Strategy } from "passport-jwt"
import { PrismaService } from "../../prisma/prisma.service"
import { AuthenticatedUser } from "../types"

export interface JwtPayload {
  sub: number
  phone: string
  roleCode: string | null
  currentOrgId?: number | null
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>("JWT_SECRET") as string,
    })
  }

  /**
   * 每次请求实时校验账号状态：token 有效 ≠ 账号仍可用。
   * 用户被删除或被停用后，旧 token 立即失效（抛 401），前端据此跳转登录。
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { isActive: true },
    })
    if (!user) {
      throw new UnauthorizedException("用户不存在")
    }
    if (!user.isActive) {
      throw new UnauthorizedException("账号已停用")
    }

    return {
      id: payload.sub,
      phone: payload.phone,
      roleCode: payload.roleCode ?? null,
      currentOrgId: payload.currentOrgId ?? null,
    }
  }
}
