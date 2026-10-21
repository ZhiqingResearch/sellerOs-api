import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import {
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator"

export class CreateUserDto {
  @ApiProperty({ example: "张明", description: "用户名" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  username: string

  @ApiProperty({ example: "13800001234", description: "手机号（登录账号，唯一）" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone: string

  @ApiPropertyOptional({ type: [Number], example: [1, 2], description: "角色 id 列表" })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @ArrayUnique()
  roleIds?: number[]

  @ApiPropertyOptional({ type: [Number], example: [1], description: "所属组织 id 列表" })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @ArrayUnique()
  orgIds?: number[]
}
