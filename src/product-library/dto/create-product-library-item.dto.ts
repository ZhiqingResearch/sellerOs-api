import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator"

export class CreateProductLibraryItemDto {
  @ApiPropertyOptional({ example: "B0GWK1HFXP" })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{10}$/)
  asin?: string

  @ApiProperty({ example: "US" })
  @IsString()
  @MaxLength(16)
  marketplace: string

  @ApiProperty({ example: "cup holder" })
  @IsString()
  @MaxLength(500)
  keyword: string

  @ApiPropertyOptional({ example: "Car Cup Holder" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  title?: string

  @ApiPropertyOptional({ example: "Example Brand" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  brand?: string

  @ApiPropertyOptional({ example: "https://example.com/product.jpg" })
  @IsOptional()
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  @MaxLength(2048)
  imageUrl?: string

  @ApiPropertyOptional({ example: 6.07 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999999.9999)
  compScore?: number

  @ApiPropertyOptional({ example: 17 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  price?: number

  @ApiPropertyOptional({ example: 800 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  monthlySales?: number

  @ApiPropertyOptional({ example: 27 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  ratingNum?: number

  @ApiProperty({ example: "5e10c2ea-f40e-48c7-9074-45388a7bfb2f" })
  @IsUUID("4")
  sourceAnalysisId: string

  @ApiPropertyOptional({ example: ["重点观察", "高潜力"] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[]

  @ApiPropertyOptional({ example: "下月重新验证广告成本" })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  notes?: string

  @ApiProperty({ example: { competitor: {}, analysis: {} } })
  @IsObject()
  profile: Record<string, unknown>
}
