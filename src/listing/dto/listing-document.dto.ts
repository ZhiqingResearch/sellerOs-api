import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from "class-validator"
import { MAX_LISTING_DOCUMENT_BYTES } from "../listing-document.constants"
import { LISTING_AI_MODELS, type ListingAiModel } from "../listing-ai.models"

export class CreateListingDocumentUploadDto {
  @ApiProperty({ example: "product-spec.pdf" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string

  @ApiPropertyOptional({ example: "application/pdf" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  mimeType?: string

  @ApiProperty({ example: 3_245_678, maximum: MAX_LISTING_DOCUMENT_BYTES })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LISTING_DOCUMENT_BYTES)
  fileSize!: number
}

export class AnalyzeListingDocumentDto {
  @ApiProperty({ example: "listing-documents/7/550e8400-e29b-41d4-a716-446655440000.pdf" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  objectKey!: string

  @ApiProperty({ example: "product-spec.pdf" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string

  @ApiProperty({ example: "application/pdf" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  mimeType!: string

  @ApiProperty({ example: 3_245_678, maximum: MAX_LISTING_DOCUMENT_BYTES })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LISTING_DOCUMENT_BYTES)
  fileSize!: number

  @ApiPropertyOptional({ description: "用户对文档提取的补充要求" })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  documentPrompt?: string

  @ApiProperty({
    description: "文档分析使用的 AI 中转站逻辑模型 ID",
    enum: LISTING_AI_MODELS,
    example: "qwen3.8-max",
  })
  @IsIn(LISTING_AI_MODELS)
  model!: ListingAiModel
}
