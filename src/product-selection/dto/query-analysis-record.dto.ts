import { ApiPropertyOptional } from "@nestjs/swagger"
import { SelectionAnalysisEntry, SelectionAnalysisStatus } from "@prisma/client"
import { Transform } from "class-transformer"
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export class QueryAnalysisRecordDto extends PaginationDto {
  @ApiPropertyOptional({
    default: false,
    description: "在统一历史中包含已授权的独立类目分析记录；仍按 entry=CATALOG 筛选",
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === "true" ? true : value === "false" ? false : value
  )
  @IsBoolean()
  includeCategoryAnalysis?: boolean

  @ApiPropertyOptional({ example: "US" })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  marketplace?: string

  @ApiPropertyOptional({
    enum: SelectionAnalysisEntry,
    description: "分析入口：CATALOG 类目选品，PRODUCT 产品验证",
  })
  @IsOptional()
  @IsEnum(SelectionAnalysisEntry)
  entry?: SelectionAnalysisEntry

  @ApiPropertyOptional({ enum: SelectionAnalysisStatus })
  @IsOptional()
  @IsEnum(SelectionAnalysisStatus)
  status?: SelectionAnalysisStatus

  @ApiPropertyOptional({
    example: "杯架",
    description: "搜索站点代码、主类目名称或主类目完整路径",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  keyword?: string
}
