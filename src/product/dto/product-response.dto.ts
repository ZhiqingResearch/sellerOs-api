import { ApiProperty } from "@nestjs/swagger"

export class ProductResponseDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "https://www.amazon.com/dp/B0XXXX" })
  url!: string

  @ApiProperty({
    example: "amazon",
    description:
      "平台标识，小写字符串。当前常见值：amazon / walmart / tiktokshop / ozon / wildberries / gigacloud；新平台返回什么存什么",
  })
  platform!: string

  @ApiProperty({ example: "Echo Dot (5th Gen)" })
  name!: string

  @ApiProperty({
    description: "完整商品抓取 JSON；不同平台字段存在差异，前端按 platform 分支解析",
    type: "object",
    additionalProperties: true,
  })
  data!: unknown

  @ApiProperty({ example: "2026-05-08T03:00:00.000Z", description: "上次成功爬取时间" })
  fetchedAt!: Date

  @ApiProperty({ example: "2026-05-08T03:00:00.000Z" })
  createdAt!: Date

  @ApiProperty({ example: "2026-05-08T03:00:00.000Z" })
  updatedAt!: Date
}
