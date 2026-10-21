import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { SelectionAnalysisEntry } from "@prisma/client"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator"
import { MAX_CATEGORY_COUNT } from "../product-selection.constants"

export class SelectionCategoryDto {
  @ApiProperty({ example: "172282", description: "类目节点 ID" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nodeId: string

  @ApiProperty({ example: "Automotive:Interior Accessories:Cup Holders" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  nodeIdPath: string

  @ApiProperty({ example: "Cup Holders" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  name: string

  @ApiPropertyOptional({ example: "杯架" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  nameCn?: string
}

export class CreateAnalysisRecordDto {
  @ApiProperty({ example: "0a49d1d3-84e7-43a0-8a68-c24f0ed93d27" })
  @IsUUID()
  clientRequestId: string

  @ApiProperty({ example: "US" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  marketplace: string

  @ApiPropertyOptional({ enum: SelectionAnalysisEntry, default: SelectionAnalysisEntry.CATALOG })
  @IsOptional()
  @IsEnum(SelectionAnalysisEntry)
  entry: SelectionAnalysisEntry = SelectionAnalysisEntry.CATALOG

  @ApiPropertyOptional({
    example: "172282",
    description: "主类目节点 ID；CATALOG 必传，PRODUCT 可选",
  })
  @ValidateIf(
    (dto: CreateAnalysisRecordDto) =>
      dto.entry === SelectionAnalysisEntry.CATALOG || dto.primaryCategoryNodeId !== undefined
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  primaryCategoryNodeId?: string

  @ApiPropertyOptional({
    type: [SelectionCategoryDto],
    description: "类目上下文；CATALOG 必传，PRODUCT 可选",
  })
  @ValidateIf(
    (dto: CreateAnalysisRecordDto) =>
      dto.entry === SelectionAnalysisEntry.CATALOG || dto.categories !== undefined
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CATEGORY_COUNT)
  @ValidateNested({ each: true })
  @Type(() => SelectionCategoryDto)
  categories?: SelectionCategoryDto[]

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  @Max(1)
  schemaVersion: number

  @ApiProperty({
    example: {
      pdfUrl: "https://example.com/product-validation.pdf",
      productData: { asin: "B0GWK1HFXP", title: "Car Cup Holder" },
    },
    description: "CATALOG 传第1步 diagnosis；PRODUCT 一次传入 pdfUrl 和非空 productData",
  })
  @IsObject()
  payload: Record<string, unknown>
}
