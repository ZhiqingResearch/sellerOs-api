import { BadRequestException } from "@nestjs/common"
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { plainToInstance } from "class-transformer"
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  validateSync,
} from "class-validator"

export class LocalRedrawForm {
  @ApiProperty({ description: "完整局部编辑指令" })
  @IsString()
  @IsNotEmpty()
  prompt!: string

  @ApiPropertyOptional({
    description: "源平台原图片 ID；传入则保存到原项目，mainImageUrls/refs 从标注图开始",
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  sourceImageId?: number

  @ApiPropertyOptional({ description: "原项目 ID；人像项目必须传 sourceImageId", minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  projectId?: number

  @ApiPropertyOptional({ minimum: 1, maximum: 4, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  count?: number

  @ApiPropertyOptional({
    type: [String],
    description: "无 sourceImageId 时依次为原图、标注图、额外参考图；有时从标注图开始",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUrl({ protocols: ["http", "https"], require_protocol: true }, { each: true })
  mainImageUrls?: string[]
}

export function parseLocalRedrawForm(raw: unknown): LocalRedrawForm {
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      throw new BadRequestException("form 必须为合法 JSON")
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("局部重绘参数必须为对象")
  const dto = plainToInstance(LocalRedrawForm, value)
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })
  if (errors.length || !dto.prompt.trim())
    throw new BadRequestException("局部重绘参数不合法，请检查字段、编辑指令、图片 URL 和数量")
  return dto
}
