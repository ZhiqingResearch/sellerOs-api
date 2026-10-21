import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"

/** 单个技能的动态数据（与前端静态元数据按 skillId 合并） */
export class SkillMarketSkillItemDto {
  @ApiProperty({ example: "listing-opt", description: "与前端固定数据对应的技能业务 ID" })
  skillId!: string

  @ApiProperty({ example: "ACTIVE", enum: ["ACTIVE", "DISABLED"] })
  status!: string

  @ApiProperty({ example: 128, description: "去重下载用户数（卡片展示此字段）" })
  downloadCount!: number

  @ApiProperty({ example: 176, description: "所有有效下载事件数（含重复下载）" })
  downloadEventCount!: number

  @ApiProperty({ example: true, description: "当前用户是否保留在已下载列表" })
  downloaded!: boolean

  @ApiPropertyOptional({
    example: "2026-08-29T08:20:00.000Z",
    type: String,
    description: "当前用户第一次下载时间",
  })
  firstDownloadedAt!: Date | null

  @ApiPropertyOptional({
    example: "2026-08-31T02:10:00.000Z",
    type: String,
    description: "当前用户最近一次下载时间",
  })
  lastDownloadedAt!: Date | null

  @ApiProperty({ example: 2, description: "当前用户累计下载次数" })
  downloadTimes!: number
}

export class SkillMarketListSummaryDto {
  @ApiProperty({ example: 23, description: "当前可用技能数量" })
  availableSkillCount!: number

  @ApiProperty({ example: 1, description: "当前用户未移出的技能数量" })
  myDownloadedSkillCount!: number
}

export class SkillMarketListResponseDto {
  @ApiProperty({ type: [SkillMarketSkillItemDto] })
  items!: SkillMarketSkillItemDto[]

  @ApiProperty({ type: SkillMarketListSummaryDto })
  summary!: SkillMarketListSummaryDto

  @ApiProperty({ example: "2026-08-31T02:30:00.000Z" })
  serverTime!: string
}

export class RegisterDownloadResponseDto {
  @ApiProperty({ example: "listing-opt" })
  skillId!: string

  @ApiProperty({ example: 129, description: "去重下载用户数" })
  downloadCount!: number

  @ApiProperty({ example: 177, description: "总下载事件数" })
  downloadEventCount!: number

  @ApiProperty({ example: true })
  downloaded!: boolean

  @ApiProperty({ example: true, description: "本次是否为该用户历史首次下载" })
  firstDownload!: boolean

  @ApiProperty({ example: 1, description: "该用户累计下载次数" })
  downloadTimes!: number

  @ApiProperty({
    example: "2026-08-31T02:35:00.000Z",
    description: "本次（或幂等重放对应原次）下载时间",
  })
  downloadedAt!: string

  @ApiProperty({
    example: false,
    description: "true = 相同 clientRequestId 幂等重放，未新增任何计数",
  })
  idempotentReplay!: boolean

  @ApiPropertyOptional({
    example: "https://erp-pro.nyc3.digitaloceanspaces.com/skill-market/skills/listing-opt.md",
    type: String,
    description:
      "技能正文公开直链（免鉴权、永久有效，对象元数据带下载文件名）；null = 未上传，前端兜底本地生成",
  })
  downloadUrl!: string | null

  @ApiPropertyOptional({
    example: null,
    type: String,
    description: "恒为 null，保留字段兼容前端（公开直链无时效）",
  })
  expiresAt!: string | null
}

export class RemoveFromLibraryResponseDto {
  @ApiProperty({ example: "listing-opt" })
  skillId!: string

  @ApiProperty({ example: false })
  downloaded!: boolean

  @ApiProperty({ example: 129, description: "去重下载用户数（移出不减少）" })
  downloadCount!: number

  @ApiPropertyOptional({
    example: "2026-08-31T02:50:00.000Z",
    type: String,
    description: "移出时间；从未下载过时为 null",
  })
  removedAt!: string | null
}
