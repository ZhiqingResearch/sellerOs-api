import { ApiPropertyOptional } from "@nestjs/swagger"
import { SensitiveWordSource } from "@prisma/client"
import { Type } from "class-transformer"
import { IsEnum, IsInt, IsOptional } from "class-validator"

/**
 * stats 接口的过滤参数：
 * - source / userId：横切过滤，会同时作用到 total + platforms[].count + platforms[].categories[].count
 * - platform 不再支持过滤：它是返回结构的 tab 维度，由前端切 tab；后端永远把所有平台一次性返出
 * - 不接受 word / category：这俩是被统计的维度，不应同时作为过滤条件
 */
export class StatsQueryDto {
  @ApiPropertyOptional({
    enum: SensitiveWordSource,
    example: SensitiveWordSource.AI_DETECTION,
    description: "只统计该来源",
  })
  @IsOptional()
  @IsEnum(SensitiveWordSource)
  source?: SensitiveWordSource

  @ApiPropertyOptional({ example: 7, description: "只统计该创建人" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  userId?: number
}
