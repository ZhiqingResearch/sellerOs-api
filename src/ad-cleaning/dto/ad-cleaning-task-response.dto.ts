import { ApiProperty } from "@nestjs/swagger"
import type { AdCleaningTaskStatus } from "../ad-cleaning.types"

class AdCleaningVerdictCountsDto {
  @ApiProperty({ example: 64 })
  good: number

  @ApiProperty({ example: 29 })
  bad: number

  @ApiProperty({ example: 215 })
  warn: number

  @ApiProperty({ example: 2529 })
  watch: number

  @ApiProperty({ example: 76 })
  neutral: number
}

class AdCleaningStatsDto {
  @ApiProperty({ example: "Sponsored_Products_Search_term_" })
  sourceSheet: string

  @ApiProperty({ example: "USD" })
  currency: string

  @ApiProperty({ example: 2914 })
  sourceRows: number

  @ApiProperty({ example: 2914 })
  effectiveRows: number

  @ApiProperty({ example: 2913 })
  aggregatedSearchTerms: number

  @ApiProperty({ example: 1 })
  mergedRows: number

  @ApiProperty({ example: 0 })
  skippedRows: number

  @ApiProperty({ example: 13 })
  cleanedInvisibleChars: number

  @ApiProperty({ example: 2 })
  trimmedWrappingQuotes: number

  @ApiProperty({ example: 2 })
  zeroImpressionClickRows: number

  @ApiProperty({ type: () => AdCleaningVerdictCountsDto })
  verdictCounts: AdCleaningVerdictCountsDto

  @ApiProperty({ example: 28 })
  negativeCandidateCount: number

  @ApiProperty({ example: 631.52 })
  negativeCandidateSpend: number
}

class AdCleaningSheetPreviewDto {
  @ApiProperty({ example: "搜索词审计" })
  sheetName: string

  @ApiProperty({ type: [String], example: ["广告活动", "广告组", "客户搜索词", "点击量"] })
  headers: string[]

  @ApiProperty({
    description: "该 Sheet 的前100条数据，不包含表头；数字保持 number，空单元格为 null",
    type: "array",
    items: {
      type: "array",
      items: {
        oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
      },
    },
    example: [["活动A", "广告组A", "laptop", 12]],
  })
  rows: Array<Array<string | number | boolean | null>>

  @ApiProperty({ description: "该 Sheet 不含表头的完整数据行数", example: 2913 })
  totalRows: number
}

export class AdCleaningTaskResponseDto {
  @ApiProperty({ example: "8d4dd930-2e77-40a8-9f79-e422c14f5a6c" })
  taskId: string

  @ApiProperty({ enum: ["PENDING", "PROCESSING", "SUCCESS", "FAILED"] })
  status: AdCleaningTaskStatus

  @ApiProperty({ minimum: 0, maximum: 100, example: 100 })
  progress: number

  @ApiProperty({ example: "清洗完成" })
  stage: string

  @ApiProperty({ example: "Sponsored_Products_Search_term_report.xlsx" })
  originalFilename: string

  @ApiProperty({
    nullable: true,
    example: "Sponsored_Products_Search_term_report-清洗结果.xlsx",
  })
  outputFilename: string | null

  @ApiProperty({
    nullable: true,
    description: "清洗结果上传到文件服务器后返回的稳定 URL",
    example: "https://files.example.com/ad-cleaning/42/2026/08/20/task-id.xlsx",
  })
  resultFileUrl: string | null

  @ApiProperty({ type: () => AdCleaningStatsDto, nullable: true })
  stats: AdCleaningStatsDto | null

  @ApiProperty({
    type: () => [AdCleaningSheetPreviewDto],
    nullable: true,
    description: "清洗成功后实时返回中间5个 Sheet 的表头和前100条数据；不返回清洗摘要和待否定词",
  })
  sheetPreviews: AdCleaningSheetPreviewDto[] | null

  @ApiProperty({ nullable: true, example: null })
  errorMessage: string | null

  @ApiProperty({ example: "2026-08-20T10:00:00.000Z" })
  createdAt: string

  @ApiProperty({ nullable: true, example: "2026-08-20T10:00:00.001Z" })
  startedAt: string | null

  @ApiProperty({ nullable: true, example: "2026-08-20T10:00:00.500Z" })
  completedAt: string | null

  @ApiProperty({
    nullable: true,
    example: "/api/ad-cleaning/tasks/8d4dd930-2e77-40a8-9f79-e422c14f5a6c/download",
  })
  downloadPath: string | null
}
