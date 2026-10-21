import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsOptional, IsString, Matches, MaxLength } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"
import { SMART_PRICING_MARKETPLACE_CODES } from "../smart-pricing.constants"

export class QuerySmartPricingRecordDto extends PaginationDto {
  @ApiPropertyOptional({
    example: "Example",
    description: "匹配产品名、站点展示名或类目",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  keyword?: string

  @ApiPropertyOptional({ enum: SMART_PRICING_MARKETPLACE_CODES, example: "AMAZON_US" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  marketplaceCode?: string

  @ApiPropertyOptional({ example: "家居厨房", description: "精确筛选类目" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  category?: string

  @ApiPropertyOptional({ example: "2026-08-01", description: "北京时间起始日期，包含" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dateFrom 需为 YYYY-MM-DD" })
  dateFrom?: string

  @ApiPropertyOptional({ example: "2026-08-25", description: "北京时间结束日期，包含" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dateTo 需为 YYYY-MM-DD" })
  dateTo?: string
}
