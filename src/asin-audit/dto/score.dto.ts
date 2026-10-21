import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID } from "class-validator"

/**
 * 审计打分请求 DTO。
 * evidence 为完整 D/E 取证对象（asin/country/C/D/E/meta），@IsObject 整对象保留
 * （whitelist 不剥离嵌套字段）；asin 必填由服务层校验（与 Web route 400 口径一致）。
 */
export class ScoreRequestDto {
  @ApiProperty({
    description: "完整 D/E 取证对象（asin 必填；C/D/E/meta 结构见 types/de.types.ts）",
    example: { asin: "B0XXXX", country: "US", C: {}, D: {}, E: {}, meta: {} },
  })
  @IsObject()
  evidence!: Record<string, unknown>

  @ApiPropertyOptional({
    example: "amazon_us",
    description: "站点市场，缺省 amazon_us（US/UK/DE）",
  })
  @IsOptional()
  @IsIn(["amazon_us", "amazon_uk", "amazon_de"])
  market?: string

  @ApiPropertyOptional({ description: "粘贴的 Listing 文本（证据归一化备用来源）" })
  @IsOptional()
  @IsString()
  pastedContent?: string

  @ApiPropertyOptional({ description: "A/P/B/C 四卡证据（可选，优先于 pastedContent）" })
  @IsOptional()
  @IsObject()
  abpc?: Record<string, unknown>

  @ApiPropertyOptional({
    example: "computer",
    description:
      "类目覆盖层显式指定（可选）。缺省时系统按 A 卡 categoryPath（爬虫类目路径）自动判定；命中电脑类目时追加电脑类目冻结清单 prompt",
  })
  @IsOptional()
  @IsIn(["computer"])
  categoryHint?: "computer"

  @ApiPropertyOptional({ example: "zh-CN", description: "说明字段语言，缺省 zh-CN" })
  @IsOptional()
  @IsIn(["zh-CN", "en-US"])
  responseLanguage?: "zh-CN" | "en-US"

  @ApiProperty({ example: "ZQ-Think-Lite", description: "逻辑模型 publicId（必填）" })
  @IsString()
  @IsNotEmpty()
  model!: string

  @ApiPropertyOptional({ example: "uuid", description: "客户端幂等/追踪键（可选 UUID）" })
  @IsOptional()
  @IsUUID()
  clientRequestId?: string
}
