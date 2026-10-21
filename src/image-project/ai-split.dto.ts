import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../common/dto/pagination.dto"
import { PortraitDeliveryTargetDto } from "./portrait-creation.dto"

export const AI_SPLIT_REFERENCE_SOURCES = ["COMPETITOR_DATA", "UPLOAD", "DIRECT_URL"] as const
export type AiSplitReferenceSource = (typeof AI_SPLIT_REFERENCE_SOURCES)[number]

/** 站点码：`平台_国家码` 格式（AMAZON_US / TIKTOK_MX…）。不再枚举白名单——
 *  图上文案语言与商品资料 locale 由国家码动态推导
 *  （common/utils/marketplace-language），新平台/新国家站点零改动生效；
 *  格式不合法直接 400。 */
export const AI_SPLIT_SITE_PATTERN = /^[A-Za-z0-9]+[-_][A-Za-z]{2}$/
export type AiSplitSite = string

export const AI_SPLIT_TEXT_AMOUNTS = ["NONE", "LOW", "MEDIUM", "HIGH"] as const
export type AiSplitTextAmount = (typeof AI_SPLIT_TEXT_AMOUNTS)[number]

export const AI_SPLIT_TEMPLATE_SAVE_MODES = ["CREATE", "APPEND"] as const
export type AiSplitTemplateSaveMode = (typeof AI_SPLIT_TEMPLATE_SAVE_MODES)[number]

export class AiSplitCompetitorReferenceDto {
  @ApiProperty({ enum: AI_SPLIT_REFERENCE_SOURCES })
  @IsIn(AI_SPLIT_REFERENCE_SOURCES as readonly string[])
  sourceType: AiSplitReferenceSource

  @ApiPropertyOptional({ description: "COMPETITOR_DATA 对应的当前用户素材池图片 ID" })
  @ValidateIf((dto: AiSplitCompetitorReferenceDto) => dto.sourceType === "COMPETITOR_DATA")
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sourceId?: number

  @ApiPropertyOptional({ description: "UPLOAD / DIRECT_URL 的 HTTPS 图片地址" })
  @ValidateIf((dto: AiSplitCompetitorReferenceDto) => dto.sourceType !== "COMPETITOR_DATA")
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @MaxLength(1000)
  url?: string

  @ApiPropertyOptional({ description: "上传图片是否同时保存到素材池", default: false })
  @ValidateIf((dto: AiSplitCompetitorReferenceDto) => dto.sourceType === "UPLOAD")
  @IsOptional()
  @IsBoolean()
  saveToCompetitorData?: boolean
}

export class AiSplitPromptConfigDto {
  @ApiProperty({
    name: "model_params",
    description: "与人像创作一致的 Gateway 模型动态参数",
    example: {
      aspect_ratio: "1:1",
      size: "2048x2048",
      quality: "standard",
      output_format: "png",
    },
  })
  @IsObject()
  model_params: Record<string, unknown>
}

export class CreateAiSplitTaskDto {
  @ApiProperty({ description: "前端创建请求幂等 UUID" })
  @IsUUID("4")
  clientRequestId: string

  @ApiProperty({ type: [AiSplitCompetitorReferenceDto], description: "竞品参考图，一图一方向" })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AiSplitCompetitorReferenceDto)
  competitorReferences: AiSplitCompetitorReferenceDto[]

  @ApiProperty({
    example: "AMAZON_US",
    description: "站点码（平台_国家码，如 AMAZON_US / TIKTOK_MX；图上文案语言按国家码动态推导）",
  })
  @Matches(AI_SPLIT_SITE_PATTERN, { message: "站点格式不合法，应为 平台_国家码（如 AMAZON_US）" })
  site: AiSplitSite

  @ApiProperty({ enum: AI_SPLIT_TEXT_AMOUNTS, example: "LOW" })
  @IsIn(AI_SPLIT_TEXT_AMOUNTS as readonly string[])
  textAmount: AiSplitTextAmount

  @ApiProperty({ description: "用户选择的最终生图模型 Gateway publicId" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model: string

  @ApiProperty({ description: "每个竞品方向的生成数量", minimum: 1, maximum: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  quantity: number

  @ApiProperty({ type: AiSplitPromptConfigDto })
  @ValidateNested()
  @Type(() => AiSplitPromptConfigDto)
  promptConfig: AiSplitPromptConfigDto

  @ApiPropertyOptional({
    description:
      "用户最终交付目标（与人像创作同口径）：ratio 模式 aspectRatio+resolutionTier(1K~4K)，pixels 模式自定义宽高；传入时优先于 model_params 的尺寸参数，后端按模型能力规划生成档位并裁切交付",
    type: PortraitDeliveryTargetDto,
  })
  @IsOptional()
  @Type(() => PortraitDeliveryTargetDto)
  @ValidateNested()
  deliveryTarget?: PortraitDeliveryTargetDto
}

export class QueryAiSplitCompetitorImagesDto extends PaginationDto {
  @ApiPropertyOptional({ description: "按素材名、Prompt 或标签搜索" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string
}

export class QueryAiSplitTasksDto {
  @ApiPropertyOptional({ description: "AI 拆图任务组 ID；与 projectId 至少传一个" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  groupId?: string

  @ApiPropertyOptional({
    description:
      "项目 ID，返回该项目全部 AI 拆图任务组（时间倒序，最新组带 isLatest）；与 groupId 至少传一个",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  projectId?: number
}

export class RetryAiSplitTaskDto {
  @ApiProperty({ description: "本次重试操作的幂等标识" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  clientRequestId: string

  @ApiProperty({ type: [Number], description: "原任务中失败或超时的图片席位 ID" })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  generatedImageIds: number[]
}

export class AiSplitUploadUrlDto {
  @ApiProperty({ example: "competitor.webp" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string

  @ApiProperty({ enum: ["image/jpeg", "image/png", "image/webp"] })
  @IsIn(["image/jpeg", "image/png", "image/webp"])
  contentType: string

  @ApiProperty({ description: "文件字节数，最大 20MB" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20 * 1024 * 1024)
  fileSize: number
}

export class ValidateAiSplitReferenceUrlDto {
  @ApiProperty({ description: "可公开直接访问的 HTTPS 图片地址" })
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @MaxLength(1000)
  url: string
}

export class AiSplitImageIdsDto {
  @ApiProperty({ type: [Number], description: "AI 拆图成功图片 ID" })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  imageIds: number[]
}

export class AiSplitTemplateGenerationSettingsDto {
  @ApiProperty({
    example: "AMAZON_US",
    description: "站点码（平台_国家码，如 AMAZON_US / TIKTOK_MX；图上文案语言按国家码动态推导）",
  })
  @Matches(AI_SPLIT_SITE_PATTERN, { message: "站点格式不合法，应为 平台_国家码（如 AMAZON_US）" })
  site: AiSplitSite

  @ApiProperty({ enum: AI_SPLIT_TEXT_AMOUNTS })
  @IsIn(AI_SPLIT_TEXT_AMOUNTS as readonly string[])
  textAmount: AiSplitTextAmount

  @ApiProperty({ description: "生图模型 Gateway publicId" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model: string

  @ApiProperty({ minimum: 1, maximum: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  quantity: number

  @ApiProperty({ name: "model_params", description: "该模板条目的生图模型参数" })
  @IsObject()
  model_params: Record<string, unknown>
}

export class SaveAiSplitTemplateItemDto {
  @ApiProperty({ description: "AI 拆图成功图片 ID" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  generatedImageId: number

  @ApiProperty({ description: "模板条目名称", example: "暗色工业风主图" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string

  @ApiProperty({ description: "用户最终确认的生成提示词" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  prompt: string

  @ApiProperty({ type: AiSplitTemplateGenerationSettingsDto })
  @ValidateNested()
  @Type(() => AiSplitTemplateGenerationSettingsDto)
  generationSettings: AiSplitTemplateGenerationSettingsDto
}

export class SaveAiSplitResultsToTemplateDto {
  @ApiProperty({
    enum: AI_SPLIT_TEMPLATE_SAVE_MODES,
    description: "CREATE 新建个人模板；APPEND 追加到已有个人模板",
  })
  @IsIn(AI_SPLIT_TEMPLATE_SAVE_MODES as readonly string[])
  mode: AiSplitTemplateSaveMode

  @ApiPropertyOptional({ description: "APPEND 时必传的个人模板 ID" })
  @ValidateIf((dto: SaveAiSplitResultsToTemplateDto) => dto.mode === "APPEND")
  @Type(() => Number)
  @IsInt()
  @Min(1)
  templateId?: number

  @ApiPropertyOptional({
    description: "CREATE 时必传的新模板名称",
    example: "Running Board 拆图模板",
  })
  @ValidateIf((dto: SaveAiSplitResultsToTemplateDto) => dto.mode === "CREATE")
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  templateName?: string

  @ApiPropertyOptional({ description: "CREATE 时可选的个人分组 ID" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId?: number

  @ApiProperty({ type: [SaveAiSplitTemplateItemDto], description: "要保存的模板条目" })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique((item: SaveAiSplitTemplateItemDto) => item.generatedImageId)
  @ValidateNested({ each: true })
  @Type(() => SaveAiSplitTemplateItemDto)
  items: SaveAiSplitTemplateItemDto[]
}

export class ReuseAiSplitTemplateItemDto {
  @ApiProperty({ description: "要复用的模板条目 ID" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  templateItemId: number

  @ApiProperty({
    example: "AMAZON_US",
    description: "站点码（平台_国家码，如 AMAZON_US / TIKTOK_MX；图上文案语言按国家码动态推导）",
  })
  @Matches(AI_SPLIT_SITE_PATTERN, { message: "站点格式不合法，应为 平台_国家码（如 AMAZON_US）" })
  site: AiSplitSite

  @ApiProperty({ enum: AI_SPLIT_TEXT_AMOUNTS })
  @IsIn(AI_SPLIT_TEXT_AMOUNTS as readonly string[])
  textAmount: AiSplitTextAmount

  @ApiProperty({ description: "本次复用选择的生图模型 Gateway publicId" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model: string

  @ApiProperty({ minimum: 1, maximum: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  quantity: number

  @ApiProperty({ type: AiSplitPromptConfigDto })
  @ValidateNested()
  @Type(() => AiSplitPromptConfigDto)
  promptConfig: AiSplitPromptConfigDto

  @ApiPropertyOptional({
    description:
      "用户最终交付目标（与人像创作同口径）；传入时优先于 promptConfig.model_params 的尺寸参数",
    type: PortraitDeliveryTargetDto,
  })
  @IsOptional()
  @Type(() => PortraitDeliveryTargetDto)
  @ValidateNested()
  deliveryTarget?: PortraitDeliveryTargetDto
}

export class CreateAiSplitTemplateTaskDto {
  @ApiProperty({ description: "前端模板复用请求幂等 UUID" })
  @IsUUID("4")
  clientRequestId: string

  @ApiProperty({ type: [ReuseAiSplitTemplateItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique((item: ReuseAiSplitTemplateItemDto) => item.templateItemId)
  @ValidateNested({ each: true })
  @Type(() => ReuseAiSplitTemplateItemDto)
  items: ReuseAiSplitTemplateItemDto[]
}
