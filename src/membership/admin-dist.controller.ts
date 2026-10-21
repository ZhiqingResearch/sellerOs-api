import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { PaginationDto } from "../common/dto/pagination.dto"
import { AdminDistService } from "./admin-dist.service"
import {
  QueryAdminApplicationsDto,
  QueryDistTreeDto,
  UpdateRebateRulesDto,
} from "./dto/admin-dist.dto"
import { InviteService } from "./invite.service"

/**
 * 后台分销管理：全局返利规则 + 分销关系树（只读聚合）+ CSV 导出 + 运营侧被邀申请审批队列。
 * 与后台用户管理同走 management.users 权限点（超管/用户管理员）。
 */
@ApiTags("后台分销")
@ApiBearerAuth()
@Controller("admin/dist")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminDistController {
  constructor(
    private readonly service: AdminDistService,
    private readonly inviteService: InviteService
  ) {}

  @Get("rebate-rules")
  @RequirePermissions("management.users")
  @ApiOperation({ summary: "查看全局返利规则（无配置行时返回默认值，不落库）" })
  getRebateRules() {
    return this.service.getRebateRules()
  }

  @Patch("rebate-rules")
  @RequirePermissions("management.users")
  @ApiOperation({ summary: "更新全局返利规则（upsert 单行；全部可选但至少传一项；null=清除封顶）" })
  updateRebateRules(@Body() dto: UpdateRebateRulesDto) {
    return this.service.updateRebateRules(dto)
  }

  @Post("rebate-rules/preview")
  @RequirePermissions("management.users")
  @ApiOperation({
    summary:
      "返利成本试算（不落库）：按近 30 天真实消耗 + 草稿规则参数回放预计返利；返利/消耗>50% 返回 highRisk+riskMessage（2026-08-31）",
  })
  previewRebateRules(@Body() dto: UpdateRebateRulesDto) {
    return this.service.previewRebateRules(dto)
  }

  @Get("applications")
  @RequirePermissions("management.users")
  @ApiOperation({
    summary:
      "被邀注册申请队列（运营侧，2026-08-31）：全平台申请分页；status 过滤（审批队列传 PENDING）；keyword 搜申请人/邀请人；手机号脱敏",
  })
  listApplications(@Query() query: QueryAdminApplicationsDto) {
    return this.inviteService.listApplicationsAdmin(query)
  }

  @Post("applications/:id/approve")
  @RequirePermissions("management.users")
  @ApiOperation({
    summary:
      "运营代审批通过（2026-08-31）：与邀请人自审同口径（邀请人有效邀请权/名额/原子认领/建号+200 赠送积分）",
  })
  approveApplication(@Param("id", ParseIntPipe) id: number) {
    return this.inviteService.approveByAdmin(id)
  }

  @Post("applications/:id/reject")
  @RequirePermissions("management.users")
  @ApiOperation({ summary: "运营代驳回（2026-08-31）：原子认领 PENDING，释放待审手机号占用" })
  rejectApplication(@Param("id", ParseIntPipe) id: number) {
    return this.inviteService.rejectByAdmin(id)
  }

  @Get("users/:id/invite-rebate-detail")
  @RequirePermissions("management.users")
  @ApiOperation({
    summary:
      "邀请配置弹窗扩展数据（2026-08-31）：rebate 汇总（关闭确认弹窗）+ 一/二级人数 + corpKids 逐人「进企业仍计返利」列表 + upstreamRebateRate 只读",
  })
  getInviteRebateDetail(@Param("id", ParseIntPipe) id: number) {
    return this.service.getInviteRebateDetail(id)
  }

  @Get("tree")
  @RequirePermissions("management.users")
  @ApiOperation({
    summary:
      "分销关系树：用户本体 + 一级列表（本月消耗/贡献返利/二级数，内嵌二级分页）；scope 成员范围筛选 all/inviter/team/personal（2026-08-31）",
  })
  getTree(@Query() query: QueryDistTreeDto) {
    return this.service.getTree(query)
  }

  @Get("tree/export")
  @RequirePermissions("management.users")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiOperation({ summary: "分销关系树 CSV 导出（带 BOM，全量不分页）" })
  exportTree(@Query("userId", ParseIntPipe) userId: number) {
    return this.service.exportCsv(userId)
  }

  @Get("export")
  @RequirePermissions("management.users")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiOperation({
    summary:
      "全局分销关系 CSV 导出（2026-09-02 bug29）：全部网络一次导出，字段按原型（姓名/手机号/邀请人/身份/直接下线/消耗/返利归属/企业归属），消耗与返利归属全历史累计口径",
  })
  exportAll() {
    return this.service.exportAllCsv()
  }

  @Get("dashboard")
  @RequirePermissions("management.users")
  @ApiOperation({
    summary:
      "邀请分销概览（用量看板）：汇总卡（可邀请用户/累计邀请注册/被邀用户累计消耗/累计返佣）+ 分销代理明细（返利倒序，分页）",
  })
  getDashboard(@Query() query: PaginationDto) {
    return this.service.getDashboard(query)
  }
}
