import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsArray, IsOptional, IsString, MaxLength, MinLength } from "class-validator"

export class CreateRoleDto {
  @ApiProperty({ example: "广告优化师", description: "角色名称" })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string

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

  @ApiProperty({
    type: [String],
    example: ["tool.listing_generate", "tool.listing_score"],
    description: "权限 key 列表（与 Permission.key 对应）",
  })
  @IsArray()
  @IsString({ each: true })
  permissionKeys!: string[]
}
