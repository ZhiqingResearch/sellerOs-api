import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsOptional, IsString } from "class-validator"

/**
 * 三件套入参（P0 契约冻结 §2.1/§3.1/§4.1）：
 * - prompt 无长度上限（前端不校验，防滥用上限需单独立项，不得静默截断）
 * - 非空校验在 service 内做（trim 后为空 → 400 "`prompt` is required"，文案冻结）
 * - direction 缺省/拼错一律静默回落 zh-to-en（P0 §3.1），DTO 不做枚举拒绝
 */
export class EnhancePromptDto {
  @ApiProperty({ example: "一只猫在沙发上" })
  @IsString()
  prompt!: string
}

export class TranslatePromptDto {
  @ApiProperty({ example: "一只猫在沙发上" })
  @IsString()
  prompt!: string

  @ApiPropertyOptional({
    example: "zh-to-en",
    description: "zh-to-en（默认，缺省/拼错静默回落）| en-to-zh",
  })
  @IsOptional()
  @IsString()
  direction?: string
}

/** 三件套响应里逐字段回传的 token 用量（P0 §1.2；usage 整体缺失时响应省略 tokenUsage 字段） */
export interface ToolboxTokenUsage {
  promptTokens: number
  completionTokens: number
  thinkingTokens: number
  totalTokens: number
}
