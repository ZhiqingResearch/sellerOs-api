import { ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, MaxLength } from "class-validator"

/** 预留给后台管理系统调整定价使用 */
export class UpdatePricingDto {
  @ApiPropertyOptional({ example: "输入 Token（≤20万）", description: "显示名称" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string

  @ApiPropertyOptional({ example: 200000, description: "token 阈值" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  threshold?: number | null

  @ApiPropertyOptional({ example: 1, description: "原价（美元/单位）" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  originalPriceUsd?: number

  @ApiPropertyOptional({ example: 1.25, description: "溢价后美元（参考）" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  markupPriceUsd?: number

  @ApiPropertyOptional({ example: 9, description: "溢价后人民币（实际计费价）" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  markupPriceCny?: number

  @ApiPropertyOptional({ example: true, description: "是否启用" })
  @IsOptional()
  @IsBoolean()
  active?: boolean

  @ApiPropertyOptional({ example: "调整说明", description: "描述" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string
}
