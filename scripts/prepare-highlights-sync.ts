import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { hashValue, parseCsv } from "./asin-audit/listing-audit"

const outputDir = resolve("scripts/data/asin-highlights-review")
const stateDir = join(outputDir, ".state")
const readJson = (name: string) =>
  JSON.parse(readFileSync(join(stateDir, name), "utf8").replace(/^\uFEFF/, ""))
const manifest = readJson("manifest.json")
const verification = readJson("verification.json")
assert.equal(verification.allFieldsVerified, true)
assert.deepEqual(verification.missingTasks, [])
const sourceRows = parseCsv(readFileSync(manifest.inputPath, "utf8")).slice(1)
const mappedRows = parseCsv(readFileSync(join(outputDir, "results.csv"), "utf8")).slice(1)
const onlineText = readFileSync(join(stateDir, "sync-before.tsv"), "utf8")
const onlineRows = onlineText
  .replace(/\r\n$/, "")
  .split("\r\n")
  .map(row => row.split("\t"))
assert(onlineRows.every(row => row.length === 11))
const rowsById = new Map(sourceRows.map((row, index) => [row[0], { row, index }]))
assert.equal(rowsById.size, sourceRows.length)
assert.equal(new Set(onlineRows.map(row => row[0])).size, onlineRows.length)
const tasksByRow = new Map<number, any>()
for (const task of manifest.tasks) for (const index of task.rowIndexes) tasksByRow.set(index, task)
const changes: any[] = []
const conflicts: any[] = []
const updatedKeys = new Set<string>()
const includedIds = new Set<string>()
const normalize = (value: string) => value.replace(/\r\n/g, "\n")
const expectedRows = onlineRows.map((row, onlineIndex) => {
  const source = rowsById.get(row[0])
  assert(source, `线上编号 ${row[0]} 未在输入找到`)
  for (const column of [1, 2, 3])
    assert.equal(row[column], source.row[column], `编号 ${row[0]} 身份字段 ${column} 变化`)
  const task = tasksByRow.get(source.index)
  if (!task) return row
  includedIds.add(row[0])
  const check = readJson(`checks/${task.key}.json`)
  if (check.status === "失败") return row
  const nextRow = [...row]
  for (const column of [4, 5, 6, 7]) {
    const before = normalize(source.row[column])
    const current = normalize(row[column])
    const next = normalize(mappedRows[source.index][column])
    if (current !== before && current !== next)
      conflicts.push({ id: row[0], key: task.key, column, before, current, next })
    nextRow[column] = next
    if (current !== next)
      changes.push({ onlineIndex, id: row[0], key: task.key, column, before: current, after: next })
  }
  updatedKeys.add(task.key)
  return nextRow
})
const excludedRows = [...tasksByRow]
  .filter(([index]) => !includedIds.has(sourceRows[index][0]))
  .map(([index, task]) => ({ id: sourceRows[index][0], key: task.key, msku: sourceRows[index][3] }))
const report = {
  preparedAt: new Date().toISOString(),
  onlineRows: onlineRows.length,
  modifiedCells: changes.length,
  modifiedRows: new Set(changes.map(item => item.onlineIndex)).size,
  updatedAsins: updatedKeys.size,
  excludedRows,
  conflicts,
  beforeHash: hashValue(onlineRows),
  expectedHash: hashValue(expectedRows),
}
writeFileSync(join(stateDir, "sync-plan.json"), JSON.stringify(report, null, 2))
assert.equal(conflicts.length, 0, "存在人工变更，禁止覆盖")
writeFileSync(join(stateDir, "sync-changes.json"), JSON.stringify(changes, null, 2))
writeFileSync(join(stateDir, "sync-expected.json"), JSON.stringify(expectedRows))
const encodeCell = (value: string) =>
  /[\t\r\n"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value
writeFileSync(
  join(stateDir, "sync-paste.tsv"),
  expectedRows.map(row => row.slice(4, 8).map(encodeCell).join("\t")).join("\r\n")
)
console.log(JSON.stringify(report))
