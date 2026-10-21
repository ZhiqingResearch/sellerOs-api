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

  @ApiProperty({
    description: "前端必传的国产模型 ID，须在 TEXT 目录启用",
    enum: COMPETITOR_ANALYSIS_MODELS,
    example: "qwen3.8-max",
  })
  @IsIn(COMPETITOR_ANALYSIS_MODELS, { message: "请选择 qwen3.8-max 或 MiniMax-M3 模型" })
  model!: CompetitorAnalysisModel
}
