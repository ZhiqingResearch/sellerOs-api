import { mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

export const AD_CLEANING_MAX_FILE_SIZE = 50 * 1024 * 1024
export const AD_CLEANING_MAX_COLUMNS = 200
export const AD_CLEANING_MAX_CELL_LENGTH = 32_767
export const AD_CLEANING_MAX_QUEUED_TASKS = 10
export const AD_CLEANING_WORKER_TIMEOUT_MS = 10 * 60 * 1000
// 本地临时文件兜底清理时间；不是任务或 Sheet 预览缓存时间。
export const AD_CLEANING_TEMP_FILE_TTL_MS = 2 * 60 * 60 * 1000
export const AD_CLEANING_RULE_VERSION = "1.0"

export const AD_CLEANING_TEMP_DIR = join(tmpdir(), "ai-sourcing-ad-cleaning")
mkdirSync(AD_CLEANING_TEMP_DIR, { recursive: true })

export const AD_CLEANING_XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
