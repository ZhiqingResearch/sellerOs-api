import { ApiProperty } from "@nestjs/swagger"
import { IsEmail, IsNotEmpty, IsString } from "class-validator"

/** 邮箱密码登录 */
export class EmailLoginDto {
  @ApiProperty({ example: "buyer@example.com", description: "注册邮箱" })
  @IsEmail()
  email: string

  @ApiProperty({ example: "Passw0rd!", description: "密码" })
  @IsString()
  @IsNotEmpty()
  password: string
}
