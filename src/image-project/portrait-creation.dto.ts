import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator"
import { PORTRAIT_RESOLUTION_TIERS, type PortraitResolutionTier } from "./portrait-size-planner"

export const PORTRAIT_CREATION_TYPES = ["SINGLE_PORTRAIT", "FOUR_VIEW_CHARACTER"] as const
export type PortraitCreationType = (typeof PORTRAIT_CREATION_TYPES)[number]

export class PortraitDeliveryTargetDto {
  @ApiPropertyOptional({ description: "图片比例（必填，如 4:5）；模型不支持时后端就近归一后裁切适配", example: "4:5" })
  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*:[1-9]\d*$/, { message: "图片比例格式应为宽:高" })
  aspectRatio?: string

  @ApiPropertyOptional({
    description: "清晰度档位（必填）；与 aspectRatio 成对构成交付目标",
    enum: PORTRAIT_RESOLUTION_TIERS,
  })
  @IsOptional()
  @IsIn(PORTRAIT_RESOLUTION_TIERS)
  resolutionTier?: PortraitResolutionTier

  // 以下像素字段已废弃：统一 ratio 模式，不再支持指定像素输出；保留声明仅为让旧请求得到明确的 400
  @ApiPropertyOptional({
    description: "（已废弃）统一 ratio 模式；传入 pixels 相关字段将被拒绝",
    enum: ["ratio", "pixels"],
    deprecated: true,
  })
  @IsOptional()
  @IsIn(["ratio", "pixels"])
  customSizeMode?: "ratio" | "pixels"

  @ApiPropertyOptional({ description: "（已废弃）不再支持指定像素输出", minimum: 64, maximum: 8192, deprecated: true })
  @ValidateIf((o: PortraitDeliveryTargetDto) => o.customSizeMode === "pixels")
  @Type(() => Number)
  @IsInt()
  @Min(64)
  @Max(8192)
  customWidth?: number

  @ApiPropertyOptional({ description: "（已废弃）不再支持指定像素输出", minimum: 64, maximum: 8192, deprecated: true })
  @ValidateIf((o: PortraitDeliveryTargetDto) => o.customSizeMode === "pixels")
  @Type(() => Number)
  @IsInt()
  @Min(64)
  @Max(8192)
  customHeight?: number
}

export class CreatePortraitTaskDto {
  @ApiProperty({ description: "前端拼装完成的最终提示词；后端原样保存和提交" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20_000)
  prompt: string

  @ApiProperty({
    description: "提示词配置快照，creation_type 位于此对象中",
    example: {
      schema_version: 1,
      creation_type: "FOUR_VIEW_CHARACTER",
      character_name: "林夏",
      modules: {},
      references: [],
      model_params: { quality: "standard", output_format: "png" },
    },
  })
  @IsObject()
  promptConfig: Record<string, unknown>

  @ApiProperty({
    description: "视角配置快照；四视角角色卡必须包含 index 1～4 的四个非空视角",
    example: { views: [{ index: 1, content: "正面半身" }] },
  })
  @IsObject()
  viewConfig: Record<string, unknown>

  @ApiProperty({ description: "模型编码，后端原样传给后续接入的统一生图能力" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  model: string

  @ApiPropertyOptional({
    description: "兼容旧前端的图片比例；新前端请传 deliveryTarget，尺寸参数由后端按模型能力规划",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*:[1-9]\d*$/, { message: "图片比例格式应为宽:高" })
  aspectRatio?: string

  @ApiPropertyOptional({
    description: "用户最终交付目标；后端根据模型能力规划实际生图参数，并在回调后统一裁切/留白/缩放",
    type: PortraitDeliveryTargetDto,
  })
  @IsOptional()
  @Type(() => PortraitDeliveryTargetDto)
  @ValidateNested()
  deliveryTarget?: PortraitDeliveryTargetDto

  @ApiPropertyOptional({ description: "生成图片数量", minimum: 1, maximum: 4, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  quantity?: number
}

export class PortraitImageIdsDto {
  @ApiProperty({ description: "生成图片 ID，按传入顺序处理", type: [Number] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  imageIds: number[]
}

export class SavePortraitTemplateDto extends PortraitImageIdsDto {
  @ApiProperty({
    description: "CREATE 新建多图模板 / APPEND 追加到个人模板",
    enum: ["CREATE", "APPEND"],
  })
  @IsIn(["CREATE", "APPEND"])
  mode: "CREATE" | "APPEND"

  @ApiPropertyOptional({ description: "新建时的模板名称" })
  @ValidateIf((o: SavePortraitTemplateDto) => o.mode === "CREATE")
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  templateName?: string

  @ApiPropertyOptional({ description: "新建时的个人模板分组名称" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  groupName?: string

  @ApiPropertyOptional({ description: "追加模式下的个人模板 ID" })
  @ValidateIf((o: SavePortraitTemplateDto) => o.mode === "APPEND")
  @Type(() => Number)
  @IsInt()
  @Min(1)
  templateId?: number
}
