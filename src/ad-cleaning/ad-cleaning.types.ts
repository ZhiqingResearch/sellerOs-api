export type AdCleaningTaskStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED"

/** 前端 Excel 预览允许的单元格类型，确保可以直接 JSON 序列化。 */
export type AdCleaningPreviewCell = string | number | boolean | null

/** 清洗结果中单个 Sheet 的表头、前 100 行数据和完整数据行数。 */
export interface AdCleaningSheetPreview {
  sheetName: string
  headers: string[]
  rows: AdCleaningPreviewCell[][]
  totalRows: number
}

export interface AdCleaningStats {
  sourceSheet: string
  currency: string
  sourceRows: number
  effectiveRows: number
  aggregatedSearchTerms: number
  mergedRows: number
  skippedRows: number
  cleanedInvisibleChars: number
  trimmedWrappingQuotes: number
  zeroImpressionClickRows: number
  verdictCounts: {
    good: number
    bad: number
    warn: number
    watch: number
    neutral: number
  }
  negativeCandidateCount: number
  negativeCandidateSpend: number
}

export interface AdCleaningTaskPublic {
  taskId: string
  status: AdCleaningTaskStatus
  progress: number
  stage: string
  originalFilename: string
  outputFilename: string | null
  resultFileUrl: string | null
  stats: AdCleaningStats | null
  sheetPreviews: AdCleaningSheetPreview[] | null
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  downloadPath: string | null
}

export interface AdCleaningWorkerInput {
  inputPath: string
  outputPath: string
  originalFilename: string
}

export type AdCleaningWorkerMessage =
  | { type: "progress"; progress: number; stage: string }
  | { type: "success"; stats: AdCleaningStats }
  | { type: "error"; message: string }
