/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
// 来源枚举仅由内部成功节点选择；异构 Prisma 委托动态派发，SQL 强制限制实体范围。
import { Prisma, PrismaClient } from "@prisma/client"
import "dotenv/config"
import {
  GENERATION_SOURCES,
  GenerationSource,
  projectGenerationSource,
  syncGenerationSource,
} from "../src/generation-record/generation-record-sync"
import {
  GENERATION_FUNCTION_LABELS,
  GenerationFunction,
} from "../src/usage/dto/query-generation-records.dto"

export function parseGenerationBackfillArgs(args: string[], now = new Date()) {
  const values: Record<string, string> = {}
  let apply = false,
    dryRun = false
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (name === "--apply") apply = true
    else if (name === "--dry-run") dryRun = true
    else if (["--function", "--from", "--to", "--batch-size", "--cursor"].includes(name)) {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数`)
      values[name] = value
    } else throw new Error(`未知参数：${name}`)
  }
  if (apply && dryRun) throw new Error("--apply 与 --dry-run 不可同时使用")
  const fn = values["--function"] as GenerationFunction | undefined
  if (fn && !Object.prototype.hasOwnProperty.call(GENERATION_FUNCTION_LABELS, fn))
    throw new Error("功能标识无效")
  const from = values["--from"]
    ? new Date(values["--from"])
    : new Date(now.getTime() - 14 * 86400000)
  const to = values["--to"] ? new Date(values["--to"]) : now
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to)
    throw new Error("时间范围无效")
  const batchSize = Number(values["--batch-size"] ?? 100)
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("批次须为 1–1000 的整数")
  const rawCursor = values["--cursor"]
  const separator = rawCursor?.indexOf(":") ?? -1
  const cursor = rawCursor
    ? {
        source: rawCursor.slice(0, separator) as GenerationSource,
        id: rawCursor.slice(separator + 1),
      }
    : null
  if (
    cursor &&
    (separator < 1 ||
      !Object.prototype.hasOwnProperty.call(GENERATION_SOURCES, cursor.source) ||
      !cursor.id)
  )
    throw new Error("断点格式为 source:id")
  if (
    cursor &&
    [
      "generationTask",
      "videoTask",
      "storyboardVideo",
      "beautyTask",
      "rpaCreationTask",
      "inspirationSubscription",
      "history",
      "businessAiRun",
      "categoryAnalysisRecord",
    ].includes(cursor.source) &&
    (!/^[1-9]\d*$/.test(cursor.id) || !Number.isSafeInteger(Number(cursor.id)))
  )
    throw new Error("数字断点必须是正安全整数")
  return { apply, fn, from, to, batchSize, cursor }
}

export function generationBackfillWhere(
  source: GenerationSource,
  options: ReturnType<typeof parseGenerationBackfillArgs>
) {
  const range = { gte: options.from, lte: options.to }
  const time =
    source === "inspirationSubscription"
      ? { lastRefreshedAt: range }
      : source === "chetaidouTask"
        ? { OR: [{ createdAt: range }, { finishedAt: range }] }
        : source === "rpaCreationTask"
          ? { OR: [{ createdAt: range }, { completedAt: range }] }
          : source === "history"
            ? {
                OR: [
                  { createdAt: range },
                  {
                    listingRun: {
                      generations: { some: { updatedAt: range, status: "COMPLETED" } },
                    },
                  },
                ],
              }
            : source === "asinAuditRecord"
              ? {
                  OR: [
                    { createdAt: range },
                    { optimizationRevisions: { some: { createdAt: range } } },
                  ],
                }
              : { createdAt: range }
  const scope =
    source === "history"
      ? { type: { in: options.fn ? [options.fn] : ["LISTING_GENERATION", "LISTING_SCORING"] } }
      : source === "chetaidouTask"
        ? { OR: [{ createdAt: range }, { finishedAt: range }] }
        : source === "rpaCreationTask"
          ? { mediaType: options.fn ?? { in: ["IMAGE", "VIDEO"] } }
          : source === "businessAiRun"
            ? {
                module: {
                  in:
                    options.fn === "LISTING_SCORING"
                      ? ["listing-score"]
                      : options.fn === "COMPETITOR_ANALYSIS"
                        ? ["competitor-analysis"]
                        : ["listing-score", "competitor-analysis"],
                },
              }
            : {}
  return { ...time, ...scope }
}

const NUMERIC_IDS = new Set<GenerationSource>([
  "generationTask",
  "videoTask",
  "storyboardVideo",
  "beautyTask",
  "rpaCreationTask",
  "inspirationSubscription",
  "history",
  "businessAiRun",
  "categoryAnalysisRecord",
])

export async function backfillGenerationRecords(
  prisma: PrismaClient,
  options: ReturnType<typeof parseGenerationBackfillArgs>,
  report: (value: unknown) => void = console.log
) {
  const totals = { scanned: 0, successful: 0, written: 0, unknownCredits: 0, knownCredits: "0" }
  const outcomes = new Map<string, { credits: string | null }>()
  let resume = !options.cursor
  for (const source of Object.keys(GENERATION_SOURCES) as GenerationSource[]) {
    if (!resume && source === options.cursor!.source) resume = true
    if (!resume) continue
    if (
      options.fn &&
      GENERATION_SOURCES[source] !== options.fn &&
      !(source === "history" && ["LISTING_GENERATION", "LISTING_SCORING"].includes(options.fn)) &&
      !(
        source === "businessAiRun" &&
        ["LISTING_SCORING", "COMPETITOR_ANALYSIS"].includes(options.fn)
      ) &&
      !(source === "rpaCreationTask" && ["IMAGE", "VIDEO"].includes(options.fn))
    )
      continue
    let after: number | string | undefined =
      options.cursor?.source === source
        ? NUMERIC_IDS.has(source)
          ? Number(options.cursor.id)
          : options.cursor.id
        : undefined
    for (;;) {
      const rows = await (prisma as any)[source].findMany({
        where: {
          ...generationBackfillWhere(source, options),
          ...(after != null ? { id: { gt: after } } : {}),
        },
        orderBy: { id: "asc" },
        take: options.batchSize,
      })
      if (!rows.length) break
      for (const root of rows) {
        totals.scanned++
        const projected = (await projectGenerationSource(prisma, source, root)).filter(
          row => row.createdAt >= options.from && row.createdAt <= options.to
        )
        if (options.apply) {
          const result = await prisma.$transaction(
            tx => syncGenerationSource(tx, source, root.id, { from: options.from, to: options.to }),
            { timeout: 30000 }
          )
          for (const row of result.snapshots) outcomes.set(row.key, { credits: row.credits })
          totals.written += result.written
          totals.successful += result.written
          totals.unknownCredits += result.unknownCredits
        } else {
          // 不调用 writer/upsert/同步函数；只读来源映射。不会生成或收费。
          for (const row of projected) outcomes.set(row.key, { credits: row.credits })
          totals.successful += projected.length
          totals.unknownCredits += projected.filter(row => row.credits == null).length
        }
      }
      after = rows[rows.length - 1].id
      totals.knownCredits = [...outcomes.values()]
        .reduce((sum, row) => sum.plus(row.credits ?? 0), new Prisma.Decimal(0))
        .toString()
      report({
        mode: options.apply ? "apply" : "dry-run",
        source,
        cursor: `${source}:${after}`,
        ...totals,
      })
    }
  }
  // successful/written 是投影尝试数；distinctResults 与金额按事件 key 去重。
  totals.unknownCredits = [...outcomes.values()].filter(row => row.credits == null).length
  report({
    complete: true,
    distinctResults: outcomes.size,
    mode: options.apply ? "apply" : "dry-run",
    ...totals,
  })
  return totals
}

if (require.main === module) {
  const options = parseGenerationBackfillArgs(process.argv.slice(2))
  const prisma = new PrismaClient()
  backfillGenerationRecords(prisma, options)
    .catch(error => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
