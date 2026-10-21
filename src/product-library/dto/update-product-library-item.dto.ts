import { ApiPropertyOptional } from "@nestjs/swagger"
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from "class-validator"

export class UpdateProductLibraryItemDto {
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
}
