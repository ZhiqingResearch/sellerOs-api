import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, writeFile, symlink, rm, mkdir, readFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { containedFile, normalizeBreakdown, uploadedImageKey, packBundle, loadBundle, loadFacts, digest, jsonHash } from "./data.mjs"
import sharp from "sharp"
import { ensureFacts, importImage, activateSku, seedRegistry, saveModels, resolveImportActor } from "./database.mjs"
import { validateBreakdownOutput } from "../../dist/chetaidou/chetaidou.schemas.js"
import { FEATURE_MODULE_DEFINITIONS } from "../../dist/usage/feature-module-definitions.js"
import { productHardConstraints } from "../../dist/chetaidou/chetaidou-product-constraints.js"

const raw = {
  imageId: "img-test", sourceHash: "hash", qualityStatus: "ai_unreviewed",
  summary: "货篮内物品在旧版本未结构化记录", hasPeople: false, persons: [],
  textInventory: [{ textId: "t1", sourceText: "品牌", category: "brand", editable: true, readability: "readable" }],
  softFeatures: {}, hardConstraints: [], conflicts: [], uncertainties: [],
}
const item = {
  entry: { id: "img-test", title: "测试母版", number: "1" }, file: "image.jpg", mime: "image/jpeg",
  checksum: "hash", width: 10, height: 10, raw,
  ...normalizeBreakdown(raw, "hash", validateBreakdownOutput),
}
const fixtureFacts = { document: "真实文档" }
const acceptance = { status: "confirmed", confirmedOn: "2026-10-08", basis: "用户确认初始化母版及拆解" }
const bundle = { manifest: { sku: { code: "CS1plus", name: "C1S Plus" }, breakdownAcceptance: acceptance }, factsHash: jsonHash(fixtureFacts), facts: fixtureFacts }
function database(skuId = 1) {
  const state = { sku: null, facts: [], images: [], breakdowns: [] }
  let failPointerOnce = false
  const db = {
    state, failNextPointer: () => { failPointerOnce = true },
    $queryRaw: async () => [],
    $transaction: async callback => {
      const before = structuredClone(state)
      try { return await callback(db) } catch (error) { Object.assign(state, before); throw error }
    },
    chetaidouSku: {
      findUnique: async () => state.sku,
      create: async ({ data }) => state.sku = { id: skuId, revision: 0, currentFactId: null, ...data },
      findUniqueOrThrow: async () => state.sku,
      update: async ({ data }) => { const { revision, ...rest } = data; Object.assign(state.sku, rest); if (revision) state.sku.revision += revision.increment; return state.sku },
    },
    chetaidouFactCard: {
      findUnique: async ({ where }) => state.facts.find(r => r.id === where.id),
      findFirst: async () => state.facts.at(-1),
      create: async ({ data }) => { const row = { id: state.facts.length + 1, ...data }; state.facts.push(row); return row },
    },
    chetaidouImage: {
      findUnique: async ({ where }) => state.images.find(r => r.importKey === where.importKey),
      create: async ({ data }) => { const row = { id: state.images.length + 1, enabled: true, currentBreakdownId: null, revision: 0, ...data }; state.images.push(row); return row },
      update: async ({ where, data }) => {
        if (failPointerOnce) { failPointerOnce = false; throw new Error("模拟落库中断") }
        const row = state.images.find(r => r.id === where.id); Object.assign(row, data); return row
      },
      count: async ({ where }) => state.images.filter(r => where.id.in.includes(r.id) && r.enabled && r.currentBreakdownId).length,
    },
    chetaidouBreakdown: {
      findUnique: async ({ where }) => state.breakdowns.find(r => where.id ? r.id === where.id : r.importKey === where.importKey),
      findFirst: async ({ where }) => state.breakdowns.filter(r => r.imageId === where.imageId).at(-1),
      create: async ({ data }) => { const row = { id: state.breakdowns.length + 1, ...data }; state.breakdowns.push(row); return row },
    },
  }
  return db
}
const storage = { ensureFile: async () => {}, ensureThumbnail: async key => `${key}.thumbnail.webp` }

test("省略导入人可在无用户库中初始化，显式用户仍需有效且启用", async () => {
  const db = database()
  const actorId = await resolveImportActor(db, undefined)
  assert.equal(actorId, 0)
  const ctx = await ensureFacts(db, bundle, actorId)
  await importImage(db, storage, ctx, item, actorId)
  assert.equal(db.state.facts[0].confirmedBy, 0)
  assert.equal(db.state.images[0].createdBy, 0)
  assert.equal(db.state.images[0].ownerId, null)
  assert.equal(db.state.breakdowns[0].qualityStatus, "CONFIRMED")
  assert.equal(db.state.breakdowns[0].source, "PRESET")
  assert.equal(db.state.breakdowns[0].confirmedBy, 0)
  assert.ok(db.state.breakdowns[0].confirmedAt instanceof Date)
  assert.deepEqual(db.state.breakdowns[0].sourceMetadata.acceptance, acceptance)
  for (const value of ["", "0", "-1", "1.5", "abc"]) {
    await assert.rejects(resolveImportActor(db, value), /正整数/)
  }
  db.user = { findUnique: async ({ where }) => where.id === 123 ? { isActive: true } : where.id === 124 ? { isActive: false } : null }
  assert.equal(await resolveImportActor(db, "123"), 123)
  await assert.rejects(resolveImportActor(db, "124"), /不存在或已停用/)
  await assert.rejects(resolveImportActor(db, "125"), /不存在或已停用/)
})

test("旧数据保留未知货篮信息，非营销文字不能导入为可编辑，原始记录不变", () => {
  assert.equal(item.payload.basketContents, null)
  assert.equal(item.payload.textInventory[0].editable, false)
  assert.equal(raw.textInventory[0].editable, true)
  assert.match(item.payload.uncertainties.at(-1), /不能据此认定为空/)
  assert.throws(() => normalizeBreakdown(raw, "other", validateBreakdownOutput), /sourceHash/)
  assert.doesNotThrow(() => normalizeBreakdown({ ...raw, qualityStatus: "confirmed" }, "hash", validateBreakdownOutput))
  assert.throws(() => normalizeBreakdown({ ...raw, qualityStatus: "invalid" }, "hash", validateBreakdownOutput), /来源状态无效/)
})

test("同一包执行两次不重复创建事实卡、图片和拆解", async () => {
  const db = database()
  for (let i = 0; i < 2; i++) {
    const ctx = await ensureFacts(db, bundle, 123)
    await importImage(db, storage, ctx, item, 123)
  }
  assert.equal(db.state.facts.length, 1)
  assert.equal(db.state.images.length, 1)
  assert.equal(db.state.breakdowns.length, 1)
  assert.equal(db.state.images[0].ownerId, null)
  assert.equal(db.state.breakdowns[0].qualityStatus, "CONFIRMED")
  assert.equal(db.state.breakdowns[0].confirmedBy, 123)
  assert.equal(db.state.breakdowns[0].sourceMetadata.originalBreakdown.qualityStatus, "ai_unreviewed")
})

test("已有不同或残缺事实卡拒绝导入，不修改已有数据", async () => {
  const db = database()
  await ensureFacts(db, bundle, 123)
  const before = structuredClone(db.state)
  const changed = { ...bundle, factsHash: "facts-v2", facts: { document: "新版文档" } }
  await assert.rejects(ensureFacts(db, changed, 123), /不会覆盖/)
  assert.deepEqual(db.state, before)
  db.state.facts[0].content = { document: "管理员修改了正文但未更新哈希" }
  const edited = structuredClone(db.state)
  await assert.rejects(ensureFacts(db, bundle, 123), /不会覆盖/)
  assert.deepEqual(db.state, edited)
  db.state.sku.currentFactId = null
  const incomplete = structuredClone(db.state)
  await assert.rejects(ensureFacts(db, bundle, 123), /不会补齐/)
  assert.deepEqual(db.state, incomplete)
})

test("新图片和拆解落库失败整体回滚，重跑创建完整记录，已有人工版本只读复用", async () => {
  const db = database()
  const ctx = await ensureFacts(db, bundle, 123)
  db.failNextPointer()
  await assert.rejects(importImage(db, storage, ctx, item, 123), /落库中断/)
  assert.equal(db.state.images.length, 0)
  assert.equal(db.state.breakdowns.length, 0)
  await importImage(db, storage, ctx, item, 123)
  db.state.breakdowns[0].qualityStatus = "CONFIRMED"
  db.state.breakdowns[0].payload = { summary: "管理员发布内容" }
  const before = structuredClone(db.state)
  await importImage(db, { ensureFile: assert.fail, ensureThumbnail: assert.fail }, ctx, item, 123)
  assert.deepEqual(db.state, before)
})

test("新 SKU 事实卡落库失败整体回滚，不留下残缺 SKU", async () => {
  const db = database()
  db.chetaidouFactCard.create = async () => { throw new Error("模拟事实卡写入失败") }
  await assert.rejects(ensureFacts(db, bundle, 123), /写入失败/)
  assert.equal(db.state.sku, null)
  assert.equal(db.state.facts.length, 0)
})

test("对象存储失败不创建图片，全部就绪前不能启用 SKU", async () => {
  const db = database()
  const ctx = await ensureFacts(db, bundle, 123)
  await assert.rejects(importImage(db, { ensureFile: async () => { throw new Error("上传失败") } }, ctx, item, 123), /上传失败/)
  assert.equal(db.state.images.length, 0)
  await assert.rejects(activateSku(db, ctx, [1]), /未全部就绪/)
  assert.equal(db.state.sku.enabled, false)
  const result = await importImage(db, storage, ctx, item, 123)
  await activateSku(db, ctx, [result.id])
  assert.equal(db.state.sku.enabled, true)
})

test("同导入键不同内容或跨 SKU 立即失败，不调用上传", async () => {
  const db = database()
  const ctx = await ensureFacts(db, bundle, 123)
  await importImage(db, storage, ctx, item, 123)
  let uploaded = false
  const recording = { ensureFile: async () => { uploaded = true } }
  await assert.rejects(importImage(db, recording, ctx, { ...item, checksum: "changed" }, 123), /停止覆盖/)
  assert.equal(uploaded, false)
})

test("权限和功能仅新增车泰斗项，不改已有配置或重置角色", async () => {
  const calls = []
  const table = name => ({ upsert: async params => { calls.push([name, params]); return { id: calls.length } } })
  const db = { permissionGroup: table("group"), permission: table("permission"), featureModule: table("feature"), rolePermission: table("role") }
  await seedRegistry(db, [{ source: "other" }, { source: "chetaidou.ideation" }], { "tool.ai_creative_studio.chetaidou": [{ id: 7 }] })
  assert.deepEqual(calls.filter(([name]) => name === "feature").map(([, p]) => p.create.source), ["chetaidou.ideation"])
  assert.equal(calls.filter(([name]) => name === "role").length, 1)
  for (const [, params] of calls) assert.deepEqual(params.update, {})
})

test("数据包拒绝路径越界和指向外部文件的符号链接", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chetaidou-import-"))
  try {
    await writeFile(path.join(root, "file.json"), "{}")
    assert.equal(await containedFile(root, "file.json"), await import("node:fs/promises").then(fs => fs.realpath(path.join(root, "file.json"))))
    await symlink("/etc/hosts", path.join(root, "outside"))
    await assert.rejects(containedFile(root, "outside"), /越界/)
    await assert.rejects(containedFile(root, "/etc/hosts"), /相对路径/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("图片 URL 仅解析当前桶/CDN 的对象路径，不使用外部地址或保存签名", () => {
  const config = { bucket: "assets", endpoint: "https://nyc3.digitaloceanspaces.com", baseUrl: "https://cdn.example.com/static" }
  assert.equal(uploadedImageKey("https://assets.nyc3.digitaloceanspaces.com/a%20b.png?signature=secret", config), "a b.png")
  assert.equal(uploadedImageKey("https://assets.nyc3.cdn.digitaloceanspaces.com/a.png", config), "a.png")
  assert.equal(uploadedImageKey("https://nyc3.digitaloceanspaces.com/assets/a.png", config), "a.png")
  assert.equal(uploadedImageKey("https://cdn.example.com/static/a.png", config), "a.png")
  for (const value of ["https://other.nyc3.digitaloceanspaces.com/a.png", "https://other.nyc3.cdn.digitaloceanspaces.com/a.png", "https://cdn.example.com/static-other/a.png", "https://assets.nyc3.digitaloceanspaces.com.evil.test/a.png", "https://user:pass@assets.nyc3.digitaloceanspaces.com/a.png", "file:///tmp/a.png"]) {
    assert.throws(() => uploadedImageKey(value, config), /URL/)
  }
  assert.throws(() => uploadedImageKey("https://cdn.example.com/static/a%2F..%2Fb.png", config), /路径/)
})

async function sourceFixture(root) {
  const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: "white" } }).png().toBuffer()
  const checksum = digest(bytes)
  await mkdir(path.join(root, "data/studio/breakdowns"), { recursive: true })
  await mkdir(path.join(root, "docs"), { recursive: true })
  const document = "CS1plus 真实商品资料"
  await writeFile(path.join(root, "docs/c1splus-library-preparation.md"), document)
  const manifest = {
    version: 1, sku: { code: "CS1plus", name: "C1S Plus" }, imageCount: 1,
    catalogFile: "data/catalog.json", breakdownsDir: "data/studio/breakdowns",
    factsFile: "docs/c1splus-library-preparation.md", factCardFile: "facts.json",
    breakdownAcceptance: acceptance,
  }
  const card = { schemaVersion: 1, skuCode: "CS1plus", content: {
    scope: "测试资料", hardConstraints: ["保留已确认结构"], dataIsolationRules: ["图上型号文字仅为观察"],
    conditionalRules: [], imageReferences: [], unknowns: [],
    provenance: { sourcePath: manifest.factsFile, sourceHash: digest(document), sourceDate: "2026-09-27", rulesDate: "2026-10-07" },
  } }
  manifest.factCardHash = jsonHash(card)
  await writeFile(path.join(root, "facts.json"), JSON.stringify(card))
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest))
  await writeFile(path.join(root, "data/image.png"), bytes)
  await writeFile(path.join(root, "data/catalog.json"), JSON.stringify({ images: [{ id: "img-test", title: "测试", number: "1", sourceType: "preset", originalAcceptance: "approved", file: "data/image.png", sha256: checksum, width: 2, height: 3, mime: "image/png" }] }))
  await writeFile(path.join(root, "data/studio/breakdowns/img-test.json"), JSON.stringify({ ...raw, sourceHash: checksum }))
  return bytes
}

test("URL 资料目录不复制原图；读回图片做完整校验并与本地方式得到相同事实卡", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chetaidou-url-"))
  try {
    const source = path.join(root, "source"), remote = path.join(root, "remote"), local = path.join(root, "local")
    const bytes = await sourceFixture(source)
    await packBundle(source, remote, { imageUrls: { "img-test": "https://assets.example.com/original.png?signature=secret" } })
    await assert.rejects(access(path.join(remote, "data/image.png")), { code: "ENOENT" })
    const catalog = JSON.parse(await readFile(path.join(remote, "data/catalog.json"), "utf8"))
    assert.equal(catalog.images[0].file, undefined)
    assert.equal(catalog.images[0].url, "https://assets.example.com/original.png")
    const uploaded = await loadBundle(remote, validateBreakdownOutput, { readUploadedImage: async () => ({ key: "original.png", bytes }) })
    await packBundle(source, local)
    const original = await loadBundle(local, validateBreakdownOutput)
    assert.equal(uploaded.images[0].checksum, original.images[0].checksum)
    assert.deepEqual(uploaded.images[0].payload, original.images[0].payload)
    assert.equal(uploaded.factsHash, original.factsHash)
    assert.equal(uploaded.factsHash, jsonHash(uploaded.facts))
    assert.deepEqual(uploaded.facts.hardConstraints, ["保留已确认结构"])
    assert.deepEqual(uploaded.facts.dataIsolationRules, ["图上型号文字仅为观察"])
    const repacked = path.join(root, "repacked")
    await packBundle(remote, repacked)
    const again = await loadBundle(repacked, validateBreakdownOutput, { readUploadedImage: async () => ({ key: "original.png", bytes }) })
    assert.deepEqual(again.facts, uploaded.facts)
    assert.equal(uploaded.images[0].uploadedKey, "original.png")
    await assert.rejects(loadBundle(remote, validateBreakdownOutput, { readUploadedImage: async () => ({ key: "original.png", bytes: Buffer.from("被替换的图片") }) }), /哈希不一致/)
    await assert.rejects(loadBundle(remote, validateBreakdownOutput, { readUploadedImage: async () => { throw new Error("图片不存在") } }), /图片不存在/)
    await assert.rejects(packBundle(source, path.join(root, "incomplete"), { imageUrls: {} }), /缺少图片 URL/)
    catalog.images[0].objectKey = "different.png"
    await writeFile(path.join(remote, "data/catalog.json"), JSON.stringify(catalog))
    await assert.rejects(loadBundle(remote, validateBreakdownOutput, { readUploadedImage: async () => ({ key: "original.png", bytes }) }), /URL 与 objectKey 不一致/)
    catalog.images[0].file = "data/image.png"
    await writeFile(path.join(remote, "data/catalog.json"), JSON.stringify(catalog))
    await assert.rejects(loadBundle(remote, validateBreakdownOutput), /只提供 file 或 url/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("已上传原图直接复用对象 key，不重复上传；重复初始化不写库也不生成缩略图", async () => {
  const db = database(), ctx = await ensureFacts(db, bundle, 123)
  let originalUploads = 0, thumbnails = 0
  const bytes = Buffer.from("已在 loadBundle 校验的原图")
  const remoteItem = { ...item, file: undefined, uploadedKey: "uploads/original.jpg", bytes }
  const cloud = {
    ensureFile: async () => { originalUploads++ },
    ensureThumbnail: async (key, file, source) => { thumbnails++; assert.equal(file, undefined); assert.equal(source, bytes); return `${key}.thumbnail.webp` },
  }
  await importImage(db, cloud, ctx, remoteItem, 123)
  await importImage(db, cloud, ctx, remoteItem, 123)
  assert.equal(originalUploads, 0)
  assert.equal(thumbnails, 1)
  assert.equal(db.state.images.length, 1)
  assert.equal(db.state.breakdowns.length, 1)
  assert.equal(db.state.images[0].fileKey, remoteItem.uploadedKey)
  assert.equal(db.state.images[0].sourceMetadata.thumbnailKey, "uploads/original.jpg.thumbnail.webp")
})

test("不扫描或迁移旧演示记录，旧记录原样保留", async () => {
  const db = database(), ctx = await ensureFacts(db, bundle, 123)
  const legacy = { id: 9, skuId: 1, ownerId: null, sourceType: "PRESET", importKey: "proto-demo:img-test", checksum: "hash", fileKey: "old.jpg", currentBreakdownId: null, enabled: true }
  db.state.images.push(structuredClone(legacy))
  await importImage(db, storage, ctx, item, 123)
  assert.deepEqual(db.state.images[0], legacy)
  assert.equal(db.state.images.length, 2)
  assert.equal(db.state.images[1].importKey, "chetaidou:seed:CS1plus:img-test")
})

test("已有初始化记录缺少拆解或缩略图时报错，不补齐、不上传", async () => {
  for (const missing of ["breakdown", "thumbnail"]) {
    const db = database(), ctx = await ensureFacts(db, bundle, 123)
    await importImage(db, storage, ctx, item, 123)
    if (missing === "breakdown") db.state.images[0].currentBreakdownId = null
    else db.state.images[0].sourceMetadata = { note: "保留" }
    const before = structuredClone(db.state)
    await assert.rejects(importImage(db, { ensureFile: assert.fail, ensureThumbnail: assert.fail }, ctx, item, 123), /不会补齐/)
    assert.deepEqual(db.state, before)
  }
})

test("模型初始化只创建新配置，不更新或停用已有模型", async () => {
  const rows = [{ publicId: "general", category: "MULTIMODAL", enabled: true }]
  const db = {
    $transaction: fn => fn(db),
    aiGatewayModel: {
      findMany: async ({ where }) => rows.filter(row => row.category === where.category && row.enabled && row.publicId !== where.publicId.not),
      findUnique: async ({ where }) => rows.find(row => row.category === where.publicId_category.category && row.publicId === where.publicId_category.publicId),
      create: async ({ data }) => { rows.push(structuredClone(data)); return data },
    },
  }
  const model = { category: "CHETAIDOU_MULTIMODAL", data: { publicId: "new", category: "CHETAIDOU_MULTIMODAL", enabled: true } }
  await saveModels(db, [model])
  const before = structuredClone(rows)
  await saveModels(db, [{ category: model.category, existing: rows[1] }])
  assert.deepEqual(rows, before)
  await saveModels(db, [{ ...model, data: { ...model.data, publicId: "another" } }])
  assert.deepEqual(rows.slice(0, before.length), before)
  assert.equal(rows.length, before.length + 1)
  await assert.rejects(saveModels(db, [model]), /发生变化/)
  assert.deepEqual(rows.slice(0, before.length), before)
})

test("内置默认资料覆盖全部 25 张母版，URL 哈希与拆解一致且不分发附件令牌或原图路径", async () => {
  const root = fileURLToPath(new URL("./preset-data/", import.meta.url))
  const manifest = JSON.parse(await readFile(await containedFile(root, "manifest.json"), "utf8"))
  const catalog = JSON.parse(await readFile(await containedFile(root, manifest.catalogFile), "utf8"))
  const facts = await readFile(await containedFile(root, manifest.factsFile), "utf8")
  const report = JSON.parse(await readFile(await containedFile(root, "upload-report.json"), "utf8"))
  assert.equal(manifest.imageCount, 25)
  assert.equal(catalog.images.length, 25)
  assert.equal(new Set(catalog.images.map(i => i.id)).size, 25)
  assert.equal(report.imageCount, 25)
  assert.ok(facts.length > 0 && !facts.includes("开发联调占位 facts"))
  for (const entry of catalog.images) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/)
    assert.equal(entry.file, undefined)
    assert.equal(entry.recordId, undefined)
    assert.equal(entry.fileToken, undefined)
    assert.equal(new URL(entry.url).origin, "https://erp-pro.nyc3.cdn.digitaloceanspaces.com")
    assert.equal(new URL(entry.url).search, "")
    assert.equal(uploadedImageKey(entry.url, { bucket: "erp-pro", endpoint: "https://nyc3.digitaloceanspaces.com" }), entry.objectKey)
    assert.ok(entry.objectKey.startsWith(`chetaidou/preset-library/CS1plus/${entry.id}/`))
    assert.equal(report.images[entry.id].key, entry.objectKey)
    assert.equal(report.images[entry.id].sha256, entry.sha256)
    assert.equal(report.images[entry.id].publicUrl, entry.url)
    assert.equal(report.images[entry.id].acl, "public-read")
    assert.ok(report.images[entry.id].verifiedAt)
    const raw = JSON.parse(await readFile(await containedFile(root, `${manifest.breakdownsDir}/${entry.id}.json`), "utf8"))
    assert.equal(raw.imageId, entry.id)
    normalizeBreakdown(raw, entry.sha256, validateBreakdownOutput)
  }
})


test("全量内置资料初始化到空库：完整结构化事实卡和文档/25 母版及拆解/权限和来源，重跑不变且不依赖 SKU ID", async () => {
  const root = fileURLToPath(new URL("./preset-data/", import.meta.url))
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"))
  const catalog = JSON.parse(await readFile(path.join(root, manifest.catalogFile), "utf8"))
  const document = await readFile(path.join(root, manifest.factsFile), "utf8")
  const fullBundle = { manifest, ...await loadFacts(root, manifest) }
  const db = database(73)
  const registry = { permissionGroup: [], permission: [], rolePermission: [], featureModule: [] }
  for (const [name, rows] of Object.entries(registry)) db[name] = { upsert: async ({ where, create }) => {
    const existing = rows.find(row => Object.entries(where).every(([key, value]) => row[key] === value))
    if (existing) return existing
    const row = { id: rows.length + 1, ...create }
    rows.push(row)
    return row
  } }
  let before
  for (let run = 0; run < 2; run++) {
    await seedRegistry(db, FEATURE_MODULE_DEFINITIONS, {})
    const ctx = await ensureFacts(db, fullBundle, 0)
    const results = []
    for (const entry of catalog.images) {
      const raw = JSON.parse(await readFile(path.join(root, manifest.breakdownsDir, `${entry.id}.json`), "utf8"))
      const imported = { entry, raw, checksum: entry.sha256, width: entry.width, height: entry.height, mime: entry.mime, uploadedKey: entry.objectKey, ...normalizeBreakdown(raw, entry.sha256, validateBreakdownOutput) }
      results.push(await importImage(db, run === 0 ? storage : { ensureFile: assert.fail, ensureThumbnail: assert.fail }, ctx, imported, 0))
    }
    await activateSku(db, ctx, results.map(result => result.id))
    if (run === 0) before = structuredClone({ state: db.state, registry })
    else assert.deepEqual({ state: db.state, registry }, before)
  }
  assert.equal(db.state.sku.code, "CS1plus")
  assert.equal(db.state.sku.enabled, true)
  assert.equal(db.state.facts.length, 1)
  assert.equal(db.state.facts[0].content.document, document)
  assert.equal(db.state.facts[0].version, 1)
  assert.equal(db.state.facts[0].skuId, 73)
  assert.equal(db.state.facts[0].contentHash, jsonHash(db.state.facts[0].content))
  const facts = db.state.facts[0].content
  assert.equal(productHardConstraints(facts).length, 5)
  assert.equal(facts.dataIsolationRules.length, 3)
  assert.equal(facts.conditionalRules.length, 5)
  assert.equal(facts.imageReferences.length, 2)
  assert.equal(facts.unknowns.length, 4)
  assert.equal(facts.hardConstraints[0], "保持当前 SKU 已确认的真实部件数量、连接关系、几何和外观身份。")
  assert.ok(facts.dataIsolationRules.some(rule => rule.includes("不能仅凭该字样判定跨 SKU 混用或阻断编辑")))
  for (const key of ["repairKey", "previousRepairKey", "previousFactId", "previousVersion"]) assert.equal(facts.provenance[key], undefined)
  assert.equal(db.state.images.length, 25)
  assert.equal(db.state.breakdowns.length, 25)
  for (const image of db.state.images) {
    assert.equal(image.ownerId, null)
    assert.equal(image.createdBy, 0)
    assert.ok(image.sourceMetadata.thumbnailKey)
    assert.equal(db.state.breakdowns.find(row => row.id === image.currentBreakdownId).imageId, image.id)
    const breakdown = db.state.breakdowns.find(row => row.id === image.currentBreakdownId)
    assert.equal(breakdown.factId, db.state.facts[0].id)
    assert.equal(breakdown.qualityStatus, "CONFIRMED")
    assert.equal(breakdown.source, "PRESET")
    assert.equal(breakdown.confirmedBy, 0)
    assert.ok(breakdown.confirmedAt instanceof Date)
    assert.deepEqual(breakdown.sourceMetadata.acceptance, manifest.breakdownAcceptance)
  }
  assert.deepEqual(registry.permission.map(row => row.key), ["tool.ai_creative_studio.chetaidou", "management.chetaidou"])
  assert.deepEqual(registry.featureModule.map(row => row.source).sort(), ["chetaidou.breakdown", "chetaidou.compose", "chetaidou.diverge", "chetaidou.ideation", "chetaidou.image"])
})
