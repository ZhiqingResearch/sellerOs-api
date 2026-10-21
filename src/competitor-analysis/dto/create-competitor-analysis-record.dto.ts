import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"
import {
  COMPETITOR_ANALYSIS_MARKETPLACES,
  COMPETITOR_ANALYSIS_MAX_COMPETITORS,
  COMPETITOR_ANALYSIS_MAX_SOURCE_TEXT_LENGTH,
  COMPETITOR_ANALYSIS_MODES,
  COMPETITOR_ANALYSIS_SCHEMA_VERSION,
} from "../competitor-analysis.constants"

export class CompetitorAnalysisInputDto {
  @ApiProperty({ enum: COMPETITOR_ANALYSIS_MODES, example: "ASIN" })
  @IsString()
  mode: string

  @ApiPropertyOptional({ example: "B0AAAA0001", nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  ownAsin?: string | null

  @ApiProperty({ type: [String], example: ["B0BBBB0002", "B0CCCC0003"] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(COMPETITOR_ANALYSIS_MAX_COMPETITORS)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  competitorAsins: string[]

  @ApiPropertyOptional({ example: "portable blender", nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  keyword?: string | null

  @ApiPropertyOptional({ example: "前端分析时使用的补充输入或来源文本" })
  @IsOptional()
  @IsString()
  @MaxLength(COMPETITOR_ANALYSIS_MAX_SOURCE_TEXT_LENGTH)
  sourceText?: string
}

export class CompetitorAnalysisProductStepDto {
  @ApiProperty({ example: "PROFILE", description: "前端定义的稳定步骤代码" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  stepCode: string

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(0)
  stepNo: number

  @ApiProperty({ example: COMPETITOR_ANALYSIS_SCHEMA_VERSION })
  @IsInt()
  schemaVersion: number

  @ApiProperty({ type: "object", additionalProperties: true, example: {} })
  @IsObject()
  resultData: Record<string, unknown>
}

export class CompetitorAnalysisProductDto {
  @ApiProperty({ example: "B0AAAA0001" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  asin: string

  @ApiProperty({ example: 0 })
  @IsInt()
  @Min(0)
  sortOrder: number

  @ApiProperty({ type: "object", additionalProperties: true, example: {} })
  @IsObject()
  productData: Record<string, unknown>

  @ApiProperty({ type: [CompetitorAnalysisProductStepDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompetitorAnalysisProductStepDto)
  steps: CompetitorAnalysisProductStepDto[]
}

export class CreateCompetitorAnalysisRecordDto {
  @ApiProperty({ format: "uuid", example: "9c82fc0e-f74f-4bb8-9075-223ba56d24aa" })
  @IsUUID("4")
  clientRequestId: string

  @ApiProperty({ example: COMPETITOR_ANALYSIS_SCHEMA_VERSION })
  @IsInt()
  schemaVersion: number

  @ApiProperty({ enum: COMPETITOR_ANALYSIS_MARKETPLACES, example: "US" })
  @IsString()
  marketplace: string

  @ApiProperty({ type: CompetitorAnalysisInputDto })
  @ValidateNested()
  @Type(() => CompetitorAnalysisInputDto)
  input: CompetitorAnalysisInputDto

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    description: "兼容前端旧字段；后端不保存、不参与幂等指纹",
  })
  @IsOptional()
  @IsObject()
  summary?: Record<string, unknown>

  @ApiProperty({ type: "object", additionalProperties: true, example: {} })
  @IsObject()
  analysisResult: Record<string, unknown>

  @ApiProperty({ type: [CompetitorAnalysisProductDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CompetitorAnalysisProductDto)
  products: CompetitorAnalysisProductDto[]

  @ApiProperty({ type: "object", additionalProperties: true, example: {} })
  @IsObject()
  reportData: Record<string, unknown>
}
