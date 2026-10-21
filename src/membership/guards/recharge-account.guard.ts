import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { AuthenticatedUser } from "../../auth/types"
import { RechargeAccessService } from "../recharge-access.service"
import { RECHARGE_READ_KEY } from "./recharge-read.decorator"

/**
 * 后台充值账号门：仅 User.canRecharge=true 的账号可访问，**连超级管理员也挡**
 * （权限点无法表达"唯独某账号"，见 InternalAccountGuard 的同款理由）。
 * 例外：标注 @RechargeRead() 的只读路由本门放行（由方法级 PermissionsGuard 把守权限点）。
 */
@Injectable()
export class RechargeAccountGuard implements CanActivate {
  constructor(
    private readonly access: RechargeAccessService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>()
    const userId = req.user?.id
    if (!userId) throw new UnauthorizedException("未登录")
    // 只读放行口（个人订阅页查充值记录等）：本门不挡，交给方法级 PermissionsGuard 校验权限点
    if (this.reflector.getAllAndOverride<boolean>(RECHARGE_READ_KEY, [ctx.getHandler()])) {
      return true
    }
    if (!(await this.access.canRecharge(userId))) {
      throw new ForbiddenException("无后台充值权限")
    }
    return true
  }
}
