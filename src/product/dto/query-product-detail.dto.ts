import { ApiProperty } from "@nestjs/swagger"
import { IsString, IsUrl, MaxLength } from "class-validator"

export class QueryProductDetailDto {
  @ApiProperty({
    example: "https://www.amazon.com/dp/B0XXXX",
    description: "产品详情页 URL（带 query 算不同行）",
  })
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  url!: string
}
