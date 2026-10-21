import { ApiProperty } from "@nestjs/swagger"
import { IsEmail } from "class-validator"

/** 忘记密码：向邮箱注册账号发送重置验证码（响应统一话术，不暴露账号存在性） */
export class ForgotPasswordDto {
  @ApiProperty({ example: "buyer@example.com", description: "注册邮箱" })
  @IsEmail()
  email: string
}
