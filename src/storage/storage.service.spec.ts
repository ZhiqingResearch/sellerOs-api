import { ConfigModule, ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import OSS from "ali-oss"
import { createHash } from "node:crypto"
import { access, readFile } from "node:fs/promises"
import { Readable } from "node:stream"
import { createModerationScope, moderationScope } from "../content-moderation/moderation-scope"
import { OssModule } from "../oss/oss.module"
import { OssService } from "../oss/oss.service"
import { SpacesModule } from "../spaces/spaces.module"
import { SpacesService } from "../spaces/spaces.service"
import { OssAdapter } from "./oss.adapter"
import { SpacesAdapter } from "./spaces.adapter"
import { StorageService } from "./storage.service"

const settings = {
  OSS_ACCESS_KEY_ID: "test-id",
  OSS_ACCESS_KEY_SECRET: "test-secret",
  OSS_REGION: "oss-cn-hangzhou",
  OSS_BUCKET: "test-bucket",
  OSS_BASE_URL: "https://oss.example/assets",
  SPACES_BASE_URL: "https://spaces.example",
  SPACES_BUCKET: "test-space",
}
const config = (values = {}) => new ConfigService({ ...settings, ...values })

afterEach(() => jest.restoreAllMocks())

it("默认 OSS，Spaces 明确配置才切换，不操作另一桶", async () => {
  const oss = jest.spyOn(OssAdapter.prototype, "uploadBuffer").mockResolvedValue("oss-url")
  const spaces = jest.spyOn(SpacesAdapter.prototype, "uploadBuffer").mockResolvedValue("spaces-url")
  await expect(
    new StorageService(config()).uploadBuffer(Buffer.from("a"), "uploads/a", "image/png")
  ).resolves.toBe("oss-url")
  expect(spaces).not.toHaveBeenCalled()
  await expect(
    new StorageService(config({ STORAGE_PROVIDER: "spaces" })).uploadBuffer(
      Buffer.from("a"),
      "uploads/a",
      "image/png"
    )
  ).resolves.toBe("spaces-url")
  expect(oss).toHaveBeenCalledTimes(1)
})

it("无效 provider 拒绝；未使用 provider 不需要密钥", () => {
  expect(() => new StorageService(config({ STORAGE_PROVIDER: "s3" }))).toThrow("STORAGE_PROVIDER")
  expect(() => new StorageService(new ConfigService({ STORAGE_PROVIDER: "spaces" }))).not.toThrow()
})

it.each([
  "content-moderation/snapshots/a",
  "aigc/videos/a",
  "portrait-results/a",
  "chetaidou/generations/a",
  "uploads/../a",
  "uploads/%2e%2e/a",
  "uploads/\u0000a",
])("客户端不能覆盖保护目录或使用别名：%s", async key => {
  await expect(new StorageService(config()).generateUploadUrl({ key })).rejects.toThrow()
})

it("实际 OSS SDK 本地 V4 签名绑定 ACL、metadata、MIME 和长度，key不变", async () => {
  const storage = new StorageService(config())
  const ticket = await storage.generateUploadUrl({
    key: "uploads/a.png",
    contentType: "image/png",
    contentLength: 42,
    acl: "private",
    metadata: { "owner-id": "7", "aigc-label": "1" },
  })
  expect(ticket.key).toBe("uploads/a.png")
  expect(ticket.headers).toEqual({
    "x-oss-object-acl": "private",
    "x-oss-meta-owner-id": "7",
    "x-oss-meta-aigc-label": "1",
    "Content-Type": "image/png",
    "Content-Length": "42",
  })
  const url = new URL(ticket.uploadUrl)
  expect(url.protocol).toBe("https:")
  expect(url.searchParams.get("x-oss-signature-version")).toBe("OSS4-HMAC-SHA256")
  expect(url.searchParams.get("x-oss-additional-headers")).toBe("content-length")
  expect(ticket.publicUrl).toBe("https://oss.example/assets/uploads/a.png")
  const signed = new URL(await storage.generateSignedDownloadUrl("private/a", 120, "中文.png"))
  expect(signed.searchParams.get("response-content-disposition")).toContain(
    "filename*=UTF-8''%E4%B8%AD%E6%96%87.png"
  )
})

it("OSS上传保持私有 ACL、AIGC metadata、Range 读取和流式上传", async () => {
  const put = jest.spyOn(OSS.prototype, "put").mockResolvedValue({} as never)
  const get = jest
    .spyOn(OSS.prototype, "get")
    .mockResolvedValue({ content: Buffer.from("range") } as never)
  const stream = jest.spyOn(OSS.prototype, "putStream").mockResolvedValue({} as never)
  const storage = new StorageService(config())
  await storage.uploadBuffer(Buffer.from("data"), "private/a", "image/png", "private", {
    "aigc-label": "1",
  })
  expect(put).toHaveBeenCalledWith(
    "private/a",
    Buffer.from("data"),
    expect.objectContaining({
      headers: { "x-oss-object-acl": "private", "x-oss-meta-aigc-label": "1" },
    })
  )
  await expect(storage.downloadBuffer("private/a", "bytes=0-32")).resolves.toEqual(
    Buffer.from("range")
  )
  expect(get).toHaveBeenCalledWith("private/a", { headers: { Range: "bytes=0-32" } })
  const body = Readable.from("video")
  await storage.uploadStream(body, "video/a", "video/mp4", 5)
  expect(stream).toHaveBeenCalledWith(
    "video/a",
    body,
    expect.objectContaining({ contentLength: 5, mime: "video/mp4" })
  )
})

it("HEAD 仅404为不存在，权限/网络错误不得吞掉", async () => {
  const head = jest.spyOn(OSS.prototype, "head")
  const storage = new StorageService(config())
  head.mockRejectedValueOnce({ status: 404 })
  await expect(storage.objectExists("a")).resolves.toBe(false)
  head.mockRejectedValueOnce({ status: 403 })
  await expect(storage.objectExists("a")).rejects.toMatchObject({ status: 403 })
  head.mockRejectedValueOnce(new Error("network"))
  await expect(storage.objectExists("a")).rejects.toThrow("network")
})

it("URL 只读取当前配置边界，双域排除不读取或迁移旧桶", async () => {
  const head = jest
    .spyOn(OssAdapter.prototype, "getObjectMetadata")
    .mockResolvedValue({ contentLength: 5, contentType: "image/png", metadata: {} })
  const storage = new StorageService(config())
  await expect(
    storage.getPublicObjectMetadata("https://oss.example/assets/own/a")
  ).resolves.toMatchObject({ key: "own/a" })
  for (const url of [
    "https://oss.example.evil/assets/own/a",
    "https://oss.example/assets-evil/a",
    "https://spaces.example/a",
    "https://oss.example/assets/%2e%2e/a",
  ])
    await expect(storage.getPublicObjectMetadata(url)).rejects.toThrow()
  expect(head).toHaveBeenCalledTimes(1)
  expect(storage.isManagedUrl("https://spaces.example/a")).toBe(true)
  expect(storage.isManagedUrl("https://spaces.example.evil/a")).toBe(false)
})

it("OSS Policy 限制旧表单目录且保留返回结构", () => {
  const policy = new StorageService(config()).generateOSSPolicy()
  expect(policy.dir).toBe("uploads/legacy/")
  expect(
    (JSON.parse(Buffer.from(policy.policy, "base64").toString()) as { conditions: unknown[] })
      .conditions
  ).toContainEqual(["starts-with", "$key", "uploads/legacy/"])
})

it("审核注册与签名 alias 仍在同一请求作用域", async () => {
  jest.spyOn(OssAdapter.prototype, "uploadBuffer").mockResolvedValue("https://oss.example/assets/a")
  const scope = createModerationScope(() => Promise.resolve([]))
  scope.digests.add(createHash("sha256").update("image").digest("hex"))
  await moderationScope.run(scope, async () => {
    const storage = new StorageService(config())
    await storage.uploadBuffer(Buffer.from("image"), "a", "image/png", "private")
    const digest = moderationScope.getStore()!.objects.get("a")
    expect(digest).toBeTruthy()
    const url = await storage.generateSignedDownloadUrl("a")
    expect(scope.aliases.get(url)).toBe(digest)
  })
})

it("Nest旧DI入口与统一StorageService共享同一实例", async () => {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => settings], isGlobal: true }),
      SpacesModule,
      OssModule,
    ],
  }).compile()
  try {
    expect(module.get(SpacesService)).toBe(module.get(StorageService))
    const upload = jest
      .spyOn(module.get(StorageService), "uploadBuffer")
      .mockResolvedValue("shared")
    await expect(
      module.get(OssService).uploadBuffer(Buffer.from("a"), "a", "image/png")
    ).resolves.toBe("shared")
    expect(upload).toHaveBeenCalledTimes(1)
  } finally {
    await module.close()
  }
})

it("OSS 错误状态保持兼容，Range416与权限403可由调用方区分", async () => {
  const get = jest.spyOn(OSS.prototype, "get")
  const storage = new StorageService(config())
  get.mockRejectedValueOnce({ status: 416, code: "InvalidRange" })
  await expect(storage.downloadBuffer("crop/a", "bytes=0-32")).rejects.toMatchObject({
    status: 416,
    $metadata: { httpStatusCode: 416 },
  })
  get.mockRejectedValueOnce({ status: 403, code: "AccessDenied" })
  await expect(storage.downloadBuffer("crop/a")).rejects.toMatchObject({
    status: 403,
    $metadata: { httpStatusCode: 403 },
  })
})

it("Spaces未知长度流经临时文件上传并始终清理，不整段缓存到内存", async () => {
  let captured = ""
  jest.spyOn(SpacesAdapter.prototype, "uploadFile").mockImplementation(async (path, key, mime) => {
    captured = path
    expect(await readFile(path, "utf8")).toBe("streaming video")
    expect(key).toBe("video/a")
    expect(mime).toBe("video/mp4")
    return "https://spaces.example/video/a"
  })
  const storage = new StorageService(config({ STORAGE_PROVIDER: "spaces" }))
  await expect(
    storage.uploadStream(Readable.from("streaming video"), "video/a", "video/mp4")
  ).resolves.toBe("https://spaces.example/video/a")
  await expect(access(captured)).rejects.toMatchObject({ code: "ENOENT" })
})
