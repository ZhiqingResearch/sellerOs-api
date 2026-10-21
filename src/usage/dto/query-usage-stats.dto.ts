import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsEnum, IsOptional } from "class-validator"

export enum StatsPeriod {
  LAST_7_DAYS = "LAST_7_DAYS",
  THIS_MONTH = "THIS_MONTH",
  LAST_MONTH = "LAST_MONTH",
  ALL = "ALL",
}

export class QueryUsageStatsDto {
  @ApiPropertyOptional({
    enum: StatsPeriod,
    default: StatsPeriod.THIS_MONTH,
    description: "时间范围：最近七天 / 本月 / 上月 / 全部（默认本月）",
  })
  @IsOptional()
  @IsEnum(StatsPeriod)
  period?: StatsPeriod
}
