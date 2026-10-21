import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import type {
  AtlasJobResult,
  AtlasVideoMode,
  AtlasVideoParams,
  AtlasVideoTier,
} from "./atlas.provider"

interface SuchuangSubmitResponse {
  code?: number | string
  msg?: string
  data?: unknown
}

interface SuchuangRoute {
  endpoint: string
  alias: string
  vendor: "google_omni" | "grok_imagine"
}

/**
 * 速创 API 中转（api.wuyinkeji.com）视频封装。
 *
 * 当前仅做 Provider 能力沉淀（提交 / 查询 / 轮询 / 下载），暂不接入业务调用。
 * 文档：
 * - google_omni: https://api.wuyinkeji.com/doc/72
 * - grok_imagine(video): https://api.wuyinkeji.com/doc/62
 * - 结果查询: https://api.wuyinkeji.com/doc/47
 */
@Injectable()
export class SuchuangProvider {
  private readonly logger = new Logger(SuchuangProvider.name)
  private readonly apiKey: string
  private readonly baseUrl: string

  private static readonly POLL_INTERVAL_MS = 10_000
  private static readonly MAX_POLL_MS = 20 * 60 * 1000

  /** 先覆盖即将接入的核心组合，后续扩展可在此追加映射。 */
  private static readonly ROUTES: Record<string, SuchuangRoute> = {
    "REFERENCE:google_omni": {
      endpoint: "/api/async/video_google_omni",
      alias: "suchuang/google_omni",
      vendor: "google_omni",
    },
    "NORMAL:gork_imagine": {
      endpoint: "/api/async/video_grok_imagine",
      alias: "suchuang/grok_imagine",
      vendor: "grok_imagine",
    },
  }

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>("SUCHUANG_API_KEY") || ""
    this.baseUrl = (
      this.config.get<string>("SUCHUANG_BASE_URL") || "https://api.wuyinkeji.com"
    ).replace(/\/$/, "")
  }

  resolveModelId(mode: AtlasVideoMode, tier: AtlasVideoTier): string {
    const route = SuchuangProvider.ROUTES[`${mode}:${tier}`]
    if (!route) throw new Error(`速创无对应模型：mode=${mode} tier=${tier}`)
    return route.alias
  }

  /** 提交视频生成任务。成功返回 { id }，失败返回 { error }。 */
  async startVideo(params: AtlasVideoParams): Promise<{ id: string } | { error: string }> {
    const route = SuchuangProvider.ROUTES[`${params.mode}:${params.tier}`]
    if (!route) return { error: `速创无对应模型：mode=${params.mode} tier=${params.tier}` }
    if (!this.apiKey) return { error: "未配置 SUCHUANG_API_KEY" }

    const body = this.buildCreateBody(route.vendor, params)
    try {
      const res = await axios.post<SuchuangSubmitResponse>(
        `${this.baseUrl}${route.endpoint}`,
        body,
        {
          headers: this.authHeaders(),
          params: { key: this.apiKey },
          timeout: 60_000,
        }
      )
      this.logger.log(`[Suchuang] 提交原始返回 vendor=${route.vendor}: ${this.rawJson(res.data)}`)
      const id = this.extractTaskId(res.data)
      if (!id) return { error: this.extractError(res.data) || "提交未返回任务 id" }
      return { id }
    } catch (error: unknown) {
      const message = this.errMsg(error)
      this.logger.error(`[Suchuang] 提交失败 vendor=${route.vendor}: ${message}`)
      return { error: message }
    }
  }

  /** 查询一次任务状态（结果详情接口），归一化为 GENERATING/SUCCESS/FAILED。 */
  async queryVideo(taskId: string): Promise<AtlasJobResult> {
    try {
      const payload = await this.fetchDetail(taskId)
      this.logger.log(`[Suchuang] 查询原始返回 task=${taskId}: ${this.rawJson(payload)}`)
      return this.parseDetail(payload)
    } catch (error: unknown) {
      this.logger.error(`[Suchuang] 查询失败 task=${taskId}: ${this.errMsg(error)}`)
      return { status: "GENERATING" }
    }
  }

  /** 轮询到结束（10s 间隔 / 20min 超时）。 */
  async pollUntilDone(taskId: string): Promise<AtlasJobResult> {
    const start = Date.now()
    let tick = 0
    while (Date.now() - start < SuchuangProvider.MAX_POLL_MS) {
      await this.sleep(SuchuangProvider.POLL_INTERVAL_MS)
      tick += 1
      const result = await this.queryVideo(taskId)
      const elapsed = ((Date.now() - start) / 1000).toFixed(0)
      this.logger.log(
        `[Suchuang] 第 ${tick} 次轮询 task=${taskId} status=${result.status} 已等=${elapsed}s`
      )
      if (result.status !== "GENERATING") return result
    }
    this.logger.warn(`[Suchuang] 轮询超时 task=${taskId}`)
    return { status: "TIMEOUT", errorMessage: "视频生成超时" }
  }

  /** 下载输出视频为 Buffer（失败返回 null）。 */
  async downloadVideoBuffer(url: string): Promise<Buffer | null> {
    try {
      const res = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: 120_000,
      })
      const buffer = Buffer.from(res.data)
      const contentType = String(res.headers?.["content-type"] ?? "").toLowerCase()

      // 速创 detail 同时包含 request.image_urls（输入图）和 result（输出视频）；
      // 若上游异常返回了图片地址，这里兜底拦截，避免把图片按 mp4 转存。
      if (contentType.startsWith("image/") || this.isImageBuffer(buffer)) {
        this.logger.error(
          `[Suchuang] 下载内容疑似图片，拒绝转存 video。url=${url} content-type=${contentType || "(empty)"}`
        )
        return null
      }

      return buffer
    } catch (error: unknown) {
      this.logger.error(`[Suchuang] 下载视频失败: ${this.errMsg(error)}`)
      return null
    }
  }

  // ==================== 私有 ====================

  /** 结果详情文档支持 id 查询；这里优先 POST，失败后兜底 GET。 */
  private async fetchDetail(taskId: string): Promise<unknown> {
    const url = `${this.baseUrl}/api/async/detail`
    try {
      const post = await axios.post(
        url,
        { id: taskId },
        {
          headers: this.authHeaders(),
          params: { key: this.apiKey },
          timeout: 30_000,
        }
      )
      return post.data
    } catch {
      const get = await axios.get(url, {
        headers: this.authHeaders(),
        params: { key: this.apiKey, id: taskId },
        timeout: 30_000,
      })
      return get.data
    }
  }

  private buildCreateBody(
    vendor: SuchuangRoute["vendor"],
    params: AtlasVideoParams
  ): Record<string, unknown> {
    if (vendor === "google_omni") {
      const out: Record<string, unknown> = { prompt: params.prompt ?? "" }
      const size = this.resolveGoogleOmniSize(params)
      if (size) out.size = size
      if (params.refImageUrls?.length) out.images = params.refImageUrls.slice(0, 7).join(",")
      if (params.durationSec != null) out.duration = String(params.durationSec)
      if (params.refVideoUrls?.[0]) out.video = params.refVideoUrls[0]
      return out
    }

    const out: Record<string, unknown> = { prompt: params.prompt ?? "" }
    if (params.durationSec != null) out.duration = String(params.durationSec)
    if (params.aspectRatio) out.aspect_ratio = params.aspectRatio
    const imageUrls = [
      ...(params.firstFrameUrl ? [params.firstFrameUrl] : []),
      ...(params.refImageUrls ?? []),
    ]
    if (imageUrls.length) out.image_urls = imageUrls.slice(0, 7)
    return out
  }

  /** google_omni 要求 size=宽x高；尽量从现有 resolution + aspectRatio 推导。 */
  private resolveGoogleOmniSize(params: AtlasVideoParams): string | undefined {
    const normalizedResolution = params.resolution?.toLowerCase()
    if (normalizedResolution && /^\d+x\d+$/.test(normalizedResolution)) {
      return normalizedResolution
    }

    const ratio = params.aspectRatio
    const resolution = normalizedResolution
    if (!ratio || !resolution) return undefined

    if (resolution === "720p") {
      if (ratio === "16:9") return "1280x720"
      if (ratio === "9:16") return "720x1280"
    }
    if (resolution === "1080p") {
      if (ratio === "16:9") return "1920x1080"
      if (ratio === "9:16") return "1080x1920"
    }
    return undefined
  }

  private parseDetail(payload: unknown): AtlasJobResult {
    const root = (payload ?? {}) as Record<string, unknown>
    const data = (root.data ?? root) as Record<string, unknown>
    const status = this.normalizeStatus(data.status ?? root.status)

    if (status === "GENERATING") return { status: "GENERATING" }
    if (status === "FAILED") {
      return { status: "FAILED", errorMessage: this.extractError(data) || this.extractError(root) }
    }

    // 先按「结果字段」提取，避免误拿 request.image_urls 等输入素材 URL。
    const url = this.extractResultVideoUrl(data) || this.extractResultVideoUrl(root)
    if (!url) return { status: "FAILED", errorMessage: "任务成功但未返回视频地址" }
    return { status: "SUCCESS", url }
  }

  /** 文档约定：0 初始化 / 1 进行中 / 2 成功 / 3 失败。 */
  private normalizeStatus(raw: unknown): "GENERATING" | "SUCCESS" | "FAILED" {
    if (raw == null) return "GENERATING"
    const text =
      typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
        ? String(raw).trim().toLowerCase()
        : ""
    if (!text) return "GENERATING"
    if (text === "2" || text === "success" || text === "succeeded" || text === "completed") {
      return "SUCCESS"
    }
    if (text === "3" || text === "failed" || text === "error" || text === "fail") return "FAILED"
    return "GENERATING"
  }

  private extractTaskId(input: unknown, depth = 0): string {
    if (input == null || depth > 5) return ""
    if (typeof input === "string") return input.trim()
    if (typeof input !== "object") return ""
    const obj = input as Record<string, unknown>

    for (const key of ["id", "task_id", "taskId"]) {
      const v = obj[key]
      if (typeof v === "string" && v.trim()) return v.trim()
    }
    return this.extractTaskId(obj.data, depth + 1)
  }

  private extractResultVideoUrl(input: unknown, depth = 0): string {
    if (input == null || depth > 6) return ""
    if (typeof input === "string") {
      const value = input.trim()
      return value.startsWith("http") && this.isLikelyVideoUrl(value) ? value : ""
    }
    if (Array.isArray(input)) {
      for (const item of input) {
        const hit = this.extractResultVideoUrl(item, depth + 1)
        if (hit) return hit
      }
      return ""
    }
    if (typeof input !== "object") return ""

    const obj = input as Record<string, unknown>
    for (const key of ["result", "outputs", "video_url", "result_url", "download_url", "url", "output"]) {
      const raw = obj[key]
      if (typeof raw === "string" && raw.startsWith("http")) return raw
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (typeof item === "string" && item.startsWith("http") && this.isLikelyVideoUrl(item)) return item
          if (typeof item === "object" && item) {
            const nested = item as Record<string, unknown>
            if (
              typeof nested.url === "string" &&
              nested.url.startsWith("http") &&
              this.isLikelyVideoUrl(nested.url)
            ) {
              return nested.url
            }
          }
        }
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      if (key === "request" || key === "image_urls" || key === "images") continue
      const hit = this.extractResultVideoUrl(value, depth + 1)
      if (hit) return hit
    }
    return ""
  }

  private isLikelyVideoUrl(url: string): boolean {
    const normalized = url.split("?")[0]?.toLowerCase() ?? ""
    return !/\.(png|jpe?g|webp|gif|bmp|svg)$/.test(normalized)
  }

  private isImageBuffer(buffer: Buffer): boolean {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return true // PNG
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return true // JPEG
    }
    if (buffer.length >= 6) {
      const sig = buffer.toString("ascii", 0, 6)
      if (sig === "GIF87a" || sig === "GIF89a") return true
    }
    if (
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
      return true
    }
    return false
  }

  private extractError(input: unknown, depth = 0): string {
    if (input == null || depth > 6) return ""
    if (typeof input === "string") return input.trim()
    if (typeof input !== "object") return ""
    const obj = input as Record<string, unknown>
    for (const key of ["message", "msg", "error", "errorMessage"]) {
      const hit = this.extractError(obj[key], depth + 1)
      if (hit) return hit
    }
    return ""
  }

  private authHeaders() {
    return { Authorization: this.apiKey, "Content-Type": "application/json" }
  }

  private errMsg(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return this.extractError(error.response?.data) || error.message
    }
    return error instanceof Error ? error.message : String(error)
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private rawJson(v: unknown): string {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
}
