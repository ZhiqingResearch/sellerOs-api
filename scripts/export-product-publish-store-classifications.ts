/**
 * 导出一键上架店铺分类映射。
 *
 * 输出内容严格只有两个字段：externalStoreId、classification。
 * classification 中如果仍有下划线，脚本会直接失败，提醒先执行数据修正脚本，
 * 避免把旧分类码交给 RPA 同事。
 *
 * 用法：
 *   npm run export:product-publish-store-classifications
 *   npm run export:product-publish-store-classifications -- --output ./temp/store-classifications.json
 */
import { PrismaClient } from "@prisma/client"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { PRODUCT_PUBLISH_CLASSIFICATIONS } from "../src/product-publish/product-publish.constants"

const DEFAULT_OUTPUT_PATH = "temp/product-publish-store-classifications.json"
const COLLAPSED_CODES = new Set(
  PRODUCT_PUBLISH_CLASSIFICATIONS.filter(item => item.code.includes(" ")).map(item =>
    item.code.replaceAll(" ", "")
  )
)

function parseOutputPath(): string {
  const args = process.argv.slice(2)
  if (args.length === 0) return resolve(DEFAULT_OUTPUT_PATH)
  if (args.length === 2 && args[0] === "--output" && args[1].trim()) {
    return resolve(args[1])
  }
  throw new Error(
    "用法：npm run export:product-publish-store-classifications -- [--output <JSON文件路径>]"
  )
}

async function main(): Promise<void> {
  const outputPath = parseOutputPath()
  const prisma = new PrismaClient()

  try {
    const rows = await prisma.productPublishStoreClassification.findMany({
      select: {
        classification: true,
        store: { select: { externalStoreId: true } },
      },
      orderBy: [{ storeId: "asc" }, { classification: "asc" }],
    })
    const invalid = rows.filter(
      row => row.classification.includes("_") || COLLAPSED_CODES.has(row.classification)
    )
    if (invalid.length > 0) {
      throw new Error(
        `仍有 ${invalid.length} 条 classification 未转换为空格格式，请先执行 npm run normalize:product-publish-classifications -- --apply`
      )
    }

    const output = rows.map(row => ({
      externalStoreId: row.store.externalStoreId,
      classification: row.classification,
    }))
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8")
    console.log(`已导出 ${output.length} 条店铺分类映射：${outputPath}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`店铺分类 JSON 导出失败：${message}`)
  process.exitCode = 1
})
