import { Controller, Get, Query, Request, UseGuards } from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { AuthenticatedUser } from "../auth/types"
import { QueryTransactionsDto } from "./dto/wallet.dto"
import { WalletService } from "./wallet.service"

/** 用户侧：积分钱包卡片 / 套餐配置 / 积分明细。 */
@ApiTags("会员钱包")
@ApiBearerAuth()
@Controller("membership")
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get("wallet")
  @ApiOperation({ summary: "积分钱包：各桶余额、等级、本月已用、累计消耗、最近清零" })
  wallet(@Request() req: { user: AuthenticatedUser }) {
    return this.walletService.getWallet(req.user.id, req.user.currentOrgId)
  }

  @Get("plans")
  @ApiOperation({ summary: "会员套餐 + 充值包配置（前端渲染选择区）" })
  plans() {
    return this.walletService.getPlans()
  }

  @Get("transactions")
  @ApiOperation({ summary: "积分明细（分页，按方向/桶/类型/归属/扣费来源/调用方式筛选）" })
  transactions(@Request() req: { user: { id: number } }, @Query() query: QueryTransactionsDto) {
    return this.walletService.listTransactions(req.user.id, query)
  }

  @Get("transaction-options")
  @ApiOperation({
    summary: "积分明细 / 充值记录筛选下拉项（按等级返回）",
    description:
      "按当前用户等级返回 { rechargeTypes, buckets?, consumeSources?, consumers? }：rechargeTypes=充值记录类型筛选(type)；buckets=扣费来源(积分桶)筛选(bucket，LV4 之外)；consumeSources=【LV4】扣费来源细分(consumeSource)；consumers=【LV5】使用用户(consumerUserId，含本人)。元素均为 { value, label }，首项「全部」value 空串。来源(source)筛选项见 GET /api/usage/source-options。",
  })
  transactionOptions(@Request() req: { user: { id: number } }) {
    return this.walletService.getTransactionOptions(req.user.id)
  }
}
