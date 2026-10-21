import { PrismaClient } from "@prisma/client"
import { readFile } from "node:fs/promises"

interface ClassificationInput {
  code: string
  name: string
  sortOrder: number
}

const CODE_PATTERN = /^[A-Z0-9]+(?: [A-Z0-9]+)*$/
const MAX_TEXT_LENGTH = 100
const CREATE_BATCH_SIZE = 1_000
const TRANSACTION_TIMEOUT_MS = 120_000

function parseArgs() {
  const args = process.argv.slice(2)
  const apply = args.includes("--apply")
  const dryRun = args.includes("--dry-run")
  const unsupportedOptions = args.filter(
    arg => arg.startsWith("--") && arg !== "--apply" && arg !== "--dry-run"
  )
  const filePaths = args.filter(arg => !arg.startsWith("--"))

  if (unsupportedOptions.length > 0) {
    throw new Error(`不支持的参数：${unsupportedOptions.join(", ")}`)
  }
  if (apply && dryRun) {
    throw new Error("--apply 和 --dry-run 不能同时使用")
  }
  if (filePaths.length !== 1) {
    throw new Error(
      "用法：npm run import:product-publish-classifications -- <json文件路径> [--apply]"
    )
  }

  return { apply, filePath: filePaths[0] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseClassifications(content: string): ClassificationInput[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content) as unknown
  } catch {
    throw new Error("分类文件不是有效的 JSON")
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("分类文件必须是非空 JSON 数组")
  }

  const seenCodes = new Set<string>()
  return parsed.map((value, index) => {
    const position = index + 1
    if (!isRecord(value)) {
      throw new Error(`第 ${position} 项必须是对象`)
    }

    const code = typeof value.code === "string" ? value.code.trim() : ""
    const name = typeof value.name === "string" ? value.name.trim() : ""
    const sortOrder = value.sortOrder === undefined ? index : value.sortOrder

    if (!CODE_PATTERN.test(code)) {
      throw new Error(`第 ${position} 项 code 无效：只能包含大写字母、数字和单个空格`)
    }
    if (code.length > MAX_TEXT_LENGTH) {
      throw new Error(`第 ${position} 项 code 不能超过 ${MAX_TEXT_LENGTH} 个字符`)
    }
    if (!name) {
      throw new Error(`第 ${position} 项 name 不能为空`)
    }
    if (name.length > MAX_TEXT_LENGTH) {
      throw new Error(`第 ${position} 项 name 不能超过 ${MAX_TEXT_LENGTH} 个字符`)
    }
    if (typeof sortOrder !== "number" || !Number.isSafeInteger(sortOrder) || sortOrder < 0) {
      throw new Error(`第 ${position} 项 sortOrder 必须是大于等于 0 的整数`)
    }
    if (seenCodes.has(code)) {
      throw new Error(`分类 code 重复：${code}`)
    }
    seenCodes.add(code)

    return { code, name, sortOrder }
  })
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

async function main() {
  const { apply, filePath } = parseArgs()
  const classifications = parseClassifications(await readFile(filePath, "utf8"))
  const prisma = new PrismaClient()

  try {
    console.log(`分类校验通过：${classifications.length} 个`)

    if (!apply) {
      const [stores, catalogItems] = await Promise.all([
        prisma.productPublishStore.findMany({
          select: { id: true },
        }),
        prisma.productPublishClassificationCatalog.findMany({
          where: { code: { in: classifications.map(item => item.code) } },
          select: { code: true },
        }),
      ])
      const existingCodes = new Set(catalogItems.map(item => item.code))
      console.log(
        `全局分类目录：计划新增 ${classifications.filter(item => !existingCodes.has(item.code)).length} 个，更新 ${classifications.filter(item => existingCodes.has(item.code)).length} 个`
      )
      console.log(`目标店铺：${stores.length} 个`)
      console.log(`计划补齐或更新店铺分类关系：${stores.length * classifications.length} 条`)
      console.log("DRY-RUN：未写入数据库；确认无误后加 --apply 执行导入。")
      return
    }

    const result = await prisma.$transaction(
      async tx => {
        for (const item of classifications) {
          await tx.productPublishClassificationCatalog.upsert({
            where: { code: item.code },
            create: {
              code: item.code,
              name: item.name,
              sortOrder: item.sortOrder,
              active: true,
            },
            update: {
              name: item.name,
              sortOrder: item.sortOrder,
              active: true,
            },
          })
        }

        const stores = await tx.productPublishStore.findMany({
          select: { id: true },
          orderBy: { id: "asc" },
        })
        const storeIds = stores.map(store => store.id)
        let updatedMappings = 0

        if (storeIds.length > 0) {
          for (const item of classifications) {
            const updated = await tx.productPublishStoreClassification.updateMany({
              where: {
                storeId: { in: storeIds },
                classification: item.code,
              },
              data: {
                classificationName: item.name,
                sortOrder: item.sortOrder,
              },
            })
            updatedMappings += updated.count
          }
        }

        const rows = stores.flatMap(store =>
          classifications.map(item => ({
            storeId: store.id,
            classification: item.code,
            classificationName: item.name,
            sortOrder: item.sortOrder,
          }))
        )
        let createdMappings = 0
        for (const batch of chunk(rows, CREATE_BATCH_SIZE)) {
          const created = await tx.productPublishStoreClassification.createMany({
            data: batch,
            skipDuplicates: true,
          })
          createdMappings += created.count
        }

        return {
          storeCount: stores.length,
          createdMappings,
          updatedMappings,
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS }
    )

    console.log(`全局分类目录已写入：${classifications.length} 个`)
    console.log(`目标店铺：${result.storeCount} 个`)
    console.log(
      `店铺分类关系同步完成：新增 ${result.createdMappings} 条，更新 ${result.updatedMappings} 条。`
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`分类导入失败：${message}`)
  process.exitCode = 1
})
