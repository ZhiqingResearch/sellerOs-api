import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { IsEmail, IsOptional, IsString, Length, MaxLength, MinLength } from "class-validator"

/** 邮箱开放注册：邮箱 + 邮箱验证码 + 密码（注册即登录，直接返回 token） */
export class EmailRegisterDto {
  @ApiProperty({ example: "buyer@example.com", description: "注册邮箱" })
  @IsEmail()
  email: string

  @ApiProperty({ example: "123456", description: "邮箱验证码（6 位）" })
  @IsString()
  @Length(6, 6)
  emailCode: string

  @ApiProperty({ example: "Passw0rd!", description: "密码（6-64 位）" })
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  password: string

  @ApiPropertyOptional({ example: "张三", description: "用户名 / 称谓，≤50；缺省取邮箱 @ 前部分" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  username?: string
}
