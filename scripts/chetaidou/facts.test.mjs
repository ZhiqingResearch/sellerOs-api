import assert from "node:assert/strict"
import { test } from "node:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { jsonHash, loadBundle, loadFacts, packBundle } from "./data.mjs"

const builtin = fileURLToPath(new URL("./preset-data/", import.meta.url))
const read = async file => JSON.parse(await readFile(file, "utf8"))

test("初始化事实卡完整保留正式资料包和来源文档，资料隔离与结构硬约束分开且不携带迁移信息", async () => {
  const manifest = await read(path.join(builtin, "manifest.json"))
  const { facts, factsHash } = await loadFacts(builtin, manifest)
  const card = await read(path.join(builtin, manifest.factCardFile))
  const { document, ...content } = facts
  assert.deepEqual(content, card.content)
  assert.equal(facts.hardConstraints[0], "保持当前 SKU 已确认的真实部件数量、连接关系、几何和外观身份。")
  assert.ok(facts.dataIsolationRules.some(rule => rule.includes("不能仅凭该字样判定跨 SKU 混用或阻断编辑")))
  assert.ok(facts.hardConstraints.every(rule => !rule.includes("不混用 C1S")))
  assert.equal(document, await readFile(path.join(builtin, manifest.factsFile), "utf8"))
  assert.deepEqual(Object.keys(facts.provenance).sort(), ["rulesDate", "sourceDate", "sourceHash", "sourcePath"])
  assert.equal(factsHash, jsonHash(facts))
})

test("缺失/损坏/跨 SKU/旧结构或来源不一致的事实卡，在读图片和写库之前拒绝", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chetaidou-facts-"))
  try {
    const original = await read(path.join(builtin, "manifest.json"))
    const originalCard = await read(path.join(builtin, original.factCardFile))
    const cases = [
      { change: m => { delete m.breakdownAcceptance }, error: /缺少母版及拆解的已确认记录/ },
      { change: m => { m.breakdownAcceptance.status = "ai_unreviewed" }, error: /已确认记录/ },
      { change: m => { delete m.factCardFile }, error: /缺少结构化事实卡/ },
      { change: m => { delete m.factCardHash }, error: /缺少结构化事实卡/ },
      { change: m => { m.factCardFile = "missing.json" }, error: /ENOENT/ },
      { change: (_m, c) => { c.content.hardConstraints.push("未经核对的规则") }, error: /哈希不一致/ },
      { change: (_m, c) => { c.skuCode = "other" }, hash: true, error: /SKU 归属/ },
      { change: (_m, c) => { c.schemaVersion = 0 }, hash: true, error: /版本/ },
      { change: (_m, c) => { delete c.content.hardConstraints }, hash: true, error: /字段不完整/ },
      { change: (_m, c) => { c.content.hardConstraints = [] }, hash: true, error: /字段不完整/ },
      { change: (_m, c) => { delete c.content.dataIsolationRules }, hash: true, error: /字段不完整/ },
      { change: (_m, c) => { delete c.content.conditionalRules }, hash: true, error: /字段不完整/ },
      { change: (_m, c) => { delete c.content.imageReferences }, hash: true, error: /字段不完整/ },
      { change: (_m, c) => { delete c.content.unknowns }, hash: true, error: /字段不完整/ },
      { change: (_m, c) => { c.content.provenance.sourcePath = "other.md" }, hash: true, error: /来源文档不匹配/ },
      { change: () => {}, document: "源文档已被修改", error: /来源文档不匹配/ },
    ]
    for (const scenario of cases) {
      await cp(builtin, root, { recursive: true })
      const manifest = structuredClone(original), card = structuredClone(originalCard)
      scenario.change(manifest, card)
      if (scenario.hash) manifest.factCardHash = jsonHash(card)
      await writeFile(path.join(root, original.factCardFile), JSON.stringify(card))
      await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest))
      if (scenario.document) await writeFile(path.join(root, manifest.factsFile), scenario.document)
      await assert.rejects(loadBundle(root, assert.fail, { readUploadedImage: assert.fail }), scenario.error)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("原型目录重新打包时携带已核对事实卡；来源变化不能悄悄沿用规则", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chetaidou-pack-facts-"))
  try {
    const source = path.join(root, "source"), destination = path.join(root, "bundle")
    await cp(builtin, source, { recursive: true })
    const manifest = await read(path.join(source, "manifest.json"))
    await rm(path.join(source, "manifest.json"))
    await rm(path.join(source, manifest.factCardFile))
    await packBundle(source, destination)
    const packed = await read(path.join(destination, "manifest.json"))
    assert.equal(packed.imageCount, 25)
    assert.deepEqual(await loadFacts(destination, packed), await loadFacts(builtin, manifest))
    await writeFile(path.join(source, manifest.factsFile), "已变更的商品资料")
    await assert.rejects(packBundle(source, path.join(root, "invalid")), /来源文档不匹配/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
