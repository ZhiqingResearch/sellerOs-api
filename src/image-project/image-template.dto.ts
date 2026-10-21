import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../common/dto/pagination.dto"

// 模板库筛选 Tab：全部 / 我的 / 系统
export const TEMPLATE_TABS = ["all", "mine", "system"] as const
export type TemplateTab = (typeof TEMPLATE_TABS)[number]

// =========================================================
// 图片条目
// =========================================================

export class TemplateItemDto {
  @ApiPropertyOptional({ description: "图片名称", example: "标题图", default: "默认" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string

  @ApiPropertyOptional({ description: "该张图的 prompt", example: "A+ 顶部 Hero 图，柔光留白..." })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  prompt?: string

  @ApiPropertyOptional({ description: "参考/示例图 URL" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  refImageUrl?: string

  @ApiPropertyOptional({ description: "尺寸：不传=不指定，否则如 1:1 / 3:4 / 16:9" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  aspectRatio?: string

  @ApiPropertyOptional({ description: "文字量：无文字 / 极少 / 常规 / 丰富" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  textAmount?: string

  @ApiPropertyOptional({ description: "分辨率档位", example: "1K" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  resolutionTier?: string

  @ApiPropertyOptional({ description: "自定义宽度", example: 1024 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  customAspectW?: number

  @ApiPropertyOptional({ description: "自定义高度", example: 1024 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  customAspectH?: number

  @ApiPropertyOptional({ description: "自定义尺寸模式", example: "pixels" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  customSizeMode?: string

  @ApiPropertyOptional({ description: "排序，数字小靠前", default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number
}

// =========================================================
// 模板
// =========================================================

export class CreateImageTemplateDto {
  @ApiProperty({ description: "模板名", example: "A+ 标准 5 板块" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string

  @ApiPropertyOptional({ description: "分组名（默认收藏夹 / A+ / ...）", example: "默认收藏夹" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  groupName?: string

  @ApiPropertyOptional({ description: "标签数组", type: [String], example: ["A+", "Amazon"] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(30)
  tags?: string[]

  @ApiPropertyOptional({ description: "备注" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string

  @ApiProperty({ description: "图片条目（至少一张）", type: [TemplateItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateItemDto)
  @ArrayMaxSize(50)
  items: TemplateItemDto[]
}

// 更新：所有字段可选；传 items 时整组替换
export class UpdateImageTemplateDto extends PartialType(CreateImageTemplateDto) {}

export class CopyImageTemplateDto {
  @ApiPropertyOptional({ description: "克隆后的模板名（不传则在原名后加「-副本」）" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string

  @ApiPropertyOptional({ description: "复制到的分组名", example: "默认收藏夹" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  groupName?: string
}

// 导入分享码：前端解析分享码后，把模板 id 数组传给后端批量克隆
export class ImportImageTemplateDto {
  @ApiProperty({
    description: "要导入的模板 id 数组（前端解析分享码得到），已删除的会被跳过",
    type: [Number],
    example: [1, 2],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids: number[]
}

// =========================================================
// 个人分组管理（分组管理弹窗）
// =========================================================

export class CreateTemplateGroupDto {
  @ApiProperty({ description: "分组名", example: "电脑" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string
}

export class RenameTemplateGroupDto {
  @ApiProperty({ description: "新分组名", example: "电脑配件" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string
}

// =========================================================
// 查询
// =========================================================

export class QueryImageTemplateDto extends PaginationDto {
  @ApiPropertyOptional({
    description: "Tab：all 全部 / mine 我的 / system 系统",
    enum: TEMPLATE_TABS,
  })
  @IsOptional()
  @IsIn(TEMPLATE_TABS as readonly string[])
  tab?: TemplateTab

  @ApiPropertyOptional({ description: "分组 id 精确筛选" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  groupId?: number

  @ApiPropertyOptional({ description: "标签精确筛选" })
  @IsOptional()
  @IsString()
  tag?: string

  @ApiPropertyOptional({ description: "关键字模糊匹配（模板名 / 备注 / 条目 prompt）" })
  @IsOptional()
  @IsString()
  keyword?: string
}

// 分组/标签等聚合随 Tab 取值：mine 只看自己的 / system 只看系统 / all 两者并集
export class TemplateScopeQueryDto {
  @ApiPropertyOptional({
    description: "Tab：all 全部 / mine 我的 / system 系统（默认 all）",
    enum: TEMPLATE_TABS,
  })
  @IsOptional()
  @IsIn(TEMPLATE_TABS as readonly string[])
  tab?: TemplateTab
}

export class QuerySystemTemplateDto extends PaginationDto {
  @ApiPropertyOptional({ description: "分组 id 精确筛选" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  groupId?: number

  @ApiPropertyOptional({ description: "关键字模糊匹配（模板名 / 备注 / 条目 prompt）" })
  @IsOptional()
  @IsString()
  keyword?: string
}
