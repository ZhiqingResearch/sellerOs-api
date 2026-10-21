import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common"
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard"
import { BillingRecordsQueryDto } from "./dto/billing-records-query.dto"
import { CreateOrderDto, PayOrderDto } from "./dto/billing.dto"
import { OrdersService } from "./orders.service"
import { UsdEstimateDto } from "./dto/usd-estimate.dto"

/** 用户侧：下单 / 发起支付 / 订单状态轮询 / 充值记录。 */
@ApiTags("充值订单")
@ApiBearerAuth()
@Controller("billing/orders")
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post("usd-estimate")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "美元金额预估（复用支付汇率与美分舍入，不建单、不扣款、不锁价）" })
  estimateUsd(@Body() dto: UsdEstimateDto) {
    return this.orders.estimateUsd(dto.amountCny)
  }

  @Post()
  @ApiOperation({ summary: "下单（金额/积分后端重算；idempotencyKey 防重复提交）" })
  create(@Request() req: { user: { id: number } }, @Body() dto: CreateOrderDto) {
    return this.orders.create(req.user.id, dto)
  }

  @Post("quote")
  @ApiOperation({
    summary: "试算预览（确认弹窗金额来源；与下单同一算价点，只读不落库、无副作用）",
  })
  quote(@Request() req: { user: { id: number } }, @Body() dto: CreateOrderDto) {
    return this.orders.quote(req.user.id, dto)
  }

  @Post(":orderNo/pay")
  @ApiOperation({
    summary: "发起支付（国内三渠道返回 QR；海外沿用 Stripe）",
  })
  pay(
    @Request() req: { user: { id: number } },
    @Param("orderNo") orderNo: string,
    @Body() dto: PayOrderDto
  ) {
    return this.orders.pay(req.user.id, orderNo, dto)
  }

  @Get("lookup")
  @ApiOperation({
    summary:
      "按 payment_intent 反查订单（支付回跳丢 orderNo 的兜底；只读，恢复订单后再走 :orderNo 轮询）",
  })
  lookup(@Request() req: { user: { id: number } }, @Query("pi") pi: string) {
    if (!pi) throw new BadRequestException("缺少 payment_intent 参数")
    return this.orders.lookupByPaymentIntent(req.user.id, pi)
  }

  @Get(":orderNo")
  @ApiOperation({ summary: "订单状态轮询/主动查单（按支付服务同步，确认成功后入账）" })
  query(@Request() req: { user: { id: number } }, @Param("orderNo") orderNo: string) {
    return this.orders.query(req.user.id, orderNo)
  }
}

/** 用户侧：充值记录（订单视角，分页）。 */
@ApiTags("充值记录")
@ApiBearerAuth()
@Controller("billing/records")
@UseGuards(JwtAuthGuard)
export class BillingRecordsController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @ApiOperation({ summary: "充值记录（我的订单，分页）" })
  list(@Request() req: { user: { id: number } }, @Query() query: BillingRecordsQueryDto) {
    return this.orders.listMine(req.user.id, query.page, query.pageSize, query)
  }

  @Get("export")
  @ApiOperation({ summary: "导出本人筛选后的支付记录（CSV，最多 5000 条，不受分页影响）" })
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="payment-records.csv"')
  export(@Request() req: { user: { id: number } }, @Query() query: BillingRecordsQueryDto) {
    return this.orders.exportRecords(req.user.id, query)
  }
}
