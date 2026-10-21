import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from "class-validator"

export class ChargeTokensDto {
  @ApiProperty({ example: 150000, description: "输入 token 数" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  promptTokens: number

  @ApiProperty({ example: 50000, description: "输出 token 数" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  completionTokens: number

  @ApiPropertyOptional({ example: 10000, description: "思考 token 数（与输出合并计费）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  thinkingTokens?: number

  @ApiPropertyOptional({ example: "customer.strategy", description: "来源标识" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string

  @ApiPropertyOptional({
    example: "gemini-3.1-pro",
    description:
      "实际执行的模型 code（落 UsageLog.meta.model → 用量分析「按模型」分组）。不传时：企业成员自动记录该功能在团队模型配置中的默认模型；个人用户/无配置则不记",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string

  @ApiPropertyOptional({ example: { model: "gemini-2.5-flash" }, description: "额外元数据" })
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>

  @ApiPropertyOptional({
    example: { keyword: "无线耳机", market: "US" },
    description: "本次请求的参数快照（便于日志排查具体请求了哪些参数）",
  })
  @IsOptional()
  @IsObject()
  requestParams?: Record<string, unknown>
}
