import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
} from "class-validator"

/** 对外扣费入参（POST /api/open/credit/deduct）：手机号对齐用户；requestId 必填（幂等兜底）。 */
export class OpenDeductDto {
  @ApiProperty({ example: "13800001234", description: "用户手机号（与平台用户表对齐）" })
  @IsString()
  @Matches(/^1\d{10}$/, { message: "手机号格式不正确" })
  phone: string

  @ApiProperty({
    example: 0.35,
    description:
      "扣费金额（人民币元，>0，最多 2 位小数）。服务端按 1元=10积分 × 用户折扣换算实扣积分",
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  costCny: number

  @ApiProperty({
    example: "listing.generate",
    description: "功能模块 key（FeatureModule 注册表；可用清单见 GET /open/credit/features）",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  source: string

  @ApiProperty({ example: "gemini-2.5-flash", description: "模型标识（用于模型维度用量统计）" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model: string

  @ApiProperty({
    example: "erp-20260827-0001",
    description: "幂等键（必填）：同一 requestId 重复提交返回首次扣费结果，不重复扣",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  requestId: string

  @ApiPropertyOptional({
    example: { orderId: "A1001" },
    description: "附加元数据（写入流水 meta）",
  })
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>
}
