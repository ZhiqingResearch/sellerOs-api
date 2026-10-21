import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

test("上线与流程增量 SQL 对照 Prisma 表、字段及索引，增量可重跑且不回填数据", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  // 只从本地 schema 生成参考 DDL，不连接任何数据库、不执行 migrate。
  const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"], {
    cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr)
  const sql = await readFile(new URL("../sql/2026-10-08-chetaidou-deployment.sql", import.meta.url), "utf8")
  const tables = text => new Map([...text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? `([^`]+)` \([\s\S]*?\) DEFAULT CHARACTER SET[^;]+;/g)].map(m => [m[1], m[0]]))
  const expected = tables(result.stdout), actual = tables(sql)
  assert.deepEqual([...actual.keys()], [...expected.keys()].filter(name => name.startsWith("Chetaidou")))
  const withoutFieldComments = text => text.replace(/\s+COMMENT '[^']*'/g, "")
  const normalize = text => withoutFieldComments(text.replace(/--[^\n]*/g, "")).replace(" IF NOT EXISTS", "").replace(/\s+/g, " ")
  const fieldComments = new Map()
  for (const [name, ddl] of actual) {
    assert.equal(normalize(ddl), normalize(expected.get(name)), name)
    const fields = [...expected.get(name).matchAll(/^\s*`([^`]+)` /gm)].map(match => match[1])
    const comments = new Map([...ddl.matchAll(/^\s*`([^`]+)` [^\n]* COMMENT '([^']+)'[,]?$/gm)].map(match => [match[1], match[2]]))
    assert.deepEqual([...comments.keys()], fields, name + ' 字段 COMMENT 完整')
    for (const comment of comments.values()) assert.match(comment, /[\u4e00-\u9fff]/, name + ' 中文字段说明')
    fieldComments.set(name, comments)
  }
  const extensions = {
    ImageGenJob: ["businessType", "businessTaskId", "cancelRequestedAt"],
    ImageGenItem: ["currentCallId", "fileKey", "mime", "width", "height", "errorCode", "deletedAt", "gatewayImage"],
  }
  for (const [name, columns] of Object.entries(extensions)) {
    for (const column of columns) {
      const definition = expected.get(name).match(new RegExp('`' + column + '` (.+),'))[1]
      assert.ok(withoutFieldComments(sql).includes('ALTER TABLE `' + name + '` ADD COLUMN `' + column + '` ' + definition + ';'), name + '.' + column)
      assert.match(sql, new RegExp('ALTER TABLE `' + name + '` ADD COLUMN `' + column + '` [^;\\n]+ COMMENT \'[^\']*[\\u4e00-\\u9fff][^\']*\';'), name + '.' + column + ' COMMENT')
    }
  }
  assert.match(sql, /MODIFY COLUMN `expiresAt` DATETIME\(3\) NULL/)
  assert.match(sql, /MODIFY COLUMN `expiresAt` DATETIME\(3\) NULL COMMENT '[^']+'/)
  assert.match(sql, /SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT/)
  assert.doesNotMatch(sql, /ADD COLUMN `chetaidouRemovedAt`|(?:ADD|CREATE) UNIQUE INDEX `ImageGenItem_jobId_idx_key`/)
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE `Chetaidou/)
  assert.match(sql, /i\.deletedAt IS NULL AND i\.chetaidouRemovedAt IS NOT NULL/)
  assert.match(sql, /j\.businessType = ''CHETAIDOU''/)

  const incremental = await readFile(new URL("../sql/2026-10-12-chetaidou-workflow-optimization.sql", import.meta.url), "utf8")
  const incrementalTables = tables(incremental)
  assert.deepEqual([...incrementalTables.keys()], ["ChetaidouAdjustment"])
  assert.equal(normalize(incrementalTables.get("ChetaidouAdjustment")), normalize(expected.get("ChetaidouAdjustment")))
  const historyComments = new Map([...incrementalTables.get("ChetaidouAdjustment").matchAll(/^\s*`([^`]+)` [^\n]* COMMENT '([^']+)'[,]?$/gm)].map(match => [match[1], match[2]]))
  const historyColumns = [...expected.get("ChetaidouAdjustment").matchAll(/^\s*`([^`]+)` /gm)].map(match => match[1])
  assert.deepEqual([...historyComments.keys()], historyColumns)
  for (const [column, comment] of historyComments) {
    assert.equal(fieldComments.get("ChetaidouAdjustment").get(column), comment, column + ' 统一与增量 SQL 注释一致')
    const definition = expected.get("ChetaidouAdjustment").match(new RegExp('`' + column + '` (.+),'))[1]
    assert.ok(incremental.includes('MODIFY COLUMN `' + column + '` ' + definition + " COMMENT '" + comment + "'"), column)
    assert.ok(incremental.includes("WHEN '" + column + "' THEN '" + comment + "'"), column)
  }
  for (const [name, columns] of Object.entries({
    ChetaidouDraft: ["workspaceId", "activeAdjustmentId", "restoredFromAdjustmentId"],
    ChetaidouTask: ["workspaceId", "adjustmentId", "site"],
  })) {
    for (const column of columns) {
      const definition = expected.get(name).match(new RegExp('`' + column + '` (.+),'))[1]
      assert.ok(withoutFieldComments(incremental).includes('ALTER TABLE `' + name + '` ADD COLUMN `' + column + '` ' + definition + ';'), name + '.' + column)
      const comment = incremental.match(new RegExp('ALTER TABLE `' + name + '` ADD COLUMN `' + column + '` [^\\n]* COMMENT \'([^\']+)\';'))?.[1]
      assert.ok(comment, name + '.' + column + ' COMMENT')
      assert.equal(fieldComments.get(name).get(column), comment, name + '.' + column + ' 统一与增量 SQL 注释一致')
      assert.ok(incremental.includes('ALTER TABLE `' + name + '` MODIFY COLUMN `' + column + '` ' + definition + " COMMENT '" + comment + "';"), name + '.' + column)
      assert.ok(incremental.includes("AND COLUMN_COMMENT <> '" + comment + "') THEN"), name + '.' + column)
      assert.match(incremental, new RegExp("IF NOT EXISTS \\(SELECT 1 FROM information_schema.COLUMNS\\s+WHERE TABLE_SCHEMA = DATABASE\\(\\) AND TABLE_NAME = '" + name + "' AND COLUMN_NAME = '" + column + "'\\) THEN"))
    }
  }
  for (const name of ["ChetaidouAdjustment", "ChetaidouTask"]) {
    const indexes = [...expected.get(name).matchAll(/INDEX (`[^`]+`\([^\n]+\)),/g)]
      .filter(match => name === "ChetaidouAdjustment" || /skuId_site|adjustmentId/.test(match[1]))
    assert.equal(indexes.length, 2, name)
    for (const [, definition] of indexes) {
      assert.ok(incremental.includes('ALTER TABLE `' + name + '` ADD INDEX ' + definition + ';'), definition)
      const indexName = definition.match(/`([^`]+)`/)[1]
      assert.ok(incremental.includes("AND INDEX_NAME = '" + indexName + "') THEN"), indexName)
    }
  }
  assert.doesNotMatch(incremental, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|\bINSERT\b|\bUPDATE\s+`/)
  assert.match(incremental, /CALL `chetaidou_workflow_20261012`\(\);/)
  assert.match(incremental, /SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT/)
})
