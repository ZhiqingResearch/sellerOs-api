import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator"

/**
 * ASIN 审计取证请求 DTO（合成版：一次返回六卡）。
 * asin 与 productUrl 二选一（都传须一致、都不传 400）；country 审计站点三选一。
 */
export class EvidenceRequestDto {
  @ApiPropertyOptional({
    example: "B0GQB1C381",
    description: "10 位 ASIN（与 productUrl 二选一，同时提供时须一致）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  asin?: string

  @ApiPropertyOptional({
    example: "https://www.amazon.com/dp/B0GQB1C381",
    description: "商品 URL（从 URL 提取 ASIN）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  productUrl?: string

  @ApiPropertyOptional({
    example: "US",
    description: "站点国家（US/UK/DE）；仅 ASIN 时缺省 US，有 URL 时按域名推导，显式传值须一致",
  })
  @IsOptional()
  @IsIn(["US", "UK", "DE"])
  country?: string

  @ApiPropertyOptional({
    example: "audit",
    description:
      "取证场景 scene：audit=ASIN 审计取证（缺省，B 卡差评痛点）；evidence-module=ASIN 取证模块（B 卡评论分析双输出：好评亮点+差评痛点，带原文摘录）",
  })
  @IsOptional()
  @IsIn(["audit", "evidence-module"])
  scene?: "audit" | "evidence-module"

  @ApiProperty({
    example: "ZQ-Think-Flash",
    description: "逻辑模型 publicId（必填：B 卡 AI 痛点环节的模型，白名单校验同其它审计接口）",
  })
  @IsString()
  @IsNotEmpty()
  model!: string

  @ApiPropertyOptional({ example: "zh-CN", description: "B 卡痛点说明字段语言，缺省 zh-CN" })
  @IsOptional()
  @IsIn(["zh-CN", "en-US"])
  responseLanguage?: "zh-CN" | "en-US"

  @ApiPropertyOptional({
    example: "uuid",
    description: "客户端幂等/追踪键（可选 UUID，写痛点计费 meta）",
  })
  @IsOptional()
  @IsUUID()
  clientRequestId?: string

  @ApiPropertyOptional({ example: true, description: "兼容字段：后端始终返回 SSE 流" })
  @IsOptional()
  @IsBoolean()
  stream?: boolean
}
