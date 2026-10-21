import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { CAMPING_CHECKSUM, FALSE_CONFLICTS, fixCampingConflicts } from "../fix-chetaidou-camping-conflicts.mjs"
import { jsonHash, normalizeBreakdown } from "./data.mjs"

test("初始化露营底稿没有历史提示词误报，人物与标记待核实信息保留", async () => {
  const raw = JSON.parse(await readFile(new URL("./preset-data/data/studio/breakdowns/img-6-1.json", import.meta.url), "utf8"))
  const { payload } = normalizeBreakdown(raw, CAMPING_CHECKSUM, () => {})
  assert.deepEqual(payload.conflicts, [])
  assert.equal(payload.persons.length, 5)
  assert.ok(payload.uncertainties.some(value => value.includes("是否为真实产品标识")))
})

function database() {
  const image = { id: 4, currentBreakdownId: 4, revision: 0, activeBreakdownTaskId: null }
  const rows = [{ id: 4, imageId: 4, version: 1, factId: 1, source: "PRESET", qualityStatus: "CONFIRMED", schemaVersion: 0,
    confirmedBy: 0, confirmedAt: new Date(), sourceMetadata: { originalBreakdown: { conflicts: FALSE_CONFLICTS } },
    payload: { conflicts: [...FALSE_CONFLICTS, "保留真实硬事实冲突"], basketContents: null, uncertainties: ["标记待核实"], persons: [{ personId: "p1" }] },
  }]
  const db = {
    $transaction: callback => callback(db), $queryRaw: async () => [],
    chetaidouSku: { findUnique: async () => ({ id: 1 }) },
    chetaidouImage: {
      findMany: async ({ where }) => { assert.deepEqual(where, { skuId: 1, sourceType: "PRESET", checksum: CAMPING_CHECKSUM }); return [{ id: image.id }] },
      findUniqueOrThrow: async () => image,
      update: async ({ data }) => { image.currentBreakdownId = data.currentBreakdownId; image.revision++ },
    },
    chetaidouBreakdown: {
      findUniqueOrThrow: async ({ where }) => rows.find(row => row.id === where.id),
      findFirstOrThrow: async () => rows.at(-1),
      create: async ({ data }) => { const row = { id: rows.at(-1).id + 1, ...data }; rows.push(row); return row },
    },
  }
  return { db, image, rows }
}

test("仅移除两条准确误报，追加版本及哈希，保留旧稿和其他字段；重复执行不新增", async () => {
  const { db, image, rows } = database()
  const original = structuredClone(rows[0])
  assert.equal((await fixCampingConflicts(db))[0].removed, 2)
  assert.deepEqual(rows[0], original)
  assert.deepEqual(rows[1].payload, { ...original.payload, conflicts: ["保留真实硬事实冲突"] })
  assert.equal(rows[1].contentHash, jsonHash(rows[1].payload))
  assert.equal(rows[1].schemaVersion, 0)
  assert.equal(rows[1].sourceMetadata.correctedFromBreakdownId, 4)
  assert.equal(image.currentBreakdownId, rows[1].id)
  assert.equal((await fixCampingConflicts(db))[0].removed, 0)
  assert.equal(rows.length, 2)
})

test("dry-run 不修改当前指针或追加记录", async () => {
  const { db, image, rows } = database()
  assert.equal((await fixCampingConflicts(db, { dryRun: true }))[0].removed, 2)
  assert.equal(image.currentBreakdownId, 4)
  assert.equal(rows.length, 1)
})
