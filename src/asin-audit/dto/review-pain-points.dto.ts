import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator"

export class ReviewCommentDto {
  @ApiPropertyOptional({
    example: "Verified Purchase",
    description:
      "评论人昵称（可选；2026-09 爬虫字段 name → customer，二者传其一即可，customer 优先）",
  })
  @IsOptional()
  @IsString()
  customer?: string

  @ApiPropertyOptional({
    example: "Verified Purchase",
    description: "评论人昵称（旧字段，兼容保留）",
  })
  @IsOptional()
  @IsString()
  name?: string

  @ApiPropertyOptional({ example: "The product broke after one week…", description: "评论正文" })
  @IsOptional()
  @IsString()
  comment?: string
}

export class ReviewPainPointsDto {
  @ApiProperty({
    type: [ReviewCommentDto],
    description: "评论列表（服务端清洗：trim 去空、最多取前 200 条、每条正文 600 字符）",
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewCommentDto)
  commentList!: ReviewCommentDto[]

  @ApiPropertyOptional({
    example: ["5 星 75%", "1 星 15%"],
    description: "星级分布：模型背景上下文，不参与痛点频次计算（≤10 项、单项 ≤50 字符）",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  starPercent?: string[]

  @ApiPropertyOptional({
    example: "50000",
    description: "总评论数：模型背景上下文（number 或字符串，字符串 ≤20 字符）",
  })
  @IsOptional()
  @ValidateIf((o: ReviewPainPointsDto) => typeof o.reviewCount === "string")
  @MaxLength(20)
  reviewCount?: number | string

  @ApiPropertyOptional({ example: "zh-CN", description: "说明字段语言，缺省 zh-CN" })
  @IsOptional()
  @IsIn(["zh-CN", "en-US"])
  responseLanguage?: "zh-CN" | "en-US"

  @ApiProperty({
    example: "ZQ-Think-Flash",
    description:
      "逻辑模型 publicId（必填，来自 GET /api/ai-models?modality=TEXT&category=ASIN_AUDIT）",
  })
  @IsString()
  @IsNotEmpty()
  model!: string

  @ApiPropertyOptional({
    example: "uuid",
    description: "客户端幂等/追踪键（可选 UUID，写日志与计费 meta）",
  })
  @IsOptional()
  @IsUUID()
  clientRequestId?: string
}
