import test from "node:test"
import assert from "node:assert/strict"
import { registerImageModel } from "./image-models.mjs"

function setup() {
  const rows = [{ publicId: "default", enabled: true, sortOrder: 4, priceMultiplier: 3 }]
  const db = { $queryRaw: async () => [], aiGatewayModel: {
    findMany: async () => structuredClone(rows), create: async ({ data }) => rows.push(data),
    update: async ({ where, data }) => Object.assign(rows.find(r => r.publicId === where.publicId_category.publicId), data),
  }, $transaction: async fn => fn(db) }
  const gateway = { models: { get: async () => ({ display_name: "NanoBanana2（开放通道）", modality: "image", facts: { modes: ["edit"] } }),
    requestSchema: async () => ({ version: 4, request_schema: { type: "object" } }) } }
  return { rows, db, gateway }
}
test("新增可选模型不影响默认项；重同步保留价格和用户启停排序", async () => {
  const { rows, db, gateway } = setup()
  await registerImageModel(db, gateway)
  assert.equal(rows.length, 1)
  await registerImageModel(db, gateway, { dryRun: false, enable: true })
  assert.equal(rows[0].enabled, true)
  assert.equal(rows[1].sortOrder, 5)
  Object.assign(rows[1], { priceMultiplier: 7, fixedCredits: 9, enabled: false, sortOrder: 42 })
  await registerImageModel(db, gateway, { dryRun: false, enable: true })
  assert.equal(rows.length, 2)
  assert.deepEqual([rows[1].priceMultiplier, rows[1].fixedCredits, rows[1].enabled, rows[1].sortOrder], [7, 9, false, 42])
})
test("不支持 edit 的模型拒绝登记", async () => {
  const { rows, db, gateway } = setup()
  gateway.models.get = async () => ({ modality: "image", facts: { modes: ["generate"] } })
  await assert.rejects(registerImageModel(db, gateway, { dryRun: false }), /参考图编辑/)
  assert.equal(rows.length, 1)
})
