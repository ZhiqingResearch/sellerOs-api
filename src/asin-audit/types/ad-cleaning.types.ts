export type AdCleaningTaskStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED"

export type AdCleaningPreviewCell = string | number | boolean | null

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

export interface AdCleaningTask {
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

export interface AdCleaningEvidence {
  taskId: string
  originalFilename: string
  outputFilename: string | null
  resultFileUrl?: string | null
  downloadPath?: string | null
  stats: AdCleaningStats
  sheetPreviews: AdCleaningSheetPreview[]
}
