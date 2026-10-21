import { ApiProperty } from "@nestjs/swagger"
import { IsMobilePhone, IsNotEmpty, IsString } from "class-validator"

export class SendCodeDto {
  @ApiProperty({ example: "18280027092", description: "手机号" })
  @IsString()
  @IsNotEmpty()
  @IsMobilePhone("zh-CN", {}, { message: "请输入有效的手机号" })
  phone: string
}
