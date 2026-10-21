import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { AuthenticatedUser } from "../types"

const DEFAULT_INTERNAL_PHONE = "18888888888"

/**
 * 内部账号身份门：菜单/路由配置仅限内部账号，连超级管理员也挡在外面。
 *
 * 为什么不用权限点（@RequirePermissions）：超管 matcher 为 () => true，在库里真实持有
 * 每一条权限，后端也无 admin 旁路，"唯独管理员不能"无法用权限表达 —— 只能按身份卡。
 *
 * 内部手机号白名单经环境变量 INTERNAL_ACCOUNT_PHONE 配置（逗号分隔多个），默认 18888888888。
 */
@Injectable()
export class InternalAccountGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>()
    const phone = req.user?.phone
    if (!phone || !this.whitelist().has(phone)) {
      throw new ForbiddenException("无权限访问菜单配置")
    }
    return true
  }

  private whitelist(): Set<string> {
    const raw = this.config.get<string>("INTERNAL_ACCOUNT_PHONE") ?? DEFAULT_INTERNAL_PHONE
    return new Set(
      raw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    )
  }
}
