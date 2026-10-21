import { ApiProperty } from "@nestjs/swagger"

export class OrgItemDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "深圳总部" })
  name!: string

  @ApiProperty({ example: "集团总部 · 综合运营", nullable: true })
  note!: string | null

  @ApiProperty({ example: 8, description: "该组织下用户数" })
  usersCount!: number

  @ApiProperty({ example: "2025-08-12T10:24:00.000Z" })
  createdAt!: string
}
