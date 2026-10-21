import { GenerateVideosOperation, GoogleGenAI } from "@google/genai"
import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import type { Readable } from "stream"

// ==================== 类型 ====================

/** Nano Banana 2 (gemini-3.1-flash-image-preview) 支持的宽高比 */
const IMAGE_SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1",
  "1:4",
  "1:8",
  "2:3",
  "3:2",
  "3:4",
  "4:1",
  "4:3",
  "4:5",
  "5:4",
  "8:1",
  "9:16",
  "16:9",
  "21:9",
])

/** Veo 3.1 支持的宽高比 */
const VIDEO_SUPPORTED_ASPECT_RATIOS = new Set(["16:9", "9:16"])

/** Veo 3.1 Lite 仅支持离散时长 4 / 6 / 8；非法值会被 snap 到最近的合法值 */
const VIDEO_ALLOWED_DURATIONS = [4, 6, 8] as const
const VIDEO_DEFAULT_DURATION = 4

export interface GenerateImageOptions {
  /** 输出图片宽高比，如 16:9 / 9:16 / 3:4 */
  aspectRatio?: string
  /** 垫图 URL 列表（可选，最多几张，用作参考） */
  refImageUrls?: string[]
}

export interface GeneratedImage {
  data: Buffer
  mimeType: string
}

export interface GenerateVideoOptions {
  /** 输出宽高比，只支持 16:9 / 9:16；非法值会被丢弃，由 Veo 用默认值 */
  aspectRatio?: string
  /** 时长秒数，Veo 3.1 Lite 仅支持 4 / 6 / 8，非法值会被 snap 到最近合法值 */
  durationSec?: number
  /** 首帧垫图 URL（作为视频起始画面） */
  firstFrameUrl?: string
  /** 尾帧垫图 URL（作为视频结束画面） */
  lastFrameUrl?: string
}

/** Veo 返回的 long-running operation 的通用结构（SDK 类型） */
export type VeoOperation = Awaited<ReturnType<GoogleGenAI["models"]["generateVideos"]>>

/**
 * 归一化的 Veo 任务结果，刻意与 AtlasProvider.AtlasJobResult 同构，
 * 便于视频创作模块在 Atlas / Google 两条链路间无缝切换。
 */
export interface VeoJobResult {
  status: "GENERATING" | "SUCCESS" | "FAILED" | "TIMEOUT"
  /** 成功时的视频下载地址（需带 API key 头下载） */
  url?: string
  errorMessage?: string
}

/** 视频创作官方 Veo 入参（常规模式 video-flash 图生 / 全能参考 video-lite 参考生） */
export interface SubmitVeoParams {
  prompt?: string
  /** 默认 veo-3.1-fast-generate-preview */
  model?: string
  aspectRatio?: string
  durationSec?: number
  resolution?: string
  generateAudio?: boolean
  firstFrameUrl?: string
  lastFrameUrl?: string
  /** 参考图 URL（1–3 张，referenceType=asset；与首/尾帧互斥，由上层能力矩阵保证） */
  refImageUrls?: string[]
}

@Injectable()
export class GoogleProvider {
  private readonly logger = new Logger(GoogleProvider.name)
  private readonly ai: GoogleGenAI
  private readonly apiKey: string

  private static readonly TEXT_MODEL = "gemini-2.5-flash"
  static readonly IMAGE_MODEL = "gemini-3.1-flash-image-preview"
  private static readonly VIDEO_MODEL = "veo-3.1-lite-generate-preview"
  /** 视频创作「常规模式 video-flash」走官方 Veo 3.1 Fast */
  private static readonly VIDEO_FLASH_MODEL = "veo-3.1-fast-generate-preview"
  private static readonly VIDEO_POLL_INTERVAL_MS = 10_000
  private static readonly VIDEO_MAX_POLL_MS = 20 * 60 * 1000

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>("GEMINI_API_KEY") || ""
    this.ai = new GoogleGenAI({ apiKey: this.apiKey })
  }

  // ==================== 文本（Gemini 2.5 Flash） ====================

  /** 调用 Gemini 生成文本 */
  async generateText(systemPrompt: string, userPrompt: string): Promise<string | null> {
    try {
      const response = await this.ai.models.generateContent({
        model: GoogleProvider.TEXT_MODEL,
        contents: userPrompt,
        config: {
          systemInstruction: systemPrompt,
        },
      })
      return response.text ?? null
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`Gemini 调用失败: ${message}`)
      return null
    }
  }

  /** 调用 Gemini 并开启 Google 搜索工具（web grounding），用于实时信息类任务 */
  async generateTextWithSearch(systemPrompt: string, userPrompt: string): Promise<string | null> {
    try {
      const response = await this.ai.models.generateContent({
        model: GoogleProvider.TEXT_MODEL,
        contents: userPrompt,
        config: {
          systemInstruction: systemPrompt,
          tools: [{ googleSearch: {} }],
        },
      })
      return response.text ?? null
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`Gemini (with search) 调用失败: ${message}`)
      return null
    }
  }

  /** 调用 Gemini Deep Research（Interactions API） */
  async deepSearch(query: string): Promise<string | null> {
    try {
      const interaction = await this.ai.interactions.create({
        input: query,
        agent: "deep-research-pro-preview-12-2025",
        background: true,
      })

      const interactionId = interaction.id
      this.logger.log(`Deep Research 已启动 [ID: ${interactionId}]`)

      // 轮询等待完成
      while (true) {
        const result = await this.ai.interactions.get(interactionId)

        this.logger.log(`Deep Research 状态: ${result.status}`)

        if (result.status === "completed") {
          const outputs = result.outputs ?? []
          if (outputs.length === 0) return null
          const lastOutput = outputs[outputs.length - 1]
          if ("text" in lastOutput && typeof lastOutput.text === "string") {
            return lastOutput.text
          }
          if ("parts" in lastOutput && Array.isArray(lastOutput.parts)) {
            const parts = lastOutput.parts as Array<{ text?: string }>
            return parts.map(p => p.text ?? "").join("") || null
          }
          this.logger.warn(
            `Deep Research outputs 结构未知: ${JSON.stringify(lastOutput).slice(0, 200)}`
          )
          return null
        }

        if (result.status === "failed" || result.status === "cancelled") {
          this.logger.error(
            `Deep Research 失败: ${result.status}, 详情: ${JSON.stringify(result).slice(0, 500)}`
          )
          return null
        }

        await new Promise(resolve => setTimeout(resolve, 10000))
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? error.stack : ""
      this.logger.error(`Deep Research 调用失败: ${message}`, stack)
      return null
    }
  }

  // ==================== 图片（Nano Banana 2） ====================

  /** 调用 Gemini Nano Banana 生成一张图片，返回原始字节 */
  async generateImage(
    prompt: string,
    options: GenerateImageOptions = {}
  ): Promise<GeneratedImage | null> {
    const startedAt = Date.now()
    try {
      const parts: Array<Record<string, unknown>> = [{ text: prompt }]

      if (options.refImageUrls?.length) {
        this.logger.log(`  [NanoBanana] 下载垫图 ${options.refImageUrls.length} 张`)
        for (const url of options.refImageUrls) {
          const ref = await this.fetchImageAsInlineData(url)
          if (ref) parts.push({ inlineData: ref })
        }
      }

      const aspectRatio =
        options.aspectRatio && IMAGE_SUPPORTED_ASPECT_RATIOS.has(options.aspectRatio)
          ? options.aspectRatio
          : undefined

      this.logger.log(
        `  [NanoBanana] 发起请求 model=${GoogleProvider.IMAGE_MODEL} aspectRatio=${aspectRatio ?? "默认"}`
      )
      const response = await this.ai.models.generateContent({
        model: GoogleProvider.IMAGE_MODEL,
        contents: [{ role: "user", parts }],
        config: {
          responseModalities: ["IMAGE"],
          ...(aspectRatio && { imageConfig: { aspectRatio } }),
        },
      })

      const responseParts = response.candidates?.[0]?.content?.parts ?? []
      for (const part of responseParts) {
        if (part.inlineData?.data) {
          const buf = Buffer.from(part.inlineData.data, "base64")
          this.logger.log(
            `  [NanoBanana] 响应完成 耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s 大小=${(buf.length / 1024).toFixed(1)}KB`
          )
          return {
            data: buf,
            mimeType: part.inlineData.mimeType || "image/png",
          }
        }
      }

      this.logger.warn("Gemini 响应中未找到图片数据")
      return null
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`Gemini 生图失败: ${message}`)
      return null
    }
  }

  // ==================== 视频（Veo 3.1） ====================

  /** 视频创作常规模式 video-flash 实际使用的官方 Veo 模型 id（供上层审计/计费 meta 记录） */
  getVeoFlashModelId(): string {
    return GoogleProvider.VIDEO_FLASH_MODEL
  }

  /** 启动一次视频生成，返回 operation（包含 operation.name 可用于恢复轮询） */
  async startVideoGeneration(
    prompt: string,
    options: GenerateVideoOptions = {}
  ): Promise<VeoOperation | null> {
    try {
      const aspectRatio =
        options.aspectRatio && VIDEO_SUPPORTED_ASPECT_RATIOS.has(options.aspectRatio)
          ? options.aspectRatio
          : undefined
      const rawDuration = options.durationSec ?? VIDEO_DEFAULT_DURATION
      const durationSec = VIDEO_ALLOWED_DURATIONS.reduce((prev, curr) =>
        Math.abs(curr - rawDuration) < Math.abs(prev - rawDuration) ? curr : prev
      )

      if (options.firstFrameUrl || options.lastFrameUrl) {
        this.logger.log(
          `  [Veo] 下载首尾帧 first=${options.firstFrameUrl ? "有" : "无"} last=${options.lastFrameUrl ? "有" : "无"}`
        )
      }
      const firstFrame = options.firstFrameUrl
        ? await this.fetchImageAsVideoFrame(options.firstFrameUrl)
        : undefined
      const lastFrame = options.lastFrameUrl
        ? await this.fetchImageAsVideoFrame(options.lastFrameUrl)
        : undefined

      const config: Record<string, unknown> = { durationSeconds: durationSec }
      if (aspectRatio) config.aspectRatio = aspectRatio
      if (lastFrame) config.lastFrame = lastFrame

      this.logger.log(
        `  [Veo] 发起请求 model=${GoogleProvider.VIDEO_MODEL} aspectRatio=${aspectRatio ?? "默认"} durationSec=${durationSec}`
      )
      const operation = await this.ai.models.generateVideos({
        model: GoogleProvider.VIDEO_MODEL,
        prompt,
        ...(firstFrame && { image: firstFrame }),
        config,
      })
      this.logger.log(`  [Veo] 任务已提交 operation=${operation.name ?? "unknown"}`)
      return operation
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`Veo 启动失败: ${message}`)
      return null
    }
  }

  /** 轮询直到 operation.done，返回最终 operation；超时或失败返回 null */
  async pollUntilDone(operation: VeoOperation): Promise<VeoOperation | null> {
    const start = Date.now()
    let op = operation
    let tick = 0
    const opName = op.name ?? "unknown"
    while (!op.done) {
      if (Date.now() - start > GoogleProvider.VIDEO_MAX_POLL_MS) {
        this.logger.warn(`Veo 轮询超时 [op=${opName}]`)
        return null
      }
      await new Promise(resolve => setTimeout(resolve, GoogleProvider.VIDEO_POLL_INTERVAL_MS))
      tick += 1
      try {
        op = await this.ai.operations.getVideosOperation({ operation: op })
        const elapsed = ((Date.now() - start) / 1000).toFixed(0)
        this.logger.log(`  [Veo] 第 ${tick} 次轮询 op=${opName} done=${op.done} 已等=${elapsed}s`)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.logger.error(`Veo 轮询出错: ${message}`)
        return null
      }
    }
    return op
  }

  /**
   * 拿到完成的 operation 后，发起流式下载并返回 Readable + 可能的 contentLength。
   * 调用方应 `pipe` 到 OSS / 文件，避免把整段视频读进 Node 堆（每个视频可能 50-150MB）。
   */
  async downloadVideoStream(
    operation: VeoOperation
  ): Promise<{ stream: Readable; contentLength?: number } | null> {
    try {
      const generated = operation.response?.generatedVideos?.[0]?.video
      if (!generated) {
        this.logger.warn("Veo 响应中未找到视频数据")
        return null
      }

      const anyGen = generated as unknown as { uri?: string; downloadUri?: string }
      const uri = anyGen.uri || anyGen.downloadUri
      if (!uri) {
        this.logger.warn("Veo 视频无可用下载地址")
        return null
      }

      this.logger.log(`  [Veo] 开始流式下载 uri=${uri.slice(0, 80)}...`)
      const response = await axios.get<Readable>(uri, {
        responseType: "stream",
        headers: { "x-goog-api-key": this.apiKey },
        timeout: 120_000,
      })
      const lenHeader = response.headers["content-length"]
      const contentLength =
        typeof lenHeader === "string" ? Number.parseInt(lenHeader, 10) : undefined
      return {
        stream: response.data,
        contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`Veo 下载视频失败: ${message}`)
      return null
    }
  }

  // ============ 视频创作模块专用：官方 Veo（与 Atlas 三件套同构） ============

  /**
   * 提交一次官方 Veo image-to-video 任务（常规模式 video-flash）。
   * 与 AtlasProvider.startVideo 对齐：成功返回 { id }（= operation.name），失败返回 { error }（原样上游报错）。
   */
  async submitVeo(params: SubmitVeoParams): Promise<{ id: string } | { error: string }> {
    const model = params.model ?? GoogleProvider.VIDEO_FLASH_MODEL
    try {
      const aspectRatio =
        params.aspectRatio && VIDEO_SUPPORTED_ASPECT_RATIOS.has(params.aspectRatio)
          ? params.aspectRatio
          : undefined
      const durationSec =
        params.durationSec != null
          ? VIDEO_ALLOWED_DURATIONS.reduce((prev, curr) =>
              Math.abs(curr - params.durationSec!) < Math.abs(prev - params.durationSec!)
                ? curr
                : prev
            )
          : undefined

      const firstFrame = params.firstFrameUrl
        ? await this.fetchImageAsVideoFrame(params.firstFrameUrl)
        : undefined
      const lastFrame = params.lastFrameUrl
        ? await this.fetchImageAsVideoFrame(params.lastFrameUrl)
        : undefined

      // 参考生视频：1–3 张 asset 参考图（保持主体外观）。垫图下载失败直接报错，
      // 不能静默丢图——少传一张参考图会改变生成语义。
      let referenceImages: Array<{ image: unknown; referenceType: string }> | undefined
      if (params.refImageUrls?.length) {
        const frames = await Promise.all(
          params.refImageUrls.map(url => this.fetchImageAsVideoFrame(url))
        )
        if (frames.some(f => !f)) {
          return { error: "参考图下载失败，请检查图片地址后重试" }
        }
        referenceImages = frames.map(image => ({ image: image!, referenceType: "asset" }))
      }

      const config: Record<string, unknown> = {}
      if (durationSec != null) config.durationSeconds = durationSec
      if (aspectRatio) config.aspectRatio = aspectRatio
      if (params.resolution) config.resolution = params.resolution
      if (lastFrame) config.lastFrame = lastFrame
      if (referenceImages) config.referenceImages = referenceImages
      // 注意：Veo 3.1 / 3.1 Fast 音频「始终开启」，官方 API 没有 generateAudio 开关，
      // 透传（尤其是 false）会被判为不支持的参数而报错，故此处一律不下发。

      this.logger.log(
        `  [Veo] 发起请求 model=${model} aspectRatio=${aspectRatio ?? "默认"} ` +
          `durationSec=${durationSec ?? "默认"} resolution=${params.resolution ?? "默认"} ` +
          `referenceImages=${referenceImages?.length ?? 0}`
      )
      const operation = await this.ai.models.generateVideos({
        model,
        ...(params.prompt ? { prompt: params.prompt } : {}),
        ...(firstFrame && { image: firstFrame }),
        config,
      })
      this.logger.log(`  [Veo] 提交原始返回 model=${model}: ${this.rawJson(operation)}`)
      if (!operation.name) return { error: "Veo 未返回 operation name" }
      this.logger.log(`  [Veo] 任务已提交 operation=${operation.name}`)
      return { id: operation.name }
    } catch (error: unknown) {
      this.logger.error(`  [Veo] 提交原始错误 model=${model}: ${this.rawJson(error)}`)
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`Veo 启动失败 model=${model}: ${message}`)
      return { error: message }
    }
  }

  /**
   * 按 operation name 轮询 Veo 到结束（进程重启后也可凭 name 续跑）。
   * 与 AtlasProvider.pollUntilDone 对齐，归一化为 SUCCESS / FAILED / TIMEOUT；瞬时轮询错误继续重试，由墙钟超时兜底。
   */
  async pollVeo(operationName: string): Promise<VeoJobResult> {
    const start = Date.now()
    // 必须用真正的 GenerateVideosOperation 实例（SDK getVideosOperation 会调用其 _fromAPIResponse），
    // 普通对象会报 "operation._fromAPIResponse is not a function"
    const seed = new GenerateVideosOperation()
    seed.name = operationName
    let op: VeoOperation = seed
    let tick = 0
    while (!op.done) {
      if (Date.now() - start > GoogleProvider.VIDEO_MAX_POLL_MS) {
        this.logger.warn(`Veo 轮询超时 [op=${operationName}]`)
        return { status: "TIMEOUT", errorMessage: "视频生成超时" }
      }
      await new Promise(resolve => setTimeout(resolve, GoogleProvider.VIDEO_POLL_INTERVAL_MS))
      tick += 1
      try {
        op = await this.ai.operations.getVideosOperation({ operation: op })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.logger.error(`Veo 轮询出错（将重试）[op=${operationName}]: ${message}`)
        continue
      }
      const elapsed = ((Date.now() - start) / 1000).toFixed(0)
      this.logger.log(
        `  [Veo] 第 ${tick} 次轮询 op=${operationName} done=${op.done} 已等=${elapsed}s`
      )
      this.logger.log(`  [Veo] 第 ${tick} 次轮询原始返回 op=${operationName}: ${this.rawJson(op)}`)
    }

    if (op.error) {
      const err = op.error as { message?: string }
      return { status: "FAILED", errorMessage: err.message || "视频生成失败" }
    }
    const uri = this.extractVeoUri(op)
    if (!uri) {
      // 完成却无视频，最常见是被内容安全（RAI）过滤（如真人/人物生成限制）。
      // Veo 把原因放在 response.raiMediaFilteredReasons，优先回传，并打全量响应日志便于定位。
      const resp = op.response as
        | { raiMediaFilteredCount?: number; raiMediaFilteredReasons?: string[] }
        | undefined
      this.logger.warn(
        `Veo 完成但无视频 [op=${operationName}] response=${JSON.stringify(op.response ?? {})}`
      )
      const reasons = resp?.raiMediaFilteredReasons
      if (reasons?.length) {
        return { status: "FAILED", errorMessage: reasons.join("; ") }
      }
      return {
        status: "FAILED",
        errorMessage: "视频被内容安全策略拦截或未生成，请调整提示词/图片后重试",
      }
    }
    return { status: "SUCCESS", url: uri }
  }

  /** 按 Veo 下载地址拉取视频为 Buffer（需带 API key 头）。与 AtlasProvider.downloadVideoBuffer 对齐。 */
  async downloadVeoBuffer(uri: string): Promise<Buffer | null> {
    try {
      const res = await axios.get<ArrayBuffer>(uri, {
        responseType: "arraybuffer",
        headers: { "x-goog-api-key": this.apiKey },
        timeout: 120_000,
      })
      return Buffer.from(res.data)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`Veo 下载视频失败: ${message}`)
      return null
    }
  }

  /** 安全序列化上游原始返回，便于排查（循环引用兜底为 String） */
  private rawJson(v: unknown): string {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }

  /** 从完成的 operation 提取视频下载地址 */
  private extractVeoUri(op: VeoOperation): string | undefined {
    const generated = op.response?.generatedVideos?.[0]?.video
    const anyGen = generated as unknown as { uri?: string; downloadUri?: string } | undefined
    return anyGen?.uri || anyGen?.downloadUri
  }

  // ==================== 内部工具 ====================

  /** 下载外链图片转为 Gemini inlineData 结构（图片生成用） */
  private async fetchImageAsInlineData(
    url: string
  ): Promise<{ mimeType: string; data: string } | null> {
    try {
      const { data, headers } = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: 30_000,
      })
      const mimeType =
        (headers["content-type"] as string | undefined)?.split(";")[0].trim() || "image/png"
      return { mimeType, data: Buffer.from(data).toString("base64") }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`下载垫图失败 [${url}]: ${message}`)
      return null
    }
  }

  /** 下载外链图片转为 Veo SDK 的 inline image 结构（视频首尾帧用） */
  private async fetchImageAsVideoFrame(
    url: string
  ): Promise<{ imageBytes: string; mimeType: string } | null> {
    try {
      const { data, headers } = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: 30_000,
      })
      const mimeType =
        (headers["content-type"] as string | undefined)?.split(";")[0].trim() || "image/png"
      return { imageBytes: Buffer.from(data).toString("base64"), mimeType }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(`Veo 下载垫图失败 [${url}]: ${message}`)
      return null
    }
  }
}
