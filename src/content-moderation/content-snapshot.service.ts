import { HttpService } from "@nestjs/axios"
import { Injectable, ServiceUnavailableException } from "@nestjs/common"
import { Interval } from "@nestjs/schedule"
import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { AliyunContentModerationProvider } from "../common/providers/aliyun-content-moderation.provider"
import { SpacesService } from "../spaces/spaces.service"
import { contentInputs } from "./content-inputs"
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
    const inputs = contentInputs(value, root, technicalFields)
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
      const inline = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(
        input.url || ""
      )
      if (!inline) {
        try {
          this.provider.validate(input)
        } catch (error) {
          if (!input.detectMime) throw error
          // 无文件类型提示的外部链接作为文字审核，不抓取第三方网页。
          input.type = "TEXT"
          input.content = input.url
          delete input.url
          continue
        }
      }
      const directory = await mkdtemp(join(tmpdir(), "moderation-"))
      try {
        // 只取已验证的存储地址，不跟随重定向；视频通过磁盘流转，不读入Node堆。
        const extension = inline
          ? inline[1].split("/")[1].replace(/[^a-zA-Z0-9]/g, "")
          : new URL(input.url!).pathname
              .split(".")
              .pop()
              ?.match(/^[a-zA-Z0-9]{1,8}$/)?.[0] || "bin"
        const key = `content-moderation/snapshots/${randomUUID()}.${extension}`
        if (inline)
          await this.spaces.uploadBuffer(
            Buffer.from(inline[2], "base64"),
            key,
            inline[1],
            "private"
          )
        else {
          const signal = AbortSignal.timeout(60_000)
          const response = await this.http.axiosRef.get<Readable>(input.url!, {
            responseType: "stream",
            maxRedirects: 0,
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
          await pipeline(response.data, createWriteStream(path), { signal })
          await this.spaces.uploadFile(path, key, mime, "private")
        }
        const url = await this.spaces.generateSignedDownloadUrl(key, 24 * 3600)
        frozen = replace(frozen, input.url!, url)
        input.url = url
      } catch {
        throw new ServiceUnavailableException({
          code: "MODERATION_SNAPSHOT_FAILED",
          message: "无法准备审核文件，请稍后重试",
        })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
    return { value: frozen, inputs }
  }

  @Interval(24 * 3600_000)
  async cleanup() {
    await this.spaces.pruneExpiredObjects("content-moderation/temporary/", 1).catch(() => undefined)
    await this.spaces.pruneExpiredObjects("content-moderation/snapshots/", 2).catch(() => undefined)
  }
}
