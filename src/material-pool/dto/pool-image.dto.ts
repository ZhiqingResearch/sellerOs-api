import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"
import type { PoolImageKind } from "../pool-image.constants"
import { POOL_IMAGE_KINDS } from "../pool-image.constants"
import { BatchIdsDto } from "./common.dto"

// 素材图列表查询：分页 + 关键字 + 分组 / 标签 / 分类 / 类型筛选
export class QueryPoolImageDto extends PaginationDto {
  @ApiPropertyOptional({ description: "关键字模糊匹配（名称 / prompt / 标签）" })
  @IsOptional()
  @IsString()
  keyword?: string

  @ApiPropertyOptional({ description: "分组 id 精确筛选（不传=全部）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  groupId?: number

  @ApiPropertyOptional({ description: "只看未归组（true 时忽略 groupId）", example: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  ungrouped?: boolean

  @ApiPropertyOptional({ description: "标签精确筛选" })
  @IsOptional()
  @IsString()
  tag?: string

  @ApiPropertyOptional({ description: "分类精确筛选" })
  @IsOptional()
  @IsString()
  category?: string

  @ApiPropertyOptional({ enum: POOL_IMAGE_KINDS, description: "素材类型筛选（不传=全部）" })
  @IsOptional()
  @IsIn(POOL_IMAGE_KINDS as readonly string[])
  kind?: PoolImageKind
}

// 手动存入素材池（按 url 去重，name/prompt 仅作展示与搜索）
export class StorePoolImageDto {
  @ApiProperty({ description: "名称（仅搜索展示，不参与去重）", example: "生成1" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string

  @ApiPropertyOptional({ description: "真实图 URL（去重键；无则用 hue 占位）" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  url?: string

  @ApiPropertyOptional({ description: "占位渐变色相（0–360）", default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  hue?: number

  @ApiPropertyOptional({ description: "prompt（仅搜索，卡片不显示）" })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  prompt?: string

  @ApiPropertyOptional({ description: "派生来源标签", example: "生成1" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sourceLabel?: string

  @ApiPropertyOptional({ description: "标签数组", type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(30)
  tags?: string[]

  @ApiPropertyOptional({ description: "分类数组", type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(30)
  categories?: string[]

  @ApiPropertyOptional({ description: "存入的分组 id（不传=不归组）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  groupId?: number

  @ApiPropertyOptional({
    enum: POOL_IMAGE_KINDS,
    description: "素材类型（不传=普通素材图；competitor=AI 拆图竞品参考图）",
  })
  @IsOptional()
  @IsIn(POOL_IMAGE_KINDS as readonly string[])
  kind?: PoolImageKind

  @ApiPropertyOptional({
    description:
      "项目归属（可选）：必须是本人电商创作项目，否则 404；不传 = 公共库。kind=competitor 时传 projectId 才会出现在该项目的拆图选图中",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  projectId?: number
}

// 变体条目（前端已拿到图）
export class VariantItemDto {
  @ApiProperty({ description: "变体图 URL" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  url: string

  @ApiPropertyOptional({ description: "占位渐变色相（0–360）", default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  hue?: number

  @ApiProperty({ description: "变体名称", example: "生成1·变体1" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string

  @ApiPropertyOptional({ description: "prompt（仅搜索）" })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  prompt?: string
}

// 变体持久化：前端拿到 N 张变体后落库，自动入池（不归组、打「变体」标签、不去重）
export class PersistVariantsDto {
  @ApiPropertyOptional({ description: "源图 id（已入池时传，建立血缘）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sourceImageId?: number

  @ApiProperty({ description: "派生来源标签", example: "生成1·变体" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sourceLabel: string

  @ApiPropertyOptional({
    description: "发散方向（换场景/换角度/...）；仅作元数据折进标签",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(8)
  directions?: string[]

  @ApiProperty({ description: "变体条目（1–8 张）", type: [VariantItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariantItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  items: VariantItemDto[]
}

// 批量移到分组：ids + 目标分组（不传/null = 移出分组）
export class BatchMoveToGroupDto extends BatchIdsDto {
  @ApiPropertyOptional({ description: "目标分组 id（不传=移出分组）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  groupId?: number
}
