import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PaginationDto } from "../common/dto/pagination.dto"
import {
  AddMemberDto,
  BatchQuotaDto,
  BatchSaveModelsDto,
  QueryUsageDto,
  UpdateMemberQuotaDto,
  UpdateMemberRoleDto,
  UpdateMemberStatusDto,
  UpdateSettingsDto,
} from "./dto/console.dto"
import { TeamModelConfigService } from "./team-model-config.service"
import { TeamQuotaService } from "./team-quota.service"
import { TeamUsageService } from "./team-usage.service"
import { TeamConsoleContext, TeamService } from "./team.service"

/**
 * 企业控制台（企业管理员/成员侧）：总览/成员/配额/模型/用量/设置 六组。
 * 角色判定走 TeamMember（非平台权限点）：管理动作须本团队 ACTIVE 管理员。
 */
@ApiTags("企业团队管理")
@ApiBearerAuth()
@Controller("team")
@UseGuards(JwtAuthGuard)
export class TeamConsoleController {
  constructor(
    private readonly team: TeamService,
    private readonly quota: TeamQuotaService,
    private readonly models: TeamModelConfigService,
    private readonly usage: TeamUsageService
  ) {}

  /** 当前用户上下文（404=未加入团队） */
  private ctx(req: { user: { id: number } }): Promise<TeamConsoleContext> {
    return this.team.requireConsoleContext(req.user.id)
  }

  /** 企业管理动作上下文：须本团队 ACTIVE 管理员 */
  private async adminCtx(req: { user: { id: number } }): Promise<TeamConsoleContext> {
    const ctx = await this.ctx(req)
    this.team.requireTeamAdmin(ctx)
    return ctx
  }

  /** 只读动作上下文：本团队 ACTIVE 管理员；归档团队的归档管理员只读查看历史数据 */
  private async readCtx(req: { user: { id: number } }): Promise<TeamConsoleContext> {
    const ctx = await this.ctx(req)
    this.team.requireTeamAdminRead(ctx)
    return ctx
  }

  // ==================== 身份条 / 总览 ====================

  @Get()
  @ApiOperation({ summary: "顶部身份条：企业信息 + 我的角色（各 Tab 常驻）" })
  async identity(@Request() req: { user: { id: number } }) {
    return this.team.identity(await this.ctx(req))
  }

  @Get("overview")
  @ApiOperation({
    summary: "总览：6 统计卡（池套餐/充值/本月消耗/剩余/席位/成员）+ 待处理提醒聚合",
  })
  async overview(@Request() req: { user: { id: number } }) {
    const ctx = await this.readCtx(req)
    return this.team.overview(ctx.team.id)
  }

  // ==================== 成员管理 ====================

  @Get("members")
  @ApiOperation({ summary: "成员列表（角色/状态/本月已用/个人上限/剩余）" })
  async members(@Request() req: { user: { id: number } }) {
    const ctx = await this.readCtx(req)
    return this.team.listMembers(ctx.team.id)
  }

  @Post("members")
  @ApiOperation({
    summary: "添加成员：已存在账号（手机号/邮箱）直接拉入；新手机号开账号（初始密码+强制改密）",
  })
  async addMember(@Request() req: { user: { id: number } }, @Body() dto: AddMemberDto) {
    const ctx = await this.adminCtx(req)
    return this.team.addMember(ctx.team.id, req.user.id, dto)
  }

  @Delete("members/:userId")
  @ApiOperation({ summary: "移出成员：退回个人计费（管理员不可移出，须先指定新管理员）" })
  async removeMember(
    @Request() req: { user: { id: number } },
    @Param("userId", ParseIntPipe) userId: number
  ) {
    const ctx = await this.adminCtx(req)
    return this.team.removeMember(ctx.team.id, req.user.id, userId)
  }

  @Patch("members/:userId/role")
  @ApiOperation({ summary: "设为管理员（移交，原管理员降为成员）/ 设为成员" })
  async setMemberRole(
    @Request() req: { user: { id: number } },
    @Param("userId", ParseIntPipe) userId: number,
    @Body() dto: UpdateMemberRoleDto
  ) {
    const ctx = await this.adminCtx(req)
    return this.team.setMemberRole(ctx.team.id, req.user.id, userId, dto.role)
  }

  @Patch("members/:userId/status")
  @ApiOperation({ summary: "停用 / 启用成员（管理员不可停用）" })
  async setMemberStatus(
    @Request() req: { user: { id: number } },
    @Param("userId", ParseIntPipe) userId: number,
    @Body() dto: UpdateMemberStatusDto
  ) {
    const ctx = await this.adminCtx(req)
    return this.team.setMemberStatus(ctx.team.id, req.user.id, userId, dto.status)
  }

  @Patch("members/:userId/quota")
  @ApiOperation({ summary: "调整成员月度上限（SHARED 封顶 / INDEPENDENT 配额；null=不限）" })
  async setMemberQuota(
    @Request() req: { user: { id: number } },
    @Param("userId", ParseIntPipe) userId: number,
    @Body() dto: UpdateMemberQuotaDto
  ) {
    const ctx = await this.adminCtx(req)
    return this.quota.setMemberQuota(ctx.team.id, req.user.id, userId, dto.monthlyQuota ?? null)
  }

  @Post("members/batch-quota")
  @ApiOperation({ summary: "批量分配月度上限（统一设置，不覆盖管理员）" })
  async batchQuota(@Request() req: { user: { id: number } }, @Body() dto: BatchQuotaDto) {
    const ctx = await this.adminCtx(req)
    return this.quota.batchSetQuota(ctx.team.id, req.user.id, dto.monthlyQuota ?? null)
  }

  // ==================== 积分与配额 ====================

  @Get("quota")
  @ApiOperation({ summary: "积分与配额：积分模式/超额策略 + 池卡片 + 成员月度上限列表" })
  async quotaTab(@Request() req: { user: { id: number } }) {
    const ctx = await this.readCtx(req)
    return this.quota.listQuota(ctx.team.id)
  }

  // ==================== 模型配置 ====================

  @Get("models/catalog")
  @ApiOperation({ summary: "模型目录：在架模型按类型分组（配置页选项池）" })
  async modelCatalog(@Request() req: { user: { id: number } }) {
    await this.readCtx(req)
    return this.models.getCatalog()
  }

  @Get("models")
  @ApiOperation({
    summary: "模型配置整页数据：全局默认 + 全部功能模块（未配置=null=跟随全局默认）",
  })
  async modelConfig(@Request() req: { user: { id: number } }) {
    const ctx = await this.readCtx(req)
    return this.models.getConfig(ctx.team.id)
  }

  @Put("models")
  @ApiOperation({
    summary: "批量保存模型配置：全局默认 + 全部功能模块一次提交（单事务，整页生效）",
  })
  async saveModels(@Request() req: { user: { id: number } }, @Body() dto: BatchSaveModelsDto) {
    const ctx = await this.adminCtx(req)
    return this.models.batchSave(ctx.team.id, req.user.id, dto)
  }

  // ==================== 用量分析 ====================

  @Get("usage")
  @ApiOperation({
    summary: "用量分析：按成员/功能/模型聚合（dimension=member|source|model，默认本月）",
  })
  async usageAggregate(@Request() req: { user: { id: number } }, @Query() query: QueryUsageDto) {
    const ctx = await this.readCtx(req)
    return this.usage.aggregate(ctx.team.id, query)
  }

  @Get("usage/export")
  @ApiOperation({ summary: "用量分析 CSV 导出（带 BOM）" })
  @Header("Content-Type", "text/csv; charset=utf-8")
  async usageExport(@Request() req: { user: { id: number } }, @Query() query: QueryUsageDto) {
    const ctx = await this.readCtx(req)
    return this.usage.exportCsv(ctx.team.id, query)
  }

  // ==================== 生命周期 ====================

  @Post(":id/archive")
  @ApiOperation({
    summary:
      "提前归档（仅 GRACE，本团队 ACTIVE 管理员）：套餐/赠送池清零、充值池退管理员、成员释放；幂等",
  })
  async archive(@Request() req: { user: { id: number } }, @Param("id", ParseIntPipe) id: number) {
    return this.team.archiveEarly(id, req.user.id)
  }

  // ==================== 设置与日志 ====================

  @Get("settings")
  @ApiOperation({ summary: "设置：企业信息（名称/版本·席位/管理员/积分模式/超额策略）" })
  async settings(@Request() req: { user: { id: number } }) {
    const ctx = await this.readCtx(req)
    return this.team.getSettings(ctx.team.id)
  }

  @Patch("settings")
  @ApiOperation({ summary: "更新设置：企业名称 / 积分模式 / 超额策略（模式切换写审计）" })
  async updateSettings(@Request() req: { user: { id: number } }, @Body() dto: UpdateSettingsDto) {
    const ctx = await this.adminCtx(req)
    return this.team.updateSettings(ctx.team.id, req.user.id, dto)
  }

  @Get("audit-logs")
  @ApiOperation({ summary: "操作审计日志（成员增删/额度调整/模式切换/续费/停用等，分页）" })
  async auditLogs(@Request() req: { user: { id: number } }, @Query() query: PaginationDto) {
    const ctx = await this.readCtx(req)
    return this.team.listAuditLogs(ctx.team.id, query.page, query.pageSize)
  }
}
