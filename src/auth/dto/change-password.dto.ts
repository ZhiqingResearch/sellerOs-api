import { ApiProperty } from "@nestjs/swagger"
import { IsNotEmpty, IsString, MaxLength, MinLength } from "class-validator"

export class ChangePasswordDto {
  @ApiProperty({ example: "123456", description: "原密码" })
  @IsString()
  @IsNotEmpty()
  oldPassword: string

  @ApiProperty({ example: "newPass@123", description: "新密码（6-100 位）" })
  @IsString()
  @MinLength(6)
  @MaxLength(100)
  newPassword: string
}
