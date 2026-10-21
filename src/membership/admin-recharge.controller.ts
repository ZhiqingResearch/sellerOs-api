import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { PaginationDto } from "../common/dto/pagination.dto"
import { AdminRechargeService } from "./admin-recharge.service"
import {
  AdminRebateWithdrawDto,
  ChargeCustomDto,
  ChargePackDto,
  ChargePlanDto,
  ManualAdjustDto,
  QueryRechargeTransactionsDto,
  QueryRechargeUsersDto,
} from "./dto/admin-recharge.dto"
import { RechargeAccountGuard } from "./guards/recharge-account.guard"
import { RechargeRead } from "./guards/recharge-read.decorator"

@ApiTags("后台充值")
@ApiBearerAuth()
@Controller("admin/recharge")
@UseGuards(JwtAuthGuard, RechargeAccountGuard)
export class AdminRechargeController {
  constructor(private readonly service: AdminRechargeService) {}

  @Get("users")
  @RechargeRead() // 只读放行：不走 canRecharge 白名单，改走 management.users 权限点（客户运营·分销管理
  // 「分销代理列表」同源——分销只读查询不与充值操作权限耦合，2026-08-31 起；此前白名单外运营看到「0 位分销代理」）
  @UseGuards(PermissionsGuard)
  @RequirePermissions("management.users")
  @ApiOperation({
    summary: "用户积分一览（默认剩余积分倒序，可切；分页；按关键词/邀请状态/等级/组织筛选）",
  })
  listUsers(@Query() query: QueryRechargeUsersDto) {
    return this.service.listUsers(query)
  }

  @Post("plan")
  @ApiOperation({ summary: "给用户充会员套餐（升级：周期内仅可升更高档，立即生效）" })
  chargePlan(@Body() dto: ChargePlanDto) {
    return this.service.chargePlan(dto.userId, dto.tier)
  }

  @Get("plan/quote")
  @ApiOperation({
    summary:
      "升级补差试算（与 chargePlan 同一算价点：差价/积分差按剩余天数折算，只读不落库；后台充值弹窗金额来源，前端不要本地自算）",
  })
  quotePlanUpgrade(
    @Query("userId", ParseIntPipe) userId: number,
    @Query("tier", ParseIntPipe) tier: number
  ) {
    return this.service.quotePlanUpgrade(userId, tier)
  }

  @Post("plan/renew")
  @ApiOperation({
    summary:
      "续费会员套餐（立即生效）：有效期在原到期日上顺延一期、积分立即到账、立即切档；高等级不能续费低等级（在期 400）；已过期视为新起一期",
  })
  renewPlan(@Body() dto: ChargePlanDto) {
    return this.service.renewPlan(dto.userId, dto.tier)
  }

  @Get("users/:userId/scheduled-plans")
  @ApiOperation({ summary: "查看指定用户的待生效续费队列（按激活时间升序）" })
  scheduledPlans(@Param("userId", ParseIntPipe) userId: number) {
    return this.service.listScheduledPlans(userId)
  }

  @Post("pack")
  @ApiOperation({ summary: "给用户充固定充值包" })
  chargePack(@Body() dto: ChargePackDto) {
    return this.service.chargePack(dto.userId, dto.packId)
  }

  @Post("custom")
  @ApiOperation({ summary: "给用户自定义额度充值（本金进充值积分、按档赠送进套餐积分）" })
  chargeCustom(@Body() dto: ChargeCustomDto) {
    return this.service.chargeCustom(dto.userId, dto.amountCny)
  }

  @Post("manual")
  @ApiOperation({ summary: "手动调额（进充值积分，正增负减，永不清零；任意等级可用）" })
  manualAdjust(@Body() dto: ManualAdjustDto) {
    return this.service.manualAdjust(dto.userId, dto.amount, dto.reason)
  }

  @Get("transactions")
  @RechargeRead() // 只读放行：不走 canRecharge 白名单，改走 management.users 权限点（客户运营·个人订阅页「充值记录」弹窗同源）
  @UseGuards(PermissionsGuard)
  @RequirePermissions("management.users")
  @ApiOperation({
    summary: "全站充值记录（套餐/充值包/自定义/手动调额；按用户/类型/日期筛选，分页）",
  })
  listTransactions(@Query() query: QueryRechargeTransactionsDto) {
    return this.service.listRechargeTransactions(query)
  }

  @Post("rebate-withdraw")
  @ApiOperation({ summary: "超管代发返利提现（替某邀请人 LV5 执行提现，扣其返利桶并留痕）" })
  rebateWithdraw(@Body() dto: AdminRebateWithdrawDto) {
    return this.service.rebateWithdraw(dto.userId, dto.amount, dto.note)
  }

  @Get("users/:userId/withdrawals")
  @RechargeRead() // 只读放行：不走 canRecharge 白名单，改走 management.users 权限点（分销管理「返利提现」弹窗的提现明细同源）
  @UseGuards(PermissionsGuard)
  @RequirePermissions("management.users")
  @ApiOperation({ summary: "查看指定用户（LV5）的返利提现明细（分页）" })
  userWithdrawals(@Param("userId", ParseIntPipe) userId: number, @Query() query: PaginationDto) {
    return this.service.listUserWithdrawals(userId, query)
  }
}
