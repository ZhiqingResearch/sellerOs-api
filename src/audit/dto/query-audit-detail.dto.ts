import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsEnum, IsOptional, IsString, IsUrl, Matches, MaxLength } from "class-validator"
import { Country } from "../audit.marketplace"

/** ASIN 审计商品详情入参：url 与 asin 二选一（都传以 url 为准、都不传 400）。 */
export class QueryAuditDetailDto {
  @ApiPropertyOptional({
    example: "https://www.amazon.com/dp/B0XXXXXXXX",
    description: "商品详情页 URL；与 asin 二选一，两者都传以 url 为准",
  })
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  url?: string

  @ApiPropertyOptional({
    example: "B0XXXXXXXX",
    description: "ASIN；与 url 二选一。传 asin 时按 country 域名拼出 URL 再调爬虫",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]{10}$/i, { message: "asin 需为 10 位字母数字" })
  asin?: string

  @ApiPropertyOptional({
    enum: Country,
    default: Country.US,
    description: "站点（仅 asin 入参时生效）；默认 US",
  })
  @IsOptional()
  @IsEnum(Country)
  country?: Country

  @ApiPropertyOptional({
    example: "amazon",
    default: "amazon",
    description: "平台，预留多平台；默认 amazon",
  })
  @IsOptional()
  @IsString()
  platform?: string
}
