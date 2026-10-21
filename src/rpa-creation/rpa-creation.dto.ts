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
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../common/dto/pagination.dto"
import type { RpaMediaType, RpaTaskStatus } from "./rpa-creation.capabilities"
import { RPA_MEDIA_TYPES, RPA_TASK_STATUSES } from "./rpa-creation.capabilities"

export class CreateRpaCreationProjectDto {
  @ApiPropertyOptional({ description: "项目名称，默认未命名项目" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string
}

export class UpdateRpaCreationProjectDto {
  @ApiProperty({ description: "项目名称" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string
}

export class QueryRpaCreationProjectDto extends PaginationDto {
  @ApiPropertyOptional({ description: "项目名称模糊搜索" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  keyword?: string
}

export class CreateRpaCreationTaskDto {
  @ApiProperty({ enum: RPA_MEDIA_TYPES, description: "生成类型" })
  @IsIn(RPA_MEDIA_TYPES as readonly string[])
  mediaType: RpaMediaType

  @ApiProperty({ description: "创作提示词" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  prompt: string

  @ApiProperty({ description: "模型编码" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  model: string

  @ApiProperty({ description: "画面比例" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  aspectRatio: string

  @ApiProperty({ description: "生成数量", minimum: 1, maximum: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  quantity: number

  @ApiPropertyOptional({ description: "视频输入模式，当前固定 INGREDIENTS" })
  @IsOptional()
  @IsIn(["INGREDIENTS"])
  inputMode?: "INGREDIENTS"

  @ApiPropertyOptional({
    description: "视频必填时长（秒）：Omni 支持 4/6/8/10，Veo 仅支持 8；按提交值计费",
    enum: [4, 6, 8, 10],
    example: 8,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  durationSec?: number

  @ApiPropertyOptional({
    description: "视频分辨率：Omni 支持 360p/720p，Veo 仅支持 720p；省略时为 720p，图片不可传",
    enum: ["360p", "720p"],
    default: "720p",
    example: "720p",
  })
  @IsOptional()
  @IsIn(["360p", "720p"])
  resolution?: string

  @ApiPropertyOptional({ description: "参考图片 URL，可为空", type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUrl({ require_protocol: true }, { each: true })
  referenceImageUrls?: string[]

  @ApiPropertyOptional({ description: "参考视频 URL，视频生成最多一个", type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1)
  @IsUrl({ require_protocol: true }, { each: true })
  referenceVideoUrls?: string[]
}

export class QueryRpaCreationTaskDto extends PaginationDto {
  @ApiPropertyOptional({ description: "项目 ID" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  projectId?: number

  @ApiPropertyOptional({ enum: RPA_MEDIA_TYPES, description: "生成类型" })
  @IsOptional()
  @IsIn(RPA_MEDIA_TYPES as readonly string[])
  mediaType?: RpaMediaType

  @ApiPropertyOptional({ enum: RPA_TASK_STATUSES, description: "任务状态" })
  @IsOptional()
  @IsIn(RPA_TASK_STATUSES as readonly string[])
  status?: RpaTaskStatus
}

export class RpaCreationTaskStatsDto {
  @ApiPropertyOptional({ description: "项目 ID" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  projectId?: number
}

export class RemoveRpaResultsDto {
  @ApiProperty({
    description: "要从项目中移除的 RPA 输出结果 ID",
    type: [Number],
    example: [301, 302],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  outputIds: number[]
}

export class CompleteRpaOutputDto {
  @ApiProperty({ enum: ["SUCCESS", "FAILED"] })
  @IsIn(["SUCCESS", "FAILED"])
  status: "SUCCESS" | "FAILED"

  @ApiPropertyOptional({ description: "结果文件 URL；SUCCESS 时必填，后端会转存 Spaces" })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(5000)
  url?: string

  @ApiPropertyOptional({ description: "单个输出失败原因" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  errorMessage?: string
}

export class CompleteRpaTaskDto {
  @ApiProperty({
    type: [CompleteRpaOutputDto],
    description: "首次生成按输出席位顺序排列；重试时按本轮待回填失败项顺序排列",
  })
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => CompleteRpaOutputDto)
  outputs: CompleteRpaOutputDto[]
}
