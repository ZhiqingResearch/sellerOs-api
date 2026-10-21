import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator"
import {
  COMPETITOR_ANALYSIS_MODELS,
  type CompetitorAnalysisModel,
} from "../competitor-analysis.models"

const SUPPORTED_COUNTRIES = [
  "US",
  "UK",
  "DE",
  "CA",
  "JP",
  "FR",
  "ES",
  "IT",
  "MX",
  "AU",
  "AE",
  "BR",
  "SA",
] as const

export class AnalyzeCompetitorsDto {
  @ApiPropertyOptional({ description: "本次竞品分析业务操作 ID，用于聚合积分明细" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  runId?: string

  @ApiProperty({ example: ["B0D1234567", "B0D7654321"], maxItems: 3 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @Matches(/^[A-Z0-9]{10}$/, { each: true, message: "每个 ASIN 必须是 10 位大写字母或数字" })
  asins!: string[]

  @ApiProperty({ example: "US", enum: SUPPORTED_COUNTRIES })
  @IsIn(SUPPORTED_COUNTRIES)
  country!: string

  @ApiPropertyOptional({
    description: "生成竞品 AI 总结使用的模型；未传时使用代码内默认模型",
    enum: COMPETITOR_ANALYSIS_MODELS,
    example: "ZQ-Think-Flash",
  })
  @IsOptional()
  @IsIn(COMPETITOR_ANALYSIS_MODELS)
  model?: CompetitorAnalysisModel
}
