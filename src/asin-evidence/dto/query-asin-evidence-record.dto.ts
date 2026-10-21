import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export class QueryAsinEvidenceRecordDto extends PaginationDto {
  @ApiPropertyOptional({
    example: "B0GQB1C381",
    description: "匹配 ASIN 或商品名",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  keyword?: string

  @ApiPropertyOptional({ example: "US", enum: ["US", "UK", "DE"], description: "精确筛选站点代码" })
  @IsOptional()
  @IsIn(["US", "UK", "DE"])
  country?: string

  @ApiPropertyOptional({ example: "2026-09-01", description: "北京时间起始日期，包含" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dateFrom 需为 YYYY-MM-DD" })
  dateFrom?: string

  @ApiPropertyOptional({ example: "2026-09-11", description: "北京时间结束日期，包含" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dateTo 需为 YYYY-MM-DD" })
  dateTo?: string
}
