import { ApiProperty } from "@nestjs/swagger"
import { Type } from "class-transformer"
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  ValidateNested,
} from "class-validator"
import { CreateUserDto } from "./create-user.dto"

export class BatchCreateUserDto {
  @ApiProperty({ type: [CreateUserDto], description: "批量创建的用户列表" })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateUserDto)
  users: CreateUserDto[]
}

export class UpdateUserStatusDto {
  @ApiProperty({ example: false, description: "true=启用，false=停用" })
  @IsBoolean()
  isActive: boolean
}

export class MoveOrgDto {
  @ApiProperty({ type: [Number], example: [1, 2, 3], description: "要移动的用户 id 列表" })
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @ArrayUnique()
  userIds: number[]

  @ApiProperty({ example: 1, description: "目标组织 id" })
  @IsInt()
  orgId: number

  @ApiProperty({
    example: false,
    description: "必传。true=替换（用户仅保留该组织）；false=加入（保留原有其他组织）",
  })
  @IsBoolean()
  replace: boolean
}
