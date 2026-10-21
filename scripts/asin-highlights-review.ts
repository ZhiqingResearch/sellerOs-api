import axios from "axios"
import { config as loadEnv } from "dotenv"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  compareConfigurations,
  mergeHighlightsListing,
  parseCorrectConfigurations,
  ProductConfiguration,
} from "./asin-audit/highlights-review"
import { COUNTRY_DOMAINS, encodeCsv, hashValue, parseCsv } from "./asin-audit/listing-audit"

function writeJson(path: string, value: unknown) {
  writeText(path, JSON.stringify(value, null, 2))
}
function writeText(path: string, text: string) {
  writeFileSync(path + ".tmp", text, "utf8")
  renameSync(path + ".tmp", path)
}
function readJson(path: string): any {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) : null
}
// 源表的运营 @姓名等原值原样保留；公式防护只作用于新抓取的文本。
function encodeMappedCsv(rows: string[][]) {
  return (
    "\uFEFF" +
    rows
      .map(row => row.map(value => '"' + value.replace(/"/g, '""') + '"').join(","))
      .join("\r\n") +
    "\r\n"
  )
}
function protectNewCell(value: string) {
  return /^[\s]*[=+@-]/.test(value) ? "'" + value : value
}
const delay = (milliseconds: number) =>
  new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))

async function main() {
  const { values: args } = parseArgs({
    options: {
      mode: { type: "string", default: "plan" },
      limit: { type: "string" },
      "retry-failed": { type: "boolean", default: false },
    },
  })
  if (!["plan", "run", "export", "recompare"].includes(args.mode!))
    throw new Error("mode 必须为 plan/run/export/recompare")
  const inputPath = resolve("scripts/data/链接审查_配置审查 (1).csv")
  const listingDir = resolve("scripts/data/asin-audit-sample-final")
  const outDir = resolve("scripts/data/asin-highlights-review")
  const stateDir = join(outDir, ".state")
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(join(stateDir, "checks"), { recursive: true })
  const inputText = readFileSync(inputPath, "utf8")
  const rows = parseCsv(inputText)
  const headers = rows.shift()!
  const column = (name: string) => {
    const index = headers.indexOf(name)
    if (index < 0) throw new Error(`缺少字段 ${name}`)
    return index
  }
  const columns = Object.fromEntries(
    ["编号", "店铺", "ASIN", "MSKU", "标题", "商品亮点", "审查结果", "备注"].map(name => [
      name,
      column(name),
    ])
  )
  if (rows.some(row => row.length !== headers.length)) throw new Error("输入行列数不一致")
  const groups = new Map<
    string,
    {
      key: string
      asin: string
      country: string
      url: string
      rowIndexes: number[]
      configurations: ProductConfiguration[]
    }
  >()
  rows.forEach((row, index) => {
    if (row[columns["审查结果"]] !== "不匹配" || !row[columns["备注"]].includes("未识别")) return
    const country = row[columns["店铺"]].match(/(?:^|-)(US|MX)(?:-|$)/)?.[1]
    const asin = row[columns.ASIN].trim().toUpperCase()
    if (!country || !/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`第 ${index + 2} 行站点/ASIN无效`)
    const key = `${country}-${asin}`
    const group = groups.get(key) ?? {
      key,
      asin,
      country,
      url: `https://${COUNTRY_DOMAINS[country]}/dp/${asin}`,
      rowIndexes: [],
      configurations: [],
    }
    group.rowIndexes.push(index)
    group.configurations.push(...parseCorrectConfigurations(row[columns["备注"]]))
    groups.set(key, group)
  })
  const tasks = [...groups.values()].map(task => ({
    ...task,
    configurations: [...new Map(task.configurations.map(item => [hashValue(item), item])).values()],
  }))
  const fingerprint = hashValue({ inputText, version: 1 })
  const previousManifest = readJson(join(stateDir, "manifest.json"))
  if (previousManifest && previousManifest.fingerprint !== fingerprint)
    throw new Error("输入文件已变更，请先核对，禁止覆盖已有任务")
  writeJson(join(stateDir, "manifest.json"), {
    fingerprint,
    inputPath,
    sourceRows: rows.length,
    selectedRows: tasks.reduce((count, task) => count + task.rowIndexes.length, 0),
    tasks,
  })
  const statePath = join(stateDir, "runtime.json")
  const lockPath = join(stateDir, "run.lock")
  const stopPath = join(stateDir, "pause.requested")
  const snapshotPath = (key: string) => {
    const auditPath = join(listingDir, ".state", "snapshots", `${key}-audit.json`)
    return existsSync(auditPath)
      ? auditPath
      : join(listingDir, ".state", "snapshots", `${key}-highlights.json`)
  }
  const getHighlights = (key: string) => readJson(snapshotPath(key))?.highlights
  const getCheck = (key: string) => readJson(join(stateDir, "checks", `${key}.json`))
  const summarize = (state: string, extra: object = {}) => {
    const checks = tasks.map(task => getCheck(task.key)).filter(Boolean)
    const counts = Object.fromEntries(
      ["匹配", "不匹配", "无法判断", "失败"].map(status => [
        status,
        checks.filter(check => check.status === status).length,
      ])
    )
    const runtime = {
      state,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      total: tasks.length,
      processed: checks.length,
      remaining: tasks.length - checks.length,
      fetched: tasks.filter(task => getHighlights(task.key)?.endpoint === "highlights").length,
      counts,
      ...extra,
    }
    writeJson(statePath, runtime)
    return runtime
  }
  const exportResults = () => {
    const processedRows: unknown[][] = [
      ["站点", "ASIN", "原行数", "处理状态", "审查结果", "备注", "标题", "商品亮点", "抓取时间"],
    ]
    const outputRows = rows.map(row => [...row])
    for (const task of tasks) {
      const check = getCheck(task.key)
      if (!check) continue
      const highlights = getHighlights(task.key)
      processedRows.push([
        task.country,
        task.asin,
        task.rowIndexes.length,
        check.status === "失败" ? "失败" : "已处理",
        check.status === "失败" ? "" : check.status,
        check.note ?? check.error,
        highlights?.response.data.title ?? "",
        highlights?.response.data.second_title ?? "",
        highlights?.fetchedAt ?? "",
      ])
      if (check.status === "失败") continue
      for (const index of task.rowIndexes) {
        if (highlights.response.data.title.trim())
          outputRows[index][columns["标题"]] = protectNewCell(highlights.response.data.title.trim())
        outputRows[index][columns["商品亮点"]] = protectNewCell(
          highlights.response.data.second_title.trim()
        )
        outputRows[index][columns["审查结果"]] = check.status
        outputRows[index][columns["备注"]] = check.note
      }
    }
    writeText(join(outDir, "current-results.csv"), encodeCsv(processedRows))
    writeText(join(outDir, "results.csv"), encodeMappedCsv([headers, ...outputRows]))
  }
  if (args.mode === "plan") {
    console.log(
      JSON.stringify({
        sourceRows: rows.length,
        taskCount: tasks.length,
        selectedRows: tasks.reduce((sum, task) => sum + task.rowIndexes.length, 0),
      })
    )
    return
  }
  if (args.mode === "export") {
    if (existsSync(lockPath)) throw new Error("任务运行中，由工作进程实时导出，请勿同时导出")
    exportResults()
    console.log(JSON.stringify(summarize("exported")))
    return
  }
  if (existsSync(join(listingDir, "run.lock")))
    throw new Error("原爬虫审计仍有运行锁，禁止同时调用爬虫")
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    { flag: "wx" }
  )
  loadEnv({ quiet: true })
  let isStopping = false
  const shouldStop = () => isStopping || existsSync(stopPath)
  process.on("SIGINT", () => {
    isStopping = true
  })
  process.on("SIGTERM", () => {
    isStopping = true
  })
  const waitRetry = async (milliseconds: number) => {
    for (let elapsed = 0; elapsed < milliseconds && !shouldStop(); elapsed += 1000)
      await delay(Math.min(1000, milliseconds - elapsed))
  }
  try {
    const limit = args.limit === undefined ? tasks.length : Number(args.limit)
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit 必须为正整数")
    const selected = tasks
      .filter(task =>
        args.mode === "recompare"
          ? Boolean(getHighlights(task.key))
          : !getCheck(task.key) || (args["retry-failed"] && getCheck(task.key).status === "失败")
      )
      .slice(0, limit)
    let reviewedCount = 0
    for (const task of selected) {
      if (shouldStop()) break
      if (args.mode !== "recompare" || reviewedCount % 50 === 0)
        summarize("processing", { currentAsin: task.asin, reviewedCount })
      try {
        let highlights = getHighlights(task.key)
        if (args.mode === "recompare" && !highlights)
          throw new Error("离线重算缺少亮点缓存，禁止调用爬虫")
        if (!highlights) {
          const probe = readJson(resolve("temp/highlights-config-review/probe.json"))
          // 本轮已实际抓取过的首条样本直接复用，不重复占用爬虫。
          if (task.key === "US-B0H7GYZ8Y6" && probe?.response?.code === 200)
            highlights = { ...probe, endpoint: "highlights", taskKey: task.key, url: task.url }
        }
        if (!highlights) {
          let attempt = 0
          for (;;) {
            if (shouldStop()) throw new Error("已请求暂停")
            attempt++
            try {
              const startedAt = Date.now()
              const response = await axios.post(
                "http://47.108.114.243:6666/highlights",
                { url: task.url },
                {
                  timeout: 60000,
                  headers: { Authorization: `Bearer ${process.env.CRAWLER_API_TOKEN || ""}` },
                }
              )
              highlights = {
                endpoint: "highlights",
                taskKey: task.key,
                url: task.url,
                fetchedAt: new Date().toISOString(),
                fetchMs: Date.now() - startedAt,
                response: response.data,
              }
              break
            } catch (error) {
              const status = axios.isAxiosError(error) ? error.response?.status : undefined
              const isBusy =
                status === 429 ||
                (status === 502 &&
                  /busy|处理中|正在处理/i.test(JSON.stringify((error as any).response?.data)))
              const isOffline = axios.isAxiosError(error) && !error.response
              if (
                [400, 401, 403, 404].includes(status ?? 0) ||
                (!isBusy && !isOffline && attempt >= 3)
              )
                throw new Error(`爬虫 HTTP ${status ?? "网络异常"}：${(error as Error).message}`)
              const retryDelayMs = Math.min(300000, 30000 * 2 ** Math.min(attempt - 1, 4))
              summarize("waiting_for_crawler", {
                currentAsin: task.asin,
                attempt,
                error: `HTTP ${status ?? "网络异常"}`,
                retryAt: new Date(Date.now() + retryDelayMs).toISOString(),
              })
              await waitRetry(retryDelayMs)
            }
          }
        }
        const data = highlights?.response?.data
        if (
          highlights?.response?.code !== 200 ||
          typeof data?.title !== "string" ||
          typeof data?.second_title !== "string" ||
          (!data.title.trim() && !data.second_title.trim())
        )
          throw new Error("highlights 返回缺少有效标题/亮点")
        if (
          (data.asin || data.productId) &&
          String(data.asin ?? data.productId).toUpperCase() !== task.asin
        )
          throw new Error("返回 ASIN 不一致")
        const originalPath = snapshotPath(task.key)
        const existing = readJson(originalPath) ?? {
          taskKey: task.key,
          endpoint: "highlights",
          url: task.url,
          listing: { title: "", bullets: [], description: "" },
          isSoldOut: null,
        }
        if (args.mode !== "recompare")
          writeJson(originalPath, mergeHighlightsListing(existing, highlights))
        const corePath = join(listingDir, "core", `${task.key}.json`)
        if (args.mode !== "recompare" && existsSync(corePath))
          writeJson(corePath, mergeHighlightsListing(readJson(corePath), highlights))
        const comparison = compareConfigurations(data.title, data.second_title, task.configurations)
        writeJson(join(stateDir, "checks", `${task.key}.json`), {
          taskKey: task.key,
          ...comparison,
          checkedAt: new Date().toISOString(),
          highlightsHash: hashValue(highlights),
          inputFingerprint: fingerprint,
        })
        console.log(`${task.key} ${comparison.status} ${data.second_title}`)
      } catch (error) {
        if (shouldStop()) break
        writeJson(join(stateDir, "checks", `${task.key}.json`), {
          taskKey: task.key,
          status: "失败",
          error: (error as Error).message,
          checkedAt: new Date().toISOString(),
        })
        console.log(`${task.key} 失败：${(error as Error).message}`)
      }
      reviewedCount++
      if (args.mode !== "recompare") {
        exportResults()
        summarize("processing")
      }
    }
    exportResults()
    console.log(
      JSON.stringify(
        summarize(
          shouldStop()
            ? "paused"
            : tasks.every(task => getCheck(task.key))
              ? "completed"
              : "sample_completed"
        )
      )
    )
  } finally {
    if (readJson(lockPath)?.pid === process.pid) unlinkSync(lockPath)
  }
}
if (require.main === module)
  main().catch(error => {
    console.error((error as Error).message)
    process.exitCode = 1
  })
