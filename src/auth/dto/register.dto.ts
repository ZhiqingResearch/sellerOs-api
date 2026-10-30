import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { Transform } from "class-transformer"
import { IsMobilePhone, IsOptional, IsString, Length, Matches } from "class-validator"

export class RegisterDto {
  @ApiProperty({ example: "tester01", description: "用户名，去除首尾空格后 1–50 字" })
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString({ message: "用户名必须为字符串" })
  @Length(1, 50, { message: "用户名长度必须为1至50字" })
  username: string

  @ApiProperty({ example: "15884033673", description: "国内手机号" })
  @IsString({ message: "手机号必须为字符串" })
  @IsMobilePhone("zh-CN", {}, { message: "请输入有效的手机号" })
  phone: string

  @ApiProperty({ example: "123456", description: "短信验证码，6位数字" })
  @IsString({ message: "验证码必须为字符串" })
  @Matches(/^\d{6}$/, { message: "验证码必须为6位数字" })
  code: string

  @ApiProperty({ example: "Passw0rd!", description: "密码，8–64位，至少包含字母和数字" })
  @IsString({ message: "密码必须为字符串" })
  @Length(8, 64, { message: "密码长度必须为8至64位" })
  @Matches(/^(?=[\s\S]*[A-Za-z])(?=[\s\S]*\d)[\s\S]+$/, {
    message: "密码必须包含字母和数字",
  })
  password: string

  @ApiPropertyOptional({ example: "OS8K3F", description: "邀请码；空白视为未填写" })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() || undefined : value
  )
  @IsOptional()
  @IsString({ message: "邀请码必须为字符串" })
  @Length(4, 32, { message: "邀请码长度必须为4至32位" })
  inviteCode?: string
}
