import { ApiProperty, OmitType } from "@nestjs/swagger"
import { AiModelModality } from "@prisma/client"
import type { VideoGenerationRequest } from "@zhiqingresearch/ai-ts-sdk"
import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator"

@ValidatorConstraint({ name: "aiGatewayVideoParams" })
class AiGatewayVideoParamsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prompt = (value as Record<string, unknown>).prompt
    return typeof prompt === "string" && prompt.trim().length > 0
  }

  defaultMessage() {
    return "params.prompt 必须是非空字符串"
  }
}

export class QueryAiGatewayModelsDto {
  @ApiProperty({ description: "模型模态", enum: AiModelModality, example: "VIDEO" })
  @IsEnum(AiModelModality)
  modality: AiModelModality

  @ApiProperty({ description: "业务分类", example: "NORMAL" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  category: string
}

export class AiGatewayVideoRequestDto {
  @ApiProperty({ description: "业务分类", example: "NORMAL" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  category: string

  @ApiProperty({ description: "AI Gateway 模型 publicId", example: "sourcing-seedance-2-5-i2v" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  publicId: string

  @ApiProperty({
    description: "完整的视频生成参数；model 字段由后端使用 publicId 覆盖",
    type: Object,
    example: {
      prompt: "海边日出，镜头缓慢推进",
      mode: "image_to_video",
      duration_seconds: 5,
      resolution: "720p",
      aspect_ratio: "16:9",
      first_frame: { url: "https://example.com/first.png" },
    },
  })
  @IsObject()
  // 模型差异参数由 Gateway 的实时 Schema 校验，避免本地规则与基座配置不一致。
  @Validate(AiGatewayVideoParamsConstraint)
  params: Omit<VideoGenerationRequest, "model" | "callback"> & {
    model?: string
    callback?: boolean
  }
}

@ValidatorConstraint({ name: "aiGatewayVideoQuoteParams" })
class AiGatewayVideoQuoteParamsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const params = value as Record<string, unknown>
    return ["mode", "resolution"].every(
      key => params[key] == null || typeof params[key] === "string"
    )
  }

  defaultMessage() {
    return "params.mode 和 params.resolution 必须是字符串"
  }
}

export class AiGatewayVideoQuoteDto extends OmitType(AiGatewayVideoRequestDto, [
  "params",
] as const) {
  @ApiProperty({
    description: "单位报价配置，仅需模型支持的模式和分辨率；无需提示词或时长",
    type: Object,
    example: { mode: "image_to_video", resolution: "720p" },
  })
  @IsObject()
  @Validate(AiGatewayVideoQuoteParamsConstraint)
  params: Partial<AiGatewayVideoRequestDto["params"]>
}
