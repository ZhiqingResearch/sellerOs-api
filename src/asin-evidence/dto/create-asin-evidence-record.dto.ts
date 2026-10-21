import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from "class-validator"

export class CreateAsinEvidenceRecordDto {
  @ApiProperty({
    example: "23fd58d7-3810-4a16-8a39-61520e134994",
    description: "前端创建请求 UUID，相同请求重试返回同一条记录",
  })
  @IsUUID(4)
  clientRequestId: string

  @ApiProperty({ example: "B0GQB1C381", description: "Amazon ASIN，10 位字母数字" })
  @Matches(/^[A-Z0-9]{10}$/i, { message: "asin 需为 10 位字母数字" })
  asin: string

  @ApiProperty({ example: "US", enum: ["US", "UK", "DE"], description: "站点代码" })
  @IsIn(["US", "UK", "DE"])
  country: string

  @ApiProperty({ example: "ZQ-Think-Flash", description: "取证时使用的 B 卡评论分析模型" })
  @IsString()
  @MaxLength(64)
  model: string

  @ApiPropertyOptional({
    example: "Example Smart Glasses",
    description: "商品名摘要，缺省时后端从取证结果 A 卡提取",
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  productTitle?: string

  @ApiProperty({
    description: "取证接口完整结果（六卡 A/P/B/C/D/E + meta，含 richPainPoints/highlights 等增强字段）",
  })
  @IsObject()
  evidence: Record<string, unknown>
}
