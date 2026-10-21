import { ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export enum ProductLibrarySortBy {
  UPDATED_AT = "updatedAt",
  CREATED_AT = "createdAt",
  COMP_SCORE = "compScore",
}

export enum ProductLibrarySortOrder {
  ASC = "asc",
  DESC = "desc",
}

export class QueryProductLibraryItemDto extends PaginationDto {
  @ApiPropertyOptional({ example: "US" })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  marketplace?: string

  @ApiPropertyOptional({ example: "cup" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  keyword?: string

  @ApiPropertyOptional({ description: "按来源分析记录 ID 筛选" })
  @IsOptional()
  @IsUUID("4")
  sourceAnalysisId?: string

  @ApiPropertyOptional({
    example: "洗碗机",
    description: "按来源分析的主类目节点 ID、名称或完整路径模糊筛选",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  category?: string

  @ApiPropertyOptional({ example: 10, description: "最低最新价格（含）" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  minPrice?: number

  @ApiPropertyOptional({ example: 100, description: "最高最新价格（含）" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  maxPrice?: number

  @ApiPropertyOptional({ description: "首次入库起始时间（含），ISO8601，可只传日期" })
  @IsOptional()
  @IsISO8601()
  dateFrom?: string

  @ApiPropertyOptional({
    description: "首次入库结束时间（含），ISO8601；只传日期时包含当日",
  })
  @IsOptional()
  @IsISO8601()
  dateTo?: string

  @ApiPropertyOptional({ enum: ProductLibrarySortBy, default: ProductLibrarySortBy.UPDATED_AT })
  @IsOptional()
  @IsEnum(ProductLibrarySortBy)
  sortBy: ProductLibrarySortBy = ProductLibrarySortBy.UPDATED_AT

  @ApiPropertyOptional({ enum: ProductLibrarySortOrder, default: ProductLibrarySortOrder.DESC })
  @IsOptional()
  @IsEnum(ProductLibrarySortOrder)
  order: ProductLibrarySortOrder = ProductLibrarySortOrder.DESC
}
