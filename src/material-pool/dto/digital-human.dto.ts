import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"
import { MediaItemDto, SimpleMediaDto } from "./common.dto"

// 家居与美妆角色卡文本模块。后端不解析、不深校验，照存照取
export class RoleCardModulesDto {
  @ApiPropertyOptional({ description: "美妆角色卡：人物档案" })
  @IsOptional()
  @IsString()
  profile?: string

  @ApiPropertyOptional({ description: "美妆角色卡：五官与外形特征" })
  @IsOptional()
  @IsString()
  features?: string

  @ApiPropertyOptional({ description: "美妆角色卡：主导肤质瑕疵" })
  @IsOptional()
  @IsString()
  flaws?: string

  @ApiPropertyOptional({ description: "1.内部定位" })
  @IsOptional()
  @IsString()
  positioning?: string

  @ApiPropertyOptional({ description: "2.TikTok 账号" })
  @IsOptional()
  @IsString()
  account?: string

  @ApiPropertyOptional({ description: "3.带货方向" })
  @IsOptional()
  @IsString()
  commerce?: string

  @ApiPropertyOptional({ description: "4.表格字段" })
  @IsOptional()
  @IsString()
  tableFields?: string

  @ApiPropertyOptional({ description: "5.可复制图片提示词（4-panel 英文）" })
  @IsOptional()
  @IsString()
  cardPrompt?: string

  @ApiPropertyOptional({ description: "6.负面词" })
  @IsOptional()
  @IsString()
  negativePrompt?: string

  @ApiPropertyOptional({ description: "7.一致性说明" })
  @IsOptional()
  @IsString()
  consistency?: string
}

// 角色卡：仅 AI 生成的数字人携带；手动数字人为 null
export class RoleCardDto {
  @ApiPropertyOptional({ description: "提炼方向标签（设计师型 / 匠人型）" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  direction?: string

  @ApiPropertyOptional({ description: "卡类型标签（核心方向 / 人物卡测试 / 流量款）" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  cardType?: string

  @ApiPropertyOptional({ description: "实际出图模型（Nano-Banana / Flux / GPT-Image / Qwen）" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  imageModel?: string

  @ApiPropertyOptional({ description: "角色卡文本模块", type: RoleCardModulesDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RoleCardModulesDto)
  modules?: RoleCardModulesDto
}

export class QueryDigitalHumanDto extends PaginationDto {
  @ApiPropertyOptional({ description: "关键字模糊匹配（名称 / 标签）" })
  @IsOptional()
  @IsString()
  keyword?: string
}

export class CreateDigitalHumanDto {
  @ApiProperty({ description: "数字人名称", example: "知性女主播" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string

  @ApiPropertyOptional({ description: "人物图列表", type: [MediaItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  @ArrayMaxSize(50)
  portraits?: MediaItemDto[]

  @ApiPropertyOptional({ description: "动态视频列表", type: [SimpleMediaDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SimpleMediaDto)
  @ArrayMaxSize(50)
  videos?: SimpleMediaDto[]

  @ApiPropertyOptional({ description: "音色描述" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  voiceDesc?: string

  @ApiPropertyOptional({ description: "上传的音频 URL" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  voiceAudio?: string

  @ApiPropertyOptional({ description: "人设/主体身份（隐藏字段，提交模型用，不进可见 prompt）" })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  persona?: string

  @ApiPropertyOptional({ description: "用途数组", type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(30)
  purposes?: string[]

  @ApiPropertyOptional({ description: "标签数组", type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(30)
  tags?: string[]

  @ApiPropertyOptional({ description: "AI 角色卡（手动数字人不传）", type: RoleCardDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RoleCardDto)
  roleCard?: RoleCardDto
}

// 更新：所有字段可选；传数组字段时整组替换
export class UpdateDigitalHumanDto extends PartialType(CreateDigitalHumanDto) {}

// 批量新建：AI 角色卡入库走这个，一次事务落 N 个
export class BatchCreateDigitalHumanDto {
  @ApiProperty({ description: "数字人/角色卡数组", type: [CreateDigitalHumanDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateDigitalHumanDto)
  cards: CreateDigitalHumanDto[]
}

export class CopyDigitalHumanDto {
  @ApiPropertyOptional({ description: "副本名（不传则原名加「-副本」）" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string
}
