import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"
import { PROMOTION_PLAN_MARKETS } from "../promotion-plan.constants"

export class ListPromotionPlanRecordsDto extends PaginationDto {
  @ApiPropertyOptional({ example: "榨汁", description: "按 productName 模糊搜索" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  keyword?: string

  @ApiPropertyOptional({ enum: PROMOTION_PLAN_MARKETS, example: "amazon_us" })
  @IsOptional()
  @IsIn([...PROMOTION_PLAN_MARKETS])
  market?: string

  @ApiPropertyOptional({ example: "家居厨房", description: "精确筛选类目" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string

  @ApiPropertyOptional({ example: "2026-08-30", description: "北京时间起始日期，包含" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dateFrom 需为 YYYY-MM-DD" })
  dateFrom?: string

  @ApiPropertyOptional({ example: "2026-08-30", description: "北京时间结束日期，包含" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dateTo 需为 YYYY-MM-DD" })
  dateTo?: string
}
