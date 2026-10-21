import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { IsNumber, IsObject, IsOptional, IsPositive, IsString, MaxLength } from "class-validator"

/**
 * 公共扣款入参（前端用，POST /api/usage/deduct）：按人民币金额扣登录用户自己的积分。
 * 服务端按「1元=10积分 × 用户折扣，向上取整」自动换算并扣减——前端只需传 元 金额。
 * 不接收 userId（一律扣 req.user.id），不暴露透支（allowOverdraft 仅后端函数可用）。
 * 注意：类名刻意区别于后台充值的 ChargeCustomDto（那是给用户加积分、需 userId），避免 Swagger 模型重名冲突。
 */
export class UsageDeductDto {
  @ApiProperty({
    example: 1.5,
    description: "扣费金额（人民币元，>0）。服务端自动按 1元=10积分 × 用户折扣换算实扣积分",
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  costCny: number

  @ApiPropertyOptional({
    example: "feature.export",
    description: "来源标识，用于积分明细「项目」列归类；缺省 manual.deduct",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string

  @ApiPropertyOptional({
    example: { orderId: "A1001", note: "导出报告" },
    description: "附加元数据（写入流水 meta，便于排查）",
  })
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>
}
