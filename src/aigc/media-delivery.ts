import axios from "axios"
import { createWriteStream } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Transform, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { publicMediaDownloadAgent } from "../common/utils/public-media-url"
import type { SpacesService } from "../spaces/spaces.service"
import { AIGC_VERSION, AigcDeliveryError, contentId, type AigcMetadata } from "./aigc-metadata"
import { labelVideo } from "./video-label"

export function objectAigcMetadata(metadata: AigcMetadata) {
  return {
    "aigc-label": "1",
    "aigc-version": AIGC_VERSION,
    aigc: JSON.stringify(metadata).replace(
      /[^\x20-\x7e]/g,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
    ),
  }
}

async function exists(spaces: SpacesService, key: string, labeled = false): Promise<boolean> {
  try {
    const object = await spaces.getObjectMetadata(key)
    return (
      !labeled ||
      (object.metadata?.["aigc-label"] === "1" && object.metadata["aigc-version"] === AIGC_VERSION)
    )
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (
      status === 404 ||
      (error as Error).name === "NotFound" ||
      (error as Error).name === "NoSuchKey"
    )
      return false
    throw error
  }
}

const inFlight = new Map<string, Promise<string>>()

/** 固定产物key；只重取私有源文件、标识和上传，不调用任何生成接口。 */
export function deliverVideo(
  spaces: SpacesService,
  source: string | Buffer,
  id: string,
  options: { headers?: Record<string, string>; maxBytes?: number } = {}
): Promise<string> {
  const key = `aigc/videos/v${AIGC_VERSION}/${contentId(id)}.mp4`
  const pending = inFlight.get(key)
  if (pending) return pending
  const operation = (async () => {
    let directory: string | undefined
    try {
      if (await exists(spaces, key, true)) return spaces.getPublicUrl(key)
      directory = await mkdtemp(join(tmpdir(), "aigc-video-"))
      const sourcePath = join(directory, "source")
      const sourceKey = `aigc/sources/${contentId(id)}.source`
      if (await exists(spaces, sourceKey)) await spaces.downloadObjectToFile(sourceKey, sourcePath)
      else {
        if (Buffer.isBuffer(source)) await writeFile(sourcePath, source)
        else {
          const agent = await publicMediaDownloadAgent(source)
          const signal = AbortSignal.timeout(10 * 60_000)
          try {
            const response = await axios.get<Readable>(source, {
              adapter: "http",
              httpsAgent: agent,
              proxy: false,
              maxRedirects: 0,
              validateStatus: status => status === 200,
              responseType: "stream",
              headers: options.headers,
              timeout: 60_000,
              signal,
            })
            let size = 0
            const counter = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                size += chunk.length
                callback(
                  options.maxBytes && size > options.maxBytes
                    ? new Error("视频文件超过大小限制")
                    : null,
                  chunk
                )
              },
            })
            await pipeline(response.data, counter, createWriteStream(sourcePath), { signal })
          } finally {
            agent.destroy()
          }
        }
        await spaces.uploadFile(sourcePath, sourceKey, "application/octet-stream", "private")
      }
      const result = await labelVideo(sourcePath, directory, id)
      return await spaces.uploadFile(
        result.path,
        key,
        "video/mp4",
        "public-read",
        objectAigcMetadata(result.metadata)
      )
    } catch {
      throw new AigcDeliveryError()
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  })()
  inFlight.set(key, operation)
  void operation.finally(() => inFlight.delete(key)).catch(() => undefined)
  return operation
}
