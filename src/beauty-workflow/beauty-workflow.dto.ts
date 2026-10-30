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
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../common/dto/pagination.dto"

export const BEAUTY_TASK_STATUSES = [
  "WAITING_MODERATION",
  "GENERATING",
  "SUCCESS",
  "TIMEOUT",
  "CANCELLED",
  "FAILED",
] as const

export type BeautyTaskStatus = (typeof BEAUTY_TASK_STATUSES)[number]

export const BEAUTY_SEGMENT_TYPES = ["BASE_MAKEUP", "MAKEUP_PROCESS", "BEFORE_AFTER"] as const

export type BeautySegmentType = (typeof BEAUTY_SEGMENT_TYPES)[number]

const BEAUTY_VIDEO_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const
const BEAUTY_VIDEO_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"] as const
const BEAUTY_VIDEO_RESOLUTIONS = ["480p", "720p", "720p-SR", "1080p-SR", "1440p-SR"] as const

export class CreateBeautyProjectDto {
  @ApiPropertyOptional({ description: "项目名称，默认「未命名美妆项目」" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string
}

export class UpdateBeautyProjectDto {
  @ApiProperty({ description: "项目名称" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string
}

export class QueryBeautyProjectDto extends PaginationDto {
  @ApiPropertyOptional({ description: "项目名称模糊匹配" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  keyword?: string
}

export class CreateBeautyVideoTaskDto {
  @ApiPropertyOptional({ description: "妆容标识，用于前端分组", example: "airy" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  makeupKey?: string

  @ApiPropertyOptional({ description: "妆容名称", example: "清透氧气妆" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  makeupName?: string

  @ApiProperty({ description: "妆容组顺序，从 0 开始", example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  groupIndex: number

  @ApiProperty({ description: "视频分段类型", enum: BEAUTY_SEGMENT_TYPES })
  @IsIn(BEAUTY_SEGMENT_TYPES as readonly string[])
  segmentType: BeautySegmentType

  @ApiProperty({ description: "组内分段顺序，1-3", example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  segmentIndex: number

  @ApiProperty({ description: "前端生成并确认后的最终视频提示词" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  prompt: string

  @ApiPropertyOptional({ description: "提示词模板版本，用于任务审计", example: "beauty-v1" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  promptVersion?: string

  @ApiProperty({ description: "视频时长（秒）", enum: BEAUTY_VIDEO_DURATIONS, example: 6 })
  @Type(() => Number)
  @IsIn(BEAUTY_VIDEO_DURATIONS as readonly number[])
  durationSec: number

  @ApiPropertyOptional({ description: "画面比例，默认 9:16", enum: BEAUTY_VIDEO_RATIOS })
  @IsOptional()
  @IsIn(BEAUTY_VIDEO_RATIOS as readonly string[])
  aspectRatio?: string

  @ApiPropertyOptional({ description: "分辨率，默认 720p", enum: BEAUTY_VIDEO_RESOLUTIONS })
  @IsOptional()
  @IsIn(BEAUTY_VIDEO_RESOLUTIONS as readonly string[])
  resolution?: string

  @ApiProperty({ description: "该分段使用的参考图 URL，最多 9 张", type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(9)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  referenceImageUrls: string[]
}

export class CreateBeautyTaskBatchDto {
  @ApiProperty({ description: "素颜数字人 ID" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  digitalHumanId: number

  @ApiProperty({
    description: "美妆工作流输入快照；具体字段由前端原型维护，后端照存照取",
    type: Object,
  })
  @IsObject()
  beautyInput: Record<string, unknown>

  @ApiProperty({
    description: "前端已组装好的视频任务；初次提交通常为 N 套妆容 × 3 段",
    type: [CreateBeautyVideoTaskDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => CreateBeautyVideoTaskDto)
  tasks: CreateBeautyVideoTaskDto[]
}

export class QueryBeautyTaskDto extends PaginationDto {
  @ApiPropertyOptional({ description: "按项目 ID 筛选" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  projectId?: number

  @ApiPropertyOptional({ description: "按批次标识筛选" })
  @IsOptional()
  @IsString()
  @MaxLength(36)
  batchKey?: string

  @ApiPropertyOptional({ description: "按任务状态筛选", enum: BEAUTY_TASK_STATUSES })
  @IsOptional()
  @IsIn(BEAUTY_TASK_STATUSES as readonly string[])
  status?: BeautyTaskStatus
}

export class BeautyTaskStatsQueryDto {
  @ApiPropertyOptional({ description: "按项目 ID 筛选；不传则统计当前用户全部任务" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  projectId?: number
}

export class RemoveBeautyTasksDto {
  @ApiProperty({
    description: "要从项目中移除的 Beauty 视频任务 ID",
    type: [Number],
    example: [401, 402],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  taskIds: number[]
}
