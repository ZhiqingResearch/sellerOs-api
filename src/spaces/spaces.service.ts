import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  type LifecycleRule,
  type ObjectCannedACL,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { createReadStream } from "fs"
import { stat } from "fs/promises"

/**
 * DigitalOcean Spaces 封装（S3 兼容协议）。
 * 参考：
 *   https://docs.digitalocean.com/products/spaces/how-to/use-aws-sdks/
 *   https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/
 *
 * 必需环境变量：
 *   SPACES_KEY            访问密钥
 *   SPACES_SECRET         访问密钥 secret
 *   SPACES_REGION         SigV4 签名 region，**固定填 "us-east-1"**（DO 文档要求；数据中心放在 endpoint）
 *   SPACES_ENDPOINT       完整 endpoint（数据中心代号写这里，如 https://nyc3.digitaloceanspaces.com）
 *   SPACES_BUCKET         Space 名（相当于 S3 bucket）
 *   SPACES_BASE_URL       公开访问根 URL（如 https://my-space.nyc3.digitaloceanspaces.com 或 CDN 域名）
 *
 * Spaces S3 兼容性要点：
 *   - 只支持两种 canned ACL：private / public-read
 *   - 支持 SigV4（推荐）和 SigV2
 *   - 新版 AWS SDK v3 默认开启 flexible-checksums 会注入 DO 不识别的 x-amz-checksum-* 头并算进签名，
 *     必须关掉（requestChecksumCalculation / responseChecksumValidation = "WHEN_REQUIRED"）
 */
@Injectable()
export class SpacesService {
  private readonly logger = new Logger(SpacesService.name)
  private readonly client: S3Client
  private readonly bucket: string
  private readonly baseUrl: string

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>("SPACES_BUCKET") || ""
    this.baseUrl = this.configService.get<string>("SPACES_BASE_URL") || ""

    this.client = new S3Client({
      endpoint: this.configService.get<string>("SPACES_ENDPOINT") || "",
      forcePathStyle: false,
      region: this.configService.get<string>("SPACES_REGION") || "us-east-1",
      credentials: {
        accessKeyId: this.configService.get<string>("SPACES_KEY") || "",
        secretAccessKey: this.configService.get<string>("SPACES_SECRET") || "",
      },
      requestHandler: { requestTimeout: 600_000 },
      // DigitalOcean Spaces 不识别 AWS SDK v3 默认开启的 flexible-checksums 头（x-amz-sdk-checksum-algorithm / x-amz-checksum-*），
      // 这些头会被算进签名 → DO 端按自己集合重算就 SignatureDoesNotMatch。
      // 关掉两个默认值即可。参考 GitHub aws-sdk-js-v3 issue#6810。
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    })
  }

  /** 上传 Buffer 到 Spaces，返回可公开访问 URL */
  async uploadBuffer(
    buffer: Buffer,
    key: string,
    mimeType: string,
    acl: ObjectCannedACL = "public-read"
  ): Promise<string> {
    const normalizedKey = this.normalizeKey(key)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: normalizedKey,
        Body: buffer,
        ContentType: mimeType,
        ACL: acl,
      })
    )
    const url = this.getPublicUrl(normalizedKey)
    this.logger.log(`Spaces 上传完成 [key=${normalizedKey}, size=${buffer.length}B]`)
    return url
  }

  /**
   * 以文件流方式上传本地文件，避免大文件在 Node.js 主线程中被完整读入内存。
   * 返回稳定的文件服务器 URL；调用方只需要将该 URL 持久化到业务表。
   */
  async uploadFile(
    filePath: string,
    key: string,
    mimeType: string,
    acl: ObjectCannedACL = "public-read"
  ): Promise<string> {
    const normalizedKey = this.normalizeKey(key)
    const metadata = await stat(filePath)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: normalizedKey,
        Body: createReadStream(filePath),
        ContentLength: metadata.size,
        ContentType: mimeType,
        ACL: acl,
      })
    )
    const url = this.getPublicUrl(normalizedKey)
    this.logger.log(`Spaces 文件上传完成 [key=${normalizedKey}, size=${metadata.size}B]`)
    return url
  }

  /**
   * 根据本服务生成的稳定公开 URL 读取对象内容。
   * 广告清洗状态接口用它实时解析 Excel 预览，不在应用进程中缓存文件或预览。
   */
  async downloadBufferByUrl(publicUrl: string): Promise<Buffer> {
    const metadata = await this.getPublicObjectMetadata(publicUrl)
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: metadata.key })
    )
    if (!result.Body) throw new Error("文件服务器返回了空文件内容")
    return Buffer.from(await result.Body.transformToByteArray())
  }

  /** 删除对象 */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.normalizeKey(key) })
    )
  }

  /**
   * 为指定前缀设置「N 天自动过期」生命周期规则（幂等、按 ID 合并，不影响 bucket 上其它规则）。
   * DO Spaces 兼容 S3 lifecycle，规则用顶层 Prefix 形式（非 Filter）。
   */
  async ensureExpirationRule(prefix: string, days: number, ruleId: string): Promise<void> {
    let rules: LifecycleRule[] = []
    try {
      const cur = await this.client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket })
      )
      rules = cur.Rules ?? []
    } catch (error) {
      // 桶上没有任何 lifecycle 时会抛 NoSuchLifecycleConfiguration，视为空规则集
      const code = (error as { name?: string })?.name
      if (code && code !== "NoSuchLifecycleConfiguration") throw error
    }

    const kept = rules.filter(r => r.ID !== ruleId)
    kept.push({
      ID: ruleId,
      Status: "Enabled",
      Prefix: prefix,
      Expiration: { Days: days },
    })

    await this.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.bucket,
        LifecycleConfiguration: { Rules: kept },
      })
    )
    this.logger.log(`Spaces 生命周期已就绪 [prefix=${prefix}, expireDays=${days}, rule=${ruleId}]`)
  }

  /**
   * 按 LastModified 主动清理指定前缀下「存活超过 maxAgeDays」的对象。
   * DO Spaces 的 lifecycle 删除执行器经常严重滞后（已标记 expiry-date 却数天不删），
   * 本方法作为兜底由定时任务调用，按真实存活时长删除；lifecycle 规则保留作双保险。
   * @returns 实际删除的对象数量
   */
  async pruneExpiredObjects(prefix: string, maxAgeDays: number): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    let token: string | undefined
    let deleted = 0
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })
      )
      for (const obj of res.Contents ?? []) {
        if (!obj.Key || !obj.LastModified || obj.LastModified.getTime() >= cutoff) continue
        await this.deleteObject(obj.Key)
        deleted++
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)
    return deleted
  }

  /** 判断对象是否存在 */
  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.normalizeKey(key) })
      )
      return true
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode
      if (status === 404 || status === 403) return false
      throw error
    }
  }

  /** 获取私有对象元数据；供业务模块在下载前校验大小和 MIME。 */
  async getObjectMetadata(key: string): Promise<{
    contentLength: number
    contentType: string | null
    metadata?: Record<string, string>
  }> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: this.normalizeKey(key) })
    )
    return {
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType ?? null,
      ...(result.Metadata ? { metadata: result.Metadata } : {}),
    }
  }

  /** 下载私有对象为 Buffer；调用方必须先完成对象归属和大小校验。 */
  async downloadBuffer(key: string, range?: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.normalizeKey(key),
        ...(range ? { Range: range } : {}),
      })
    )
    if (!result.Body) throw new Error("Spaces 对象内容为空")
    const bytes = await result.Body.transformToByteArray()
    return Buffer.from(bytes)
  }

  /** 获取公开 URL 对应对象的真实元数据，用于直传完成后的大小和类型校验。 */
  async getPublicObjectMetadata(publicUrl: string): Promise<{
    key: string
    contentLength: number
    contentType: string | null
  }> {
    const baseUrl = this.baseUrl.replace(/\/$/, "")
    const prefix = `${baseUrl}/`
    if (!baseUrl || !publicUrl.startsWith(prefix)) {
      throw new Error("对象 URL 不属于当前 Spaces")
    }

    const key = this.normalizeKey(decodeURIComponent(publicUrl.slice(prefix.length)))
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
    return {
      key,
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType ?? null,
    }
  }

  /** 生成对象的预签名下载 URL（默认 1 小时），用于私有文件临时分享 */
  async generateSignedDownloadUrl(
    key: string,
    expiresIn = 3600,
    filename?: string
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.normalizeKey(key),
        ...(filename
          ? {
              ResponseContentDisposition: `attachment; filename="download.${
                filename
                  .split(".")
                  .pop()
                  ?.replace(/[^a-zA-Z0-9]/g, "") || "png"
              }"; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
            }
          : {}),
      }),
      { expiresIn }
    )
  }

  /**
   * 生成 Presigned PUT URL，供前端 `fetch(url, { method: "PUT", body: file })` 直传。
   *
   * @param options.key         完整对象 key（如 `uploads/2026/05/12/abc.png`）
   * @param options.contentType 若传入，则签名会绑定 Content-Type，前端必须用同样的值上传
   * @param options.contentLength 若传入，则签名会绑定实际字节数，上传 Body 长度必须完全一致
   * @param options.expiresIn   签名有效期（秒），默认 1 小时
   * @param options.acl         上传后 ACL，默认 public-read；前端必须带 `x-amz-acl` header 上传
   *
   * 返回：
   *   uploadUrl  前端 PUT 目标 URL
   *   publicUrl  对象上传成功后的公开访问 URL（基于 SPACES_BASE_URL 拼接）
   *   key        服务端规整后的对象 key
   *   headers    前端 PUT 必须携带的请求头（值必须完全一致，否则 S3 会 SignatureDoesNotMatch）
   *   expiresIn  签名有效期（秒）
   */
  async generateUploadUrl(options: {
    key: string
    contentType?: string
    contentLength?: number
    expiresIn?: number
    acl?: ObjectCannedACL
    metadata?: Record<string, string>
  }): Promise<{
    uploadUrl: string
    publicUrl: string
    key: string
    headers: Record<string, string>
    expiresIn: number
  }> {
    const key = this.normalizeKey(options.key)
    const acl: ObjectCannedACL = options.acl ?? "public-read"
    const expiresIn = options.expiresIn ?? 3600

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ACL: acl,
      ...(options.contentType ? { ContentType: options.contentType } : {}),
      ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
      ...(options.metadata ? { Metadata: options.metadata } : {}),
    })
    // AWS SDK v3 默认会把 x-amz-acl（以及 content-type）hoist 到 URL 的 query 里，
    // 不再放进 SignedHeaders。AWS S3 能从 query 读 ACL，但 DigitalOcean Spaces
    // 只认 HTTP 请求头里的 x-amz-acl，结果是：PUT 200 但对象 ACL 回落到 private，
    // GET publicUrl 直接 403。把这两个 header 标为 unhoistable，强制塞回
    // SignedHeaders，前端 PUT 时必须按 `headers` 字段原样回传。
    const unhoistableHeaders = new Set<string>(["x-amz-acl"])
    if (options.contentType) unhoistableHeaders.add("content-type")
    const signableHeaders = new Set<string>()
    for (const name of Object.keys(options.metadata ?? {})) {
      unhoistableHeaders.add(`x-amz-meta-${name}`)
      signableHeaders.add(`x-amz-meta-${name}`)
    }
    if (options.contentType) signableHeaders.add("content-type")
    if (options.contentLength !== undefined) signableHeaders.add("content-length")
    const uploadUrl = await getSignedUrl(this.client, command, {
      expiresIn,
      unhoistableHeaders,
      signableHeaders,
    })

    const headers: Record<string, string> = { "x-amz-acl": acl }
    for (const [name, value] of Object.entries(options.metadata ?? {})) {
      headers[`x-amz-meta-${name}`] = value
    }
    if (options.contentType) headers["Content-Type"] = options.contentType
    if (options.contentLength !== undefined) {
      headers["Content-Length"] = String(options.contentLength)
    }

    return {
      uploadUrl,
      publicUrl: this.getPublicUrl(key),
      key,
      headers,
      expiresIn,
    }
  }

  /** 由 key 拼装公开访问 URL（不上传） */
  getPublicUrl(key: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}/${this.normalizeKey(key)}`
  }

  /** 暴露 bucket，便于调用方在脚本/工具中复用 */
  getBucket(): string {
    return this.bucket
  }

  private normalizeKey(key: string): string {
    return key.replace(/^\/+/, "")
  }
}
