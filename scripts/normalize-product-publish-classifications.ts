/**
 * 将一键上架历史分类码中的下划线替换为空格。
 *
 * 项目使用 prisma db push，本脚本专门负责数据修正，不依赖 Prisma migration。
 * 默认只检查并输出变更数量；确认后必须显式传入 --apply 才会写数据库。
 * 脚本幂等，可重复执行；如果同一店铺同时有新旧分类码，会保留并合并模板数据。
 *
 * 用法：
 *   npm run normalize:product-publish-classifications
 *   npm run normalize:product-publish-classifications -- --apply
 *   npm run restore:product-publish-classifications -- --apply
 */
import { Prisma, PrismaClient } from "@prisma/client"
import { PRODUCT_PUBLISH_CLASSIFICATIONS } from "../src/product-publish/product-publish.constants"

const MAPPING_SELECT = {
  id: true,
  storeId: true,
  classification: true,
  classificationName: true,
  sortOrder: true,
  templateUrl: true,
  templateStatus: true,
  templateSyncedAt: true,
  lastSyncError: true,
  rpaTaskUuid: true,
  templateRequestId: true,
} satisfies Prisma.ProductPublishStoreClassificationSelect

type StoreClassification = Prisma.ProductPublishStoreClassificationGetPayload<{
  select: typeof MAPPING_SELECT
}>

const COLLAPSED_CODE_TO_SPACED = new Map<string, string>(
  PRODUCT_PUBLISH_CLASSIFICATIONS.filter(item => item.code.includes(" ")).map(item => [
    item.code.replaceAll(" ", ""),
    item.code,
  ])
)
const SPACED_CODE_TO_ORIGINAL = new Map<string, string>(
  PRODUCT_PUBLISH_CLASSIFICATIONS.map(item => [
    item.code,
    item.templateFilename.replace(/\.xlsm$/i, ""),
  ])
)
const COLLAPSED_CODE_TO_ORIGINAL = new Map<string, string>(
  PRODUCT_PUBLISH_CLASSIFICATIONS.map(item => [
    item.code.replaceAll(" ", ""),
    item.templateFilename.replace(/\.xlsm$/i, ""),
  ])
)

function normalizeCode(code: string): string {
  const spaced = code.replaceAll("_", " ").replace(/\s+/g, " ").trim()
  return COLLAPSED_CODE_TO_SPACED.get(spaced) ?? spaced
}

function restoreCode(code: string): string {
  return SPACED_CODE_TO_ORIGINAL.get(code) ?? COLLAPSED_CODE_TO_ORIGINAL.get(code) ?? code
}

function parseOptions(): { apply: boolean; restore: boolean } {
  const args = process.argv.slice(2)
  const unsupported = args.filter(
    arg => arg !== "--apply" && arg !== "--dry-run" && arg !== "--restore"
  )
  if (unsupported.length > 0) throw new Error(`不支持的参数：${unsupported.join(", ")}`)
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("--apply 和 --dry-run 不能同时使用")
  }
  return { apply: args.includes("--apply"), restore: args.includes("--restore") }
}

function mergedTemplateData(canonical: StoreClassification, legacy: StoreClassification) {
  const useLegacyTemplate = !canonical.templateUrl && Boolean(legacy.templateUrl)
  return {
    classificationName: canonical.classificationName || legacy.classificationName,
    sortOrder: Math.min(canonical.sortOrder, legacy.sortOrder),
    templateUrl: canonical.templateUrl ?? legacy.templateUrl,
    templateStatus: useLegacyTemplate ? legacy.templateStatus : canonical.templateStatus,
    templateSyncedAt: canonical.templateSyncedAt ?? legacy.templateSyncedAt,
    lastSyncError: canonical.lastSyncError ?? legacy.lastSyncError,
    rpaTaskUuid: canonical.rpaTaskUuid ?? legacy.rpaTaskUuid,
    templateRequestId: canonical.templateRequestId ?? legacy.templateRequestId,
  }
}

async function main(): Promise<void> {
  const { apply, restore } = parseOptions()
  const transformCode = restore ? restoreCode : normalizeCode
  const prisma = new PrismaClient()

  try {
    // 不能使用 Prisma `contains: "_"`：MySQL LIKE 会把下划线当成单字符通配符。
    // 必须先读取实际值，再用 JavaScript 做逐字符判断。
    const [allCatalogRows, allStoreRows, allTaskRows, allLogRows] = await Promise.all([
      prisma.productPublishClassificationCatalog.findMany({
        select: { code: true },
      }),
      prisma.productPublishStoreClassification.findMany({
        select: MAPPING_SELECT,
        orderBy: [{ storeId: "asc" }, { id: "asc" }],
      }),
      prisma.productPublishTask.findMany({
        where: { classification: { not: null } },
        select: { classification: true },
      }),
      prisma.productPublishRpaLog.findMany({
        where: { classification: { not: null } },
        select: { classification: true },
      }),
    ])
    const catalogRows = allCatalogRows.filter(row => transformCode(row.code) !== row.code)
    const storeRows = allStoreRows.filter(
      row => transformCode(row.classification) !== row.classification
    )
    const taskRows = allTaskRows.filter(
      row => row.classification && transformCode(row.classification) !== row.classification
    )
    const logRows = allLogRows.filter(
      row => row.classification && transformCode(row.classification) !== row.classification
    )
    const oldCodes = new Set<string>([
      ...catalogRows.map(row => row.code),
      ...storeRows.map(row => row.classification),
      ...taskRows.flatMap(row => (row.classification ? [row.classification] : [])),
      ...logRows.flatMap(row => (row.classification ? [row.classification] : [])),
    ])
    const codeMappings = [...oldCodes]
      .sort()
      .map(oldCode => [oldCode, transformCode(oldCode)] as const)

    console.log(
      `待${restore ? "恢复" : "修正"}：分类目录 ${catalogRows.length} 条，店铺分类 ${storeRows.length} 条，任务 ${taskRows.length} 条，RPA 日志 ${logRows.length} 条。`
    )
    if (!apply) {
      console.log("DRY-RUN：未写入数据库；确认无误后加 --apply 执行。")
      return
    }

    let mergedMappings = 0
    let updatedMappings = 0
    for (const [oldCode, newCode] of codeMappings) {
      const catalogCandidates = await prisma.productPublishClassificationCatalog.findMany({
        select: { id: true, code: true },
      })
      const legacyCatalog = catalogCandidates.find(row => row.code === oldCode)
      const canonicalCatalog = catalogCandidates.find(row => row.code === newCode)
      if (legacyCatalog && canonicalCatalog) {
        await prisma.productPublishClassificationCatalog.delete({ where: { id: legacyCatalog.id } })
      } else if (legacyCatalog) {
        await prisma.productPublishClassificationCatalog.update({
          where: { id: legacyCatalog.id },
          data: { code: newCode },
        })
      }

      const legacyRows = storeRows.filter(row => row.classification === oldCode)
      if (legacyRows.length > 0) {
        const storeCandidates = await prisma.productPublishStoreClassification.findMany({
          where: {
            storeId: { in: legacyRows.map(row => row.storeId) },
          },
          select: MAPPING_SELECT,
        })
        const canonicalRows = storeCandidates.filter(row => row.classification === newCode)
        const canonicalByStoreId = new Map(canonicalRows.map(row => [row.storeId, row]))

        for (const legacy of legacyRows) {
          const canonical = canonicalByStoreId.get(legacy.storeId)
          if (canonical) {
            await prisma.$transaction([
              prisma.productPublishStoreClassification.delete({ where: { id: legacy.id } }),
              prisma.productPublishStoreClassification.update({
                where: { id: canonical.id },
                data: mergedTemplateData(canonical, legacy),
              }),
            ])
            mergedMappings++
          } else {
            await prisma.productPublishStoreClassification.update({
              where: { id: legacy.id },
              data: { classification: newCode },
            })
            updatedMappings++
          }
        }
      }

      await Promise.all([
        prisma.productPublishTask.updateMany({
          where: { classification: oldCode },
          data: { classification: newCode },
        }),
        prisma.productPublishRpaLog.updateMany({
          where: { classification: oldCode },
          data: { classification: newCode },
        }),
      ])
    }

    const targetClassifications = PRODUCT_PUBLISH_CLASSIFICATIONS.map(classification => ({
      ...classification,
      code: transformCode(classification.code),
    }))
    const restoredCatalog = await prisma.productPublishClassificationCatalog.createMany({
      data: targetClassifications.map((classification, sortOrder) => ({
        code: classification.code,
        name: classification.name,
        sortOrder,
      })),
      skipDuplicates: true,
    })
    const stores = await prisma.productPublishStore.findMany({ select: { id: true } })
    const restoredMappings = await prisma.productPublishStoreClassification.createMany({
      data: stores.flatMap(store =>
        targetClassifications.map((classification, sortOrder) => ({
          storeId: store.id,
          classification: classification.code,
          classificationName: classification.name,
          sortOrder,
        }))
      ),
      skipDuplicates: true,
    })

    console.log(
      `分类码${restore ? "恢复" : "修正"}完成：直接更新店铺分类 ${updatedMappings} 条，合并重复店铺分类 ${mergedMappings} 条，补回分类目录 ${restoredCatalog.count} 条、店铺分类 ${restoredMappings.count} 条。`
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`分类码处理失败：${message}`)
  process.exitCode = 1
})
