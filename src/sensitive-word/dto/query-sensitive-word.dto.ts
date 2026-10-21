import { ApiPropertyOptional } from "@nestjs/swagger"
import { SensitiveWordSource } from "@prisma/client"
import { Transform, Type } from "class-transformer"
import { IsEnum, IsInt, IsOptional, IsString, MaxLength } from "class-validator"
import { PaginationDto } from "../../common/dto/pagination.dto"

export class QuerySensitiveWordDto extends PaginationDto {
  @ApiPropertyOptional({ example: "amazon", description: "平台标识（精确匹配）" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value
  )
  platform?: string

  @ApiPropertyOptional({ example: "保健品", description: "商品分类（精确匹配）" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string

  @ApiPropertyOptional({ example: "FDA", description: "敏感词模糊查询" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  word?: string

  @ApiPropertyOptional({
    enum: SensitiveWordSource,
    example: SensitiveWordSource.MANUAL,
    description: "来源筛选",
  })
  @IsOptional()
  @IsEnum(SensitiveWordSource)
  source?: SensitiveWordSource

  @ApiPropertyOptional({ example: 1, description: "创建人 userId" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  userId?: number
}
