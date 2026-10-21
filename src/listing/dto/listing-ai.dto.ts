import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"
import { LISTING_AI_MODELS, type ListingAiModel } from "../listing-ai.models"

export const LISTING_AI_OPERATIONS = [
  "generation",
  "optimization",
  "long_title",
  "qa_rewrite",
  "score",
  "category_match",
  "attribute_analysis",
] as const

export type ListingAiOperation = (typeof LISTING_AI_OPERATIONS)[number]

export const LISTING_AI_RESPONSE_FORMATS = ["text", "json_object"] as const

export type ListingAiResponseFormat = (typeof LISTING_AI_RESPONSE_FORMATS)[number]

export class ListingScoreImageDto {
  @ApiProperty({ description: "审计取得的 Amazon 图片 CDN HTTPS 地址" })
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @MaxLength(2048)
  url!: string

  @ApiProperty({ enum: ["main", "secondary", "aplus"] })
  @IsIn(["main", "secondary", "aplus"])
  role!: "main" | "secondary" | "aplus"
}

export class ListingAiInvocationDto {
  @ApiPropertyOptional({
    description: "是否保存独立 Listing 生成记录；一键上架传 false，结果保存在上架任务中，不影响扣费",
    default: true,
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  shouldSaveHistory?: boolean

  @ApiPropertyOptional({ description: "生成/优化目标市场，用于扣费前校验完整结果", example: "amazon_us" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  listingMarket?: string

  @ApiPropertyOptional({ description: "独立评分请求号；重连复用该号，不重复调用模型或扣费" })
  @IsOptional()
  @IsUUID()
  scoreRequestId?: string

  @ApiPropertyOptional({ description: "独立评分平台，用于扣费前核验报告结构", example: "amazon_us" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  scoreMarket?: string

  @ApiPropertyOptional({ description: "关联 Listing 生成记录，缺省时自动创建独立记录" })
  @IsOptional()
  @IsUUID()
  runId?: string

  @ApiProperty({ enum: LISTING_AI_OPERATIONS, example: "generation" })
  @IsIn(LISTING_AI_OPERATIONS)
  operation!: ListingAiOperation

  @ApiProperty({
    description: "前端必传的国产模型 ID，须在 TEXT 目录启用",
    enum: LISTING_AI_MODELS,
    example: "qwen3.8-max",
  })
  @IsIn(LISTING_AI_MODELS, { message: "请选择 qwen3.8-max 或 MiniMax-M3 模型" })
  model!: ListingAiModel

  @ApiPropertyOptional({
    description: "仅评分使用的真实图片，最多40张",
    type: [ListingScoreImageDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => ListingScoreImageDto)
  images?: ListingScoreImageDto[]

  @ApiPropertyOptional({ description: "由前端服务端现有 Listing Skill 组装的系统提示词" })
  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  systemPrompt?: string

  @ApiProperty({ description: "由前端服务端现有 Listing 链路组装的用户提示词" })
  @IsString()
  @MaxLength(1_000_000)
  userPrompt!: string

  @ApiPropertyOptional({ minimum: 0, maximum: 2, default: 0.8 })
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(2)
  temperature?: number

  @ApiPropertyOptional({ minimum: 256, maximum: 20_000, default: 12_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(256)
  @Max(20_000)
  maxOutputTokens?: number

  @ApiPropertyOptional({
    description: "响应格式；独立评分会先保存输出、执行本地格式修复，必要时最多一次受限修复",
    enum: LISTING_AI_RESPONSE_FORMATS,
    default: "text",
  })
  @IsOptional()
  @IsIn(LISTING_AI_RESPONSE_FORMATS)
  responseFormat?: ListingAiResponseFormat
}
