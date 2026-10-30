import { HttpService } from "@nestjs/axios"
import { HttpException, Injectable, ServiceUnavailableException } from "@nestjs/common"
import { Interval } from "@nestjs/schedule"
import { createHash, randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import type { Agent } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Transform, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { AliyunContentModerationProvider } from "../common/providers/aliyun-content-moderation.provider"
import { publicMediaDownloadAgent } from "../common/utils/public-media-url"
import { SpacesService } from "../spaces/spaces.service"
import { contentInputs } from "./content-inputs"
import {
  aliasModerationMedia,
  moderationScope,
  requestContentInputs,
  type FrozenModerationMedia,
} from "./moderation-scope"
import type { ModerationInput } from "./moderation.types"

export const DOCUMENT_MIME_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "txt",
  "text/html": "html",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
}

@Injectable()
export class ContentSnapshotService {
  constructor(
    private readonly provider: AliyunContentModerationProvider,
    private readonly http: HttpService,
    private readonly spaces: SpacesService
  ) {}

  async freeze(
    value: unknown,
    root = "input",
    technicalFields: readonly string[] = []
  ): Promise<{ value: unknown; inputs: ModerationInput[] }> {
    let frozen: unknown = JSON.parse(JSON.stringify(value))
    const inputs = await requestContentInputs(contentInputs(value, root, technicalFields))
    const replace = (node: unknown, from: string, to: string): unknown => {
      if (node === from) return to
      if (typeof node === "string" && node.includes(from) && /^\s*[[{]/.test(node)) {
        try {
          return JSON.stringify(replace(JSON.parse(node), from, to))
        } catch {
          return node
        }
      }
      if (Array.isArray(node)) return node.map(child => replace(child, from, to))
      if (node && typeof node === "object")
        return Object.fromEntries(
          Object.entries(node).map(([key, child]) => [key, replace(child, from, to)])
        )
      return node
    }
    for (const input of inputs) {
      if (input.type === "TEXT") continue
      const scope = moderationScope.getStore()
      const original = input.url!
      let pending = scope?.snapshots.get(original)
      if (!pending) {
        pending = this.freezeInput({ ...input })
        scope?.snapshots.set(original, pending)
      }
      const media = await pending
      scope?.snapshots.set(media.url, pending)
      const digest = scope?.aliases.get(media.url)
      if (digest) aliasModerationMedia(original, digest)
      frozen = replace(frozen, original, media.url)
      Object.assign(input, media)
    }
    return { value: frozen, inputs }
  }

  private async freezeInput(input: ModerationInput): Promise<FrozenModerationMedia> {
    const inline = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(
      input.url || ""
    )
    if (!inline) {
      this.provider.validate(input)
    }
    const directory = await mkdtemp(join(tmpdir(), "moderation-"))
    let agent: Agent | undefined
    try {
      const scope = moderationScope.getStore()
      const hash = createHash("sha256")
      // 公网素材固定到已验证IP，不跟随重定向；视频通过磁盘流转，不读入Node堆。
      const extension = inline
        ? inline[1].split("/")[1].replace(/[^a-zA-Z0-9]/g, "")
        : new URL(input.url!).pathname
            .split(".")
            .pop()
            ?.match(/^[a-zA-Z0-9]{1,8}$/)?.[0] || "bin"
      const key = `content-moderation/snapshots/${randomUUID()}.${extension}`
      if (inline) {
        const buffer = Buffer.from(inline[2], "base64")
        hash.update(buffer)
        await this.spaces.uploadBuffer(buffer, key, inline[1], "private")
      } else {
        const signal = AbortSignal.timeout(60_000)
        agent = await publicMediaDownloadAgent(input.url!)
        const response = await this.http.axiosRef.get<Readable>(input.url!, {
          adapter: "http",
          httpsAgent: agent,
          proxy: false,
          responseType: "stream",
          maxRedirects: 0,
          validateStatus: status => status === 200,
          timeout: 60_000,
          signal,
        })
        const header = response.headers["content-type"]
        const mime = typeof header === "string" ? header : "application/octet-stream"
        if (input.detectMime) {
          if (mime.startsWith("image/")) input.type = "IMAGE"
          else if (mime.startsWith("video/")) input.type = "VIDEO"
        }
        if (input.type === "DOCUMENT" && !input.documentType) {
          input.documentType = DOCUMENT_MIME_TYPES[mime.split(";")[0].trim().toLowerCase()]
        }
        const path = join(directory, "content")
        await pipeline(
          response.data,
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk)
              callback(null, chunk)
            },
          }),
          createWriteStream(path),
          { signal }
        )
        await this.spaces.uploadFile(path, key, mime, "private")
      }
      const url = await this.spaces.generateSignedDownloadUrl(key, 24 * 3600)
      const media = {
        url,
        type: input.type,
        ...(input.documentType ? { documentType: input.documentType } : {}),
      }
      const digest = hash.digest("hex")
      scope?.digests.add(digest)
      scope?.mediaByDigest.set(digest, Promise.resolve(media))
      scope?.objects.set(key, digest)
      aliasModerationMedia(url, digest)
      return media
    } catch (error) {
      if (error instanceof HttpException) throw error
      throw new ServiceUnavailableException({
        code: "MODERATION_SNAPSHOT_FAILED",
        message: "无法准备审核文件，请稍后重试",
      })
    } finally {
      agent?.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  }

  @Interval(24 * 3600_000)
  async cleanup() {
    await this.spaces.pruneExpiredObjects("content-moderation/temporary/", 1).catch(() => undefined)
    await this.spaces.pruneExpiredObjects("content-moderation/snapshots/", 2).catch(() => undefined)
  }
}
