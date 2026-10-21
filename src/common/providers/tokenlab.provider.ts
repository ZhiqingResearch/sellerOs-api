import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import type { AtlasJobResult, AtlasVideoMode, AtlasVideoParams } from "./atlas.provider"

// ==================== TokenLab 响应结构 ====================
// 文档：docs.tokenlab.sh/zh/api-reference/video/create-video & get-video-status
// 提交与轮询共用同一任务体：status pending/processing → completed（video_url）/ failed（error）

interface TokenlabTask {
  id?: string
  task_id?: string
  status?: string
  progress?: number
  url?: string
  output?: string
  outputs?: string[]
  video_url?: string
  duration?: number
  video?: { url?: string; duration?: number }
  videos?: Array<{ url?: string }>
  error?: unknown
}

interface TokenlabErrorBody {
  error?: { message?: string; type?: string; code?: string; retry_after?: number }
}

const KLING_MOTION_OPERATION = {
  model: "kling-3.0-motion-control",
  operation: "motion-control",
  alias: "kuaishou/kling-3.0-motion-control/motion-control",
} as const

/**
 * TokenLab 中转（api.tokenlab.sh）。承载 Grok Imagine 系 + Veo 3.1 Fast 视频：
 * - NORMAL × video-imagine：image-to-video（首帧图生视频）
 * - NORMAL × video-imagine-1.5-preview：1.5 preview image-to-video（参数面同 1.0，仅此一个操作）
 * - REFERENCE × video-imagine：reference-to-video（1–7 张参考图，时长 ≤10s）
 * - REFERENCE × video-imagine-reference：video-to-video（视频转视频，无时长/比例参数，源视频 ≤8.7s）
 * - MOTION_CONTROL × kling-motion：Kling 3.0 Motion Control（单张目标图 + 单个动作视频，时长/比例跟随动作视频）
 * - NORMAL × video-flash：Veo 3.1 Fast image-to-video（仅首帧）/ start-end-to-video（带尾帧）
 * - REFERENCE × video-lite：Veo 3.1 Fast reference-to-video（1–3 张 asset 参考图，时长锁 8s）
 * - video-ultra* 的 Seedance 2.0 Fast 映射仅保留作紧急回滚；新任务已切换 AtlasProvider
 * 与 AtlasProvider 同构（startVideo / pollUntilDone / downloadVideoBuffer），复用同一份入参类型。
 */
@Injectable()
export class TokenlabProvider {
  private readonly logger = new Logger(TokenlabProvider.name)
  private readonly apiKey: string
  private readonly baseUrl: string

  private static readonly POLL_INTERVAL_MS = 10_000
  private static readonly MAX_POLL_MS = 20 * 60 * 1000

  /** (mode × tier) → 上游 model + operation + 审计用模型别名 */
  private static readonly OPERATIONS: Record<
    string,
    { model: string; operation: string; alias: string }
  > = {
    "NORMAL:video-imagine": {
      model: "grok-imagine-video",
      operation: "image-to-video",
      alias: "x-ai/grok-imagine-video/image-to-video",
    },
    "NORMAL:video-imagine-1.5-preview": {
      model: "grok-imagine-video-1.5-preview",
      operation: "image-to-video",
      alias: "x-ai/grok-imagine-video-v1.5/image-to-video",
    },
    "REFERENCE:video-imagine": {
      model: "grok-imagine-video",
      operation: "reference-to-video",
      alias: "x-ai/grok-imagine-video/reference-to-video",
    },
    "REFERENCE:video-imagine-reference": {
      model: "grok-imagine-video",
      operation: "video-to-video",
      alias: "x-ai/grok-imagine-video/edit-video",
    },
    "MOTION_CONTROL:kling-motion": KLING_MOTION_OPERATION,
    // 兼容分类拆分前已落库的任务；能力矩阵不再开放该组合，新任务无法继续使用旧模式。
    "REFERENCE:kling-motion": KLING_MOTION_OPERATION,
    // Veo 3.1 Fast（owned_by google，model id 取无前缀的 veo3.1-fast）。
    // NORMAL 静态记 image-to-video，运行时带尾帧再切 start-end-to-video（见 resolveVeoOperation）
    "NORMAL:video-flash": {
      model: "veo3.1-fast",
      operation: "image-to-video",
      alias: "google/veo3.1-fast/image-to-video",
    },
    "REFERENCE:video-lite": {
      model: "veo3.1-fast",
      operation: "reference-to-video",
      alias: "google/veo3.1-fast/reference-to-video",
    },
    // 豆包 Seedance 2.0 Fast 旧 TokenLab 映射，仅供紧急回滚；当前新任务走 AtlasProvider。
    "NORMAL:video-ultra": {
      model: "seedance-2.0-fast",
      operation: "image-to-video",
      alias: "bytedance/seedance-2.0-fast/image-to-video",
    },
    "REFERENCE:video-ultra-reference": {
      model: "seedance-2.0-fast",
      operation: "reference-to-video",
      alias: "bytedance/seedance-2.0-fast/reference-to-video",
    },
  }

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>("TOKENLAB_API_KEY") || ""
    this.baseUrl = (
      this.config.get<string>("TOKENLAB_BASE_URL") || "https://api.tokenlab.sh"
    ).replace(/\/$/, "")
  }

  /** 取 (mode × tier) 的审计模型别名；该组合不归 TokenLab 时抛错 */
  resolveModelId(mode: AtlasVideoMode, tier: string): string {
    const op = TokenlabProvider.OPERATIONS[`${mode}:${tier}`]
    if (!op) throw new Error(`TokenLab 无对应模型：mode=${mode} tier=${tier}`)
    return op.alias
  }

  /** 提交视频生成任务。成功返回 { id }（即任务 id，轮询走 /v1/tasks/{id}），失败返回 { error } */
  async startVideo(params: AtlasVideoParams): Promise<{ id: string } | { error: string }> {
    const op = TokenlabProvider.OPERATIONS[`${params.mode}:${params.tier}`]
    if (!op) return { error: `TokenLab 无对应模型：mode=${params.mode} tier=${params.tier}` }

    const operation = this.resolveVeoOperation(op, params)
    const body = this.buildBody(op.model, operation, params)
    this.logger.log(`[TokenLab] 提交请求体 op=${operation}: ${this.rawJson(body)}`)
    try {
      const res = await axios.post(`${this.baseUrl}/v1/videos/generations`, body, {
        headers: this.authHeaders(),
        timeout: 60_000,
      })
      this.logger.log(`[TokenLab] 提交原始返回 op=${operation}: ${this.rawJson(res.data)}`)
      const task = res.data as TokenlabTask
      const id = task?.id ?? task?.task_id
      if (!id) return { error: "提交未返回任务 id" }
      return { id }
    } catch (error: unknown) {
      const detail = this.errMsg(error)
      this.logger.error(`[TokenLab] 提交失败 op=${operation}: ${detail}`)
      return { error: detail }
    }
  }

  /** 查询一次任务状态，归一化为 GENERATING/SUCCESS/FAILED */
  async queryVideo(taskId: string): Promise<AtlasJobResult> {
    try {
      const res = await axios.get(`${this.baseUrl}/v1/tasks/${taskId}`, {
        headers: this.authHeaders(),
        timeout: 30_000,
      })
      this.logger.log(`[TokenLab] 查询原始返回 task=${taskId}: ${this.rawJson(res.data)}`)
      return this.parseTask(res.data as TokenlabTask)
    } catch (error: unknown) {
      this.logger.error(`[TokenLab] 查询失败 task=${taskId}: ${this.errMsg(error)}`)
      return { status: "GENERATING" }
    }
  }

  /** 轮询到结束（10s 间隔 / 20min 超时）。超时返回 status=TIMEOUT */
  async pollUntilDone(taskId: string): Promise<AtlasJobResult> {
    const start = Date.now()
    let tick = 0
    while (Date.now() - start < TokenlabProvider.MAX_POLL_MS) {
      await this.sleep(TokenlabProvider.POLL_INTERVAL_MS)
      tick += 1
      const result = await this.queryVideo(taskId)
      const elapsed = ((Date.now() - start) / 1000).toFixed(0)
      this.logger.log(
        `[TokenLab] 第 ${tick} 次轮询 task=${taskId} status=${result.status} 已等=${elapsed}s`
      )
      if (result.status !== "GENERATING") return result
    }
    this.logger.warn(`[TokenLab] 轮询超时 task=${taskId}`)
    return { status: "TIMEOUT", errorMessage: "视频生成超时" }
  }

  /** 下载输出视频为 Buffer（失败返回 null） */
  async downloadVideoBuffer(url: string): Promise<Buffer | null> {
    try {
      const res = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: 120_000,
      })
      return Buffer.from(res.data)
    } catch (error: unknown) {
      this.logger.error(`[TokenLab] 下载视频失败: ${this.errMsg(error)}`)
      return null
    }
  }

  // ==================== 私有 ====================

  /**
   * Veo / Seedance 图生视频带尾帧时改走 start-end-to-video（image-to-video 不收 end_image）；
   * 其余（Grok 各操作、仅首帧 / 参考生视频）沿用静态 operation。
   */
  private resolveVeoOperation(
    op: { model: string; operation: string },
    p: AtlasVideoParams
  ): string {
    const supportsStartEnd = op.model === "veo3.1-fast" || op.model === "seedance-2.0-fast"
    if (supportsStartEnd && op.operation === "image-to-video" && p.lastFrameUrl) {
      return "start-end-to-video"
    }
    return op.operation
  }

  /**
   * 按 operation 组装请求体（字段依据 create-video API 文档 + 模型 public_contract + 实测）：
   *   image-to-video      prompt / image_url / duration / aspect_ratio / resolution
   *   start-end-to-video  prompt / start_image / end_image / duration / aspect_ratio / resolution（Veo 首尾帧）
   *   reference-to-video  prompt / reference_images / duration / aspect_ratio / resolution
   *                       （Grok ≤7 张 / 时长 ≤10；Veo 1–3 张 asset / 时长锁 8）
   *   video-to-video      仅 prompt / video_url（xAI 直连 edit 连 resolution 都拒收，
   *                       实测 unsupported_xai_video_edit_parameters）
   *   motion-control      prompt / image_url[目标图] / video_url[动作视频] / resolution
   * Grok 系列无音频参数；Veo 省略 output_audio 即默认开启——均不下发 generateAudio / keepSourceAudio。
   * Kling Motion Control 同样不公开音频开关，省略 output_audio，由模型按默认开启处理。
   * 例外：Seedance 2.0 Fast 的 output_audio 默认关闭、可由用户开关，按 generateAudio 显式下发。
   */
  private buildBody(
    model: string,
    operation: string,
    p: AtlasVideoParams
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { model, operation, prompt: p.prompt }
    const set = (k: string, v: unknown) => {
      if (v === undefined || v === null) return
      if (Array.isArray(v) && v.length === 0) return
      out[k] = v
    }
    if (operation === "video-to-video") {
      set("video_url", p.refVideoUrls?.[0])
      return out
    }
    if (operation === "motion-control") {
      const imageUrl = p.refImageUrls?.[0]
      const videoUrl = p.refVideoUrls?.[0]
      set("resolution", this.toMotionResolution(p.resolution))
      set("image_url", imageUrl)
      set("video_url", videoUrl)
      set("input_urls", imageUrl ? [imageUrl] : undefined)
      set("video_urls", videoUrl ? [videoUrl] : undefined)
      set("character_orientation", "image")
      set("background_source", "input_video")
      return out
    }
    set("resolution", p.resolution)
    set("duration", p.durationSec)
    set("aspect_ratio", p.aspectRatio)
    if (operation === "image-to-video") set("image_url", p.firstFrameUrl)
    if (operation === "start-end-to-video") {
      set("start_image", p.firstFrameUrl)
      set("end_image", p.lastFrameUrl)
    }
    if (operation === "reference-to-video") set("reference_images", p.refImageUrls)
    // Seedance 2.0 Fast 支持 output_audio 开关（默认关）；其余 TokenLab 模型不收此参数
    if (model === "seedance-2.0-fast") set("output_audio", p.generateAudio)
    return out
  }

  /** 任务体 → 归一状态（pending/processing 在跑；completed 取视频地址；failed 取错误） */
  private parseTask(task: TokenlabTask): AtlasJobResult {
    const status = String(task?.status ?? "").toLowerCase()
    if (status === "completed") {
      const url =
        task.video_url ??
        task.video?.url ??
        task.videos?.[0]?.url ??
        task.url ??
        task.output ??
        task.outputs?.[0]
      if (!url) return { status: "FAILED", errorMessage: "任务完成但未返回视频地址" }
      const duration = task.duration ?? task.video?.duration
      return { status: "SUCCESS", url, durationSec: duration ? Math.round(duration) : undefined }
    }
    if (status === "failed") {
      return { status: "FAILED", errorMessage: this.extractError(task.error) || "视频生成失败" }
    }
    return { status: "GENERATING" }
  }

  private authHeaders() {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }
  }

  private toMotionResolution(resolution?: string): string | undefined {
    if (!resolution) return undefined
    const map: Record<string, string> = {
      "720p": "1280x720",
      "1080p": "1920x1080",
    }
    return map[resolution] ?? resolution
  }

  /**
   * 抽取一句纯文本错误。HTTP 错误体为 { error: { message, type, code, retry_after? } }，
   * code/type（如 rate_limit_exceeded / upstream_error）与 retry_after 一并带上，
   * 供上层瞬时重试判定与退避取时（见 VideoProjectService.retryDelayMs）。
   */
  private errMsg(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const body = error.response?.data as TokenlabErrorBody | undefined
      if (body?.error) {
        const { message, type, code, retry_after } = body.error
        const tag = code || type
        const suffix = retry_after ? ` retry_after=${retry_after}` : ""
        const text = tag ? `[${tag}] ${message ?? ""}`.trim() : (message ?? error.message)
        return `${text}${suffix}`
      }
      return error.message
    }
    return error instanceof Error ? error.message : String(error)
  }

  /** 任务 error 字段可能是字符串或对象，统一收口为纯文本 */
  private extractError(input: unknown): string {
    if (input == null) return ""
    if (typeof input === "string") return input.trim()
    if (typeof input === "object") {
      const o = input as Record<string, unknown>
      for (const c of [o.message, o.msg, o.error]) {
        const s = this.extractError(c)
        if (s) return s
      }
    }
    return ""
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
