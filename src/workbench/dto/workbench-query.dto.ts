import { ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { IsEnum, IsInt, IsOptional, Max, Min } from "class-validator"

/** 工作台统计周期：滚动窗口，与原型「全部 / 近 7 天 / 近 30 天」三个筛选页签一一对应 */
export enum WorkbenchPeriod {
  /** 全部 */
  ALL = "ALL",
  /** 近 7 天（now - 7d 起的滚动窗口） */
  LAST_7_DAYS = "LAST_7_DAYS",
  /** 近 30 天（now - 30d 起的滚动窗口） */
  LAST_30_DAYS = "LAST_30_DAYS",
}

export class WorkbenchPeriodQueryDto {
  @ApiPropertyOptional({
    enum: WorkbenchPeriod,
    default: WorkbenchPeriod.ALL,
    example: WorkbenchPeriod.LAST_30_DAYS,
    description: "统计周期，缺省=全部",
  })
  @IsOptional()
  @IsEnum(WorkbenchPeriod)
  period: WorkbenchPeriod = WorkbenchPeriod.ALL
}

export class WorkbenchRecentOutputsQueryDto extends WorkbenchPeriodQueryDto {
  @ApiPropertyOptional({ example: 10, default: 10, description: "返回条数上限，1~50" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 10
}
