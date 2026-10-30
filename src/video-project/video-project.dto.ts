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
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../common/dto/pagination.dto"

export const VIDEO_TASK_STATUSES = [
  "WAITING_MODERATION",
  "GENERATING",
  "SUCCESS",
  "TIMEOUT",
  "CANCELLED",
  "FAILED",
] as const
export type VideoTaskStatus = (typeof VIDEO_TASK_STATUSES)[number]

export class CreateVideoProjectDto {
  @ApiPropertyOptional({ description: "项目名称，默认「未命名项目」", example: "夏季新品短视频" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string
}

export class UpdateVideoProjectDto {
  @ApiPropertyOptional({ description: "项目名称（重命名）" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string
}

export class QueryVideoProjectDto extends PaginationDto {
  @ApiPropertyOptional({ description: "项目名称模糊匹配" })
  @IsOptional()
  @IsString()
  keyword?: string

  @ApiPropertyOptional({ description: "项目类型：GENERAL 通用 / ECOMMERCE 带货；不传=全部" })
  @IsOptional()
  @IsIn(["GENERAL", "ECOMMERCE"])
  type?: string
}

class MotionControlVideoDto {
  @ApiProperty({ description: "动作视频 URL（前端已直传 OSS）" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  url: string

  @ApiProperty({ description: "动作视频名称", example: "动作1" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string

  @ApiProperty({ description: "动作视频时长（秒）", example: 8 })
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(30)
  durationSec: number
}

class MotionControlImageDto {
  @ApiProperty({ description: "目标图 URL（前端已直传 OSS / 素材池 URL）" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  url: string

  @ApiProperty({ description: "目标图名称", example: "目标图1" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string
}

export class CreateMotionControlBatchDto {
  @ApiPropertyOptional({ description: "补充描述（整批共用，可选）" })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  prompt?: string

  @ApiPropertyOptional({ description: "分辨率档位", enum: ["720p", "1080p"], default: "1080p" })
  @IsOptional()
  @IsIn(["720p", "1080p"])
  resolution?: string

  @ApiPropertyOptional({
    description:
      "人物朝向控制：image=以目标图朝向为主（动作视频限 3~10 秒）；video=以动作视频朝向为主（限 3~30 秒）。V2.6 起网关必填，缺省按 video 与时长跟随视频的现网行为一致",
    enum: ["image", "video"],
    default: "video",
  })
  @IsOptional()
  @IsIn(["image", "video"])
  characterOrientation?: string

  @ApiProperty({
    description: "动作视频列表，多选后会与目标图做笛卡尔积生成",
    type: [MotionControlVideoDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MotionControlVideoDto)
  actionVideos: MotionControlVideoDto[]

  @ApiProperty({
    description: "目标图列表，多选后会与动作视频做笛卡尔积生成",
    type: [MotionControlImageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MotionControlImageDto)
  targetImages: MotionControlImageDto[]
}

export class QueryVideoTaskDto extends PaginationDto {
  @ApiPropertyOptional({ description: "按项目 ID 筛选" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  projectId?: number

  @ApiPropertyOptional({ description: "任务状态", enum: VIDEO_TASK_STATUSES })
  @IsOptional()
  @IsIn(VIDEO_TASK_STATUSES as readonly string[])
  status?: VideoTaskStatus
}

export class VideoTaskStatsQueryDto {
  @ApiPropertyOptional({ description: "按项目 ID 筛选；不传=当前用户全部" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  projectId?: number
}

export class RemoveVideoTasksDto {
  @ApiProperty({ description: "要从项目中移除的视频任务 ID", type: [Number], example: [201, 202] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  taskIds: number[]
}
