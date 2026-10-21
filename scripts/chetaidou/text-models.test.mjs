import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"
import { CHETAIDOU_TEXT_MODELS, prepareTextModels, syncTextModels } from "./text-models.mjs"
import { CHETAIDOU_IMAGE_MODELS } from "./image-models.mjs"
import { saveModels } from "./database.mjs"

test("两个指定模型展示名取自网关，名称缺失拒绝登记", async () => {
  const gateway = { models: {
    get: async id => ({ display_name: `网关名称:${id}`, modality: "text", exec_mode: "sync" }),
    requestSchema: async () => ({ request_schema: {} }),
  } }
  const models = await prepareTextModels(gateway)
  assert.deepEqual(models.map(m => m.publicId), [
    "ZQ-Multimodal-Gemini-3.7-Flash",
    "ZQ-Multimodal-Gemini-3.8-Flash",
  ])
  assert.ok(models.every(m => m.displayName === `网关名称:${m.publicId}`))
  gateway.models.get = async () => ({ display_name: "", modality: "text" })
  await assert.rejects(prepareTextModels(gateway), /名称无效/)
})

test("指定 GPT-5.5 时只读取该模型及 chat.completions 能力", async () => {
  const reads = []
  const gateway = { models: {
    get: async id => { reads.push(id); return { display_name: "GPT-5.5", modality: "text", exec_mode: "sync" } },
    requestSchema: async (id, { operation }) => { reads.push([id, operation]); return { request_schema: {} } },
  } }
  const models = await prepareTextModels(gateway, ["gpt-5.5"])
  assert.deepEqual(reads, ["gpt-5.5", ["gpt-5.5", "chat.completions"]])
  assert.equal(models.length, 1)
  assert.equal(models[0].publicId, "gpt-5.5")
  assert.equal(models[0].category, "CHETAIDOU_MULTIMODAL")
})

test("同步保留现有价格、排序和启用设置，新增必须显式配置价格，dry-run不写库", async () => {
  const rows = [{ publicId: "old", category: "CHETAIDOU_MULTIMODAL", displayName: "旧名称", enabled: false, priceMultiplier: 3, sortOrder: 42 }]
  const db = { aiGatewayModel: {
    findUnique: async ({ where }) => rows.find(r => r.publicId === where.publicId_category.publicId),
    update: async ({ where, data }) => Object.assign(rows.find(r => r.publicId === where.publicId_category.publicId), data),
    create: async ({ data }) => rows.push(data),
  }, $transaction: async fn => fn(db) }
  const metadata = { publicId: "old", category: "CHETAIDOU_MULTIMODAL", displayName: "网关新名称", sortOrder: 0 }
  await syncTextModels(db, [metadata])
  assert.equal(rows[0].displayName, "网关新名称")
  assert.equal(rows[0].priceMultiplier, 3)
  assert.equal(rows[0].sortOrder, 42)
  assert.equal(rows[0].enabled, false)
  const fresh = { ...metadata, publicId: "new" }
  await assert.rejects(syncTextModels(db, [fresh]), /显式指定/)
  await syncTextModels(db, [fresh], { multiplier: 1, enable: true, dryRun: true })
  assert.equal(rows.length, 1)
  await syncTextModels(db, [fresh], { multiplier: 1, enable: true })
  assert.equal(rows[1].enabled, true)
  assert.equal(rows[1].priceMultiplier, 1)
})

function initializer(args, gateway) {
  return readFile(new URL("../init-chetaidou-production.mjs", import.meta.url), "utf8").then(source => {
    const body = source.slice(source.indexOf("async function prepareModels(db)"), source.indexOf("async function main()"))
      .replace('await import("@zhiqingresearch/ai-ts-sdk")', 'gatewaySdk')
    return vm.runInNewContext(`${body}\nprepareModels`, {
      args, CHETAIDOU_TEXT_MODELS, CHETAIDOU_IMAGE_MODELS, numberOption: key => args[key], required: () => "test",
      gatewaySdk: { AiGatewayClient: class { constructor() { return gateway } } },
    })
  })
}

test("全量初始化复用指定两个文本和两个图片模型，保留其他旧模型及原有排序价格", async () => {
  const texts = [...CHETAIDOU_TEXT_MODELS, "legacy-text"].map(publicId => ({ publicId, enabled: true, gatewayActive: true, modality: "TEXT" }))
  const images = [...CHETAIDOU_IMAGE_MODELS, "legacy-image"].map((publicId, sortOrder) => ({ publicId, enabled: true, gatewayActive: true, modality: "IMAGE", sortOrder: 50 + sortOrder, priceMultiplier: 1, fixedCredits: null }))
  const db = { aiGatewayModel: {
    findMany: async ({ where }) => where.category === "CHETAIDOU_MULTIMODAL" ? texts : images,
    findUnique: async ({ where }) => [...texts, ...images].find(row => row.publicId === where.publicId_category.publicId),
  } }
  const before = structuredClone({ texts, images })
  const prepare = await initializer({}, { models: { get: assert.fail } })
  const models = await prepare(db)
  assert.deepEqual(Array.from(models, row => row.existing.publicId), [...CHETAIDOU_TEXT_MODELS, "gpt-image-2.5-sunburst", "ZQ-Image-1"])
  assert.deepEqual({ texts, images }, before)
})

test("全新文本目录一次准备两个模型及售价排序；缺少倍率或网关模型时停止，不调用生成", async () => {
  const reads = [], schemas = []
  const gateway = { models: {
    get: async id => { reads.push(id); return { display_name: `网关名称:${id}`, modality: "text", exec_mode: "sync" } },
    requestSchema: async (id, { operation }) => { schemas.push([id, operation]); return { request_schema: {} } },
  } }
  const db = { aiGatewayModel: {
    findUnique: async ({ where }) => CHETAIDOU_IMAGE_MODELS.includes(where.publicId_category.publicId)
      ? { publicId: where.publicId_category.publicId, enabled: true, gatewayActive: true, modality: "IMAGE" } : null,
  } }
  const prepare = await initializer({ "text-multiplier": 2 }, gateway)
  const models = await prepare(db)
  const textCount = CHETAIDOU_TEXT_MODELS.length
  assert.deepEqual(Array.from(models.slice(0, textCount), row => row.data.publicId), CHETAIDOU_TEXT_MODELS)
  assert.deepEqual(reads, CHETAIDOU_TEXT_MODELS)
  assert.deepEqual(schemas, CHETAIDOU_TEXT_MODELS.map(id => [id, "chat.completions"]))
  assert.ok(models.slice(0, textCount).every(row => row.data.enabled && row.data.priceMultiplier === 2 && row.data.category === "CHETAIDOU_MULTIMODAL"))
  assert.deepEqual(Array.from(models.slice(0, textCount), row => row.data.sortOrder), CHETAIDOU_TEXT_MODELS.map((_, i) => i))
  assert.deepEqual(Array.from(models.slice(textCount), row => row.existing.publicId), CHETAIDOU_IMAGE_MODELS)
  await assert.rejects((await initializer({}, gateway))(db), /显式提供 --text-multiplier/)
  gateway.models.get = async () => { throw new Error("模型未上架") }
  await assert.rejects(prepare(db), /模型未上架/)
})

test("空库初始化两种图片模型及文本模型，全部启用；重跑不写库，旧图片模型不阻止新增", async () => {
  const rows = []
  const db = { $transaction: fn => fn(db), aiGatewayModel: {
    findUnique: async ({ where }) => rows.find(row => row.publicId === where.publicId_category.publicId && row.category === where.publicId_category.category),
    create: async ({ data }) => { rows.push(structuredClone(data)); return data },
  } }
  const reads = []
  const gateway = { models: {
    get: async id => ({ display_name: id, modality: CHETAIDOU_IMAGE_MODELS.includes(id) ? "image" : "text", exec_mode: "async", facts: { modes: ["edit"] } }),
    requestSchema: async (id, { operation }) => { reads.push([id, operation]); return { request_schema: { type: "object" } } },
  } }
  const prepare = await initializer({ "text-multiplier": 2, "image-multiplier": 1 }, gateway)
  const planned = await prepare(db)
  assert.equal(rows.length, 0)
  assert.deepEqual(reads.slice(2), [["gpt-image-2.5-sunburst", "images.generations"], ["ZQ-Image-1", "images.generations"]])
  await saveModels(db, planned)
  assert.equal(rows.length, 4)
  assert.ok(rows.every(row => row.enabled && row.gatewayActive))
  assert.deepEqual(rows.slice(2).map(row => [row.publicId, row.sortOrder, row.priceMultiplier]), [["gpt-image-2.5-sunburst", 0, 1], ["ZQ-Image-1", 1, 1]])
  const before = structuredClone(rows)
  db.aiGatewayModel.create = assert.fail
  await saveModels(db, await prepare(db))
  assert.deepEqual(rows, before)
  rows.pop()
  db.aiGatewayModel.create = async ({ data }) => rows.push(structuredClone(data))
  await saveModels(db, await prepare(db))
  assert.deepEqual(rows.map(row => row.publicId), before.map(row => row.publicId))
})

test("图片初始化拒绝不支持编辑或缺少 Schema 的模型，显式图片参数仍可覆盖默认清单", async () => {
  const db = { aiGatewayModel: { findUnique: async ({ where }) => CHETAIDOU_TEXT_MODELS.includes(where.publicId_category.publicId)
    ? { publicId: where.publicId_category.publicId, enabled: true, gatewayActive: true, modality: "TEXT" } : null } }
  const detail = { display_name: "自定义模型", modality: "image", facts: { modes: ["generate"] } }
  let schema = { request_schema: { type: "object" } }
  const gateway = { models: { get: async () => detail, requestSchema: async () => schema } }
  const prepare = await initializer({ "image-model": "custom-image", "image-multiplier": 1 }, gateway)
  await assert.rejects(prepare(db), /参考图编辑/)
  detail.facts.modes.push("edit")
  schema = {}
  await assert.rejects(prepare(db), /请求 Schema/)
  schema = { request_schema: { type: "object" } }
  assert.deepEqual(Array.from(await prepare(db), row => row.existing?.publicId ?? row.data.publicId), [...CHETAIDOU_TEXT_MODELS, "custom-image"])
  await assert.rejects((await initializer({ "image-model": " " }, gateway))(db), /不能为空/)
})
