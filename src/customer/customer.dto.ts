import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { ProjectStatus, SourceType, TagCategory } from "@prisma/client"
import { Transform, Type } from "class-transformer"
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "src/common/dto/pagination.dto"

// ==================== 客户 ====================

export class CreateCustomerDto {
  @ApiProperty({ example: "品牌A", description: "客户名称" })
  @IsNotEmpty()
  @IsString()
  name: string

  @ApiProperty({ example: ["美容护肤", "母婴"], description: "所属行业（多选）" })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  industry: string[]

  @ApiProperty({ example: "抗衰/成分党", description: "内容方向" })
  @IsNotEmpty()
  @IsString()
  contentFocus: string

  @ApiProperty({ example: ["小红书", "抖音"], description: "运营平台" })
  @IsArray()
  @IsString({ each: true })
  platforms: string[]

  @ApiPropertyOptional({ example: "25-40岁女性", description: "目标受众" })
  @IsOptional()
  @IsString()
  targetAudience?: string

  @ApiPropertyOptional({ example: "提升品牌知名度", description: "运营目标" })
  @IsOptional()
  @IsString()
  marketingGoals?: string

  @ApiPropertyOptional({ example: "专业、亲和", description: "内容调性" })
  @IsOptional()
  @IsString()
  contentTone?: string

  @ApiPropertyOptional({ example: "竞品对比", description: "规避方向" })
  @IsOptional()
  @IsString()
  avoidTopics?: string
}

export class UpdateCustomerDto {
  @ApiPropertyOptional({ example: "品牌A", description: "客户名称" })
  @IsOptional()
  @IsString()
  name?: string

  @ApiPropertyOptional({ example: ["美容护肤", "母婴"], description: "所属行业（多选）" })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  industry?: string[]

  @ApiPropertyOptional({ example: "抗衰/成分党", description: "内容方向" })
  @IsOptional()
  @IsString()
  contentFocus?: string

  @ApiPropertyOptional({ example: ["小红书", "抖音"], description: "运营平台" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  platforms?: string[]

  @ApiPropertyOptional({ example: "25-40岁女性", description: "目标受众" })
  @IsOptional()
  @IsString()
  targetAudience?: string

  @ApiPropertyOptional({ example: "提升品牌知名度", description: "运营目标" })
  @IsOptional()
  @IsString()
  marketingGoals?: string

  @ApiPropertyOptional({ example: "专业、亲和", description: "内容调性" })
  @IsOptional()
  @IsString()
  contentTone?: string

  @ApiPropertyOptional({ example: "竞品对比", description: "规避方向" })
  @IsOptional()
  @IsString()
  avoidTopics?: string

  @ApiPropertyOptional({ description: "运营方案（Markdown）" })
  @IsOptional()
  @IsString()
  strategy?: string
}

export class QueryCustomerDto {
  @ApiPropertyOptional({ example: "品牌", description: "客户名称（模糊搜索）" })
  @IsOptional()
  @IsString()
  name?: string

  @ApiPropertyOptional({ example: "美容护肤", description: "所属行业" })
  @IsOptional()
  @IsString()
  industry?: string
}

// ==================== 账号 ====================

export class CreateAccountDto {
  @ApiProperty({ example: "@品牌官方", description: "账号名称" })
  @IsNotEmpty()
  @IsString()
  name: string

  @ApiProperty({ example: "小红书", description: "平台" })
  @IsNotEmpty()
  @IsString()
  platform: string

  @ApiPropertyOptional({ example: "知识型·专业", description: "账号风格" })
  @IsOptional()
  @IsString()
  accountStyle?: string

  @ApiProperty({ example: ["抗衰", "成分党"], description: "核心关键词" })
  @IsArray()
  @IsString({ each: true })
  coreKeywords: string[]

  @ApiPropertyOptional({ example: "美妆垂类头部账号", description: "目标定位" })
  @IsOptional()
  @IsString()
  targetPositioning?: string
}

export class UpdateAccountDto {
  @ApiPropertyOptional({ example: "@品牌官方", description: "账号名称" })
  @IsOptional()
  @IsString()
  name?: string

  @ApiPropertyOptional({ example: "小红书", description: "平台" })
  @IsOptional()
  @IsString()
  platform?: string

  @ApiPropertyOptional({ example: "知识型·专业", description: "账号风格" })
  @IsOptional()
  @IsString()
  accountStyle?: string

  @ApiPropertyOptional({ example: ["抗衰", "成分党"], description: "核心关键词" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  coreKeywords?: string[]

  @ApiPropertyOptional({ example: "美妆垂类头部账号", description: "目标定位" })
  @IsOptional()
  @IsString()
  targetPositioning?: string

  @ApiPropertyOptional({ description: "账号规划方案（Markdown）" })
  @IsOptional()
  @IsString()
  strategy?: string
}

// ==================== 形象 ====================

export class CreateAvatarDto {
  @ApiProperty({
    example: "形象A",
    description: "形象名称（仅中文/字母/数字/中划线/下划线，不超过 20 字）",
  })
  @IsNotEmpty()
  @Matches(/^[一-龥A-Za-z0-9_-]{1,20}$/, {
    message: "name 仅可包含中文、字母、数字、中划线、下划线，且不超过 20 字",
  })
  name: string

  @ApiProperty({ example: "FEMALE", description: "性别", enum: ["MALE", "FEMALE"] })
  @IsNotEmpty()
  @IsIn(["MALE", "FEMALE"])
  gender: "MALE" | "FEMALE"

  @ApiPropertyOptional({ example: "职场女性形象", description: "形象描述" })
  @IsOptional()
  @IsString()
  description?: string

  @ApiPropertyOptional({
    example: "1234567890",
    description: "兼容旧客户端fileId；不作为审核依据，后端使用已审核视频重新上传",
  })
  @IsOptional()
  @IsString()
  fileId?: string

  @ApiProperty({
    example: "https://oss.example.com/avatar.mp4",
    description: "训练视频URL，内容审核必填；后端审核快照通过后再上传曦灵训练",
  })
  @IsNotEmpty({ message: "请提供可审核的训练视频trainingUrl" })
  @IsString()
  trainingUrl: string
}

export class QueryAvatarDto {
  @ApiPropertyOptional({
    example: "SUCCESS",
    description: "按训练状态筛选",
    enum: ["GENERATING", "SUCCESS", "FAILED"],
  })
  @IsOptional()
  @IsIn(["GENERATING", "SUCCESS", "FAILED"])
  status?: "GENERATING" | "SUCCESS" | "FAILED"
}

// ==================== 音色 ====================

export class CreateVoiceDto {
  @ApiProperty({ example: "音色A", description: "音色名称（当前账户下唯一，不超过 50 字）" })
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  name: string

  @ApiProperty({
    example: "female",
    description: "性别",
    enum: ["male", "female", "unknown"],
  })
  @IsNotEmpty()
  @IsIn(["male", "female", "unknown"])
  gender: "male" | "female" | "unknown"

  @ApiProperty({
    example: "你好，很高兴认识你，这是一段试听音频。",
    description: "试听文本（用于克隆成功后合成示例音频，不超过 100 字）",
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  exampleText: string

  @ApiPropertyOptional({ example: "温柔知性", description: "音色描述" })
  @IsOptional()
  @IsString()
  description?: string

  @ApiProperty({ example: "https://oss.example.com/voice.mp3", description: "训练音频 URL" })
  @IsNotEmpty()
  @IsString()
  trainingUrl: string
}

export class QueryVoiceDto {
  @ApiPropertyOptional({
    example: "SUCCESS",
    description: "按克隆状态筛选",
    enum: ["GENERATING", "SUCCESS", "FAILED"],
  })
  @IsOptional()
  @IsIn(["GENERATING", "SUCCESS", "FAILED"])
  status?: "GENERATING" | "SUCCESS" | "FAILED"
}

// ==================== 公共形象 / 公共音色 ====================

export class QueryPublicAvatarDto extends PaginationDto {
  @ApiPropertyOptional({ example: "小葵", description: "按名称模糊搜索" })
  @IsOptional()
  @IsString()
  q?: string

  @ApiPropertyOptional({ example: "FEMALE", enum: ["MALE", "FEMALE", "UNKNOWN"] })
  @IsOptional()
  @IsIn(["MALE", "FEMALE", "UNKNOWN"])
  gender?: string

  @ApiPropertyOptional({ example: "青年", enum: ["少年", "青年", "中年", "老年"] })
  @IsOptional()
  @IsIn(["少年", "青年", "中年", "老年"])
  age?: string

  @ApiPropertyOptional({ example: "站姿全身", enum: ["坐姿半身", "站姿半身", "站姿全身"] })
  @IsOptional()
  @IsIn(["坐姿半身", "站姿半身", "站姿全身"])
  pose?: string

  @ApiPropertyOptional({ example: "室内", enum: ["透明", "户外", "室内"] })
  @IsOptional()
  @IsIn(["透明", "户外", "室内"])
  background?: string

  @ApiPropertyOptional({ example: "2D", enum: ["2D", "3D"] })
  @IsOptional()
  @IsIn(["2D", "3D"])
  humanType?: string

  @ApiPropertyOptional({ example: "16:9", enum: ["16:9", "9:16", "1:1", "4:3", "3:4"] })
  @IsOptional()
  @IsString()
  aspectRatio?: string

  @ApiPropertyOptional({ example: false, description: "true 强制重刷镜像（绕过 24h TTL）" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  refresh?: boolean
}

export class QueryPublicVoiceDto extends PaginationDto {
  @ApiPropertyOptional({ example: "小哥", description: "按名称/描述模糊搜索" })
  @IsOptional()
  @IsString()
  q?: string

  @ApiPropertyOptional({ example: "male", enum: ["male", "female", "unknown"] })
  @IsOptional()
  @IsIn(["male", "female", "unknown"])
  gender?: string

  @ApiPropertyOptional({
    example: "青年",
    enum: ["少年", "青少年", "青年", "中年", "老年"],
  })
  @IsOptional()
  @IsIn(["少年", "青少年", "青年", "中年", "老年"])
  age?: string

  @ApiPropertyOptional({ example: "活力激情", enum: ["权威专业", "活力激情", "亲和陪伴"] })
  @IsOptional()
  @IsIn(["权威专业", "活力激情", "亲和陪伴"])
  style?: string

  @ApiPropertyOptional({ example: "中文", description: "语言（从音色启发式标签里过滤）" })
  @IsOptional()
  @IsString()
  language?: string

  @ApiPropertyOptional({ example: "超拟", enum: ["超拟", "精品"] })
  @IsOptional()
  @IsIn(["超拟", "精品"])
  capability?: string

  @ApiPropertyOptional({ example: "温润柔和", enum: ["温润柔和", "清透明亮", "低沉磁性"] })
  @IsOptional()
  @IsIn(["温润柔和", "清透明亮", "低沉磁性"])
  feature?: string

  @ApiPropertyOptional({ example: "低时延", enum: ["超低时延", "低时延"] })
  @IsOptional()
  @IsIn(["超低时延", "低时延"])
  latency?: string

  @ApiPropertyOptional({ example: false, description: "true 强制重刷镜像（绕过 24h TTL）" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  refresh?: boolean
}

export class QueryAccountDto extends PaginationDto {
  @ApiPropertyOptional({ example: "官方", description: "账号名称（模糊搜索）" })
  @IsOptional()
  @IsString()
  name?: string

  @ApiPropertyOptional({ example: "小红书", description: "平台" })
  @IsOptional()
  @IsString()
  platform?: string
}

// ==================== 项目 ====================

export class CreateProjectDto {
  @ApiProperty({ example: "春季护肤推广", description: "项目名称" })
  @IsNotEmpty()
  @IsString()
  name: string

  @ApiProperty({ example: 1, description: "关联账号ID" })
  @IsNotEmpty()
  @IsInt()
  accountId: number
}

export class PublishProjectDto {
  @ApiPropertyOptional({
    example: "2026-04-22T09:30:00.000Z",
    description: "发布时间（ISO 8601，精确到分钟）",
  })
  @IsOptional()
  @IsDateString()
  publishedAt?: string

  @ApiPropertyOptional({
    example: "https://www.xiaohongshu.com/explore/abc123",
    description: "发布链接",
  })
  @IsOptional()
  @IsUrl()
  publishUrl?: string
}

export class UpdateProjectTopicDto {
  @ApiProperty({ example: "成分党抗衰测评", description: "项目主题（15 字以内）" })
  @IsNotEmpty()
  @IsString()
  topic: string
}

export class QueryProjectDto extends PaginationDto {
  @ApiPropertyOptional({ example: "护肤", description: "项目名称（模糊搜索）" })
  @IsOptional()
  @IsString()
  name?: string

  @ApiPropertyOptional({
    example: "DRAFT",
    enum: ProjectStatus,
    description: "项目状态",
  })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus

  @ApiPropertyOptional({ example: 1, description: "账号ID筛选" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  accountId?: number
}

// ==================== 全局项目查询 ====================

export class QueryGlobalProjectDto extends PaginationDto {
  @ApiPropertyOptional({
    example: "DRAFT",
    enum: ProjectStatus,
    description: "项目状态",
  })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus
}

// ==================== 来源 ====================

export class CreateSourceDto {
  @ApiProperty({
    example: "HOT_TOPIC",
    enum: SourceType,
    description: "来源类型：HOT_TOPIC(热点抓取)、CLIENT_BRIEF(甲方文案)、DEEP_RESEARCH(深度调研)",
  })
  @IsNotEmpty()
  @IsEnum(SourceType)
  type: SourceType

  @ApiProperty({ example: "最近护肤品赛道热点话题...", description: "来源内容" })
  @IsNotEmpty()
  @IsString()
  content: string
}

// ==================== 深度调研 ====================

export class DeepResearchDto {
  @ApiProperty({ example: "美股大涨 科技股", description: "核心关键词" })
  @IsNotEmpty()
  @IsString()
  query: string
}

// ==================== 方案 ====================

export class CreateStrategyDto {
  @ApiProperty({ example: "STRONG_LINK", description: "业务结合方式" })
  @IsNotEmpty()
  @IsString()
  integrationType: string

  @ApiProperty({ example: 60, description: "目标时长（秒）" })
  @IsNotEmpty()
  @IsInt()
  targetDurationSec: number

  @ApiProperty({ example: "方案内容...", description: "方案内容" })
  @IsNotEmpty()
  @IsString()
  content: string
}

export class GenerateContentPlanDto {
  @ApiProperty({ example: "软植入", description: "业务结合方式" })
  @IsNotEmpty()
  @IsString()
  integrationType: string

  @ApiProperty({ example: 60, description: "目标时长（秒）" })
  @IsNotEmpty()
  @IsInt()
  targetDurationSec: number
}

// ==================== 生产层 AI 生成 ====================

export class GenerateProductionDto {
  @ApiProperty({ example: 1, description: "项目ID" })
  @IsNotEmpty()
  @IsInt()
  projectId: number

  @ApiPropertyOptional({
    example: false,
    default: false,
    description: "是否自动触发：true 则直接返回已保存的结果不重新生成；false 则重新生成",
  })
  @IsOptional()
  @IsBoolean()
  isAuto?: boolean
}

export class SynthesizeVideoDto {
  @ApiProperty({ example: 1, description: "生产层 ID" })
  @IsNotEmpty()
  @IsInt()
  productionId: number

  @ApiProperty({ example: "大家好，今天聊聊...", description: "口播稿内容（不超过 20000 字）" })
  @IsNotEmpty()
  @IsString()
  @MaxLength(20000)
  content: string

  @ApiProperty({ example: 1, description: "形象 ID" })
  @IsNotEmpty()
  @IsInt()
  avatarId: number

  @ApiProperty({ example: 1, description: "音色 ID" })
  @IsNotEmpty()
  @IsInt()
  voiceId: number

  @ApiPropertyOptional({
    example: 5,
    description: "语速（0-15 整数，5 为正常值，越大越快），不传默认 5",
    minimum: 0,
    maximum: 15,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(15)
  speed?: number

  @ApiPropertyOptional({
    example: 5,
    description: "音量（0-15 整数，5 为正常值，越大越大），不传默认 5",
    minimum: 0,
    maximum: 15,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(15)
  volume?: number

  @ApiPropertyOptional({
    example: 5,
    description: "语调（0-15 整数，5 为正常值，越大声音越尖），不传默认 5",
    minimum: 0,
    maximum: 15,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(15)
  pitch?: number
}

// ==================== 分镜头 ====================

/** 批量生成分镜头席位视频时，单条分镜头的表单 + 席位 id（只包含前端可编辑字段） */
export class GenerateStoryboardVideoItemDto {
  @ApiProperty({ example: 1, description: "分镜头 ID" })
  @IsNotEmpty()
  @IsInt()
  id: number

  @ApiProperty({
    example: 4,
    description: "时长（秒，客户分镜视频模型支持 4 / 6 / 8）",
    enum: [4, 6, 8],
  })
  @IsNotEmpty()
  @IsIn([4, 6, 8])
  duration: number

  @ApiProperty({ example: "柔光下的精华液瓶特写...", description: "视频生成 prompt" })
  @IsNotEmpty()
  @IsString()
  prompt: string

  @ApiPropertyOptional({ example: "https://oss.example.com/first.jpg", description: "首帧垫图" })
  @IsOptional()
  @IsString()
  firstFrameUrl?: string

  @ApiPropertyOptional({ example: "https://oss.example.com/last.jpg", description: "尾帧垫图" })
  @IsOptional()
  @IsString()
  lastFrameUrl?: string
}

/** 按素材图 ID 批量查询状态（供前端轮询） */
export class QueryMaterialIdsDto {
  @ApiProperty({
    example: "1,2,3",
    description: "素材图 ID 列表；支持逗号分隔字符串，或重复的 ids 参数",
    type: [Number],
  })
  @Transform(({ value }: { value: unknown }) => {
    const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []
    return raw
      .map(v => (typeof v === "number" ? v : Number(typeof v === "string" ? v.trim() : v)))
      .filter(n => Number.isInteger(n) && n > 0)
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  ids: number[]
}

/** 按分镜头 ID 批量查询状态（供前端轮询） */
export class QueryStoryboardIdsDto {
  @ApiProperty({
    example: "1,2,3",
    description: "分镜头 ID 列表；支持逗号分隔字符串，或重复的 ids 参数",
    type: [Number],
  })
  @Transform(({ value }: { value: unknown }) => {
    const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []
    return raw
      .map(v => (typeof v === "number" ? v : Number(typeof v === "string" ? v.trim() : v)))
      .filter(n => Number.isInteger(n) && n > 0)
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  ids: number[]
}

/** 批量生成分镜头席位视频 */
export class GenerateStoryboardVideosDto {
  @ApiProperty({
    type: [GenerateStoryboardVideoItemDto],
    description: "要生成的分镜头列表；单条生成传 1 项，一键全部生成传多项",
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique((item: GenerateStoryboardVideoItemDto) => item.id, {
    message: "分镜头 ID 不能重复",
  })
  @ValidateNested({ each: true })
  @Type(() => GenerateStoryboardVideoItemDto)
  items: GenerateStoryboardVideoItemDto[]
}

// ==================== 素材图片 ====================

/** 批量生成素材图片席位时，单条素材的表单 + 素材 id（只包含前端可编辑字段） */
export class GenerateMaterialVariantsItemDto {
  @ApiProperty({ example: 1, description: "素材图 ID" })
  @IsNotEmpty()
  @IsInt()
  id: number

  @ApiProperty({ example: "烟酰胺精华液特写...", description: "AI 生图 prompt" })
  @IsNotEmpty()
  @IsString()
  prompt: string

  @ApiPropertyOptional({ example: "https://oss.example.com/ref.jpg", description: "垫图 URL" })
  @IsOptional()
  @IsString()
  refImageUrl?: string
}

/** 批量生成素材图片席位（前端可传 1 条或多条，每条会先回写 prompt/垫图再触发 Nano Banana） */
export class GenerateMaterialVariantsDto {
  @ApiProperty({
    type: [GenerateMaterialVariantsItemDto],
    description: "要生成的素材图列表；单条生成传 1 项，一键全部生成传多项",
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => GenerateMaterialVariantsItemDto)
  items: GenerateMaterialVariantsItemDto[]
}

// ==================== 席位图片采纳 ====================

export class UpdateImageApprovalDto {
  @ApiProperty({ example: true, description: "是否采纳（true 占用席位，false 释放席位）" })
  @IsNotEmpty()
  @IsBoolean()
  approved: boolean
}

// ==================== 标签 ====================

export class QueryTagDto {
  @ApiProperty({
    example: "INDUSTRY",
    enum: TagCategory,
    description: "标签分类",
  })
  @IsNotEmpty()
  @IsEnum(TagCategory)
  category: TagCategory
}
