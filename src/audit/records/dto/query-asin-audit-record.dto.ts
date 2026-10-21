import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsOptional, IsString, Matches, MaxLength } from "class-validator"
import { PaginationDto } from "../../../common/dto/pagination.dto"

export class QueryAsinAuditRecordDto extends PaginationDto {
  @ApiPropertyOptional({
    example: "B0C9L8ZR6Q",
    description: "匹配 ASIN、标题、站点、国家、类目名称或类目路径",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  keyword?: string

  @ApiPropertyOptional({ example: "US", description: "精确筛选站点代码" })
  @IsOptional()
  @IsString()
  @MaxLength(16)
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
