import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import crypto from "crypto"
import FormData from "form-data"

const BASE_URL = "https://open.xiling.baidu.com/api/digitalhuman/open/v1"

// ==================== 类型 ====================

export type AvatarGender = "MALE" | "FEMALE"
export type VoiceGender = "male" | "female" | "unknown"

export interface AvatarWebhookPayload {
  requestId: string
  type: string
  data: {
    figureId: string
    status: "WAIT" | "GENERATING" | "SUCCESS" | "FAILED"
    failedCode?: number
    failedMessage?: string
  }
}

export interface VoiceWebhookPayload {
  requestId: string
  type: string
  data: {
    perId: string
    name: string
    gender?: VoiceGender
    describe?: string
    status: "SUCCESS" | "FAIL"
    exampleText?: string
    exampleAudioUrl?: string
    code?: number
    reason?: string
  }
}

export interface VideoWebhookPayload {
  requestId: string
  type: string
  data: {
    taskId: string
    status: "SUCCESS" | "FAILED"
    failedCode?: number
    failedMessage?: string
    videoUrl?: string
    duration?: number
    subtitleFileUrl?: string
  }
}

export interface XilingAvatarInfo {
  figureId: string
  status?: string
  templateImg?: string | null
  resolutionWidth: number
  resolutionHeight: number
  templateVideoUrl?: string | null
  maskVideoUrl?: string | null
  pictureUrl?: string | null
  systemFigure?: boolean
}

@Injectable()
export class BaiduXilingProvider {
  private readonly logger = new Logger(BaiduXilingProvider.name)
  private readonly appId: string
  private readonly secretKey: string

  constructor(private readonly config: ConfigService) {
    this.appId = this.config.get<string>("XILING_APP_ID", "")
    this.secretKey = this.config.get<string>("XILING_SECRET_KEY", "")
  }

  /** 生成鉴权字符串（默认 1 小时有效） */
  generateAuth(expireMs = 3600000): { authorization: string; expireAt: string } {
    const expireAt = new Date(Date.now() + expireMs).toISOString()
    const signature = crypto
      .createHmac("sha256", this.secretKey)
      .update(this.appId + expireAt)
      .digest("hex")
    return { authorization: `${this.appId}/${signature}/${expireAt}`, expireAt }
  }

  /** 返回文件上传接口地址，供前端直传使用（当前仅形象克隆走前端直传） */
  getUploadEndpoint(): string {
    return `${BASE_URL}/file/upload`
  }

  /** 上传文件到曦灵平台（音色克隆仍由后端代上传） */
  private async uploadFile(
    fileBuffer: Buffer,
    fileName: string,
    providerType: "OPEN_CUSTOMIZATION_2D_GENERAL" | "OPEN_TTS_CLONE_LITE"
  ): Promise<string> {
    const formData = new FormData()
    formData.append("file", fileBuffer, { filename: fileName })
    formData.append("providerType", providerType)
    formData.append("sourceFileName", fileName)

    const { data } = await axios.post<{
      code: number
      message: { global: string }
      result: { fileId: string }
    }>(`${BASE_URL}/file/upload`, formData, {
      headers: {
        ...formData.getHeaders(),
        Authorization: this.generateAuth().authorization,
      },
    })

    if (data.code !== 0) throw new BadRequestException(`上传文件失败: ${data.message.global}`)
    return data.result.fileId
  }

  // ==================== 数字人 ====================

  /** 创建数字人形象（异步训练，通过 webhook 回调）。fileId 由前端直传拿到。 */
  async createAvatar(params: {
    fileId: string
    name: string
    gender: AvatarGender
    callbackUrl: string
  }): Promise<string> {
    const { data } = await axios.post<{
      code: number
      message: { global: string }
      result: { figureId: string }
    }>(
      `${BASE_URL}/figure/lite2d/train`,
      {
        name: params.name,
        customizeType: "LITE_2D_GENERAL",
        gender: params.gender,
        keepBackground: true,
        templateVideoId: params.fileId,
        callbackUrl: params.callbackUrl,
      },
      { headers: { Authorization: this.generateAuth().authorization } }
    )

    if (data.code !== 0) throw new BadRequestException(`创建数字人失败: ${data.message.global}`)
    this.logger.log(`数字人训练已提交 [figureId: ${data.result.figureId}]`)
    return data.result.figureId
  }

  /**
   * 查询数字人形象详情。
   * - 默认查询用户克隆形象：GET /figure/lite2d/query
   * - systemFigure=true 时查询平台公共人像：GET /figure/query?systemFigure=true&item=...
   */
  async queryAvatar(
    figureId: string,
    opts: { systemFigure?: boolean; item?: string } = {}
  ): Promise<XilingAvatarInfo> {
    if (opts.systemFigure) {
      return this.queryPublicAvatar(figureId, opts.item)
    }

    const { data } = await axios.get<{
      code: number
      message: { global: string }
      result: {
        result: XilingAvatarInfo[]
      }
    }>(`${BASE_URL}/figure/lite2d/query`, {
      headers: { Authorization: this.generateAuth().authorization },
      params: { figureId },
    })

    if (data.code !== 0) throw new Error(`查询数字人失败: ${data.message.global}`)
    const result = data.result.result[0]
    if (!result) throw new Error(`未找到 figureId=${figureId} 的数字人`)
    return result
  }

  private async queryPublicAvatar(figureId: string, item?: string): Promise<XilingAvatarInfo> {
    if (!item) throw new Error("查询公共人像必须提供 item")

    const pageSize = 1000
    let pageNo = 1
    while (pageNo <= 100) {
      const { data } = await axios.get<{
        code: number
        message: { global: string }
        result: { result: XilingAvatarInfo[]; totalCount?: number }
      }>(`${BASE_URL}/figure/query`, {
        headers: { Authorization: this.generateAuth().authorization },
        params: { systemFigure: true, item, pageNo, pageSize },
      })

      if (data.code !== 0) throw new Error(`查询公共人像失败: ${data.message.global}`)
      const batch = data.result.result ?? []
      const found = batch.find(f => f.figureId === figureId)
      if (found) return found
      if (batch.length < pageSize) break
      pageNo += 1
    }

    throw new Error(`未找到公共 figureId=${figureId} 的数字人`)
  }

  // ==================== 音色 ====================

  /** 创建声音克隆（异步，通过 webhook 回调） */
  async createVoiceClone(params: {
    audioBuffer: Buffer
    audioFileName: string
    name: string
    gender: VoiceGender
    exampleText: string
    describe?: string
    callbackUrl: string
  }): Promise<string> {
    const fileId = await this.uploadFile(
      params.audioBuffer,
      params.audioFileName,
      "OPEN_TTS_CLONE_LITE"
    )

    const { data } = await axios.post<{
      code: number
      message: { global: string }
      result: { perId: string }
    }>(
      `${BASE_URL}/tts/clone/lite`,
      {
        name: params.name,
        describe: params.describe ?? "",
        gender: params.gender,
        uploadAudioId: fileId,
        exampleText: params.exampleText,
        callbackUrl: params.callbackUrl,
      },
      { headers: { Authorization: this.generateAuth().authorization } }
    )

    if (data.code !== 0) throw new BadRequestException(`声音克隆失败: ${data.message.global}`)
    this.logger.log(`声音克隆已提交 [perId: ${data.result.perId}]`)
    return data.result.perId
  }

  // ==================== 视频合成 ====================

  /**
   * 提交数字人视频合成任务（异步，通过 webhook 回调）。
   * speed/volume/pitch 均为 0-15 整数，不传默认 5；曦灵要求字段类型为 string，所以这里 String() 转一下。
   */
  async createVideoTask(params: {
    figureId: string
    perId: string
    text: string
    width: number
    height: number
    callbackUrl: string
    speed?: number
    volume?: number
    pitch?: number
  }): Promise<string> {
    const { data } = await axios.post<{
      code: number
      message: { global: string }
      result: { taskId: string }
    }>(
      `${BASE_URL}/video/submit`,
      {
        figureId: params.figureId,
        driveType: "TEXT",
        text: params.text,
        ttsParams: {
          person: params.perId,
          speed: String(params.speed ?? 5),
          volume: String(params.volume ?? 5),
          pitch: String(params.pitch ?? 5),
        },
        videoParams: { width: params.width, height: params.height, transparent: false },
        callbackUrl: params.callbackUrl,
      },
      { headers: { Authorization: this.generateAuth().authorization } }
    )

    if (data.code !== 0)
      throw new BadRequestException(`创建视频合成任务失败: ${data.message.global}`)
    this.logger.log(`视频合成已提交 [taskId: ${data.result.taskId}]`)
    return data.result.taskId
  }

  /** 查询声音克隆状态。默认 isSuccess=false 以便对账能拿到失败/进行中任务 */
  async queryVoiceClone(perId: string, isSuccess = false) {
    const { data } = await axios.get<{
      code: number
      message: { global: string }
      result: Array<{
        perId: string
        status: string
        exampleAudioUrl?: string
        reason?: string
      }>
    }>(`${BASE_URL}/tts/clone`, {
      headers: { Authorization: this.generateAuth().authorization },
      params: { perId, isSuccess },
    })

    if (data.code !== 0) throw new Error(`查询声音克隆失败: ${data.message.global}`)
    const result = data.result[0]
    if (!result) throw new Error(`未找到 perId=${perId} 的声音克隆任务`)
    return result
  }

  // ==================== 公共资源列表（供本地 TTL 镜像刷新） ====================

  /**
   * 分页拉取某个 item 类型下的公共形象。接口为 `GET /figure/query?systemFigure=true`，
   * 单页最大 1000。本方法自动翻页拉完所有页。
   *
   * 返回原始对象（不做字段改名），上层在 PublicResourceService 里映射入库。
   */
  async listPublicFigures(
    item: string,
    opts: { pageSize?: number } = {}
  ): Promise<
    Array<{
      figureId: string
      name: string
      systemFigure: boolean
      gender?: string
      resolutionWidth?: number
      resolutionHeight?: number
      templateImg?: string | null
      templateVideoUrl?: string | null
      maskVideoUrl?: string | null
      pictureUrl?: string | null
      pose?: string | null
      background?: string | null
      age?: string | null
      tags?: string[] | null
      customizeType?: string | null
      keepBackground?: boolean | null
    }>
  > {
    const pageSize = opts.pageSize ?? 1000
    const all: Array<Record<string, unknown>> = []
    let pageNo = 1
    // 安全上限：pageSize=1000 × 100 页 = 10 万条，远超百度实际公共人像总量，防无限循环
    while (pageNo <= 100) {
      const { data } = await axios.get<{
        code: number
        message: { global: string }
        result: { result: Array<Record<string, unknown>>; totalCount?: number }
      }>(`${BASE_URL}/figure/query`, {
        headers: { Authorization: this.generateAuth().authorization },
        params: { systemFigure: true, item, pageNo, pageSize },
      })
      if (data.code !== 0) throw new Error(`查询公共人像失败: ${data.message.global}`)
      const batch = data.result.result ?? []
      all.push(...batch)
      if (batch.length < pageSize) break
      pageNo += 1
    }
    return all as Awaited<ReturnType<BaiduXilingProvider["listPublicFigures"]>>
  }

  /**
   * 拉取全量公共音色。接口为 `GET /tts/persons?isSystem=true`，文档未说明分页参数，
   * 一次性返回全部数组。
   */
  async listPublicVoices(): Promise<
    Array<{
      perId: string
      name: string
      describe?: string | null
      version?: string | null
      exampleAudioUrl?: string | null
      gender?: string | null
      systemProvided: boolean
    }>
  > {
    const { data } = await axios.get<{
      code: number
      message: { global: string }
      result: Array<Record<string, unknown>>
    }>(`${BASE_URL}/tts/persons`, {
      headers: { Authorization: this.generateAuth().authorization },
      params: { isSystem: true },
    })
    if (data.code !== 0) throw new Error(`查询公共音色失败: ${data.message.global}`)
    return (data.result ?? []) as Awaited<ReturnType<BaiduXilingProvider["listPublicVoices"]>>
  }

  /** 查询视频合成任务（对账用，webhook 丢失兜底） */
  async queryVideoTask(taskId: string) {
    const { data } = await axios.get<{
      code: number
      message: { global: string }
      result: {
        taskId: string
        status: string // SUBMIT / GENERATING / SUCCESS / FAILED
        failedCode?: number | null
        failedMessage?: string | null
        videoUrl?: string | null
        duration?: number | null
        subtitleFileUrl?: string | null
      }
    }>(`${BASE_URL}/video/task`, {
      headers: { Authorization: this.generateAuth().authorization },
      params: { taskId },
    })

    if (data.code !== 0) throw new Error(`查询视频合成任务失败: ${data.message.global}`)
    return data.result
  }
}
