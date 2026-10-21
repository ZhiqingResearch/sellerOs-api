import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import type { Readable } from "stream"

// ==================== 类型 ====================

export type AtlasVideoMode = "NORMAL" | "REFERENCE" | "MOTION_CONTROL"
// 注：video-imagine* 各档实际走 TokenLab 链路（见 TokenlabProvider），
// 列在这里是因为 AtlasVideoParams 是三条视频通道（Atlas / Google / TokenLab）共用的入参形状
export type AtlasVideoTier =
  | "video-lite"
  | "video-flash"
  | "video-pro"
  | "video-mini"
  | "video-flash-reference"
  | "video-imagine"
  | "video-imagine-1.5-preview"
  | "video-imagine-reference"
  | "video-turbo"
  | "video-edit"
  | "kling-motion"
  | "video-ultra"
  | "video-ultra-reference"
  | "google_omni"
  | "gork_imagine"
  | "video-seedance-2-5"

/**
 * 统一的视频生成入参（与 VideoTask 字段对齐）。
 * AtlasProvider 内部按 (mode × tier) 选择对应模型，并组装各模型的 input。
 */
export interface AtlasVideoParams {
  mode: AtlasVideoMode
  tier: AtlasVideoTier
  prompt?: string
  durationSec?: number
  aspectRatio?: string // 16:9 / 9:16 / 1:1
  resolution?: string // 720p / 1080p / 4k
  generateAudio?: boolean
  keepSourceAudio?: boolean
  outputFormat?: "mp4" | "mov"
  watermark?: boolean
  // 常规模式（image-to-video）：首/尾帧
  firstFrameUrl?: string
  lastFrameUrl?: string
  // 全能参考模式（reference-to-video）：参考素材
  refImageUrls?: string[]
  refVideoUrls?: string[]
  refAudioUrls?: string[]
}

/** 归一化后的任务状态 */
export type AtlasJobStatus = "GENERATING" | "SUCCESS" | "FAILED" | "TIMEOUT"

export interface AtlasJobResult {
  status: AtlasJobStatus
  /** 成功时的输出视频 URL（atlas storage） */
  url?: string
  /** 成功时上游报告的实际出片时长（秒）；目前仅 TokenLab 返回，用于回填无时长参数的任务（如 v2v） */
  durationSec?: number
  errorMessage?: string
}

// ==================== Atlas 响应结构（用于类型化，避免 any） ====================

interface AtlasSubmitResponse {
  id?: string
  data?: { id?: string }
}

interface AtlasPredictionData {
  status?: string
  outputs?: string[]
  output?: string
  error?: string | { message?: string }
  errorMessage?: string
  message?: string
}

interface AtlasPredictionResponse {
  data?: AtlasPredictionData
}

@Injectable()
export class AtlasProvider {
  private readonly logger = new Logger(AtlasProvider.name)
  private readonly apiKey: string
  private readonly baseUrl: string

  private static readonly POLL_INTERVAL_MS = 10_000
  private static readonly MAX_POLL_MS = 20 * 60 * 1000

  /**
   * (mode × tier) → atlas 模型 id。
   * 常规模式走 image-to-video，全能参考走 reference-to-video。
   */
  // 内层 Partial：video-flash-reference 仅在 REFERENCE 模式有对应模型
  private static readonly MODEL_IDS: Record<
    AtlasVideoMode,
    Partial<Record<AtlasVideoTier, string>>
  > = {
    NORMAL: {
      "video-lite": "kwaivgi/kling-video-o3-std/image-to-video",
      "video-flash": "google/veo3.1-fast/image-to-video",
      "video-pro": "bytedance/seedance-2.0/image-to-video",
      "video-mini": "bytedance/seedance-2.0-mini/image-to-video",
      "video-ultra": "bytedance/seedance-2.0-fast/image-to-video",
      "video-turbo": "kwaivgi/kling-v3.0-turbo/image-to-video",
      "video-seedance-2-5": "bytedance/seedance-2.5/image-to-video",
    },
    REFERENCE: {
      "video-lite": "kwaivgi/kling-video-o3-std/reference-to-video",
      "video-flash": "google/gemini-omni-flash/image-to-video-developer",
      "video-flash-reference": "google/gemini-omni-flash/reference-to-video-developer",
      "video-pro": "bytedance/seedance-2.0/reference-to-video",
      "video-mini": "bytedance/seedance-2.0-mini/reference-to-video",
      "video-ultra-reference": "bytedance/seedance-2.0-fast/reference-to-video",
      "video-edit": "kwaivgi/kling-video-o3-std/video-edit",
      "video-seedance-2-5": "bytedance/seedance-2.5/reference-to-video",
    },
    MOTION_CONTROL: {},
  }

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>("ATLASCLOUD_API_KEY") || ""
    this.baseUrl = (
      this.config.get<string>("ATLASCLOUD_BASE_URL") || "https://api.atlascloud.ai/api/v1/model"
    ).replace(/\/$/, "")
  }

  /** 取 (mode × tier) 对应的模型 id；该组合无对应模型时抛错（如 NORMAL × video-flash-reference） */
  resolveModelId(mode: AtlasVideoMode, tier: AtlasVideoTier): string {
    const id = AtlasProvider.MODEL_IDS[mode][tier]
    if (!id) throw new Error(`Atlas 无对应模型：mode=${mode} tier=${tier}`)
    return id
  }

  /**
   * 提交视频生成任务。成功返回 { id }，失败返回 { error }（含 Atlas 原始报错，便于落库排查）。
   * 提交体为「扁平」结构：{ model, ...各模型字段 }（Atlas 各模型 tab=api 完整示例确认非 input 包裹）。
   */
  async startVideo(params: AtlasVideoParams): Promise<{ id: string } | { error: string }> {
    const model = this.resolveModelId(params.mode, params.tier)
    const body = { model, ...this.buildBody(params) }
    try {
      const res = await axios.post(`${this.baseUrl}/generateVideo`, body, {
        headers: this.authHeaders(),
        timeout: 60_000,
      })
      this.logger.log(`[Atlas] 提交原始返回 model=${model}: ${this.rawJson(res.data)}`)
      const resBody = res.data as AtlasSubmitResponse
      const id: string | undefined = resBody?.id ?? resBody?.data?.id
      if (!id) {
        this.logger.error(`[Atlas] 提交未返回 prediction id model=${model}`)
        return { error: "提交未返回 prediction id" }
      }
      this.logger.log(`[Atlas] 任务已提交 model=${model} prediction=${id}`)
      return { id }
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `[Atlas] 提交原始错误 model=${model}: ${this.rawJson(error.response?.data ?? error.message)}`
        )
      }
      const detail = this.errMsg(error)
      this.logger.error(`[Atlas] 提交失败 model=${model}: ${detail}`)
      return { error: detail }
    }
  }

  /** 查询一次任务状态（对账用），归一化为 GENERATING/SUCCESS/FAILED */
  async queryVideo(predictionId: string): Promise<AtlasJobResult> {
    try {
      const res = await axios.get(`${this.baseUrl}/prediction/${predictionId}`, {
        headers: this.authHeaders(),
        timeout: 30_000,
      })
      this.logger.log(`[Atlas] 查询原始返回 prediction=${predictionId}: ${this.rawJson(res.data)}`)
      return this.parsePrediction(res.data)
    } catch (error: unknown) {
      // Atlas 会用非 2xx（如 500）承载任务终态，例如
      // { code:500, data:{ status:"failed", error:"..." } }，需解析响应体而非当作瞬时错误
      if (axios.isAxiosError(error) && error.response?.data != null) {
        this.logger.warn(
          `[Atlas] 查询原始错误体 prediction=${predictionId}: ${this.rawJson(error.response.data)}`
        )
        const parsed = this.parsePrediction(error.response.data)
        if (parsed.status !== "GENERATING") return parsed
      }
      this.logger.error(`[Atlas] 查询失败 prediction=${predictionId}: ${this.errMsg(error)}`)
      return { status: "GENERATING" }
    }
  }

  /** 解析 prediction 响应体（兼容有/无 data 包裹），归一化为任务状态 */
  private parsePrediction(payload: unknown): AtlasJobResult {
    const body = payload as AtlasPredictionResponse
    const d: AtlasPredictionData = body?.data ?? (payload as AtlasPredictionData) ?? {}
    const raw = String(d.status ?? "").toLowerCase()
    if (raw === "completed" || raw === "succeeded") {
      const url = Array.isArray(d.outputs) ? d.outputs[0] : d.output
      if (!url) return { status: "FAILED", errorMessage: "任务完成但未返回视频地址" }
      return { status: "SUCCESS", url }
    }
    if (raw === "failed" || raw === "canceled" || raw === "cancelled") {
      return { status: "FAILED", errorMessage: this.pickError(d) }
    }
    return { status: "GENERATING" }
  }

  /** 轮询到结束（10s 间隔 / 20min 超时）。超时返回 status=TIMEOUT */
  async pollUntilDone(predictionId: string): Promise<AtlasJobResult> {
    const start = Date.now()
    let tick = 0
    while (Date.now() - start < AtlasProvider.MAX_POLL_MS) {
      await this.sleep(AtlasProvider.POLL_INTERVAL_MS)
      tick += 1
      const result = await this.queryVideo(predictionId)
      const elapsed = ((Date.now() - start) / 1000).toFixed(0)
      this.logger.log(
        `[Atlas] 第 ${tick} 次轮询 prediction=${predictionId} status=${result.status} 已等=${elapsed}s`
      )
      if (result.status !== "GENERATING") return result
    }
    this.logger.warn(`[Atlas] 轮询超时 prediction=${predictionId}`)
    return { status: "TIMEOUT", errorMessage: "视频生成超时" }
  }

  /** 下载输出视频为 Buffer（短视频，便于直接 PutObject 到 Spaces；失败返回 null） */
  async downloadVideoBuffer(url: string): Promise<Buffer | null> {
    try {
      const res = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: 120_000,
      })
      return Buffer.from(res.data)
    } catch (error: unknown) {
      this.logger.error(`[Atlas] 下载视频失败: ${this.errMsg(error)}`)
      return null
    }
  }

  /** 流式下载输出视频，便于直接管道到 OSS（失败返回 null） */
  async downloadVideoStream(
    url: string
  ): Promise<{ stream: Readable; contentLength?: number } | null> {
    try {
      const res = await axios.get<Readable>(url, { responseType: "stream", timeout: 120_000 })
      const lenHeader = res.headers["content-length"]
      const contentLength =
        typeof lenHeader === "string" ? Number.parseInt(lenHeader, 10) : undefined
      return {
        stream: res.data,
        contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
      }
    } catch (error: unknown) {
      this.logger.error(`[Atlas] 下载视频失败: ${this.errMsg(error)}`)
      return null
    }
  }

  // ==================== 私有 ====================

  /**
   * 按 (tier × mode) 组装各模型的扁平字段（提交体 = { model, ...本函数返回 }）。
   * 字段名/取值均依据 atlas 各模型页 ?tab=api 的「完整示例」逐一核对，各模型差异较大：
   *   Kling i2v    image / end_image / duration / sound
   *   Kling r2v    images / video / aspect_ratio / duration / sound / keep_original_sound
   *   Kling V3 Turbo i2v  image / prompt / duration（3–15）/ resolution（720p/1080p）（无尾帧 / 比例 / 音频）
   *   Kling O3 video-edit  prompt / video（≤10s）/ images（≤4 参考图）/ keep_original_sound（无时长 / 比例 / 分辨率）
   *   Veo i2v      image / last_image / aspect_ratio / duration / resolution / generate_audio
   *   Gemini r2v   images / aspect_ratio / duration / resolution（仅图，无视频/音频/声音）
   *   Seedance i2v image / last_image / duration / resolution / ratio / generate_audio
   *   Seedance r2v reference_images / reference_videos / reference_audios / duration / resolution / ratio / generate_audio
   * 任一模型字段有出入，只改本函数对应分支即可。
   */
  private buildBody(p: AtlasVideoParams): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const set = (k: string, v: unknown) => {
      if (v === undefined || v === null) return
      if (Array.isArray(v) && v.length === 0) return
      out[k] = v
    }
    const key = `${p.tier}:${p.mode}`
    switch (key) {
      case "video-lite:NORMAL": // Kling o3 图生视频
        set("prompt", p.prompt)
        set("image", p.firstFrameUrl)
        set("end_image", p.lastFrameUrl)
        set("duration", p.durationSec)
        set("sound", p.generateAudio)
        break
      case "video-turbo:NORMAL": // Kling V3.0 Turbo 图生视频
        // 真源为 Atlas OpenAPI Input Schema（schema.json）：仅 image / prompt / duration(3–15) / resolution(720p/1080p)，
        // 无尾帧 / 比例 / 音频 / cfg_scale（页面下方营销版 Parameters 表过时，以 Raw Schema 为准）
        set("prompt", p.prompt)
        set("image", p.firstFrameUrl)
        set("duration", p.durationSec)
        set("resolution", p.resolution)
        break
      case "video-edit:REFERENCE": // Kling O3 视频编辑（video-edit，仅取首个参考视频作源视频）
        // 真源为 Atlas OpenAPI Input Schema（schema.json）：prompt(必) / video(必，≤10s) /
        // images(可选，≤4 张参考图) / keep_original_sound(默认 true)；无时长 / 比例 / 分辨率 / generate_audio
        set("prompt", p.prompt)
        set("video", p.refVideoUrls?.[0])
        set("images", p.refImageUrls)
        set("keep_original_sound", p.keepSourceAudio)
        break
      case "video-lite:REFERENCE": // Kling o3 参考生视频（仅取首个参考视频，video 为单值）
        set("prompt", p.prompt)
        set("images", p.refImageUrls)
        set("video", p.refVideoUrls?.[0])
        set("aspect_ratio", p.aspectRatio)
        set("duration", p.durationSec)
        set("sound", p.generateAudio)
        set("keep_original_sound", p.keepSourceAudio)
        break
      case "video-flash:NORMAL": // Veo 3.1 fast 图生视频
        set("prompt", p.prompt)
        set("image", p.firstFrameUrl)
        set("last_image", p.lastFrameUrl)
        set("aspect_ratio", p.aspectRatio)
        set("duration", p.durationSec)
        set("resolution", p.resolution)
        set("generate_audio", p.generateAudio)
        break
      case "video-flash:REFERENCE": // Gemini Omni Flash（仅参考图）
        set("prompt", p.prompt)
        set("images", p.refImageUrls)
        set("aspect_ratio", p.aspectRatio)
        set("duration", p.durationSec)
        set("resolution", p.resolution)
        break
      case "video-flash-reference:REFERENCE": // Gemini Omni Flash 参考生视频（图 1–5 + 恰好 1 个源视频）
        set("prompt", p.prompt)
        set("images", p.refImageUrls)
        // video_clips 恰好 1 个对象，含 url/start/ends（注意字段名是 ends）；
        // 取整段默认窗口 [0,10]（ends−start ≤10s），前端暂不传裁剪点
        if (p.refVideoUrls?.[0]) {
          out.video_clips = [{ url: p.refVideoUrls[0], start: 0, ends: 10 }]
        }
        set("duration", p.durationSec) // enum 4/6/8/10
        set("aspect_ratio", p.aspectRatio)
        set("resolution", p.resolution)
        // 无 generate_audio / keep_original_sound
        break
      case "video-pro:NORMAL": // Seedance 2.0 图生视频
      case "video-mini:NORMAL": // Seedance 2.0 Mini 图生视频
      case "video-ultra:NORMAL": // Seedance 2.0 Fast 图生视频
        set("prompt", p.prompt)
        set("image", p.firstFrameUrl)
        set("last_image", p.lastFrameUrl)
        set("duration", p.durationSec)
        set("resolution", p.resolution)
        set("ratio", p.aspectRatio)
        set("generate_audio", p.generateAudio)
        break
      case "video-seedance-2-5:NORMAL":
        set("prompt", p.prompt)
        set("image", p.firstFrameUrl)
        set("last_image", p.lastFrameUrl)
        set("duration", p.durationSec)
        set("resolution", p.resolution)
        set("ratio", p.aspectRatio)
        set("generate_audio", p.generateAudio)
        set("watermark", p.watermark)
        set("return_last_frame", false)
        set("output_format", p.outputFormat)
        break
      case "video-pro:REFERENCE": // Seedance 2.0 参考生视频（参考视频为数组，最多 3 个）
      case "video-mini:REFERENCE": // Seedance 2.0 Mini 参考生视频（参数结构与完整版一致）
      case "video-ultra-reference:REFERENCE": // Seedance 2.0 Fast 参考生视频（Atlas 链路）
        set("prompt", p.prompt)
        set("reference_images", p.refImageUrls)
        set("reference_videos", p.refVideoUrls)
        set("reference_audios", p.refAudioUrls)
        set("duration", p.durationSec)
        set("resolution", p.resolution)
        set("ratio", p.aspectRatio)
        set("generate_audio", p.generateAudio)
        break
      case "video-seedance-2-5:REFERENCE":
        set("prompt", p.prompt)
        set("reference_images", p.refImageUrls)
        set("reference_videos", p.refVideoUrls)
        set("reference_audios", p.refAudioUrls)
        set("duration", p.durationSec)
        set("resolution", p.resolution)
        set("ratio", p.aspectRatio)
        set("generate_audio", p.generateAudio)
        set("watermark", p.watermark)
        set("return_last_frame", false)
        set("output_format", p.outputFormat)
        break
    }
    return out
  }

  private authHeaders() {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }
  }

  private pickError(d: AtlasPredictionData): string {
    return this.extractError(d) || "视频生成失败"
  }

  private errMsg(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return this.extractError(error.response?.data) || error.message
    }
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * 从上游各种错误形态里抽出「一句纯文本」错误，不再回吐整坨 JSON：
   * - 对象：按 message / msg / error / errorMessage / data 优先级递归取
   * - 字符串：若内嵌 `body: {json}` 或整串是 JSON，则解析内层再递归（上游偶发双层包裹）
   * 各模型字段不一致（msg vs message）、提交/查询两套响应壳，都在此收口为统一纯文本。
   */
  private extractError(input: unknown, depth = 0): string {
    if (input == null || depth > 5) return ""
    if (typeof input === "object") {
      const o = input as Record<string, unknown>
      for (const c of [o.message, o.msg, o.error, o.errorMessage, o.data]) {
        const s = this.extractError(c, depth + 1)
        if (s) return s
      }
      return ""
    }
    // 走到这里 input 已排除 null/object，仅剩原始类型；显式收窄以避免对象被 "[object Object]" 化
    if (typeof input !== "string" && typeof input !== "number" && typeof input !== "boolean") {
      return ""
    }
    const str = String(input).trim()
    if (!str) return ""
    const i = str.indexOf("body:")
    const jsonStr = i >= 0 ? str.slice(i + 5).trim() : str.startsWith("{") ? str : ""
    if (jsonStr) {
      try {
        const inner = this.extractError(JSON.parse(jsonStr), depth + 1)
        if (inner) return inner
      } catch {
        // 解析失败则退回原字符串
      }
    }
    return str
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /** 安全序列化上游原始返回，便于排查（循环引用兜底为 String） */
  private rawJson(v: unknown): string {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
}
