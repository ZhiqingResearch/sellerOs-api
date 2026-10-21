import { ApiProperty } from "@nestjs/swagger"
import { IsDateString, IsNotEmpty, IsString, MaxLength } from "class-validator"

export class CreateAnnouncementDto {
  @ApiProperty({ example: "2026-09-20T00:00:00.000Z", description: "生效开始时间（ISO 8601）" })
  @IsDateString()
  startAt!: string

  @ApiProperty({
    example: "2026-09-30T23:59:59.999Z",
    description: "生效结束时间（ISO 8601，须晚于 startAt 且晚于当前时间）",
  })
  @IsDateString()
  endAt!: string

  @ApiProperty({ example: "平台将于本周六 02:00-04:00 升级维护。", description: "公告正文" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  content!: string
}
