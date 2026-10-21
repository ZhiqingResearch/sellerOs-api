import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { PERMISSIONS_METADATA_KEY } from "../decorators/require-permissions.decorator"
import { PermissionCacheService } from "../services/permission-cache.service"
import { AuthenticatedUser } from "../types"

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionCache: PermissionCacheService
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSIONS_METADATA_KEY,
      [ctx.getHandler(), ctx.getClass()]
    )
    if (!required || required.length === 0) return true

    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>()
    const user = req.user
    if (!user) throw new UnauthorizedException("未登录")

    const ownedKeys = await this.permissionCache.getForUser(user.id)
    const missing = required.filter(k => !hasPermission(ownedKeys, k))
    if (missing.length > 0) {
      // 把原始权限 key 映射成中文菜单名，缺映射时回退到 key 本身
      const labelByKey = await this.permissionCache.getLabelMap()
      const missingLabels = missing.map(k => labelByKey.get(k) ?? k)
      throw new ForbiddenException(`缺少权限：${missingLabels.join("、")}`)
    }
    return true
  }
}

export function hasPermission(owned: Set<string>, required: string): boolean {
  if (owned.has(required)) return true
  // 父级隐含子级：持有 tool 隐含持有 tool.x；持有 management.product 隐含持有 management.product.reports
  const parts = required.split(".")
  for (let i = parts.length - 1; i > 0; i--) {
    const parent = parts.slice(0, i).join(".")
    if (owned.has(parent)) return true
  }
  return false
}
