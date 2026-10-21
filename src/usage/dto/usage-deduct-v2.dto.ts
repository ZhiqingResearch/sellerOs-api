import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from "class-validator"

/**
 * 公共扣费 v2 入参（POST /api/usage/deduct/v2）：大模型底座计费——传底座返回的人民币成本，
 * 扣登录用户自己的积分（不接收 userId）。source/model 必填用于用量统计（功能模块 + 模型维度）。
 */
export class UsageDeductV2Dto {
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
    description:
      "功能模块 key（FeatureModule 注册表，未登记/已下线 400；下拉项见 /usage/source-options）",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  source: string

  @ApiProperty({
    example: "gemini-2.5-flash",
    description: "模型标识（底座/业务侧模型 id，用于用量分析的模型维度统计）",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model: string

  @ApiPropertyOptional({
    example: { taskId: 123 },
    description: "附加元数据（写入积分流水与用量日志 meta，便于排查对账）",
  })
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>

  @ApiPropertyOptional({
    example: "gw-20260827-abc123",
    description:
      "幂等键：同一 requestId 重复提交返回首次扣费结果，不重复扣（建议前端按业务动作生成）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  requestId?: string
}
