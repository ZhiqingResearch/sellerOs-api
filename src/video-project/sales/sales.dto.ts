import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"

// 产品信息来源：四选一（互斥，大模型只取其中一种路径）
export const SALES_INFO_SOURCES = ["TEXT", "URL", "IMAGE", "MANUAL"] as const
export type SalesInfoSource = (typeof SALES_INFO_SOURCES)[number]

// 成片方式：一键成片（拼接成 1 个任务）/ 分段生成（每段 1 个任务）
export const SALES_OUTPUT_MODES = ["ONESHOT", "SEGMENTED"] as const
export type SalesOutputMode = (typeof SALES_OUTPUT_MODES)[number]

// =========================================================
// 子结构
// =========================================================

class SalesProductImageDto {
  @ApiProperty({ description: "产品图 URL（前端已直传 OSS）" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  url: string

  @ApiPropertyOptional({ description: "名称" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string

  @ApiPropertyOptional({ description: "来源素材池图片 id（若从素材池选）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  fromPoolImageId?: number
}

class SalesPainPointDto {
  @ApiProperty({ description: "痛点文案" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  text: string

  @ApiProperty({ description: "是否选中（进入脚本）", default: true })
  @IsBoolean()
  selected: boolean
}

class SalesDigitalHumanDto {
  @ApiPropertyOptional({ description: "来源素材池数字人 id" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  id?: number

  @ApiProperty({ description: "数字人名称" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string

  @ApiPropertyOptional({ description: "肖像图 URL（作为参考图注入生成）" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  portraitUrl?: string

  @ApiPropertyOptional({ description: "人设/主体身份（注入脚本生成的隐藏字段）" })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  persona?: string
}

class SalesSceneDto {
  @ApiPropertyOptional({ description: "来源素材池场景 id" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  id?: number

  @ApiProperty({ description: "场景名称" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string

  @ApiPropertyOptional({ description: "场景图 URL（作为参考图注入生成）" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  imageUrl?: string

  @ApiPropertyOptional({ description: "场景描述（拼进可见 prompt）" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  desc?: string
}

class SalesSegmentDto {
  @ApiProperty({ description: "分镜顺序（从 0 起）" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  order: number

  @ApiProperty({ description: "区间起（秒）" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  startSec: number

  @ApiProperty({ description: "区间止（秒）" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  endSec: number

  @ApiProperty({ description: "视频提示词（参考生视频）" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  vidPrompt: string

  @ApiProperty({ description: "口播文案 中文/English" })
  @IsString()
  @MaxLength(1000)
  voiceover: string
}

// =========================================================
// 请求 DTO
// =========================================================

export class CreateSalesProjectDto {
  @ApiPropertyOptional({ description: "项目名称，默认「未命名项目」" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string
}

// Step1 产品 & 痛点：仅更新传入字段（前端解析/生成后写回）
export class SaveSalesProductDto {
  @ApiPropertyOptional({ description: "产品图（上限 3）", type: [SalesProductImageDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalesProductImageDto)
  @ArrayMaxSize(3)
  productImages?: SalesProductImageDto[]

  @ApiPropertyOptional({ description: "信息源类型（四选一）", enum: SALES_INFO_SOURCES })
  @IsOptional()
  @IsIn(SALES_INFO_SOURCES as readonly string[])
  infoSource?: SalesInfoSource

  @ApiPropertyOptional({ description: "文字描述原文" })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  textInput?: string

  @ApiPropertyOptional({ description: "Amazon 链接" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  sourceUrl?: string

  @ApiPropertyOptional({ description: "产品手册文件 URL" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  manualFileUrl?: string

  @ApiPropertyOptional({ description: "统一 schema 结构化商品信息（前端提取/编辑后写回）" })
  @IsOptional()
  @IsObject()
  productInfo?: Record<string, unknown>

  @ApiPropertyOptional({ description: "痛点列表", type: [SalesPainPointDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalesPainPointDto)
  @ArrayMaxSize(20)
  painPoints?: SalesPainPointDto[]
}

// Step2 选素材：数字人 / 场景各上限 1；传 null 表示清除该选择
export class SaveSalesMaterialsDto {
  @ApiPropertyOptional({
    description: "数字人快照（null 清除）",
    type: SalesDigitalHumanDto,
    nullable: true,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SalesDigitalHumanDto)
  digitalHuman?: SalesDigitalHumanDto | null

  @ApiPropertyOptional({
    description: "场景快照（null 清除）",
    type: SalesSceneDto,
    nullable: true,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SalesSceneDto)
  scene?: SalesSceneDto | null
}

// Step3 生成脚本：保存出片参数 + 分镜（前端生成后写回，segments 传入即全量替换）
export class SaveSalesScriptDto {
  @ApiPropertyOptional({ description: "AI Gateway 全能参考视频模型 publicId" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string

  @ApiPropertyOptional({ description: "成片总时长（秒）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  totalDuration?: number

  @ApiPropertyOptional({ description: "生成音频", default: false })
  @IsOptional()
  @IsBoolean()
  generateAudio?: boolean

  @ApiPropertyOptional({ description: "比例，默认 9:16" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  aspectRatio?: string

  @ApiPropertyOptional({ description: "分辨率档位" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  resolution?: string

  @ApiPropertyOptional({ description: "分镜脚本（传入即全量替换）", type: [SalesSegmentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalesSegmentDto)
  @ArrayMaxSize(20)
  segments?: SalesSegmentDto[]
}

// Step4 确认出片：选择成片方式后触发生成
export class GenerateSalesDto {
  @ApiPropertyOptional({
    description:
      "成片方式：ONESHOT 一键成片（拼接 1 个任务）/ SEGMENTED 分段生成（每段 1 个任务）；默认沿用上次或 ONESHOT",
    enum: SALES_OUTPUT_MODES,
  })
  @IsOptional()
  @IsIn(SALES_OUTPUT_MODES as readonly string[])
  outputMode?: SalesOutputMode
}
