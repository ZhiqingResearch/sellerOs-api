import { ApiProperty } from "@nestjs/swagger"

export class BucketCountDto {
  @ApiProperty({ example: "amazon" })
  key!: string

  @ApiProperty({ example: 42 })
  count!: number
}

export class SensitiveWordStatsResponseDto {
  @ApiProperty({ example: 128, description: "总数" })
  total!: number

  @ApiProperty({ type: [BucketCountDto], description: "按平台聚合" })
  byPlatform!: BucketCountDto[]

  @ApiProperty({ type: [BucketCountDto], description: "按分类聚合" })
  byCategory!: BucketCountDto[]
}
