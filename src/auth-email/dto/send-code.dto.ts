import { ApiProperty } from "@nestjs/swagger"
import { IsEmail } from "class-validator"

/** 发送邮箱注册验证码 */
export class SendEmailCodeDto {
  @ApiProperty({ example: "buyer@example.com", description: "注册邮箱" })
  @IsEmail()
  email: string
}
