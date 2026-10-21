import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator"

/**
 * 下载原始评论请求 DTO（B 卡评论分析数据源 review.comment_list 导出 xlsx）。
 * asin 与 productUrl 二选一（都传以 asin 为准、都不传 400）。
 * 纯读取接口：不调 AI、不扣积分；30 天缓存未命中时现场调爬虫。
 */
export class ReviewDownloadDto {
  @ApiPropertyOptional({
    example: "B0GQB1C381",
    description: "10 位 ASIN（与 productUrl 二选一，优先）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  asin?: string

  @ApiPropertyOptional({
    example: "https://www.amazon.com/dp/B0GQB1C381",
    description: "商品 URL（与 asin 二选一）",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  productUrl?: string

  @ApiPropertyOptional({ example: "US", description: "站点国家，缺省 US（US/UK/DE）" })
  @IsOptional()
  @IsIn(["US", "UK", "DE"])
  country?: string
}
