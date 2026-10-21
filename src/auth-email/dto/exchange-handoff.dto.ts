import { ApiProperty } from "@nestjs/swagger"
import { IsNotEmpty, IsString } from "class-validator"

/** 核销跨域登录交接码（公开接口，无需登录态） */
export class ExchangeHandoffDto {
  @ApiProperty({ description: "一次性交接码（handoff 接口返回的 handoffCode）" })
  @IsString()
  @IsNotEmpty()
  handoffCode: string
}
