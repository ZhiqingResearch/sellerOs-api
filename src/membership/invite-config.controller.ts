import { Body, Controller, Param, ParseIntPipe, Patch, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { InviteConfigDto } from "./dto/invite.dto"
import { InviteService } from "./invite.service"

/**
 * 后台邀请配置：设某用户的 canInvite / 折扣 / 返利比例。
 * 守卫走 management.users 权限点（2026-08-30 起，与 admin/dist/* 全局返利规则、admin/subscriptions/* 同口径）：
 * 分销代理开关本质是用户属性管理，用户管理页（management.users）要直接开关；不再走充值白名单
 * （RechargeAccountGuard 只留真正的充值写接口：plan/pack/custom/manual/rebate-withdraw）。
 */
@ApiTags("后台分销")
@ApiBearerAuth()
@Controller("admin/users")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InviteConfigController {
  constructor(private readonly inviteService: InviteService) {}

  @Patch(":id/invite-config")
  @RequirePermissions("management.users")
  @ApiOperation({
    summary: "设置邀请配置（开/关邀请——只发邀请码，不动套餐/积分/等级；折扣；返利比例）",
  })
  setInviteConfig(@Param("id", ParseIntPipe) id: number, @Body() dto: InviteConfigDto) {
    return this.inviteService.setInviteConfig(id, dto)
  }
}
