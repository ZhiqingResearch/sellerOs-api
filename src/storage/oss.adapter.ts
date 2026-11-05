import { ConfigService } from "@nestjs/config"
import OSS from "ali-oss"
import { createReadStream, createWriteStream } from "node:fs"
import { stat } from "node:fs/promises"
import type { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { SpacesAdapter } from "./spaces.adapter"
import type { ObjectResponseHeaders } from "./storage.types"

type UploadOptions = Parameters<SpacesAdapter["generateUploadUrl"]>[0]

export class OssAdapter {
  private instance?: OSS
  constructor(private readonly config: ConfigService) {}
  private get client(): OSS {
    if (!this.instance) {
      for (const name of [
        "OSS_ACCESS_KEY_ID",
        "OSS_ACCESS_KEY_SECRET",
        "OSS_REGION",
        "OSS_BUCKET",
        "OSS_BASE_URL",
      ]) {
        if (!this.config.get<string>(name)) throw new Error(`缺少存储配置 ${name}`)
      }
      this.instance = new OSS({
        accessKeyId: this.config.get<string>("OSS_ACCESS_KEY_ID")!,
        accessKeySecret: this.config.get<string>("OSS_ACCESS_KEY_SECRET")!,
        region: this.config.get<string>("OSS_REGION"),
        bucket: this.config.get<string>("OSS_BUCKET"),
        endpoint: this.config.get<string>("OSS_ENDPOINT") || undefined,
        secure: true,
        authorizationV4: true,
        timeout: 600_000,
      })
    }
    return this.instance
  }
  private async withStatus<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error: unknown) {
      // 保留现有调用方判断缺失/Range错误的响应状态接口。
      if (error && typeof error === "object" && "status" in error)
        Object.assign(error, { $metadata: { httpStatusCode: error.status } })
      throw error
    }
  }
  getPublicUrl(key: string) {
    const base = this.config.get<string>("OSS_BASE_URL")
    if (!base) throw new Error("缺少存储配置 OSS_BASE_URL")
    return `${base.replace(/\/$/, "")}/${key}`
  }
  getBucket() {
    return this.config.get<string>("OSS_BUCKET") || ""
  }
  private headers(acl: string, metadata?: Record<string, string>) {
    return {
      "x-oss-object-acl": acl,
      ...Object.fromEntries(
        Object.entries(metadata ?? {}).map(([key, value]) => [`x-oss-meta-${key}`, value])
      ),
    }
  }
  async uploadBuffer(
    buffer: Buffer,
    key: string,
    mime: string,
    acl = "public-read",
    metadata?: Record<string, string>,
    responseHeaders?: ObjectResponseHeaders
  ) {
    await this.client.put(key, buffer, {
      mime,
      headers: {
        ...this.headers(acl, metadata),
        ...(responseHeaders?.contentDisposition
          ? { "Content-Disposition": responseHeaders.contentDisposition }
          : {}),
        ...(responseHeaders?.cacheControl ? { "Cache-Control": responseHeaders.cacheControl } : {}),
      },
    })
    return this.getPublicUrl(key)
  }
  async uploadFile(
    path: string,
    key: string,
    mime: string,
    acl = "public-read",
    metadata?: Record<string, string>
  ) {
    const file = await stat(path)
    await this.client.putStream(key, createReadStream(path), {
      mime,
      contentLength: file.size,
      headers: this.headers(acl, metadata),
    } as OSS.PutStreamOptions)
    return this.getPublicUrl(key)
  }
  async uploadStream(stream: Readable, key: string, mime: string, contentLength?: number) {
    await this.client.putStream(key, stream, {
      mime,
      contentLength,
      headers: this.headers("public-read"),
    } as OSS.PutStreamOptions)
    return this.getPublicUrl(key)
  }
  async deleteObject(key: string) {
    await this.client.delete(key)
  }
  async getObjectMetadata(key: string) {
    const result = await this.withStatus(() => this.client.head(key))
    const headers = result.res.headers as Record<string, string>
    return {
      contentLength: Number(headers["content-length"] ?? 0),
      contentType: headers["content-type"] ?? null,
      metadata: Object.fromEntries(
        Object.entries(headers)
          .filter(([name]) => name.startsWith("x-oss-meta-"))
          .map(([name, value]) => [name.slice(11), value])
      ),
    }
  }
  async objectExists(key: string) {
    try {
      await this.getObjectMetadata(key)
      return true
    } catch (error) {
      if ((error as { status?: number }).status === 404) return false
      throw error
    }
  }
  async downloadBuffer(key: string, range?: string) {
    const result = await this.withStatus(() =>
      this.client.get(key, { headers: range ? { Range: range } : {} })
    )
    return Buffer.from(result.content)
  }
  async downloadObjectToFile(key: string, path: string) {
    const result = await this.withStatus(() => this.client.getStream(key))
    await pipeline(result.stream, createWriteStream(path), { signal: AbortSignal.timeout(600_000) })
  }
  async generateSignedDownloadUrl(key: string, expires = 3600, filename?: string) {
    const queries = filename
      ? {
          "response-content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        }
      : {}
    return this.client.signatureUrlV4("GET", expires, { queries }, key)
  }
  async generateUploadUrl(options: UploadOptions) {
    const expiresIn = options.expiresIn ?? 3600
    const headers: Record<string, string> = this.headers(
      options.acl ?? "public-read",
      options.metadata
    )
    if (options.contentType) headers["Content-Type"] = options.contentType
    if (options.contentLength !== undefined)
      headers["Content-Length"] = String(options.contentLength)
    const uploadUrl = await this.client.signatureUrlV4(
      "PUT",
      expiresIn,
      { headers },
      options.key,
      Object.keys(headers).map(name => name.toLowerCase())
    )
    return {
      uploadUrl,
      publicUrl: this.getPublicUrl(options.key),
      key: options.key,
      headers,
      expiresIn,
    }
  }
  async pruneExpiredObjects(prefix: string, days: number) {
    const cutoff = Date.now() - days * 86400_000
    let marker = "",
      deleted = 0
    do {
      const page = await this.client.list({ prefix, marker, "max-keys": 1000 }, {})
      for (const object of page.objects ?? []) {
        if (new Date(object.lastModified).getTime() >= cutoff) continue
        await this.deleteObject(object.name)
        deleted++
      }
      marker = page.isTruncated ? page.nextMarker : ""
    } while (marker)
    return deleted
  }
  generateOSSPolicy() {
    const dir = "uploads/legacy/"
    const signature = this.client.calculatePostSignature({
      expiration: new Date(Date.now() + 3600_000).toISOString(),
      conditions: [
        ["content-length-range", 0, 1048576000],
        { bucket: this.getBucket() },
        ["starts-with", "$key", dir],
      ],
    })
    return {
      policy: signature.policy,
      signature: signature.Signature,
      ossAccessKeyId: signature.OSSAccessKeyId,
      host: this.config.get<string>("OSS_BASE_URL"),
      dir,
    }
  }
}
