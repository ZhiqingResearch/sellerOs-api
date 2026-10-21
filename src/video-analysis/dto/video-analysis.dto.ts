import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Allow, IsOptional, IsString } from "class-validator"

/**
 * 视频分析入参（P0 契约冻结 §5.1）。结构校验的冻结文案（https / duration>0 /
 * ≤600 / 白名单 / chargeRequestId）在 assertVideoAnalysisRequest（models.ts）里
 * 逐字抛出，DTO 只做类型收窄，避免 class-validator 的默认英文文案泄漏到契约。
 */
export class VideoAnalysisDto {
  @ApiProperty({
    example: "https://cdn.example.com/video.mp4",
    description: "Spaces 公网 https 地址",
  })
  @IsString()
  videoUrl!: string

  @ApiProperty({ example: 32.5, description: "视频时长（秒），上限 600" })
  // @Allow 仅让 duration 在全局 ValidationPipe 的 whitelist 下免于剥离；
  // 约束（>0 / ≤600）与冻结文案都在 assertRequest，这里不能换成 @IsNumber()
  // （数值字符串会被新挡、失败时泄漏 class-validator 英文默认文案，破坏 P0 契约）
  @Allow()
  duration!: number

  @ApiPropertyOptional({ example: "开场钩子", description: "关注点，服务端 trim 后截断 500 字" })
  @IsOptional()
  @IsString()
  focus?: string

  @ApiPropertyOptional({ example: "video/mp4", description: "缺省按 URL 扩展名推导" })
  @IsOptional()
  @IsString()
  mimeType?: string

  @ApiPropertyOptional({
    example: "ZQ-Multimodal-Gemini-3.5-Flash-Lite",
    description: "白名单：3.5-Flash-Lite（默认）/ 3.7-Flash / Qwen-3.7-Plus",
  })
  @IsOptional()
  @IsString()
  model?: string

  @ApiProperty({
    example: "video-analysis-3f2a...-uuid",
    description: "幂等键（video-analysis-{UUIDv4}），进流前生成，重试复用",
  })
  @IsString()
  chargeRequestId!: string
}
