import OSS from "ali-oss"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import sharp from "sharp"
import { configureStorageCors, createStorage, initializerStorage } from "./object-storage.mjs"
const digest = bytes => createHash("sha256").update(bytes).digest("hex")

test("脚本默认OSS、可切换Spaces，未配置另一套也能构造", () => {
  assert.equal(createStorage({}).provider, "oss")
  assert.equal(createStorage({ STORAGE_PROVIDER: "spaces" }).provider, "spaces")
  assert.throws(() => createStorage({ STORAGE_PROVIDER: "wrong" }), /STORAGE_PROVIDER/)
})

test("初始化新资料始终确保当前桶对象，私有缩略图可重复执行且失败哈希不覆盖", async () => {
  const bytes = await sharp({ create: { width: 512, height: 256, channels: 3, background: "red" } })
    .png()
    .toBuffer()
  const objects = new Map(),
    writes = []
  const storage = initializerStorage(
    {
      objectExists: async key => objects.has(key),
      getObjectMetadata: async key => ({ metadata: objects.get(key).metadata }),
      downloadBuffer: async key => objects.get(key).bytes,
      uploadBuffer: async (body, key, mime, acl, metadata) => {
        objects.set(key, { bytes: body, metadata })
        writes.push({ key, mime, acl, metadata })
      },
    },
    digest
  )
  await storage.ensureFile("new/master.png", null, "image/png", digest(bytes), bytes)
  const key = await storage.ensureThumbnail("new/master.png", null, bytes)
  assert.equal(key, "new/master.png.thumbnail.webp")
  assert.equal(writes.length, 2)
  assert.equal(writes[0].acl, "private")
  assert.equal(writes[1].acl, "private")
  assert.equal((await sharp(objects.get(key).bytes).metadata()).width, 256)
  await storage.ensureFile("new/master.png", null, "image/png", digest(bytes), bytes)
  await storage.ensureThumbnail("new/master.png", null, bytes)
  assert.equal(writes.length, 2)
  await assert.rejects(
    storage.ensureFile("new/master.png", null, "image/png", "different", bytes),
    /哈希/
  )
  assert.equal(writes.length, 2)
})

test("OSS CORS预览不写、合并直传方法、重跑幂等", async t => {
  let rules = [{ allowedOrigin: ["https://old.example"], allowedMethod: ["GET"] }],
    writes = 0
  t.mock.method(OSS.prototype, "getBucketCORS", async () => ({ rules: structuredClone(rules) }))
  t.mock.method(OSS.prototype, "putBucketCORS", async (_bucket, value) => {
    rules = structuredClone(value)
    writes++
  })
  const env = {
    OSS_ACCESS_KEY_ID: "fake",
    OSS_ACCESS_KEY_SECRET: "fake",
    OSS_BUCKET: "test-bucket",
    OSS_REGION: "oss-cn-hangzhou",
  }
  assert.equal((await configureStorageCors(env, ["https://new.example"])).changed, true)
  assert.equal(writes, 0)
  await configureStorageCors(env, ["https://new.example"], true)
  assert.equal(writes, 1)
  assert.deepEqual(rules[0], { allowedOrigin: ["https://old.example"], allowedMethod: ["GET"] })
  assert.deepEqual(rules[1].allowedMethod, ["GET", "HEAD", "PUT", "POST"])
  assert.equal((await configureStorageCors(env, ["https://new.example"], true)).changed, false)
  assert.equal(writes, 1)
})

test("OSS CORS字符串Origin必须精确匹配，不把相似域名视为已授权", async t => {
  let added
  t.mock.method(OSS.prototype, "getBucketCORS", async () => ({
    rules: [
      { allowedOrigin: "https://site.example.evil", allowedMethod: ["GET", "HEAD", "PUT", "POST"] },
    ],
  }))
  t.mock.method(OSS.prototype, "putBucketCORS", async (_bucket, rules) => {
    added = rules
  })
  const env = {
    OSS_ACCESS_KEY_ID: "fake",
    OSS_ACCESS_KEY_SECRET: "fake",
    OSS_BUCKET: "test-bucket",
    OSS_REGION: "oss-cn-hangzhou",
  }
  assert.equal((await configureStorageCors(env, ["https://site.example"], true)).applied, true)
  assert.equal(added.length, 2)
  assert.deepEqual(added[1].allowedOrigin, ["https://site.example"])
})
