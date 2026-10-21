/**
 * 存量竞品参考图回填 PoolImage.kind：把 AI 拆图早期入库的竞品图（kind 还是默认 image）刷成 competitor。
 * 识别口径与 ai-split.service 写入口径一致：tags 含「竞品参考」或 sourceLabel = 「AI 拆图上传」。
 * 只升不改：仅更新 kind="image" 的行，已是 competitor（或其他未来取值）的行不碰；可随时重跑。
 * 用法：
 *   npx tsx scripts/backfill-pool-image-kind.ts --dry-run   # 先看影响面
 *   npx tsx scripts/backfill-pool-image-kind.ts             # 正式回填
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const dryRun = process.argv.includes("--dry-run")

// 与 src/image-project/ai-split.service.ts 的 persistSelectedUploads 写入特征保持一致
const WHERE = {
  kind: "image",
  OR: [{ tags: { array_contains: "竞品参考" } }, { sourceLabel: "AI 拆图上传" }],
}

async function main() {
  const count = await prisma.poolImage.count({ where: WHERE })
  console.log(`待回填竞品参考图 ${count} 条${dryRun ? "（dry-run，不写入）" : ""}`)
  if (!dryRun && count > 0) {
    const res = await prisma.poolImage.updateMany({
      where: WHERE,
      data: { kind: "competitor" },
    })
    console.log(`已回填 ${res.count} 条 → kind="competitor"`)
  }
  console.log(dryRun ? "dry-run 完成" : "回填完成")
}

main()
  .catch(e => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
