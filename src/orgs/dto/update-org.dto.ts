import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator"

export class UpdateOrgDto {
  @ApiPropertyOptional({ example: "深圳总部", description: "组织名称（唯一）" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string

  @ApiPropertyOptional({ example: "集团总部 · 综合运营", description: "备注" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string
}
