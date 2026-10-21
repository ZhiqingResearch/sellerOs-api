import { FixedModulePrecheckDto } from "./dto/fixed-module-precheck.dto"
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { ChargeMcpDto } from "./dto/charge-mcp.dto"
import { ChargeTokensDto } from "./dto/charge-tokens.dto"
import {
  GenerationRecordModelOptionDto,
  QueryGenerationRecordModelOptionsDto,
  QueryGenerationRecordsDto,
} from "./dto/query-generation-records.dto"
import { QueryUsageLogsDto } from "./dto/query-usage-logs.dto"
import { QueryUsageStatsDto } from "./dto/query-usage-stats.dto"
import { UsageDeductV2Dto } from "./dto/usage-deduct-v2.dto"
import { UsageDeductDto } from "./dto/usage-deduct.dto"
import { GenerationRecordService } from "./generation-record.service"
import { UsageService } from "./usage.service"

@ApiTags("用量与额度")
@ApiBearerAuth()
@Controller("usage")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class UsageController {
  constructor(
    private readonly usageService: UsageService,
    private readonly generationRecordService: GenerationRecordService
  ) {}

  @Post("fixed-module/precheck")
  @ApiOperation({ summary: "固定积分功能启动前校验余额，不扣费" })
  precheckFixedModule(@Request() req: { user: { id: number } }, @Body() dto: FixedModulePrecheckDto) {
    return this.usageService.assertFixedModuleAffordable(req.user.id, dto.source, dto.operation, dto.generationBillingId, dto.quantity)
  }

  @Get("balance")
  @ApiOperation({ summary: "查询积分钱包（各桶余额、等级、本月已用、累计消耗）" })
  getBalance(@Request() req: { user: { id: number } }) {
    return this.usageService.getBalance(req.user.id)
  }

  @Get("source-options")
  @ApiOperation({
    summary: "用量/积分明细「来源」筛选下拉项",
    description:
      "返回 [{ value, label }]：value=完整 source（作为列表筛选的 source 参数）、label=中文模块名；首项为「全部」(value 空串)。与积分明细「项目」列同源，前端直接渲染、不要再硬编码。",
  })
  getSourceOptions() {
    return this.usageService.getSourceOptions()
  }

  @Get("logs")
  @ApiOperation({ summary: "分页查询用量流水" })
  listLogs(@Request() req: { user: { id: number } }, @Query() query: QueryUsageLogsDto) {
    return this.usageService.listLogs(req.user.id, query)
  }

  @Get("generation-records/model-options")
  @RequirePermissions("company.admin")
  @ApiOperation({
    summary: "用户生成记录模型筛选选项（管理员）",
    description:
      "按 keyword / orgId / roleId / function / dateFrom / dateTo 对完整记录集筛选后返回去重模型；不受列表分页和当前 model 影响。前端自行追加「全部模型」。",
  })
  @ApiOkResponse({ type: GenerationRecordModelOptionDto, isArray: true })
  getGenerationRecordModelOptions(@Query() query: QueryGenerationRecordModelOptionsDto) {
    return this.generationRecordService.getModelOptions(query)
  }

  @Get("generation-records")
  @RequirePermissions("company.admin")
  @ApiOperation({
    summary: "用户生成记录（管理员）",
    description:
      "跨用户列出图片 / 视频创作 / 影刀 RPA / 灵感雷达记录（合并 GenerationTask + ImageGenJob + VideoTask + RpaCreationTask + InspirationSubscription 最近刷新），含用户、组织、角色、提示词、模型、扣除积分、时间、结果。RPA 图片归入 IMAGE、RPA 视频归入 VIDEO；AI 拆图按任务组（groupId）聚合为一行并入 IMAGE，积分含工作流阶段 + 终态生图全部流水；通用生图 t2i/i2i（ImageGenJob）按 jobId 一行并入 IMAGE，积分按 UsageLog.meta.jobId 反查。支持 keyword(姓名/手机号/提示词/订阅名) / orgId / roleId / function(IMAGE|VIDEO|INSPIRATION_RADAR) / model / dateFrom / dateTo 筛选 + 分页，并返回筛选集累计实扣积分。",
  })
  listGenerationRecords(@Query() query: QueryGenerationRecordsDto) {
    return this.generationRecordService.list(query)
  }

  @Get("stats-by-user")
  @RequirePermissions("company.admin")
  @ApiOperation({
    summary: "按用户聚合积分消耗（管理员）",
    description:
      "返回列表：用户名、手机号、等级、剩余积分(各桶可消费 remaining 之和)、已消耗积分、总 tokens、角色、权限明细。按已消耗 DESC 排序，无使用记录的用户也会返回。period：LAST_7_DAYS/THIS_MONTH/LAST_MONTH/ALL，默认 THIS_MONTH。",
  })
  statsByUser(@Query() query: QueryUsageStatsDto) {
    return this.usageService.statsByUser(query)
  }

  @Get("stats-summary")
  @RequirePermissions("company.admin")
  @ApiOperation({
    summary: "全站汇总：剩余积分 / 已消耗积分 / 总消耗 tokens（管理员）",
    description: "period 同 stats-by-user，默认 THIS_MONTH。",
  })
  statsSummary(@Query() query: QueryUsageStatsDto) {
    return this.usageService.statsSummary(query)
  }

  @Get("stats-by-user/:userId/sources")
  @RequirePermissions("company.admin")
  @ApiOperation({
    summary: "指定用户的 source 消耗明细（管理员）",
    description:
      "按 source 聚合积分消耗，返回 (source, totalConsumed, totalTokens, callCount)，按已消耗 DESC。period 同 stats-by-user，默认 THIS_MONTH。",
  })
  statsSourcesByUser(
    @Param("userId", ParseIntPipe) userId: number,
    @Query() query: QueryUsageStatsDto
  ) {
    return this.usageService.statsSourcesByUser(userId, query)
  }

  @Get("my-sources")
  @ApiOperation({
    summary: "我的分功能用量（本人口径）",
    description:
      "与 stats-by-user/:userId/sources 同结构同口径（source, totalConsumed, totalTokens, callCount；period 默认 THIS_MONTH），但固定查当前登录人、无需 company.admin 权限。C 端分销页「我各功能的积分使用情况」（被邀请人视角，产品 §7.3）走这里。",
  })
  mySources(@Request() req: { user: { id: number } }, @Query() query: QueryUsageStatsDto) {
    return this.usageService.statsSourcesByUser(req.user.id, query)
  }

  @Post("token")
  @ApiOperation({ summary: "提交 token 消耗（自动扣费）" })
  chargeTokens(@Request() req: { user: { id: number } }, @Body() dto: ChargeTokensDto) {
    return this.usageService.chargeTokens(req.user.id, dto)
  }

  @Post("mcp")
  @ApiOperation({ summary: "提交 MCP 调用次数（自动扣费）" })
  chargeMcp(@Request() req: { user: { id: number } }, @Body() dto: ChargeMcpDto) {
    return this.usageService.chargeMcp(req.user.id, dto)
  }

  /**
   * 公共扣款（前端用）：扣登录用户自己的积分，入参为人民币金额。
   * 后端模块若要主动扣某用户积分，请直接调 `UsageService.deductCustom(userId, costCny, opts)`
   * （可对任意 userId、可走 allowOverdraft），不要经此 HTTP 端点。
   */
  @Post("deduct")
  @ApiOperation({
    summary: "公共扣款：按人民币金额扣登录用户自己的积分",
    description:
      "扣 req.user.id 自己的积分；costCny 为人民币元，服务端按「1元=10积分 × 用户折扣，向上取整」自动换算（与 /usage/token 同一换算口径）。复用统一扣费内核（桶优先级 + 行锁 + 跨池共享 + 返利 + 流水），仅写积分流水、不写用量日志。不接收 userId、不暴露透支。",
  })
  deduct(@Request() req: { user: { id: number } }, @Body() dto: UsageDeductDto) {
    return this.usageService.deductCustom(req.user.id, dto.costCny, {
      source: dto.source,
      meta: dto.meta,
    })
  }

  /**
   * 公共扣费 v2（前端用）：大模型底座计费——扣登录用户自己的积分，记功能模块 + 模型，写用量日志。
   * 后端模块若要主动扣某用户积分，请直接调 `UsageService.chargeModel(userId, costCny, params)`。
   */
  @Post("deduct/v2")
  @ApiOperation({
    summary: "公共扣费 v2：大模型底座计费（人民币金额 + 功能模块 + 模型）",
    description:
      "扣 req.user.id 自己的积分；costCny 为底座返回的人民币成本，按 1元=10积分 × 用户折扣换算（与 /usage/token 同口径）。source 须在功能模块注册表（未登记 400），model 必填；双写积分流水 + 用量日志（用量分析功能/模型维度可见）；requestId 幂等（重复提交返回首次结果 duplicate=true）。归属企业团队的用户自动路由共享池扣费。",
  })
  deductV2(@Request() req: { user: { id: number } }, @Body() dto: UsageDeductV2Dto) {
    return this.usageService.chargeModel(req.user.id, dto.costCny, {
      source: dto.source,
      model: dto.model,
      meta: dto.meta,
      requestId: dto.requestId,
    })
  }
}
