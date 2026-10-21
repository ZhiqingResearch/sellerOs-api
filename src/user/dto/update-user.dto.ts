import { ApiPropertyOptional } from "@nestjs/swagger"
import {
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator"

export class UpdateUserDto {
  @ApiPropertyOptional({ example: "张明", description: "用户名" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  username?: string

  @ApiPropertyOptional({ example: "13800001234", description: "手机号（登录账号，唯一）" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone?: string

  @ApiPropertyOptional({
    type: [Number],
    example: [1, 2],
    description: "角色 id 列表（传入即整组覆盖）",
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @ArrayUnique()
  roleIds?: number[]

  @ApiPropertyOptional({
    type: [Number],
    example: [1],
    description: "组织 id 列表（传入即整组覆盖）",
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @ArrayUnique()
  orgIds?: number[]
}
