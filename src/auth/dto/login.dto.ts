import { ApiProperty } from "@nestjs/swagger"
import { IsNotEmpty, IsString } from "class-validator"

export class LoginDto {
  @ApiProperty({ example: "18280027092", description: "手机号" })
  @IsString()
  @IsNotEmpty()
  phone: string

  @ApiProperty({ example: "123456", description: "密码" })
  @IsString()
  @IsNotEmpty()
  password: string
}
