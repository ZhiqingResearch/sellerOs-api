import { ApiPropertyOptional } from "@nestjs/swagger"
import { Type } from "class-transformer"
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from "class-validator"

export class UpdateMenuGroupDto {
  @ApiPropertyOptional({ example: "报表中心", description: "分组名" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label?: string

  @ApiPropertyOptional({ example: 3, description: "排序值（小者靠前）" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sortOrder?: number
}
