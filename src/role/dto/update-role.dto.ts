import { ApiPropertyOptional } from "@nestjs/swagger"
import { IsArray, IsOptional, IsString, MaxLength, MinLength } from "class-validator"

export class UpdateRoleDto {
  @ApiPropertyOptional({ example: "广告优化师", description: "角色名称" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string

  @ApiPropertyOptional({ example: "负责广告投放优化", description: "角色描述" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string

  @ApiPropertyOptional({ example: "#007aff", description: "角色标识色" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string

  @ApiPropertyOptional({
    type: [String],
    example: ["tool.listing_generate"],
    description: "权限 key 列表（传入即整组覆盖；超级管理员不可改权限）",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissionKeys?: string[]
}
