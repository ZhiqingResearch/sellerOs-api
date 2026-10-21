import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios, { type AxiosResponse } from "axios"
import FormData from "form-data"
import { Agent as HttpsAgent } from "node:https"
import { extname } from "node:path"

const DEFAULT_BASE_URL = "https://api.yingdao.com"
const REQUEST_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 60_000
const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_FILE_NAME_LENGTH = 100

export interface YingdaoAccessToken {
  accessToken: string
  expiresIn: number
}

export interface YingdaoFlowParam {
  name: string
  direction: string
  type: string
  value: string
  description: string
  kind: string
}

export interface YingdaoAppOnlineDetail {
  appId: string
  appName: string
  appType: string
  publishVersion: string
  firstPublish: boolean
  publishUserId: string
  publishAccount: string
  publishTime: string
  flowParams: YingdaoFlowParam[]
  uiTags: string
  terminalTags: string
  extraInfo: string
}

export interface YingdaoTaskParam {
  name: string
  value: string
  type: string
}

export interface YingdaoScheduleRelaParam {
  robotUuid: string
  runTimeout?: number
  params?: YingdaoTaskParam[]
}

export interface YingdaoStartTaskRequest {
  scheduleUuid: string
  idempotentUuid?: string
  scheduleRelaParams?: YingdaoScheduleRelaParam[]
}

export interface YingdaoStartTaskResult {
  taskUuid: string
  jobUuidList: string[]
  idempotentFlag: boolean
}

export interface YingdaoUploadResult {
  fileKey: string
}

interface YingdaoApiResponse<T> {
  data?: T
  code: number
  success: boolean
  requestId?: string
  serverIp?: string
  serverInstName?: string
  msg?: string | null
}

export class YingdaoRequestError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly httpStatus?: number,
    readonly requestCode?: string
  ) {
    super(message)
    this.name = "YingdaoRequestError"
  }
}

@Injectable()
export class YingdaoProvider implements OnModuleDestroy {
  private readonly logger = new Logger(YingdaoProvider.name)
  private readonly accessKeyId: string
  private readonly accessKeySecret: string
  private readonly baseUrl: string
  /**
   * Node 22 的全局 HTTPS Agent 默认 keep-alive。全量模板同步会快速连续请求影刀，
   * Axios/follow-redirects 可能在复用同一 TLSSocket 时短暂累积 error listener，触发
   * MaxListenersExceededWarning。影刀调用量不高，使用不复用 socket 的专用 Agent
   * 可以从根源隔离监听器生命周期；不使用全局 setMaxListeners 掩盖问题。
   */
  private readonly httpsAgent = new HttpsAgent({ keepAlive: false })
  private cachedToken?: { value: string; expiresAt: number }

  constructor(private readonly config: ConfigService) {
    this.accessKeyId = this.config.get<string>("YINGDAO_ACCESS_KEY_ID", "").trim()
    this.accessKeySecret = this.config.get<string>("YINGDAO_ACCESS_KEY_SECRET", "").trim()
    this.baseUrl = this.config.get<string>("YINGDAO_BASE_URL", DEFAULT_BASE_URL).replace(/\/$/, "")
  }

  onModuleDestroy(): void {
    this.httpsAgent.destroy()
  }

  /** 获取并缓存 accessToken；临近过期前 30 秒会重新获取。 */
  async getAccessToken(forceRefresh = false): Promise<YingdaoAccessToken> {
    if (!forceRefresh && this.cachedToken && Date.now() < this.cachedToken.expiresAt - 30_000) {
      return {
        accessToken: this.cachedToken.value,
        expiresIn: Math.max(0, Math.floor((this.cachedToken.expiresAt - Date.now()) / 1000)),
      }
    }

    if (!this.accessKeyId || !this.accessKeySecret) {
      throw new Error("未配置 YINGDAO_ACCESS_KEY_ID 或 YINGDAO_ACCESS_KEY_SECRET")
    }

    const result = await this.execute("影刀鉴权", () =>
      axios.get<YingdaoApiResponse<YingdaoAccessToken>>(
        `${this.baseUrl}/oapi/token/v2/token/create`,
        {
          params: {
            accessKeyId: this.accessKeyId,
            accessKeySecret: this.accessKeySecret,
          },
          httpsAgent: this.httpsAgent,
          maxRedirects: 0,
          timeout: REQUEST_TIMEOUT_MS,
        }
      )
    )

    this.cachedToken = {
      value: result.accessToken,
      expiresAt: Date.now() + result.expiresIn * 1000,
    }
    this.logger.log(`影刀 accessToken 获取成功，有效期 ${result.expiresIn} 秒`)
    return result
  }

  /** 查询应用当前上线版本及其输入、输出参数。 */
  async getAppOnlineDetail(appId: string): Promise<YingdaoAppOnlineDetail> {
    const token = (await this.getAccessToken()).accessToken
    const result = await this.execute("查询影刀应用上线版本", () =>
      axios.get<YingdaoApiResponse<YingdaoAppOnlineDetail>>(
        `${this.baseUrl}/oapi/app/open/query/appOnlineDetailWithParam`,
        {
          params: { appId },
          headers: this.authHeaders(token),
          httpsAgent: this.httpsAgent,
          maxRedirects: 0,
          timeout: REQUEST_TIMEOUT_MS,
        }
      )
    )
    this.logger.log(`影刀应用上线版本查询成功 [appId: ${appId}]`)
    return result
  }

  /** 启动控制台中已编排的任务。 */
  async startTask(params: YingdaoStartTaskRequest): Promise<YingdaoStartTaskResult> {
    const token = (await this.getAccessToken()).accessToken
    const result = await this.execute("启动影刀任务", () =>
      axios.post<YingdaoApiResponse<YingdaoStartTaskResult>>(
        `${this.baseUrl}/oapi/dispatch/v2/task/start`,
        params,
        {
          headers: {
            ...this.authHeaders(token),
            "Content-Type": "application/json",
          },
          httpsAgent: this.httpsAgent,
          maxRedirects: 0,
          timeout: REQUEST_TIMEOUT_MS,
        }
      )
    )
    this.logger.log(
      `影刀任务启动成功 [scheduleUuid: ${params.scheduleUuid}, taskUuid: ${result.taskUuid}]`
    )
    return result
  }

  /** 上传任务或应用的文件类型输入参数，返回 7 天内有效的 fileKey。 */
  async uploadFile(fileBuffer: Buffer, fileName: string): Promise<YingdaoUploadResult> {
    const normalizedFileName = this.validateFile(fileBuffer, fileName)
    const token = (await this.getAccessToken()).accessToken
    const formData = new FormData()
    formData.append("file", fileBuffer, {
      filename: normalizedFileName,
      contentType: this.resolveContentType(normalizedFileName),
    })

    const result = await this.execute("上传影刀文件", () =>
      axios.post<YingdaoApiResponse<YingdaoUploadResult>>(
        `${this.baseUrl}/oapi/dispatch/v2/file/upload`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            ...this.authHeaders(token),
          },
          // Node 环境上传流不跟随重定向，避免 follow-redirects 缓冲文件并复用旧 socket。
          httpsAgent: this.httpsAgent,
          maxRedirects: 0,
          // multipart 还包含 boundary 和请求头，需为文件本体之外预留少量空间。
          maxBodyLength: MAX_FILE_SIZE + 1024 * 1024,
          timeout: UPLOAD_TIMEOUT_MS,
        }
      )
    )
    this.logger.log(`影刀文件上传成功 [fileName: ${normalizedFileName}]`)
    return result
  }

  private async execute<T>(
    operation: string,
    request: () => Promise<AxiosResponse<YingdaoApiResponse<T>>>
  ): Promise<T> {
    try {
      const { data } = await request()
      if (!data.success || data.code !== 200 || data.data === undefined) {
        throw new Error(data.msg || `code=${data.code}`)
      }
      return data.data
    } catch (error: unknown) {
      if (axios.isAxiosError<YingdaoApiResponse<unknown>>(error)) {
        throw new YingdaoRequestError(
          `${operation}失败：${this.extractErrorMessage(error)}`,
          operation,
          error.response?.status,
          error.code
        )
      }
      throw new Error(`${operation}失败：${this.extractErrorMessage(error)}`)
    }
  }

  private extractErrorMessage(error: unknown): string {
    if (axios.isAxiosError<YingdaoApiResponse<unknown>>(error)) {
      return error.response?.data?.msg || error.message
    }
    return error instanceof Error ? error.message : String(error)
  }

  private authHeaders(accessToken: string): { Accept: string; Authorization: string } {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    }
  }

  private validateFile(fileBuffer: Buffer, fileName: string): string {
    const normalizedFileName = fileName.split(/[\\/]/).pop()?.trim()
    if (!normalizedFileName) throw new Error("文件名不能为空")
    if (normalizedFileName.length > MAX_FILE_NAME_LENGTH) {
      throw new Error(`文件名不能超过 ${MAX_FILE_NAME_LENGTH} 个字符`)
    }
    if (fileBuffer.byteLength > MAX_FILE_SIZE) {
      throw new Error("单个文件不能超过 10MB")
    }

    const extension = extname(normalizedFileName).toLowerCase()
    if (![".txt", ".csv", ".xlsx"].includes(extension)) {
      throw new Error("仅支持 txt、csv、xlsx 文件")
    }
    return normalizedFileName
  }

  private resolveContentType(fileName: string): string {
    const contentTypes: Record<string, string> = {
      ".txt": "text/plain",
      ".csv": "text/csv",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }
    return contentTypes[extname(fileName).toLowerCase()] || "application/octet-stream"
  }
}
