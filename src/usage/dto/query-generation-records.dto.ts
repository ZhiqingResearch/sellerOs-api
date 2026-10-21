import { ApiProperty, ApiPropertyOptional, OmitType } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, MaxLength } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

// 生成功能：图片创作（含 RPA）/ 视频创作（含 RPA）/ 灵感雷达（不传=全部合并）
export const GENERATION_FUNCTIONS = ["IMAGE", "VIDEO", "INSPIRATION_RADAR"] as const
export type GenerationFunction = (typeof GENERATION_FUNCTIONS)[number]
export type GenerationModelFunction = Extract<GenerationFunction, "IMAGE" | "VIDEO">

// 用户生成记录查询（管理员）：跨用户、合并图片 + 视频 + RPA + 灵感雷达，多维筛选
export class QueryGenerationRecordsDto extends PaginationDto {
  @ApiPropertyOptional({ description: "关键词：用户名 / 手机号 / 提示词 模糊匹配" })
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
      "功能：IMAGE 生成图片（含 RPA）/ VIDEO 生成视频（含 RPA）/ INSPIRATION_RADAR 灵感雷达；不传=全部",
    enum: GENERATION_FUNCTIONS,
  })
  @IsOptional()
  @IsIn(GENERATION_FUNCTIONS as readonly string[])
  function?: GenerationFunction

  @ApiPropertyOptional({ description: "按模型档位（原始 code）筛选，如 video-flash / NANO_BANANA" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  model?: string

  @ApiPropertyOptional({ description: "起始时间（含），ISO8601；可只传日期" })
  @IsOptional()
  @IsISO8601()
  dateFrom?: string

  @ApiPropertyOptional({ description: "结束时间（含），ISO8601；只传日期时按当日 23:59:59 计" })
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

  @ApiProperty({ description: "模型所属生成功能", enum: ["IMAGE", "VIDEO"] })
  function: GenerationModelFunction
}
