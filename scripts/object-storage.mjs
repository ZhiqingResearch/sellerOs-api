/** 脚本与服务共用同一个适配器/配置；先 npm run build。 */
import { S3Client } from "@aws-sdk/client-s3"
import OSS from "ali-oss"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import sharp from "sharp"
import { configureCors, validateOrigins } from "./chetaidou/storage.mjs"

const require = createRequire(import.meta.url)
export function createStorage(env = process.env) {
  const { StorageService } = require("../dist/storage/storage.service.js")
  const { ConfigService } = require("@nestjs/config")
  return new StorageService(new ConfigService(env))
}
export function initializerStorage(storage, digest) {
  return {
    async ensureFile(key, file, mime, checksum, uploadedBytes) {
      if (await storage.objectExists(key)) {
        const head = await storage.getObjectMetadata(key)
        // 验证实际字节，不能把同名的未知对象当成已上传资料。
        if ((head.metadata?.sha256 ?? digest(await storage.downloadBuffer(key))) !== checksum)
          throw new Error("对象存储文件哈希不匹配")
        return
      }
      const bytes = uploadedBytes ?? (await readFile(file))
      if (digest(bytes) !== checksum) throw new Error("图片在校验后被修改，已停止上传")
      await storage.uploadBuffer(bytes, key, mime, "private", { sha256: checksum })
    },
    async ensureThumbnail(key, file, uploadedBytes) {
      const thumbnailKey = `${key}.thumbnail.webp`
      if (!(await storage.objectExists(thumbnailKey))) {
        const bytes = uploadedBytes ?? (await readFile(file))
        const body = await sharp(bytes, { limitInputPixels: false })
          .rotate()
          .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer()
        await storage.uploadBuffer(body, thumbnailKey, "image/webp", "private")
      }
      return thumbnailKey
    },
  }
}
export async function configureStorageCors(env = process.env, origins = [], apply = false) {
  validateOrigins(origins)
  const provider = env.STORAGE_PROVIDER || "oss"
  if (provider === "spaces") {
    const client = new S3Client({
      endpoint: env.SPACES_ENDPOINT,
      region: env.SPACES_REGION || "us-east-1",
      credentials: { accessKeyId: env.SPACES_KEY, secretAccessKey: env.SPACES_SECRET },
    })
    try {
      return await configureCors(client, env.SPACES_BUCKET, origins, apply)
    } finally {
      client.destroy()
    }
  }
  if (provider !== "oss") throw new Error("STORAGE_PROVIDER 只能为 oss 或 spaces")
  const client = new OSS({
    accessKeyId: env.OSS_ACCESS_KEY_ID,
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
    region: env.OSS_REGION,
    bucket: env.OSS_BUCKET,
    endpoint: env.OSS_ENDPOINT || undefined,
    secure: true,
    authorizationV4: true,
  })
  let rules
  try {
    rules = (await client.getBucketCORS(env.OSS_BUCKET)).rules ?? []
  } catch (error) {
    if (error.code !== "NoSuchCORSConfiguration") throw error
    rules = []
  }
  const values = value => (Array.isArray(value) ? value : value ? [value] : [])
  let changed = false
  for (const origin of new Set(origins)) {
    if (
      !rules.some(
        rule =>
          values(rule.allowedOrigin).includes(origin) &&
          ["GET", "HEAD", "PUT", "POST"].every(method =>
            values(rule.allowedMethod).includes(method)
          )
      )
    ) {
      rules.push({
        allowedOrigin: [origin],
        allowedMethod: ["GET", "HEAD", "PUT", "POST"],
        allowedHeader: ["*"],
        exposeHeader: ["Content-Disposition", "ETag"],
        maxAgeSeconds: 3600,
      })
      changed = true
    }
  }
  if (changed && apply) await client.putBucketCORS(env.OSS_BUCKET, rules)
  return { rules, changed, applied: changed && apply }
}
