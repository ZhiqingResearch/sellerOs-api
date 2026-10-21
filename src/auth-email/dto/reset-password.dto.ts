import { ApiProperty } from "@nestjs/swagger"
import { IsEmail, IsString, Length, MaxLength, MinLength } from "class-validator"

/** 重置密码：邮箱 + 重置验证码 + 新密码（仅邮箱注册账号可用） */
export class ResetPasswordDto {
  @ApiProperty({ example: "buyer@example.com", description: "注册邮箱" })
  @IsEmail()
  email: string

  @ApiProperty({ example: "123456", description: "重置验证码（6 位）" })
  @IsString()
  @Length(6, 6)
  emailCode: string

  @ApiProperty({ example: "NewPassw0rd!", description: "新密码（6-64 位）" })
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  newPassword: string
}
