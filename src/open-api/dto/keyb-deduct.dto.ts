import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Decimal } from "@prisma/client/runtime/library"
import { IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, ValidateBy } from "class-validator"

/** UsageLog.cost 的现有 Decimal(12, 6) 范围；只约束新接入，不改变旧接口。 */
export const KEYB_MAX_COST_CNY = "999999.999999"

export function isKeybCostCny(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 13 ||
    value.trim() !== value ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)
  ) {
    return false
  }
  try {
    const amount = new Decimal(value)
    return amount.isFinite() && amount.gt(0) && amount.lte(KEYB_MAX_COST_CNY)
  } catch {
    return false
  }
}

/** 新入口金额保留六位小数，避免旧 DTO 的 Number / 两位小数限制吞掉小额费用。 */
export class KeybDeductDto {
  @ApiProperty({
    example: "0.000001",
    description: "服务端确认的实际人民币金额，十进制字符串，>0，最多六位小数，最大999999.999999",
  })
  @ValidateBy({
    name: "isKeybCostCny",
    validator: {
      validate: isKeybCostCny,
      defaultMessage: () => "扣费金额须为正数十进制字符串，最多六位小数且不超过999999.999999元",
    },
  })
  costCny: string

  @ApiProperty({ example: "listing.generate", description: "已登记的 FeatureModule key" })
  @IsString({ message: "功能来源须为字符串" })
  @IsNotEmpty({ message: "功能来源不能为空" })
  @MaxLength(50, { message: "功能来源最长50字符" })
  source: string

  @ApiProperty({ example: "gemini-2.5-flash", description: "本次实际使用的模型标识" })
  @IsString({ message: "模型标识须为字符串" })
  @IsNotEmpty({ message: "模型标识不能为空" })
  @MaxLength(100, { message: "模型标识最长100字符" })
  model: string

  @ApiProperty({
    example: "listing-task-123-charge-1",
    description: "API 生成的稳定消费编号，重试沿用；最多128字符",
  })
  @IsString({ message: "消费编号须为字符串" })
  @IsNotEmpty({ message: "消费编号不能为空" })
  @MaxLength(128, { message: "消费编号最长128字符" })
  requestId: string

  @ApiPropertyOptional({
    example: { taskId: "task-123", gatewayTaskId: "gateway-456", channel: "api" },
    description: "仅允许 taskId、gatewayTaskId、channel；不接收身份、金额或凭证字段",
  })
  @IsOptional()
  @IsObject({ message: "辅助信息须为对象" })
  meta?: Record<string, unknown>
}
