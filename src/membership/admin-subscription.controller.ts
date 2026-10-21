import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger"
import { RequirePermissions } from "../auth/decorators/require-permissions.decorator"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { PermissionsGuard } from "../auth/guards/permissions.guard"
import { AdminSubscriptionService } from "./admin-subscription.service"
import {
  AdjustSubscriptionDto,
  AdminSubscriptionListResponseDto,
  QueryAdminSubscriptionDto,
} from "./dto/admin-subscription.dto"

/**
 * 后台个人订阅（客户运营·个人订阅 tab）。
 * 列表/调整同走 management.users 权限点（本页即客户运营的工作台，2026-08-28 起不再走充值白名单）；
 * 调整（赠送积分/延长有效期）虽动积分，但流水带 meta.operatorId + 备注留痕，追责不丢。
 * 真正的后台充值主页（admin/recharge 写接口）仍走账号级 RechargeAccountGuard。
 */
@ApiTags("后台充值")
@ApiBearerAuth()
@Controller("admin/subscriptions")
@UseGuards(JwtAuthGuard)
export class AdminSubscriptionController {
  constructor(private readonly service: AdminSubscriptionService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions("management.users")
  @ApiOperation({
    summary: "个人订阅列表（Lv.1-3 在期/临期/过期 + MRR 汇总，到期升序；手机号脱敏）",
  })
  @ApiResponse({ status: 200, type: AdminSubscriptionListResponseDto })
  list(@Query() query: QueryAdminSubscriptionDto) {
    return this.service.list(query)
  }

  @Get("export")
  @UseGuards(PermissionsGuard)
  @RequirePermissions("management.users")
  @ApiOperation({
    summary: "个人订阅名单 CSV 导出（带 BOM；与列表同筛选，最多 5000 行）",
    description:
      "列：用户名/手机号(脱敏)/邮箱/会员等级/状态/到期时间/剩余天数；到期时间按 tz（IANA 时区名）格式化，缺省回落 Asia/Shanghai。",
  })
  @Header("Content-Type", "text/csv; charset=utf-8")
  exportCsv(@Query() query: QueryAdminSubscriptionDto, @Query("tz") tz?: string) {
    return this.service.exportCsv(query, tz)
  }

  @Post(":userId/adjust")
  @UseGuards(PermissionsGuard)
  @RequirePermissions("management.users")
  @ApiOperation({
    summary:
      "客服补偿调整：赠送积分（可负数）/ 延长有效期，充值记录显示「后台积分发放/后台积分扣减」，不产生订单",
  })
  adjust(
    @Param("userId", ParseIntPipe) userId: number,
    @Body() dto: AdjustSubscriptionDto,
    @Request() req: { user: { id: number } }
  ) {
    return this.service.adjust(userId, req.user.id, dto)
  }
}
