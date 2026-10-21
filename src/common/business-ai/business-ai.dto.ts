import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsIn, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator"

export const BUSINESS_AI_MODELS = ["ZQ-Think-Flash", "ZQ-Think-Lite", "ZQ-Think-Pro"] as const

/** 与 Listing 相同：BFF 负责业务提示词，后端统一鉴权、调用网关和结算。 */
export class BusinessAiDto {
  @ApiPropertyOptional({ description: "本次业务操作 ID，用于积分明细聚合" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  businessEventId?: string

  @ApiPropertyOptional({ description: "AI 步骤运行号；相同输入重试时复用已保存产出" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  runId?: string

  @ApiProperty({ enum: ["generate", "extract", "research"], example: "generate" })
  @IsIn(["generate", "extract", "research"])
  operation!: "generate" | "extract" | "research"

  @ApiPropertyOptional({ enum: BUSINESS_AI_MODELS, default: "ZQ-Think-Flash" })
  @IsOptional()
  @IsIn(BUSINESS_AI_MODELS)
  model?: (typeof BUSINESS_AI_MODELS)[number]

  @ApiPropertyOptional({ example: "只输出严格 JSON" })
  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  systemPrompt?: string

  @ApiProperty({ example: "请分析以下商品资料" })
  @IsString()
  @Matches(/\S/, { message: "分析内容不能为空" })
  @MaxLength(1_000_000)
  userPrompt!: string

  @ApiPropertyOptional({ minimum: 0, maximum: 2, example: 0.2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number

  @ApiPropertyOptional({ enum: ["text", "json_object"], default: "text" })
  @IsOptional()
  @IsIn(["text", "json_object"])
  responseFormat?: "text" | "json_object"
}
