import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"
import { MediaItemDto, SimpleMediaDto } from "./common.dto"

export class QuerySceneDto extends PaginationDto {
  @ApiPropertyOptional({ description: "关键字模糊匹配（名称 / 标签）" })
  @IsOptional()
  @IsString()
  keyword?: string
}

export class CreateSceneDto {
  @ApiProperty({ description: "场景名称", example: "北欧客厅" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string

  @ApiPropertyOptional({ description: "场景图列表", type: [MediaItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  @ArrayMaxSize(50)
  images?: MediaItemDto[]

  @ApiPropertyOptional({ description: "场景视频列表", type: [SimpleMediaDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SimpleMediaDto)
  @ArrayMaxSize(50)
  videos?: SimpleMediaDto[]

  @ApiPropertyOptional({ description: "场景描述（生成时拼进可见 prompt）" })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  desc?: string

  @ApiPropertyOptional({ description: "适用品类数组", type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(30)
  categories?: string[]

  @ApiPropertyOptional({ description: "标签数组", type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(30)
  tags?: string[]
}

export class UpdateSceneDto extends PartialType(CreateSceneDto) {}

export class CopySceneDto {
  @ApiPropertyOptional({ description: "副本名（不传则原名加「-副本」）" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string
}
