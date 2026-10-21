import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { SensitiveWordRiskLevel, SensitiveWordSource } from "@prisma/client"

export class SensitiveWordUserDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "张三" })
  username!: string
}

export class SensitiveWordResponseDto {
  @ApiProperty({ example: 1 })
  id!: number

  @ApiProperty({ example: "FDA approved" })
  word!: string

  @ApiProperty({ example: "amazon" })
  platform!: string

  @ApiProperty({ example: "保健品" })
  category!: string

  @ApiProperty({ enum: SensitiveWordRiskLevel, example: SensitiveWordRiskLevel.HIGH })
  riskLevel!: SensitiveWordRiskLevel

  @ApiProperty({ enum: SensitiveWordSource, example: SensitiveWordSource.MANUAL })
  source!: SensitiveWordSource

  @ApiPropertyOptional({ example: "可使用「品质保障」等替代说法" })
  suggestion?: string | null

  @ApiProperty({ example: 7, description: "创建人 userId" })
  userId!: number

  @ApiPropertyOptional({ type: SensitiveWordUserDto, description: "创建人简要信息" })
  user?: SensitiveWordUserDto

  @ApiProperty({ example: "2026-06-02T03:00:00.000Z" })
  createdAt!: Date

  @ApiProperty({ example: "2026-06-02T03:00:00.000Z" })
  updatedAt!: Date
}
