import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../common/dto/pagination.dto"

// 项目状态（与 prisma schema 注释一致；后端不强约束，仅做白名单）
export const PROJECT_STATUSES = ["DRAFT", "GENERATING", "COMPLETED", "ARCHIVED"] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

// 创作类型：通用创作 / 电商创作 / 人像创作。项目与任务共用
export const PROJECT_TYPES = ["GENERAL", "ECOMMERCE", "PORTRAIT"] as const
export type ProjectType = (typeof PROJECT_TYPES)[number]

// 任务中心状态（与前端原型对齐）：
//   GENERATING=运行中 / SUCCESS=已完成 / FAILED=失败 / TIMEOUT=超时 / CANCELLED=已取消
export const TASK_STATUSES = ["GENERATING", "SUCCESS", "FAILED", "TIMEOUT", "CANCELLED"] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

// 生成图席位状态（用于单张图状态，不依赖外层任务状态）
export const IMAGE_STATUSES = ["GENERATING", "SUCCESS", "FAILED", "TIMEOUT", "CANCELLED"] as const
export type ImageStatus = (typeof IMAGE_STATUSES)[number]

export const PRODUCT_IMAGE_PURPOSES = [
  "PRODUCT_MAIN",
  "PRODUCT_DETAIL",
  "PACKAGING",
  "ACCESSORY",
  "USAGE_SCENE",
  "LABEL_LOGO",
  "OTHER",
] as const
export type ProductImagePurpose = (typeof PRODUCT_IMAGE_PURPOSES)[number]

// =========================================================
// ImageProject
// =========================================================

export class CreateImageProjectDto {
  @ApiProperty({ description: "项目名称", example: "夏季新品·防晒霜推广图" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string

  @ApiPropertyOptional({
    description: "创作类型：GENERAL 通用创作 / ECOMMERCE 电商创作 / PORTRAIT 人像创作",
    enum: PROJECT_TYPES,
  })
  @IsOptional()
  @IsIn(PROJECT_TYPES as readonly string[])
  type?: ProjectType

  @ApiPropertyOptional({ description: "初始状态，默认 DRAFT", enum: PROJECT_STATUSES })
  @IsOptional()
  @IsIn(PROJECT_STATUSES as readonly string[])
  status?: ProjectStatus
}

export class UpdateImageProjectDto {
  @ApiPropertyOptional({ description: "项目名称" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string

  @ApiPropertyOptional({ description: "项目状态", enum: PROJECT_STATUSES })
  @IsOptional()
  @IsIn(PROJECT_STATUSES as readonly string[])
  status?: ProjectStatus
}

export class QueryImageProjectDto extends PaginationDto {
  @ApiPropertyOptional({ description: "创作类型筛选", enum: PROJECT_TYPES })
  @IsOptional()
  @IsIn(PROJECT_TYPES as readonly string[])
  type?: ProjectType

  @ApiPropertyOptional({ description: "状态筛选", enum: PROJECT_STATUSES })
  @IsOptional()
  @IsIn(PROJECT_STATUSES as readonly string[])
  status?: ProjectStatus

  @ApiPropertyOptional({ description: "项目名称模糊匹配" })
  @IsOptional()
  @IsString()
  name?: string
}

// =========================================================
// ProductProfile（upsert，仅传入字段会被更新）
// =========================================================

class AttributeItem {
  @ApiProperty({ example: "重量" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  key: string

  @ApiProperty({ example: "500g" })
  @IsString()
  @MaxLength(500)
  value: string
}

class AudienceDto {
  @ApiPropertyOptional({ example: "美国郊区家庭主妇", description: "受众画像" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  portrait?: string

  @ApiPropertyOptional({ example: "中青年（26-35）", description: "年龄段（前端写死下拉）" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  ageRange?: string

  @ApiPropertyOptional({ example: "中端", description: "消费层级（前端写死下拉）" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  consumptionTier?: string
}

class CommerceDto {
  @ApiPropertyOptional({ example: "$29.99", description: "售价（带币种符号）" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  price?: string

  @ApiPropertyOptional({ example: 4.5, description: "评分" })
  @IsOptional()
  @IsNumber()
  rating?: number

  @ApiPropertyOptional({ example: 1234, description: "BSR（Best Seller Rank）排名数字" })
  @IsOptional()
  @IsInt()
  bsr?: number

  @ApiPropertyOptional({
    example: "#1 in Tumblers & Water Bottles",
    description: "BSR 原始展示串（保留类目文字，bsr 数字之外的保真存储）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bsrLabel?: string

  @ApiPropertyOptional({ example: 6, description: "变体数" })
  @IsOptional()
  @IsInt()
  variantCount?: number

  @ApiPropertyOptional({ example: "FBA", description: "履约方式" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  fulfillment?: string

  @ApiPropertyOptional({ example: "28956", description: "评论数（展示原文，可能带千分位/单位）" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  reviewCount?: string

  @ApiPropertyOptional({ example: "amazon", description: "来源平台" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sourcePlatform?: string

  @ApiPropertyOptional({
    example: "B0CXXXXXXX",
    description: "来源商品 ID（ASIN / Walmart item id）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sourceProductId?: string

  @ApiPropertyOptional({
    example: "Home & Kitchen > Kitchen & Dining > Drinkware > Tumblers",
    description: "来源类目路径（面包屑原文）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceCategoryPath?: string

  @ApiPropertyOptional({ example: 1716960000000, description: "抓取时间戳（unix ms）" })
  @IsOptional()
  @IsInt()
  sourceFetchedAt?: number

  @ApiPropertyOptional({
    description: "抓取候选图 URL 列表（≤8）",
    type: [String],
    example: ["https://m.media-amazon.com/.../a.jpg"],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(8)
  sourceImages?: string[]
}

const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

export class ProductProfileLocalizationContentDto {
  @ApiPropertyOptional({ description: "产品名" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  productName?: string

  @ApiPropertyOptional({ description: "一级类目" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryL1?: string

  @ApiPropertyOptional({ description: "二级类目" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryL2?: string

  @ApiPropertyOptional({ description: "三级类目" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryL3?: string

  @ApiPropertyOptional({ description: "属性 KV 列表", type: [AttributeItem] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttributeItem)
  attributes?: AttributeItem[]

  @ApiPropertyOptional({ description: "卖点", type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sellingPoints?: string[]

  @ApiPropertyOptional({ description: "认证", type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  certifications?: string[]

  @ApiPropertyOptional({ description: "目标受众", type: AudienceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AudienceDto)
  audience?: AudienceDto

  @ApiPropertyOptional({ description: "补充资料" })
  @IsOptional()
  @IsString()
  extra?: string
}

class ProductProfileLocalizationDto {
  @ApiProperty({ example: "ru-RU", description: "BCP 47 语言标识" })
  @IsString()
  @MaxLength(20)
  @Matches(LOCALE_PATTERN)
  locale: string

  @ApiProperty({ type: ProductProfileLocalizationContentDto })
  @ValidateNested()
  @Type(() => ProductProfileLocalizationContentDto)
  content: ProductProfileLocalizationContentDto

  @ApiPropertyOptional({ example: "ru-RU", description: "翻译来源语言" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(LOCALE_PATTERN)
  translatedFrom?: string
}

export class UpsertProductProfileDto {
  @ApiPropertyOptional({ description: "产品名" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  productName?: string

  @ApiPropertyOptional({ description: "SKU" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string

  @ApiPropertyOptional({ description: "品牌名" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  brandName?: string

  @ApiPropertyOptional({ description: "一级类目" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryL1?: string

  @ApiPropertyOptional({ description: "二级类目" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryL2?: string

  @ApiPropertyOptional({ description: "三级类目" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryL3?: string

  @ApiPropertyOptional({
    description: "目标国家/地区（多选，前端预设 + 自定义）",
    type: [String],
    example: ["美国", "日本"],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  targetCountries?: string[]

  @ApiPropertyOptional({
    description: "电商平台（多选，前端预设 + 自定义）",
    type: [String],
    example: ["Amazon", "Walmart"],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  ecommercePlatforms?: string[]

  @ApiPropertyOptional({
    description: "商业数据（URL 抓取后自动填充）",
    type: CommerceDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CommerceDto)
  commerce?: CommerceDto

  @ApiPropertyOptional({ description: "属性 KV 列表", type: [AttributeItem] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttributeItem)
  attributes?: AttributeItem[]

  @ApiPropertyOptional({ description: "卖点", type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sellingPoints?: string[]

  @ApiPropertyOptional({ description: "认证", type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  certifications?: string[]

  @ApiPropertyOptional({ description: "目标受众", type: AudienceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AudienceDto)
  audience?: AudienceDto

  @ApiPropertyOptional({ description: "补充资料" })
  @IsOptional()
  @IsString()
  extra?: string

  @ApiPropertyOptional({ description: "手册 PDF URL（三件套来源审计）" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  manualPdfUrl?: string

  @ApiPropertyOptional({ description: "原始 URL（三件套来源审计）" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  sourceUrl?: string

  @ApiPropertyOptional({ example: "ru-RU", description: "抓取商品资料的原始语言" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(LOCALE_PATTERN)
  sourceLocale?: string

  @ApiPropertyOptional({ example: "zh-CN", description: "旧字段及生成链路使用的默认语言" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(LOCALE_PATTERN)
  defaultLocale?: string

  @ApiPropertyOptional({
    description: "商品资料语言版本；按 locale 增量合并，未传语言保持不变",
    type: [ProductProfileLocalizationDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ProductProfileLocalizationDto)
  localizations?: ProductProfileLocalizationDto[]
}

// =========================================================
// BrandIdentity（upsert）
// =========================================================

export class UpsertBrandIdentityDto {
  @ApiPropertyOptional({ description: "中文品牌名" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  brandNameZh?: string

  @ApiPropertyOptional({ description: "英文品牌名" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  brandNameEn?: string

  @ApiPropertyOptional({
    description: "主色调 HEX 列表（最多 5 个）",
    type: [String],
    example: ["#0071E3", "#FF5733"],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsHexColor({ each: true })
  primaryColors?: string[]

  @ApiPropertyOptional({ description: "生成时应用品牌色（品牌级开关，默认关）", default: false })
  @IsOptional()
  @IsBoolean()
  applyBrandColor?: boolean

  @ApiPropertyOptional({
    description: "设计风格（多选，前端 16 预设 + 自定义）",
    type: [String],
    example: ["极简", "科技感"],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(30)
  designStyles?: string[]

  @ApiPropertyOptional({
    description: "图案元素（多选，前端 8 预设 + 自定义）",
    type: [String],
    example: ["几何", "插画"],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(30)
  patterns?: string[]

  @ApiPropertyOptional({ description: "字体（单选）" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  font?: string

  @ApiPropertyOptional({ description: "LOGO URL" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  logoUrl?: string

  @ApiPropertyOptional({ description: "品牌图片 URL（前端取色源，独立于 LOGO）" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  brandImageUrl?: string

  @ApiPropertyOptional({ description: "调性" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  tone?: string
}

// =========================================================
// ProductImage
// =========================================================

export class CreateProductImageDto {
  @ApiProperty({ description: "产品图 URL（已上传到 Spaces）" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  url: string

  @ApiPropertyOptional({ description: "标签：主图 / 细节图 / 场景图 / 包装图 等" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  tag?: string

  @ApiPropertyOptional({ description: "AI 识图稳定用途", enum: PRODUCT_IMAGE_PURPOSES })
  @IsOptional()
  @IsIn(PRODUCT_IMAGE_PURPOSES as readonly string[])
  purpose?: ProductImagePurpose

  @ApiPropertyOptional({ description: "备注" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string

  @ApiPropertyOptional({ description: "是否主图", default: false })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean

  @ApiPropertyOptional({ description: "排序权重", default: 0 })
  @IsOptional()
  @IsInt()
  order?: number
}

export class UpdateProductImageDto {
  @ApiPropertyOptional({ description: "产品图 URL" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  url?: string

  @ApiPropertyOptional({ description: "标签" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  tag?: string

  @ApiPropertyOptional({ description: "AI 识图稳定用途", enum: PRODUCT_IMAGE_PURPOSES })
  @IsOptional()
  @IsIn(PRODUCT_IMAGE_PURPOSES as readonly string[])
  purpose?: ProductImagePurpose

  @ApiPropertyOptional({ description: "备注" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string

  @ApiPropertyOptional({ description: "是否主图" })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean

  @ApiPropertyOptional({ description: "排序权重" })
  @IsOptional()
  @IsInt()
  order?: number
}

// =========================================================
// TaskCenter
// =========================================================

class GeneratedImageInput {
  @ApiPropertyOptional({ description: "生成图 URL（SUCCESS 才传）" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  url?: string

  @ApiPropertyOptional({ description: "状态", enum: IMAGE_STATUSES })
  @IsOptional()
  @IsIn(IMAGE_STATUSES as readonly string[])
  status?: ImageStatus

  @ApiPropertyOptional({ description: "Provider 异步任务 ID（Flux / Qwen）" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerJobId?: string

  @ApiPropertyOptional({ description: "失败原因" })
  @IsOptional()
  @IsString()
  errorMessage?: string

  @ApiPropertyOptional({ description: "排序", default: 0 })
  @IsOptional()
  @IsInt()
  order?: number
}

export class CreateTaskDto {
  @ApiProperty({ description: "预设大类：白底 / 场景 / 尺寸 / 卖点 / 细节 / 包装" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  presetCategory: string

  @ApiPropertyOptional({ description: "二级选项（前端写死）" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  presetOption?: string

  @ApiProperty({
    description: "模型：FLUX_PRO_11 / GPT_IMAGE_1 / NANO_BANANA / QWEN_IMAGE_V2",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  model: string

  @ApiProperty({ description: "最终拼装的 Prompt" })
  @IsString()
  @IsNotEmpty()
  prompt: string

  @ApiPropertyOptional({ description: "文字量：无 / 少 / 中 / 多" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  textAmount?: string

  @ApiPropertyOptional({ description: "语种，如 zh / en / ja" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  language?: string

  @ApiPropertyOptional({ description: "长宽比，如 1:1 / 3:4 / 16:9" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  aspectRatio?: string

  @ApiPropertyOptional({ description: "席位数（生成几张），默认 4", default: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(16)
  n?: number

  @ApiPropertyOptional({
    description: "生成图命名基名，如“主图”或“套图3”；为空时前端按“图 N”命名",
    example: "主图",
    nullable: true,
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  imageLabelBase?: string | null

  @ApiPropertyOptional({ description: "垫图 URL 列表" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  refImageUrls?: string[]

  @ApiPropertyOptional({ description: "整体状态，默认 GENERATING", enum: TASK_STATUSES })
  @IsOptional()
  @IsIn(TASK_STATUSES as readonly string[])
  status?: TaskStatus

  @ApiPropertyOptional({ description: "失败原因" })
  @IsOptional()
  @IsString()
  errorMessage?: string

  @ApiPropertyOptional({
    description:
      "前端 AI 调用完成后的生成图数据（url + status + 任意元数据）；可为空。",
    type: [GeneratedImageInput],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GeneratedImageInput)
  @ArrayMaxSize(16)
  generatedImages?: GeneratedImageInput[]

  @ApiPropertyOptional({
    description:
      "成品入库快照行的来源 ImageGenJob.id（批量改图等 t2i/i2i 归档场景）。" +
      "带上后生成记录视图把该 job 的扣费积分挂到本行，并隐藏原始 IMAGEGEN 行（去重不双计）。",
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sourceJobId?: string
}

export class UpdateTaskDto {
  @ApiPropertyOptional({ description: "整体状态", enum: TASK_STATUSES })
  @IsOptional()
  @IsIn(TASK_STATUSES as readonly string[])
  status?: TaskStatus

  @ApiPropertyOptional({ description: "失败原因" })
  @IsOptional()
  @IsString()
  errorMessage?: string
}

export class QueryTaskDto extends PaginationDto {
  @ApiPropertyOptional({ description: "创作类型筛选：GENERAL / ECOMMERCE", enum: PROJECT_TYPES })
  @IsOptional()
  @IsIn(PROJECT_TYPES as readonly string[])
  type?: ProjectType

  @ApiPropertyOptional({ description: "按项目 ID 筛选" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  projectId?: number

  @ApiPropertyOptional({ description: "任务状态", enum: TASK_STATUSES })
  @IsOptional()
  @IsIn(TASK_STATUSES as readonly string[])
  status?: TaskStatus

  @ApiPropertyOptional({ description: "模型筛选" })
  @IsOptional()
  @IsString()
  model?: string
}

// =========================================================
// GeneratedImage
// =========================================================

export class UpdateGeneratedImageDto {
  @ApiPropertyOptional({ description: "图片 URL" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  url?: string

  @ApiPropertyOptional({ description: "状态", enum: IMAGE_STATUSES })
  @IsOptional()
  @IsIn(IMAGE_STATUSES as readonly string[])
  status?: ImageStatus

  @ApiPropertyOptional({ description: "Provider 任务 ID" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerJobId?: string

  @ApiPropertyOptional({ description: "失败原因" })
  @IsOptional()
  @IsString()
  errorMessage?: string

  @ApiPropertyOptional({ description: "是否采纳" })
  @IsOptional()
  @IsBoolean()
  adopted?: boolean

  @ApiPropertyOptional({ description: "排序" })
  @IsOptional()
  @IsInt()
  order?: number
}

export class RemoveGeneratedImagesDto {
  @ApiProperty({ description: "要从项目中移除的生成图片 ID", type: [Number], example: [101, 102] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  imageIds: number[]
}
