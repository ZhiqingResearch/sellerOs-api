import {
  Body,
  Controller,
  Delete,
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
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import {
  AdjustTeamDto,
  AdminAddMemberDto,
  CreateCustomTeamDto,
  QueryTeamsDto,
  RestoreTeamDto,
  UpdateTeamDto,
} from "./dto/admin.dto"
import { TeamService } from "./team.service"

/**
 * 客户运营 · 企业管理（平台侧）：平台定制企业开通/编辑/调整/停用/启用/恢复 + 成员管理。
 * 复用 management.users 权限点（平台 ADMIN），与企业侧控制台（/api/team）互不相通。
 */
@ApiTags("客户运营-企业管理")
@ApiBearerAuth()
@Controller("admin/teams")
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions("management.users")
export class TeamAdminController {
  constructor(private readonly team: TeamService) {}

  @Get()
  @ApiOperation({
    summary: "企业列表（状态胶囊带计数：全部/生效中/即将到期/冻结中/已归档/已停用 + 筛选分页）",
  })
  list(@Query() query: QueryTeamsDto) {
    return this.team.listTeams(query)
  }

  @Post()
  @ApiOperation({
    summary:
      "新建企业（平台定制：席位/积分池/折扣/到期日自定义；合同金额留痕，不走订单不开发收据）",
  })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateCustomTeamDto) {
    return this.team.createCustomTeam(req.user.id, dto)
  }

  @Get(":id")
  @ApiOperation({ summary: "企业详情（含席位成员子表 + 池概况）" })
  detail(@Param("id", ParseIntPipe) id: number) {
    return this.team.getAdminTeamDetail(id)
  }

  @Patch(":id")
  @ApiOperation({
    summary: "编辑企业（名称/席位/到期日/折扣/合同；席位不得低于在用，自助购买折扣固定 1）",
  })
  update(
    @Request() req: { user: { id: number } },
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateTeamDto
  ) {
    return this.team.updateTeam(id, req.user.id, dto)
  }

  @Post(":id/adjust")
  @ApiOperation({
    summary: "调整（客服补偿）：赠送池充值积分（可负数扣减，不得超剩余）/ 延长有效期",
  })
  adjust(
    @Request() req: { user: { id: number } },
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: AdjustTeamDto
  ) {
    return this.team.adjustTeam(id, req.user.id, dto)
  }

  @Post(":id/disable")
  @ApiOperation({ summary: "停用企业：成员退回个人计费、共享池冻结（可重新启用）" })
  disable(@Request() req: { user: { id: number } }, @Param("id", ParseIntPipe) id: number) {
    return this.team.disableTeam(id, req.user.id)
  }

  @Post(":id/enable")
  @ApiOperation({
    summary: "重新启用：DISABLED → ACTIVE（有效期不变；已加入他企的成员跳过并列出）",
  })
  enable(@Request() req: { user: { id: number } }, @Param("id", ParseIntPipe) id: number) {
    return this.team.enableTeam(id, req.user.id)
  }

  @Post(":id/restore")
  @ApiOperation({ summary: "恢复团队：GRACE/ARCHIVED → ACTIVE（按天数重算有效期；成员名单接回）" })
  restore(
    @Request() req: { user: { id: number } },
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RestoreTeamDto
  ) {
    return this.team.restoreTeam(id, dto.periodDays, req.user.id)
  }

  @Post(":id/members")
  @ApiOperation({ summary: "拉入已存在成员（唯一归属校验 + 席位满拦截 + 终止个人套餐）" })
  addMember(
    @Request() req: { user: { id: number } },
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: AdminAddMemberDto
  ) {
    return this.team.joinExistingUser(id, req.user.id, dto.userId)
  }

  @Delete(":id/members/:userId")
  @ApiOperation({ summary: "移出成员（管理员不可移出，须先指定新管理员）" })
  removeMember(
    @Request() req: { user: { id: number } },
    @Param("id", ParseIntPipe) id: number,
    @Param("userId", ParseIntPipe) userId: number
  ) {
    return this.team.removeMember(id, req.user.id, userId)
  }
}
