import { BadGatewayException, Injectable, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import axios from "axios"
import FormData from "form-data"

interface ZixiaoyunResponse {
  status?: unknown
  statusCode?: unknown
  resultData?: unknown
  url?: unknown
}

export interface WashedImage {
  url: string
}

@Injectable()
export class ZixiaoyunProvider {
  private readonly apiUrl: string
  private readonly apiToken: string

  constructor(config: ConfigService) {
    this.apiUrl = config.get<string>("ZIXIAOYUN_API_URL")?.trim() ?? ""
    this.apiToken = config.get<string>("ZIXIAOYUN_API_TOKEN")?.trim() ?? ""
  }

  async washImageUrl(sourceUrl: string): Promise<WashedImage> {
    if (!this.apiUrl || !this.apiToken) {
      throw new ServiceUnavailableException("洗链接服务未配置，请联系管理员")
    }

    const form = new FormData()
    form.append("api_token", this.apiToken)
    form.append("upload_format", "url")
    form.append("uploadedFile", sourceUrl)

    let status: number
    let data: ZixiaoyunResponse
    try {
      const response = await axios.post<ZixiaoyunResponse>(this.apiUrl, form, {
        headers: form.getHeaders(),
        timeout: 60_000,
        validateStatus: () => true,
      })
      status = response.status
      data = response.data
    } catch (error) {
      const message = error instanceof Error ? error.message : "网络请求失败"
      throw new BadGatewayException(`洗链接服务请求失败：${message}`)
    }

    const rawStatusCode = data?.statusCode
    const statusCode =
      typeof rawStatusCode === "string" || typeof rawStatusCode === "number"
        ? String(rawStatusCode)
        : ""
    if (status < 200 || status >= 300 || statusCode !== "200" || typeof data?.url !== "string") {
      const reason =
        typeof data?.resultData === "string" && data.resultData.trim()
          ? data.resultData.trim()
          : `第三方状态码 ${statusCode || status}`
      throw new BadGatewayException(`图片洗链接失败：${reason}`)
    }

    return { url: data.url }
  }
}
