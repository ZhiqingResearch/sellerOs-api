import { Body, Controller, Param, ParseIntPipe, Patch, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { AdminRechargeService } from "./admin-recharge.service"
import { RechargeFlagDto } from "./dto/admin-recharge.dto"

/**
 * 充值操作员名单维护：开/关账号的 canRecharge（账号级白名单）。
 * 用「用户管理」权限点把守（超管/用户管理员可维护名单），与「能否充值」本身解耦。
 */
@ApiTags("后台充值")
@ApiBearerAuth()
@Controller("admin/users")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RechargeFlagController {
  constructor(private readonly service: AdminRechargeService) {}

  @Patch(":id/recharge-flag")
  @RequirePermissions("management.users")
  @ApiOperation({ summary: "开/关某账号的后台充值权限（账号级白名单，运行时增减，无需重新部署）" })
  setRechargeFlag(@Param("id", ParseIntPipe) id: number, @Body() dto: RechargeFlagDto) {
    return this.service.setRechargeFlag(id, dto.canRecharge)
  }
}
