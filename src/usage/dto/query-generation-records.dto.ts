import { ApiProperty, ApiPropertyOptional, OmitType } from "@nestjs/swagger"
import { Transform, Type } from "class-transformer"
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, MaxLength } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export const GENERATION_FUNCTION_LABELS = {
  IMAGE: "图片生成",
  VIDEO: "视频生成",
  INSPIRATION_RADAR: "灵感雷达",
  ASIN_EVIDENCE: "ASIN 取证",
  ASIN_AUDIT: "ASIN 审计",
  COMPETITOR_ANALYSIS: "竞品分析",
  LISTING_GENERATION: "Listing 生成",
  LISTING_SCORING: "Listing 打分",
  CATEGORY_ANALYSIS: "类目分析",
  PRODUCT_SELECTION: "选品分析",
  SMART_PRICING: "智能定价",
  PROMOTION_PLAN: "新品推广计划",
  VIDEO_ANALYSIS: "视频分析",
  CHETAIDOU_TEXT: "车泰斗文本流程",
} as const

export const GENERATION_FUNCTIONS = Object.keys(GENERATION_FUNCTION_LABELS) as Array<
  keyof typeof GENERATION_FUNCTION_LABELS
>
export type GenerationFunction = (typeof GENERATION_FUNCTIONS)[number]
export type GenerationModelFunction = Exclude<GenerationFunction, "INSPIRATION_RADAR">
export type TextGenerationFunction = Exclude<
  GenerationFunction,
  "IMAGE" | "VIDEO" | "INSPIRATION_RADAR"
>

// 用户生成记录查询（管理员）：跨用户、合并媒体与文本功能，多维筛选
export class QueryGenerationRecordsDto extends PaginationDto {
  @ApiPropertyOptional({ description: "关键词：用户名 / 手机号 / 提示词 / 报告标题 模糊匹配" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string

  @ApiPropertyOptional({ description: "按组织 id 筛选" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  orgId?: number

  @ApiPropertyOptional({ description: "按角色 id 筛选" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  roleId?: number

  @ApiPropertyOptional({
    description:
      "具体生成功能；不传=全部。ASIN_AUDIT 统一包含审计打分和优化，CHETAIDOU_TEXT 包含拆解、联想、发散、组合。",
    enum: GENERATION_FUNCTIONS,
  })
  @Transform(({ value }: { value: unknown }) => (value === "" ? undefined : value))
  @IsOptional()
  @IsIn(GENERATION_FUNCTIONS as readonly string[])
  function?: GenerationFunction

  @ApiPropertyOptional({ description: "按模型档位（原始 code）筛选，如 video-flash / NANO_BANANA" })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  model?: string

  @ApiPropertyOptional({
    description: "起始时间（含），ISO8601；默认近 14 天，传入更早时间也只查询近 14 天；可只传日期",
  })
  @IsOptional()
  @IsISO8601()
  dateFrom?: string

  @ApiPropertyOptional({
    description:
      "结束时间（含），ISO8601；默认当前时间，最多当前时间；只传日期时包含当日，与近 14 天窗口取交集",
  })
  @IsOptional()
  @IsISO8601()
  dateTo?: string
}

/** 模型选项沿用列表筛选条件，但不接收分页和 model 本身，避免选项随当前页或已选模型收缩。 */
export class QueryGenerationRecordModelOptionsDto extends OmitType(QueryGenerationRecordsDto, [
  "page",
  "pageSize",
  "model",
] as const) {}

export class GenerationRecordModelOptionDto {
  @ApiProperty({
    description: "模型原始 code，作为生成记录列表的 model 参数",
    example: "video-ultra",
  })
  value: string

  @ApiProperty({ description: "模型展示名", example: "Seedance 2.0 Fast" })
  label: string

  @ApiProperty({
    description: "模型所属生成功能",
    enum: GENERATION_FUNCTIONS.filter(f => f !== "INSPIRATION_RADAR"),
  })
  function: GenerationModelFunction
}

export class GenerationRecordFunctionOptionDto {
  @ApiProperty({
    description: "功能筛选值；空串表示全部，查询列表时省略 function",
    example: "ASIN_AUDIT",
  })
  value: string

  @ApiProperty({ description: "功能展示名称", example: "ASIN 审计" })
  label: string
}
