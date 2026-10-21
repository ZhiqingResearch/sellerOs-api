/**
 * 敏感词初始数据导入脚本
 *
 * 数据来源：scripts/data/ 下的 Excel 文件
 *   - 亚马逊敏感词集合_Amazon_US.xlsx → platform = "amazon"
 *   - 沃尔玛敏感词集合_Walmart_US.xlsx → platform = "walmart"
 *
 * Excel 结构（前 3 行为标题/说明/表头，第 4 行起为数据）：
 *   敏感词 (Sensitive Word) | 分类 (Category) | 风险等级 (Risk Level) | 建议代替 (Suggested Replacement)
 *
 * 落库规则：
 *   - source = AI_DETECTION（固定）
 *   - userId = null（初始数据无创建人；DB schema 已允许 userId 可空）
 *   - category 用中文全角分号「；」/英文半角分号「;」拆分成 string[] 数组
 *   - 风险等级：高 → HIGH，中 → MEDIUM，低 → LOW
 *   - 使用 createMany + skipDuplicates，已存在的 (platform, word) 自动跳过
 *   - 单文件内部如有 word 重复，保留首次出现的那条
 *
 * 用法：
 *   npx ts-node scripts/import-sensitive-words.ts
 *   # 或先 dry-run 看解析结果，不写库：
 *   npx ts-node scripts/import-sensitive-words.ts --dry-run
 *
 * 幂等性：重复执行不会产生重复数据（skipDuplicates 兜底）。
 */

import { PrismaClient, SensitiveWordRiskLevel, SensitiveWordSource } from "@prisma/client"
import * as path from "path"
import * as xlsx from "xlsx"

const prisma = new PrismaClient()

const DRY_RUN = process.argv.includes("--dry-run")

const FILES: Array<{ relPath: string; platform: string }> = [
  { relPath: "scripts/data/亚马逊敏感词集合_Amazon_US.xlsx", platform: "amazon" },
  { relPath: "scripts/data/沃尔玛敏感词集合_Walmart_US.xlsx", platform: "walmart" },
]

const RISK_MAP: Record<string, SensitiveWordRiskLevel> = {
  高: SensitiveWordRiskLevel.HIGH,
  中: SensitiveWordRiskLevel.MEDIUM,
  低: SensitiveWordRiskLevel.LOW,
}

const HEADER_ROW_COUNT = 3 // 前 3 行：标题 / 说明 / 表头

interface ParsedRecord {
  word: string
  platform: string
  category: string[]
  riskLevel: SensitiveWordRiskLevel
  suggestion: string | null
  source: SensitiveWordSource
  userId: null
}

function parseFile(absPath: string, platform: string): ParsedRecord[] {
  const wb = xlsx.readFile(absPath)
  const sheetName = wb.SheetNames[0]
  if (!sheetName) {
    console.warn(`  [WARN] no sheet in ${absPath}`)
    return []
  }
  const sheet = wb.Sheets[sheetName]
  const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false })

  const records: ParsedRecord[] = []
  const wordSeen = new Set<string>()
  let skippedNoWord = 0
  let skippedBadRisk = 0
  let skippedNoCategory = 0
  let dedupedInternal = 0

  for (let i = HEADER_ROW_COUNT; i < rows.length; i++) {
    const row = rows[i] ?? []
    const [wordRaw, categoryRaw, riskRaw, suggestionRaw] = row as [
      unknown,
      unknown,
      unknown,
      unknown,
    ]

    const word = typeof wordRaw === "string" ? wordRaw.trim() : ""
    if (!word) {
      skippedNoWord++
      continue
    }
    if (wordSeen.has(word)) {
      dedupedInternal++
      continue
    }

    const categoryStr = typeof categoryRaw === "string" ? categoryRaw : ""
    const category = categoryStr
      .split(/[；;]/)
      .map(s => s.trim())
      .filter(Boolean)
    if (category.length === 0) {
      console.warn(`  [WARN] row ${i + 1} "${word}": empty category, skip`)
      skippedNoCategory++
      continue
    }

    const riskKey = typeof riskRaw === "string" ? riskRaw.trim() : ""
    const riskLevel = RISK_MAP[riskKey]
    if (!riskLevel) {
      console.warn(`  [WARN] row ${i + 1} "${word}": unknown risk "${riskKey}", skip`)
      skippedBadRisk++
      continue
    }

    const suggestion = typeof suggestionRaw === "string" ? suggestionRaw.trim() || null : null

    wordSeen.add(word)
    records.push({
      word,
      platform,
      category,
      riskLevel,
      suggestion,
      source: SensitiveWordSource.AI_DETECTION,
      userId: null,
    })
  }

  console.log(
    `  parsed: ${records.length} | skipped: no-word=${skippedNoWord} bad-risk=${skippedBadRisk} no-category=${skippedNoCategory} dedup-internal=${dedupedInternal}`
  )
  return records
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY-RUN (no DB writes)" : "LIVE (will write to DB)"}`)
  console.log()

  let grandTotal = 0
  let grandInserted = 0
  let grandSkipped = 0

  for (const { relPath, platform } of FILES) {
    const absPath = path.resolve(process.cwd(), relPath)
    console.log(`=== ${platform} ← ${relPath} ===`)

    const records = parseFile(absPath, platform)
    if (records.length === 0) {
      console.log("  no records, skip")
      continue
    }

    if (DRY_RUN) {
      console.log(`  [dry-run] would insert up to ${records.length} rows`)
      console.log(`  sample (first 3):`)
      records.slice(0, 3).forEach(r => {
        console.log(
          `    word="${r.word}" category=${JSON.stringify(r.category)} risk=${r.riskLevel} suggestion=${r.suggestion ? `"${r.suggestion.slice(0, 40)}..."` : "null"}`
        )
      })
      grandTotal += records.length
      continue
    }

    const result = await prisma.sensitiveWord.createMany({
      data: records,
      skipDuplicates: true, // (platform, word) 唯一约束撞了直接跳过
    })
    const inserted = result.count
    const skippedDup = records.length - inserted
    console.log(`  inserted: ${inserted} | skipped (already exists): ${skippedDup}`)

    grandTotal += records.length
    grandInserted += inserted
    grandSkipped += skippedDup
  }

  console.log()
  console.log("=== Summary ===")
  if (DRY_RUN) {
    console.log(`Total parsed: ${grandTotal}`)
    console.log(`Re-run without --dry-run to write to DB.`)
  } else {
    console.log(`Total parsed:   ${grandTotal}`)
    console.log(`Inserted:       ${grandInserted}`)
    console.log(`Skipped (dup):  ${grandSkipped}`)
  }
}

main()
  .catch(e => {
    console.error("Import failed:", e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
