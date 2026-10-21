import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsNotEmpty, IsNumber, IsObject, IsOptional, IsString } from "class-validator"

export class CreateProductReportDto {
  @ApiProperty({ example: "产品A分析报告", description: "标题" })
  @IsString()
  @IsNotEmpty()
  title: string

  @ApiPropertyOptional({ example: 85.5, description: "评分" })
  @IsNumber()
  @IsOptional()
  score?: number

  @ApiPropertyOptional({ example: "该产品综合评分较高", description: "描述" })
  @IsString()
  @IsOptional()
  description?: string

  @ApiProperty({ example: { metrics: {} }, description: "报告数据" })
  @IsObject()
  @IsNotEmpty()
  data: object

  @ApiPropertyOptional({ example: "https://example.com/report.pdf", description: "报告URL" })
  @IsString()
  @IsOptional()
  reportUrl?: string
}
