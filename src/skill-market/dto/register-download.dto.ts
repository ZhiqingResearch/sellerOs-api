import { ApiProperty } from "@nestjs/swagger"
import { IsUUID } from "class-validator"

export class RegisterDownloadDto {
  @ApiProperty({
    description: "前端每次用户主动点击下载时生成的幂等键；同一次请求重试必须复用",
    example: "d7d829c4-b226-4be5-bbcb-cdbe14fb18f8",
  })
  @IsUUID("4", { message: "INVALID_CLIENT_REQUEST_ID：clientRequestId 缺失或不是 UUID" })
  clientRequestId!: string
}
