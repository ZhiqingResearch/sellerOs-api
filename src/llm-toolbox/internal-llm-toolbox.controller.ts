import { Body, Controller, NotFoundException, Post, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"
import { ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger"
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator"
import { PrismaService } from "../prisma/prisma.service"
import { InternalGenerationGuard } from "../video-project/internal-generation.guard"
import { LlmToolboxService, UploadedImage } from "./llm-toolbox.service"

/** 内部一键润色入参（prompt 校验语义与公开接口一致：非空校验在 service，文案冻结） */
class InternalEnhancePromptDto {
  @ApiProperty({ description: "发起用户手机号（vidflowos 按手机号映射同一用户）", example: "18814486260" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string

  @ApiProperty({ example: "一只猫在沙发上" })
  @IsString()
  prompt!: string
}

/** 内部中英互译入参（direction 缺省/拼错回落 zh-to-en，DTO 不做枚举拒绝） */
class InternalTranslatePromptDto {
  @ApiProperty({ description: "发起用户手机号", example: "18814486260" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string

  @ApiProperty({ example: "一只猫在沙发上" })
  @IsString()
  prompt!: string

  @ApiPropertyOptional({ example: "zh-to-en", description: "zh-to-en（默认）| en-to-zh" })
  @IsOptional()
  @IsString()
  direction?: string
}

/** 内部由图推理入参（multipart：phone 为表单字段，image 为文件） */
class InternalImageInferenceDto {
  @ApiProperty({ description: "发起用户手机号", example: "18814486260" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string
}

/**
 * VidFlowOS 内部 LLM 工具箱代理接口（X-Internal-Token 鉴权，与视频/图片/扣费同一 token）。
 * 手机号映射用户后透传现有 LlmToolboxService：模型解析/一口价预检/网关调用/扣费全复用，零新逻辑。
 * 不挂 ToolboxErrorFilter——保持全局 {statusCode, message} 包络，供调用方按 message 透传文案。
 */
@ApiTags("内部 LLM 工具箱（VidFlowOS）")
@ApiHeader({ name: "X-Internal-Token", required: true, description: "与视频转发接口相同的内部令牌" })
@UseGuards(InternalGenerationGuard)
@Controller("internal/llm-toolbox")
export class InternalLlmToolboxController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly toolbox: LlmToolboxService
  ) {}

  @Post("enhance-prompt")
  @ApiOperation({
    summary: "代发起一键润色",
    description: "body {phone, prompt}；返回 {enhanced, tokenUsage?, billingHandled} 原样透传",
  })
  async enhance(@Body() dto: InternalEnhancePromptDto) {
    const user = await this.mapUser(dto.phone)
    return this.toolbox.enhance(user.id, { prompt: dto.prompt })
  }

  @Post("translate-prompt")
  @ApiOperation({
    summary: "代发起中英互译",
    description: "body {phone, prompt, direction?}；返回 {translated, tokenUsage?, billingHandled} 原样透传",
  })
  async translate(@Body() dto: InternalTranslatePromptDto) {
    const user = await this.mapUser(dto.phone)
    return this.toolbox.translate(user.id, {
      prompt: dto.prompt,
      ...(dto.direction !== undefined ? { direction: dto.direction } : {}),
    })
  }

  @Post("image-inference")
  @ApiOperation({
    summary: "代发起由图推理（multipart）",
    description:
      "multipart {phone, image}（image ≤10MB）；二进制直转不落 base64（避开全局 JSON 5MB 限制）；返回 {visualDescription, structuredPrompt, raw, tokenUsage?, billingHandled} 原样透传",
  })
  @UseInterceptors(FileInterceptor("image", { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  async imageInference(@Body() dto: InternalImageInferenceDto, @UploadedFile() file: UploadedImage | undefined) {
    const user = await this.mapUser(dto.phone)
    return this.toolbox.imageInference(user.id, file)
  }

  /** 手机号映射用户（与内部扣费/生成接口同款：404 + USER_NOT_FOUND 供调用方转译） */
  private async mapUser(phone: string) {
    const user = await this.prisma.user.findUnique({
      where: { phone: phone.trim() },
      select: { id: true },
    })
    if (!user) throw new NotFoundException({ code: "USER_NOT_FOUND" })
    return user
  }
}
