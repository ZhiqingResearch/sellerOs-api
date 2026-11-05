import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { exportBootstrapData, parseArgs, sqlValue, TABLES } from "./export-bootstrap-data.mjs"

const hex = value => Buffer.from(value, "utf8").toString("hex").toUpperCase()

function source(records = {}, changeColumns = value => value) {
  const calls = []
  const columns = changeColumns(TABLES.flatMap(tableName => [
    { tableName, columnName: "id", dataType: "bigint", columnKey: "PRI", extra: "auto_increment", engine: "InnoDB" },
    { tableName, columnName: "payload", dataType: "json", columnKey: "", extra: "", engine: "InnoDB" },
  ]))
  const tx = {
    async $executeRawUnsafe(sql) { calls.push({ sql }); return 0 },
    async $queryRawUnsafe(sql, ...args) {
      calls.push({ sql, args })
      if (sql.includes("information_schema.COLUMNS")) return columns
      const table = /FROM `([^`]+)`/.exec(sql)?.[1]
      assert(TABLES.includes(table), "不得读取清单外的业务表")
      const rows = records[table] ?? []
      if (sql.startsWith("SELECT COUNT")) return [{ count: BigInt(rows.length) }]
      if (table === "Tag" && records.fail) throw new Error("模拟读取失败")
      return rows.slice(args[1], args[1] + args[0])
    },
  }
  return {
    calls,
    async $transaction(callback, options) {
      assert.equal(options.isolationLevel, "RepeatableRead")
      return callback(tx)
    },
  }
}

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), "bootstrap-export-test-"))
  try { return await run(join(directory, "data.sql")) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

test("固定33张表，使用真实Role表名，不包括车泰斗或财务历史", () => {
  assert.equal(TABLES.length, 33)
  assert.equal(new Set(TABLES).size, 33)
  assert(TABLES.includes("Role"))
  for (const table of ["RoleModel", "CreditLot", "CreditTransaction", "ChetaidouSku", "History"])
    assert(!TABLES.includes(table))
})

test("十六进制编码支持空值、空串、二进制和注入内容，不受SQL转义模式影响", () => {
  assert.equal(sqlValue(null, "json"), "NULL")
  assert.equal(sqlValue("", "varchar"), "CONVERT(X'' USING utf8mb4)")
  assert.equal(sqlValue("00FF", "blob"), "X'00FF'")
  const input = "中文😀'\\\n\0'); DROP TABLE User; --"
  const literal = sqlValue(hex(input), "longtext")
  assert.equal(literal, `CONVERT(X'${hex(input)}' USING utf8mb4)`)
  assert(!literal.includes("DROP"))
  for (const invalid of ["0", "GG", "AA'); DROP TABLE User;--", undefined, 12])
    assert.throws(() => sqlValue(invalid, "varchar"), /无效的十六进制/)
})

test("导出全部用户和个人模板原始行，保留大整数及JSON，只写INSERT并限制文件权限", () => temporary(async output => {
  const secret = '{"token":"private-secret","quote":"中文😀\\\""}'
  const db = source({
    User: [{ id: hex("9007199254740993"), payload: hex(secret) }],
    ImageTemplate: [{ id: hex("7"), payload: hex('{"isSystem":false}') }],
    OpenApiApp: [{ id: hex("3"), payload: hex(secret) }],
  })
  const logs = []
  const summary = await exportBootstrapData(db, { output }, text => logs.push(text))
  assert.equal(summary.length, 33)
  assert.equal(summary.find(row => row.table === "User").count, "1")
  const sql = await readFile(output, "utf8")
  assert(sql.includes(`INSERT INTO \`User\` (\`id\`, \`payload\`) VALUES (CONVERT(X'${hex("9007199254740993")}' USING utf8mb4)`))
  assert(sql.includes("INSERT INTO `ImageTemplate`"))
  assert(sql.includes("INSERT INTO `OpenApiApp`"))
  assert(!sql.includes("private-secret"))
  assert(!logs.join(" ").includes("private-secret"))
  assert(!/\b(?:DROP|TRUNCATE|DELETE|REPLACE|CREATE|USE)\b/.test(sql))
  assert(sql.includes("START TRANSACTION;"))
  assert(sql.includes("COMMIT;"))
  assert(sql.includes("NO_AUTO_VALUE_ON_ZERO"))
  assert.equal((await stat(output)).mode & 0o777, 0o600)
  assert.deepEqual(db.calls.filter(call => !call.sql.trimStart().startsWith("SELECT")), [{ sql: "SET SESSION time_zone = '+00:00'" }])
}))

test("按主键分页导出全部行，不重复、不遗漏", () => temporary(async output => {
  const rows = Array.from({ length: 401 }, (_, index) => ({ id: hex(String(index + 1)), payload: null }))
  const db = source({ User: rows })
  await exportBootstrapData(db, { output }, () => {})
  const pages = db.calls.filter(call => call.sql.startsWith("SELECT HEX") && call.sql.includes("FROM `User`"))
  assert.deepEqual(pages.map(page => page.args), [[200, 0], [200, 200], [200, 400]])
  assert(pages.every(page => page.sql.includes("ORDER BY `id`")))
  const sql = await readFile(output, "utf8")
  assert.equal(sql.split("INSERT INTO `User`").length - 1, 401)
}))

test("预检只统计33张表，不生成SQL、不读取行内容", () => temporary(async output => {
  const db = source({ User: [{ id: "31", payload: null }] })
  const summary = await exportBootstrapData(db, { output, dryRun: true }, () => {})
  assert.equal(summary.find(row => row.table === "User").count, "1")
  await assert.rejects(stat(output), { code: "ENOENT" })
  assert(!db.calls.some(call => call.sql.startsWith("SELECT HEX")))
}))

test("源库缺表或非事务表时失败，已有文件不覆盖，异常不留下不完整SQL", () => temporary(async output => {
  await assert.rejects(exportBootstrapData(source({}, cols => cols.filter(col => col.tableName !== "Role")), { output }, () => {}), /缺少表 Role/)
  await assert.rejects(stat(output), { code: "ENOENT" })
  await assert.rejects(exportBootstrapData(source({}, cols => cols.map(col => ({ ...col, engine: "MyISAM" }))), { output }, () => {}), /不是 InnoDB/)
  await assert.rejects(stat(output), { code: "ENOENT" })
  await assert.rejects(exportBootstrapData(source({ fail: true }), { output }, () => {}), /模拟读取失败/)
  await assert.rejects(stat(output), { code: "ENOENT" })
  await writeFile(output, "原有文件")
  await assert.rejects(exportBootstrapData(source(), { output }, () => {}), { code: "EEXIST" })
  assert.equal(await readFile(output, "utf8"), "原有文件")
}))

test("保留DEFAULT_GENERATED普通列，跳过计算列，复合主键完整排序", () => temporary(async output => {
  const db = source({ UserRole: [{ id: "31", payload: "7B7D" }] }, cols => [
    ...cols.map(col => col.tableName === "UserRole" && col.columnName === "payload" ? { ...col, columnKey: "PRI", extra: "DEFAULT_GENERATED" } : col),
    { tableName: "UserRole", columnName: "derived", dataType: "int", columnKey: "", extra: "VIRTUAL GENERATED", engine: "InnoDB" },
  ])
  await exportBootstrapData(db, { output }, () => {})
  const query = db.calls.find(call => call.sql.startsWith("SELECT HEX") && call.sql.includes("FROM `UserRole`"))
  assert(query.sql.includes("ORDER BY `id`, `payload`"))
  assert(!query.sql.includes("derived"))
  const sql = await readFile(output, "utf8")
  assert(sql.includes("INSERT INTO `UserRole` (`id`, `payload`)"))
}))

test("命令行接受预检和输出路径，拒绝未知参数", () => {
  assert.equal(parseArgs(["--dry-run"]).dryRun, true)
  assert.equal(parseArgs(["--help"]).help, true)
  assert.equal(parseArgs(["--output", "temp/data.sql"]).output, resolve("temp/data.sql"))
  for (const args of [["--all"], ["--output"], ["--output", "--dry-run"]])
    assert.throws(() => parseArgs(args), /用法/)
})

test("兼容源库lower_case_table_names=1，输出仍使用Prisma定义的规范表名", () => temporary(async output => {
  const db = source({ Role: [{ id: "31", payload: null }] }, columns => columns.map(column => ({ ...column, tableName: column.tableName.toLowerCase() })))
  await exportBootstrapData(db, { output }, () => {})
  const sql = await readFile(output, "utf8")
  assert(sql.includes("INSERT INTO `Role`"))
}))
