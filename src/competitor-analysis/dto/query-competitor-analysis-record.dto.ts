import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsOptional, IsString, Matches, MaxLength } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"
import { COMPETITOR_ANALYSIS_MARKETPLACES } from "../competitor-analysis.constants"

export class QueryCompetitorAnalysisRecordDto extends PaginationDto {
  @ApiPropertyOptional({ example: "B0AAAA0001", description: "匹配我方或任一产品 ASIN" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  keyword?: string

  @ApiPropertyOptional({ enum: COMPETITOR_ANALYSIS_MARKETPLACES, example: "US" })
  @IsOptional()
  @IsString()
  marketplace?: string

  @ApiPropertyOptional({ example: "2026-08-01", description: "北京时间起始日期，包含" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dateFrom 需为 YYYY-MM-DD" })
  dateFrom?: string

  @ApiPropertyOptional({ example: "2026-08-25", description: "北京时间结束日期，包含" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dateTo 需为 YYYY-MM-DD" })
  dateTo?: string
}
