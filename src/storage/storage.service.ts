import { Injectable } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import type { Readable } from "node:stream"
import {
  aliasModerationMedia,
  moderationScope,
  registerModerationUpload,
} from "../content-moderation/moderation-scope"
import { OssAdapter } from "./oss.adapter"
import { SpacesAdapter } from "./spaces.adapter"
import type { ObjectResponseHeaders } from "./storage.types"

type UploadOptions = Parameters<SpacesAdapter["generateUploadUrl"]>[0]

/** 切换只选择当前存储；不查询、复制或清理另一桶的历史对象。 */
@Injectable()
export class StorageService {
  private readonly adapter: OssAdapter | SpacesAdapter
  readonly provider: "oss" | "spaces"
  constructor(private readonly config: ConfigService) {
    const provider = config.get<string>("STORAGE_PROVIDER") || "oss"
    if (provider !== "oss" && provider !== "spaces")
      throw new Error("STORAGE_PROVIDER 只能为 oss 或 spaces")
    this.provider = provider
    this.adapter = provider === "oss" ? new OssAdapter(config) : new SpacesAdapter(config)
  }
  private key(value: string): string {
    const key = value.replace(/^\/+/, "")
    if (
      !key ||
      /[\\?#%]/.test(key) ||
      [...key].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      key.split("/").some(part => part === "." || part === ".." || !part)
    )
      throw new Error("无效的对象路径")
    return key
  }
  managedUrlPrefixes() {
    return ["OSS_BASE_URL", "SPACES_BASE_URL"]
      .map(name => this.config.get<string>(name))
      .filter((value): value is string => !!value)
      .map(value => `${value.replace(/\/$/, "")}/`)
  }
  isManagedUrl(url: string) {
    return this.managedUrlPrefixes().some(prefix => url.startsWith(prefix))
  }
  private keyFromUrl(value: string) {
    const base = this.config
      .get<string>(`${this.provider.toUpperCase()}_BASE_URL`)
      ?.replace(/\/$/, "")
    if (!base || !value.startsWith(`${base}/`)) throw new Error("对象 URL 不属于当前存储")
    const suffix = value.slice(base.length + 1)
    const url = new URL(value)
    if (url.search || url.hash || url.username || url.password) throw new Error("无效的存储 URL")
    return this.key(decodeURIComponent(suffix))
  }
  async uploadBuffer(
    buffer: Buffer,
    key: string,
    mime: string,
    acl: Parameters<SpacesAdapter["uploadBuffer"]>[3] = "public-read",
    metadata?: Record<string, string>,
    responseHeaders?: ObjectResponseHeaders
  ) {
    const normalized = this.key(key)
    const url = await this.adapter.uploadBuffer(
      buffer,
      normalized,
      mime,
      acl,
      metadata,
      responseHeaders
    )
    registerModerationUpload(normalized, url, buffer)
    return url
  }
  async uploadFile(
    path: string,
    key: string,
    mime: string,
    acl: Parameters<SpacesAdapter["uploadFile"]>[3] = "public-read",
    metadata?: Record<string, string>
  ) {
    return this.adapter.uploadFile(path, this.key(key), mime, acl, metadata)
  }
  async uploadStream(stream: Readable, key: string, mime: string, length?: number) {
    return this.adapter.uploadStream(stream, this.key(key), mime, length)
  }
  async deleteObject(key: string) {
    await this.adapter.deleteObject(this.key(key))
  }
  async objectExists(key: string) {
    return this.adapter.objectExists(this.key(key))
  }
  async getObjectMetadata(key: string) {
    return this.adapter.getObjectMetadata(this.key(key))
  }
  async downloadBuffer(key: string, range?: string) {
    return this.adapter.downloadBuffer(this.key(key), range)
  }
  async downloadBufferByUrl(url: string) {
    return this.downloadBuffer(this.keyFromUrl(url))
  }
  async downloadObjectToFile(key: string, path: string) {
    return this.adapter.downloadObjectToFile(this.key(key), path)
  }
  async getPublicObjectMetadata(url: string) {
    const key = this.keyFromUrl(url)
    return { ...(await this.adapter.getObjectMetadata(key)), key }
  }
  async generateSignedDownloadUrl(key: string, expires = 3600, filename?: string) {
    const normalized = this.key(key)
    const url = await this.adapter.generateSignedDownloadUrl(normalized, expires, filename)
    const digest = moderationScope.getStore()?.objects.get(normalized)
    if (digest) aliasModerationMedia(url, digest)
    return url
  }
  async generateUploadUrl(options: UploadOptions, generatedArtifact = false) {
    const key = this.key(options.key)
    if (key.startsWith("content-moderation/")) throw new Error("审核文件不允许客户端覆盖")
    if (
      !generatedArtifact &&
      /^(?:aigc\/|portrait-results\/|portrait-originals\/|ai-split-results\/|chetaidou\/generations\/|ai-creative\/openai-compatible\/)/.test(
        key
      )
    )
      throw new Error("生成交付文件不允许客户端覆盖")
    return this.adapter instanceof SpacesAdapter
      ? this.adapter.generateUploadUrl({ ...options, key }, generatedArtifact)
      : this.adapter.generateUploadUrl({ ...options, key })
  }
  getPublicUrl(key: string) {
    // 旧裁剪校验使用目录 URL；对象操作仍拒绝空路径段。
    return this.adapter.getPublicUrl(
      key.endsWith("/") ? `${this.key(key.slice(0, -1))}/` : this.key(key)
    )
  }
  getBucket() {
    return this.adapter.getBucket()
  }
  async pruneExpiredObjects(prefix: string, days: number) {
    if (!/^content-moderation\/(?:temporary|snapshots)\/$/.test(prefix))
      throw new Error("仅允许清理审核临时文件")
    return this.adapter.pruneExpiredObjects(prefix, days)
  }
  async ensureExpirationRule(prefix: string, days: number, id: string) {
    if (!(this.adapter instanceof SpacesAdapter))
      throw new Error("OSS 生命周期请通过云控制台配置；应用定时清理仍有效")
    await this.adapter.ensureExpirationRule(prefix, days, id)
  }
  generateOSSPolicy() {
    return new OssAdapter(this.config).generateOSSPolicy()
  }
}
