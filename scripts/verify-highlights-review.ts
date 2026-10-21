import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { compareConfigurations } from "./asin-audit/highlights-review"
import { hashValue, parseCsv } from "./asin-audit/listing-audit"

const outDir = resolve("scripts/data/asin-highlights-review")
const stateDir = join(outDir, ".state")
const listingDir = resolve("scripts/data/asin-audit-sample-final")
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))
const manifest = readJson(join(stateDir, "manifest.json"))
const sourceRows = parseCsv(readFileSync(manifest.inputPath, "utf8"))
const outputRows = parseCsv(readFileSync(join(outDir, "results.csv"), "utf8"))
const headers = sourceRows.shift()!
assert.deepEqual(outputRows.shift(), headers)
assert.equal(outputRows.length, sourceRows.length)
const allowedColumns = ["标题", "商品亮点", "审查结果", "备注"].map(name => headers.indexOf(name))
const tasksByRow = new Map<number, any>()
const successfulTasks: any[] = []
const missingTasks: string[] = []
const failedTasks: string[] = []
const unresolvedTasks: string[] = []
let modifiedCells = 0
let preservedSnapshots = 0
let verifiedCoreFiles = 0
for (const task of manifest.tasks) {
  for (const index of task.rowIndexes) tasksByRow.set(index, task)
  const checkPath = join(stateDir, "checks", `${task.key}.json`)
  if (!existsSync(checkPath)) {
    missingTasks.push(task.key)
    continue
  }
  const check = readJson(checkPath)
  if (check.status === "失败") {
    failedTasks.push(task.key)
    continue
  }
  if (check.status === "无法判断") unresolvedTasks.push(task.key)
  const auditPath = join(listingDir, ".state", "snapshots", `${task.key}-audit.json`)
  const snapshot = readJson(
    existsSync(auditPath)
      ? auditPath
      : join(listingDir, ".state", "snapshots", `${task.key}-highlights.json`)
  )
  assert.equal(hashValue(snapshot.highlights), check.highlightsHash)
  const { title, second_title: secondTitle } = snapshot.highlights.response.data
  const expected = compareConfigurations(title, secondTitle, task.configurations)
  assert.equal(check.status, expected.status)
  assert.equal(check.note, expected.note)
  assert.deepEqual(check.evidence, expected.evidence)
  if (title.trim()) assert.equal(snapshot.listing.title, title.trim())
  assert.equal(snapshot.listing.second_title, secondTitle.trim())
  assert.deepEqual(snapshot.listing.bullets, snapshot.originalAuditSnapshot.listing.bullets)
  assert.deepEqual(snapshot.listing.description, snapshot.originalAuditSnapshot.listing.description)
  assert.deepEqual(snapshot.raw, snapshot.originalAuditSnapshot.raw)
  assert.deepEqual(snapshot.isSoldOut, snapshot.originalAuditSnapshot.isSoldOut)
  const oldCheckPath = join(listingDir, ".state", "checks", `${task.key}.json`)
  if (existsSync(oldCheckPath)) {
    const oldCheck = readJson(oldCheckPath)
    if (oldCheck.snapshotHash)
      assert.equal(
        hashValue(snapshot.originalAuditSnapshot),
        oldCheck.snapshotHash,
        `${task.key} 旧审计证据发生变更`
      )
  }
  preservedSnapshots++
  const corePath = join(listingDir, "core", `${task.key}.json`)
  if (existsSync(corePath)) {
    const core = readJson(corePath)
    assert.deepEqual(core.raw, core.originalAuditSnapshot.raw)
    assert.equal(
      core.currentListing.title,
      title.trim() || core.originalAuditSnapshot.currentListing.title
    )
    assert.equal(core.currentListing.second_title, secondTitle.trim())
    const {
      title: oldTitle,
      second_title: oldSecondTitle,
      ...oldFields
    } = core.originalAuditSnapshot.currentListing
    const { title: newTitle, second_title: newSecondTitle, ...newFields } = core.currentListing
    assert.deepEqual(newFields, oldFields)
    verifiedCoreFiles++
  }
  successfulTasks.push({ task, check, title, secondTitle })
}
const checksByKey = new Map(successfulTasks.map(item => [item.task.key, item]))
for (let index = 0; index < sourceRows.length; index++) {
  assert.equal(outputRows[index].length, headers.length)
  const task = tasksByRow.get(index)
  const result = task && checksByKey.get(task.key)
  for (let column = 0; column < headers.length; column++) {
    if (!result || !allowedColumns.includes(column))
      assert.equal(
        outputRows[index][column],
        sourceRows[index][column],
        `第${index + 2}行 ${headers[column]} 意外变化`
      )
    else {
      const protectText = (value: string) => (/^[\s]*[=+@-]/.test(value) ? "'" + value : value)
      const values: Record<string, string> = {
        标题: result.title.trim() ? protectText(result.title.trim()) : sourceRows[index][column],
        商品亮点: protectText(result.secondTitle.trim()),
        审查结果: result.check.status,
        备注: result.check.note,
      }
      assert.equal(outputRows[index][column], values[headers[column]])
    }
    if (outputRows[index][column] !== sourceRows[index][column]) modifiedCells++
  }
}
const report = {
  verifiedAt: new Date().toISOString(),
  sourceRows: sourceRows.length,
  targetTasks: manifest.tasks.length,
  processed: successfulTasks.length + failedTasks.length,
  successful: successfulTasks.length,
  missingTasks,
  failedTasks,
  unresolvedTasks,
  modifiedCells,
  preservedSnapshots,
  verifiedCoreFiles,
  allFieldsVerified: true,
  readyForFinalReview:
    missingTasks.length === 0 && failedTasks.length === 0 && unresolvedTasks.length === 0,
}
writeFileSync(join(stateDir, "verification.json"), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
