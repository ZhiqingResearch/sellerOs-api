import { ApiProperty } from "@nestjs/swagger"
import { IsMobilePhone, IsNotEmpty, IsString, Matches } from "class-validator"

export class SmsLoginDto {
  @ApiProperty({ example: "18280027092", description: "手机号" })
  @IsString()
  @IsNotEmpty()
  @IsMobilePhone("zh-CN", {}, { message: "请输入有效的手机号" })
  phone: string

  @ApiProperty({ example: "123456", description: "短信验证码" })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{6}$/, { message: "验证码必须为6位数字" })
  code: string
}
