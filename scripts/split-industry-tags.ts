/**
 * 一次性清理脚本：把 Tag 表里 INDUSTRY 分类下形如 "体育、服饰" / "a,b" 的多值标签
 * 拆成多条单值标签，保留 createdAt，再删除原多值行。
 *
 * 用法：
 *   npx ts-node scripts/split-industry-tags.ts              # DRY-RUN（仅打印计划）
 *   npx ts-node scripts/split-industry-tags.ts --apply      # 真实执行
 */
import { PrismaClient, TagCategory } from "@prisma/client"

const APPLY = process.argv.includes("--apply")

function splitTagName(name: string): string[] {
  return name
    .split(/[、,]/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

async function main() {
  const prisma = new PrismaClient()
  try {
    const multi = await prisma.tag.findMany({
      where: {
        category: TagCategory.INDUSTRY,
        OR: [{ name: { contains: "、" } }, { name: { contains: "," } }],
      },
      orderBy: { id: "asc" },
    })

    if (multi.length === 0) {
      console.log("没有需要拆分的 INDUSTRY 标签，跳过。")
      return
    }

    console.log(`待处理多值 INDUSTRY 标签 ${multi.length} 条：`)
    const plan = multi.map(t => ({ id: t.id, name: t.name, parts: splitTagName(t.name) }))
    for (const p of plan) {
      console.log(`  #${p.id} "${p.name}" → ${JSON.stringify(p.parts)}`)
    }

    if (!APPLY) {
      console.log("\nDRY-RUN：未做任何写入。加 --apply 真实执行。")
      return
    }

    let inserted = 0
    let skipped = 0
    for (const { parts, id } of plan) {
      const createdAt = multi.find(m => m.id === id)!.createdAt
      const result = await prisma.tag.createMany({
        data: parts.map(name => ({ name, category: TagCategory.INDUSTRY, createdAt })),
        skipDuplicates: true,
      })
      inserted += result.count
      skipped += parts.length - result.count
    }

    const deleted = await prisma.tag.deleteMany({ where: { id: { in: multi.map(m => m.id) } } })

    console.log(
      `\n完成：拆出新增 ${inserted} 条，重复跳过 ${skipped} 条，删除原多值行 ${deleted.count} 条。`
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
