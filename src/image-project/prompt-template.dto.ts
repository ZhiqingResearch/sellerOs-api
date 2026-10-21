import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger"
import { Transform, Type } from "class-transformer"
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator"
import { PaginationDto } from "../common/dto/pagination.dto"

/** query 参数里的布尔值兼容 "true"/"false"/"1"/"0"/true/false */
const toOptionalBool = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const v = value.toLowerCase()
    if (v === "true" || v === "1") return true
    if (v === "false" || v === "0") return false
  }
  return undefined
}

export class CreatePromptTemplateDto {
  @ApiProperty({ description: "维度（白底 / 场景 / 尺寸 / 卖点 / ...）", example: "白底" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  dimension: string

  @ApiProperty({ description: "功能名称", example: "正面" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string

  @ApiProperty({
    description: "提示词正文",
    example:
      "生成一张产品白底图：正面拍摄。纯白背景，无多余杂物。根据参考图准确还原产品的外观、颜色和材质质感。",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  prompt: string

  @ApiPropertyOptional({ description: "是否启用，默认 true", default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean

  @ApiPropertyOptional({ description: "同维度内排序，数字小靠前", default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number
}

export class UpdatePromptTemplateDto extends PartialType(CreatePromptTemplateDto) {}

export class ListPromptTemplateQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: "维度精确筛选" })
  @IsOptional()
  @IsString()
  dimension?: string

  @ApiPropertyOptional({ description: "启用状态筛选" })
  @IsOptional()
  @Transform(toOptionalBool)
  @IsBoolean()
  enabled?: boolean

  @ApiPropertyOptional({ description: "关键字模糊匹配（功能名称 / 提示词）" })
  @IsOptional()
  @IsString()
  keyword?: string
}

export class GroupedPromptTemplateQueryDto {
  @ApiPropertyOptional({
    description: "仅返回启用的模板（前端 Composer 传 true，admin 页面不传）",
    default: false,
  })
  @IsOptional()
  @Transform(toOptionalBool)
  @IsBoolean()
  enabledOnly?: boolean
}
