import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { ArrayMinSize, IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength } from "class-validator"

export const PLATFORMS = ["PINTEREST", "INSTAGRAM", "TIKTOK"] as const
export type Platform = (typeof PLATFORMS)[number]

export class CreateSubscriptionDto {
  @ApiProperty({ example: "春季园艺", description: "订阅名称" })
  @IsString()
  @MaxLength(100)
  name: string

  @ApiProperty({ example: ["spring garden", "patio decor"], description: "用户手输的种子词（原文，中/英均可），一定参与抓取" })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  keywords: string[]

  @ApiPropertyOptional({
    example: {
      "spring garden": ["garden ideas", "patio garden", "flower bed", "garden decor", "cottage garden"],
      "patio decor": ["outdoor living", "patio design", "backyard ideas", "patio makeover"],
    },
    description: "每个种子词的全部同语言变体候选集（AI 扩写）",
  })
  @IsOptional()
  @IsObject()
  keywordVariants?: Record<string, string[]>

  @ApiPropertyOptional({
    example: {
      "spring garden": ["garden ideas", "patio garden", "flower bed", "garden decor", "cottage garden"],
      "patio decor": ["outdoor living", "patio makeover"],
    },
    description: "用户勾选真正参与抓取的变体子集，value ⊆ keywordVariants[key]。搜索词 = keywords ∪ selectedVariants 值",
  })
  @IsOptional()
  @IsObject()
  selectedVariants?: Record<string, string[]>

  @ApiProperty({
    example: ["PINTEREST", "INSTAGRAM"],
    description: "目标平台（PINTEREST / INSTAGRAM / TIKTOK）",
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(PLATFORMS, { each: true })
  platforms: Platform[]

  @ApiProperty({
    example: { PINTEREST: 20, INSTAGRAM: 30 },
    description: "每个所选平台各自每次更新拉取条数（20–50），仅包含所选平台",
  })
  @IsObject()
  countPerPlatform: Record<string, number>
}
