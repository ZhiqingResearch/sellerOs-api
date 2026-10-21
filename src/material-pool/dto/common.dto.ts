import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator"

// JWT 守卫注入的请求上下文（各控制器统一引用）
export interface AuthedRequest {
  user: { id: number; phone: string; roleCode: string | null }
}

// 数字人人物图 / 场景图条目：{ id, name, hue, img? }
export class MediaItemDto {
  @ApiPropertyOptional({ description: "前端生成的条目 id", example: "p1" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string

  @ApiProperty({ description: "条目名称", example: "正面照" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string

  @ApiPropertyOptional({ description: "占位渐变色相（0–360）", example: 210 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  hue?: number

  @ApiPropertyOptional({ description: "真实图 URL（无则用 hue 占位）" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  img?: string
}

// 数字人动态视频 / 场景视频条目：{ id, name, url? }
export class SimpleMediaDto {
  @ApiPropertyOptional({ description: "前端生成的条目 id", example: "v1" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string

  @ApiProperty({ description: "条目名称", example: "讲解片段" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string

  @ApiPropertyOptional({ description: "视频 URL（前端已直传 OSS）" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  url?: string
}

// 批量操作：id 数组（批量删除 / 批量下载 / 移到分组基类）
export class BatchIdsDto {
  @ApiProperty({ description: "目标 id 数组", type: [Number], example: [1, 2, 3] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids: number[]
}

// 导入分享码：前端解析分享码得到 id 数组后调用，按 id 批量克隆
export class ImportIdsDto {
  @ApiProperty({
    description: "要导入的 id 数组（前端解析分享码得到），已删除/不存在的会被跳过",
    type: [Number],
    example: [1, 2],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids: number[]
}
