import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"
import {
  PROMOTION_PLAN_MARKETS,
  PROMOTION_PLAN_MAX_COMPETITORS,
  PROMOTION_PLAN_MAX_PRODUCT_TEXT_LENGTH,
  PROMOTION_PLAN_SCHEMA_VERSION,
} from "../promotion-plan.constants"

const numberOptions = { allowNaN: false, allowInfinity: false }

export class PromotionCompetitorDto {
  @ApiProperty({
    example: "https://www.amazon.com/dp/B09VLJJPL6",
    description: "规范化后的商品页 URL",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  sourceUrl: string

  @ApiPropertyOptional({ example: "Portable Blender, USB Rechargeable" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string

  @ApiPropertyOptional({ example: "BOSHIWA" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  brand?: string

  @ApiPropertyOptional({ example: "$29.99", description: "页面原文价格" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  price?: string

  @ApiPropertyOptional({ example: "4.5" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  rating?: string

  @ApiPropertyOptional({ example: "12580" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  reviewCount?: string

  @ApiPropertyOptional({ type: [String], example: ["USB 充电一次可打 12-15 杯"] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  bullets?: string[]
}

export class PromotionPlanInputDto {
  @ApiProperty({ example: "便携榨汁杯 400ml · USB-C 快充 · 六叶刀头 · 健身房 / 露营场景" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROMOTION_PLAN_MAX_PRODUCT_TEXT_LENGTH)
  productText: string

  @ApiProperty({
    type: [String],
    example: ["https://www.amazon.com/dp/B09VLJJPL6", "B0C1X2Y3Z4"],
    description: "原始竞品链接，每行一个，可能是裸 ASIN",
  })
  @IsArray()
  @ArrayMaxSize(PROMOTION_PLAN_MAX_COMPETITORS)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  competitorLinks: string[]

  @ApiProperty({ type: [PromotionCompetitorDto], description: "抓取成功的竞品快照" })
  @IsArray()
  @ArrayMaxSize(PROMOTION_PLAN_MAX_COMPETITORS)
  @ValidateNested({ each: true })
  @Type(() => PromotionCompetitorDto)
  competitors: PromotionCompetitorDto[]

  @ApiPropertyOptional({ example: 25.9, nullable: true, description: "表单留空时为 null" })
  @IsOptional()
  @IsNumber(numberOptions)
  @Min(0)
  targetPrice?: number | null

  @ApiProperty({ enum: PROMOTION_PLAN_MARKETS, example: "amazon_us" })
  @IsIn([...PROMOTION_PLAN_MARKETS])
  market: string

  @ApiProperty({ example: "家居厨房" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  category: string
}

export class CreatePromotionPlanRecordDto {
  @ApiProperty({ example: "3f1c2b8e-6d4a-4f2e-9c1d-8a7b6c5d4e3f", description: "幂等键" })
  @IsUUID("4")
  clientRequestId: string

  @ApiProperty({ example: PROMOTION_PLAN_SCHEMA_VERSION, description: "快照结构版本，当前恒为 1" })
  @IsInt()
  @Min(PROMOTION_PLAN_SCHEMA_VERSION)
  @Max(PROMOTION_PLAN_SCHEMA_VERSION)
  schemaVersion: number

  @ApiProperty({ example: "便携榨汁杯 400ml" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  productName: string

  @ApiProperty({ enum: PROMOTION_PLAN_MARKETS, example: "amazon_us" })
  @IsIn([...PROMOTION_PLAN_MARKETS])
  market: string

  @ApiProperty({ example: "家居厨房" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  category: string

  @ApiProperty({ example: 29.99, description: "锚点价（= result.anchorPrice），> 0" })
  @IsNumber(numberOptions)
  @IsPositive()
  anchorPrice: number

  @ApiProperty({ example: 2, description: "= input.competitors.length，0~5" })
  @IsInt()
  @Min(0)
  @Max(PROMOTION_PLAN_MAX_COMPETITORS)
  competitorCount: number

  @ApiProperty({ type: PromotionPlanInputDto })
  @ValidateNested()
  @Type(() => PromotionPlanInputDto)
  input: PromotionPlanInputDto

  @ApiProperty({
    type: Object,
    description: "SopResult 全量；仅强校验 productName 非空，其余按不透明 JSON 存储",
  })
  @IsObject()
  result: Record<string, unknown>
}
