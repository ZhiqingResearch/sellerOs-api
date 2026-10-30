import Core from "@alicloud/pop-core"
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { createHash } from "node:crypto"
import { isIP } from "node:net"
import {
  field,
  record,
  textValue,
  type ModerationDecision,
  type ModerationInput,
  type ModerationLabel,
  type ModerationMediaType,
  type ModerationReceipt,
  type ModerationResult,
} from "../../content-moderation/moderation.types"

const SERVICES: Record<ModerationMediaType, string> = {
  TEXT: "ugc_moderation_byllm",
  IMAGE: "postImageCheckByVL",
  VIDEO: "videoDetection",
  DOCUMENT: "document_detection",
}

@Injectable()
export class AliyunContentModerationProvider {
  private readonly logger = new Logger(AliyunContentModerationProvider.name)
  private readonly clients = new Map<string, Core>()

  constructor(private readonly config: ConfigService) {}

  get region(): string {
    return this.config.get<string>("CONTENT_MODERATION_REGION") || "cn-shanghai"
  }

  service(type: ModerationMediaType): string {
    return this.config.get<string>(`CONTENT_MODERATION_${type}_SERVICE`) || SERVICES[type]
  }

  validate(input: ModerationInput): void {
    if (input.type === "TEXT") {
      if (!input.content?.trim() || Array.from(input.content).length > 2000) {
        throw new BadRequestException({
          code: "MODERATION_INVALID_INPUT",
          message: "待审核文本不能为空且不能超过2000个字符",
        })
      }
      return
    }
    this.validateUrl(input.url)
  }

  async check(input: ModerationInput, timeoutMs = 10_000): Promise<ModerationResult> {
    this.validate(input)
    if (input.type !== "TEXT" && input.type !== "IMAGE") {
      throw new BadRequestException("视频和文档需要异步审核")
    }
    const parameters = input.type === "TEXT" ? { content: input.content } : { imageUrl: input.url }
    const response = await this.request(
      input.type === "TEXT" ? "TextModerationPlus" : "ImageModeration",
      this.service(input.type),
      parameters,
      this.region,
      timeoutMs
    )
    return this.normalizeContentResult(field(response, "Data"))
  }

  async submit(
    input: ModerationInput,
    dataId: string,
    timeoutMs = 10_000
  ): Promise<ModerationReceipt> {
    this.validate(input)
    if (input.type !== "VIDEO" && input.type !== "DOCUMENT") {
      throw new BadRequestException("该内容不需要创建异步审核")
    }
    const region = this.region
    const service = this.service(input.type)
    const response = await this.request(
      input.type === "VIDEO" ? "VideoModeration" : "FileModeration",
      service,
      {
        url: input.url,
        dataId: createHash("sha256").update(dataId).digest("hex"),
        ...(input.documentType ? { docType: input.documentType } : {}),
      },
      region,
      timeoutMs
    )
    const taskId = textValue(field(field(response, "Data"), "TaskId"))
    if (!taskId) throw this.invalidResponse()
    return {
      taskId,
      requestId: textValue(field(response, "RequestId")),
      region,
      service,
    }
  }

  async poll(
    type: "VIDEO" | "DOCUMENT",
    receipt: ModerationReceipt,
    timeoutMs = 10_000
  ): Promise<ModerationResult | null> {
    const response = await this.request(
      type === "VIDEO" ? "VideoModerationResult" : "DescribeFileModerationResult",
      receipt.service,
      { taskId: receipt.taskId },
      receipt.region,
      timeoutMs
    )
    if (String(field(response, "Code")) === "280") return null
    return this.normalize(field(response, "Data"))
  }

  decide(result: ModerationResult, service: string): ModerationDecision {
    const suggestions = result.dimensions
      .map(item => item.suggestion?.toLowerCase())
      .filter((value): value is string => Boolean(value))
    const overall = result.suggestion?.toLowerCase()
    if (overall && ["block", "watch", "mask", "review"].includes(overall)) return "REJECTED"
    if (suggestions.some(value => ["block", "watch", "mask", "review"].includes(value))) {
      return "REJECTED"
    }
    if (suggestions.some(value => value !== "pass")) return "UNDETERMINED"
    if (overall) return overall === "pass" ? "PASSED" : "UNDETERMINED"

    let policy: Record<string, unknown> = {
      [this.service("TEXT")]: ["none"],
      [this.service("IMAGE")]: ["none"],
      [this.service("VIDEO")]: ["none"],
      [this.service("DOCUMENT")]: ["none"],
    }
    const configured = this.config.get<string>("CONTENT_MODERATION_PASS_RISK_LEVELS")
    if (configured) {
      try {
        const overrides: unknown = JSON.parse(configured)
        if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
          throw new Error("invalid policy")
        policy = { ...policy, ...record(overrides) }
      } catch {
        throw new ServiceUnavailableException({
          code: "MODERATION_NOT_CONFIGURED",
          message: "审核放行配置格式不正确",
        })
      }
    }
    const allowed = policy[service]
    if (!Array.isArray(allowed) || !result.riskLevel) return "UNDETERMINED"
    if (result.dimensions.some(item => item.level && item.level !== result.riskLevel))
      return "UNDETERMINED"
    if (allowed.includes(result.riskLevel)) return "PASSED"
    return ["high", "medium", "low"].includes(result.riskLevel) ? "REJECTED" : "UNDETERMINED"
  }

  private validateUrl(value: string | undefined): void {
    let url: URL
    try {
      url = new URL(value || "")
    } catch {
      throw new BadRequestException("待审核文件地址不合法")
    }
    const configured = this.config.get<string>("CONTENT_MODERATION_ALLOWED_ORIGINS")
    const origins = configured
      ? configured.split(",")
      : [this.config.get<string>("SPACES_BASE_URL"), this.config.get<string>("OSS_BASE_URL")]
    const allowed = origins.filter(Boolean).map(origin => {
      try {
        return new URL(origin!.trim()).origin
      } catch {
        return ""
      }
    })
    // 私有 Spaces 的签名地址使用 bucket.endpoint，而不是公开 CDN 域名。
    if (!configured) {
      const endpoint = this.config.get<string>("SPACES_ENDPOINT")
      const bucket = this.config.get<string>("SPACES_BUCKET")
      if (endpoint && bucket) {
        try {
          const parsed = new URL(endpoint)
          allowed.push(`${parsed.protocol}//${bucket}.${parsed.host}`)
        } catch {
          /* 无效的存储配置不能扩大允许范围。 */
        }
      }
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443") ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      !allowed.includes(url.origin)
    ) {
      throw new BadRequestException({
        code: "MODERATION_INVALID_INPUT",
        message: "审核文件必须来自已配置的可信存储地址",
      })
    }
  }

  private async request(
    action: string,
    service: string,
    parameters: object,
    region = this.region,
    timeoutMs = 10_000
  ): Promise<Record<string, unknown>> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region)) {
      throw new ServiceUnavailableException("审核地域配置不正确")
    }
    let client = this.clients.get(region)
    if (!client) {
      const accessKeyId = this.config.get<string>("ZQ_ACCESS_KEY_ID")
      const accessKeySecret = this.config.get<string>("ZQ_ACCESS_KEY_SECRET")
      if (!accessKeyId || !accessKeySecret) {
        throw new ServiceUnavailableException({
          code: "MODERATION_NOT_CONFIGURED",
          message: "内容审核服务尚未配置",
        })
      }
      client = new Core({
        accessKeyId,
        accessKeySecret,
        endpoint: `https://green-cip.${region}.aliyuncs.com`,
        apiVersion: "2022-03-02",
        codes: [280, "280"],
      })
      this.clients.set(region, client)
    }
    try {
      const response = await client.request<unknown>(
        action,
        {
          Service: service,
          ServiceParameters: JSON.stringify(parameters),
        },
        {
          method: "POST",
          formatParams: false,
          timeout: Math.max(1, timeoutMs),
          beforeRequest: (options: Record<string, unknown>) => ({
            ...options,
            signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
          }),
        }
      )
      const code = String(field(response, "Code"))
      if (code !== "200" && code !== "280") throw this.invalidResponse()
      return record(response)
    } catch (error) {
      if (error instanceof BadGatewayException) throw error
      const rawCode = field(error, "code")
      const code =
        typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : "UNAVAILABLE"
      this.logger.warn(
        `内容审核调用失败 action=${action} code=${/^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : "UNAVAILABLE"}`
      )
      // SDK 错误会包含请求地址和供应商数据，不向日志/全局过滤器传播。
      throw new ServiceUnavailableException({
        code: "MODERATION_UNAVAILABLE",
        message: "内容审核暂不可用，请稍后重试",
      })
    }
  }

  private normalizeContentResult(data: unknown): ModerationResult {
    const riskLevel = field(data, "RiskLevel")
    const results = field(data, "Result")
    if (typeof riskLevel !== "string" || !riskLevel.trim() || !Array.isArray(results))
      throw this.invalidResponse()
    for (const result of results) {
      const label = field(result, "Label")
      const description = field(result, "Description")
      if (
        typeof label !== "string" ||
        !label.trim() ||
        (description !== undefined && description !== null && typeof description !== "string")
      )
        throw this.invalidResponse()
    }
    return this.normalize({
      RiskLevel: riskLevel,
      Suggestion: field(data, "Suggestion"),
      Detail: results.map(result => ({
        Level: field(result, "RiskLevel") ?? riskLevel,
        Suggestion: field(result, "Suggestion"),
        Result: [result],
      })),
    })
  }

  private normalize(data: unknown): ModerationResult {
    for (const name of ["Suggestion", "RiskLevel"]) {
      const value = field(data, name)
      if (value !== undefined && value !== null && (typeof value !== "string" || !value.trim()))
        throw this.invalidResponse()
    }
    const suggestion = textValue(field(data, "Suggestion"))
    const riskLevel = textValue(field(data, "RiskLevel"))
    const detail = field(data, "Detail")
    if (detail !== undefined && !Array.isArray(detail)) throw this.invalidResponse()
    if (Array.isArray(detail))
      for (const item of detail) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw this.invalidResponse()
        for (const name of ["Type", "Level", "Suggestion"]) {
          const value = field(item, name)
          if (value !== undefined && value !== null && typeof value !== "string")
            throw this.invalidResponse()
        }
        const result = field(item, "Result")
        if (result !== undefined && result !== null && !Array.isArray(result))
          throw this.invalidResponse()
      }
    const dimensions = Array.isArray(detail)
      ? detail.map(item => ({
          type: textValue(field(item, "Type")),
          level: textValue(field(item, "Level")),
          suggestion: textValue(field(item, "Suggestion")),
          labels: this.labels(field(item, "Result")),
        }))
      : []
    if (!Array.isArray(detail) && riskLevel) {
      const frames = field(data, "FrameResult")
      const audio = field(data, "AudioResult")
      const pages = field(data, "PageSummary")
      const labels = [
        ...this.labels(field(frames, "FrameSummarys")),
        ...this.labels(field(audio, "AudioSummarys")),
        ...this.labels(field(field(pages, "ImageSummary"), "ImageLabels")),
        ...this.labels(field(field(pages, "TextSummary"), "TextLabels")),
      ]
      dimensions.push({
        type: null,
        level: riskLevel,
        suggestion,
        labels: this.uniqueLabels(labels),
      })
    }
    if (!suggestion && !riskLevel && !dimensions.some(item => item.level || item.suggestion)) {
      throw this.invalidResponse()
    }
    return { suggestion, riskLevel, dimensions }
  }

  private labels(value: unknown): ModerationLabel[] {
    if (!Array.isArray(value)) return []
    return this.uniqueLabels(
      value.flatMap(item => {
        const code = textValue(field(item, "Label"))
        return !code || code === "nonLabel"
          ? []
          : [
              {
                code,
                name: textValue(field(item, "Description")),
              },
            ]
      })
    )
  }

  private uniqueLabels(labels: ModerationLabel[]): ModerationLabel[] {
    return [...new Map(labels.map(label => [label.code, label])).values()]
  }

  private invalidResponse(): BadGatewayException {
    return new BadGatewayException({
      code: "MODERATION_INVALID_RESPONSE",
      message: "审核服务返回了无法识别的结果",
    })
  }
}
