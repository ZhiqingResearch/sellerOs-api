import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator"
import {
  SMART_PRICING_CURRENCIES,
  SMART_PRICING_MARKETPLACE_CODES,
  SMART_PRICING_MAX_COMPETITORS,
  SMART_PRICING_MAX_FILENAMES,
  SMART_PRICING_SCHEMA_VERSION,
} from "../smart-pricing.constants"

const numberOptions = { allowNaN: false, allowInfinity: false }

export class PricingProductDto {
  @ApiProperty({ example: "Example Product" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  name: string

  @ApiPropertyOptional({ example: "https://www.1688.com/offer/123.html" })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  sourceText?: string

  @ApiPropertyOptional({ example: "https://www.1688.com/offer/123.html" })
  @IsOptional()
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  @MaxLength(2048)
  sourceUrl?: string

  @ApiPropertyOptional({ type: [String], example: ["采购报价.pdf"] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SMART_PRICING_MAX_FILENAMES)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  filenames?: string[]

  @ApiPropertyOptional({ example: "Example Product · Brand" })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  extractedProductInfo?: string
}

export class PricingInputDto {
  @ApiProperty({ example: 12.3 })
  @IsNumber(numberOptions)
  @Min(0)
  cost: number

  @ApiProperty({ example: 3.5 })
  @IsNumber(numberOptions)
  @Min(0)
  freight: number

  @ApiProperty({ example: 5.7 })
  @IsNumber(numberOptions)
  @Min(0)
  fba: number

  @ApiProperty({ example: 0.15, description: "小数；0.15 表示 15%" })
  @IsNumber(numberOptions)
  @Min(0)
  @Max(1)
  commR: number

  @ApiProperty({ example: 0.18, description: "小数；0.18 表示 18%" })
  @IsNumber(numberOptions)
  @Min(0)
  @Max(1)
  acosR: number

  @ApiProperty({ example: 0.025 })
  @IsNumber(numberOptions)
  @Min(0)
  @Max(1)
  retR: number

  @ApiProperty({ example: 0 })
  @IsNumber(numberOptions)
  @Min(0)
  @Max(1)
  vatR: number

  @ApiProperty({ example: 0.32 })
  @IsNumber(numberOptions)
  @Min(0)
  @Max(1)
  premium: number

  @ApiProperty({ example: 0.3 })
  @IsNumber(numberOptions)
  @Min(0)
  @Max(1)
  targetM: number
}

export class PricingCompetitorDto {
  @ApiPropertyOptional({ example: "B0AAAA0001" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  asin?: string

  @ApiProperty({ example: "Competitor A" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  title: string

  @ApiPropertyOptional({ example: "Brand A" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  brand?: string

  @ApiProperty({ example: 39.99 })
  @IsNumber(numberOptions)
  @Min(0)
  price: number

  @ApiPropertyOptional({ example: 4.5 })
  @IsOptional()
  @IsNumber(numberOptions)
  @Min(0)
  @Max(5)
  rating?: number

  @ApiPropertyOptional({ example: 1250 })
  @IsOptional()
  @IsInt()
  @Min(0)
  ratings?: number
}

export class PricingCompetitorContextDto {
  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(0)
  sampleSize: number

  @ApiProperty({ example: 29.99 })
  @IsNumber(numberOptions)
  @Min(0)
  priceMin: number

  @ApiProperty({ example: 39.99 })
  @IsNumber(numberOptions)
  @Min(0)
  priceMedian: number

  @ApiProperty({ example: 49.99 })
  @IsNumber(numberOptions)
  @Min(0)
  priceMax: number

  @ApiProperty({ type: [PricingCompetitorDto] })
  @IsArray()
  @ArrayMaxSize(SMART_PRICING_MAX_COMPETITORS)
  @ValidateNested({ each: true })
  @Type(() => PricingCompetitorDto)
  competitors: PricingCompetitorDto[]
}

export class PricingVerdictDto {
  @ApiProperty({ example: "✅ 可上架定价" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  t: string

  @ApiProperty({ example: "#34c759", description: "六位 HEX 颜色" })
  @IsString()
  @MaxLength(7)
  c: string
}

export class PricingResultDto {
  @ApiProperty({ example: "Example Product" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  name: string

  @ApiProperty({ example: 12.3 })
  @IsNumber(numberOptions)
  cost: number

  @ApiProperty({ example: 3.5 })
  @IsNumber(numberOptions)
  freight: number

  @ApiProperty({ example: 5.7 })
  @IsNumber(numberOptions)
  fba: number

  @ApiProperty({ example: 21.5 })
  @IsNumber(numberOptions)
  Cfix: number

  @ApiProperty({ example: 0.15 })
  @IsNumber(numberOptions)
  commR: number

  @ApiProperty({ example: 0.18 })
  @IsNumber(numberOptions)
  acosR: number

  @ApiProperty({ example: 0.025 })
  @IsNumber(numberOptions)
  retR: number

  @ApiProperty({ example: 0 })
  @IsNumber(numberOptions)
  vatR: number

  @ApiProperty({ example: 0.32 })
  @IsNumber(numberOptions)
  premium: number

  @ApiProperty({ example: 0.3 })
  @IsNumber(numberOptions)
  targetM: number

  @ApiProperty({ example: 0.355 })
  @IsNumber(numberOptions)
  rateSum: number

  @ApiProperty({ example: 33.3333 })
  @IsNumber(numberOptions)
  P_floor: number

  @ApiProperty({ example: 62.3188 })
  @IsNumber(numberOptions)
  P_target: number

  @ApiProperty({ example: 62.3188 })
  @IsNumber(numberOptions)
  P_ceiling: number

  @ApiProperty({ example: 44.99 })
  @IsNumber(numberOptions)
  rec: number

  @ApiProperty({ example: 7.5186 })
  @IsNumber(numberOptions)
  recNet: number

  @ApiProperty({ example: 16.7113, description: "百分数；16.7113 表示 16.7113%" })
  @IsNumber(numberOptions)
  recMargin: number

  @ApiProperty({ example: false })
  @IsBoolean()
  infeasible: boolean

  @ApiProperty({ example: 56 })
  @IsNumber(numberOptions)
  sHealth: number

  @ApiProperty({ example: 82 })
  @IsNumber(numberOptions)
  sCompete: number

  @ApiProperty({ example: 96 })
  @IsNumber(numberOptions)
  sConv: number

  @ApiProperty({ example: 74 })
  @IsNumber(numberOptions)
  sRisk: number

  @ApiProperty({ example: 74 })
  @IsNumber(numberOptions)
  composite: number

  @ApiProperty({ type: PricingVerdictDto })
  @ValidateNested()
  @Type(() => PricingVerdictDto)
  verdict: PricingVerdictDto

  @ApiPropertyOptional({ example: "建议价位于竞品价格带中上部。" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  competitorRecommendation?: string

  @ApiProperty({
    type: "array",
    description: "必须正好四项；每项为 [阶段名, 目标, 策略, 价格]",
    example: [
      ["新品期", "冲排名 / 攒评论", "渗透定价：贴地板价 +5%", 22.99],
      ["成长期", "稳利润 / 爬坑位", "竞争定价：主流带中位偏下", 27.99],
      ["成熟期", "利润最大化", "价值定价：主流带上沿 + 溢价", 41.99],
      ["清仓期", "回笼现金", "清仓定价：保本 +2% + 大额 Coupon", 21.99],
    ],
  })
  @IsArray()
  stages: unknown[][]

  @ApiProperty({
    type: "array",
    description: "每项为 [标签, 金额, HEX颜色]；vatR=0 时四项，否则五项",
    example: [
      ["平台佣金", 4.1985, "#ff9500"],
      ["广告摊销 (ACOS)", 5.0382, "#5ac8fa"],
      ["采购+头程+FBA", 13.8, "#af52de"],
      ["退货损耗", 0.69975, "#ff3b30"],
    ],
  })
  @IsArray()
  waterfall: unknown[][]
}

export class CreateSmartPricingRecordDto {
  @ApiProperty({ example: "c01935bb-a4a4-43b2-9d03-ae65bf99dd15" })
  @IsUUID("4")
  clientRequestId: string

  @ApiProperty({ example: SMART_PRICING_SCHEMA_VERSION })
  @IsInt()
  @Min(SMART_PRICING_SCHEMA_VERSION)
  @Max(SMART_PRICING_SCHEMA_VERSION)
  schemaVersion: number

  @ApiProperty({ enum: SMART_PRICING_MARKETPLACE_CODES, example: "AMAZON_US" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  marketplaceCode: string

  @ApiProperty({ example: "Amazon US" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  marketplaceName: string

  @ApiProperty({
    enum: SMART_PRICING_CURRENCIES,
    example: "USD",
    description: "ISO 4217 币种，按页面实际计算币种传值，小写会自动转大写",
  })
  @IsString()
  @MaxLength(3)
  currency: string

  @ApiProperty({ example: "家居厨房" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  category: string

  @ApiProperty({ type: PricingProductDto })
  @ValidateNested()
  @Type(() => PricingProductDto)
  product: PricingProductDto

  @ApiProperty({ type: PricingInputDto })
  @ValidateNested()
  @Type(() => PricingInputDto)
  input: PricingInputDto

  @ApiPropertyOptional({ type: PricingCompetitorContextDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PricingCompetitorContextDto)
  competitorContext?: PricingCompetitorContextDto | null

  @ApiProperty({ type: PricingResultDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PricingResultDto)
  result: PricingResultDto
}
