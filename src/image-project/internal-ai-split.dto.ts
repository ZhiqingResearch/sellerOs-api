import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from "class-validator"
import { AiSplitPromptConfigDto, CreateAiSplitTaskDto } from "./ai-split.dto"

export class InternalAiSplitProductImageDto {
  @ApiProperty({ description: "本次 SKU 的 HTTPS 产品图地址" })
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @MaxLength(1000)
  url: string

  @ApiProperty({
    enum: ["PRODUCT_MAIN", "PRODUCT_DETAIL", "ACCESSORY", "PACKAGING", "USAGE_SCENE", "OTHER"],
  })
  @IsIn(["PRODUCT_MAIN", "PRODUCT_DETAIL", "ACCESSORY", "PACKAGING", "USAGE_SCENE", "OTHER"])
  purpose: string

  @ApiPropertyOptional({ description: "配件、包装、其他用途必须填写说明" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string
}

export class InternalAiSplitProductSnapshotDto {
  @ApiProperty({ description: "本次 SKU 商品资料，productName 必填" })
  @IsObject()
  currentProduct: Record<string, unknown>

  @ApiProperty({ type: [InternalAiSplitProductImageDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => InternalAiSplitProductImageDto)
  productImages: InternalAiSplitProductImageDto[]
}

export class InternalAiSplitRequestDto extends CreateAiSplitTaskDto {
  @ApiProperty({ type: AiSplitPromptConfigDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AiSplitPromptConfigDto)
  declare promptConfig: AiSplitPromptConfigDto

  @ApiProperty({ type: InternalAiSplitProductSnapshotDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => InternalAiSplitProductSnapshotDto)
  productSnapshot: InternalAiSplitProductSnapshotDto
}

export class InternalCreateAiSplitTaskDto {
  @ApiProperty({ description: "用于映射源平台用户的手机号" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone: string

  @ApiProperty({ type: InternalAiSplitRequestDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => InternalAiSplitRequestDto)
  request: InternalAiSplitRequestDto
}
