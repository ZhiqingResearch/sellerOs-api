import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PaginationDto } from "../common/dto/pagination.dto"
import { QueryInviteesDto, RebateWithdrawDto, UpdateInviteeStatusDto } from "./dto/invite.dto"
import { QueryTransactionsDto } from "./dto/wallet.dto"
import { InviteService } from "./invite.service"

/** 邀请人自助：我的邀请码/返利、审批被邀请申请、返利提现。 */
@ApiTags("邀请分销")
@ApiBearerAuth()
@Controller("membership")
@UseGuards(JwtAuthGuard)
export class MembershipInviteController {
  constructor(private readonly inviteService: InviteService) {}

  @Get("invite")
  @ApiOperation({ summary: "我的邀请：邀请码(7天)、返利汇总、待审批申请（需已开通邀请权限）" })
  myInvite(@Request() req: { user: { id: number } }) {
    return this.inviteService.getMyInvite(req.user.id)
  }

  @Get("invite/tree")
  @ApiOperation({
    summary:
      "我的邀请团队关系树（C 端分销页；结构同后台 admin/dist/tree：本体 + 一级（本月消耗/贡献返利/二级数，内嵌二级分页））",
  })
  myInviteTree(@Request() req: { user: { id: number } }, @Query() query: PaginationDto) {
    return this.inviteService.getMyTree(req.user.id, query)
  }

  @Post("invite/refresh-code")
  @ApiOperation({ summary: "手动刷新邀请码（旧码立即失效）" })
  refreshCode(@Request() req: { user: { id: number } }) {
    return this.inviteService.refreshCode(req.user.id)
  }

  @Get("invitees")
  @ApiOperation({
    summary:
      "我邀请的用户列表（分页；含角色/总额度/已消耗/剩余/状态/贡献返利；可搜索/按角色筛/排序）",
  })
  invitees(@Request() req: { user: { id: number } }, @Query() query: QueryInviteesDto) {
    return this.inviteService.listInvitees(req.user.id, query)
  }

  @Patch("invitees/:userId/status")
  @ApiOperation({ summary: "停用 / 启用我邀请的下级账号（仅限自己邀请的用户）" })
  setInviteeStatus(
    @Param("userId", ParseIntPipe) userId: number,
    @Request() req: { user: { id: number } },
    @Body() dto: UpdateInviteeStatusDto
  ) {
    return this.inviteService.setInviteeStatus(req.user.id, userId, dto.isActive)
  }

  @Post("invitees/:userId/reset-password")
  @ApiOperation({
    summary: "重置我邀请的下级密码为系统默认密码（仅限自己邀请的用户；强制改密，不发短信）",
  })
  resetInviteePassword(
    @Param("userId", ParseIntPipe) userId: number,
    @Request() req: { user: { id: number } }
  ) {
    return this.inviteService.resetInviteePassword(req.user.id, userId)
  }

  @Get("invitees/:userId/transactions")
  @ApiOperation({ summary: "查看某下级的积分流水（充值/使用，分页；仅限自己邀请的用户）" })
  inviteeTransactions(
    @Param("userId", ParseIntPipe) userId: number,
    @Request() req: { user: { id: number } },
    @Query() query: QueryTransactionsDto
  ) {
    return this.inviteService.listInviteeTransactions(req.user.id, userId, query)
  }

  @Post("invite/applications/:id/approve")
  @ApiOperation({ summary: "审批通过：被邀请人成为普通用户 + 200 赠送积分（计 1 个邀请名额）" })
  approve(@Param("id", ParseIntPipe) id: number, @Request() req: { user: { id: number } }) {
    return this.inviteService.approve(id, req.user.id)
  }

  @Post("invite/applications/:id/reject")
  @ApiOperation({ summary: "拒绝申请（可再次邀请）" })
  reject(@Param("id", ParseIntPipe) id: number, @Request() req: { user: { id: number } }) {
    return this.inviteService.reject(id, req.user.id)
  }

  @Get("rebate/withdrawals")
  @ApiOperation({ summary: "返利提现明细（分页）" })
  withdrawals(@Request() req: { user: { id: number } }, @Query() query: PaginationDto) {
    return this.inviteService.listWithdrawals(req.user.id, query)
  }

  @Post("rebate/withdraw")
  @ApiOperation({ summary: "返利提现" })
  withdraw(@Request() req: { user: { id: number } }, @Body() dto: RebateWithdrawDto) {
    return this.inviteService.withdraw(req.user.id, dto.amount, dto.note)
  }
}
