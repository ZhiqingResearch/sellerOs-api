import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { HistoryType } from "@prisma/client"
import { IsEnum, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString } from "class-validator"

export class CreateHistoryDto {
  @ApiProperty({ example: "铝合金型材寻源", description: "标题" })
  @IsString()
  @IsNotEmpty()
  title: string

  @ApiProperty({
    enum: HistoryType,
    example: "PRODUCT_SCORING",
    description:
      "类型：PRODUCT_SCORING(选品打分)、LISTING_GENERATION(Listing生成)、LISTING_SCORING(Listing打分)",
  })
  @IsEnum(HistoryType)
  type: HistoryType

  @ApiPropertyOptional({ example: 85.5, description: "分数" })
  @IsNumber()
  @IsOptional()
  score?: number

  @ApiProperty({ example: { query: "示例数据" }, description: "历史记录数据" })
  @IsObject()
  @IsNotEmpty()
  data: object
}
