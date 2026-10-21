/**
 * 一次性导入脚本：把产品提供的 Excel 提示词集合导入到 ImagePromptTemplate 表。
 *
 * Excel 结构（首行表头）：
 *   A 列 = 一级维度（白底/场景/尺寸/卖点/...）
 *   B 列 = 功能名称（正面/30°/...）
 *   C 列 = 提示词正文
 *
 * 行为：按 (dimension, name) upsert
 *   - 新增：enabled=true，sortOrder 取该维度内 Excel 出现顺序（0,1,2,...）
 *   - 已存在：覆盖 prompt + sortOrder，保留 enabled 当前值（不把 admin 手动关闭的恢复成 true）
 *   - 跳过：任一列为空的行
 *
 * 用法：
 *   npx ts-node scripts/import-prompt-templates.ts <xlsx-path>             # DRY-RUN（仅打印计划，不写库）
 *   npx ts-node scripts/import-prompt-templates.ts <xlsx-path> --apply     # 真实执行
 */
import { PrismaClient } from "@prisma/client"
import path from "node:path"
import * as XLSX from "xlsx"

interface Row {
  dimension: string
  name: string
  prompt: string
}

function parseRows(filePath: string): Row[] {
  const wb = XLSX.readFile(filePath)
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error("Excel 文件没有工作表")
  const ws = wb.Sheets[sheetName]
  // header: 1 → 返回二维数组，自己控制表头解析（更稳：不依赖列名）
  const matrix = XLSX.utils.sheet_to_json<string[]>(ws, {
    header: 1,
    defval: "",
    raw: false,
  })

  const rows: Row[] = []
  // 跳过第一行（表头）
  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i] ?? []
    const dimension = (r[0] ?? "").toString().trim()
    const name = (r[1] ?? "").toString().trim()
    const prompt = (r[2] ?? "").toString().trim()
    if (!dimension || !name || !prompt) continue
    rows.push({ dimension, name, prompt })
  }
  return rows
}

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes("--apply")
  const fileArg = args.find(a => !a.startsWith("--"))
  if (!fileArg) {
    console.error("用法：npx ts-node scripts/import-prompt-templates.ts <xlsx-path> [--apply]")
    process.exit(1)
  }
  const filePath = path.resolve(fileArg)

  const rows = parseRows(filePath)
  console.log(`Excel 解析：${rows.length} 行有效数据`)

  // 维度内 sortOrder 计数
  const sortCounters = new Map<string, number>()
  const plan = rows.map(r => {
    const next = sortCounters.get(r.dimension) ?? 0
    sortCounters.set(r.dimension, next + 1)
    return { ...r, sortOrder: next }
  })

  // 维度分布预览
  const dimStats = new Map<string, number>()
  for (const p of plan) dimStats.set(p.dimension, (dimStats.get(p.dimension) ?? 0) + 1)
  console.log("各维度数量：")
  for (const [dim, cnt] of dimStats) console.log(`  ${dim}: ${cnt}`)

  if (!apply) {
    console.log("\n[DRY-RUN] 未传 --apply，仅展示前 5 条计划：")
    for (const p of plan.slice(0, 5)) {
      console.log(
        `  ${p.dimension} / ${p.name} (sortOrder=${p.sortOrder}) → ${p.prompt.slice(0, 40)}...`
      )
    }
    console.log("\n如确认无误，加 --apply 真实写入。")
    return
  }

  const prisma = new PrismaClient()
  let inserted = 0
  let updated = 0
  try {
    for (const p of plan) {
      const existing = await prisma.imagePromptTemplate.findUnique({
        where: { dimension_name: { dimension: p.dimension, name: p.name } },
        select: { id: true, enabled: true },
      })
      if (existing) {
        await prisma.imagePromptTemplate.update({
          where: { id: existing.id },
          data: { prompt: p.prompt, sortOrder: p.sortOrder },
        })
        updated++
      } else {
        await prisma.imagePromptTemplate.create({
          data: {
            dimension: p.dimension,
            name: p.name,
            prompt: p.prompt,
            sortOrder: p.sortOrder,
            enabled: true,
          },
        })
        inserted++
      }
    }
    console.log(`\n完成。新增 ${inserted} 条，更新 ${updated} 条。`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
