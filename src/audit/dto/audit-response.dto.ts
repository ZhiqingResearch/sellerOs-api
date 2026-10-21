import { ApiProperty } from "@nestjs/swagger"

export class AuditResponseDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "https://www.amazon.com/dp/B0XXXXXXXX" })
  url!: string

  @ApiProperty({ example: "amazon", description: "平台标识（小写）" })
  platform!: string

  @ApiProperty({ example: "US", description: "站点" })
  country!: string

  @ApiProperty({ example: "B0XXXXXXXX", nullable: true, description: "ASIN（入参或从爬虫回填）" })
  asin!: string | null

  @ApiProperty({ example: "Echo Dot (5th Gen)" })
  name!: string

  @ApiProperty({
    description: "完整爬虫返回的审计富数据（含 qa / review / product_information_hhl 等）",
    type: "object",
    additionalProperties: true,
  })
  data!: unknown

  @ApiProperty({ example: "2026-06-29T03:00:00.000Z", description: "上次成功爬取时间" })
  fetchedAt!: Date

  @ApiProperty({ example: "2026-06-29T03:00:00.000Z" })
  createdAt!: Date

  @ApiProperty({ example: "2026-06-29T03:00:00.000Z" })
  updatedAt!: Date
}
