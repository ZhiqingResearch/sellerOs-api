import test from "node:test"
import assert from "node:assert/strict"
import { ensureThumbnail, configureCors } from "./storage.mjs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

test("跨域预览不写入，正式执行保留已有规则且重跑无重复", async () => {
  let rules = [{ AllowedOrigins: ["https://old.example.com"], AllowedMethods: ["PUT"], AllowedHeaders: ["*"] }]
  let writes = 0
  const s3 = { send: async command => {
    if (command.constructor.name === "GetBucketCorsCommand") return { CORSRules: structuredClone(rules) }
    assert.equal(command.constructor.name, "PutBucketCorsCommand")
    writes++
    rules = structuredClone(command.input.CORSConfiguration.CORSRules)
  } }
  const old = structuredClone(rules[0])
  const origins = ["https://new.example.com", "https://new.example.com"]
  assert.equal((await configureCors(s3, "bucket", origins)).changed, true)
  assert.equal(writes, 0)
  assert.equal(rules.length, 1)
  assert.equal((await configureCors(s3, "bucket", origins, true)).applied, true)
  assert.equal(writes, 1)
  assert.deepEqual(rules[0], old)
  assert.deepEqual(rules[1].AllowedMethods, ["GET", "HEAD"])
  assert.equal((await configureCors(s3, "bucket", origins, true)).changed, false)
  assert.equal(writes, 1)
  await assert.rejects(configureCors(s3, "bucket", ["https://new.example.com/path"], true), /不带路径/)
  assert.equal(writes, 1)
})

test("新母版缩略图为私有对象，已生成的文件直接复用", async () => {
  const bytes = await sharp({ create: { width: 512, height: 256, channels: 3, background: "red" } }).png().toBuffer()
  let exists = false, writes = 0
  const s3 = { send: async command => {
    if (command.constructor.name === "HeadObjectCommand") {
      if (!exists) throw { $metadata: { httpStatusCode: 404 } }
      return {}
    }
    assert.equal(command.constructor.name, "PutObjectCommand")
    assert.equal(command.input.ACL, "private")
    assert.equal(command.input.ContentType, "image/webp")
    const info = await sharp(command.input.Body).metadata()
    assert.equal(info.width, 256)
    assert.equal(info.height, 128)
    exists = true
    writes++
  } }
  assert.equal(await ensureThumbnail(s3, "bucket", "new.png", async () => bytes), "new.png.thumbnail.webp")
  assert.equal(await ensureThumbnail(s3, "bucket", "new.png", assert.fail), "new.png.thumbnail.webp")
  assert.equal(writes, 1)
})

test("统一入口帮助可运行，互斥或无效模式在连接外部服务前拒绝", () => {
  const entry = fileURLToPath(new URL("../init-chetaidou-production.mjs", import.meta.url))
  const run = args => spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" }, timeout: 10000 })
  const help = run(["--help"])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /不迁移权限、不扫描历史图片/)
  for (const args of [
    ["--maintenance-only"],
    ["--replace-facts"],
    ["--maintenance-only", "--enable"],
    ["--maintenance-only", "--text-model=test"],
    ["--models-only"],
    ["--models-only", "--check-cors"],
    ["--check-data", "--pack-from=test"],
    ["--allow-origin=https://example.com/path"],
    ["--apply"],
  ]) {
    const result = run(args)
    assert.equal(result.status, 1, result.stderr)
    assert.doesNotMatch(result.stderr, /缺少环境变量 DATABASE_URL/)
  }
})
