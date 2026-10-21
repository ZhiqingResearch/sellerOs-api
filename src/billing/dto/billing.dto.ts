import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { BillingOrderType, PaymentChannel } from "@prisma/client"
import { Type } from "class-transformer"
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator"

/** 下单：type + 商品定位参数（金额/积分一律后端重算，前端传的金额不采信） */
export class CreateOrderDto {
  @ApiPropertyOptional({
    enum: ["STRIPE", "ALLINPAY"],
    description: "支付服务：STRIPE 海外（默认）/ ALLINPAY 国内",
  })
  @IsOptional()
  @IsIn(["STRIPE", "ALLINPAY"])
  provider?: "STRIPE" | "ALLINPAY"

  @ApiProperty({ enum: BillingOrderType, description: "订单类型" })
  @IsEnum(BillingOrderType)
  type: BillingOrderType

  @ApiPropertyOptional({
    description: "目标套餐档 1/2/3（PLAN_NEW / PLAN_RENEW / PLAN_UPGRADE 必填）",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  targetTier?: number

  @ApiPropertyOptional({ description: "充值包 id（PACK / TEAM_PACK 必填；TEAM_PACK 为团队包 id）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  packId?: number

  @ApiPropertyOptional({
    description:
      "团队套餐档 1=standard 2=flagship（TEAM_PLAN / TEAM_SEAT_UPGRADE / PERSONAL_TO_TEAM 必填）",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2)
  teamTier?: number

  @ApiPropertyOptional({
    description: "团队 id（TEAM_RENEW / TEAM_SEAT_UPGRADE / TEAM_PACK / TEAM_CUSTOM 必填）",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teamId?: number

  @ApiPropertyOptional({
    description: "企业名称（TEAM_PLAN / PERSONAL_TO_TEAM 可选）",
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  teamName?: string

  @ApiPropertyOptional({
    enum: ["inject", "keep"],
    description:
      "个人充值包(RECHARGE)存量积分去向（PERSONAL_TO_TEAM / TEAM_PLAN 可选）：inject=注入团队共享池 / keep=保留个人账户（默认 keep）",
  })
  @IsOptional()
  @IsIn(["inject", "keep"])
  packChoice?: "inject" | "keep"

  @ApiPropertyOptional({
    description: "充值金额（人民币元，最多两位小数；CUSTOM / TEAM_CUSTOM 必填）",
    example: "100.00",
  })
  @IsOptional()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: "金额必须为数字（最多两位小数）" })
  amountCny?: string

  @ApiPropertyOptional({ description: "幂等键（防重复提交；同键返回已建订单）" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idempotencyKey?: string

  @ApiPropertyOptional({
    description: "收据接收邮箱（可选；不传则用账号邮箱，账号也无邮箱则收据不自动邮寄）",
    example: "finance@example.com",
  })
  @IsOptional()
  @IsEmail({}, { message: "收据接收邮箱格式不正确" })
  @MaxLength(100)
  receiptEmail?: string
}

/** 发起支付 */
export class PayOrderDto {
  @ApiPropertyOptional({
    enum: ["STRIPE", "ALLINPAY"],
    description: "支付服务：STRIPE 海外（默认）/ ALLINPAY 国内",
  })
  @IsOptional()
  @IsIn(["STRIPE", "ALLINPAY"])
  provider?: "STRIPE" | "ALLINPAY"

  @ApiProperty({
    enum: PaymentChannel,
    description: "支付渠道：国内 WECHAT/ALIPAY/CARD 均扫码；海外微信扫码/支付宝跳转/银行卡表单",
  })
  @IsIn([PaymentChannel.WECHAT, PaymentChannel.ALIPAY, PaymentChannel.CARD])
  channel: PaymentChannel

  @ApiPropertyOptional({ description: "海外 ALIPAY 必填：支付完成后 Stripe 收银台跳回的前端地址" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  returnUrl?: string
}

/** 收据补开（对历史人工充值流水） */
export class ClaimReceiptDto {
  @ApiProperty({ description: "积分流水 id（本人的人工充值入账行）" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  transactionId: number

  @ApiPropertyOptional({ description: "收据接收邮箱（可选；不传则用账号邮箱）" })
  @IsOptional()
  @IsEmail({}, { message: "收据接收邮箱格式不正确" })
  @MaxLength(100)
  email?: string
}

/** 重发收据邮件（可选指定新接收邮箱；不传则发往收据原邮箱） */
export class ResendReceiptDto {
  @ApiPropertyOptional({ description: "新接收邮箱（传入则发到该邮箱并更新收据接收邮箱）" })
  @IsOptional()
  @IsEmail({}, { message: "邮箱格式不正确" })
  @MaxLength(100)
  email?: string
}

/** 设置默认收据邮箱（空串 = 清除，回落账号邮箱） */
export class SetDefaultEmailDto {
  @ApiProperty({ description: "默认收据接收邮箱；传空串清除设置", example: "finance@example.com" })
  @IsString()
  @MaxLength(100)
  @ValidateIf((o: SetDefaultEmailDto) => o.email.trim() !== "")
  @IsEmail({}, { message: "邮箱格式不正确" })
  email: string
}
