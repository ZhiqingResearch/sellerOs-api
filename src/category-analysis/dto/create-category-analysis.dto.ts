import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export class CategorySelectionDto {
  @ApiProperty({ example: "3743981" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nodeId: string
  @ApiProperty({ example: "1055398:284507:3743981" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  nodeIdPath: string
  @ApiProperty({ example: "Kitchen Storage" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string
  @ApiProperty({ example: "家居厨房 > 厨房餐饮 > 厨房收纳" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  path: string
  @ApiPropertyOptional({ example: "kitchen storage" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  seedKeyword?: string
  @ApiPropertyOptional({ example: "Kitchen & Dining" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  parentName?: string
  @ApiPropertyOptional({
    example: "510156",
    description: "关键词反查返回的类目编号，切换口径时保留",
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,100}$/)
  categoryId?: string
  @ApiPropertyOptional({ enum: ["picked", "keyword"] })
  @IsOptional()
  @IsIn(["picked", "keyword"])
  from?: "picked" | "keyword"
  @ApiPropertyOptional({ type: [String], example: ["spice rack"] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  resolvedFrom?: string[]
}
export class CreateCategoryAnalysisDto {
  @ApiProperty({ example: "87d6ae20-07a5-4a99-bff3-a778a45e6740" })
  @IsUUID("4")
  requestId: string
  @ApiProperty({ enum: ["US", "UK", "DE", "JP"], example: "US" })
  @IsIn(["US", "UK", "DE", "JP"])
  marketplace: string
  @ApiProperty({ type: [CategorySelectionDto], maxItems: 5, minItems: 0 })
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(5)
  @ArrayUnique((category: CategorySelectionDto) => category.nodeId)
  @ValidateNested({ each: true })
  @Type(() => CategorySelectionDto)
  categories: CategorySelectionDto[]

  @ApiPropertyOptional({ type: [String], maxItems: 5, example: ["spice rack"] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  @Matches(/^[^\u4e00-\u9fa5]+$/, { each: true, message: "请使用英文关键词，例如 earbuds" })
  keywords?: string[]

  @ApiPropertyOptional({ enum: ["cat", "kw", "mix"] })
  @IsOptional()
  @IsIn(["cat", "kw", "mix"])
  plan?: "cat" | "kw" | "mix"
}
export class ConfirmCategoryCandidatesDto {
  @ApiProperty({ type: [String], minItems: 1, maxItems: 5 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^\d+$/, { each: true })
  categoryIds: string[]
}
export class QueryCategoryAnalysisDto extends PaginationDto {
  @ApiPropertyOptional({ example: "厨房收纳" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  keyword?: string
}
export class ImportCategorySampleDto {
  @ApiProperty({ example: "3743981" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  categoryId: string
  @ApiProperty({ enum: ["US", "UK", "DE", "JP"] })
  @IsIn(["US", "UK", "DE", "JP"])
  marketplace: string
}
