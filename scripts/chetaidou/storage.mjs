/** 全量初始化用的缩略图与可选跨域配置，不扫描或修改历史图片。 */
import sharp from "sharp"
import { GetBucketCorsCommand, PutBucketCorsCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"

export async function ensureThumbnail(s3, bucket, key, bytes) {
  const thumbnailKey = `${key}.thumbnail.webp`
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: thumbnailKey })); return thumbnailKey }
  catch (error) { if (error.$metadata?.httpStatusCode !== 404) throw error }
  const image = typeof bytes === "function" ? await bytes() : bytes
  const body = await sharp(image, { limitInputPixels: false }).rotate().resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: thumbnailKey, Body: body, ContentType: "image/webp", ACL: "private" }))
  return thumbnailKey
}

export function validateOrigins(origins = []) {
  for (const origin of origins) {
    const url = new URL(origin)
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== origin) throw new Error("allow-origin 必须是完整且不带路径的 HTTP(S) 域名")
  }
}

export async function configureCors(s3, bucket, origins = [], apply = false) {
  validateOrigins(origins)
  let rules
  try { rules = (await s3.send(new GetBucketCorsCommand({ Bucket: bucket }))).CORSRules ?? [] }
  catch (error) { if (!["NoSuchCORSConfiguration", "NoSuchCORS"].includes(error.name)) throw error; rules = [] }
  let changed = false
  for (const origin of new Set(origins)) {
    if (!rules.some(r => r.AllowedOrigins?.includes(origin) && ["GET", "HEAD"].every(m => r.AllowedMethods?.includes(m)))) {
      rules.push({ AllowedOrigins: [origin], AllowedMethods: ["GET", "HEAD"], AllowedHeaders: ["*"], ExposeHeaders: ["Content-Disposition", "ETag"], MaxAgeSeconds: 3600 })
      changed = true
    }
  }
  if (apply && changed) await s3.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: rules } }))
  return { rules, changed, applied: apply && changed }
}
