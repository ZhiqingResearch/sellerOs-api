// 车泰斗素材工作台 — C 端 DTO（方案 §5）
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Transform, Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"
import {
  CHETAIDOU_GENERATE_COUNTS,
  CHETAIDOU_IMAGE_QUALITIES,
  CHETAIDOU_PERSON_MODES,
  CHETAIDOU_SITES,
  CHETAIDOU_TEXT_MODES,
} from "../chetaidou.constants"

export class SaveChetaidouCropDto {
  @ApiProperty({ description: "一次保存动作的 UUID，重试沿用" })
  @IsUUID("all", { message: "idempotencyKey 必须是 UUID" })
  idempotencyKey: string

  @ApiProperty({ description: "裁剪直传上传成功后的 publicUrl" })
  @IsUrl({ protocols: ["https"], require_protocol: true }, { message: "url 必须是 HTTPS 图片地址" })
  @MaxLength(1000)
  url: string
}

export class ChetaidouResultIdsDto {
  @ApiProperty({
    description: "当前 SKU 中本人生成的结果 ID，取预览墙 resultId",
    example: [101, 102],
    type: [Number],
  })
  @IsArray({ message: "resultIds 必须是数组" })
  @ArrayMinSize(1, { message: "请至少选择一张图片" })
  @ArrayUnique({ message: "结果 ID 不能重复" })
  @IsInt({ each: true, message: "结果 ID 必须是整数" })
  @Min(1, { each: true, message: "结果 ID 必须为正整数" })
  @Max(Number.MAX_SAFE_INTEGER, { each: true, message: "结果 ID 超出有效范围" })
  resultIds: number[]
}

export class ChetaidouCountRangeDto {
  @ApiProperty({ example: 6, description: "最小数量，含边界；与 max 相同表示精确数量" })
  @IsInt({ message: "min 必须是整数" })
  min: number

  @ApiProperty({ example: 6, description: "最大数量，含边界；不设置固定业务上限" })
  @IsInt({ message: "max 必须是整数" })
  max: number
}

export class ChetaidouSettingsDto {
  @ApiPropertyOptional({
    example: "ZQ-Think-Ultra",
    description: "已有分类模型接口返回的 publicId",
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  model?: string

  @ApiPropertyOptional({ type: ChetaidouCountRangeDto, example: { min: 6, max: 6 } })
  @IsOptional()
  @ValidateNested()
  @Type(() => ChetaidouCountRangeDto)
  dimensionCountRange?: ChetaidouCountRangeDto

  @ApiPropertyOptional({ type: ChetaidouCountRangeDto, example: { min: 20, max: 40 } })
  @IsOptional()
  @ValidateNested()
  @Type(() => ChetaidouCountRangeDto)
  optionCountRange?: ChetaidouCountRangeDto

  @ApiProperty({ example: "amazon_us", description: "站点（original/amazon_us/de/fr/es/it/jp）" })
  @IsString()
  site: string

  @ApiProperty({ example: "keep", enum: [...CHETAIDOU_TEXT_MODES] })
  @IsIn([...CHETAIDOU_TEXT_MODES])
  textMode: string

  @ApiProperty({ example: "keep", enum: [...CHETAIDOU_PERSON_MODES] })
  @IsIn([...CHETAIDOU_PERSON_MODES])
  personMode: string

  @ApiPropertyOptional({
    example: "",
    description: "人物说明（≤1000 字；keep 可调整服饰、表情和动作，不能改变身份外观）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  personText: string = ""

  @ApiPropertyOptional({ example: "", description: "补充要求（≤1000 字）" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  customText: string = ""
}

export class SelectionRefDto {
  @ApiProperty({ example: "8f0e…", description: "维度组 groupId" })
  @IsUUID()
  groupId: string

  @ApiProperty({ example: ["opt_1", "opt_2"], description: "组内选项 key 列表" })
  @IsArray()
  @IsString({ each: true })
  optionKeys: string[]

  @ApiPropertyOptional({ example: "加一点秋季氛围", description: "组内手写补充（≤1000 字）" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  customText?: string
}

export class CustomDimensionOptionDto {
  @ApiPropertyOptional({
    enum: ["USER", "AI"],
    description: "只读来源，保存时后端按 key 保留，不信任客户端赋值",
  })
  @IsOptional()
  @IsIn(["USER", "AI"])
  origin?: string

  @ApiPropertyOptional({ description: "只读：原 AI 发散任务 ID" })
  @IsOptional()
  @IsString()
  sourceTaskId?: string

  @ApiPropertyOptional({ example: "user_a1" })
  @IsOptional()
  @IsString()
  key?: string

  @ApiProperty({ example: "背景换成海边栈道" })
  @IsString()
  @MaxLength(1000)
  text: string
}

export class CustomDimensionDto {
  @ApiPropertyOptional({ example: "user_dim_1", description: "服务端分配的稳定 ID" })
  @IsOptional()
  @IsString()
  id?: string

  @ApiProperty({ example: "海边场景" })
  @IsString()
  @Length(1, 60)
  label: string

  @ApiProperty({
    example: "single",
    enum: ["single", "multi"],
    description: "用户自建维度的选择模式：single 单选，multi 多选；AI 生成选项时保留此设置",
  })
  @IsIn(["single", "multi"])
  selectionMode: string

  @ApiPropertyOptional({ example: "偏度假休闲风", description: "AI 发散指引" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  guidance?: string

  @ApiProperty({ type: [CustomDimensionOptionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomDimensionOptionDto)
  options: CustomDimensionOptionDto[]

  @ApiPropertyOptional({ type: String, isArray: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  selectedKeys?: string[]
}

export class WorkspaceMutationDto {
  @ApiProperty({
    description: "GET draft 返回的工作区令牌",
    example: "430bf253-e97c-49fb-8bdc-f2e80931c690",
  })
  @IsUUID()
  workspaceId?: string

  @ApiProperty({ example: 1, description: "当前草稿 revision" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  revision: number
}

export class UpdateDraftDto extends WorkspaceMutationDto {
  @ApiProperty({ type: ChetaidouSettingsDto })
  @ValidateNested()
  @Type(() => ChetaidouSettingsDto)
  settings: ChetaidouSettingsDto

  @ApiProperty({ type: [SelectionRefDto], description: "当前选择（groupId+optionKeys）" })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectionRefDto)
  selections: SelectionRefDto[]

  @ApiProperty({ type: [CustomDimensionDto] })
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CustomDimensionDto)
  customDimensions: CustomDimensionDto[]
}

export class CreateTaskDto {
  @ApiProperty({ description: "当前工作区令牌" })
  @IsUUID()
  workspaceId?: string

  @ApiPropertyOptional({ description: "GENERATE 的生图模型 publicId，省略使用目录默认项" })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  imageModel?: string

  @ApiProperty({
    enum: ["IDEATION", "REFRESH_GROUP", "DIVERGE", "COMPOSE", "GENERATE"],
    description: "任务类型（上传拆解走 images 上传接口；BREAKDOWN 重试走 breakdown/retry）",
  })
  @IsIn(["IDEATION", "REFRESH_GROUP", "DIVERGE", "COMPOSE", "GENERATE"])
  type: string

  @ApiProperty({ example: 19 })
  @Type(() => Number)
  @IsInt()
  imageId: number

  @ApiProperty({
    example: "430bf253-e97c-49fb-8bdc-f2e80931c690",
    description: "请求幂等键（UUID）",
  })
  @IsUUID()
  idempotencyKey: string

  @ApiProperty({ example: 6, description: "提交时草稿 revision" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  draftRevision?: number

  // REFRESH_GROUP
  @ApiPropertyOptional({ description: "REFRESH_GROUP：被刷新的旧组 groupId" })
  @IsOptional()
  @IsUUID()
  groupId?: string

  // DIVERGE
  @ApiPropertyOptional({ description: "DIVERGE：自建维度 ID（服务端分配）" })
  @IsOptional()
  @IsString()
  customDimensionId?: string

  // COMPOSE
  @ApiPropertyOptional({
    description: "历史兼容字段；COMPOSE 默认允许使用已有联想结果，无需传入",
  })
  @IsOptional()
  @IsBoolean()
  allowPartialIdeation?: boolean

  // GENERATE
  @ApiPropertyOptional({ description: "GENERATE：组合根任务 ID" })
  @IsOptional()
  @IsUUID()
  compositionTaskId?: string

  @ApiPropertyOptional({ enum: [...CHETAIDOU_GENERATE_COUNTS], description: "GENERATE：生图张数" })
  @IsOptional()
  @IsIn([...CHETAIDOU_GENERATE_COUNTS])
  count?: number

  @ApiPropertyOptional({
    example: "hd",
    enum: [...CHETAIDOU_IMAGE_QUALITIES],
    description: "GENERATE：图片质量，standard 标准 / hd 高清；省略时使用模型默认质量",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value
  )
  @IsOptional()
  @IsIn([...CHETAIDOU_IMAGE_QUALITIES], {
    message: "图片质量仅支持 standard（标准）或 hd（高清）",
  })
  quality?: string

  @ApiPropertyOptional({
    example: "16:9",
    description: "GENERATE 新请求必传实际比例；自定义传 custom，不能传 original",
  })
  @IsOptional()
  @IsString({ message: "图片比例必须为字符串" })
  aspectRatio?: string

  @ApiPropertyOptional({
    example: "2K",
    enum: ["1K", "2K", "4K"],
    description: "GENERATE：尺寸档位，缺省 1K",
  })
  @IsOptional()
  @IsString({ message: "尺寸档位必须为字符串" })
  resolutionTier?: string

  @ApiPropertyOptional({ example: 166, description: "custom 比例宽（正安全整数，不是像素）" })
  @IsOptional()
  @IsInt({ message: "自定义比例宽必须为整数" })
  @Min(1, { message: "自定义比例宽必须大于零" })
  customAspectW?: number

  @ApiPropertyOptional({ example: 182, description: "custom 比例高（正安全整数，不是像素）" })
  @IsOptional()
  @IsInt({ message: "自定义比例高必须为整数" })
  @Min(1, { message: "自定义比例高必须大于零" })
  customAspectH?: number
}

export class BreakdownRetryDto {
  @ApiProperty({ example: "430bf253-e97c-49fb-8bdc-f2e80931c690" })
  @IsUUID()
  idempotencyKey: string
}

export class AcknowledgeDto {
  @ApiProperty({ example: 3, description: "确认的拆解版本 ID（必须是当前 AI 版本）" })
  @Type(() => Number)
  @IsInt()
  breakdownId: number

  @ApiPropertyOptional({ example: 6 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  draftRevision?: number
}

export class ConflictAnswerDto {
  @ApiProperty({ example: "c1" })
  @IsString()
  conflictId: string

  @ApiProperty({ example: 1, description: "问题版本（服务端下发）" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  questionVersion: number

  @ApiPropertyOptional({ example: "choice_1" })
  @IsOptional()
  @IsString()
  choiceId?: string

  @ApiPropertyOptional({ example: "保留现有背景，只换人物服装" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string
}

export class ComposeAnswersDto {
  @ApiProperty({ description: "当前工作区令牌" })
  @IsUUID()
  workspaceId?: string

  @ApiProperty({ example: "430bf253-e97c-49fb-8bdc-f2e80931c690" })
  @IsUUID()
  idempotencyKey: string

  @ApiProperty({ example: 6 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  draftRevision: number

  @ApiProperty({ type: [ConflictAnswerDto], description: "全部当前非阻断问题的答案（一次提交）" })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ConflictAnswerDto)
  answers: ConflictAnswerDto[]
}

export class RetryTaskDto {
  @ApiProperty({ example: "430bf253-e97c-49fb-8bdc-f2e80931c690" })
  @IsUUID()
  idempotencyKey: string

  @ApiPropertyOptional({ example: 6 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  draftRevision?: number

  @ApiPropertyOptional({
    type: String,
    isArray: true,
    description: "仅重试失败维（IDEATION/REFRESH_GROUP）",
  })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  groupIds?: string[]

  @ApiPropertyOptional({ type: Number, isArray: true, description: "仅重试失败图（GENERATE）" })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  resultIds?: number[]
}

export class ApplyTaskDto {
  @ApiProperty({ description: "当前工作区令牌" })
  @IsUUID()
  workspaceId?: string

  @ApiProperty({ example: 6 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  draftRevision: number
}

export class TaskStatusQueryDto {
  @ApiProperty({ example: "id1,id2", description: "任务 ID 列表（逗号分隔）" })
  @IsString()
  ids: string
}

export class ImageListQueryDto {
  @ApiPropertyOptional({ example: "19", description: "编号/名称关键词" })
  @IsOptional()
  @IsString()
  keyword?: string

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number = 20
}

export class TaskListQueryDto {
  @ApiPropertyOptional({ enum: Object.keys(CHETAIDOU_SITES), description: "任务提交时的站点" })
  @IsOptional()
  @IsIn(Object.keys(CHETAIDOU_SITES))
  site?: string

  @ApiPropertyOptional({
    description: "单个状态或逗号分隔多个状态，如 QUEUED,RUNNING",
    enum: [
      "QUEUED",
      "RUNNING",
      "SUCCEEDED",
      "PARTIAL",
      "FAILED",
      "CANCELLED",
      "WAITING_RECONCILIATION",
    ],
  })
  @IsOptional()
  @IsString()
  status?: string

  @ApiPropertyOptional({
    enum: ["BREAKDOWN", "IDEATION", "REFRESH_GROUP", "DIVERGE", "COMPOSE", "GENERATE"],
  })
  @IsOptional()
  @IsString()
  type?: string

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  skuId?: number

  @ApiPropertyOptional({ description: "按母版过滤（工作台 state 加载用，减少无关注务）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  imageId?: number

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number = 20
}

export class UploadImageBodyDto {
  @ApiProperty({ example: "430bf253-e97c-49fb-8bdc-f2e80931c690" })
  @IsUUID()
  idempotencyKey: string

  @ApiPropertyOptional({ example: "新母版 2026-09-28" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string
}

export class AdjustmentListQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1

  @ApiPropertyOptional({ example: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize: number = 20
}

export class ResultListQueryDto extends AdjustmentListQueryDto {
  @ApiPropertyOptional({ enum: Object.keys(CHETAIDOU_SITES) })
  @IsOptional()
  @IsIn(Object.keys(CHETAIDOU_SITES))
  site?: string

  @ApiPropertyOptional({ description: "母版 ID" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  imageId?: number
}
