import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common"
import { hasPermission } from "../../auth/guards/permissions.guard"
import { PermissionCacheService } from "../../auth/services/permission-cache.service"
import { AuthenticatedUser } from "../../auth/types"
import type { ListingAiOperation } from "../dto/listing-ai.dto"

const LISTING_GENERATE_PERMISSION = "tool.listing_generate"
const LISTING_SCORE_PERMISSION = "tool.listing_score"

interface ListingAiRequest {
  user?: AuthenticatedUser
  body?: { operation?: ListingAiOperation }
}

@Injectable()
export class ListingAiPermissionGuard implements CanActivate {
  constructor(private readonly permissionCache: PermissionCacheService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ListingAiRequest>()
    const user = request.user
    if (!user) throw new UnauthorizedException("未登录")

    const ownedKeys = await this.permissionCache.getForUser(user.id)
    const operation = request.body?.operation
    const allowedKeys =
      operation === "score"
        ? [LISTING_SCORE_PERMISSION, LISTING_GENERATE_PERMISSION]
        : [LISTING_GENERATE_PERMISSION]

    if (allowedKeys.some(key => hasPermission(ownedKeys, key))) return true

    const labelByKey = await this.permissionCache.getLabelMap()
    const labels = allowedKeys.map(key => labelByKey.get(key) ?? key)
    throw new ForbiddenException(`缺少权限：${labels.join("或")}`)
  }
}
