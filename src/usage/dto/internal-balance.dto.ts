import { ApiProperty } from "@nestjs/swagger"
import { Transform } from "class-transformer"
import { IsString, Matches } from "class-validator"

export class InternalBalanceDto {
  @ApiProperty({ example: "13800001234", description: "用户在平台登记的手机号" })
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString({ message: "手机号必须为字符串" })
  @Matches(/^1\d{10}$/, { message: "手机号格式不正确" })
  phone!: string
}
